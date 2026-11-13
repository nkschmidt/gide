import { createHash } from 'crypto';
import { injectable } from '@theia/core/shared/inversify';
import { ToolPolicyDocument, ToolPolicyView } from '../../../common/tool-policy';
import { Action } from '../../../common/task-service';
import { Policy, ToolContext, ToolRegistry } from '../core/contracts';
import { accessRequirements, combineAccess, PolicyVerdict, ToolAccess } from '../core/tool-access';
import { ProjectToolRepository } from './project-tools';
import { SafeToolError } from '../modules/file-tools';
/** Policy evaluation is independent of execution, but its data lives in the tool manifest. */
@injectable()
export class ToolPolicies implements Policy {
    private source?: ProjectToolRepository;
    constructor(private readonly tools: ToolRegistry) { }
    useRepository(repository: ProjectToolRepository): void { if (this.source) throw new Error('Manifest policy source already configured.'); this.source = repository; }
    private repository(): ProjectToolRepository { if (!this.source) throw new SafeToolError('Tool manifest source is unavailable.'); return this.source; }
    async initialize(project: string): Promise<void> { project = await this.repository().project(project); await this.tools.refreshProject(project); }
    private async view(project: string, name: string, method?: string): Promise<ToolPolicyView> {
        const item = this.tools.registration(name, project, method); const saved = await this.repository().get(project, item.manifestId!);
        return { tool: name, description: saved.tool.description, module: item.module, version: item.version, categories: item.access.categories, document: { schemaVersion: 1, tool: name, categories: saved.tool.policy }, revision: saved.revision, definitionRevision: saved.revision };
    }
    async list(project: string): Promise<ToolPolicyView[]> { project = await this.repository().project(project); await this.initialize(project); return Promise.all(this.tools.catalog(project).map(item => this.view(project, item.executor.definition.name))); }
    async save(project: string, name: string, document: ToolPolicyDocument, expectedRevision: string): Promise<ToolPolicyView> {
        project = await this.repository().project(project); await this.initialize(project); const item = this.tools.registration(name, project); const saved = await this.repository().get(project, item.manifestId!);
        if (document.schemaVersion !== 1 || document.tool !== name) throw new SafeToolError('Policy does not identify this tool.');
        await this.repository().save(project, { ...saved.tool, policy: document.categories }, expectedRevision); await this.tools.refreshProject(project); return this.view(project, name);
    }
    async evaluate(action: Action, manifest: ToolAccess, context: ToolContext): Promise<PolicyVerdict> {
        try {
            await this.initialize(context.projectPath); const view = await this.view(context.projectPath, action.tool, action.method); const category = manifest.classify(action.args, action.prepared || {});
            const required = accessRequirements(manifest, action.args, action.prepared || {});
            if (!view.document || required.some(id => !Object.prototype.hasOwnProperty.call(view.document!.categories, id))) throw new SafeToolError('Action has no declared manifest policy category.');
            return { category, decision: combineAccess(required.map(id => view.document!.categories[id])), revision: createHash('sha256').update(JSON.stringify({ manifest: view.revision, module: view.module, version: view.version, categories: manifest.categories })).digest('hex') };
        } catch (error) { throw new SafeToolError(`Policy blocked ${action.tool}: ${error instanceof Error ? error.message : 'Manifest unavailable.'}`); }
    }
}
