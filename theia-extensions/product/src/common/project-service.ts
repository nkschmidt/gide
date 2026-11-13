export const ProjectServicePath = '/services/governed-projects';

export interface RecentProject { name: string; path: string; description: string; updatedAt: string; opened?: boolean; }
export interface CreateProjectRequest { name: string; description: string; parentDirectory: string; }
export interface RepositoryRequest { projectPath: string; id: string; source: string; kind: 'local' | 'remote'; access: 'read-write' | 'read-only'; }
export interface ConnectedRepository { id: string; path: string; source: 'local' | 'remote'; }
export const DEFAULT_LOCAL_MODEL = 'qwen3:8b';
export interface ChatGptStatus { signedIn: boolean; planEnabled: boolean; pending: boolean; email?: string; error?: string; }
export interface LocalModelStatus { running: boolean; models: string[]; memoryGB: number; cpu: string; credentials: { openai: boolean; anthropic: boolean }; job?: { state: 'running' | 'done' | 'error'; phase: string; completed: number; total: number; error?: string }; }

export const ProjectService = Symbol('ProjectService');
export interface ProjectService {
    listRecent(): Promise<RecentProject[]>;
    createProject(request: CreateProjectRequest): Promise<RecentProject>;
    connectRepository(request: RepositoryRequest): Promise<void>;
    openProject(project: RecentProject): Promise<string>;
    listRepositories(projectPath: string): Promise<ConnectedRepository[]>;
    removeRepository(projectPath: string, id: string): Promise<void>;
    modelStatus(): Promise<LocalModelStatus>;
    installLocalModel(): Promise<void>;
    saveModels(projectPath: string): Promise<void>;
    chatGptStatus(): Promise<ChatGptStatus>;
    startChatGptLogin(): Promise<{ authUrl: string }>;
    cancelChatGptLogin(): Promise<void>;
}
