import { constants } from 'fs';
import { lstat, mkdir, open, realpath, rename, unlink, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { randomUUID } from 'crypto';

export async function projectDirectory(project: string, parts: string[], create = false): Promise<string> {
    let directory = await realpath(project);
    for (const part of parts) {
        if (!/^[a-z0-9._-]+$/i.test(part) || part === '.' || part === '..') throw new Error('Invalid project storage directory.');
        directory = resolve(directory, part);
        try { const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Project configuration must use real directories, not symbolic links.'); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
            try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
            const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Project configuration must use real directories, not symbolic links.');
        }
    }
    return directory;
}
export async function readProjectText(project: string, parts: string[], name: string, limit = 128000): Promise<string | undefined> {
    if (!/^[a-z0-9._-]+$/i.test(name) || name === '.' || name === '..') throw new Error('Invalid configuration file name.');
    try {
        const directory = await projectDirectory(project, parts); const file = await open(resolve(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try { const info = await file.stat(); if (!info.isFile() || info.size > limit) throw new Error('Project configuration exceeds its size limit.'); const buffer = Buffer.alloc(limit + 1); const result = await file.read(buffer, 0, buffer.length, 0); if (result.bytesRead > limit) throw new Error('Project configuration exceeds its size limit.'); return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, result.bytesRead)); }
        finally { await file.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export async function writeProjectText(project: string, parts: string[], name: string, text: string): Promise<void> {
    if (!/^[a-z0-9._-]+$/i.test(name) || name === '.' || name === '..') throw new Error('Invalid configuration file name.');
    const directory = await projectDirectory(project, parts, true); const temporary = resolve(directory, `${randomUUID()}.tmp`);
    try { await writeFile(temporary, text, { flag: 'wx', mode: 0o600 }); await rename(temporary, resolve(directory, name)); }
    finally { await unlink(temporary).catch(() => undefined); }
}
