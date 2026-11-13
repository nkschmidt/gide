import { projectMutations } from './harness/storage/mutation-queue';
import { writeProjectText } from './harness/storage/project-files';
import { governedDataDirectory } from './data-directory';
import { ContainerModule } from '@theia/core/shared/inversify';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common';
import { injectable, inject } from '@theia/core/shared/inversify';
import { mkdir, readFile, writeFile, access, lstat, realpath, symlink, readlink, unlink } from 'fs/promises';
import { constants } from 'fs';
import { join, resolve, dirname } from 'path';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ChatGptStatus, ConnectedRepository, CreateProjectRequest, DEFAULT_LOCAL_MODEL, LocalModelStatus, ProjectService, ProjectServicePath, RecentProject, RepositoryRequest } from '../common/project-service';
import { LocalModelService } from './local-model-service';
import { ChatGptService } from './chatgpt-service';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { TaskService, TaskServicePath } from '../common/task-service';
import { TaskServiceImpl } from './harness/task-service-impl';
import { WorkflowService, WorkflowServicePath } from '../common/workflow-service';
import { WorkflowServiceImpl } from './harness/workflows/workflow-service-impl';

import { DiskFileSystemProvider } from '@theia/filesystem/lib/node/disk-file-system-provider';
import { ProjectFileSystemProvider } from './project-file-system-provider';
import { projectDirectories } from '../common/project-structure';
import { ProjectToolService, ProjectToolServicePath } from '../common/project-tool-service';
import { ProjectTools } from './harness/project-tool-service';
import { ToolPolicies } from './harness/storage/tool-policies';
import { ToolRegistry } from './harness/core/contracts';

const execFileAsync = promisify(execFile);

@injectable()
class ProjectServiceImpl implements ProjectService {
    @inject(ToolPolicies) protected readonly policies: ToolPolicies;
    @inject(WorkflowService) protected readonly workflows: WorkflowService;
    protected checkoutRoot = governedDataDirectory('checkouts');
    @inject(LocalModelService) protected readonly localModels: LocalModelService;
    @inject(ChatGptService) protected readonly chatGpt: ChatGptService;
    chatGptStatus(): Promise<ChatGptStatus> { return this.chatGpt.status(); }
    startChatGptLogin(): Promise<{ authUrl: string }> { return this.chatGpt.startLogin(); }
    cancelChatGptLogin(): Promise<void> { return this.chatGpt.cancel(); }
    modelStatus(): Promise<LocalModelStatus> { return this.localModels.status(); }
    async installLocalModel(): Promise<void> { this.localModels.install(); }
    async saveModels(projectPath: string): Promise<void> {
        if (!(await this.chatGpt.status()).planEnabled) throw new Error('Sign in with ChatGPT and authorize plan usage first.');
        await writeFile(join(resolve(projectPath), 'models.yaml'), `external:\n  provider: openai\n  auth: chatgpt_oauth\n  model: auto\nlocal:\n  enabled: true\n  provider: ollama\n  model: "${DEFAULT_LOCAL_MODEL}"\n  endpoint: http://127.0.0.1:11434\n  contextLength: 4096\n`);
    }
    protected registryPath = governedDataDirectory('recent-projects.json');

    async listRecent(): Promise<RecentProject[]> {
        try { return (JSON.parse(await readFile(this.registryPath, 'utf8')) as RecentProject[]).filter(project => project.opened === true); } catch { return []; }
    }

    async createProject(request: CreateProjectRequest): Promise<RecentProject> {
        const name = request.name.trim().normalize('NFC');
        if (!name || name === '.' || name === '..' || /[\/\\\x00-\x1f]/.test(name)) throw new Error('Enter a project name without path separators.');
        const root = resolve(request.parentDirectory, name);
        await mkdir(root, { recursive: false });
        await Promise.all(projectDirectories.map(part => mkdir(join(root, part))));
        const description = request.description.trim() || 'Project context for governed agents.';
        const project: RecentProject = { name, path: root, description, updatedAt: new Date().toISOString() };
        await writeFile(join(root, 'project.theia-workspace'), JSON.stringify({ folders: [{ name: 'Project', path: '.' }], governedProject: { name, description }, governedRepositories: [] }, undefined, 2));
        await this.workflows.initialize(root);
        await this.policies.initialize(root);
        return project;
    }

