export const ContextTopics = ['architecture', 'modules', 'data', 'integration', 'patterns', 'testing', 'operations'] as const;
export type ContextTopicId = typeof ContextTopics[number];
export interface ContextFact { text: string; evidence: string[]; }
export interface ContextExample { purpose: string; path: string; symbol: string; }
export interface ContextTopic { id: ContextTopicId; title: string; summary: string; whenToUse: string; facts: ContextFact[]; examples: ContextExample[]; unknowns: string[]; }
export interface ContextTopicLink { id: ContextTopicId; title: string; summary: string; whenToUse: string; }
export interface ContextSource { path: string; digest: string; }
export interface RepositoryContext {
    repository: string; summary: string; generation: string; updatedAt: number; revision: string; dirty: boolean;
    topics: ContextTopicLink[]; freshness: 'current' | 'changed' | 'unknown'; note?: string;
    job?: { taskId: string; state: string; error?: string };
}
export interface ProjectContextIndex { project: string; overview: string; repositories: { id: string; context?: RepositoryContext; job?: { taskId: string; state: string; error?: string; review?: { actionId: string; interactionId: string; proposal: Record<string, unknown> } } }[]; }
export interface ContextSelection { repository: string; generation?: string; summary: string; revision: string; updatedAt: number; freshness: 'current' | 'changed' | 'unknown'; note?: string; topics: ContextTopic[]; sources: ContextSource[]; }
