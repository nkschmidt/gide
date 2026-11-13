import { createHash } from 'crypto';
import { Task } from '../../../common/task-service';
import { WorkflowObserver } from '../core/workflow-engine';
import { git, gitRoot, gitState } from './git-tools';
import { sourceIdentity } from './git-snapshot';
import { SafeToolError } from './file-tools';
import { readFile } from 'fs/promises';
import { resolve } from 'path';

/** Optional evidence adapter. The workflow state machine has no Git-specific transitions. */
export class RepositoryWorkflowObserver implements WorkflowObserver {
    readonly id = 'repository-source';
    readonly name = 'Repository source state';
    readonly description = 'Show changed files from Git and reject approval or completion if the reviewed source changes.';
    async capture(task: Task, signal: AbortSignal) {
        const repositories: { repository: string; branch: string; head: string; files: { path: string; status: string }[] }[] = [];
        const identities: unknown[] = [];
        const branches = task.workflow?.branches || {};
        const workspace = JSON.parse(await readFile(resolve(task.projectPath, 'project.theia-workspace'), 'utf8'));
        const ids: string[] = Object.keys(branches).length ? Object.keys(branches) : (workspace.governedRepositories || []).map((item: { id: string }) => item.id);
        for (const repository of ids.sort()) {
            const context = { projectPath: task.projectPath, taskId: task.id, signal };
            const root = await gitRoot(repository, context); const before = await sourceIdentity(repository, context, { includeRevision: false });
            const state = await gitState(root, context);
            const raw = (await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', branches[repository]?.head || state.head, '--'], context)).split('\0').filter(Boolean);
            const files = new Map<string, string>(); for (let index = 0; index < raw.length; index += 2) files.set(raw[index + 1], raw[index]);
            for (const entry of state.entries) if (entry.status === '??') files.set(entry.path, 'A');
            if (await sourceIdentity(repository, context, { includeRevision: false }) !== before) throw new SafeToolError('Repository changed while preparing review evidence. Submit a fresh report.');
            identities.push({ repository, root, branch: state.branch, before });
            repositories.push({ repository, branch: state.branch, head: state.head, files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, status]) => ({ path, status })).slice(0, 2000) });
        }
        const paths = repositories.flatMap(repository => repository.files.map(file => `${file.status} \`${repository.repository}/${file.path.replace(/[`\r\n]/g, '').slice(0, 240)}\``));
        return { fingerprint: createHash('sha256').update(JSON.stringify(identities)).digest('hex'), data: { repositories },
            ...(repositories.length ? { summary: '**Changed files · Git**\n' + (paths.length ? paths.slice(0, 30).map(path => '- ' + path).join('\n') + (paths.length > 30 ? `\n- … ${paths.length - 30} more; see Git diff.` : '') : 'No source changes against the recorded task base.') } : {}) };
    }
}

/** Application composition point shared by execution and the workflow editor. */
export function createWorkflowObservers(): WorkflowObserver[] { return [new RepositoryWorkflowObserver()]; }
