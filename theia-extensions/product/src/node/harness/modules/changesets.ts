import { createHash } from 'crypto';
import { readdir } from 'fs/promises';
import { readProjectText, writeProjectText } from '../storage/project-files';
import { projectMutations } from '../storage/mutation-queue';
import { SafeToolError } from './file-tools';
import { changesetDirectory } from '../storage/changeset-directory';
export const hashText = (text: string) => createHash('sha256').update(text).digest('hex');
const notesMarker = '\n<!-- governed-execution-notes -->\n';
export interface ChangeScope { repository: string; paths: string[]; baseBranch?: string; }
export function repositoryFilePath(value: unknown): string {
    if (typeof value !== 'string' || !value || value.length > 512 || value.startsWith('/') || value.includes('\\') || value.includes('\0') || value.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git') || /^[a-z]:/i.test(value)) throw new SafeToolError('Use a file path inside the registered repository, without links, traversal or Git metadata.');
    return value;
}
export class ChangeSetStore {
    name(value: unknown): string { if (typeof value !== 'string' || !/^[a-z0-9_][a-z0-9._-]{0,99}\.md$/i.test(value) || value.includes('..')) throw new SafeToolError('Use a ChangeSet Markdown filename, without directory components.'); return value; }
    scope(value: unknown): ChangeScope[] {
        if (!Array.isArray(value) || value.length > 20) throw new SafeToolError('Specify up to 20 affected repositories.');
        return value.map(item => { if (!item || typeof item.repository !== 'string' || !/^[a-z0-9][a-z0-9-]*$/i.test(item.repository) || !Array.isArray(item.paths) || item.paths.length > 100 || (item.baseBranch !== undefined && (typeof item.baseBranch !== 'string' || item.baseBranch.length > 100 || (item.baseBranch && !/^[a-z0-9][a-z0-9._/-]*$/i.test(item.baseBranch)) || item.baseBranch.includes('..')))) throw new SafeToolError('Specify repository IDs, exact file paths and an optional agreed base branch.'); return { repository: item.repository, paths: [...new Set<string>(item.paths.map(repositoryFilePath))], ...(item.baseBranch ? { baseBranch: item.baseBranch } : {}) }; });
    }
    async read(project: string, name: unknown): Promise<{ path: string; digest: string; planDigest: string; body: string; plan: string; executionNotes: string; scope: ChangeScope[] }> {
        await changesetDirectory(project);
        const file = this.name(name); const text = await readProjectText(project, ['changesets'], file, 64000);
        if (text === undefined) throw new SafeToolError('ChangeSet not found.');
        const first = text.split('\n', 1)[0]; const metadata = first.startsWith('<!-- governed-scope: ') && first.endsWith(' -->') ? JSON.parse(first.slice('<!-- governed-scope: '.length, -4)) : undefined;
        const parts = text.split(notesMarker); const plan = metadata ? parts[0].slice(first.length).trimStart() : parts[0];
        return { path: `changesets/${file}`, digest: hashText(text), planDigest: hashText(parts[0]), body: text, plan, executionNotes: parts[1] || '', scope: metadata ? this.scope(metadata) : [] };
    }
    async list(project: string): Promise<{ name: string }[]> { const directory = await changesetDirectory(project); return (await readdir(directory, { withFileTypes: true })).filter(item => item.isFile() && /^[a-z0-9_][a-z0-9._-]{0,99}\.md$/i.test(item.name) && !item.name.includes('..')).slice(0, 200).map(item => ({ name: item.name })); }
    async write(project: string, name: unknown, body: unknown, scope: unknown, expectedDigest: unknown): Promise<{ path: string; digest: string; scope: ChangeScope[] }> {
        const file = this.name(name); const targets = this.scope(scope);
        if (typeof body !== 'string' || !body.trim() || body.includes(notesMarker.trim()) || body.includes('<!-- governed-scope:') || Buffer.byteLength(body) > 25000 || (expectedDigest !== null && (typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest)))) throw new SafeToolError('Provide Markdown plan content only (up to 25,000 bytes), without generated scope headers or execution notes. For updates use the plan field from changeset_read and its full digest.');
        return projectMutations.run(project, async () => {
            await changesetDirectory(project);
            const previous = await readProjectText(project, ['changesets'], file, 64000);
            if ((previous === undefined ? null : hashText(previous)) !== expectedDigest) throw new SafeToolError('ChangeSet changed. Read the current document before updating it.');
            const text = `<!-- governed-scope: ${JSON.stringify(targets)} -->\n\n${body}`;
            if (Buffer.byteLength(text) > 30000) throw new SafeToolError('The scoped ChangeSet exceeds 30,000 bytes. Narrow the file list or summarize the plan.');
            await writeProjectText(project, ['changesets'], file, text);
            return { path: `changesets/${file}`, digest: hashText(text), scope: targets };
        });
    }
    async notes(project: string, name: unknown, notes: unknown, expectedDigest: unknown): Promise<{ path: string; digest: string; planDigest: string }> {
        if (typeof notes !== 'string' || Buffer.byteLength(notes) > 10000 || notes.includes(notesMarker.trim())) throw new SafeToolError('Use at most 10,000 bytes of execution notes.');
        return projectMutations.run(project, async () => {
            const previous = await this.read(project, name); if (previous.digest !== expectedDigest) throw new SafeToolError('ChangeSet changed. Read it again.');
            const text = previous.body.split(notesMarker)[0] + notesMarker + '\n## Execution notes\n\n' + notes;
            await writeProjectText(project, ['changesets'], this.name(name), text);
            return { path: previous.path, digest: hashText(text), planDigest: previous.planDigest };
        });
    }
}
