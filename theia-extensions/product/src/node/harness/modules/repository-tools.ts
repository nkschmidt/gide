import { searchWithRipgrep, SearchFile } from './ripgrep-search';
import { scopeAccess } from '../core/tool-access';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { lstat, readFile, realpath, stat } from 'fs/promises';
import { isAbsolute, relative, resolve } from 'path';
import { ToolContext, ToolDefinition, ToolExecutor, ToolRegistry } from '../core/contracts';
import { internalPath, SafeToolError, within } from './file-tools';

const exec = promisify(execFile);
const ignored = (path: string) => internalPath(path) || path.split('/').some(part => ['node_modules', 'vendor', 'dist', 'build', 'target', 'coverage', '.cache', '.venv', '__pycache__'].includes(part));
interface Repository { id: string; path: string; source?: string; }
function subpath(value: unknown): string {
    if (typeof value !== 'string' || !value || value.length > 4096 || isAbsolute(value) || value.includes('\\') || value.includes('\0') || value.split('/').includes('..')) throw new SafeToolError('Use a repository-relative path without parent traversal. Use "." for the repository root.');
    return value.split('/').filter(part => part && part !== '.').join('/');
}
function validate(args: Record<string, unknown>, keys: string[], optional: string[] = []): void {
    if (Object.keys(args).some(key => !keys.includes(key) && !optional.includes(key)) || keys.some(key => !(key in args))) throw new SafeToolError('Invalid repository tool parameters.');
}
async function repositories(context: ToolContext): Promise<Repository[]> {
    context.signal.throwIfAborted();
    const workspace = JSON.parse(await readFile(resolve(context.projectPath, 'project.theia-workspace'), 'utf8')) as { governedRepositories?: Repository[] };
    if (!Array.isArray(workspace.governedRepositories)) return [];
    return workspace.governedRepositories.filter(item => item && /^[a-z0-9][a-z0-9-]*$/i.test(item.id) && typeof item.path === 'string');
}
async function target(args: Record<string, unknown>, context: ToolContext): Promise<{ root: string; directory: string; id: string; path: string }> {
    if (context.purpose === 'repository-analysis' && context.repository !== args.repository) throw new SafeToolError('Research may inspect only its own connected repository.');
    if (typeof args.repository !== 'string') throw new SafeToolError('Choose a connected repository by its ID.');
    const entry = (await repositories(context)).find(item => item.id === args.repository);
    if (!entry) throw new SafeToolError('Repository is not connected. Use repositories_list to get the available repository IDs.');
    const root = await realpath(resolve(context.projectPath, entry.path));
    if (await realpath(resolve(context.projectPath, 'repositories', entry.id)) !== root) throw new SafeToolError('The repository link does not match its registration. Reconnect this repository.');
    const path = subpath(args.path);
    if (ignored(path)) throw new SafeToolError('This directory is excluded by repository policy.');
    const directory = await realpath(resolve(root, path));
    if (!within(root, directory) || ignored(relative(root, directory))) throw new SafeToolError('This directory is outside the allowed repository or is excluded by policy.');
    if (!(await stat(directory)).isDirectory()) throw new SafeToolError('The requested path is not a directory.');
    if (!Number.isInteger(args.offset) || Number(args.offset) < 0 || Number(args.offset) > 10000) throw new SafeToolError('Offset must be an integer between 0 and 10000.');
    return { root, directory, id: entry.id, path };
}
async function inventory(root: string, path: string, context: ToolContext): Promise<string[]> {
    context.signal.throwIfAborted();
    try {
        const result = await exec('git', ['--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate', '--', path || '.'], { timeout: 10000, maxBuffer: 8 * 1024 * 1024, signal: context.signal });
        const entries = result.stdout.split('\0').filter(file => file && !isAbsolute(file) && !file.split('/').includes('..') && !ignored(file) && (!path || file.startsWith(`${path}/`)));
        return [...new Set(entries)].sort();
    } catch {
        context.signal.throwIfAborted(); throw new SafeToolError('Cannot list this Git repository within the size/time limit. Verify that Git is available and narrow the directory path for large repositories.');
    }
}
async function safePath(root: string, file: string): Promise<string | undefined> {
    try {
        const requested = resolve(root, file);
        if ((await lstat(requested)).isSymbolicLink()) return undefined;
        const canonical = await realpath(requested);
        if (!within(root, canonical) || ignored(relative(root, canonical))) return undefined;
        return canonical;
    } catch { return undefined; }
}
const baseProperties = {
    repository: { type: 'string', description: 'Connected repository ID, obtained from repositories_list.' },
    path: { type: 'string', description: 'Directory relative to the repository root. Use "." for the root.' },
    offset: { type: 'integer', minimum: 0, maximum: 10000, description: 'Pagination offset. Start at 0; use nextOffset to continue.' }
};

