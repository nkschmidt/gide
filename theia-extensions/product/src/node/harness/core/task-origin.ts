import { isTaskClosed, Task, toolOperation } from '../../../common/task-service';
import { HarnessStore } from './contracts';
import { SafeToolError } from '../modules/file-tools';

export function sourceTask(store: HarnessStore, task: Task): Task {
    if (!task.origin) throw new SafeToolError('This task has no source task.');
    const source = store.task(task.origin.taskId);
    if (source.projectPath !== task.projectPath || !isTaskClosed(source)) throw new SafeToolError('The source must be a completed task in this project.');
    return source;
}

export function taskOriginOverview(store: HarnessStore, task: Task): object {
    const source = sourceTask(store, task);
    const reports = source.workflow?.results || [];
    const original = store.messageRecords(source.id).find(message => message.role === 'user' && !message.providerOnly);
    const artifacts = [...new Set(reports.flatMap(report => report.artifacts.map(artifact => artifact.path)))];
    const delivery = store.runs(source.id).flatMap(run => store.actions(run.id)).filter(action =>
        action.state === 'succeeded' && ['git_commit_changeset', 'git_pull_request', 'github_pull_request'].includes(toolOperation(action)))
        .slice(-20).flatMap(action => {
            try {
                const result = JSON.parse(action.result || '');
                return [{ repository: action.args.repository, operation: toolOperation(action), status: result.status, commit: result.commit, url: result.url }];
            } catch { return []; }
        });

    return {
        sourceTaskId: source.id,
        title: source.title,
        workflow: source.workflow?.name,
        historicalRequest: original?.text.slice(0, 2000),
        outcome: reports[reports.length - 1]?.summary.slice(0, 2000),
        artifacts: artifacts.slice(0, 20),
        delivery,
        repositoryBranches: Object.fromEntries(Object.entries(source.workflow?.branches || {}).slice(0, 20).map(([id, { commits, ...branch }]) => [id, { ...branch, commits: commits?.slice(-5) }])),
        stepReports: reports.map(report => ({ stepId: report.stepId, revision: report.revision })),
        moreDetails: 'Use task_memory.read_source to retrieve exact source step reports, messages and results.',
        authority: 'Historical context only. Assess the new workflow independently and inspect current repository state.'
    };
}