    async connectRepository(request: RepositoryRequest): Promise<void> {
        if (!/^[a-z0-9][a-z0-9-]*$/i.test(request.id)) throw new Error('Use letters, numbers, and hyphens for the repository name.');
        const projectPath = await realpath(request.projectPath);
        await projectMutations.run(`repositories:${projectPath}`, () => this.connect(projectPath, request));
    }

    private async connect(projectPath: string, request: RepositoryRequest): Promise<void> {
        const repositories = await this.readRepositories(projectPath);
        if (repositories.some(repository => repository.id === request.id)) throw new Error('A repository with this name is already connected.');
        if (request.kind === 'local' && repositories.some(repository => repository.path === resolve(request.source))) throw new Error('This folder is already connected.');
        let localPath = request.source;
        if (request.kind === 'local') {
            localPath = resolve(request.source);
            await access(join(localPath, '.git'), constants.F_OK);
            const result = await execFileAsync('git', ['-C', localPath, 'rev-parse', '--is-inside-work-tree'], { timeout: 10000 });
            if (result.stdout.trim() !== 'true') throw new Error('The selected folder is not a Git repository.');
        } else {
            const checkoutDirectory = join(this.checkoutRoot, randomUUID());
            await mkdir(checkoutDirectory, { recursive: true });
            const destination = join(checkoutDirectory, request.id);
            await execFileAsync('git', ['-c', 'credential.interactive=false', 'clone', '--filter=blob:none', '--', request.source, destination], { timeout: 120000 });
            localPath = destination;
        }
        repositories.push({ id: request.id, path: localPath, source: request.kind });
        await this.saveRepositories(projectPath, repositories, true);
    }

    async listRepositories(projectPath: string): Promise<ConnectedRepository[]> {
        projectPath = await realpath(projectPath);
        return projectMutations.run(`repositories:${projectPath}`, () => this.readRepositories(projectPath));
    }

    private async readRepositories(projectPath: string): Promise<ConnectedRepository[]> {
        const workspace = JSON.parse(await readFile(join(resolve(projectPath), 'project.theia-workspace'), 'utf8'));
        const repositories: ConnectedRepository[] = workspace.governedRepositories || workspace.folders.filter((folder: { path: string }) => folder.path !== '.').map((folder: { name: string; path: string; source?: 'local' | 'remote' }) => ({ id: folder.name, path: resolve(projectPath, folder.path), source: folder.source || 'local' }));
        // Reconcile older projects whose workspace folders had no on-disk links.
        for (const repository of repositories) await this.ensureRepositoryLink(projectPath, repository);
        if (!workspace.governedRepositories || workspace.folders.length !== 1 || workspace.folders[0].path !== '.') await this.saveRepositories(projectPath, repositories);
        return repositories;
    }

    async removeRepository(projectPath: string, id: string): Promise<void> {
        projectPath = await realpath(projectPath);
        await projectMutations.run(`repositories:${projectPath}`, async () => {
            const repositories = await this.readRepositories(projectPath);
            const repository = repositories.find(item => item.id === id);
            if (!repository) return;
            const link = join(projectPath, 'repositories', id);
            const entry = await lstat(link);
            if (entry.isSymbolicLink() && resolve(dirname(link), await readlink(link)) !== resolve(repository.path)) {
                throw new Error('Repository link was changed. No files were removed.');
            }
            if (entry.isSymbolicLink()) await unlink(link);
            try {
                await this.saveRepositories(projectPath, repositories.filter(item => item.id !== id), true);
            } catch (error) {
                if (entry.isSymbolicLink()) await this.ensureRepositoryLink(projectPath, repository);
                throw error;
            }
        });
    }

