import { Task } from '../../../common/task-service';
import { ToolContext, ToolRegistry, ToolRegistration } from './contracts';
import { methodsExecutor } from '../implementations/methods';
import { SafeToolError } from '../modules/file-tools';
export class WorkflowToolScope {
    constructor(private readonly registry: ToolRegistry) { }
    entries(task: Task, context: ToolContext): ToolRegistration[] {
        const routing = task.workflowMode === 'auto' && !task.workflow && context.purpose !== 'repository-analysis';
        const availableDuringRouting = (entry: ToolRegistration) => !routing || ['workflow_route', 'ask_user'].includes(entry.handlerTool || entry.executor.definition.name);
        const workflow=task.workflow;const selected=workflow?new Set(workflow.steps[workflow.index]?.tools||[]):undefined;const result:ToolRegistration[]=[];
        for(const entry of this.registry.catalog(context.projectPath)) {
            const id=entry.manifestId||entry.executor.definition.name;
            if(entry.executor.methods){const methods=Object.fromEntries(Object.entries(entry.executor.methods).filter(([method,child])=>availableDuringRouting(child)&&child.enabled!==false&&(!child.executor.available||child.executor.available(context))&&(!selected||selected.has(id)||selected.has(`${id}#${method}`)||child.executor.workflowSupport)));if(Object.keys(methods).length)result.push({...entry,executor:methodsExecutor(entry.executor.definition.name,entry.executor.definition.description,methods)});}
            else if(availableDuringRouting(entry)&&(!entry.executor.available||entry.executor.available(context))&&(!selected||entry.executor.workflowSupport||selected.has(id)))result.push(entry);
        }return result;
    }
    assert(name:string,task:Task,context:ToolContext,method?:string):void{const entry=this.entries(task,context).find(item=>item.executor.definition.name===name);if(!entry||(entry.executor.methods?(!method||!Object.prototype.hasOwnProperty.call(entry.executor.methods,method)):!!method))throw new SafeToolError('This tool method is not enabled for the current workflow step. Configure its Tools selection.');}
}
