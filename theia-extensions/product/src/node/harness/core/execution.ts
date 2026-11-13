import { ProjectTool, ExecutionReview, ToolPlan, ToolJob } from '../../../common/project-tool-service';
import { ToolContext } from './contracts';
export interface ExecutionResult {
    state: 'passed' | 'failed' | 'cancelled' | 'timed_out'; exitCode?: number | null; signal?: string | null;
    sourceAfter?: string; sourceChanged?: boolean; error?: string;
}
export interface ExecutionObserver { output(chunk: Buffer): void; stopping(): void; }
export interface ExecutionAdapter {
    readonly id: string;
    readonly configurationSchema: Record<string, unknown>;
    validate(configuration: unknown): Record<string, unknown>;
    validateProject(tool: ProjectTool, context: ToolContext): Promise<void>;
    readonly inputSchema?: Record<string, unknown>;
    prepare(tool: ProjectTool, context: ToolContext, inputs?: Record<string, unknown>): Promise<{ binding: Record<string, unknown>; review: ExecutionReview }>;
    execute(plan: ToolPlan, context: ToolContext, observer: ExecutionObserver): Promise<ExecutionResult>;
    resourceKey(plan: ToolPlan): string;
    outputLimit(plan: ToolPlan): number;
    matchesCurrentSource?(job: ToolJob, context: ToolContext): Promise<boolean>;
}
export class ExecutorRegistry {
    private readonly adapters = new Map<string, ExecutionAdapter>();
    register(adapter: ExecutionAdapter): void {
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(adapter.id) || this.adapters.has(adapter.id)) throw new Error('Invalid or duplicate execution adapter.');
        this.adapters.set(adapter.id, adapter);
    }
    get(id: string): ExecutionAdapter { const adapter = this.adapters.get(id); if (!adapter) throw new Error(`Executor "${id}" is not installed.`); return adapter; }
    catalog(): ExecutionAdapter[] { return [...this.adapters.values()]; }
}
export type ExecutionRecord = ToolJob;