    protected async ensureRepositoryLink(projectPath: string, repository: ConnectedRepository): Promise<void> {
        if (!/^[a-z0-9][a-z0-9-]*$/i.test(repository.id)) throw new Error('Invalid repository name in project metadata.');
        const directory = join(resolve(projectPath), 'repositories');
        await mkdir(directory, { recursive: true });
        if ((await lstat(directory)).isSymbolicLink()) throw new Error('The repositories directory must be a real project folder.');
        const link = join(directory, repository.id); const target = resolve(repository.path);
        try {
            const entry = await lstat(link);
            if (entry.isSymbolicLink() && resolve(dirname(link), await readlink(link)) === target) return;
            // Preserve physical checkouts made by earlier app versions.
            if (entry.isDirectory() && link === target) return;
            throw new Error(`repositories/${repository.id} already exists and points elsewhere. Nothing was overwritten.`);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            await symlink(target, link, 'dir');
        }
    }

    protected async saveRepositories(projectPath: string, repositories: ConnectedRepository[], changed = false): Promise<void> {
        for (const repository of repositories) await this.ensureRepositoryLink(projectPath, repository);
        const workspacePath = join(projectPath, 'project.theia-workspace');
        const workspace = JSON.parse(await readFile(workspacePath, 'utf8'));
        await writeProjectText(projectPath, [], 'project.theia-workspace', JSON.stringify({ ...workspace, folders: [{ name: 'Project', path: '.' }], governedRepositories: repositories, ...(changed ? { governedRepositoryRevision: randomUUID() } : {}) }, undefined, 2));
    }

    async openProject(project: RecentProject): Promise<string> {
        const workspacePath = join(resolve(project.path), 'project.theia-workspace');
        await access(workspacePath, constants.F_OK);
        await this.listRepositories(project.path);
        const recents = (await this.listRecent()).filter(item => item.path !== project.path);
        recents.unshift({ ...project, opened: true, updatedAt: new Date().toISOString() });
        await mkdir(governedDataDirectory(), { recursive: true });
        await writeFile(this.registryPath, JSON.stringify(recents.slice(0, 12), undefined, 2));
        return workspacePath;
    }
}

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
    bind(ToolRegistry).toConstantValue(new ToolRegistry());
    bind(ToolPolicies).toDynamicValue(ctx => new ToolPolicies(ctx.container.get(ToolRegistry))).inSingletonScope();
    bind(ProjectTools).toDynamicValue(ctx => new ProjectTools(ctx.container.get(ToolRegistry), ctx.container.get(ToolPolicies))).inSingletonScope();
    bind(ProjectToolService).toService(ProjectTools);
    bind(BackendApplicationContribution).toService(ProjectTools);
    bind(ConnectionHandler).toDynamicValue(ctx => new RpcConnectionHandler(ProjectToolServicePath, () => ctx.container.get(ProjectToolService))).inSingletonScope();
    rebind(DiskFileSystemProvider).to(ProjectFileSystemProvider);
    bind(WorkflowServiceImpl).toSelf().inSingletonScope();
    bind(WorkflowService).toService(WorkflowServiceImpl);
    bind(ConnectionHandler).toDynamicValue(ctx => new RpcConnectionHandler(WorkflowServicePath, () => ctx.container.get(WorkflowService))).inSingletonScope();
    bind(TaskServiceImpl).toSelf().inSingletonScope();
    bind(TaskService).toService(TaskServiceImpl);
    bind(BackendApplicationContribution).toService(TaskServiceImpl);
    bind(ConnectionHandler).toDynamicValue(ctx => new RpcConnectionHandler(TaskServicePath, () => ctx.container.get(TaskService))).inSingletonScope();
    bind(LocalModelService).toSelf().inSingletonScope();
    bind(BackendApplicationContribution).toService(LocalModelService);
    bind(ChatGptService).toSelf().inSingletonScope();
    bind(BackendApplicationContribution).toService(ChatGptService);
    bind(ProjectServiceImpl).toSelf().inSingletonScope();
    bind(ProjectService).toService(ProjectServiceImpl);
    bind(ConnectionHandler).toDynamicValue(ctx => new RpcConnectionHandler(ProjectServicePath, () => ctx.container.get(ProjectService))).inSingletonScope();
});
