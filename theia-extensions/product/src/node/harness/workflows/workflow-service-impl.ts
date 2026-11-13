import { injectable } from '@theia/core/shared/inversify';
import { access, realpath } from 'fs/promises';
import { resolve } from 'path';
import { WorkflowCreate, WorkflowDraft, WorkflowService, WorkflowSummary, WorkflowView } from '../../../common/workflow-service';
import { WorkflowRepository } from './workflow-repository';
import { createWorkflowObservers } from '../modules/repository-workflow-observer';

@injectable()
export class WorkflowServiceImpl implements WorkflowService {
    readonly repository = new WorkflowRepository();
    async evidenceProviders(project: string) { await this.project(project); return createWorkflowObservers().map(({ id, name, description }) => ({ id, name, description })); }
    private async project(path: string): Promise<string> {
        if (typeof path !== 'string' || !path || path.length > 4096) throw new Error('Invalid project path.');
        const root = await realpath(path); await access(resolve(root, 'project.theia-workspace')); return root;
    }
    async initialize(project: string): Promise<void> { await this.repository.initialize(await this.project(project)); }
    async list(project: string): Promise<WorkflowSummary[]> { return this.repository.list(await this.project(project)); }
    async create(project: string, input: WorkflowCreate): Promise<WorkflowView> { return this.repository.create(await this.project(project), input); }
    async get(project: string, id?: string): Promise<WorkflowView> { return this.repository.get(await this.project(project), id); }
    async save(project: string, draft: WorkflowDraft): Promise<WorkflowView> { return this.repository.save(await this.project(project), draft); }
}
