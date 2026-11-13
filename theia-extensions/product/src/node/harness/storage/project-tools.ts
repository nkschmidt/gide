import { builtinTemplates } from '../core/tool-families';
import { methodTool, ToolMethodSpec } from '../../../common/tool-methods';
import { createHash } from 'crypto';
import { isDeepStrictEqual } from 'util';
import { access, readdir, realpath } from 'fs/promises';
import { join } from 'path';
import { ProjectTool, SavedTool, ToolProblem } from '../../../common/project-tool-service';
import { ToolRegistry } from '../core/contracts';
import { ImplementationRegistry } from '../core/implementations';
import { SafeToolError } from '../modules/file-tools';
import { projectDirectory, readProjectText, writeProjectText } from './project-files';
import { projectMutations } from './mutation-queue';
export const toolDigest = (text: string) => createHash('sha256').update(text).digest('hex');
export function projectFunctionName(id: string): string { const name = 'project_' + id.replace(/[.-]/g, '_'); return name.length <= 64 ? name : name.slice(0, 53) + '_' + toolDigest(id).slice(0, 10); }
export const validToolId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9][a-z0-9._-]{0,99}$/.test(id) && !id.includes('..');
export class ProjectToolRepository {
    constructor(readonly implementations: ImplementationRegistry, private readonly registry: ToolRegistry) { }
    builtin(id: string) { return builtinTemplates(this.registry).find(item => item.tool.id === id); }
    validate(value: unknown): ProjectTool {
        const t = value as ProjectTool;
        if (!t || Object.keys(t).sort().join(',') !== 'description,id,implementation,name,policy,schemaVersion,toolName' || t.schemaVersion !== 2 || !validToolId(t.id) || typeof t.toolName !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(t.toolName)) throw new SafeToolError('Use schemaVersion 2, a stable tool ID and a valid function name.');
        if (typeof t.name !== 'string' || !t.name.trim() || t.name.length > 160 || typeof t.description !== 'string' || !t.description.trim() || t.description.length > 4000 || !t.implementation || Object.keys(t.implementation).sort().join(',') !== 'configuration,executor') throw new SafeToolError('Provide name, description and an implementation binding.');
        const provider = this.implementations.get(t.implementation.executor); const configuration = provider.validate(t.implementation.configuration); const categories = provider.access(configuration).categories;
        if (!t.policy || typeof t.policy !== 'object' || Array.isArray(t.policy) || Object.entries(t.policy).some(([id, decision]) => !/^[a-z0-9][a-z0-9_-]{0,159}$/.test(id) || !['allow', 'ask', 'deny'].includes(decision)) || categories.some(category => !Object.prototype.hasOwnProperty.call(t.policy, category.id))) throw new SafeToolError('Set Allow, Ask or Deny for every implementation policy category.');
        const builtin = this.builtin(t.id);
        if (builtin) {
            if (!isDeepStrictEqual({ ...t, policy: builtin.tool.policy }, builtin.tool) || Object.keys(t.policy).length !== builtin.categories.length) {
                throw new SafeToolError('Only access rules can be changed for a built-in tool.');
            }
            return { ...builtin.tool, policy: { ...t.policy } };
        }
        if (t.id.startsWith('builtin.') || builtinTemplates(this.registry).some(item => item.tool.toolName === t.toolName) || this.registry.catalog().some(item => item.executor.definition.name === t.toolName)) throw new SafeToolError('That built-in ID or function name is reserved.');
        const result: ProjectTool = { schemaVersion: 2, id: t.id, toolName: t.toolName, name: t.name.trim(), description: t.description.trim(), implementation: { executor: t.implementation.executor, configuration }, policy: { ...t.policy } };
        const limit=t.implementation.executor==='methods'?64000:32000; if (Buffer.byteLength(JSON.stringify(result, null, 2) + '\n') > limit) throw new SafeToolError(`Tool manifest exceeds the ${limit===64000?'64,000':'32,000'}-byte file limit.`); return result;
    }
    async project(project: string): Promise<string> { const root = await realpath(project); await access(join(root, 'project.theia-workspace')); await projectDirectory(root, ['tools'], true); return root; }
    async initialize(project: string): Promise<void> {
        project = await this.project(project);
        await projectMutations.run(`manifests:${project}`, async () => {
            const catalogText = await readProjectText(project, ['tools'], '.catalog.json'); const catalog = catalogText ? JSON.parse(catalogText) : {};
            if (!catalog || Array.isArray(catalog) || typeof catalog !== 'object' || Object.values(catalog).some(ids => !Array.isArray(ids))) throw new SafeToolError('Tool manifest catalog is invalid. Restore tools/.catalog.json.');
            for (const item of builtinTemplates(this.registry)) {
                const id=item.tool.id;const name=`${id}.json`;const text=await readProjectText(project,['tools'],name,64000);
                if(!text && !Object.prototype.hasOwnProperty.call(catalog,id)) await writeProjectText(project,['tools'],name,JSON.stringify(this.validate(item.tool),null,2)+'\n');
                else if (text) {
                    try {
                        const raw = JSON.parse(text) as ProjectTool;
                        if (!raw?.policy || typeof raw.policy !== 'object' || Array.isArray(raw.policy)) continue;
                        const known = catalog[id] || [];
                        const policy = Object.fromEntries(item.categories.flatMap(({ id: category, defaultDecision }) => {
                            if (Object.prototype.hasOwnProperty.call(raw.policy, category)) return [[category, raw.policy[category]]];
                            return known.includes(category) ? [] : [[category, defaultDecision]];
                        }));
                        let implementation = raw.implementation;
                        if (implementation?.executor === 'methods' && item.tool.implementation.executor === 'methods' && Array.isArray(implementation.configuration?.methods)) {
                            const installed = item.tool.implementation.configuration.methods as ToolMethodSpec[];
                            // Retire installed methods removed by a module update. Keep unknown edits invalid for repair.
                            const methods = (implementation.configuration.methods as ToolMethodSpec[]).filter(method => installed.some(candidate => candidate.id === method.id) || !known.some((key: string) => key.startsWith(`${method.id}--`))).map(method => {
                                const definition = installed.find(candidate => candidate.id === method.id);
                                return definition ? { ...method, name: definition.name, description: definition.description } : method;
                            });
                            for (const method of installed) {
                                if (!methods.some(candidate => candidate.id === method.id) && !known.some((key: string) => key.startsWith(`${method.id}--`))) methods.push(method);
                            }
                            const order = new Map(installed.map((method, index) => [method.id, index]));
                            methods.sort((a, b) => (order.get(a.id) ?? -1) - (order.get(b.id) ?? -1));
                            implementation = { ...implementation, configuration: { ...implementation.configuration, methods } };
                        }
                        const canonical = this.validate({ ...raw, name: item.tool.name, description: item.tool.description, implementation, policy });
                        if (!isDeepStrictEqual(raw, canonical) && await readProjectText(project, ['tools'], name, 64000) === text) {
                            await writeProjectText(project, ['tools'], name, JSON.stringify(canonical, null, 2) + '\n');
                        }
                    } catch { /* Invalid policies remain available for repair. */ }
                }
                catalog[id]=item.categories.map(category=>category.id);
            }
            const next = JSON.stringify(catalog, null, 2) + '\n'; if (next !== catalogText) await writeProjectText(project, ['tools'], '.catalog.json', next);

        });
    }
    async list(project: string): Promise<{ tools: SavedTool[]; unavailable: ToolProblem[]; errors: string[] }> {
        project = await this.project(project); const errors: string[] = []; try { await this.initialize(project); } catch (error) { errors.push(error instanceof Error ? error.message : 'Tool initialization failed.'); }
        const tools: SavedTool[] = []; const unavailable: ToolProblem[] = [];
        for (const name of (await readdir(await projectDirectory(project, ['tools']))).filter(name => !name.startsWith('.') && name.endsWith('.json')).sort()) {
            const id = name.slice(0, -5); try { tools.push(await this.get(project, id)); }
            catch (error) { let text: string | undefined; let raw: ProjectTool | undefined; try { text = await readProjectText(project, ['tools'], name, 64000); raw = text ? JSON.parse(text) : undefined; } catch { /* Preserve unreadable files. */ } unavailable.push({ id, name: raw?.name || id, error: error instanceof Error ? error.message : 'Invalid tool', revision: text ? toolDigest(text) : undefined, tool: raw?.schemaVersion === 2 ? raw : undefined }); }
        }
        const counts = new Map<string, number>(); tools.forEach(item => counts.set(item.functionName, (counts.get(item.functionName) || 0) + 1));
        const unique = tools.filter(item => { if (counts.get(item.functionName) === 1) return true; unavailable.push({ id: item.tool.id, name: item.tool.name, tool: item.tool, revision: item.revision, error: 'Duplicate function name; conflicting tools are unavailable.' }); return false; });
        let known: Record<string, unknown> = {}; try { known = JSON.parse(await readProjectText(project, ['tools'], '.catalog.json') || '{}'); } catch { /* Reported above. */ }
        for (const id of Object.keys(known)) if (!unique.some(item => item.tool.id === id) && !unavailable.some(item => item.id === id) && this.builtin(id)) unavailable.push({ id, name: id, error: 'Manifest is missing. Restore this tool file; it was not recreated.' });
        return { tools: unique, unavailable, errors };
    }
    async get(project: string, id: string): Promise<SavedTool> {
        if (!validToolId(id)) throw new SafeToolError('Invalid tool ID.'); const text = await readProjectText(project, ['tools'], `${id}.json`, 64000); if (!text) throw new SafeToolError('Tool manifest is missing.'); const tool = this.validate(JSON.parse(text)); if (tool.id !== id) throw new SafeToolError('Tool ID must match its file name.');
        return { tool, revision: toolDigest(text), functionName: tool.toolName, origin: this.builtin(id) ? 'builtin' : 'project', workflowSupport: !!this.builtin(id)?.workflowSupport, ...(tool.implementation.executor === 'methods' ? { methods:Object.entries(this.implementations.get('methods').registration({tool,revision:toolDigest(text),functionName:tool.toolName,origin:this.builtin(id)?'builtin':'project'}).executor.methods!).map(([method,entry])=>({id:method,name:(tool.implementation.configuration.methods as ToolMethodSpec[]).find(item=>item.id===method)!.name,description:entry.executor.definition.description.slice(0,240),workflowSupport:!!entry.executor.workflowSupport})) } : {}), categories: this.implementations.get(tool.implementation.executor).access(tool.implementation.configuration).categories };
    }
    async executable(project:string,id:string,method?:string):Promise<SavedTool>{const saved=await this.get(project,id);if(saved.tool.implementation.executor==='methods'){if(!method)throw new SafeToolError('Choose a tool method.');return methodTool(saved,method);}if(method)throw new SafeToolError('This tool has no methods.');return saved;}
    async save(project: string, value: ProjectTool, expectedRevision: string | null): Promise<SavedTool> {
        project = await this.project(project); const tool = this.validate(value);
        return projectMutations.run(`manifests:${project}`, async () => {
            const previous = await readProjectText(project, ['tools'], `${tool.id}.json`, 64000); if ((previous === undefined ? null : toolDigest(previous)) !== expectedRevision) throw new SafeToolError('Tool changed. Reload before saving; nothing was overwritten.');
            for (const name of (await readdir(await projectDirectory(project, ['tools']))).filter(name => !name.startsWith('.') && name.endsWith('.json') && name !== `${tool.id}.json`)) { const text = await readProjectText(project, ['tools'], name, 64000); try { if (text && JSON.parse(text).toolName === tool.toolName) throw new SafeToolError('Another tool uses this function name.'); } catch (error) { if (error instanceof SafeToolError) throw error; } }
            await this.implementations.get(tool.implementation.executor).validateProject(tool, { projectPath: project, signal: AbortSignal.timeout(30000) }); await writeProjectText(project, ['tools'], `${tool.id}.json`, JSON.stringify(tool, null, 2) + '\n'); return this.get(project, tool.id);
        });
    }
}
