import { mkdir } from 'fs/promises';
import { isAbsolute, join } from 'path';
import { createHash } from 'crypto';
import { LocalProcessConfiguration, ProjectTool, ToolPlan, ToolJob } from '../../../common/project-tool-service';
import { ExecutionAdapter, ExecutionObserver, ExecutionResult } from '../core/execution';
import { ToolContext } from '../core/contracts';
import { SafeToolError } from '../modules/file-tools';
import { nativeExecutable, runNative } from '../modules/native-process';
import { resolveRepositoryTarget } from '../modules/repository-tools';
import { sourceIdentity } from '../modules/git-snapshot';
export function validateLocalProcess(value: unknown): LocalProcessConfiguration {
    const c = value as LocalProcessConfiguration; const keys = ['directory', 'program', 'arguments', 'environment', 'timeoutSeconds', 'outputLimit'];
    if (!c || typeof c !== 'object' || Object.keys(c).some(key => !keys.includes(key)) || keys.some(key => !(key in c))) throw new SafeToolError('Local process configuration must contain exactly the documented fields.');
    if (typeof c.directory !== 'string' || !c.directory || isAbsolute(c.directory) || c.directory.includes('\\') || c.directory.includes('\0') || c.directory.split('/').includes('..')) throw new SafeToolError('Directory must be relative to the connected repository.');
    if (typeof c.program !== 'string' || !c.program || c.program.length > 4096 || /[\0\r\n]/.test(c.program) || (!isAbsolute(c.program) && /[\\/]/.test(c.program))) throw new SafeToolError('Program must be a PATH executable name or an absolute executable path.');
    if (!Array.isArray(c.arguments) || c.arguments.length > 100 || c.arguments.some(arg => typeof arg !== 'string' || arg.length > 8000 || arg.includes('\0'))) throw new SafeToolError('Arguments must be a bounded array of strings.');
    if (c.environment !== 'local' || !Number.isInteger(c.timeoutSeconds) || c.timeoutSeconds < 1 || c.timeoutSeconds > 1800 || !Number.isInteger(c.outputLimit) || c.outputLimit < 1024 || c.outputLimit > 262144) throw new SafeToolError('Use local execution, a timeout of 1–1800 seconds and an output limit of 1024–262144 bytes.');
    return { directory: c.directory, program: c.program, arguments: [...c.arguments], environment: 'local', timeoutSeconds: c.timeoutSeconds, outputLimit: c.outputLimit };
}
export class LocalProcessExecutor implements ExecutionAdapter {
    readonly id = 'local-process';
    readonly inputSchema = { type: 'object', properties: { repository: { type: 'string', description: 'Connected repository ID. Use repositories.list to find the available repositories.' } }, required: ['repository'], additionalProperties: false };
    readonly configurationSchema = { type: 'object', properties: { directory: { type: 'string' }, program: { type: 'string' }, arguments: { type: 'array', items: { type: 'string' } }, environment: { type: 'string', enum: ['local'] }, timeoutSeconds: { type: 'integer' }, outputLimit: { type: 'integer' } }, required: ['directory', 'program', 'arguments', 'environment', 'timeoutSeconds', 'outputLimit'], additionalProperties: false };
    constructor(private readonly home: string) { }
    validate(configuration: unknown): Record<string, unknown> { return { ...validateLocalProcess(configuration) }; }
    async validateProject(tool: ProjectTool): Promise<void> { validateLocalProcess(tool.implementation.configuration); }
    private environment(): NodeJS.ProcessEnv {
        return { ...Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP', ...(process.platform === 'win32' ? ['SystemRoot', 'WINDIR', 'PATHEXT'] : [])].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])), HOME: this.home, USERPROFILE: this.home, XDG_CACHE_HOME: join(this.home, '.cache') };
    }
    async prepare(tool: ProjectTool, context: ToolContext, inputs: Record<string, unknown> = {}) {
        const c = validateLocalProcess(tool.implementation.configuration);
        if (Object.keys(inputs).length !== 1 || typeof inputs.repository !== 'string') throw new SafeToolError('Choose a connected repository for this run.');
        const target = await resolveRepositoryTarget({ repository: inputs.repository, path: c.directory, offset: 0 }, context);
        let executable; try { executable = await nativeExecutable(c.program); } catch { throw new SafeToolError(`Program "${c.program}" is not available as a native executable. Nothing was run or installed. On Windows use an .exe or Node with the package manager's JavaScript entry point.`); }
        const env = this.environment();
        return { binding: { repository: target.id, root: target.root, cwd: target.directory, executable: executable.path, executableDigest: executable.digest, source: await sourceIdentity(target.id, context), environmentDigest: createHash('sha256').update(JSON.stringify(env)).digest('hex') }, review: { fields: [
            { label: 'Executor', value: 'Local process' }, { label: 'Repository', value: target.id }, { label: 'Working folder', value: target.directory }, { label: 'Executable', value: executable.path }, { label: 'Arguments', value: JSON.stringify(c.arguments) }, { label: 'Limits', value: `${c.timeoutSeconds}s · ${c.outputLimit} bytes` }, { label: 'Environment', value: Object.keys(env).sort().join(', ') }
        ], warning: 'Runs with your user permissions. Working folder selection does not restrict filesystem or network access. Uses an application-specific home/cache; your usual tool credentials and settings are not automatically inherited.' } };
    }
    resourceKey(plan: ToolPlan): string { return String(plan.binding.root); }
    outputLimit(plan: ToolPlan): number { return validateLocalProcess(plan.tool.implementation.configuration).outputLimit; }
    async matchesCurrentSource(job: ToolJob, context: ToolContext): Promise<boolean> { const repository = job.inputs?.repository; return typeof repository === 'string' && !job.sourceChanged && job.sourceAfter === await sourceIdentity(repository, context); }
    async execute(plan: ToolPlan, context: ToolContext, observer: ExecutionObserver): Promise<ExecutionResult> {
        const c = validateLocalProcess(plan.tool.implementation.configuration); await mkdir(this.home, { recursive: true, mode: 0o700 }); context.signal.throwIfAborted();
        try {
            const result = await runNative({ program: String(plan.binding.executable), arguments: c.arguments, cwd: String(plan.binding.cwd), environment: this.environment(), timeoutMs: c.timeoutSeconds * 1000, outputLimit: c.outputLimit, onOutput: observer.output, onStopping: observer.stopping }, context.signal);
            const { output, truncated, ...metadata } = result;
            try { const sourceAfter = await sourceIdentity(String(plan.binding.repository), { ...context, signal: AbortSignal.timeout(30000) }); return { ...metadata, sourceAfter, sourceChanged: plan.binding.source !== sourceAfter }; }
            catch { return { ...metadata, sourceChanged: true, error: 'Source identity could not be verified after execution.' }; }
        } catch (error) { return { state: context.signal.aborted ? 'cancelled' : 'failed', error: `Process could not start: ${(error as NodeJS.ErrnoException).code || 'unknown error'}` }; }
    }
}
