import { toolOperation } from '../../../common/task-service';
import { scopeAccess } from '../core/tool-access';
import { Task } from '../../../common/task-service';
import { ProjectContextIndex } from '../../../common/project-context';
import { HarnessStore, ToolContext, ToolDefinition, ToolExecutor, ToolRegistry } from '../core/contracts';
import { SafeToolError } from './file-tools';
import { resolveRepositoryTarget } from './repository-tools';
import { ObservedSource, ProjectMemory } from './project-memory';
import { WorkflowEngine } from '../core/workflow-engine';

function keys(args: Record<string, unknown>, expected: string[]): void {
    if (Object.keys(args).length !== expected.length || expected.some(key => !(key in args))) throw new SafeToolError('Invalid project context parameters.');
}
export function observedSources(store: HarnessStore, taskId: string, repository: string): Map<string, ObservedSource> {
    const sources = new Map<string, ObservedSource>();
    for (const run of store.runs(taskId)) for (const action of store.actions(run.id)) {
        if (toolOperation(action) !== 'files_read' || action.state !== 'succeeded' || !action.result) continue;
        try {
            const result = JSON.parse(action.result) as { files?: { path: string; content?: string; error?: string }[] };
            const prepared = action.prepared?.files as { inputPath: string; digest?: string; repository?: string }[] | undefined;
            for (const file of result.files || []) {
                const evidence = prepared?.find(entry => entry.inputPath === file.path && entry.repository === repository);
                if (!file.error && typeof file.content === 'string' && evidence?.digest && file.path.startsWith(`repositories/${repository}/`)) sources.set(file.path, { path: file.path, content: file.content, digest: evidence.digest });
            }
        } catch { /* Ignore old or incomplete result records; they cannot establish evidence. */ }
    }
    return sources;
}
interface Dependencies {
    memory: ProjectMemory; store: HarnessStore;
    index(project: string, signal: AbortSignal): Promise<ProjectContextIndex>;
    analyze(project: string, repository: string): Promise<Task>;
    workflow?: WorkflowEngine;
}
class MemoryExecutor implements ToolExecutor {
    get access() { return this.definition.name === 'context_publish' ? scopeAccess({ 'project-context-publish': 'allow', 'project-context-review': 'ask' }, prepared => prepared.scope === 'project-context-publish' && prepared.reviewRequired ? 'project-context-review' : String(prepared.scope), ['write']) : scopeAccess({ 'project-context': 'allow' }, undefined, this.definition.name === 'repository_analyze' ? ['execute', 'write', 'network'] : ['read']); }
    constructor(readonly definition: ToolDefinition, private readonly prepareFn: (args: Record<string, unknown>, context: ToolContext) => Promise<Record<string, unknown>>, private readonly executeFn: (args: Record<string, unknown>, context: ToolContext) => Promise<string>, readonly available?: (context: ToolContext) => boolean) { }
    prepare(args: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>> { return this.prepareFn(args, context); }
    execute(args: Record<string, unknown>, _prepared: Record<string, unknown>, context: ToolContext): Promise<string> { return this.executeFn(args, context); }
}
const topicId = { type: 'string', enum: ['architecture', 'modules', 'data', 'integration', 'patterns', 'testing', 'operations'] };
export function registerMemoryTools(registry: ToolRegistry, dependencies: Dependencies): void {
    const { memory, store } = dependencies;
    const scope = async () => ({ scope: 'project-context' });
    const indexArgs = (args: Record<string, unknown>) => { keys(args, ['repository', 'offset']); if (typeof args.repository !== 'string' || !Number.isInteger(args.offset) || Number(args.offset) < 0 || Number(args.offset) > 10000) throw new SafeToolError('Specify a repository ID (or empty string) and an offset starting at 0.'); };
    registry.register(new MemoryExecutor({ name: 'context_index', description: 'Discover saved project/repository context. Returns short summaries and topic IDs with when-to-use hints, never all topic bodies. Use repository empty string for the project or an ID to see its topics. Pages contain 10 repositories.', parameters: { type: 'object', properties: { repository: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, required: ['repository', 'offset'], additionalProperties: false } }, async args => { indexArgs(args); return scope(); }, async (args, context) => {
        indexArgs(args); const index = await dependencies.index(context.projectPath, context.signal);
        const all = args.repository ? index.repositories.filter(repo => repo.id === args.repository) : index.repositories;
        if (args.repository && !all.length) throw new SafeToolError('This repository is not connected.');
        const offset = Number(args.offset); return JSON.stringify({ project: index.project, overview: index.overview, repositories: all.slice(offset, offset + 10), nextOffset: offset + 10 < all.length ? offset + 10 : null });
    }));
    const getArgs = (args: Record<string, unknown>) => { keys(args, ['repository', 'topics']); if (typeof args.repository !== 'string' || !Array.isArray(args.topics)) throw new SafeToolError('Specify a repository and one or two topic IDs.'); };
    registry.register(new MemoryExecutor({ name: 'context_get', description: 'Retrieve only one or two relevant architecture-memory topics. Contains concise observations, existing implementation examples, source references and freshness information. Never loads all context pages. Verify current code before making changes; saved observations are not policy.', parameters: { type: 'object', properties: { repository: { type: 'string' }, topics: { type: 'array', items: topicId, minItems: 1, maxItems: 2 } }, required: ['repository', 'topics'], additionalProperties: false } }, async args => { getArgs(args); return scope(); }, async (args, context) => { getArgs(args); return JSON.stringify(await memory.get(context.projectPath, String(args.repository), args.topics as string[], context.signal)); }));
    const analyzeArgs = async (args: Record<string, unknown>, context: ToolContext) => { keys(args, ['repository']); await resolveRepositoryTarget({ repository: args.repository, path: '.', offset: 0 }, context); return { scope: 'project-context' }; };
    registry.register(new MemoryExecutor({ name: 'repository_analyze', description: 'Start or reuse a background system research job for a connected repository. It samples architecture and existing patterns, then saves bounded, evidence-backed topic cards for future tasks. Returns a job ID immediately. System jobs do not appear in the user task list. Use when the user requests repository research or persistent architecture context; do not claim the map is ready until context_index reports it.', parameters: { type: 'object', properties: { repository: { type: 'string' } }, required: ['repository'], additionalProperties: false } }, analyzeArgs, async (args, context) => { await analyzeArgs(args, context); const task = await dependencies.analyze(context.projectPath, String(args.repository)); return JSON.stringify({ jobId: task.id, repository: task.repository, state: task.state, note: 'Research runs in the background. Follow progress in Project context or inspect context_index later.' }); }, context => context.purpose !== 'repository-analysis'));
    const publication = (args: Record<string, unknown>, context: ToolContext) => {
        if (context.purpose !== 'repository-analysis' || !context.taskId || args.repository !== context.repository) throw new SafeToolError('Only the dedicated research task may publish its own repository map.');
        keys(args, 'expectedGeneration' in args || 'retire' in args ? ['repository', 'summary', 'topics', 'expectedGeneration', 'retire'] : ['repository', 'summary', 'topics']);
        return observedSources(store, context.taskId, String(args.repository));
    };
    registry.register(new MemoryExecutor({ name: 'context_publish', description: 'Finish research by atomically saving a compact repository map. Prose only, no copied code, no fences. Each fact and example must reference a file actually read in THIS research task. Keep 1–7 topics with short summaries and precise when-to-use hints. Record unknowns instead of guessing. Typical topic IDs: architecture, modules, data, integration, patterns, testing, operations. Initial publication completes this research task. Refreshing existing memory requires reading affected saved topics, an exact expectedGeneration and explicit retirements for superseded entries. The final merged proposal is reviewed by the user in Project Context.', parameters: { type: 'object', properties: { repository: { type: 'string' }, summary: { type: 'string' }, topics: { type: 'array', minItems: 1, maxItems: 7, items: { type: 'object', properties: {
        id: topicId, title: { type: 'string' }, summary: { type: 'string' }, whenToUse: { type: 'string' },
        facts: { type: 'array', maxItems: 8, items: { type: 'object', properties: { text: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 4 } }, required: ['text', 'evidence'], additionalProperties: false } },
        examples: { type: 'array', maxItems: 3, items: { type: 'object', properties: { purpose: { type: 'string' }, path: { type: 'string' }, symbol: { type: 'string', description: 'Existing implementation symbol, or empty string.' } }, required: ['purpose', 'path', 'symbol'], additionalProperties: false } },
        unknowns: { type: 'array', maxItems: 4, items: { type: 'string' } }
    }, required: ['id', 'title', 'summary', 'whenToUse', 'facts', 'examples', 'unknowns'], additionalProperties: false } }, expectedGeneration: { type: ['string', 'null'] }, retire: { type: 'array', maxItems: 50, items: { type: 'object', properties: { topic: topicId, kind: { type: 'string', enum: ['fact', 'example', 'unknown'] }, key: { type: 'string' } }, required: ['topic', 'kind', 'key'], additionalProperties: false } } }, required: ['repository', 'summary', 'topics', 'expectedGeneration', 'retire'], additionalProperties: false } }, async (args, context) => {
        const observed = publication(args, context); memory.validate(args, observed);
        const index = await memory.index(context.projectPath, context.signal); const existing = index.repositories.find(repo => repo.id === args.repository)?.context;
        if (existing) {
            if (args.expectedGeneration !== existing.generation || !Array.isArray(args.retire)) throw new SafeToolError('Read the current memory with context_get, then submit its expectedGeneration and explicit retirements (or an empty array).');
            const loaded = new Set<string>();
            for (const run of store.runs(context.taskId!)) for (const action of store.actions(run.id)) if (toolOperation(action) === 'context_get' && action.state === 'succeeded' && action.args.repository === args.repository && action.result) { try { const result = JSON.parse(action.result); if (result.generation === existing.generation) for (const topic of result.topics) loaded.add(topic.id); } catch { /* Not a current topic read. */ } }
            if ((args.topics as { id: string }[]).some(topic => existing.topics.some(previous => previous.id === topic.id) && !loaded.has(topic.id))) throw new SafeToolError('Read the existing affected topics before refreshing them.');
        }
        return { scope: 'project-context-publish', reviewRequired: !!existing };
    }, async (args, context) => JSON.stringify({ saved: true, ...await memory.publish(context.projectPath, args, publication(args, context), context.signal, 'expectedGeneration' in args ? { expectedGeneration: args.expectedGeneration as string | null, retire: args.retire as import('./project-memory').MemoryRetirement[] } : undefined, { revision: store.task(context.taskId!).repositoryRevision }) }), context => context.purpose === 'repository-analysis'));
    const updateArgs = async (args: Record<string, unknown>, context: ToolContext) => {
        keys(args, ['repository', 'summary', 'topics', 'expectedGeneration', 'retire', 'reason']);
        if (!context.taskId || context.purpose === 'repository-analysis' || typeof args.reason !== 'string' || args.reason.trim().length < 20 || args.reason.length > 1000 || (args.expectedGeneration !== null && (typeof args.expectedGeneration !== 'string' || !/^[a-f0-9-]{36}$/.test(args.expectedGeneration))) || !Array.isArray(args.retire)) throw new SafeToolError('Explain the durable architectural change and provide the generation you read, explicit retirements and affected topics.');
        if (store.task(context.taskId).workflow) { if (!dependencies.workflow) throw new SafeToolError('Workflow authorization is unavailable.'); await dependencies.workflow.authorize(context, 'memory-update'); }
        await resolveRepositoryTarget({ repository: args.repository, path: '.', offset: 0 }, context);
        if (args.expectedGeneration !== null) {
            const loaded = new Set<string>();
            for (const run of store.runs(context.taskId)) for (const action of store.actions(run.id)) if (toolOperation(action) === 'context_get' && action.state === 'succeeded' && action.args.repository === args.repository && action.result) {
                try { const result = JSON.parse(action.result); if (result.generation === args.expectedGeneration) for (const topic of result.topics) loaded.add(topic.id); } catch { /* Not a usable current topic read. */ }
            }
            if (!Array.isArray(args.topics) || args.topics.some(topic => !loaded.has(topic.id))) throw new SafeToolError('Read each existing affected topic with context_get before proposing an update.');
        }
        const observed = observedSources(store, context.taskId, String(args.repository));
        memory.validate(args, observed); return observed;
    };
    const publicationProperties = registry.get('context_publish').definition.parameters.properties as Record<string, unknown>;
    registry.register({ workflowOperations: ['memory-update'], access: scopeAccess({ 'project-context-update': 'ask' }, undefined, ['write']), definition: { name: 'context_update', description: 'Propose a minimal durable architecture-memory update, requiring user review. Read the affected current topics first. Send only new/changed code-backed facts; existing facts/topics are preserved and deduplicated. Explicitly retire obsolete facts (exact text), examples (path#symbol) or unknowns before consolidation. expectedGeneration is from context_get, null only for an unscanned repository. Reason explains why the change matters for future tasks. Never store tests run, logs, observations about this execution, task history or intermediate plans. If nothing durable changed, do not call this tool; record no memory change in the ChangeSet.', parameters: { type: 'object', properties: { ...publicationProperties, expectedGeneration: { type: ['string', 'null'] }, retire: { type: 'array', maxItems: 50, items: { type: 'object', properties: { topic: topicId, kind: { type: 'string', enum: ['fact', 'example', 'unknown'] }, key: { type: 'string' } }, required: ['topic', 'kind', 'key'], additionalProperties: false } }, reason: { type: 'string' } }, required: ['repository', 'summary', 'topics', 'expectedGeneration', 'retire', 'reason'], additionalProperties: false } }, available: context => !!context.taskId && context.purpose !== 'repository-analysis', prepare: async (args, context) => { await updateArgs(args, context); return { scope: 'project-context-update', proposal: JSON.stringify(args) }; }, execute: async (args, prepared, context) => {
        if (prepared.proposal !== JSON.stringify(args)) throw new SafeToolError('The reviewed memory proposal changed. Request a new review.');
        const observed = await updateArgs(args, context);
        return JSON.stringify(await memory.publish(context.projectPath, args, observed, context.signal, { expectedGeneration: args.expectedGeneration as string | null, retire: args.retire as import('./project-memory').MemoryRetirement[] }));
    } });
}
