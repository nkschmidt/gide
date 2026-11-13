export type AccessDecision = 'allow' | 'ask' | 'deny';
export type ToolEffect = 'read' | 'write' | 'delete' | 'network' | 'publish' | 'execute' | 'unknown';
export interface OperationAnalysis { category: string; effects: readonly ToolEffect[]; unrecognizedFlags?: readonly string[]; }
export interface AccessCategory { id: string; label: string; defaultDecision: AccessDecision; auxiliary?: boolean; description?: string; }
export interface ToolPolicyDocument { schemaVersion: 1; tool: string; categories: Record<string, AccessDecision>; }
export interface ToolPolicyView {
    tool: string; description: string; module: string; version: string; categories: AccessCategory[];
    definitionRevision?: string; document?: ToolPolicyDocument; revision?: string; error?: string;
}
