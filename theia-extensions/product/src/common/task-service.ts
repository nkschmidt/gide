import { OperationAnalysis } from './tool-policy';
export const TaskService = Symbol('TaskService');
export const TaskServicePath = '/services/governed-tasks';
export type TaskState = 'idle' | 'running' | 'awaiting_approval' | 'waiting_input' | 'waiting_review' | 'blocked' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type ActionState = 'requested' | 'awaiting_approval' | 'waiting' | 'running' | 'succeeded' | 'failed' | 'denied' | 'cancelled' | 'interrupted';
export { QuestionOption, UserQuestion, QuestionAnswer } from './interaction';
export interface Task { id: string; projectPath: string; title: string; state: TaskState; draft: string; createdAt: number; updatedAt: number; closedAt?: number; origin?: { taskId: string; workflowId: string; requestId: string }; kind?: 'chat' | 'repository-analysis'; repository?: string; repositoryRevision?: string; workflowMode?: 'chat' | 'auto' | 'selected'; workflow?: import('./workflow-run').WorkflowRun; }
export interface Message { id: string; taskId: string; runId?: string; role: 'user' | 'assistant' | 'tool'; text: string; resultRef?: string; createdAt: number; callId?: string; continuation?: unknown[]; localOnly?: boolean; providerOnly?: boolean; }
export interface Run { id: string; taskId: string; state: TaskState; kind: 'model' | 'action'; steps: number; outcome?: import('./interaction').TurnOutcome; waitingFor?: string; error?: string; createdAt: number; updatedAt: number; }
export interface ReadFileSummary { path: string; status: 'pending' | 'reading' | 'read' | 'failed' | 'denied' | 'cancelled'; error?: string; }
export interface Action { id: string; taskId: string; runId: string; callId: string; tool: string; method?: string; handlerId?: string; handlerTool?: string; args: Record<string, unknown>; reason: string; state: ActionState; prepared?: Record<string, unknown>; operation?: OperationAnalysis; workflowContext?: { stepId: string; revision: number }; authorization?: { decision: 'allow' | 'ask' | 'deny'; revision: string; category: string }; result?: string; readFiles?: ReadFileSummary[]; error?: string; createdAt: number; updatedAt: number; }
export interface Approval { id: string; actionId: string; state: 'pending' | 'approved' | 'denied' | 'revoked'; fingerprint: string; createdAt: number; decidedAt?: number; }
export interface TaskEvent { id: number; taskId: string; runId?: string; type: string; data: Record<string, unknown>; createdAt: number; }
export interface TaskSnapshot { task: Task; messages: Message[]; runs: Run[]; actions: Action[]; interactions: import('./interaction').InteractionRequest[]; approvals: Approval[]; events: TaskEvent[]; }
export interface TaskService {
    /** User conversations only; repository research is a system job exposed via projectContext. */
    list(projectPath: string): Promise<Task[]>;
    create(projectPath: string): Promise<Task>;
    followUpOptions(taskId: string): Promise<import('./workflow-service').WorkflowSummary[]>;
    startFollowUp(taskId: string, workflowId: string, requestId: string): Promise<Task>;
    setWorkflow(taskId: string, choice: string): Promise<void>;
    snapshot(taskId: string): Promise<TaskSnapshot>;
    saveDraft(taskId: string, text: string): Promise<void>;
    send(taskId: string, text: string, requestId: string): Promise<void>;
    resume(taskId: string): Promise<void>;
    cancel(taskId: string): Promise<void>;
    respondInteraction(interactionId: string, response: import('./interaction').InteractionResponse): Promise<void>;
    readFiles(taskId: string, paths: string[]): Promise<void>;
    projectContext(projectPath: string): Promise<import('./project-context').ProjectContextIndex>;
    contextTopics(projectPath: string, repository: string, topics: string[]): Promise<import('./project-context').ContextSelection>;
    analyzeProject(projectPath: string): Promise<void>;
    analyzeRepository(projectPath: string, repository: string): Promise<Task>;
}

/** Task closure is terminal. A completed chat turn alone does not close its task. */
export function isTaskClosed(task: Task): boolean {
    return task.closedAt !== undefined || task.workflow?.phase === 'completed';
}

/** Canonical operation of an installed handler, retained for evidence and compact presentation. */
export function toolOperation(action: Action): string { return action.handlerTool || action.tool; }
