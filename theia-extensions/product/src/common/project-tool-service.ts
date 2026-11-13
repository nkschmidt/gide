export interface LocalProcessConfiguration {
    directory: string; program: string; arguments: string[];
    environment: 'local'; timeoutSeconds: number; outputLimit: number;
}
import { AccessCategory, AccessDecision } from './tool-policy';
export interface ProjectTool {
    schemaVersion: 2; id: string; toolName: string; name: string; description: string;
    implementation: { executor: string; configuration: Record<string, unknown> };
    policy: Record<string, AccessDecision>;
}
export interface SavedTool { tool: ProjectTool; revision: string; functionName: string; method?: string; methods?: import('./tool-methods').ToolMethodSummary[]; origin?: 'builtin' | 'project'; workflowSupport?: boolean; categories?: AccessCategory[]; }
export interface ToolProblem { id: string; name: string; error: string; revision?: string; tool?: ProjectTool; }
export interface ImplementationChoice { key: string; label: string; executor: string; configuration: Record<string, unknown>; configurationSchema: Record<string, unknown>; categories: AccessCategory[]; }
export interface ExecutionReview { fields: { label: string; value: string }[]; warning: string; }
export interface ToolPlan extends SavedTool {
    project: string; inputs?: Record<string, unknown>; binding: Record<string, unknown>; review: ExecutionReview;
}
export interface ToolJob {
    id: string; project: string; taskId?: string; inputs?: Record<string, unknown>; tool: ProjectTool; method?: string;
    state: 'running' | 'cancelling' | 'passed' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
    startedAt: number; finishedAt?: number; exitCode?: number | null; signal?: string | null;
    output: string; truncated: boolean; sourceBefore?: string; sourceAfter?: string; sourceChanged?: boolean; error?: string;
}
export interface ProjectToolCatalog { tools: SavedTool[]; unavailable: ToolProblem[]; implementations: ImplementationChoice[]; errors: string[]; }
export const ProjectToolService = Symbol('ProjectToolService');
export const ProjectToolServicePath = '/services/project-tools';
export interface ProjectToolService {
    list(project: string): Promise<ProjectToolCatalog>;
    get(project: string, id: string): Promise<SavedTool>;
    save(project: string, tool: ProjectTool, expectedRevision: string | null): Promise<SavedTool>;
    plan(project: string, id: string, method?: string, inputs?: Record<string, unknown>): Promise<ToolPlan>;
    start(plan: ToolPlan): Promise<ToolJob>;
    jobs(project: string): Promise<ToolJob[]>;
    cancel(project: string, id: string): Promise<void>;
}