export class ListRepositoriesExecutor implements ToolExecutor {
    readonly access = scopeAccess({ 'registered-repository': 'allow' }, undefined, ['read']);
    readonly definition = { name: 'repositories_list', description: 'List repositories registered in the current project. Returns IDs and project-relative paths, never remote credentials or absolute checkout paths. No approval required.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } };
    async prepare(args: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>> { validate(args, []); await repositories(context); return { scope: 'registered-repository' }; }
    async execute(args: Record<string, unknown>, _prepared: Record<string, unknown>, context: ToolContext): Promise<string> {
        validate(args, []); return JSON.stringify({ repositories: (await repositories(context)).map(item => ({ id: item.id, path: `repositories/${item.id}`, source: item.source === 'remote' ? 'remote' : 'local' })) });
    }
}
abstract class RepositoryExecutor implements ToolExecutor {
    readonly access = scopeAccess({ 'registered-repository': 'allow' }, undefined, ['read']);
    abstract readonly definition: ToolDefinition;
    protected abstract readonly keys: string[];
    protected readonly optionalKeys: string[] = [];
    async prepare(args: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>> {
        validate(args, this.keys, this.optionalKeys); const item = await target(args, context); return { scope: 'registered-repository', root: item.root };
    }
    protected async files(args: Record<string, unknown>, prepared: Record<string, unknown>, context: ToolContext): Promise<{ root: string; id: string; path: string; files: string[] }> {
        validate(args, this.keys, this.optionalKeys); const item = await target(args, context);
        if (prepared.scope !== 'registered-repository' || prepared.root !== item.root) throw new SafeToolError('Repository registration changed. Request the operation again.');
        return { ...item, files: await inventory(item.root, item.path, context) };
    }
    abstract execute(args: Record<string, unknown>, prepared: Record<string, unknown>, context: ToolContext): Promise<string>;
}
export class ListRepositoryExecutor extends RepositoryExecutor {
    protected readonly keys = ['repository', 'path', 'offset'];
    readonly definition = { name: 'repository_list', description: 'List immediate files and directories of a connected Git repository. Respects Git ignores for untracked files and excludes Git metadata, generated folders and unsafe links. No secret filename filtering. Empty directories are not listed. No approval required. Pages contain up to 200 entries.', parameters: { type: 'object', properties: baseProperties, required: this.keys, additionalProperties: false } };
    async execute(args: Record<string, unknown>, prepared: Record<string, unknown>, context: ToolContext): Promise<string> {
        const item = await this.files(args, prepared, context); const entries = new Map<string, { name: string; type: string; path: string }>();
        let examined = 0;
        for (const file of item.files) {
            context.signal.throwIfAborted();
            const remainder = item.path ? file.slice(item.path.length + 1) : file; const name = remainder.split('/')[0];
            if (!name || entries.has(name)) continue;
            const child = item.path ? `${item.path}/${name}` : name;
            if (++examined > 20000) break;
            if (!await safePath(item.root, child)) continue;
            entries.set(name, { name, type: remainder.includes('/') ? 'directory' : 'file', path: `repositories/${item.id}/${child}` });
        }
        const all = [...entries.values()].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)); const offset = Number(args.offset);
        return JSON.stringify({ repository: item.id, path: item.path || '.', entries: all.slice(offset, offset + 200), nextOffset: offset + 200 < all.length ? offset + 200 : null, inventoryLimited: examined > 20000 });
    }
}
export class SearchRepositoryExecutor extends RepositoryExecutor {
    protected readonly keys = ['repository', 'path', 'offset', 'query', 'mode'];
    protected readonly optionalKeys = ['fileOffset'];
    readonly definition = { name: 'repository_search', description: 'Find literal occurrences in UTF-8 source files with mode content: returns repository-relative paths, line numbers and short matching excerpts. Use this before reading whole files to locate implementations and usages. Mode paths searches filenames. Case-insensitive, powered by the bundled cross-platform ripgrep binary; no shell or separate installation required. Search is restricted to connected repositories and is allowed without approval. Excludes ignored/generated files, Git metadata, binaries and unsafe links; no secret redaction. Up to 100 matches/85,000 excerpt characters, 1000 files and 4 MiB per call, 2 MiB per file. For nextOffset repeat with that match offset and the SAME fileOffset; once exhausted use nextFileOffset with offset 0. Narrow path for focused searches.', parameters: { type: 'object', properties: { ...baseProperties, query: { type: 'string', minLength: 1, maxLength: 200 }, mode: { type: 'string', enum: ['paths', 'content'] }, fileOffset: { type: 'integer', minimum: 0, maximum: 1000000, description: 'Optional scan position, default 0. Use nextFileOffset to continue beyond a scan limit, with offset 0.' } }, required: this.keys, additionalProperties: false } };
    private searchArgs(args: Record<string, unknown>): void {
        if (typeof args.query !== 'string' || !args.query.trim() || /[\r\n\0]/.test(args.query) || args.query.length > 200 || !['paths', 'content'].includes(String(args.mode))) throw new SafeToolError('Choose paths or content search and enter a literal query of 1–200 characters.');
        if (args.fileOffset !== undefined && (!Number.isInteger(args.fileOffset) || Number(args.fileOffset) < 0 || Number(args.fileOffset) > 1000000)) throw new SafeToolError('File offset must be an integer between 0 and 1000000.');
    }
    async prepare(args: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>> {
        this.searchArgs(args);
        return super.prepare(args, context);
    }
    async execute(args: Record<string, unknown>, prepared: Record<string, unknown>, context: ToolContext): Promise<string> {
        // Repeat validation at execution; a prepared target does not authorize changed parameters.
        this.searchArgs(args);
        const item = await this.files(args, prepared, context); const query = String(args.query).toLowerCase(); const offset = Number(args.offset); const fileOffset = Number(args.fileOffset || 0);
        const matches: { path: string; line?: number; text?: string }[] = []; const candidates: SearchFile[] = [];
        let count = 0; let scanned = 0; let bytes = 0; let scanLimited = false; let hasMore = false; let index = fileOffset; let skippedFiles = 0;
        const deadline = Date.now() + 5000;
        for (; index < item.files.length; index++) {
            const file = item.files[index]; context.signal.throwIfAborted();
            if (hasMore) break;
            if (scanned >= 1000 || bytes >= 4 * 1024 * 1024 || Date.now() > deadline) { scanLimited = true; break; }
            scanned++;
            if (args.mode === 'paths' && !file.toLowerCase().includes(query)) continue;
            const canonical = await safePath(item.root, file); if (!canonical) { skippedFiles++; continue; }
            const resultPath = `repositories/${item.id}/${file}`;
            if (args.mode === 'paths') { if (count++ >= offset) { if (matches.length >= 100) hasMore = true; else matches.push({ path: resultPath }); } continue; }
            try {
                const info = await stat(canonical); if (!info.isFile() || info.size > 2 * 1024 * 1024) { skippedFiles++; continue; }
                if (bytes + info.size > 4 * 1024 * 1024) { scanLimited = true; break; }
                bytes += info.size; candidates.push({ canonical, path: resultPath });
            } catch { context.signal.throwIfAborted(); skippedFiles++; }
        }
        if (args.mode === 'content') {
            const result = await searchWithRipgrep(item.root, candidates, String(args.query), offset, context.signal); hasMore = result.hasMore;
            for (const match of result.matches) {
                const candidate = candidates.find(file => file.path === match.path)!;
                const file = match.path.slice(`repositories/${item.id}/`.length);
                if (await safePath(item.root, file) === candidate.canonical) matches.push(match); else skippedFiles++;
            }
        }
        return JSON.stringify({ repository: item.id, query: args.query, mode: args.mode, matches, nextOffset: hasMore ? offset + matches.length : null, fileOffset, nextFileOffset: scanLimited && !hasMore ? index : null, scanLimited, scannedFiles: scanned, skippedFiles, executor: args.mode === 'content' ? 'ripgrep' : 'inventory' });
    }
}
export function registerRepositoryTools(registry: ToolRegistry): void {
    registry.register(new ListRepositoriesExecutor()); registry.register(new ListRepositoryExecutor()); registry.register(new SearchRepositoryExecutor());
}
export { target as resolveRepositoryTarget };
