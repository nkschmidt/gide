export const WorkflowService = Symbol('WorkflowService');
export const WorkflowServicePath = '/services/governed-workflows';
export interface WorkflowStep { id: string; title: string; instructions: string; definitionOfReady: string[]; definitionOfDone: string[]; tools?: string[]; approval: boolean; enabled: boolean; dependsOn?: string[]; reworkTargets?: string[]; reviewEvidence?: string[]; }
export interface WorkflowEvidenceProvider { id: string; name: string; description: string; }
export type StepField = Exclude<keyof WorkflowStep, 'id'>;
export interface WorkflowDefinition { id: string; version: string; name: string; description: string; nextWorkflows?: string[]; steps: WorkflowStep[]; }
export interface WorkflowDocument { schemaVersion: 5; id: string; name: string; description: string; revision: number; nextWorkflows?: string[]; steps: WorkflowStep[]; updatedAt: number; }
export type WorkflowView = WorkflowDocument;
export interface WorkflowDraft { id?: string; expectedRevision: number; nextWorkflows?: string[]; steps: WorkflowStep[]; }
export interface WorkflowSummary { id: string; name: string; description: string; stepCount: number; updatedAt: number; }
export interface WorkflowCreate { name: string; description: string; sourceId?: string; }
export interface WorkflowIssue { stepId?: string; field: string; message: string; }
export interface WorkflowService {
    evidenceProviders(projectPath: string): Promise<WorkflowEvidenceProvider[]>;
    initialize(projectPath: string): Promise<void>;
    list(projectPath: string): Promise<WorkflowSummary[]>;
    create(projectPath: string, input: WorkflowCreate): Promise<WorkflowView>;
    get(projectPath: string, id?: string): Promise<WorkflowView>;
    save(projectPath: string, draft: WorkflowDraft): Promise<WorkflowView>;
}
export const StepFields: StepField[] = ['title', 'instructions', 'definitionOfReady', 'definitionOfDone', 'tools', 'approval', 'enabled', 'dependsOn', 'reworkTargets', 'reviewEvidence'];
export function editableStep(step: WorkflowStep): WorkflowStep { return { id: step.id, title: step.title, instructions: step.instructions, definitionOfReady: [...step.definitionOfReady], definitionOfDone: [...step.definitionOfDone], ...(step.tools !== undefined ? { tools: [...step.tools] } : {}), ...(step.dependsOn !== undefined ? { dependsOn: [...step.dependsOn] } : {}), ...(step.reworkTargets !== undefined ? { reworkTargets: [...step.reworkTargets] } : {}), ...(step.reviewEvidence !== undefined ? { reviewEvidence: [...step.reviewEvidence] } : {}), approval: step.approval, enabled: step.enabled }; }
export function workflowIssues(steps: WorkflowStep[]): WorkflowIssue[] {
    const issues: WorkflowIssue[] = []; const ids = new Set<string>();
    if (!Array.isArray(steps) || steps.length > 30) return [{ field: 'steps', message: 'A workflow can contain up to 30 steps.' }];
    for (const step of steps) {
        if (!step || typeof step.id !== 'string' || ids.has(step.id)) { issues.push({ field: 'steps', message: 'Step IDs must be unique.' }); continue; }
        ids.add(step.id);
        if (!/^[a-z0-9][a-z0-9-]{0,99}$/i.test(step.id)) issues.push({ stepId: step.id, field: 'id', message: 'Invalid step ID.' });
        for (const [field, limit] of [['title', 80], ['instructions', 2000]] as const) if (typeof step[field] !== 'string' || !step[field].trim() || step[field].length > limit) issues.push({ stepId: step.id, field, message: `Enter ${field}, up to ${limit} characters.` });
        for (const field of ['definitionOfReady', 'definitionOfDone'] as const) {
            const criteria = step[field];
            if (!Array.isArray(criteria) || criteria.length > 20) issues.push({ stepId: step.id, field, message: 'Use up to 20 criteria.' });
            else criteria.forEach((value, index) => { if (typeof value !== 'string' || !value.trim() || value.length > 300) issues.push({ stepId: step.id, field: `${field}.${index}`, message: 'Enter a criterion, up to 300 characters.' }); });
        }
        if (typeof step.enabled !== 'boolean' || typeof step.approval !== 'boolean') issues.push({ stepId: step.id, field: 'enabled', message: 'Enabled and confirmation settings must be boolean values.' });
        if (step.reviewEvidence !== undefined && (!Array.isArray(step.reviewEvidence) || step.reviewEvidence.length > 20 || new Set(step.reviewEvidence).size !== step.reviewEvidence.length || step.reviewEvidence.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,99}$/.test(id)))) issues.push({ stepId: step.id, field: 'reviewEvidence', message: 'Choose up to 20 unique review safeguards.' });
        if (!Array.isArray(step.tools) || step.tools.length > 200 || new Set(step.tools).size !== step.tools.length || step.tools.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,99}(?:#[a-z][a-z0-9_]{0,31})?$/.test(id) || id.includes('..'))) issues.push({ stepId: step.id, field: 'tools', message: 'Choose up to 200 unique tool IDs.' });
    }
    for (let index = 0; index < steps.length; index++) {
        const step = steps[index]; if (!step || !ids.has(step.id)) continue;
        for (const field of ['dependsOn', 'reworkTargets'] as const) {
            const references = step[field]; if (references === undefined) continue;
            if (!Array.isArray(references) || new Set(references).size !== references.length || references.some(id => typeof id !== 'string' || !steps.slice(0, field === 'reworkTargets' ? index + 1 : index).some(target => target.id === id))) issues.push({ stepId: step.id, field, message: field === 'dependsOn' ? 'Dependencies must identify unique earlier steps.' : 'Rework targets must identify unique current or earlier steps.' });
        }
    }
    return issues;
}
export function canMoveWorkflowStep(steps: WorkflowStep[], index: number, direction: number): boolean {
    const target = index + direction; return index >= 0 && index < steps.length && target >= 0 && target < steps.length;
}

export function workflowNextIds(value: unknown): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 20 || new Set(value).size !== value.length ||
        value.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(id))) {
        throw new Error('Choose up to 20 unique workflows for completion actions.');
    }
    return [...value];
}
