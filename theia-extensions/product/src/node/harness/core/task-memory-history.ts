import { createHash } from 'crypto';
import { Message } from '../../../common/task-service';
export const historyDigest = (messages: Message[]) => { const hash = createHash('sha256').update('['); messages.forEach((message, index) => { if (index) hash.update(','); hash.update(JSON.stringify(message)); }); return hash.update(']').digest('hex'); };
/** A checkpoint may end only after all calls from the preceding model output have results. */
export function historyBoundaries(messages: Message[]): number[] {
    const pending = new Set<string>(); const boundaries: number[] = [];
    messages.forEach((message, index) => {
        if (message.role === 'assistant') for (const item of message.continuation || []) {
            const call = item as { type?: string; call_id?: string }; if (call.type === 'function_call' && call.call_id) pending.add(call.call_id);
        }
        if (message.role === 'tool' && message.callId) pending.delete(message.callId);
        if (!pending.size) boundaries.push(index + 1);
    });
    return boundaries;
}
