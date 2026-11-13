import { governedDataDirectory } from '../data-directory';
import { MethodsImplementation } from './implementations/methods';
import { scopeAccess } from './core/tool-access';
import { ImplementationRegistry } from './core/implementations';
import { HandlerImplementation } from './implementations/handler';
import { ProcessImplementation } from './implementations/process';
import { dirname, join } from 'path';
import { ProjectToolService, ProjectTool, ToolPlan, ToolJob, ProjectToolCatalog, SavedTool } from '../../common/project-tool-service';
import { ToolContext, ToolRegistration, ToolRegistry } from './core/contracts';
import { ExecutorRegistry } from './core/execution';
import { ProjectToolRepository } from './storage/project-tools';
import { ExecutionStore } from './storage/executions';
import { ToolPolicies } from './storage/tool-policies';
import { ToolExecutionService } from './execution-service';
import { LocalProcessExecutor } from './executors/local-process';
import { SafeToolError } from './modules/file-tools';
export class ProjectTools implements ProjectToolService {
    readonly repository: ProjectToolRepository;
    readonly implementations = new ImplementationRegistry();
    readonly executions: ToolExecutionService;
    readonly executors: ExecutorRegistry;
    constructor(private readonly registry: ToolRegistry, private readonly policies: ToolPolicies, file = governedDataDirectory('runtime', 'executions.sqlite'), executors?: ExecutorRegistry) {
        this.executors = executors || new ExecutorRegistry();
        if (!executors) this.executors.register(new LocalProcessExecutor(join(dirname(file), 'tool-home')));
        this.repository = new ProjectToolRepository(this.implementations, registry); this.executions = new ToolExecutionService(this.repository, this.executors, new ExecutionStore(file));
        this.implementations.register(new HandlerImplementation(registry));
        for (const adapter of this.executors.catalog()) this.implementations.register(new ProcessImplementation(adapter, this.executions));
        this.implementations.register(new MethodsImplementation(this.implementations, registry));
        policies.useRepository(this.repository);
        registry.setProjectLoader(project => this.registrations(project));
    }
    onStart(): void { this.executions.onStart(); }
    onStop(): Promise<void> { return this.executions.onStop(); }
    close(): void { this.executions.store.close(); }
    private async registrations(project: string): Promise<ToolRegistration[]> {
        const result = await this.repository.list(project);
        if (result.errors.length) throw new SafeToolError(result.errors.join(' '));
        return result.tools.map(saved => this.implementations.get(saved.tool.implementation.executor).registration(saved));
    }
    async list(project: string): Promise<ProjectToolCatalog> {
        const result = await this.repository.list(project); return { ...result, implementations: this.implementations.choices() };
    }
    get(project: string, id: string): Promise<SavedTool> { return this.repository.get(project, id); }
    async save(project: string, tool: ProjectTool, revision: string | null): Promise<SavedTool> {
        const saved = await this.repository.save(project, tool, revision); project = await this.repository.project(project);
        await this.registry.refreshProject(project); await this.policies.initialize(project); return saved;
    }
    async plan(project: string, id: string, method?: string, inputs?: Record<string, unknown>): Promise<ToolPlan> { const saved = await this.repository.executable(project, id, method); if (saved.tool.policy.execute === 'deny') throw new SafeToolError('Execution is disabled by this tool policy.'); if (saved.tool.implementation.executor === 'handler') throw new SafeToolError('Invoke installed handlers through the task runtime with their declared parameters.'); return this.executions.plan(project, id, method, inputs); }
    async start(plan: ToolPlan): Promise<ToolJob> { const saved = await this.repository.executable(plan.project, plan.tool.id, plan.method); if (saved.tool.policy.execute === 'deny') throw new SafeToolError('Execution is disabled by this tool policy.'); return this.executions.start(plan); }
    jobs(project: string): Promise<ToolJob[]> { return this.executions.jobs(project); }
    cancel(project: string, id: string): Promise<void> { return this.executions.cancel(project, id); }
}

