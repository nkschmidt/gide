import { scopeAccess } from '../core/tool-access';
import { UserQuestion } from '../../../common/task-service';
import { ToolExecutor } from '../core/contracts';
import { SafeToolError } from './file-tools';

export class AskUserTool implements ToolExecutor {
    readonly access = scopeAccess({ 'user-question': 'allow' }, undefined, ['write']);
    readonly turnControl = true;
    readonly interaction = true;
    readonly workflowSupport = true;
    readonly definition = {
        name: 'ask_user',
        description: 'Ask the user one concrete question with 2–5 distinct answer options, or options: [] for an open question. Never invent choices for a question that needs free text. Pauses this task until the user selects an option or types their own answer. Use for ALL clarifications, scope decisions or resolvable blockers instead of asking in ordinary chat. Must be the ONLY tool call in the response. Never use this as a substitute for workflow step approval or action permission; those gates remain controlled by the engine.',
        parameters: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', minItems: 0, maxItems: 5, items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, description: { type: 'string' } }, required: ['id', 'label', 'description'], additionalProperties: false } } }, required: ['question', 'options'], additionalProperties: false }
    };
    available(context: import('../core/contracts').ToolContext): boolean { return context.purpose !== 'repository-analysis'; }
    question(args: Record<string, unknown>): UserQuestion {
        if (Object.keys(args).some(key => !['question', 'options'].includes(key)) || typeof args.question !== 'string' || !args.question.trim() || args.question.length > 2000 || !Array.isArray(args.options) || args.options.length === 1 || args.options.length > 5) throw new SafeToolError('Ask one question (up to 2,000 characters) with 2–5 options, or an empty options array for a free-text answer.');
        const options = args.options.map(item => {
            if (!item || Object.keys(item).some(key => !['id', 'label', 'description'].includes(key)) || typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(item.id) || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 160 || typeof item.description !== 'string' || item.description.length > 500) throw new SafeToolError('Each option needs a unique ID, a label (up to 160 characters), and a description (up to 500 characters).');
            return { id: item.id, label: item.label.trim(), description: item.description.trim() };
        });
        if (new Set(options.map(option => option.id)).size !== options.length || new Set(options.map(option => option.label.toLocaleLowerCase())).size !== options.length) throw new SafeToolError('Question options must be distinct.');
        return { question: args.question.trim(), options };
    }
    async prepare(args: Record<string, unknown>): Promise<Record<string, unknown>> { return { scope: 'user-question', question: this.question(args) }; }
    async execute(args: Record<string, unknown>): Promise<{ kind: 'question'; question: UserQuestion }> { return { kind: 'question', question: this.question(args) }; }
}
