export interface MemoryFact { text: string; refs: string[]; }
export interface TaskSummary { goal: MemoryFact; requirements: MemoryFact[]; decisions: MemoryFact[]; progress: MemoryFact[]; verification: MemoryFact[]; openQuestions: MemoryFact[]; nextSteps: MemoryFact[]; }
export interface TaskCheckpoint { id: string; taskId: string; version: number; previousId?: string; throughMessageId: string; sourceHash: string; summary: TaskSummary; createdAt: number; }
export interface TaskResult { id: string; taskId: string; text: string; }
