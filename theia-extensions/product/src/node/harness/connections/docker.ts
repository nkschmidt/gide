import { governedDataDirectory } from '../../data-directory';
import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { posix, win32 } from 'path';
import { createHash } from 'crypto';
import { ToolContext } from '../core/contracts';
import { nativeExecutable } from '../modules/native-process';
import { SafeToolError } from '../modules/file-tools';
import { parseDockerArguments } from '../modules/command-profiles';

export interface DockerConnection { id: string; label: string; target: string; identity: string; program: string; argumentsPrefix: string[]; environment: NodeJS.ProcessEnv; warning: string; }
export interface DockerMachineSettings { schemaVersion: 1; program?: string; context?: string; host?: string; configDirectory?: string; }
export interface DockerConnectionHost {
    platform: string; home: string; env: NodeJS.ProcessEnv;
    settings(): Promise<unknown>;
    executable(name: string): Promise<{ path: string; digest: string }>;
    inspect(program: string, arguments_: string[], environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string>;
}
const systemHost = (): DockerConnectionHost => ({
    platform: process.platform, home: homedir(), env: process.env, executable: nativeExecutable,
    settings: async () => { try { return JSON.parse(await readFile(governedDataDirectory('connections', 'docker.json'), 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1 }; throw new SafeToolError('Cannot read this computer’s Docker connection settings.'); } },
    inspect: (program, args, env, signal) => new Promise((resolve, reject) => execFile(program, args, { env, signal, timeout: 10000, maxBuffer: 262144, windowsHide: true, encoding: 'utf8' }, (error, stdout) => error ? reject(new SafeToolError('Cannot inspect the selected Docker context. Check this computer’s Docker CLI and context settings.')) : resolve(stdout)))
});
function settings(value: unknown): DockerMachineSettings {
    const c = value as DockerMachineSettings;
    if (!c || c.schemaVersion !== 1 || Object.keys(c).some(key => !['schemaVersion', 'program', 'context', 'host', 'configDirectory'].includes(key)) || ['program', 'context', 'host', 'configDirectory'].some(key => c[key as keyof DockerMachineSettings] !== undefined && (typeof c[key as keyof DockerMachineSettings] !== 'string' || !String(c[key as keyof DockerMachineSettings]).trim() || /[\0\r\n]/.test(String(c[key as keyof DockerMachineSettings])))) || (c.context && c.host)) throw new SafeToolError('Docker machine settings require schemaVersion 1 and optional program, context OR host, and configDirectory.');
    return c;
}
export class DockerConnectionProvider {
    readonly id = 'docker';
    readonly description = 'docker: Uses this computer’s Docker CLI and selected context or DOCKER_HOST. Provide Docker subcommand arguments only. Endpoint, config paths and authentication are resolved locally; do not hardcode socket paths or connection flags in project commands.';
    constructor(private readonly machine: DockerConnectionHost = systemHost()) { }
    validateArguments(args: string[]): void {
        const overrides = ['--host', '--context', '--config', '--tls', '--tlsverify', '--tlscacert', '--tlscert', '--tlskey'];
        if (parseDockerArguments(args).options.some(option => overrides.includes(option.name))) throw new SafeToolError('Docker connection overrides belong in this computer’s connection settings, not project command arguments.');
    }
    async resolve(context: ToolContext): Promise<DockerConnection> {
        context.signal.throwIfAborted(); const machine = this.machine; const configuration = settings(await machine.settings()); const paths = machine.platform === 'win32' ? win32 : posix;
        const candidates = configuration.program ? [configuration.program] : ['docker', ...(machine.platform === 'darwin' ? ['/Applications/Docker.app/Contents/Resources/bin/docker'] : machine.platform === 'win32' && machine.env.ProgramFiles ? [win32.join(machine.env.ProgramFiles, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe')] : [])];
        let executable: { path: string; digest: string } | undefined;
        for (const candidate of candidates) { try { executable = await machine.executable(candidate); break; } catch { /* Next native installation location. */ } }
        if (!executable) throw new SafeToolError('Docker CLI is not installed or could not be found on this computer. Configure its path in connections/docker.json. Nothing was installed or run.');
        const allowed = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_API_VERSION', 'DOCKER_BUILDKIT', 'BUILDX_BUILDER', 'SSH_AUTH_SOCK', ...(machine.platform === 'win32' ? ['SystemRoot', 'WINDIR', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA'] : [])];
        const environment: NodeJS.ProcessEnv = { ...Object.fromEntries(allowed.filter(key => machine.env[key] !== undefined).map(key => [key, machine.env[key]])), HOME: machine.home, USERPROFILE: machine.home };
        const configDirectory = configuration.configDirectory || environment.DOCKER_CONFIG || paths.join(machine.home, '.docker');
        if (!paths.isAbsolute(configDirectory)) throw new SafeToolError('Docker configDirectory must be an absolute path on this computer.');
        environment.DOCKER_CONFIG = configDirectory;
        const selectedContext = configuration.context || (configuration.host ? undefined : environment.DOCKER_CONTEXT);
        const selectedHost = configuration.host || (!selectedContext ? environment.DOCKER_HOST : undefined);
        const prefix = ['--config', configDirectory]; let target: string; let label: string; let metadata = '';
        if (selectedHost) { target = selectedHost; label = 'Docker host'; prefix.push('--host', target); }
        else {
            const name = selectedContext || (await machine.inspect(executable.path, [...prefix, 'context', 'show'], environment, context.signal)).trim();
            if (!name || name.length > 256 || /[\0\r\n]/.test(name)) throw new SafeToolError('Docker did not provide a valid current context.');
            try {
                metadata = await machine.inspect(executable.path, [...prefix, 'context', 'inspect', name], environment, context.signal);
                const parsed = JSON.parse(metadata); target = parsed?.[0]?.Endpoints?.docker?.Host;
            } catch (error) { if (error instanceof SafeToolError) throw error; throw new SafeToolError('Docker context metadata is invalid.'); }
            label = `Docker context: ${name}`; prefix.push('--context', name);
        }
        if (typeof target !== 'string' || !/^(unix|npipe|tcp|ssh):\/\//i.test(target) || /[\0\r\n]/.test(target)) throw new SafeToolError('The selected context does not expose a supported Docker Engine endpoint.');
        try { if (new URL(target).password) throw new Error('password'); } catch { throw new SafeToolError('Docker endpoint must be a valid connection URI without an embedded password.'); }
        // The reviewed explicit prefix pins selection, even if another CLI changes the current context later.
        delete environment.DOCKER_CONTEXT; delete environment.DOCKER_HOST;
        const identity = createHash('sha256').update(JSON.stringify({ executable, prefix, environment, metadata, target })).digest('hex');
        return { id: this.id, label, target, identity, program: executable.path, argumentsPrefix: prefix, environment, warning: 'Uses this computer’s selected Docker connection, Docker configuration and existing authentication. Runs with your user permissions; repository selection is not filesystem or network isolation.' };
    }
}
