import { WorkflowStep } from './workflow-service';
export const WorkflowOperations = ['changeset-write', 'branch-create', 'repository-edit', 'memory-update', 'repository-commit', 'repository-publish'] as const;
export type WorkflowOperation = typeof WorkflowOperations[number];
export interface CriterionResult { index: number; status: 'met' | 'unmet' | 'not_applicable'; explanation: string; references: string[]; }
export interface WorkflowArtifact { path: string; digest: string; }
export interface WorkflowObservation { fingerprint: string; data?: Record<string, unknown>; summary?: string; }
export interface WorkflowStepResult { stepId: string; revision: number; summary: string; ready: CriterionResult[]; done: CriterionResult[]; artifacts: WorkflowArtifact[]; approvedAt?: number; inputs?: Record<string, number>; observations?: Record<string, WorkflowObservation>; }
export interface WorkflowRun {
    id: string; name: string; definitionRevision: number; steps: WorkflowStep[]; index: number;
    phase: 'draft' | 'active' | 'blocked' | 'review' | 'completed'; revision: number;
    ready?: CriterionResult[]; pending?: WorkflowStepResult; results: WorkflowStepResult[];
    notice?: string; branches: Record<string, { branch: string; base: string; head: string; tip?: string; commits?: { head: string; parent: string }[] }>;
    waitingFor?: string;
    edits?: Record<string, Record<string, string | null>>;
    history?: { result: WorkflowStepResult; invalidatedAt: number; reason: string }[];
    discussion?: boolean;
    rework?: { target: string; from: string; reason: string; reference?: string; revision: number };
}
