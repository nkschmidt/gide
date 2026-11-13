import { randomUUID } from 'crypto';
import { InteractionRequest, UserQuestion, QuestionAnswer } from '../../../common/interaction';
import { HarnessStore } from './contracts';

export class InteractionManager {
    constructor(private readonly store: HarnessStore) { }
    create(input: Omit<InteractionRequest, 'id' | 'state' | 'createdAt'>): InteractionRequest {
        const existing = this.store.interactions(input.taskId).find(item => item.key === input.key);
        if (existing) return existing;
        const request: InteractionRequest = { ...input, id: randomUUID(), state: 'pending', createdAt: Date.now() };
        this.store.putInteraction(request); this.store.event(request.taskId, request.runId, 'interaction.requested', { interactionId: request.id, kind: request.kind });
        return request;
    }
    pending(taskId: string, kind?: InteractionRequest['kind']): InteractionRequest | undefined {
        return this.store.interactions(taskId).find(item => item.state === 'pending' && (!kind || item.kind === kind));
    }
    invalidate(taskId: string, predicate: (item: InteractionRequest) => boolean, state: 'invalidated' | 'cancelled' = 'invalidated'): void {
        for (const item of this.store.interactions(taskId).filter(item => item.state === 'pending' && predicate(item))) {
            item.state = state; item.resolvedAt = Date.now(); this.store.putInteraction(item);
        }
    }
    approve(request: InteractionRequest, approved: boolean): void {
        if (request.state !== 'pending' || request.kind === 'question') throw new Error('This approval is no longer pending.');
        request.state = 'answered'; request.response = { approved }; request.resolvedAt = Date.now(); this.store.putInteraction(request);
    }
}

class InteractionError extends Error { constructor(message: string) { super(message); this.name = 'InteractionError'; } }

export function questionAnswer(question: UserQuestion, answer: QuestionAnswer): string {
    if (!answer || Object.keys(answer).some(key => !['optionId', 'text'].includes(key)) || (answer.optionId !== undefined) === (answer.text !== undefined)) throw new InteractionError('Choose an option or enter your own answer.');
    if (answer.optionId !== undefined) {
        const option = question.options.find(item => item.id === answer.optionId);
        if (!option) throw new InteractionError('This option does not belong to the question.');
        return JSON.stringify({ question: question.question, optionId: option.id, text: option.label, description: option.description });
    }
    if (typeof answer.text !== 'string' || !answer.text.trim() || answer.text.length > 32000) throw new InteractionError('Enter an answer of up to 32,000 characters.');
    return JSON.stringify({ question: question.question, text: answer.text.trim() });
}
