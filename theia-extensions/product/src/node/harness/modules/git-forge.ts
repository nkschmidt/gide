import { ToolContext } from '../core/contracts';
import { SafeToolError } from './file-tools';
import { git } from './git-tools';
import { nativeExecutable, runNative } from './native-process';
import { analyzeCommand } from '../core/command-analysis';
import { githubCommandProfile } from './command-profiles';

export interface GitRemote {
    transport: string;
    web: string;
    host: string;
    path: string;
    provider: 'github' | 'gitlab' | 'bitbucket' | 'other';
}

export function parseGitRemote(value: string, configuredProvider: string): GitRemote {
    const scp = /^git@([a-z0-9.-]+):([^\s]+)$/i.exec(value);
    let uri: URL;
    try { uri = new URL(scp ? `ssh://git@${scp[1]}/${scp[2]}` : value); }
    catch { throw new SafeToolError('The push remote must use HTTPS or SSH.'); }
    const path = uri.pathname.replace(/^\//, '').replace(/\/$/, '').replace(/\.git$/i, '');
    if (!['https:', 'ssh:'].includes(uri.protocol) || !/^[a-z0-9.-]+$/i.test(uri.hostname) || uri.password || uri.hash || uri.search ||
        !/^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+$/i.test(path) || path.split('/').some(part => part === '.' || part === '..') ||
        (uri.protocol === 'ssh:' && uri.username !== 'git') || !/^[a-z0-9._%-]*$/i.test(uri.username) ||
        /(?:^|\/)\.{1,2}(?:\/|$)|%2e|[\\\s]/i.test(value)) throw new SafeToolError('The push remote URL is outside the supported HTTPS or SSH format.');
    const host = uri.hostname;
    const provider = host === 'github.com' ? 'github' : host === 'gitlab.com' ? 'gitlab' : host === 'bitbucket.org' ? 'bitbucket'
        : configuredProvider === 'gitlab' || configuredProvider === 'github' ? configuredProvider : 'other';
    const webHost = uri.protocol === 'https:' ? uri.host : host;
    return { transport: value, web: `https://${webHost}/${path}`, host: webHost, path, provider };
}

export interface PublicationTarget {
    root: string;
    head: string;
    branch: string;
    base: string;
}

export function publicationPage(remote: GitRemote, target: PublicationTarget): string {
    if (remote.provider === 'github') return `${remote.web}/compare/${encodeURIComponent(target.base)}...${encodeURIComponent(target.branch)}?expand=1`;
    if (remote.provider === 'gitlab') {
        const query = new URLSearchParams({ 'merge_request[source_branch]': target.branch, 'merge_request[target_branch]': target.base });
        return `${remote.web}/-/merge_requests/new?${query}`;
    }
    if (remote.provider === 'bitbucket') {
        const query = new URLSearchParams({ source: target.branch, dest: target.base });
        return `${remote.web}/pull-requests/new?${query}`;
    }
    return remote.web;
}

const hostEnvironment = () => Object.fromEntries([
    'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR',
    'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'SSH_AUTH_SOCK', 'DBUS_SESSION_BUS_ADDRESS'
].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));

