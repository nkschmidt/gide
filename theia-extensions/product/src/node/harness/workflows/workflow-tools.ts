import { scopeAccess } from '../core/tool-access';
import { WorkflowService } from '../../../common/workflow-service';
import { HarnessStore, ToolRegistry } from '../core/contracts';
import { SafeToolError } from '../modules/file-tools';

export function registerWorkflowTools(tools: ToolRegistry, workflows: WorkflowService, store?: HarnessStore): void {
    const validate = (args: Record<string, unknown>) => { if (Object.keys(args).length) throw new SafeToolError('workflow_get takes no arguments.'); };
    tools.register({
        access: scopeAccess({ 'project-workflow': 'allow' }, undefined, ['read']),
        definition: { name: 'workflow_get', description: 'Read the development workflow saved independently in this project. Returns step instructions, available tools, Definition of Ready and Definition of Done criteria. When a task workflow is active, the engine controls transitions and approval. Do not claim that a step or check ran merely because it is configured.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } },
        available: context => context.purpose !== 'repository-analysis',
        prepare: async args => { validate(args); return { scope: 'project-workflow' }; },
        execute: async (args, _prepared, context) => { validate(args); const active = context.taskId && store?.task(context.taskId).workflow; const view = active ? { ...active, revision: active.definitionRevision } : await workflows.get(context.projectPath); return JSON.stringify({ workflow: view.name, id: view.id, revision: view.revision, automatedStageExecution: !!active, steps: view.steps.filter(step => step.enabled).map(({ id, title, instructions, definitionOfReady, definitionOfDone, tools, approval, dependsOn, reworkTargets }) => ({ id, title, instructions, definitionOfReady, definitionOfDone, tools, approval, dependsOn, reworkTargets })) }); }
    });
}
