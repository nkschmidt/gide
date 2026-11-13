import { constants } from 'fs';
import { lstat, mkdir, open, realpath } from 'fs/promises';
import { createHash } from 'crypto';
import { resolve } from 'path';
import { repositoryFilePath } from './changesets';
import { SafeToolError, within } from './file-tools';

export async function fileState(root: string, path: string, createParents = false): Promise<{ digest: string | null; mode: number; parent: string; parentIdentity: string; content?: string }> {
    const parts = repositoryFilePath(path).split('/'); let parent = root;
    for (const part of parts.slice(0, -1)) {
        parent = resolve(parent, part);
        try { const entry = await lstat(parent); if (!entry.isDirectory() || entry.isSymbolicLink() || !within(root, await realpath(parent))) throw new SafeToolError('Repository edit paths must use real directories inside this repository.'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !createParents) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { digest: null, mode: 0o644, parent, parentIdentity: 'missing' }; throw error; } await mkdir(parent); }
    }
    const directory = await lstat(parent); const parentIdentity = `${directory.dev}:${directory.ino}`;
    const file = resolve(root, path);
    try {
        const entry = await lstat(file); if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > 131072 || !within(root, await realpath(file))) throw new SafeToolError('Edit only regular non-linked UTF-8 files up to 128 KiB.');
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try { const info = await handle.stat(); if (!info.isFile() || info.nlink !== 1 || info.size > 131072) throw new SafeToolError('The file changed during inspection.'); const buffer = Buffer.alloc(131073); const read = await handle.read(buffer, 0, buffer.length, 0); if (read.bytesRead > 131072) throw new SafeToolError('File is too large.'); const bytes = buffer.subarray(0, read.bytesRead); const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); if (text.includes('\0')) throw new SafeToolError('Binary edits are unavailable.'); return { digest: createHash('sha256').update(bytes).digest('hex'), mode: info.mode & 0o777, parent, parentIdentity, content: text }; }
        finally { await handle.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { digest: null, mode: 0o644, parent, parentIdentity }; throw error; }
}
