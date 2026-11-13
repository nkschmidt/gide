import { createHash } from 'crypto';
import { lstat, readFile, readlink, realpath } from 'fs/promises';
import { isAbsolute, resolve } from 'path';
import { ToolContext } from '../core/contracts';
import { SafeToolError, within } from './file-tools';
import { git, gitRoot } from './git-tools';
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
// Hash actual tracked and non-ignored untracked contents, not only Git status letters.
export async function sourceIdentity(repository: string, context: ToolContext, options?: { includeRevision: boolean }): Promise<string> {
    const root = await gitRoot(repository, context);
    const head = await git(root, ['rev-parse', 'HEAD'], context); const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], context);
    const files = (await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate'], context)).split('\0').filter(Boolean).sort();
    if (files.length > 20000) throw new SafeToolError('Repository is too large for bounded source verification. Nothing was run.');
    const hash = createHash('sha256'); if (options?.includeRevision !== false) hash.update(head).update(branch); let bytes = 0;
    for (const file of files) {
        context.signal.throwIfAborted();
        if (isAbsolute(file) || file.split('/').includes('..')) throw new SafeToolError('Invalid source path.');
        const path = resolve(root, file); if (options?.includeRevision !== false) hash.update(JSON.stringify(file));
        try {
            const info = await lstat(path); const canonical = await realpath(path); if (options?.includeRevision === false) hash.update(JSON.stringify(file));
            if (info.isSymbolicLink()) { hash.update('link:' + await readlink(path)); continue; }
            if (!within(root, canonical)) { hash.update('external'); continue; }
            if (!info.isFile()) { hash.update('non-file'); continue; }
            bytes += info.size; if (bytes > 128 * 1024 * 1024) throw new SafeToolError('Repository exceeds the 128 MiB source verification limit. Nothing was run.');
            hash.update(String(info.mode)); hash.update(digest(await readFile(path)));
        } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { if (options?.includeRevision !== false) hash.update('missing'); } else throw error; }
    }
    return hash.digest('hex');
}

