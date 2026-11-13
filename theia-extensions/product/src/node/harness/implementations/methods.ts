import { ProjectTool, SavedTool } from '../../../common/project-tool-service';
import { ToolMethodSpec, methodTool } from '../../../common/tool-methods';
import { ToolContext, ToolDefinition, ToolExecutor, ToolRegistration, ToolRegistry } from '../core/contracts';
import { ImplementationRegistry, ToolImplementation } from '../core/implementations';
import { builtinTemplates } from '../core/tool-families';
import { SafeToolError } from '../modules/file-tools';
import { accessRequirements, analyzeToolAction } from '../core/tool-access';
export function methodsExecutor(name: string, description: string, methods: Record<string, ToolRegistration>): ToolExecutor {
    const definition: ToolDefinition = { name, description, parameters: { type: 'object', properties: { call: { anyOf: Object.entries(methods).map(([id, entry]) => ({ type: 'object', description:entry.executor.definition.description, properties: { method: { type: 'string', enum: [id] }, arguments: entry.executor.definition.parameters }, required: ['method','arguments'], additionalProperties: false })) } }, required: ['call'], additionalProperties: false } };
    return { definition, methods, workflowOperations: [...new Set(Object.values(methods).flatMap(item => item.executor.workflowOperations || []))], prepare: async()=>{throw new SafeToolError('Choose a declared method.');}, execute: async()=>{throw new SafeToolError('Choose a declared method.');} };
}
export class MethodsImplementation implements ToolImplementation {
    readonly id = 'methods';
    constructor(private readonly implementations: ImplementationRegistry, private readonly registry: ToolRegistry) { }
    validate(value: unknown): Record<string, unknown> {
        const c = value as { methods: ToolMethodSpec[] };
        if (!c || Object.keys(c).join(',') !== 'methods' || !Array.isArray(c.methods) || !c.methods.length || c.methods.length > 40) throw new SafeToolError('Define 1–40 methods.');
        const ids = new Set<string>(); const methods = c.methods.map(method => {
            if (!method || Object.keys(method).sort().join(',') !== 'description,id,implementation,name' || !/^[a-z][a-z0-9_]{0,31}$/.test(method.id) || ids.has(method.id) || typeof method.name !== 'string' || !method.name.trim() || method.name.length>160 || typeof method.description !== 'string' || !method.description.trim() || method.description.length>4000 || !method.implementation || Object.keys(method.implementation).sort().join(',') !== 'configuration,executor' || method.implementation.executor === 'methods') throw new SafeToolError('Each method needs a unique ID, name, description and installed implementation. Nested method groups are not supported.');
            ids.add(method.id); const provider = this.implementations.get(method.implementation.executor); return { ...method, implementation: { executor: provider.id, configuration: provider.validate(method.implementation.configuration) } };
        }); return { methods };
    }
    access(configuration: Record<string, unknown>) {
        const methods = this.validate(configuration).methods as ToolMethodSpec[];
        return { categories: methods.flatMap(method => this.implementations.get(method.implementation.executor).access(method.implementation.configuration).categories.map(category => ({ ...category, id: `${method.id}--${category.id}`, label: `${method.name} · ${category.label}` }))), classify: () => { throw new SafeToolError('Policy requires a concrete method.'); } };
    }
    async validateProject(tool: ProjectTool, context: ToolContext): Promise<void> { for (const method of tool.implementation.configuration.methods as ToolMethodSpec[]) { const child = methodTool({ tool, revision:'', functionName:tool.toolName },method.id); await this.implementations.get(method.implementation.executor).validateProject(child.tool,context); } }
    choices() { return [{ key:this.id,label:'Methods',executor:this.id,configuration:{methods:[]},configurationSchema:{type:'object',properties:{methods:{type:'array'}},required:['methods'],additionalProperties:false},categories:[] }]; }
    registration(saved: SavedTool): ToolRegistration {
        const methods: Record<string,ToolRegistration> = Object.create(null);
        for (const method of saved.tool.implementation.configuration.methods as ToolMethodSpec[]) {
            const child = methodTool(saved,method.id); const source = this.implementations.get(method.implementation.executor).registration(child); const access = source.access;
            methods[method.id] = { ...source, enabled:access.categories.some(category=>!category.auxiliary && saved.tool.policy[`${method.id}--${category.id}`]!=='deny'), method:method.id, executor:source.executor, access: { categories:access.categories.map(category=>({...category,id:`${method.id}--${category.id}`,label:`${method.name} · ${category.label}`})), analyze: (args, prepared) => { const operation = analyzeToolAction(access, args, prepared); return { ...operation, category: `${method.id}--${operation.category}` }; }, requiredCategories: (args, prepared) => accessRequirements(access, args, prepared).map(id => `${method.id}--${id}`), classify:(args,prepared)=>`${method.id}--${access.classify(args,prepared)}` } };
        }
        const builtin = builtinTemplates(this.registry).find(item=>item.tool.id===saved.tool.id);
        return { executor:methodsExecutor(saved.tool.toolName,saved.tool.description,methods), access:this.access(saved.tool.implementation.configuration), module:builtin?.module || 'project.methods', version:'1.0.0',revision:saved.revision,manifestId:saved.tool.id };
    }
}
