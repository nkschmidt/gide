import { scopeAccess } from '../core/tool-access';
import { constants } from 'fs';
import { open, readFile, realpath } from 'fs/promises';
import { isAbsolute, relative, resolve, sep } from 'path';
import { createHash } from 'crypto';
import { OutputFilter, ToolContext, ToolExecutor } from '../core/contracts';

export class SafeToolError extends Error { constructor(message: string) { super(message); this.name = 'SafeToolError'; } }
export class OutputSizeLimit implements OutputFilter {
    filter(text: string): string {
        if (text.length > 100000) throw new SafeToolError('Content exceeds the 100,000-character limit. Narrow the request.');
        return text;
    }
}
export { DefaultPolicy } from '../core/tool-access';
export const within = (root: string, file: string) => { const path = relative(root, file); return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path); };
export const internalPath = (path: string): boolean => path.split(/[\\/]/).some(part => part === '.git');
export class ReadFilesExecutor implements ToolExecutor {
    readonly access = scopeAccess({ 'registered-repository': 'allow', project: 'ask' }, undefined, ['read']);
    readonly definition = { name: 'files_read', description: 'Read a batch of UTF-8 text files. Always pass paths as an array, including for one file. Use repositories/<id>/file for connected repositories (no approval); project-context files require approval. Prefer batches of related files over separate calls. Up to 20 files, 64 KiB each and 90,000 output characters per batch. Each result contains content or an individual error. No secret detection. Git metadata is excluded.', parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20, description: 'Project-relative file paths. For one file pass a one-element array.' } }, required: ['paths'], additionalProperties: false } };
    private async inspect(args: Record<string, unknown>, context: ToolContext): Promise<{ path: string; digest: string; text: string; scope: string; repository?: string; root: string }> {
        context.signal.throwIfAborted();
        if (Object.keys(args).length !== 1 || typeof args.path !== 'string' || !args.path || args.path.length > 4096 || args.path.includes('\0') || isAbsolute(args.path)) throw new SafeToolError('Use one project-relative file path.');
        const project = await realpath(context.projectPath); const requested = resolve(project, args.path);
        if (!within(project, requested)) throw new SafeToolError('The file is outside this project.');
        // Only explicit repository registrations may cross the project boundary via a link.
        const workspace = JSON.parse(await readFile(resolve(project, 'project.theia-workspace'), 'utf8')) as { governedRepositories?: { id: string; path: string }[] };
        let allowedRoot = project;
        const repository = workspace.governedRepositories?.find(item => /^[a-z0-9][a-z0-9-]*$/i.test(item.id) && within(resolve(project, 'repositories', item.id), requested));
        if (repository) {
            allowedRoot = await realpath(resolve(project, repository.path));
            if (await realpath(resolve(project, 'repositories', repository.id)) !== allowedRoot) throw new SafeToolError('The repository link does not match its registration. Reconnect this repository.');
        }
        const canonical = await realpath(requested);
        if (!within(allowedRoot, canonical)) throw new SafeToolError('This link points outside the allowed project or repository.');
        if (internalPath(`${args.path}/${relative(allowedRoot, canonical)}`)) throw new SafeToolError('Git metadata is excluded from file access.');
        const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > 65536) throw new SafeToolError('Select a regular text file no larger than 64 KiB.');
            const buffer = Buffer.alloc(65537); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            if (bytesRead > 65536 || await realpath(requested) !== canonical) throw new SafeToolError('The file changed while it was being read. Request it again.');
            let text: string;
            try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)); } catch { throw new SafeToolError('The file must contain UTF-8 text.'); }
            if (text.includes('\0')) throw new SafeToolError('Binary content is not allowed.');
            context.signal.throwIfAborted();
            return { path: canonical, digest: createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex'), text, scope: repository ? 'registered-repository' : 'project', repository: repository?.id, root: allowedRoot };
        } finally { await handle.close(); }
    }
    async prepare(args: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>> {
        const paths = this.paths(args);
        if (JSON.stringify({ files: paths.map(path => ({ path, error: 'x'.repeat(300) })) }).length > 90000) throw new SafeToolError('The file list is too large. Request a smaller batch.');
        const files: Record<string, unknown>[] = [];
        for (const path of paths) {
            context.signal.throwIfAborted();
            try {
                const { text, ...file } = await this.inspect({ path }, context);
                if (context.purpose === 'repository-analysis' && file.repository !== context.repository) throw new SafeToolError('Research may read only its own connected repository.');
                files.push({ inputPath: path, ...file });
            }
            catch (error) { context.signal.throwIfAborted(); files.push({ inputPath: path, error: this.errorMessage(error) }); }
        }
        const readable = files.filter(file => !file.error);
        if (!readable.length) throw new SafeToolError(String(files[0].error));
        return { files, scope: readable.every(file => file.scope === 'registered-repository') ? 'registered-repository' : 'project' };
    }
    async execute(args: Record<string, unknown>, prepared: Record<string, unknown>, context: ToolContext): Promise<string> {
        const paths = this.paths(args);
        // Preserve outstanding approvals written by the previous one-file implementation.
        const expected = Array.isArray(prepared.files) ? prepared.files as Record<string, unknown>[] : paths.length === 1 && prepared.path ? [{ inputPath: paths[0], ...prepared }] : [];
        if (paths.length !== expected.length || paths.some((path, index) => path !== expected[index].inputPath)) throw new SafeToolError('The requested file list changed. Request the batch again.');
        const files: { path: string; content?: string; error?: string }[] = [];
        for (let index = 0; index < paths.length; index++) {
            const path = paths[index]; const previous = expected[index]; context.signal.throwIfAborted();
            if (previous.error) { files.push({ path, error: String(previous.error) }); continue; }
            try {
                const file = await this.inspect({ path }, context);
                if (context.purpose === 'repository-analysis' && file.repository !== context.repository) throw new SafeToolError('Research may read only its own connected repository.');
                if (file.path !== previous.path || file.digest !== previous.digest) throw new SafeToolError('The file changed after the read was prepared. Request it again.');
                if (previous.scope !== undefined && (file.scope !== previous.scope || file.root !== previous.root || file.repository !== previous.repository)) throw new SafeToolError('Repository registration changed. Request this file again.');
                const result = { path, content: file.text, digest: file.digest };
                const reservedTail = paths.slice(index + 1).map(path => ({ path, error: 'x'.repeat(300) }));
                if (JSON.stringify({ files: [...files, result, ...reservedTail] }).length > 90000) files.push({ path, error: 'Batch output limit reached. Read this file in a smaller batch.' });
                else files.push(result);
            } catch (error) { context.signal.throwIfAborted(); files.push({ path, error: this.errorMessage(error) }); }
        }
        return JSON.stringify({ files });
    }
    private paths(args: Record<string, unknown>): string[] {
        if (Object.keys(args).length !== 1 || !Array.isArray(args.paths) || args.paths.length < 1 || args.paths.length > 20 || args.paths.some(path => typeof path !== 'string' || !path.trim() || path.length > 4096)) throw new SafeToolError('Pass paths as an array of 1–20 project-relative file paths.');
        return [...new Set((args.paths as string[]).map(path => path.trim()))];
    }
    private errorMessage(error: unknown): string {
        if (error instanceof SafeToolError) return error.message;
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') return 'File or directory not found. List the repository to discover existing paths.';
        if (code === 'EACCES' || code === 'EPERM') return 'The operating system denied access to this file.';
        return 'This file could not be read safely.';
    }
}
