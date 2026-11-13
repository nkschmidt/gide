import { createWorkflowObservers } from './modules/repository-workflow-observer';
import { projectIdentity } from './storage/project-layout';
import { governedDataDirectory } from '../data-directory';
import { registerDockerTools } from './modules/docker-tools';
import { BuiltinFamilies } from './core/tool-families';
import { toolOperation } from '../../common/task-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import { join } from 'path';
import { realpath, access } from 'fs/promises';
import { TaskService, Task, TaskSnapshot } from '../../common/task-service';
import { InteractionResponse } from '../../common/interaction';
import { ChatGptService } from '../chatgpt-service';
import { SqliteStore } from './storage/sqlite-store';
import { TaskRuntime } from './core/runtime';
import { ToolRegistry } from './core/contracts';
import { OutputSizeLimit, ReadFilesExecutor } from './modules/file-tools';
import { OpenAiProvider } from './modules/openai-provider';
import { registerRepositoryTools } from './modules/repository-tools';
import { resolveRepositoryTarget } from './modules/repository-tools';
import { ProjectMemory } from './modules/project-memory';
import { registerMemoryTools } from './modules/memory-tools';
import { ContextSelection, ProjectContextIndex } from '../../common/project-context';
import { WorkflowService } from '../../common/workflow-service';
import { WorkflowEngine } from './core/workflow-engine';
import { registerGitTools } from './modules/git-tools';
import { registerWriteTools } from './modules/write-tools';
import { registerWorkflowTools } from './workflows/workflow-tools';
import { changesetDirectory } from './storage/changeset-directory';
import { AskUserTool } from './modules/question-tool';
import { ProjectTools, registerProjectToolManagement } from './project-tool-service';
import { ToolPolicies } from './storage/tool-policies';
import { GitCommand } from './modules/git-command';
import { registerTaskMemoryTools } from './modules/task-memory-tools';

