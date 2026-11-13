import { ImplementationChoice, ProjectTool, SavedTool } from '../../../common/project-tool-service';
import { ToolAccess } from './tool-access';
import { ToolContext, ToolRegistration } from './contracts';
export interface ToolImplementation {
    readonly id: string;
    validate(configuration: unknown): Record<string, unknown>;
    validateProject(tool: ProjectTool, context: ToolContext): Promise<void>;
    access(configuration: Record<string, unknown>): ToolAccess;
    choices(): ImplementationChoice[];
    registration(saved: SavedTool): ToolRegistration;
}
export class ImplementationRegistry {
    private readonly providers = new Map<string, ToolImplementation>();
    register(provider: ToolImplementation): void { if (this.providers.has(provider.id) || !/^[a-z][a-z0-9-]{0,63}$/.test(provider.id)) throw new Error('Invalid or duplicate tool implementation provider.'); this.providers.set(provider.id, provider); }
    get(id: string): ToolImplementation { const item = this.providers.get(id); if (!item) throw new Error(`Implementation "${id}" is not installed.`); return item; }
    choices(): ImplementationChoice[] { return [...this.providers.values()].flatMap(item => item.choices()); }
}
