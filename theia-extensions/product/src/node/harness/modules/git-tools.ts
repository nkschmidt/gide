import { fileState } from './repository-file-state';
import { registerGitDelivery } from './git-delivery';
import { scopeAccess } from '../core/tool-access';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { lstat, readdir, readFile, realpath } from 'fs/promises';
import { resolve } from 'path';
import { ToolContext, ToolRegistry } from '../core/contracts';
import { WorkflowEngine } from '../core/workflow-engine';
import { projectMutations } from '../storage/mutation-queue';
import { SafeToolError, within } from './file-tools';
import { resolveRepositoryTarget } from './repository-tools';
import { hashText, repositoryFilePath } from './changesets';
const exec = promisify(execFile);
const environment = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' });
export async function gitRoot(repository: unknown, context: ToolContext): Promise<string> {
    const { root } = await resolveRepositoryTarget({ repository, path: '.', offset: 0 }, context);
    const metadata = resolve(root, '.git'); const info = await lstat(metadata);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new SafeToolError('Git tools currently require a real .git directory inside the registered repository; linked worktrees are not supported.');
    let count = 0;
    const walk = async (path: string): Promise<void> => {
        context.signal.throwIfAborted(); if (++count > 30000) throw new SafeToolError('Git metadata exceeds the bounded inspection limit.');
        const entry = await lstat(path); if (entry.isSymbolicLink() || !within(metadata, await realpath(path))) throw new SafeToolError('Git metadata must not contain links outside or inside the repository.');
        if (entry.isDirectory()) for (const child of await readdir(path)) await walk(resolve(path, child));
        else if (!entry.isFile() || (entry.nlink > 1 && !path.startsWith(resolve(metadata, 'objects') + '/'))) throw new SafeToolError('Unsafe Git metadata file.');
    };
    await walk(metadata);
    const config = await readFile(resolve(metadata, 'config'), 'utf8');
    if (/^\s*\[\s*(include|includeif|extensions)(\s|\])/im.test(config)) throw new SafeToolError('External Git config includes and extended repository layouts are unsupported by these bounded tools.');
    for (const name of ['objects/info/alternates', 'objects/info/http-alternates', 'info/grafts']) { try { await lstat(resolve(metadata, name)); throw new SafeToolError('Git alternate object stores and grafts are outside the registered-repository boundary.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
    const top = await git(root, ['rev-parse', '--show-toplevel'], context);
    if (await realpath(top.trim()) !== root) throw new SafeToolError('The registered folder must be the Git repository root.'); return root;
}
export async function git(root: string, args: string[], context: ToolContext, options?: { environment: NodeJS.ProcessEnv; timeout: number; includeStderr?: boolean }): Promise<string> {
    context.signal.throwIfAborted();
    try { const result = await exec('git', ['--literal-pathspecs', '--no-pager', `--git-dir=${resolve(root, '.git')}`, `--work-tree=${root}`, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', '-c', 'diff.external=', ...args], { cwd: root, env: { ...environment(), ...options?.environment }, timeout: options?.timeout ?? 10000, maxBuffer: 512000, signal: context.signal }); return options?.includeStderr ? result.stdout + '\n' + result.stderr : result.stdout; }
    catch { context.signal.throwIfAborted(); throw new SafeToolError('The bounded Git operation failed. Inspect repository state; no arbitrary Git command is accepted.'); }
}
export interface GitState { branch: string; head: string; defaultBranch: string; clean: boolean; entries: { status: string; path: string; previousPath?: string }[]; fingerprint: string; remoteFreshness: string; }
export async function repositoryMutation<T>(repository: unknown, context: ToolContext, action: () => Promise<T>): Promise<T> {
    const root = await gitRoot(repository, context);
    // Different projects may register the same physical checkout. Protect both project plans and that checkout.
    return projectMutations.run(context.projectPath, () => projectMutations.run(`repository:${root}`, action));
}
export async function gitState(root: string, context: ToolContext): Promise<GitState> {
    const head = (await git(root, ['rev-parse', '--verify', 'HEAD'], context)).trim();
    let branch = ''; try { branch = (await git(root, ['symbolic-ref', '--short', 'HEAD'], context)).trim(); } catch { /* Detached HEAD is reported, never switched implicitly. */ }
    let defaultBranch = ''; try { defaultBranch = (await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], context)).trim().replace(/^origin\//, ''); } catch { /* Fall back to an existing main/master ref. */ }
    if (!defaultBranch) for (const candidate of ['main', 'master']) { try { await git(root, ['show-ref', '--verify', `refs/heads/${candidate}`], context); defaultBranch = candidate; break; } catch { /* Try next base. */ } }
    const raw = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], context); const parts = raw.split('\0').filter(Boolean); const entries: GitState['entries'] = [];
    for (let index = 0; index < parts.length; index++) { const value = parts[index]; const status = value.slice(0, 2); const path = repositoryFilePath(value.slice(3)); const previousPath = /[RC]/.test(status) ? repositoryFilePath(parts[++index]) : undefined; entries.push({ status, path, ...(previousPath ? { previousPath } : {}) }); }
    return { branch, head, defaultBranch, clean: !raw, entries, fingerprint: hashText(JSON.stringify({ branch, head, raw })), remoteFreshness: 'Local references only; no network fetch or remote freshness claim.' };
}
export function registerGitTools(tools: ToolRegistry, workflow: WorkflowEngine): void {
    registerGitDelivery(tools, workflow);
    tools.register({ access: scopeAccess({ 'registered-git-read': 'allow' }, undefined, ['read']), definition: { name: 'git_status', description: 'Inspect branch, HEAD, default main/master branch and structured working-tree changes inside one registered repository. No shell, fetch, checkout or commit. Remote freshness is not verified.', parameters: { type: 'object', properties: { repository: { type: 'string' } }, required: ['repository'], additionalProperties: false } }, prepare: async (args, context) => ({ scope: 'registered-git-read', root: await gitRoot(args.repository, context) }), execute: async (args, prepared, context) => { const root = await gitRoot(args.repository, context); if (root !== prepared.root) throw new SafeToolError('Repository registration changed.'); return JSON.stringify({ repository: args.repository, ...await gitState(root, context) }); } });
    tools.register({ access: scopeAccess({ 'registered-git-read': 'allow' }, undefined, ['read']), definition: { name: 'git_diff', description: 'Read structured changed-file entries and bounded patches against the recorded task base commit when present, otherwise HEAD, in a registered repository. No external diff/textconv, arbitrary refs or options. Pass a repository-relative file path or empty string for all tracked changes. Untracked file names appear in git_status; read their content with files_read.', parameters: { type: 'object', properties: { repository: { type: 'string' }, path: { type: 'string' } }, required: ['repository', 'path'], additionalProperties: false } }, prepare: async (args, context) => { if (args.path !== '') repositoryFilePath(args.path); return { scope: 'registered-git-read', root: await gitRoot(args.repository, context) }; }, execute: async (args, prepared, context) => {
        const root = await gitRoot(args.repository, context); if (root !== prepared.root) throw new SafeToolError('Repository registration changed.');
        const base = workflow.branch(context, String(args.repository))?.head || 'HEAD';
        const paths = args.path === '' ? [] : [repositoryFilePath(args.path)]; const flags = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames'];
        const raw = await git(root, [...flags, '--name-status', '-z', base, '--', ...paths], context); const entries = raw.split('\0').filter(Boolean); const files = [];
        for (let i = 0; i < entries.length; i += 2) files.push({ status: entries[i], path: repositoryFilePath(entries[i + 1]) });
        const patch = await git(root, [...flags, '--unified=3', base, '--', ...paths], context);
        return JSON.stringify({ repository: args.repository, base, files: files.slice(0, 200), patch: patch.slice(0, 60000), limited: patch.length > 60000 || files.length > 200 });
    } });
    tools.register({ workflowOperations: ['branch-create'], access: scopeAccess({ 'workflow-branch': 'allow' }, undefined, ['write']), definition: { name: 'git_branch_create', description: 'Create and switch HEAD to a new feature branch at the current clean agreed base, or revalidate the recorded task branch on a repeat pass. Revalidation accepts only unchanged task-owned files within the current approved scope and never creates another branch. Requires a ready branch-create workflow step and an approved ChangeSet containing this repository. Never resets, stashes, commits, switches an existing base or overwrites a branch. expectedHead and expectedState come from git_status.', parameters: { type: 'object', properties: { repository: { type: 'string' }, baseBranch: { type: 'string' }, branch: { type: 'string' }, expectedHead: { type: 'string' }, expectedState: { type: 'string' } }, required: ['repository', 'baseBranch', 'branch', 'expectedHead', 'expectedState'], additionalProperties: false } }, available: context => context.purpose !== 'repository-analysis', prepare: async (args, context) => {
        await workflow.authorize(context, 'branch-create', String(args.repository));
        if (typeof args.branch !== 'string' || !/^[a-z0-9][a-z0-9._/-]{0,99}$/i.test(args.branch) || args.branch.includes('..') || args.branch.endsWith('/') || args.branch.includes('//') || args.branch.endsWith('.lock') || args.branch === args.baseBranch) throw new SafeToolError('Choose a new feature branch name.');
        return { scope: 'workflow-branch', root: await gitRoot(args.repository, context), branch: args.branch, head: args.expectedHead, state: args.expectedState };
    }, execute: async (args, prepared, context) => repositoryMutation(args.repository, context, async () => {
        const scopes = await workflow.authorize(context, 'branch-create', String(args.repository)); const root = await gitRoot(args.repository, context); if (root !== prepared.root || args.branch !== prepared.branch || args.expectedHead !== prepared.head || args.expectedState !== prepared.state) throw new SafeToolError('Prepared branch parameters changed.');
        const state = await gitState(root, context);
        const recorded = workflow.branch(context, String(args.repository));
        if (recorded) {
            if (args.branch !== recorded.branch || args.baseBranch !== recorded.base || state.branch !== recorded.branch || state.head !== (recorded.tip || recorded.head) || state.head !== args.expectedHead || state.fingerprint !== args.expectedState || !scopes.some(scope => (scope.baseBranch || state.defaultBranch) === recorded.base)) throw new SafeToolError('The recorded task branch changed. Reconcile its actual state with the user; no branch was recreated or reset.');
            const owned = workflow.edits(context, String(args.repository)); const allowed = new Set(scopes.flatMap(scope => scope.paths));
            const changed = (await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', recorded.head, '--'], context)).split('\0').filter(Boolean);
            for (const path of new Set([...changed, ...state.entries.flatMap(entry => entry.previousPath ? [entry.path, entry.previousPath] : [entry.path])])) {
                if (!allowed.has(path) || !Object.prototype.hasOwnProperty.call(owned, path) || (await fileState(root, path)).digest !== owned[path]) throw new SafeToolError('Existing task changes are outside the new approved scope or changed externally. Nothing was reset or stashed.');
            }
            return JSON.stringify({ repository: args.repository, ...recorded, reused: true });
        }
        if (!state.clean || state.head !== args.expectedHead || state.fingerprint !== args.expectedState || state.branch !== args.baseBranch || !scopes.some(scope => (scope.baseBranch || state.defaultBranch) === args.baseBranch)) throw new SafeToolError('Repository must be clean, unchanged and on its detected default or explicitly approved base branch. Resolve unexpected state with the user; do not reset or stash.');
        await git(root, ['check-ref-format', '--branch', String(args.branch)], context);
        await git(root, ['branch', '--no-track', String(args.branch), state.head], context);
        // This changes only HEAD at the same commit: no checkout filters, hooks or work-tree writes.
        await git(root, ['symbolic-ref', 'HEAD', `refs/heads/${args.branch}`], context);
        const result = { branch: String(args.branch), base: state.branch, head: state.head }; workflow.recordBranch(context, String(args.repository), result);
        return JSON.stringify({ repository: args.repository, ...result });
    }) });
}
