import { ToolContext, ToolExecutor, ToolRegistry } from '../core/contracts';
import { commandFlagAccess, ToolAccess } from '../core/tool-access';
import { DockerConnectionProvider } from '../connections/docker';
import { SafeToolError } from './file-tools';
import { gitRoot, repositoryMutation } from './git-tools';
import { sourceIdentity } from './git-snapshot';
import { runNative } from './native-process';
import { analyzeDockerCommand } from './command-profiles';
import { hasOption, parseArguments } from '../core/command-analysis';

export const dockerMethods = ['connection', 'read', 'build', 'run', 'exec', 'push', 'remove', 'manage'] as const;
type DockerMethod = typeof dockerMethods[number];
export function dockerArguments(value: unknown): string[] {
    if (!Array.isArray(value) || !value.length || value.length > 100 || value.some(arg => typeof arg !== 'string' || arg.length > 8000 || /[\0\r\n]/.test(arg)) || JSON.stringify(value).length > 24000 || !/^[a-z][a-z0-9-]*$/.test(value[0])) throw new SafeToolError('Provide a Docker subcommand and literal arguments. No shell or global connection options.');
    return [...value];
}
/** Unknown commands fail closed. The supplied method can never lower a command's permission. */
export function dockerMethod(args: string[]): DockerMethod {
    return analyzeDockerCommand(args).category as DockerMethod;
}
/** Only explicit container deletion qualifies for the narrow cleanup permission. */
export function containerRemoval(args: string[]): { names: string[]; force: boolean } | undefined {
    const offset = args[0] === 'rm' ? 1 : args[0] === 'container' && ['rm', 'remove'].includes(args[1]) ? 2 : 0;
    if (!offset) return undefined;
    const parsed = parseArguments(args.slice(offset), { options: [{ name: '--force', aliases: ['-f'] }] });
    if (parsed.errors.length || parsed.options.some(option => !option.known) || parsed.operands.some(name => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/.test(name))) return undefined;
    const names = parsed.operands; const force = hasOption(parsed, '--force');
    return names.length > 0 && names.length <= 20 ? { names: [...new Set(names)], force } : undefined;
}
const descriptions: Record<DockerMethod, string> = {
    connection: 'Inspect this computer’s selected Docker CLI and Engine endpoint without contacting the daemon.',
    read: 'Read Docker Engine state, images, containers, ports, process lists, statistics or bounded logs.',
    build: 'Build a Docker image from the registered repository. Build instructions can execute code and use networking.',
    run: 'Create, start, stop or run containers. Mounts, networking and container permissions are part of the exact command review.',
    exec: 'Execute a command inside a container.', push: 'Publish images or export build outputs.',
    remove: 'Remove explicitly named containers after approval; container IDs are verified and pinned before deletion. Removing images, volumes, links or pruning resources uses a separate policy, denied by default. Prefer run --rm for one-shot checks; use unique names for detached verification containers and remove only the task’s own containers.', manage: 'Other Docker operations, including plugins, Compose, authentication and configuration; denied by default.'
};
export class DockerToolMethod implements ToolExecutor {
    readonly definition;
    readonly access: ToolAccess;
    constructor(readonly method: DockerMethod, private readonly connection = new DockerConnectionProvider(), private readonly runner = runNative) {
        this.definition = { name: `docker_${method}`, description: `${descriptions[method]} Uses local Docker context/DOCKER_HOST automatically; never hardcode sockets or ask the user to run a command that this tool can propose. Send full subcommand argv in arguments. Output is bounded and sent to the external model without secret filtering. Commands use normal Docker privileges, not repository isolation. A timeout or Stop ends the CLI; daemon-side builds/containers may continue.`, parameters: method === 'connection' ? { type: 'object', properties: {}, required: [], additionalProperties: false } : { type: 'object', properties: { repository: { type: 'string' }, arguments: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 } }, required: ['repository', 'arguments'], additionalProperties: false } };
        const access: ToolAccess = { analyze: args => { const argv = this.validate(args); const operation = method === 'connection' ? { category: 'execute', effects: ['read'] as const } : analyzeDockerCommand(argv); return { ...operation, category: method === 'remove' && containerRemoval(argv) ? 'containers' : 'execute' }; }, categories: method === 'remove' ? [{ id: 'execute', label: 'Remove other resources, volumes, links or prune data', defaultDecision: 'deny' }, { id: 'containers', label: 'Remove explicitly named containers (including force stop)', defaultDecision: 'ask' }] : [{ id: 'execute', label: descriptions[method], defaultDecision: ['connection', 'read'].includes(method) ? 'allow' : method === 'manage' ? 'deny' : 'ask' }], classify: args => { const argv = this.validate(args); return method === 'remove' && containerRemoval(argv) ? 'containers' : 'execute'; } };
        this.access = method === 'connection' ? access : commandFlagAccess(access);
    }
    available(context: ToolContext): boolean { return context.purpose !== 'repository-analysis'; }
    private validate(args: Record<string, unknown>): string[] {
        if (this.method === 'connection') { if (Object.keys(args).length) throw new SafeToolError('Connection takes no arguments.'); return []; }
        if (Object.keys(args).sort().join(',') !== 'arguments,repository' || typeof args.repository !== 'string') throw new SafeToolError('Pass a registered repository and Docker arguments only.');
        const argv = dockerArguments(args.arguments); this.connection.validateArguments(argv);
        if (dockerMethod(argv) !== this.method) throw new SafeToolError(`This command requires docker.${dockerMethod(argv)}, not docker.${this.method}.`);
        return argv;
    }
    private async inspect(args: Record<string, unknown>, context: ToolContext) {
        const argv = this.validate(args); const connection = await this.connection.resolve(context);
        const root = this.method === 'connection' ? undefined : await gitRoot(args.repository, context);
        const fingerprint = this.method === 'connection' || this.method === 'read' ? undefined : await sourceIdentity(String(args.repository), context);
        const removal = this.method === 'remove' ? containerRemoval(argv) : undefined;
        const containers: { name: string; id: string }[] = [];
        if (removal) {
            for (const name of removal.names) {
                const inspected = await this.runner({ program: connection.program, arguments: [...connection.argumentsPrefix, 'container', 'inspect', '--format', '{{.Id}}', name], cwd: root!, environment: connection.environment, timeoutMs: 10000, outputLimit: 1024 }, context.signal);
                const id = inspected.output.trim();
                if (inspected.state !== 'passed' || inspected.exitCode !== 0 || inspected.truncated || !/^[a-f0-9]{64}$/.test(id)) throw new SafeToolError(`Cannot verify container "${name}" on the selected Docker connection. Nothing was removed.`);
                containers.push({ name, id });
            }
        }
        const executionArguments = removal ? ['container', 'rm', ...(removal.force ? ['--force'] : []), ...containers.map(container => container.id)] : argv;
        return { connection, target: { root, fingerprint, identity: connection.identity, program: connection.program, prefix: connection.argumentsPrefix, endpoint: connection.target, label: connection.label, arguments: argv, executionArguments, containers } };
    }
    async prepare(args: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>> {
        const { connection, target } = await this.inspect(args, context);
        return { scope: 'docker', target, review: { kind: 'docker', method: this.method, repository: args.repository, ...target, timeoutSeconds: this.timeout / 1000, outputLimit: 12000, warning: connection.warning + ' Output is returned to the external model without secret filtering. Stopping the CLI does not guarantee cancellation of daemon-side work.' } };
    }
    private get timeout(): number { return ['build', 'push'].includes(this.method) ? 600000 : this.method === 'read' ? 30000 : 120000; }
    async execute(args: Record<string, unknown>, prepared: Record<string, unknown>, context: ToolContext): Promise<string> {
        const perform = async () => {
            const { connection, target } = await this.inspect(args, context);
            if (JSON.stringify(target) !== JSON.stringify(prepared.target)) throw new SafeToolError('Docker connection, executable, container identity or repository source changed after review. Request the action again.');
            if (this.method === 'connection') return JSON.stringify({ connection: connection.label, endpoint: connection.target, program: connection.program });
            const result = await this.runner({ program: connection.program, arguments: [...connection.argumentsPrefix, ...target.executionArguments], cwd: target.root!, environment: connection.environment, timeoutMs: this.timeout, outputLimit: 12000 }, context.signal);
            const sourceChanged = target.fingerprint !== undefined && target.fingerprint !== await sourceIdentity(String(args.repository), context);
            return JSON.stringify({ repository: args.repository, method: this.method, arguments: target.arguments, executedArguments: target.executionArguments, containers: target.containers, connection: connection.label, endpoint: connection.target, ...result, sourceChanged });
        };
        return this.method === 'connection' ? perform() : repositoryMutation(args.repository, context, perform);
    }
}
export function registerDockerTools(registry: ToolRegistry): void { for (const method of dockerMethods) registry.register(new DockerToolMethod(method)); }