export async function githubRequest(remote: GitRemote, target: PublicationTarget, title: string, description: string, context: ToolContext): Promise<{ status: 'created' | 'existing'; url: string } | undefined> {
    const executable = await nativeExecutable('gh').catch(() => undefined);
    if (!executable) return undefined;
    const environment = { ...hostEnvironment(), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' };
    const run = (args: string[]) => {
        const operation = analyzeCommand(githubCommandProfile, args);
        if (operation.effects.includes('unknown')) throw new SafeToolError('GitHub command semantics are not declared by this implementation.');
        return runNative({ program: executable.path, arguments: args, cwd: target.root, environment, timeoutMs: 30000, outputLimit: 16000 }, context.signal);
    };
    const auth = await run(['auth', 'status', '--hostname', remote.host]).catch(() => undefined);
    context.signal.throwIfAborted();
    if (auth?.state !== 'passed') return undefined;
    const repo = `${remote.host}/${remote.path}`;
    const list = await run(['pr', 'list', '--repo', repo, '--state', 'open', '--head', target.branch, '--base', target.base, '--json', 'url,headRefOid', '--limit', '10']);
    if (list.state !== 'passed' || list.truncated) return undefined;
    let existing: { url: string; headRefOid: string }[];
    try { existing = JSON.parse(list.output); if (!Array.isArray(existing)) return undefined; } catch { return undefined; }
    const validUrl = (url: unknown): url is string => typeof url === 'string' && url.startsWith(`${remote.web}/pull/`) && /^\d+$/.test(url.slice(`${remote.web}/pull/`.length));
    const match = existing.find(item => item.headRefOid === target.head && validUrl(item.url));
    if (match) return { status: 'existing', url: match.url };
    if (existing.length) return undefined;
    const result = await run(['pr', 'create', '--repo', repo, '--head', target.branch, '--base', target.base, '--title', title, '--body', description]);
    context.signal.throwIfAborted();
    const url = result.output.split(/\r?\n/).map(line => line.trim()).find(validUrl);
    return result.state === 'passed' && url ? { status: 'created', url } : undefined;
}

export async function pushTaskBranch(remote: GitRemote, target: PublicationTarget, title: string, description: string, context: ToolContext): Promise<string | undefined> {
    const controls = ['-c', 'http.followRedirects=false', '-c', 'credential.helper=', '-c', 'credential.interactive=false',
        '-c', 'core.sshCommand=ssh -o BatchMode=yes', '-c', 'push.followTags=false', '-c', 'push.recurseSubmodules=no'];
    if (remote.transport.startsWith('https:')) {
        const configured = await git(target.root, ['config', '--global', '--get-urlmatch', 'credential.helper', remote.transport], context,
            { environment: { GIT_CONFIG_GLOBAL: undefined }, timeout: 10000 }).catch(() => '');
        const helpers = configured.split(/\r?\n/).map(line => line.trim());
        for (const helper of helpers) {
            if (['manager', 'manager-core', 'osxkeychain', 'wincred', 'libsecret', 'cache', 'store'].includes(helper)) controls.push('-c', `credential.helper=${helper}`);
        }
        if (remote.provider === 'github' && helpers.some(helper => /^!.*[\/\\]gh(?:\.exe)?["']? auth git-credential$/i.test(helper) || helper === '!gh auth git-credential')) {
            const gh = await nativeExecutable('gh').catch(() => undefined);
            if (gh && !/[\r\n]/.test(gh.path)) {
                const path = "'" + gh.path.replace(/'/g, "'\\''") + "'";
                controls.push('-c', `credential.helper=!${path} auth git-credential`);
            }
        }
    }
    const options = remote.provider === 'gitlab' ? [
        '-o', 'merge_request.create', '-o', `merge_request.target=${target.base}`, '-o', `merge_request.title=${title}`,
        '-o', `merge_request.description=${description.replace(/\r\n|\r|\n/g, '\\n')}`
    ] : [];
    const environment = { GIT_ALLOW_PROTOCOL: 'https:ssh', GIT_ASKPASS: 'false', SSH_ASKPASS: 'false', GCM_INTERACTIVE: 'never' };
    const output = await git(target.root, [...controls, 'push', ...options, '--', remote.transport,
        `${target.head}:refs/heads/${target.branch}`], context, { environment, timeout: 120000, includeStderr: true }).catch(() => {
        context.signal.throwIfAborted();
        throw new SafeToolError('Git could not confirm the push. Check the configured SSH key or HTTPS credential helper and remote branch permissions.');
    });
    if (remote.provider === 'gitlab') {
        const prefix = `${remote.web}/-/merge_requests/`;
        return output.split(/\s+/).find(word => word.startsWith(prefix) && /^\d+$/.test(word.slice(prefix.length)));
    }
    return undefined;
}
