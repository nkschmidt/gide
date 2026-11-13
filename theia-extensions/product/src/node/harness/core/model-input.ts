import { Message } from '../../../common/task-service';
/** Shared wire projection keeps context accounting aligned with actual provider input. */
export function modelInput(messages: Message[]): unknown[] {
    return messages.flatMap(message => {
        if (message.role === 'tool') return [{ type: 'function_call_output', call_id: message.callId, output: message.text }];
        if (message.role === 'assistant' && message.continuation?.length) return message.continuation;
        return message.text ? [{ role: message.role, content: message.text }] : [];
    });
}
