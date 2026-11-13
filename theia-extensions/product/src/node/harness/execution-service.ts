import { randomUUID } from 'crypto';
import { ToolJob, ToolPlan } from '../../common/project-tool-service';
import { ExecutorRegistry } from './core/execution';
import { ProjectToolRepository } from './storage/project-tools';
import { ExecutionStore } from './storage/executions';
import { projectMutations } from './storage/mutation-queue';
import { SafeToolError } from './modules/file-tools';
export class ToolExecutionService {
    private stopping = false;
    private readonly active = new Map<string, { project: string; resource: string; controller: AbortController; done: Promise<ToolJob> }>();
    constructor(readonly repository: ProjectToolRepository, readonly executors: ExecutorRegistry, readonly store: ExecutionStore) { }
    onStart(): void { this.store.open(); }
    async onStop(): Promise<void> { this.stopping = true; const entries = [...this.active.values()]; entries.forEach(entry => entry.controller.abort()); await Promise.allSettled(entries.map(entry => entry.done)); }
    async plan(project: string, id: string, method?: string, inputs: Record<string, unknown> = {}): Promise<ToolPlan> {
        project = await this.repository.project(project); const saved = await this.repository.executable(project, id, method);
        const adapter = this.executors.get(saved.tool.implementation.executor);
        if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs) || (!adapter.inputSchema && Object.keys(inputs).length)) throw new SafeToolError('Invalid runtime inputs for this tool.');
        const target = await adapter.prepare(saved.tool, { projectPath: project, signal: AbortSignal.timeout(30000) }, inputs);
        return { ...saved, project, ...(Object.keys(inputs).length ? { inputs: { ...inputs } } : {}), ...target };
    }
    async start(plan: ToolPlan): Promise<ToolJob> { return (await this.launch(plan)).job; }
    async run(plan: ToolPlan, signal: AbortSignal, taskId?: string): Promise<ToolJob> {
        signal.throwIfAborted(); const run = await this.launch(plan, taskId, signal); const stop = () => this.active.get(run.job.id)?.controller.abort(); signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
        try { return await run.done; } finally { signal.removeEventListener('abort', stop); }
    }
    async jobs(project: string): Promise<ToolJob[]> { return this.store.list(await this.repository.project(project)); }
    async job(project: string, id: string): Promise<ToolJob | undefined> { return this.store.get(await this.repository.project(project), id); }
    async cancel(project: string, id: string): Promise<void> { project = await this.repository.project(project); const entry = this.active.get(id); if (entry?.project === project) entry.controller.abort(); }
    private async launch(plan: ToolPlan, taskId?: string, signal?: AbortSignal): Promise<{ job: ToolJob; done: Promise<ToolJob> }> {
        const resource = this.executors.get(plan.tool.implementation.executor).resourceKey(plan);
        return projectMutations.run(`tool-launch:${resource}`, async () => {
            signal?.throwIfAborted(); const current = await this.plan(plan.project, plan.tool.id, plan.method, plan.inputs); signal?.throwIfAborted();
            if (this.stopping) throw new SafeToolError('The application is stopping. Nothing was run.');
            if (JSON.stringify(current) !== JSON.stringify(plan)) throw new SafeToolError('Tool, source, executable, environment or repository changed after review. Review the new run request.');
            if ([...this.active.values()].some(entry => entry.project === plan.project || entry.resource === resource)) throw new SafeToolError('A tool is already running in this project or repository. Stop it or wait.');
            const job: ToolJob = { id: randomUUID(), project: plan.project, taskId, ...(plan.inputs ? { inputs: plan.inputs } : {}), tool: plan.tool, ...(plan.method ? { method:plan.method } : {}), state: 'running', startedAt: Date.now(), output: '', truncated: false, sourceBefore: typeof plan.binding.source === 'string' ? plan.binding.source : undefined };
            const controller = new AbortController(); this.store.put(job); let bytes = 0;
            const limit = Math.min(262144, Math.max(1024, this.executors.get(plan.tool.implementation.executor).outputLimit(plan)));
            const done = Promise.resolve().then(async () => {
                try {
                    const result = await this.executors.get(plan.tool.implementation.executor).execute(plan, { projectPath: plan.project, signal: controller.signal, taskId }, {
                        output: chunk => { const remaining = limit - bytes; const kept = chunk.subarray(0, Math.max(0, remaining)); bytes += kept.length; job.output += kept.toString('utf8'); if (chunk.length > remaining) job.truncated = true; this.store.put(job); },
                        stopping: () => { job.state = 'cancelling'; this.store.put(job); }
                    }); Object.assign(job, result);
                } catch (error) { job.state = controller.signal.aborted ? 'cancelled' : 'failed'; job.error = error instanceof SafeToolError ? error.message : 'Executor could not complete the run.'; }
                job.finishedAt = Date.now(); this.store.put(job); this.active.delete(job.id); return { ...job };
            });
            this.active.set(job.id, { project: plan.project, resource, controller, done }); return { job: { ...job }, done };
        });
    }
}
