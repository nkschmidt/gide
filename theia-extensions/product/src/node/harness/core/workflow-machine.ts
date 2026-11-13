import { WorkflowRun, WorkflowStepResult } from '../../../common/workflow-run';
import { WorkflowStep } from '../../../common/workflow-service';
import { SafeToolError } from '../modules/file-tools';

const transitions = {
    start: { draft: 'active' }, assess: { active: 'active' }, block: { active: 'blocked' },
    requestReview: { active: 'review' }, acceptResult: { active: 'active', review: 'active' },
    complete: { active: 'completed' }, discuss: { review: 'review' },
    feedback: { active: 'active', blocked: 'active', review: 'active' },
    reopen: { active: 'active', blocked: 'active', review: 'active' }
} as const;
export function transitionPhase(workflow: WorkflowRun, event: keyof typeof transitions): void {
    const phase = (transitions[event] as Partial<Record<WorkflowRun['phase'], WorkflowRun['phase']>>)[workflow.phase];
    if (!phase) throw new SafeToolError(`Workflow cannot ${event} while ${workflow.phase}.`);
    workflow.phase = phase;
}

/** Pure scheduling and invalidation. No tool, repository, workflow-name or IO knowledge. */
export function stepDependencies(steps: WorkflowStep[], index: number): string[] {
    const step = steps[index];
    const expand = (id: string): string[] => { const i = steps.findIndex(item => item.id === id); return i >= 0 && !steps[i].enabled ? (steps[i].dependsOn || (i ? [steps[i - 1].id] : [])).flatMap(expand) : [id]; };
    return [...new Set((step.dependsOn || (index ? [steps[index - 1].id] : [])).flatMap(expand))];
}
export function materializeSteps(steps: WorkflowStep[]): WorkflowStep[] {
    return steps.flatMap((step, index) => step.enabled ? [{ ...step, dependsOn: stepDependencies(steps, index), ...(step.reworkTargets !== undefined ? { reworkTargets: step.reworkTargets.filter(id => steps.some(candidate => candidate.id === id && candidate.enabled)) } : {}) }] : []);
}
export function resultInputs(workflow: WorkflowRun, index = workflow.index): Record<string, number> {
    return Object.fromEntries(stepDependencies(workflow.steps, index).map(id => {
        const result = workflow.results.find(item => item.stepId === id);
        if (!result) throw new SafeToolError(`A current result is required from step "${id}".`);
        return [id, result.revision];
    }));
}
export function resultIsCurrent(workflow: WorkflowRun, result: WorkflowStepResult): boolean {
    const index = workflow.steps.findIndex(step => step.id === result.stepId); if (index < 0 || (workflow.steps[index].approval && !result.approvedAt)) return false;
    return stepDependencies(workflow.steps, index).every(id => { const dependency = workflow.results.find(item => item.stepId === id); return !!dependency && (!result.inputs || result.inputs[id] === dependency.revision) && resultIsCurrent(workflow, dependency); });
}
export function nextUnresolvedStep(workflow: WorkflowRun): number {
    return workflow.steps.findIndex(step => !workflow.results.some(result => result.stepId === step.id && resultIsCurrent(workflow, result)));
}
export function reopenStep(workflow: WorkflowRun, target: string, reason: string, reference?: string): { invalidated: string[] } {
    const index = workflow.steps.findIndex(step => step.id === target); const current = workflow.steps[workflow.index];
    if (workflow.phase === 'completed' || index < 0 || index > workflow.index || !reason.trim() || reason.length > 2000 || (current.reworkTargets !== undefined && !current.reworkTargets.includes(target))) throw new SafeToolError('Choose a configured current or earlier rework target and explain the revision.');
    transitionPhase(workflow, 'reopen');
    const affected = new Set([target]);
    for (let i = index + 1; i < workflow.steps.length; i++) if (stepDependencies(workflow.steps, i).some(id => affected.has(id))) affected.add(workflow.steps[i].id);
    const retired = workflow.results.filter(result => affected.has(result.stepId));
    if (workflow.pending) retired.push(workflow.pending);
    workflow.history ||= []; workflow.history.push(...retired.map(result => ({ result, invalidatedAt: Date.now(), reason })));
    workflow.results = workflow.results.filter(result => !affected.has(result.stepId));
    workflow.rework = { target, from: current.id, reason, reference, revision: ++workflow.revision };
    workflow.index = index; workflow.ready = undefined; workflow.pending = undefined; workflow.waitingFor = undefined; workflow.discussion = undefined; workflow.notice = reason;
    return { invalidated: [...affected] };
}
