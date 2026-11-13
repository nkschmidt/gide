import { readFile, lstat } from 'fs/promises';
import { resolve } from 'path';
import { ToolContext, ToolRegistry } from '../core/contracts';
import { scopeAccess } from '../core/tool-access';
import { WorkflowEngine } from '../core/workflow-engine';
import { SafeToolError } from './file-tools';
import { git, gitRoot, gitState, repositoryMutation } from './git-tools';
import { fileState } from './repository-file-state';
import { githubRequest, parseGitRemote, publicationPage, pushTaskBranch } from './git-forge';

const text = { type: 'string' };
function input(value: unknown, max: number, multiline = false): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /\0/.test(value) || (!multiline && /[\r\n]/.test(value))) {
        throw new SafeToolError('Provide a valid title or description within the tool limits.');
    }
    return value.trim();
}

export function registerGitDelivery(registry: ToolRegistry, workflow: WorkflowEngine): void {
    const inspect = async (args: Record<string, unknown>, context: ToolContext, publish: boolean) => {
        const repository = String(args.repository);
        const scopes = await workflow.authorize(context, publish ? 'repository-publish' : 'repository-commit', repository);
        const branch = workflow.branch(context, repository);
        const root = await gitRoot(args.repository, context);
        const config = await readFile(resolve(root, '.git/config'), 'utf8');
        if (/^\s*\[\s*(filter|diff|merge)(?:\s+"|\.)/im.test(config)) throw new SafeToolError('Custom Git filters and drivers are outside the commit tool boundary.');
        const state = await gitState(root, context);
        if (!branch || branch.branch !== state.branch || branch.base === state.branch) throw new SafeToolError('The task feature branch must be checked out.');
        for (const entry of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
            const exists = await lstat(resolve(root, '.git', entry)).then(() => true, error => {
                if (error.code === 'ENOENT') return false;
                throw error;
            });
            if (exists) throw new SafeToolError('Finish the in-progress Git operation before finalizing this task.');
        }
        const allowed = new Set(scopes.flatMap(scope => scope.paths));
        const edits = workflow.edits(context, repository);
        let paths = [...new Set(state.entries.flatMap(entry => entry.previousPath ? [entry.path, entry.previousPath] : [entry.path]))].sort();
        const expectedHead = branch.tip || branch.head;
        const needsReceipt = state.head !== expectedHead;
        const alreadyCommitted = state.clean && state.head !== branch.head;
        if (needsReceipt) {
            const parents = (await git(root, ['rev-list', '--parents', '-n', '1', 'HEAD'], context)).trim().split(' ');
            if (!state.clean || parents.length !== 2 || parents[1] !== expectedHead) throw new SafeToolError('The task branch already has unexpected changes or commits.');
            paths = (await git(root, ['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', 'HEAD'], context)).split('\0').filter(Boolean).sort();
        } else if (alreadyCommitted) {
            paths = (await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', branch.head, 'HEAD', '--'], context)).split('\0').filter(Boolean).sort();
        }
        if (state.entries.some(entry => /U|^(AA|DD)$/.test(entry.status))) throw new SafeToolError('Resolve conflicted files before committing.');
        for (const path of paths) {
            if (!allowed.has(path) || !Object.prototype.hasOwnProperty.call(edits, path) || (await fileState(root, path)).digest !== edits[path]) {
                throw new SafeToolError('The branch contains changes outside the exact files and content recorded by this task.');
            }
            if (alreadyCommitted) {
                const entry = await git(root, ['ls-tree', '-z', '--full-tree', 'HEAD', '--', path], context);
                const blob = edits[path] === null ? undefined : (await git(root, ['-c', 'core.attributesFile=/dev/null', 'hash-object', '--path=' + path, '--', path], context)).trim();
                if (blob ? !entry.startsWith(`100644 blob ${blob}\t`) && !entry.startsWith(`100755 blob ${blob}\t`) : !!entry) {
                    throw new SafeToolError('The existing commit does not contain the exact task changes.');
                }
            }
        }
        if (publish && (!alreadyCommitted || !paths.length)) throw new SafeToolError('Create the local ChangeSet commit before publishing.');
        return { root, head: state.head, branch: state.branch, base: branch.base, paths, alreadyCommitted, needsReceipt, expectedHead, fingerprint: state.fingerprint };
    };
    const available = (context: ToolContext) => !!context.taskId && !!workflow.store.task(context.taskId).workflow && context.purpose !== 'repository-analysis';

    registry.register({
        workflowOperations: ['repository-commit'],
        access: scopeAccess({ 'local-commit': 'allow' }, undefined, ['write']),
        available,
        definition: {
            name: 'git_commit_changeset', description: 'Create a local commit on the prepared task branch using only exact files recorded by repository editing tools and approved in the ChangeSet. Does not push. Pass a single-line commit message. Retrying a completed commit returns its hash.',
            parameters: { type: 'object', properties: { repository: text, message: text }, required: ['repository', 'message'], additionalProperties: false }
        },
        prepare: async (args, context) => ({ scope: 'local-commit', target: await inspect(args, context, false), message: input(args.message, 160) }),
        execute: async (args, prepared, context) => repositoryMutation(args.repository, context, async () => {
            const target = await inspect(args, context, false);
            const message = input(args.message, 160);
            if (JSON.stringify(target) !== JSON.stringify(prepared.target) || message !== prepared.message) throw new SafeToolError('Git state changed before the commit. Inspect it and retry.');
            if (!target.paths.length) return JSON.stringify({ status: 'no_changes', repository: args.repository, branch: target.branch });
            if (!target.alreadyCommitted) {
                const environment: NodeJS.ProcessEnv = {};
                for (const [configKey, keys] of [['name', ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME']], ['email', ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']]] as const) {
                    const property = `user.${configKey}`;
                    const local = await git(target.root, ['config', '--local', '--get', property], context).catch(() => '');
                    if (local.trim()) continue;
                    const global = await git(target.root, ['config', '--global', '--no-includes', '--get', property], context, { environment: { GIT_CONFIG_GLOBAL: undefined }, timeout: 10000 }).catch(() => '');
                    if (global.trim()) for (const key of keys) environment[key] = global.trim();
                }
                const options = { environment, timeout: 10000 };
                try {
                    await git(target.root, ['var', 'GIT_AUTHOR_IDENT'], context, options);
                    await git(target.root, ['var', 'GIT_COMMITTER_IDENT'], context, options);
                } catch {
                    context.signal.throwIfAborted();
                    throw new SafeToolError('Configure Git author name and email before retrying the commit.');
                }
                await git(target.root, ['-c', 'core.attributesFile=/dev/null', 'add', '-A', '--', ...target.paths], context);
                await inspect(args, context, false);
                await git(target.root, ['-c', 'commit.gpgSign=false', '-c', 'core.attributesFile=/dev/null', 'commit', '--only', '-m', message, '--', ...target.paths], context, options);
            }
            const final = await inspect(args, context, false);
            if (final.needsReceipt) workflow.recordCommit(context, String(args.repository), final.expectedHead, final.head);
            return JSON.stringify({ status: 'committed', repository: args.repository, branch: final.branch, commit: final.head });
        })
    });

    const preparePullRequest = async (args: Record<string, unknown>, context: ToolContext, githubOnly: boolean) => {
        const title = input(args.title, 160);
        const description = input(args.description, 6000, true);
        const target = await inspect(args, context, true);
        const config = await readFile(resolve(target.root, '.git/config'), 'utf8');
        if (/^\s*\[\s*(?:url|http|credential)(?:\s|\]|\.)/im.test(config)) throw new SafeToolError('Repository transport overrides are outside the pull request tool boundary.');
        const remotes = (await git(target.root, ['remote', 'get-url', '--push', '--all', 'origin'], context)).trim().split(/\r?\n/);
        if (remotes.length !== 1) throw new SafeToolError('Configure one push URL for origin before publishing.');
        const configuredProvider = (await git(target.root, ['config', '--local', '--get', 'governed.forge'], context).catch(() => '')).trim();
        const remote = parseGitRemote(remotes[0], configuredProvider);
        if (githubOnly && remote.provider !== 'github') throw new SafeToolError('This remote is not a recognized GitHub repository. Use Git pull request instead.');
        return { scope: 'remote-pull-request', target, remote, title, description, review: {
            kind: 'pull-request', destination: remote.web, branch: target.branch, base: target.base,
            commit: target.head, title, description
        } };
    };
    for (const githubOnly of [false, true]) registry.register({
        workflowOperations: ['repository-publish'],
        requiresApproval: true,
        access: scopeAccess({ 'remote-pull-request': 'ask' }, undefined, ['write', 'network', 'publish']),
        available,
        definition: {
            name: githubOnly ? 'github_pull_request' : 'git_pull_request',
            description: githubOnly
                ? 'Propose pushing the exact task commit to a GitHub origin and creating a PR through the signed-in GitHub CLI. Falls back to the GitHub comparison page. Requires user confirmation.'
                : 'Propose pushing the exact task commit to origin and opening a pull request. GitLab can create a merge request during push. GitHub can use the signed-in GitHub CLI. Bitbucket opens the browser form. Requires user confirmation. On denial leave the commit local.',
            parameters: { type: 'object', properties: { repository: text, title: text, description: text }, required: ['repository', 'title', 'description'], additionalProperties: false }
        },
        prepare: (args, context) => preparePullRequest(args, context, githubOnly),
        execute: async (args, prepared, context) => repositoryMutation(args.repository, context, async () => {
            const actual = await preparePullRequest(args, context, githubOnly);
            if (JSON.stringify(actual) !== JSON.stringify(prepared)) throw new SafeToolError('The reviewed branch or destination changed. Request approval again.');
            const { remote, target, title, description } = actual;
            const mergeRequest = await pushTaskBranch(remote, target, title, description, context);
            if (mergeRequest) return JSON.stringify({ status: 'created', url: mergeRequest, commit: target.head });
            if (remote.provider === 'github') {
                const result = await githubRequest(remote, target, title, description, context).catch(() => undefined);
                context.signal.throwIfAborted();
                if (result) return JSON.stringify({ ...result, commit: target.head });
            }
            return JSON.stringify({ status: 'published', url: publicationPage(remote, target), commit: target.head, linkKind: remote.provider === 'other' ? 'repository' : 'form' });
        })
    });
}
