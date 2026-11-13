import { ProjectTool, SavedTool } from '../../../common/project-tool-service';
import { ToolContext, ToolExecutor, ToolRegistry } from '../core/contracts';
import { ToolImplementation } from '../core/implementations';
import { defaultToolAccess } from '../core/tool-access';
import { SafeToolError } from '../modules/file-tools';
export class HandlerImplementation implements ToolImplementation {
    readonly id = 'handler';
    constructor(private readonly registry: ToolRegistry) { }
    validate(value: unknown): Record<string, unknown> {
        const c = value as { handler: string; version: string; settings: Record<string, unknown> };
        if (!c || Object.keys(c).sort().join(',') !== 'handler,settings,version' || typeof c.handler !== 'string' || typeof c.version !== 'string') throw new SafeToolError('A handler binding requires handler ID, API version and settings.');
        const { handler } = this.registry.handler(c.handler, c.version); return { handler: c.handler, version: c.version, settings: handler.validate(c.settings) };
    }
    private resolve(configuration: Record<string, unknown>) {
        const c = this.validate(configuration); const registration = this.registry.handler(String(c.handler), String(c.version));
        return { registration, executor: registration.handler.bind(c.settings as Record<string, unknown>) };
    }
    access(configuration: Record<string, unknown>) { return this.resolve(configuration).executor.access || defaultToolAccess(); }
    async validateProject(_tool: ProjectTool, _context: ToolContext): Promise<void> { }
    choices() {
        return this.registry.handlerCatalog().map(({ handler }) => ({ key: `handler:${handler.id}:${handler.apiVersion}`, label: (()=>{for(const family of this.registry.families){const method=family.methods.find(item=>handler.id===`${this.registry.catalog().find(entry=>entry.executor.definition.name===item.source)?.module}/${item.source}`);if(method)return `${family.name} / ${method.name}`;}return handler.name.replace(/_/g,' ').replace(/^./,c=>c.toUpperCase());})(), executor: this.id, configuration: { handler: handler.id, version: handler.apiVersion, settings: handler.defaultConfiguration }, configurationSchema: handler.configurationSchema, categories: (handler.bind(handler.defaultConfiguration).access || defaultToolAccess()).categories }));
    }
    registration(saved: SavedTool) {
        const { registration, executor: source } = this.resolve(saved.tool.implementation.configuration);
        const executor: ToolExecutor = {
            definition: { ...source.definition, name: saved.tool.toolName, description: saved.tool.description },
            workflowOperations: source.workflowOperations, workflowSupport: saved.origin === 'builtin' && source.workflowSupport, turnControl: source.turnControl, requiresApproval: source.requiresApproval, interaction: source.interaction,
            available: source.available?.bind(source), prepare: source.prepare.bind(source), execute: source.execute.bind(source), respond: source.respond?.bind(source)
        };
        return { executor, access: source.access || defaultToolAccess(), module: registration.module, version: registration.version, revision: saved.revision, manifestId: saved.tool.id, handlerId: registration.handler.id, handlerTool: source.definition.name };
    }
}
