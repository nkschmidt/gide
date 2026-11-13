import { ProjectTool, SavedTool, ToolPlan } from '../../../common/project-tool-service';
import { ExecutionAdapter } from '../core/execution';
import { ToolContext, ToolExecutor } from '../core/contracts';
import { ToolImplementation } from '../core/implementations';
import { scopeAccess } from '../core/tool-access';
import { ToolExecutionService } from '../execution-service';
import { SafeToolError } from '../modules/file-tools';
export class ProcessImplementation implements ToolImplementation {
    readonly id: string;
    constructor(private readonly adapter: ExecutionAdapter, private readonly executions: ToolExecutionService) { this.id = adapter.id; }
    validate(configuration: unknown): Record<string, unknown> { return this.adapter.validate(configuration); }
    validateProject(tool: ProjectTool, context: ToolContext): Promise<void> { return this.adapter.validateProject(tool, context); }
    access() { return { ...scopeAccess({ execute: 'ask' }), analyze: () => ({ category: 'execute', effects: ['execute', 'unknown'] as const }) }; }
    choices() { return [{ key: this.id, label: this.id === 'local-process' ? 'Local command' : this.id, executor: this.id, configuration: {}, configurationSchema: this.adapter.configurationSchema, categories: this.access().categories }]; }
    registration(saved: SavedTool) {
        const executor: ToolExecutor = {
            definition: { name: saved.tool.toolName, description: `${saved.tool.name}: ${saved.tool.description} Runs a fixed project tool using its declared inputs; no runtime command overrides. Policy controls execution. Output is unfiltered for secrets.`, parameters: this.adapter.inputSchema || { type: 'object', properties: {}, required: [], additionalProperties: false } },
            available: context => context.purpose !== 'repository-analysis',
            prepare: async (args, context) => { const plan = await this.executions.plan(context.projectPath, saved.tool.id, saved.method, args); if (plan.revision !== saved.revision) throw new SafeToolError('Tool manifest changed. Request the current tool again.'); return { scope: 'execute', plan, review: { kind: 'project-tool', ...plan } }; },
            execute: async (_args, prepared, context) => {
                const job = await this.executions.run(prepared.plan as unknown as ToolPlan, context.signal, context.taskId); const { tool, project, output, ...metadata } = job;
                return JSON.stringify({ ...metadata, toolId: tool.id, toolName: tool.name, executor: tool.implementation.executor, output: output.slice(0, 12000), excerptTruncated: output.length > 12000, sourceScope: 'Before/after observations where supported; not an isolated source snapshot or dependency verification.' });
            }
        };
        return { executor, access: this.access(), module: 'project.tools', version: '1.0.0', revision: saved.revision, manifestId: saved.tool.id };
    }
}