@injectable()
export class TaskServiceImpl implements TaskService {
    @inject(ChatGptService) protected readonly chatGpt: ChatGptService;
    @inject(WorkflowService) protected readonly workflows: WorkflowService;
    @inject(ProjectTools) protected readonly projectTools: ProjectTools;
    @inject(ToolRegistry) protected readonly tools: ToolRegistry;
    @inject(ToolPolicies) protected readonly policies: ToolPolicies;
    private store?: SqliteStore;
    private runtime?: TaskRuntime;
    private readonly memory = new ProjectMemory();
    onStart(): void { this.engine(); }
    private engine(): TaskRuntime {
        if (!this.runtime) {
            this.store = new SqliteStore(governedDataDirectory('runtime', 'tasks.sqlite'));
            const tools = this.tools; const workflows = new WorkflowEngine(this.store, this.workflows, tools, createWorkflowObservers());
            tools.registerModule({ id: 'builtin.files', version: '1.0.0', register: registry => registry.register(new ReadFilesExecutor()) });
            tools.registerModule({ id: 'builtin.questions', version: '1.0.0', register: registry => registry.register(new AskUserTool()) });
            tools.registerModule({ id: 'builtin.task-memory', version: '1.0.0', register: registry => registerTaskMemoryTools(registry, this.store!) });
            tools.registerModule({ id: 'builtin.repositories', version: '1.0.0', register: registry => registerRepositoryTools(registry) });
            tools.registerModule({ id: 'builtin.tools', version: '1.0.0', register: registry => registerProjectToolManagement(registry, this.projectTools) });
            tools.registerModule({ id: 'builtin.workflow', version: '1.0.0', register: registry => { workflows.register(registry); registerWorkflowTools(registry, this.workflows, this.store); } });
            tools.registerModule({ id: 'builtin.docker', version: '1.0.0', register: registerDockerTools });
            tools.registerModule({ id: 'builtin.git', version: '1.0.0', register: registry => { registerGitTools(registry, workflows); registry.register(new GitCommand(workflows)); } });
            tools.registerModule({ id: 'builtin.changes', version: '1.0.0', register: registry => registerWriteTools(registry, workflows) });
            tools.registerModule({ id: 'builtin.memory', version: '1.0.0', register: registry => registerMemoryTools(registry, { memory: this.memory, store: this.store!, workflow: workflows, index: (project, signal) => this.contextIndex(project, signal), analyze: (project, repository) => this.analyzeRepository(project, repository) }) });
            for (const family of BuiltinFamilies) tools.registerFamily(family);
            this.runtime = new TaskRuntime(this.store, new OpenAiProvider(this.chatGpt), tools, this.policies, new OutputSizeLimit(), this.memory, workflows);
        }
        return this.runtime;
    }
    private async project(path: string): Promise<string> {
        if (typeof path !== 'string' || path.length > 4096) throw new Error('Invalid project path.');
        const root = await realpath(path); await access(join(root, 'project.theia-workspace')); await changesetDirectory(root); this.engine(); await this.policies.initialize(root); return root;
    }
    async list(projectPath: string): Promise<Task[]> { return this.engine().list(await this.project(projectPath)); }
    async create(projectPath: string): Promise<Task> { return this.engine().create(await this.project(projectPath)); }
    async followUpOptions(taskId: string): Promise<import('../../common/workflow-service').WorkflowSummary[]> { return this.engine().followUpOptions(taskId); }
    async startFollowUp(taskId: string, workflowId: string, requestId: string): Promise<Task> { return this.engine().startFollowUp(taskId, workflowId, requestId); }
    async setWorkflow(taskId: string, choice: string): Promise<void> { await this.engine().setWorkflow(taskId, choice); }
    async snapshot(taskId: string): Promise<TaskSnapshot> { return this.engine().snapshot(taskId); }
    async saveDraft(taskId: string, text: string): Promise<void> { this.engine().saveDraft(taskId, text); }
    async send(taskId: string, text: string, requestId: string): Promise<void> { this.engine().send(taskId, text, requestId); }
    async resume(taskId: string): Promise<void> { this.engine().resume(taskId); }
    async cancel(taskId: string): Promise<void> { this.engine().cancel(taskId); }
    async respondInteraction(interactionId: string, response: InteractionResponse): Promise<void> { await this.engine().respondInteraction(interactionId, response); }
    async readFiles(taskId: string, paths: string[]): Promise<void> { this.engine().readFiles(taskId, paths); }
    private async contextIndex(project: string, signal: AbortSignal): Promise<ProjectContextIndex> {
        const index = await this.memory.index(project, signal); const tasks = this.engine().researchJobs(project);
        const { repositoryRevision } = await projectIdentity(project);
        for (const repo of index.repositories) {
            const analysis = tasks.find(task => task.kind === 'repository-analysis' && task.repository === repo.id && task.repositoryRevision === repositoryRevision);
            if (analysis) {
                const runs = this.store!.runs(analysis.id); const last = runs[runs.length - 1];
                repo.job = { taskId: analysis.id, state: analysis.state, error: last?.error };
                const review = last && this.store!.actions(last.id).find(action => action.state === 'awaiting_approval' && toolOperation(action) === 'context_publish');
                const interaction = review && this.store!.interactions(analysis.id).find(item => item.actionId === review.id && item.state === 'pending');
                if (review && interaction) repo.job.review = { actionId: review.id, interactionId: interaction.id, proposal: review.args };
            }
        }
        return index;
    }
    async projectContext(projectPath: string): Promise<ProjectContextIndex> { return this.contextIndex(await this.project(projectPath), AbortSignal.timeout(20000)); }
    async contextTopics(projectPath: string, repository: string, topics: string[]): Promise<ContextSelection> { return this.memory.get(await this.project(projectPath), repository, topics, AbortSignal.timeout(20000)); }
    async analyzeProject(projectPath: string): Promise<void> {
        const root = await this.project(projectPath);
        const { repositoryRevision } = await projectIdentity(root);
        for (const job of this.engine().researchJobs(root)) {
            if (job.repositoryRevision !== repositoryRevision && ['running', 'awaiting_approval', 'waiting_input', 'waiting_review'].includes(job.state)) {
                this.engine().cancel(job.id);
            }
        }
        const index = await this.contextIndex(root, AbortSignal.timeout(20000));
        const pending = index.repositories.filter(repo => !repo.context && !['running', 'awaiting_approval'].includes(repo.job?.state || ''));
        for (const repo of pending) await this.analyzeRepository(root, repo.id);
    }
    async analyzeRepository(projectPath: string, repository: string): Promise<Task> {
        const root = await this.project(projectPath);
        await resolveRepositoryTarget({ repository, path: '.', offset: 0 }, { projectPath: root, signal: AbortSignal.timeout(10000) });
        return this.engine().analyzeRepository(root, repository, (await projectIdentity(root)).repositoryRevision);
    }
    onStop(): void { this.runtime?.shutdown(); /* Crash recovery handles any unfinished run on next startup. */ }
}
