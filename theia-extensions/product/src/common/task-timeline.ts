import { toolOperation } from './task-service';
import { Action, Message, ReadFileSummary } from './task-service';
import { InteractionRequest } from './interaction';

export function readPaths(action: Action): string[] {
    return Array.isArray(action.args.paths) ? action.args.paths.filter((path): path is string => typeof path === 'string') : typeof action.args.path === 'string' ? [action.args.path] : [];
}
export function summarizeReads(action: Action): ReadFileSummary[] {
    if (action.readFiles) return action.readFiles;
    const status = action.state === 'succeeded' ? 'read' : action.state === 'running' ? 'reading' : action.state === 'failed' || action.state === 'interrupted' ? 'failed' : action.state === 'denied' ? 'denied' : action.state === 'cancelled' ? 'cancelled' : 'pending';
    try {
        if (action.result) {
            const result = JSON.parse(action.result) as { files?: { path: string; error?: string }[]; path?: string };
            if (Array.isArray(result.files)) return result.files.map(file => ({ path: file.path, status: file.error ? 'failed' : 'read', error: file.error }));
            if (result.path) return [{ path: result.path, status: 'read' }];
        }
    } catch { /* Historical records may contain an unstructured result. */ }
    return readPaths(action).map(path => ({ path, status, error: action.error }));
}
export type TaskTimelineEntry = { kind: 'message'; message: Message } | { kind: 'action'; action: Action } | { kind: 'reads'; id: string; actions: Action[] } | { kind: 'interaction'; request: InteractionRequest };
export function buildTaskTimeline(messages: Message[], actions: Action[], interactions: InteractionRequest[] = []): TaskTimelineEntry[] {
    const entries = [...messages.filter(message => message.text).map(message => ({ kind: 'message' as const, message, time: message.createdAt })), ...actions.filter(action => !['ask_user', 'tools_propose', 'workflow_route', 'workflow_request_tools'].includes(toolOperation(action)) || !interactions.some(request => request.actionId === action.id)).map(action => ({ kind: 'action' as const, action, time: action.createdAt })), ...interactions.filter(request => ['question', 'tool_proposal', 'workflow_selection', 'workflow_tools', 'workflow_approval'].includes(request.kind)).map(request => ({ kind: 'interaction' as const, request, time: request.createdAt }))].sort((a, b) => a.time - b.time);
    const result: TaskTimelineEntry[] = [];
    for (const entry of entries) {
        if (entry.kind === 'action' && toolOperation(entry.action) === 'files_read') {
            const last = result[result.length - 1];
            if (last?.kind === 'reads' && last.actions[0].runId === entry.action.runId) last.actions.push(entry.action);
            else result.push({ kind: 'reads', id: entry.action.id, actions: [entry.action] });
        } else if (entry.kind === 'interaction') result.push({ kind: 'interaction', request: entry.request });
        else if (entry.kind === 'action') result.push({ kind: 'action', action: entry.action });
        else result.push({ kind: 'message', message: entry.message });
    }
    return result;
}
