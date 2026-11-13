export interface QuestionOption { id: string; label: string; description: string; }
export interface UserQuestion { question: string; options: QuestionOption[]; }
export interface QuestionAnswer { optionId?: string; text?: string; }
import { ProjectTool } from './project-tool-service';
export type InteractionResponse = QuestionAnswer | { approved: boolean } | { save: boolean; tool?: ProjectTool };
export interface StepToolAccess { reason: string; stepTitle: string; tools: { id: string; label: string; description: string; revision: string }[]; }
export type ToolInteraction = { kind: 'question'; question: UserQuestion } | { kind: 'workflow_selection'; question: UserQuestion; recommendedId: string } | { kind: 'workflow_tools'; toolAccess: StepToolAccess } | { kind: 'tool_proposal'; tool: ProjectTool; expectedRevision: string | null };
export interface InteractionRequest {
    id: string; key: string; taskId: string; runId?: string; actionId?: string;
    kind: 'question' | 'workflow_selection' | 'workflow_tools' | 'workflow_approval' | 'action_approval' | 'tool_proposal';
    state: 'pending' | 'answered' | 'cancelled' | 'invalidated';
    question?: UserQuestion; recommendedId?: string; toolAccess?: StepToolAccess; stepId?: string; revision?: number; approvalId?: string;
    tool?: ProjectTool; expectedRevision?: string | null; review?: Record<string, unknown>;
    response?: InteractionResponse; result?: string; createdAt: number; resolvedAt?: number;
}
/** Explicit results of a model turn; ordinary messages never advance a workflow. */
export type TurnOutcome = { kind: 'message' } | { kind: 'interaction'; interactionId: string } | { kind: 'step_result' } | { kind: 'blocked' };
