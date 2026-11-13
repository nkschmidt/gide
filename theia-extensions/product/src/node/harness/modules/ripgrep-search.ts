import { rgPath } from '@vscode/ripgrep';
import { StringDecoder } from 'string_decoder';
import { normalize } from 'path';
import { SafeToolError } from './file-tools';
import { runNative } from './native-process';

export interface SearchFile { canonical: string; path: string; }
export interface SearchMatch { path: string; line: number; text: string; }
/** Use the platform binary bundled by Theia. Paths/flags are assembled by this adapter, not the model. */
export async function searchWithRipgrep(root: string, files: SearchFile[], query: string, offset: number, signal: AbortSignal): Promise<{ matches: SearchMatch[]; hasMore: boolean }> {
    const deadline = Date.now() + 10000;
    const matches: SearchMatch[] = []; let count = 0; let outputSize = 0; let hasMore = false;
    const environment = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    // Keep each argv well below Windows' command-line limit, including UTF-16 quoting overhead.
    for (let start = 0; start < files.length && !hasMore;) {
        if (Date.now() >= deadline) throw new SafeToolError('Ripgrep search reached its time limit. Narrow the directory.');
        const batch: SearchFile[] = []; let length = query.length + 1024;
        while (start < files.length && batch.length < 64 && length + files[start].canonical.length * 2 + 8 < 24000) { const file = files[start++]; batch.push(file); length += file.canonical.length * 2 + 8; }
        if (!batch.length) throw new SafeToolError('A source path exceeds the portable search command size. Narrow the repository directory.');
        const lookup = new Map(batch.map(file => [normalize(file.canonical), file.path]));
        const stop = new AbortController(); const decoder = new StringDecoder('utf8'); let pending = ''; let malformed = false;
        let current: { count: number; matches: SearchMatch[]; binary: boolean } | undefined;
        const receive = (chunk: Buffer) => {
            if (hasMore || malformed) return;
            pending += decoder.write(chunk);
            if (pending.length > 16 * 1024 * 1024) { malformed = true; stop.abort(); return; }
            let end: number;
            while (!hasMore && !malformed && (end = pending.indexOf('\n')) >= 0) {
                const row = pending.slice(0, end); pending = pending.slice(end + 1); if (!row) continue;
                try {
                    const event = JSON.parse(row);
                    if (event.type === 'begin') { current = { count: 0, matches: [], binary: false }; continue; }
                    if (event.type === 'end') {
                        if (current && !current.binary && event.data?.binary_offset == null) {
                            count += current.count;
                            for (const match of current.matches) {
                                const size = JSON.stringify(match).length;
                                if (matches.length >= 100 || outputSize + size > 85000) { hasMore = true; stop.abort(); break; }
                                matches.push(match); outputSize += size;
                            }
                        }
                        current = undefined; continue;
                    }
                    if (event.type !== 'match') continue;
                    const path = typeof event.data?.path?.text === 'string' ? lookup.get(normalize(event.data.path.text)) : undefined;
                    const line = event.data?.line_number; const content = event.data?.lines?.text;
                    if (!path || !current || !Number.isInteger(line) || line < 1) { malformed = true; stop.abort(); break; }
                    if (typeof content !== 'string' || content.includes('\0')) { current.binary = true; continue; }
                    if (count + current.count++ < offset || current.matches.length >= 101) continue;
                    const source = content.replace(/\r?\n$/, ''); const position = source.toLowerCase().indexOf(query.toLowerCase());
                    const match = { path, line, text: source.slice(Math.max(0, position - 80), Math.max(0, position) + 240) };
                    current.matches.push(match);
                } catch { malformed = true; stop.abort(); }
            }
        };
        let result;
        try {
            result = await runNative({ program: rgPath, arguments: ['--no-config', '--json', '--fixed-strings', '--ignore-case', '--encoding', 'utf-8', '--no-messages', '--no-ignore', '--hidden', '--threads', '1', '--sort', 'path', '--color', 'never', '--max-filesize', '2M', '--', query, ...batch.map(file => file.canonical)], cwd: root, environment, timeoutMs: Math.max(1, Math.min(5000, deadline - Date.now())), outputLimit: 4096, onStdout: receive }, AbortSignal.any([signal, stop.signal]));
        } catch { signal.throwIfAborted(); throw new SafeToolError('Bundled ripgrep could not start. Repair the application installation; no system rg installation is required.'); }
        signal.throwIfAborted();
        if (malformed || (!hasMore && (!['passed', 'failed'].includes(result.state) || ![0, 1].includes(result.exitCode ?? -1) || pending.trim()))) throw new SafeToolError('Ripgrep search did not complete within its execution/output limits. Narrow the directory or query.');
    }
    return { matches, hasMore };
}
