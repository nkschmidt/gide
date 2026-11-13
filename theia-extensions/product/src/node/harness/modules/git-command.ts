import { createHash } from 'crypto';
import { readFile, lstat, realpath } from 'fs/promises';
import { resolve, isAbsolute, dirname } from 'path';
import { ToolContext, ToolExecutor } from '../core/contracts';
import { commandFlagAccess, ToolAccess } from '../core/tool-access';
import { isReadOnly, requiresSourceScope } from '../core/command-analysis';
import { analyzeGitCommand } from './command-profiles';
import { WorkflowEngine } from '../core/workflow-engine';
import { SafeToolError, within } from './file-tools';
import { git, gitRoot, gitState, repositoryMutation } from './git-tools';
import { repositoryFilePath } from './changesets';
import { sourceIdentity } from './git-snapshot';
import { runNative, nativeExecutable } from './native-process';

const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
// These families change repository boundaries/configuration or delegate to external programs.
const boundaryCommands = new Set(['init', 'clone', 'config', 'worktree', 'submodule', 'subtree', 'archive', 'bundle', 'fast-import', 'fast-export', 'daemon', 'shell', 'help', 'web--browse', 'instaweb', 'mergetool', 'difftool', 'send-email', 'credential', 'credential-cache', 'credential-store', 'http-backend', 'upload-pack', 'receive-pack', 'upload-archive', 'remote', 'replace']);
const handlerOptions = ['--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--config', '--super-prefix', '--separate-git-dir', '--global', '--system', '--file', '--blob', '--ext-diff', '--textconv', '--exec', '--upload-pack', '--receive-pack', '--filters', '--filter', '--to-command', '--remote', '--recurse-submodules', '--strategy', '--strategy-option', '--gpg-sign', '--sign', '--verify-signatures', '--show-signature', '--open-files-in-pager'];
export function gitArguments(value: unknown): string[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > 100 || value.some(arg => typeof arg !== 'string' || arg.length > 8000 || /[\0\r\n]/.test(arg)) || JSON.stringify(value).length > 24000 || !/^[a-z][a-z0-9-]*$/.test(value[0])) throw new SafeToolError('Pass a Git subcommand followed by literal arguments. Global options and aliases are not accepted.');
    const args = value as string[];
    if (['verify-commit', 'verify-tag', 'interpret-trailers'].includes(args[0]) || (args[0] === 'bisect' && args[1] === 'run')) throw new SafeToolError('External handler execution is unavailable through this Git tool.');
    if (boundaryCommands.has(args[0])) throw new SafeToolError('This Git command changes repository/configuration boundaries or starts an external handler and is outside this tool boundary.');
    let pathsOnly = false;
    for (const arg of args.slice(1)) {
        if (arg === '--' && !pathsOnly) { pathsOnly = true; continue; }
        const part = !pathsOnly && arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
        const option = arg.split('=')[0];
        if (isAbsolute(part) || /^[a-z]:[\\/]/i.test(part) || /(^|[\\/])\.\.([\\/]|$)/.test(part) || part.split(/[\\/]/).includes('.git') || arg.includes('::') || /^file:/i.test(part) || (!pathsOnly && option.startsWith('--') && option.length > 2 && handlerOptions.some(name => name.startsWith(option))) || (!pathsOnly && args[0] === 'rebase' && /^-x/.test(arg)) || (!pathsOnly && ['merge', 'rebase', 'pull'].includes(args[0]) && /^-s/.test(arg)) || (!pathsOnly && ['commit', 'merge', 'rebase', 'pull', 'tag'].includes(args[0]) && /^-S/.test(arg)) || (!pathsOnly && args[0] === 'tag' && (/^-[sv]/.test(arg) || (arg.startsWith('--') && '--verify'.startsWith(option)))) || (!pathsOnly && args[0] === 'grep' && /^-O/.test(arg))) throw new SafeToolError('Arguments may not override repository/configuration paths, select external handlers, execute commands or address files outside the registered repository.');
    }
    if (args[0] === 'rebase' && args.some(arg => ['-i', '--interactive', '--edit-todo'].includes(arg))) throw new SafeToolError('Interactive editors are unavailable. Use non-interactive Git arguments.');
    return [...args];
}
export function gitCategory(args: string[]): string { return analyzeGitCommand(args).category; }
export class GitCommand implements ToolExecutor {
    constructor(private readonly workflow?: WorkflowEngine) { }
    readonly workflowOperations = ['repository-edit'] as const;
    readonly access: ToolAccess = commandFlagAccess({ categories: [
        { id: 'read', label: 'Read repository state', defaultDecision: 'allow' }, { id: 'local', label: 'Change local Git state / other commands', defaultDecision: 'ask' },
        { id: 'network', label: 'Fetch / pull / remote reads', defaultDecision: 'ask' }, { id: 'publish', label: 'Push changes', defaultDecision: 'ask' }, { id: 'destructive', label: 'Potential data loss / forced operations', defaultDecision: 'ask' }
    ], analyze: args => analyzeGitCommand(gitArguments(args.arguments)), classify: args => analyzeGitCommand(gitArguments(args.arguments)).category });
    readonly definition = { name: 'git', description: 'Run a Git subcommand with literal arguments inside a registered repository. Policy controls read/local/network/publish/destructive categories. Additional flags are governed by the method’s Unrecognized command flags rule; Allow does not override command permissions or technical boundaries. Propose actionable Git operations with this tool instead of telling the user to execute them manually. Mutations usually require exact command approval. No shell, path/config overrides, aliases, hooks, external diff/filter/merge handlers, interactive editors, repository management or submodules. A cwd is not host isolation. Existing workflow branch/scope guards still apply; git_branch_create remains the scoped branch-preparation action. Result contains actual exit code, bounded output and state. Never claim success from user prose.', parameters: { type: 'object', properties: { repository: { type: 'string' }, arguments: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 } }, required: ['repository', 'arguments'], additionalProperties: false } };
    available(context: ToolContext): boolean { return context.purpose !== 'repository-analysis'; }
    private async inspect(args: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>> {
        if (Object.keys(args).sort().join(',') !== 'arguments,repository') throw new SafeToolError('Pass repository and arguments only.');
        const argv = gitArguments(args.arguments); const root = await gitRoot(args.repository, context); const operation = analyzeGitCommand(argv); const category = operation.category; const readOnly = isReadOnly(operation); const sourceScope = requiresSourceScope(operation);
        let pathsOnly = false;
        for (const arg of argv.slice(1)) {
            if (arg === '--' && !pathsOnly) { pathsOnly = true; continue; }
            if (!pathsOnly && arg.startsWith('-') && !arg.includes('=')) continue;
            const value = !pathsOnly && arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
            if (!value || /^(https|ssh):\/\//.test(value) || /^[^/]+@[^:]+:/.test(value)) continue;
            let candidate = resolve(root, value);
            while (within(root, candidate)) { try { if (!within(root, await realpath(candidate))) throw new SafeToolError('Git arguments may not follow a link outside the repository.'); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error; const parent = dirname(candidate); if (parent === candidate) break; candidate = parent; } }
        }
        // Only native built-in commands; repository aliases cannot turn an unknown command into shell execution.
        const builtins = (await git(root, ['--list-cmds=builtins'], context)).split(/\s+/);
        if (!builtins.includes(argv[0])) throw new SafeToolError('Unknown Git built-in. Aliases and external Git plugins are not executed.');
        const config = await readFile(resolve(root, '.git/config'), 'utf8');
        if (/^\s*\[\s*(filter|diff|merge)\s+"/im.test(config)) throw new SafeToolError('Repository config defines custom filters/diff/merge drivers. This host runner cannot execute them within its technical boundary.');
        for (const name of ['rebase-merge/git-rebase-todo', 'rebase-merge/done']) {
            try { if (/^\s*(exec|x)\s/m.test(await readFile(resolve(root, '.git', name), 'utf8'))) throw new SafeToolError('Saved rebase instructions contain external commands. Resolve them manually before continuing.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        const state = await gitState(root, context);
        if (['switch', 'checkout'].includes(argv[0])) {
            if (!state.clean) throw new SafeToolError('Branch switching requires a clean working tree. Inspect changes and resolve them with the user; nothing was stashed or discarded.');
            for (const entry of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) { try { await lstat(resolve(root, '.git', entry)); throw new SafeToolError('Finish or explicitly abort the in-progress Git operation before switching.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
        }
        const activeWorkflow = context.taskId && this.workflow?.store.task(context.taskId).workflow;
        const preparedBranch = this.workflow?.branch(context, String(args.repository));
        const preparingRestore = !!activeWorkflow && !preparedBranch && argv[0] === 'restore';
        if (preparingRestore && this.workflow) {
            if (!['--worktree', '-W'].includes(argv[1]) || argv[2] !== '--' || argv.length < 4) {
                throw new SafeToolError('Before branch creation, restore only explicitly named working-tree files with restore --worktree -- <paths>.');
            }
            const paths = argv.slice(3).map(repositoryFilePath);
            const scopes = await this.workflow.preparationScope(context, String(args.repository));
            const allowed = new Set(scopes.flatMap(scope => scope.paths));
            if (paths.some(path => !allowed.has(path))) throw new SafeToolError('Restore only files listed in the approved ChangeSet. Other changes are preserved.');
        }
        if (sourceScope && activeWorkflow && !preparedBranch && !preparingRestore && !['switch', 'checkout', 'fetch', 'ls-remote'].includes(argv[0])) throw new SafeToolError('This workflow has not prepared its approved feature branch. Use the scoped branch-preparation tool before source/history mutations.');
        if (sourceScope && preparedBranch) {
            if (state.branch !== preparedBranch.branch || !['fetch', 'push', 'ls-remote', 'add', 'rm', 'mv', 'restore', 'apply', 'commit'].includes(argv[0])) throw new SafeToolError('This task is bound to its approved feature branch. Revise the workflow before changing that branch or its history.');
        }
        // Once task source work is scoped, unrestricted staging/committing cannot bypass path approval.
        if (sourceScope && activeWorkflow && this.workflow && !preparingRestore && ['add', 'rm', 'mv', 'restore', 'apply', 'commit'].includes(argv[0])) {
            const scopes = await this.workflow.authorize(context, 'repository-edit', String(args.repository));
            const allowed = new Set(scopes.flatMap(scope => scope.paths));
            if (state.entries.some(entry => !allowed.has(entry.path) || (entry.previousPath && !allowed.has(entry.previousPath)))) throw new SafeToolError('Working-tree changes extend beyond the approved ChangeSet. Resolve scope before this Git operation.');
        }
        const fingerprint = readOnly ? state.fingerprint : await sourceIdentity(String(args.repository), context);
        const refs = readOnly ? '' : await git(root, ['show-ref'], context);
        const index = await readFile(resolve(root, '.git/index')).catch(() => Buffer.alloc(0));
        const executable = await nativeExecutable('git');
        return { root, executable, arguments: argv, category, operation, branch: state.branch, head: state.head, clean: state.clean, fingerprint, metadata: hash(config + refs + hash(index)) };
    }
    async prepare(args: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>> {
        const target = await this.inspect(args, context);
        return { scope: 'registered-git-command', target, review: { kind: 'git', repository: args.repository, ...target, warning: target.category === 'destructive' ? 'Potential loss of local work, branch history or remote changes. Review the exact arguments before allowing.' : 'Runs Git locally with your user permissions. Network commands contact the configured remote. Bounded output is returned to the external model.' } };
    }
    async execute(args: Record<string, unknown>, prepared: Record<string, unknown>, context: ToolContext): Promise<string> {
        return repositoryMutation(args.repository, context, async () => {
            const target = await this.inspect(args, context);
            if (JSON.stringify(target) !== JSON.stringify(prepared.target)) throw new SafeToolError('Repository, source or Git state changed after review. Request this Git action again.');
            const root = String(target.root); const argv = target.arguments as string[];
            const environment = { ...Object.fromEntries(['PATH', 'HOME', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'false', SSH_ASKPASS: 'false', GIT_PAGER: 'cat', PAGER: 'cat', GIT_EDITOR: 'false', GIT_SEQUENCE_EDITOR: 'false', GIT_ALLOW_PROTOCOL: 'https:ssh', GIT_ATTR_NOSYSTEM: '1', GIT_PROTOCOL_FROM_USER: '0', LC_ALL: 'C' };
            const controls = ['--literal-pathspecs', '--no-pager', `--git-dir=${resolve(root, '.git')}`, `--work-tree=${root}`, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.pager=cat', '-c', 'core.editor=false', '-c', 'sequence.editor=false', '-c', 'diff.external=', '-c', 'core.attributesFile=/dev/null', '-c', 'credential.helper=', '-c', 'credential.interactive=false', '-c', 'core.sshCommand=ssh', '-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never', '-c', 'submodule.recurse=false', '-c', 'fetch.recurseSubmodules=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'rebase.instructionFormat=%s', '-c', 'log.showSignature=false', '-c', 'merge.verifySignatures=false'];
            const command = [...argv]; if (['diff', 'show', 'log'].includes(argv[0])) command.splice(1, 0, '--no-ext-diff', '--no-textconv');
            const result = await runNative({ program: (target.executable as { path: string }).path, arguments: [...controls, ...command], cwd: root, environment, timeoutMs: 120000, outputLimit: 12000 }, context.signal);
            return JSON.stringify({ repository: args.repository, arguments: argv, ...result });
        });
    }
}
