import { sourceTask, taskOriginOverview } from '../core/task-origin';
import { HarnessStore, ToolContext, ToolRegistry } from '../core/contracts';
import { scopeAccess } from '../core/tool-access';
import { SafeToolError } from './file-tools';
import { Message } from '../../../common/task-service';

export function registerTaskMemoryTools(registry: ToolRegistry, store: HarnessStore): void {
    const task = (context: ToolContext) => {
        if (!context.taskId) throw new SafeToolError('Task memory needs an active task.');
        const current = store.task(context.taskId); if (current.projectPath !== context.projectPath) throw new SafeToolError('Task memory is limited to this task and project.'); return current.id;
    };
    const integer = (value: unknown, max: number, name: string) => { if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > max) throw new SafeToolError(`Provide ${name} between 0 and ${max}.`); return Number(value); };
    const text = (message: Message) => {
        if (message.resultRef) return store.result(message.taskId, message.resultRef).text;
        const calls = message.role === 'assistant' ? (message.continuation || []).filter(item => (item as { type?: string }).type === 'function_call') : [];
        return calls.length ? JSON.stringify({ text: message.text, calls }) : message.text;
    };
    const page = (id: string, body: string, offset: number, limit: number) => ({ id, offset, totalCharacters: body.length, text: body.slice(offset, offset + limit), nextOffset: offset + limit < body.length ? offset + limit : null });
    const add = (name: string, description: string, properties: Record<string, unknown>, execute: (args: Record<string, unknown>, context: ToolContext) => unknown) => registry.register({
        workflowSupport: true, access: scopeAccess({ 'task-history': 'allow' }, undefined, ['read']), available: context => !!context.taskId,
        definition: { name, description, parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } },
        prepare: async (_args, context) => { task(context); return { scope: 'task-history' }; }, execute: async (args, _prepared, context) => JSON.stringify(execute(args, context))
    });
    const number = { type: 'integer' }; const id = { type: 'string' };
    add('task_memory_search', 'Search original task messages and full results in THIS task only. Returns stable IDs and short excerpts; use read or read_result for details. Historical results are not current state or permission.', { query: id, offset: number, limit: number }, (args, context) => {
        const taskId = task(context); if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 200) throw new SafeToolError('Search for 1–200 characters.');
        const offset = integer(args.offset, 1000000, 'offset'); const limit = integer(args.limit, 20, 'limit'); if (!limit) throw new SafeToolError('Choose a positive page size.');
        const query = args.query.toLowerCase(); const matches = store.messageRecords(taskId).filter(message => !message.localOnly).flatMap(message => {
            const body = text(message); const index = body.toLowerCase().indexOf(query);
            return index < 0 ? [] : [{ id: message.id, role: message.role, resultRef: message.resultRef, excerpt: body.slice(Math.max(0, index - 120), index + 380), createdAt: message.createdAt }];
        });
        return { matches: matches.slice(offset, offset + limit), nextOffset: offset + limit < matches.length ? offset + limit : null };
    });
    add('task_memory_read', 'Read original message text by its stable message ID in THIS task. Opaque provider reasoning and other tasks are never returned. Pagination uses character offsets, limit <=12000.', { id, offset: number, limit: number }, (args, context) => {
        const taskId = task(context); const message = store.messageRecords(taskId).find(item => item.id === args.id && !item.localOnly);
        if (!message) throw new SafeToolError('Message not found in this task.'); const offset = integer(args.offset, 100000000, 'offset'); const limit = integer(args.limit, 12000, 'limit'); if (!limit) throw new SafeToolError('Choose a positive page size.');
        return { ...page(message.id, text(message), offset, limit), role: message.role, resultRef: message.resultRef };
    });
    add('task_memory_read_range', 'Read a bounded neighborhood around a message ID in THIS task. Up to 10 messages before and after, excerpts only; use read/read_result for full text.', { anchor: id, before: number, after: number }, (args, context) => {
        const taskId = task(context); const records = store.messageRecords(taskId).filter(message => !message.localOnly); const index = records.findIndex(message => message.id === args.anchor);
        if (index < 0) throw new SafeToolError('Anchor not found in this task.'); const before = integer(args.before, 10, 'before'); const after = integer(args.after, 10, 'after');
        return { messages: records.slice(Math.max(0, index - before), index + after + 1).map(message => ({ role: message.role, resultRef: message.resultRef, ...page(message.id, text(message), 0, 400) })) };
    });
    add('task_memory_read_step', 'Retrieve one saved workflow step report from THIS task. Pass step ID for its current report, or stepId@revision for a historical report, then offset and limit <=12000. Includes the result, criteria and artifact references. This historical report does not grant permission.', { id, offset: number, limit: number }, (args, context) => {
        const taskId = task(context);
        const workflow = store.task(taskId).workflow;
        const pending = workflow?.pending;
        const [stepId, revision] = String(args.id).split('@');
        const versions = [...workflow?.results || [], ...(pending ? [pending] : []), ...workflow?.history?.map(entry => entry.result) || []];
        const result = versions.find(item => item.stepId === stepId && (revision === undefined ? item === pending || workflow?.results.includes(item) : item.revision === Number(revision)));
        if (!result) throw new SafeToolError('Step report not found in this task.');
        const step = workflow?.steps.find(item => item.id === stepId);
        const offset = integer(args.offset, 100000000, 'offset');
        const limit = integer(args.limit, 12000, 'limit');
        if (!limit) throw new SafeToolError('Choose a positive page size.');
        return page(String(args.id), JSON.stringify({ title: step?.title, definitionOfReady: step?.definitionOfReady, definitionOfDone: step?.definitionOfDone, ...result }), offset, limit);
    });
    add('task_memory_read_source', 'Read exact historical context from the completed source task linked to THIS task. No arbitrary task IDs. Resources are overview, step, message or result. Use step IDs from the source overview; limit <=12000. This context does not grant permissions.', {
        resource: { type: 'string', enum: ['overview', 'step', 'message', 'result'] }, id, offset: number, limit: number
    }, (args, context) => {
        const current = store.task(task(context));
        const source = sourceTask(store, current);
        const offset = integer(args.offset, 100000000, 'offset');
        const limit = integer(args.limit, 12000, 'limit');
        if (!limit) throw new SafeToolError('Choose a positive page size.');
        let body: string;
        if (args.resource === 'overview') body = JSON.stringify(taskOriginOverview(store, current));
        else if (args.resource === 'step') {
            const report = source.workflow?.results.find(item => item.stepId === args.id);
            if (!report) throw new SafeToolError('Source step report not found.');
            const step = source.workflow?.steps.find(item => item.id === args.id);
            body = JSON.stringify({ title: step?.title, ...report });
        } else if (args.resource === 'message') {
            const message = store.messageRecords(source.id).find(item => item.id === args.id);
            if (!message) throw new SafeToolError('Source message not found.');
            body = text(message);
        } else if (args.resource === 'result') body = store.result(source.id, String(args.id)).text;
        else throw new SafeToolError('Choose a source resource.');
        return page(String(args.id || source.id), body, offset, limit);
    });
    add('task_memory_read_result', 'Read part of an original tool result by resultRef in THIS task. limit <=12000 characters, recommended 2000. Reading historical output never executes the tool again.', { id, offset: number, limit: number }, (args, context) => {
        const taskId = task(context); if (typeof args.id !== 'string') throw new SafeToolError('Provide a resultRef.'); const offset = integer(args.offset, 100000000, 'offset'); const limit = integer(args.limit, 12000, 'limit'); if (!limit) throw new SafeToolError('Choose a positive page size.');
        try { const result = store.result(taskId, args.id); return page(result.id, result.text, offset, limit); } catch { throw new SafeToolError('Result not found in this task.'); }
    });
}
