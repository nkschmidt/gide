import { Message } from '../../../common/task-service';
import { ChatGptService } from '../../chatgpt-service';
import { ModelProvider, ModelReply, ModelTurnPolicy, ModelProtocolError, ToolDefinition } from '../core/contracts';
import { modelInput } from '../core/model-input';

type OutputItem = { type: string; call_id?: string; name?: string; arguments?: string; content?: { type: string; text?: string; refusal?: string }[] };
export class ProviderError extends Error { constructor(message: string) { super(message); this.name = 'ProviderError'; } }
export class OpenAiProvider implements ModelProvider {
    readonly id = 'openai-chatgpt';
    constructor(private readonly connection: ChatGptService) { }
    async respond(messages: Message[], tools: ToolDefinition[], instructions: string, signal: AbortSignal, policy: ModelTurnPolicy = { allowMessage: true }): Promise<ModelReply> {
        if (!policy.allowMessage && !tools.length) throw new ModelProtocolError('This workflow needs tools for its explicit turn outcomes.');
        const input = modelInput(messages);
        let response: Response;
        try { response = await this.connection.streamResponse(input, instructions, tools.map(tool => ({ type: 'function', ...tool, strict: true })), signal, policy.allowMessage ? 'auto' : 'required'); }
        catch { signal.throwIfAborted(); throw new ProviderError('Could not contact OpenAI. Check the ChatGPT connection and plan access, then continue.'); }
        if (!response.body) throw new ProviderError('OpenAI returned an empty response.');
        const reader = response.body.getReader(); const decoder = new TextDecoder();
        let buffer = ''; let bytes = 0; let final: { output?: OutputItem[]; status?: string } | undefined;
        const consume = (frame: string) => {
            const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data || data === '[DONE]') return;
            let event: { type: string; response?: { output?: OutputItem[]; status?: string } };
            try { event = JSON.parse(data); } catch { throw new ProviderError('OpenAI returned an invalid event.'); }
            if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') throw new ProviderError('OpenAI did not finish this response. You can continue the task.');
            if (event.type === 'response.completed') final = event.response;
        };
        try {
            for (;;) {
                signal.throwIfAborted(); const { value, done } = await reader.read();
                if (done) { buffer += decoder.decode(); break; }
                bytes += value.byteLength; if (bytes > 2000000) throw new ProviderError('Provider response exceeded the initial size limit.');
                buffer += decoder.decode(value, { stream: true }); buffer = buffer.replace(/\r\n/g, '\n');
                let boundary: number;
                while ((boundary = buffer.indexOf('\n\n')) >= 0) { consume(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); }
            }
            if (buffer.trim()) consume(buffer);
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
        if (!final?.output || final.status !== 'completed') throw new ProviderError('The response stream ended before completion. No actions were executed.');
        const calls = final.output.filter(item => item.type === 'function_call').map(item => {
            let args: Record<string, unknown>;
            try { args = JSON.parse(item.arguments || '{}'); } catch { throw new ProviderError('The model returned invalid action parameters.'); }
            if (!item.call_id || !item.name || !args || Array.isArray(args) || typeof args !== 'object') throw new ProviderError('The model returned an invalid action.');
            return { id: item.call_id, tool: item.name, args };
        });
        const text = final.output.flatMap(item => item.type === 'message' ? (item.content || []).map(part => part.text || part.refusal || '') : []).join('\n');
        if (!text && !calls.length) throw new ProviderError('OpenAI returned no message or action. You can continue the task.');
        return { outcome: calls.length ? 'actions' : 'message', text, calls, continuation: final.output };
    }
}
