import { InteractionRequest, InteractionResponse, StepToolAccess, ToolInteraction } from '../../../common/interaction';
import { splitMethodRef } from '../../../common/tool-methods';
import { HarnessStore, ToolContext, ToolRegistration, ToolRegistry } from './contracts';
import { SafeToolError } from '../modules/file-tools';

/** User-reviewed additions to the current step; never edits project definitions or tool policies. */
export class WorkflowToolAccess {
    constructor(private readonly store: HarnessStore, private readonly registry: ToolRegistry) { }
    private resolve(ref: string, context: ToolContext): StepToolAccess['tools'] {
        if (typeof ref !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,99}(?:#[a-z][a-z0-9_]{0,31})?$/.test(ref) || ref.includes('..')) throw new SafeToolError('Use installed tool IDs, optionally followed by #method.');
        const { id, method } = splitMethodRef(ref);
        const entry = this.registry.catalog(context.projectPath).find(item => (item.manifestId || item.executor.definition.name) === id);
        if (!entry) throw new SafeToolError(`Tool ${id} is not installed or is unavailable. Install or repair it in Tools first.`);
        const item = (child: ToolRegistration, methodId?: string) => {
            if (child.enabled === false || (child.executor.available && !child.executor.available(context))) throw new SafeToolError(`Tool method ${ref} is unavailable or denied by policy. Change its policy in Tools first.`);
            return { id: methodId ? `${id}#${methodId}` : id, label: `${entry.executor.definition.name}${methodId ? `.${methodId}` : ''}`, description: child.executor.definition.description.slice(0, 500), revision: child.revision || `${child.module}:${child.version}` };
        };
        if (entry.executor.methods) {
            if (method) {
                if (!Object.prototype.hasOwnProperty.call(entry.executor.methods, method)) throw new SafeToolError(`Unknown method ${ref}.`);
                return [item(entry.executor.methods[method], method)];
            }
            // Freeze the exact enabled methods shown to the user, rather than granting future additions.
            return Object.entries(entry.executor.methods).filter(([, child]) => child.enabled !== false && (!child.executor.available || child.executor.available(context))).map(([key, child]) => item(child, key));
        }
        if (method) throw new SafeToolError(`Tool ${id} does not declare methods.`);
        return [item(entry)];
    }
    propose(args: Record<string, unknown>, context: ToolContext): ToolInteraction {
        const task = context.taskId && this.store.task(context.taskId); const workflow = task && task.workflow;
        if (!workflow || workflow.phase !== 'active' || workflow.waitingFor) throw new SafeToolError('Request tool access from an active workflow step.');
        if (!Array.isArray(args.tools) || !args.tools.length || args.tools.length > 20 || typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 2000) throw new SafeToolError('Request 1–20 installed tool references and explain why this step needs them.');
        const selected = new Set(workflow.steps[workflow.index].tools || []);
        const tools = [...new Map(args.tools.flatMap(ref => this.resolve(ref, context)).map(item => [item.id, item])).values()].filter(item => !selected.has(item.id) && !selected.has(splitMethodRef(item.id).id));
        if (!tools.length || tools.length > 40 || selected.size + tools.length > 200) throw new SafeToolError('Request 1–40 missing methods within the 200-reference step limit.');
        return { kind: 'workflow_tools', toolAccess: { reason: args.reason.trim(), stepTitle: workflow.steps[workflow.index].title, tools } };
    }
    respond(request: InteractionRequest, response: InteractionResponse, context: ToolContext): string {
        if (!response || !('approved' in response) || typeof response.approved !== 'boolean' || Object.keys(response).length !== 1) throw new SafeToolError('Enable the requested methods or keep the current tools.');
        const task = this.store.task(request.taskId); const workflow = task.workflow;
        if (request.kind !== 'workflow_tools' || !request.toolAccess || this.store.interaction(request.id).state !== 'pending' || !workflow || workflow.phase !== 'active' || workflow.waitingFor !== request.id || workflow.revision !== request.revision || workflow.steps[workflow.index]?.id !== request.stepId) throw new SafeToolError('This step tool request is no longer pending.');
        if (response.approved) {
            for (const previous of request.toolAccess.tools) {
                const current = this.resolve(previous.id, context);
                if (current.length !== 1 || current[0].revision !== previous.revision) throw new SafeToolError('A requested tool changed during review. Keep the current tools and request access again.');
            }
            const step = workflow.steps[workflow.index];
            step.tools = [...new Set([...(step.tools || []), ...request.toolAccess.tools.map(item => item.id)])];
            workflow.ready = undefined; workflow.revision++; task.updatedAt = Date.now(); this.store.putTask(task);
            this.store.event(task.id, context.runId, 'workflow.tools_enabled', { stepId: step.id, tools: request.toolAccess.tools.map(item => item.id), revision: workflow.revision });
        }
        return JSON.stringify({ approved: response.approved, enabled: response.approved ? request.toolAccess.tools.map(item => item.id) : [], scope: 'current task step only', policiesChanged: false, readinessRequired: response.approved });
    }
}
