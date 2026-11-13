import { dirname, relative, resolve } from 'path';
import { lstat, realpath } from 'fs/promises';
import { protectedProjectPath } from '../../../common/project-structure';
import { readProjectText } from './project-files';

export async function assertRemovableProjectPath(target: string): Promise<void> {
    if (await isProtectedProjectPath(target, protectedProjectPath)) {
        throw new Error('Project structure is protected. You can edit these files, but cannot delete, rename or move them.');
    }
}

export function isReadOnlyProjectPath(target: string): Promise<boolean> {
    return isProtectedProjectPath(target, path => /^tools[\\/]builtin\.[^\\/]+\.json$/i.test(path));
}

export async function assertWritableProjectPath(target: string): Promise<void> {
    if (await isReadOnlyProjectPath(target)) {
        throw new Error('Built-in tool definitions are read-only. Edit access rules in Tools.');
    }
}

/** Check both the explorer path and the physical path (including aliases into project storage). */
async function isProtectedProjectPath(target: string, isProtected: (path: string) => boolean): Promise<boolean> {
    const lexical = resolve(target);
    const paths = new Set([lexical]);
    try { paths.add(await realpath(lexical)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const path of paths) {
        let parent = path;
        while (true) {
            const workspace = resolve(parent, 'project.theia-workspace');
            try {
                if (isProtected(relative(parent, path)) && (await lstat(workspace)).isFile()) {
                    const config = JSON.parse(await readProjectText(parent, [], 'project.theia-workspace') || '{}');
                    if (Array.isArray(config.folders) && (config.governedProject || Array.isArray(config.governedRepositories))) {
                        return true;
                    }
                }
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error; }
            const next = dirname(parent); if (next === parent) break; parent = next;
        }
    }
    return false;
}
