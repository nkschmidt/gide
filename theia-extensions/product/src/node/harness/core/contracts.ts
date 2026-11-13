import { ToolFamily } from './tool-families';
import { Action, Approval, Message, Run, Task, TaskEvent } from '../../../common/task-service';
import { InteractionRequest, InteractionResponse, ToolInteraction } from '../../../common/interaction';
import { ToolAccess, PolicyVerdict, defaultToolAccess } from './tool-access';
import { TaskCheckpoint, TaskResult } from '../../../common/task-memory';

export interface ModelCall { id: string; tool: string; args: Record<string, unknown>; }
export interface ModelReply { outcome: 'message' | 'actions'; text: string; calls: ModelCall[]; continuation?: unknown[]; }
export interface ModelTurnPolicy { allowMessage: boolean; }
export class ModelProtocolError extends Error { constructor(message: string) { super(message); this.name = 'ModelProtocolError'; } }
export interface ModelProvider { readonly id: string; respond(messages: Message[], tools: ToolDefinition[], instructions: string, signal: AbortSignal, policy?: ModelTurnPolicy): Promise<ModelReply>; }
export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown>; }
export interface ToolContext { projectPath: string; signal: AbortSignal; taskId?: string; runId?: string; purpose?: 'chat' | 'repository-analysis'; repository?: string; }
export interface ProjectContextSource { overview(projectPath: string, signal: AbortSignal): Promise<string>; }
export interface ToolExecutor {
    readonly access?: ToolAccess;
    readonly methods?: Record<string, ToolRegistration>;
    readonly definition: ToolDefinition;
    readonly turnControl?: boolean;
    readonly requiresApproval?: boolean;
    readonly workflowSupport?: boolean;
    readonly workflowOperations?: readonly import('../../../common/workflow-run').WorkflowOperation[];
    readonly interaction?: boolean;
    available?(context: ToolContext): boolean;
    prepare(args: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>>;
    execute(args: Record<string, unknown>, prepared: Record<string, unknown>, context: ToolContext): Promise<string | ToolInteraction>;
    respond?(request: InteractionRequest, response: InteractionResponse, context: ToolContext): Promise<string>;
}
export interface Policy { evaluate(action: Action, access: ToolAccess, context: ToolContext): Promise<PolicyVerdict>; }
export interface OutputFilter { filter(text: string): string; }
export interface HarnessStore {
    transaction<T>(operation: () => T): T;
    tasks(projectPath: string): Task[];
    task(id: string): Task;
    putTask(task: Task): void;
    messages(taskId: string): Message[];
    messageRecords(taskId: string): Message[];
    result(taskId: string, id: string): TaskResult;
    checkpoint(taskId: string): TaskCheckpoint | undefined;
    putCheckpoint(checkpoint: TaskCheckpoint, expectedId?: string): void;
    putMessage(message: Message): void;
    runs(taskId: string): Run[];
    pendingRuns(): Run[];
    run(id: string): Run;
    putRun(run: Run): void;
    actions(runId: string): Action[];
    action(id: string): Action;
    putAction(action: Action): void;
    approvals(actionId: string): Approval[];
    putApproval(approval: Approval): void;
    interaction(id: string): InteractionRequest;
    interactions(taskId: string): InteractionRequest[];
    putInteraction(request: InteractionRequest): void;
    event(taskId: string, runId: string | undefined, type: string, data?: Record<string, unknown>): void;
    events(taskId: string): TaskEvent[];
    recover(): void;
}

export interface ToolModule { id: string; version: string; register(registry: ToolRegistry): void; }
export interface ToolRegistration { executor: ToolExecutor; access: ToolAccess; module: string; version: string; revision?: string; manifestId?: string; enabled?: boolean; method?: string; handlerId?: string; handlerTool?: string; }
export interface ToolHandler {
    id: string; apiVersion: string; name: string; configurationSchema: Record<string, unknown>; defaultConfiguration: Record<string, unknown>;
    validate(configuration: unknown): Record<string, unknown>;
    bind(configuration: Record<string, unknown>): ToolExecutor;
}
export interface HandlerRegistration { handler: ToolHandler; module: string; version: string; }
export class ToolRegistry {
    readonly families: ToolFamily[] = [];
    registerFamily(family: ToolFamily): void { if (this.families.some(item=>item.id===family.id) || !/^[a-z][a-z0-9_]{0,31}$/.test(family.id) || !Array.isArray(family.methods) || !family.methods.length || family.methods.length>40 || new Set(family.methods.map(method=>method.id)).size!==family.methods.length || family.methods.some(method=>!this.registrations.has(method.source)||!/^[a-z][a-z0-9_]{0,31}$/.test(method.id)||!method.name)) throw new Error("Invalid tool family registration."); this.families.push(family); }
    private readonly executors = new Map<string, ToolExecutor>();
    private readonly registrations = new Map<string, ToolRegistration>();
    private readonly modules = new Set<string>();
    private readonly handlers = new Map<string, HandlerRegistration>();
    private readonly projects = new Map<string, ToolRegistration[]>();
    private projectLoader?: (project: string) => Promise<ToolRegistration[]>;
    private readonly loading = new Map<string, Promise<void>>();
    constructor(private readonly moduleId = 'builtin', private readonly moduleVersion = '1.0.0') { }
    register(executor: ToolExecutor): void {
        if (!/^[a-z][a-z0-9_]{0,79}$/.test(executor.definition.name) || this.executors.has(executor.definition.name)) throw new Error('Invalid or duplicate tool registration.');
        const access = executor.access || defaultToolAccess();
        if (!access.categories.length || access.categories.length > 30 || new Set(access.categories.map(item => item.id)).size !== access.categories.length || access.categories.some(item => !/^[a-z0-9][a-z0-9_-]{0,159}$/.test(item.id) || !['allow', 'ask', 'deny'].includes(item.defaultDecision))) throw new Error('Invalid tool access manifest.');
        this.executors.set(executor.definition.name, executor);
        this.registrations.set(executor.definition.name, { executor, access, module: this.moduleId, version: this.moduleVersion });
        this.registerHandler({ id: `${this.moduleId}/${executor.definition.name}`, apiVersion: this.moduleVersion.split('.')[0], name: executor.definition.name, configurationSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }, defaultConfiguration: {}, validate: configuration => { if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration) || Object.keys(configuration).length) throw new Error('This handler does not accept settings.'); return {}; }, bind: () => executor });
    }
    registerHandler(handler: ToolHandler): void {
        if (!/^[a-z0-9][a-z0-9._/-]{0,159}$/.test(handler.id) || !/^\d+$/.test(handler.apiVersion) || this.handlers.has(handler.id)) throw new Error('Invalid or duplicate handler registration.');
        this.handlers.set(handler.id, { handler, module: this.moduleId, version: this.moduleVersion });
    }
    handler(id: string, version: string): HandlerRegistration {
        const entry = this.handlers.get(id); if (!entry) throw new Error(`Handler "${id}" is not installed.`);
        if (entry.handler.apiVersion !== version) throw new Error(`Handler "${id}" API ${version} is unavailable; installed API is ${entry.handler.apiVersion}.`); return entry;
    }
    handlerCatalog(): HandlerRegistration[] { return [...this.handlers.values()]; }
    registerModule(module: ToolModule): void {
        if (!/^[a-z0-9][a-z0-9.-]{0,99}$/.test(module.id) || !/^\d+\.\d+\.\d+$/.test(module.version) || this.modules.has(module.id)) throw new Error('Invalid or duplicate tool module.');
        const scoped = new ToolRegistry(module.id, module.version); module.register(scoped);
        for (const item of scoped.catalog()) if (this.executors.has(item.executor.definition.name)) throw new Error('Tool module conflicts with an existing tool.');
        for (const item of scoped.handlerCatalog()) if (this.handlers.has(item.handler.id)) throw new Error('Tool module conflicts with an existing handler.');
        for(const family of scoped.families)if(this.families.some(item=>item.id===family.id))throw new Error('Tool module conflicts with an existing family.');
        for (const item of scoped.catalog()) { this.executors.set(item.executor.definition.name, item.executor); this.registrations.set(item.executor.definition.name, item); }
        for (const item of scoped.handlerCatalog()) this.handlers.set(item.handler.id, item);
        this.families.push(...scoped.families);
        this.modules.add(module.id);
    }
    setProjectLoader(loader: (project: string) => Promise<ToolRegistration[]>): void { if (this.projectLoader) throw new Error('Project tool loader already installed.'); this.projectLoader = loader; }
    async refreshProject(project: string): Promise<void> {
        if (!this.projectLoader) return;
        const pending = this.loading.get(project); if (pending) return pending;
        const load = (async () => {
            const entries = await this.projectLoader!(project); const names = new Set<string>();
            for (const entry of entries) {
                const name = entry.executor.definition.name;
                const builtin = this.registrations.get(name);
                if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || names.has(name) || (builtin && (!entry.manifestId || entry.module !== builtin.module))) throw new Error('Project tool registration conflicts with another tool.');
                names.add(name);
            }
            this.projects.set(project, entries);
        })(); this.loading.set(project, load);
        try { await load; } catch (error) { this.projects.delete(project); throw error; } finally { this.loading.delete(project); }
    }
    catalog(project?: string): ToolRegistration[] { return project && this.projectLoader ? this.projects.get(project) || [] : [...this.registrations.values()]; }
    registration(name: string, project?: string, method?: string): ToolRegistration {
        this.get(name, project); const entry = this.catalog(project).find(item => item.executor.definition.name === name)!;
        if (entry.executor.methods) { if (!method) return entry; const child=Object.prototype.hasOwnProperty.call(entry.executor.methods,method)?entry.executor.methods[method]:undefined; if(!child) throw new ModelProtocolError('This tool method is not available.'); return child; }
        if(method) throw new ModelProtocolError('This tool has no methods.'); return entry;
    }
    call(name:string,args:Record<string,unknown>,project?:string): { method?:string; args:Record<string,unknown>; registration?:ToolRegistration } {
        const entry=this.catalog(project).find(item=>item.executor.definition.name===name); if(!entry) return {args};
        if(!entry.executor.methods) return {args,registration:entry};
        const call=args.call as {method:string;arguments:Record<string,unknown>};
        if(Object.keys(args).join(',')!=='call'||!call||Object.keys(call).sort().join(',')!=='arguments,method'||typeof call.method!=='string'||!call.arguments||typeof call.arguments!=='object'||Array.isArray(call.arguments)) throw new ModelProtocolError('Call a declared method with {call:{method,arguments}}.');
        return { method:call.method,args:call.arguments,registration:this.registration(name,project,call.method) };
    }
    get(name: string, project?: string): ToolExecutor {
        const executor = project && this.projectLoader ? this.projects.get(project)?.find(item => item.executor.definition.name === name)?.executor : this.executors.get(name);
        if (!executor) throw new Error('This tool is not available.');
        return executor;
    }
    canonicalCall(name:string,project?:string):{tool:string;method?:string}{for(const entry of this.catalog(project)){for(const [method,child]of Object.entries(entry.executor.methods||{}))if(child.handlerTool===name)return{tool:entry.executor.definition.name,method};if(entry.executor.definition.name===name)return{tool:name};}throw new Error('This operation is not installed.');}
    isTurnControl(name: string, project?: string): boolean { return !!this.catalog(project).find(item => item.executor.definition.name === name)?.executor.turnControl; }
    isInteractionTool(name: string, project?: string): boolean { return !!this.catalog(project).find(item => item.executor.definition.name === name)?.executor.interaction; }
    definitions(context?: ToolContext): ToolDefinition[] { return this.catalog(context?.projectPath).map(item => item.executor).filter(tool => !context || !tool.available || tool.available(context)).map(tool => tool.definition); }
}
