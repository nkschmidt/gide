import { randomUUID } from 'crypto';
import { readdir, realpath } from 'fs/promises';
import { WorkflowCreate, WorkflowSummary, WorkflowDefinition, WorkflowDocument, WorkflowDraft, WorkflowStep, WorkflowView, editableStep, workflowIssues, workflowNextIds } from '../../../common/workflow-service';
import { projectDirectory, readProjectText, writeProjectText } from '../storage/project-files';
import { CodeReviewWorkflow } from './code-review-workflow';
import { DevelopmentWorkflow } from './default-workflow';

export class WorkflowRepository {
    private readonly writers = new Map<string, Promise<unknown>>();
    constructor(private readonly template: WorkflowDefinition = DevelopmentWorkflow) { }
    private async exclusive<T>(project: string, action: (root: string) => Promise<T>): Promise<T> {
        const root = await realpath(project); const previous = this.writers.get(root) || Promise.resolve();
        const operation = previous.catch(() => undefined).then(() => action(root)); this.writers.set(root, operation);
        try { return await operation; } finally { if (this.writers.get(root) === operation) this.writers.delete(root); }
    }
    private document(steps: WorkflowStep[], revision: number, name: string, description: string, id = 'development', nextWorkflows: string[] = []): WorkflowDocument {
        const issues = workflowIssues(steps); if (issues.length) throw new Error(issues[0].message);
        return { schemaVersion: 5, id, name, description, revision, nextWorkflows: workflowNextIds(nextWorkflows), steps: steps.map(editableStep), updatedAt: Date.now() };
    }
    private async load(project: string, id = 'development'): Promise<WorkflowDocument> {
        this.validateId(id);
        const text = await readProjectText(project, ['workflows'], `${id}.json`);
        if (!text) { if (id !== 'development') throw new Error('Workflow not found.'); const document = this.document(this.template.steps, 1, this.template.name, this.template.description, 'development', this.template.nextWorkflows); await this.write(project, document); return document; }
        const value = JSON.parse(text);
        if (value?.schemaVersion !== 5 || value.id !== id || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80 || typeof value.description !== 'string' || value.description.length > 2000 || !Number.isInteger(value.revision) || value.revision < 1 || !Number.isFinite(value.updatedAt)) throw new Error('Unsupported or invalid workflow format. Use schemaVersion 5.');
        const issues = workflowIssues(value.steps); if (issues.length) throw new Error(issues[0].message);
        const document: WorkflowDocument = { schemaVersion: 5, id: value.id, name: value.name, description: value.description, revision: value.revision, nextWorkflows: workflowNextIds(value.nextWorkflows), steps: value.steps.map(editableStep), updatedAt: value.updatedAt };
        return document;
    }

    initialize(project: string): Promise<void> {
        return this.exclusive(project, async root => {
            if (!await readProjectText(root, ['workflows'], 'code-review.json')) {
                await this.write(root, this.document(CodeReviewWorkflow.steps, 1, CodeReviewWorkflow.name, CodeReviewWorkflow.description, CodeReviewWorkflow.id));
            }
            await this.load(root);
        });
    }

    private validateId(id: string): void { if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(id)) throw new Error('Invalid workflow ID.'); }
    private async catalog(project: string): Promise<WorkflowSummary[]> {
        await this.load(project);
        const directory = await projectDirectory(project, ['workflows']);
        const files = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && /^[a-z0-9][a-z0-9-]{0,99}\.json$/.test(entry.name));
        if (files.length > 100) throw new Error('A project can contain up to 100 workflows.');
        const result: WorkflowSummary[] = [];
        for (const file of files) {
            const value = await this.load(project, file.name.slice(0, -5));
            result.push({ id: value.id, name: value.name, description: value.description, stepCount: value.steps.length, updatedAt: value.updatedAt });
        }
        return result.sort((a, b) => a.id === 'development' ? -1 : b.id === 'development' ? 1 : a.name.localeCompare(b.name));
    }
    list(project: string): Promise<WorkflowSummary[]> { return this.exclusive(project, root => this.catalog(root)); }
    create(project: string, input: WorkflowCreate): Promise<WorkflowView> {
        return this.exclusive(project, async root => {
            if (typeof input?.name !== 'string' || !input.name.trim() || input.name.trim().length > 80) throw new Error('Enter a workflow name, up to 80 characters.');
            if (typeof input.description !== 'string' || input.description.length > 2000) throw new Error('Enter a description of up to 2000 characters.');
            const catalog = await this.catalog(root);
            if (catalog.length >= 100) throw new Error('A project can contain up to 100 workflows.');
            if (catalog.some(item => item.name.toLowerCase() === input.name.trim().toLowerCase())) throw new Error('A workflow with this name already exists.');
            const source = input.sourceId === undefined ? undefined : await this.load(root, input.sourceId);
            const document = this.document(source?.steps || [], 1, input.name.trim(), input.description.trim(), `workflow-${randomUUID()}`, source?.nextWorkflows);
            await this.write(root, document); return document;
        });
    }
    private async write(project: string, document: WorkflowDocument): Promise<void> { await writeProjectText(project, ['workflows'], `${document.id}.json`, JSON.stringify(document, undefined, 2)); }
    get(project: string, id = 'development'): Promise<WorkflowView> { return this.exclusive(project, async root => this.load(root, id)); }
    save(project: string, draft: WorkflowDraft): Promise<WorkflowView> {
        return this.exclusive(project, async root => {
            const previous = await this.load(root, draft.id);
            if (draft.expectedRevision !== previous.revision) throw new Error('This workflow was changed in another window. Reload before saving; your draft has been kept.');
            const nextWorkflows = workflowNextIds(draft.nextWorkflows === undefined ? previous.nextWorkflows : draft.nextWorkflows);
            if (draft.nextWorkflows !== undefined) {
                for (const id of nextWorkflows) {
                    const target = id === previous.id ? { steps: draft.steps } : await this.load(root, id);
                    if (!target.steps.some(step => step.enabled)) throw new Error('A completion action needs a workflow with at least one enabled step.');
                }
            }
            const document = this.document(draft.steps, previous.revision + 1, previous.name, previous.description, previous.id, nextWorkflows);
            await this.write(root, document); return document;
        });
    }
}