export function registerProjectToolManagement(registry: ToolRegistry, tools: ProjectTools): void {
    const available = (context: ToolContext) => context.purpose !== 'repository-analysis';
    const schema = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
    const text = { type: 'string' };
    const proposal=(value:unknown)=>{if(typeof value!=='string'||value.length>64000)throw new SafeToolError('Provide the complete tool manifest as a JSON string.');try{return tools.repository.validate(JSON.parse(value));}catch(error){throw new SafeToolError(error instanceof Error?error.message:'Invalid manifest JSON.');}};
    registry.register({ access: scopeAccess({ 'tools-read': 'allow' }, undefined, ['read']), available, definition: { name: 'tools_list', description: 'List tools defined in this project and built-in tools. Each project tool has its own callable functionName and policy. Use tools_get for its saved definition. Missing capabilities can be proposed with tools_propose. No execution.', parameters: schema({}) }, prepare: async () => ({ scope: 'tools-read' }), execute: async (_a, _p, c) => { const result = await tools.list(c.projectPath); return JSON.stringify({ tools: result.tools.map(({ tool, revision, functionName }) => ({ id: tool.id, name: tool.name, description: tool.description.slice(0, 200), executor: tool.implementation.executor, methods: tool.implementation.executor==='methods' ? (tool.implementation.configuration.methods as {id:string;name:string}[]).map(({id,name})=>({id,name})) : undefined, functionName, revision })), unavailable: result.unavailable.map(item => ({ id: item.id, error: item.error })), errors: result.errors.map(error => error.slice(0, 250)) }); } });
    registry.register({ access: scopeAccess({ 'tools-read': 'allow' }, undefined, ['read']), available, definition: { name: 'tools_get', description: 'Read a saved tool manifest, methods, implementation bindings, policy and revision before proposing changes.', parameters: schema({ id: text }) }, prepare: async () => ({ scope: 'tools-read' }), execute: async (a, _p, c) => JSON.stringify(await tools.repository.get(c.projectPath, String(a.id))) });
    registry.register({access:scopeAccess({'tools-read':'allow'}, undefined, ['read']),available,definition:{name:'tools_implementations',description:'Discover installed handler IDs, API versions, execution adapters and configuration schemas for defining tool methods. Metadata only; no installation or execution.',parameters:schema({})},prepare:async()=>({scope:'tools-read'}),execute:async()=>JSON.stringify({implementations:tools.implementations.choices()})});
    registry.register({ access: scopeAccess({ 'tools-proposal': 'allow' }), available, interaction: true, turnControl: true, get definition() { return { name: 'tools_propose', description: 'Propose creation or revision of a project tool using a complete JSON manifest string. The user edits and approves/rejects its DEFINITION. Saving never executes it. The manifest includes its policy and implementation. local-process tools have fixed commands and take a connected repository ID at run time; do not store a repository in the command configuration; handler tools bind an already installed handler ID/API version/settings and inherit its input schema. No downloading backend code from JSON. Default to Ask for native execution. After save use the returned functionName with its declared parameters. No arbitrary backend code, installer or shell expansion. expectedRevision is null for new tools or the exact tools_get revision for updates. Do not include credentials. Sole tool call in this turn.', parameters: schema({ tool: {type:'string',description:'Complete JSON tool manifest. Inspect tools.get for an example. Use executor methods to define named methods, each with id, name, description and implementation. Root policy keys are methodId--categoryId.'}, expectedRevision: { type: ['string', 'null'] } }) }; }, prepare: async a => {
        if (Object.keys(a).sort().join(',') !== 'expectedRevision,tool' || !(a.expectedRevision === null || (typeof a.expectedRevision === 'string' && /^[a-f0-9]{64}$/.test(a.expectedRevision)))) throw new SafeToolError('Provide a tool and its expected revision (null for creation).');
        return { scope: 'tools-proposal', tool: proposal(a.tool) };
    }, execute: async a => ({ kind: 'tool_proposal', tool: proposal(a.tool), expectedRevision: a.expectedRevision as string | null }), respond: async (request, response, context) => {
        if (!('save' in response) || typeof response.save !== 'boolean') throw new SafeToolError('Approve or reject the tool definition.');
        if (!response.save) return JSON.stringify({ saved: false, reason: 'User rejected the tool proposal.' });
        const tool = tools.repository.validate(response.tool); if (tool.id !== request.tool?.id) throw new SafeToolError('Keep the proposed tool ID when editing.');
        let saved: SavedTool | undefined; try { saved = await tools.repository.get(context.projectPath, tool.id); } catch { /* New definition. */ }
        if (!saved || JSON.stringify(saved.tool) !== JSON.stringify(tool)) saved = await tools.save(context.projectPath, tool, request.expectedRevision ?? null);
        return JSON.stringify({ saved: true, ...saved, executed: false });
    } });
    registry.register({ access: scopeAccess({ 'executions-read': 'allow' }), available, definition: { name: 'jobs_get', description: 'Read metadata of a tool execution in this task, with current source comparison where supported. Does not resend raw stored logs.', parameters: schema({ id: text }) }, prepare: async () => ({ scope: 'executions-read' }), execute: async (a, _p, c) => {
        const job = await tools.executions.job(c.projectPath, String(a.id)); if (!job || job.taskId !== c.taskId) throw new SafeToolError('Job not found in this task.'); const { output, ...metadata } = job;
        let matchesCurrentSource = false; try { matchesCurrentSource = await tools.executors.get(job.tool.implementation.executor).matchesCurrentSource?.(job, c) || false; } catch { /* Unverifiable means stale. */ }
        return JSON.stringify({ ...metadata, matchesCurrentSource, dependencyStateVerified: false });
    } });
    registry.register({ access: scopeAccess({ 'executions-read': 'allow' }), available, definition: { name: 'jobs_cancel', description: 'Stop a running project tool belonging to this task.', parameters: schema({ id: text }) }, prepare: async () => ({ scope: 'executions-read' }), execute: async (a, _p, c) => { const job = await tools.executions.job(c.projectPath, String(a.id)); if (!job || job.taskId !== c.taskId) throw new SafeToolError('Job not found in this task.'); await tools.cancel(c.projectPath, job.id); return JSON.stringify({ cancellationRequested: true, id: job.id }); } });
}
