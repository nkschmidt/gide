import { AccessCategory, AccessDecision } from '../../../common/tool-policy';
import { Action } from '../../../common/task-service';
import { OperationAnalysis, ToolEffect } from './command-analysis';
export interface ToolAccess {
    categories: AccessCategory[];
    classify(args: Record<string, unknown>, prepared: Record<string, unknown>): string;
    analyze?(args: Record<string, unknown>, prepared: Record<string, unknown>): OperationAnalysis;
    requiredCategories?(args: Record<string, unknown>, prepared: Record<string, unknown>): readonly string[];
}
/** Every implementation enters through this contract; undeclared effects remain unknown. */
export function analyzeToolAction(access: ToolAccess, args: Record<string, unknown>, prepared: Record<string, unknown>): OperationAnalysis {
    const category = access.classify(args, prepared);
    const analysis = access.analyze?.(args, prepared) || { category, effects: ['unknown'] as const };
    const effects = ['read', 'write', 'delete', 'network', 'publish', 'execute', 'unknown'];
    if (analysis.category !== category || !access.categories.some(item => item.id === category) || !Array.isArray(analysis.effects) || !analysis.effects.length || analysis.effects.some(effect => !effects.includes(effect))) throw new Error('Tool implementation returned inconsistent operation semantics.');
    return { category, effects: [...new Set(analysis.effects)].sort(), ...(analysis.unrecognizedFlags?.length ? { unrecognizedFlags: [...new Set(analysis.unrecognizedFlags)].sort() } : {}) };
}
/** Independent policy constraints compose; Allow never overrides another constraint's Ask/Deny. */
export function accessRequirements(access: ToolAccess, args: Record<string, unknown>, prepared: Record<string, unknown>): string[] {
    const categories = [...new Set([access.classify(args, prepared), ...(access.requiredCategories?.(args, prepared) || [])])];
    if (categories.some(id => !access.categories.some(category => category.id === id))) throw new Error('Tool requires an undeclared policy category.');
    return categories;
}
export function combineAccess(decisions: readonly AccessDecision[]): AccessDecision { return decisions.includes('deny') ? 'deny' : decisions.includes('ask') ? 'ask' : 'allow'; }
/** Reusable opt-in capability for installed CLI implementations. Model input cannot change this rule. */
export function commandFlagAccess(access: ToolAccess): ToolAccess {
    return { ...access, categories: [...access.categories, { id: 'extra-flags', label: 'Unrecognized command flags', description: 'Allow any additional flags, ask before each command, or deny flags absent from the installed command description. Command permissions and technical boundaries still apply.', defaultDecision: 'ask', auxiliary: true }],
        requiredCategories: (args, prepared) => [...(access.requiredCategories?.(args, prepared) || []), ...(access.analyze?.(args, prepared).unrecognizedFlags?.length ? ['extra-flags'] : [])] };
}
export interface PolicyVerdict { decision: AccessDecision; revision: string; category: string; }
export function scopeAccess(decisions: Record<string, AccessDecision>, select: (prepared: Record<string, unknown>) => string = prepared => String(prepared.scope), effects: readonly ToolEffect[] = ['unknown']): ToolAccess {
    return { categories: Object.entries(decisions).map(([id, defaultDecision]) => ({ id, label: id.replace(/-/g, ' '), defaultDecision })), classify: (_args, prepared) => select(prepared), analyze: (_args, prepared) => ({ category: select(prepared), effects }) };
}
export const defaultToolAccess = (): ToolAccess => ({ categories: [{ id: 'execute', label: 'Execute', defaultDecision: 'ask' }], classify: () => 'execute' });
/** In-memory defaults for embedding/testing; the application uses project-backed policies. */
export class DefaultPolicy {
    check(action: Action, access?: ToolAccess): 'allow' | 'approve' | 'deny' {
        if (!access) return 'deny';
        const categories = accessRequirements(access, action.args || {}, action.prepared || {});
        const decision = combineAccess(categories.map(category => access.categories.find(item => item.id === category)?.defaultDecision || 'deny'));
        return decision === 'ask' ? 'approve' : decision;
    }
    async evaluate(action: Action, access: ToolAccess): Promise<PolicyVerdict> {
        const decision = this.check(action, access); return { decision: decision === 'approve' ? 'ask' : decision, revision: JSON.stringify(access.categories), category: access.classify(action.args || {}, action.prepared || {}) };
    }
}
