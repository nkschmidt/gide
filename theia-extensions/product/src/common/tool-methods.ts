import { ProjectTool, SavedTool } from './project-tool-service';
export interface ToolMethodSpec { id: string; name: string; description: string; implementation: ProjectTool['implementation']; }
export interface ToolMethodSummary { id: string; name: string; description: string; workflowSupport: boolean; }
export const methodRef = (id: string, method: string) => `${id}#${method}`;
export function splitMethodRef(ref: string): { id: string; method?: string } { const [id, method] = ref.split('#'); return { id, ...(method ? { method } : {}) }; }
export function methodTool(saved: SavedTool, method: string): SavedTool {
    const methods = saved.tool.implementation.configuration.methods as ToolMethodSpec[];
    const spec = methods?.find(item => item.id === method); if (!spec) throw new Error('This method is not available.');
    const prefix = `${method}--`;
    return { ...saved, method, tool: { ...saved.tool, name: `${saved.tool.name} · ${spec.name}`, description: spec.description, implementation: spec.implementation, policy: Object.fromEntries(Object.entries(saved.tool.policy).filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key.slice(prefix.length), value])) } };
}
