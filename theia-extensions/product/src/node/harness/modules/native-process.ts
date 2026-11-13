import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { access, lstat, readFile, realpath } from 'fs/promises';
import { constants } from 'fs';
import { delimiter, isAbsolute, join } from 'path';
export async function nativeExecutable(name: string): Promise<{ path: string; digest: string }> {
    const paths = isAbsolute(name) ? [name] : (process.env.PATH || '').split(delimiter).filter(isAbsolute).flatMap(directory => process.platform === 'win32' ? [join(directory, name), join(directory, name + '.exe')] : [join(directory, name)]);
    for (const candidate of paths) { try { const path = await realpath(candidate); const stat = await lstat(path); if (!stat.isFile() || stat.size > 256 * 1024 * 1024 || /\.(cmd|bat)$/i.test(path)) continue; await access(path, constants.X_OK); return { path, digest: createHash('sha256').update(await readFile(path)).digest('hex') }; } catch { /* Next PATH candidate. */ } }
    throw new Error(`Native executable ${name} is unavailable.`);
}
export interface ProcessRequest { program: string; arguments: string[]; cwd: string; environment: NodeJS.ProcessEnv; timeoutMs: number; outputLimit: number; onOutput?(chunk: Buffer): void; onStdout?(chunk: Buffer): void; onStopping?(): void; }
export interface ProcessResult { exitCode: number | null; signal: string | null; state: 'passed' | 'failed' | 'cancelled' | 'timed_out'; output: string; truncated: boolean; }
/** Host process adapter. Cwd is not an OS isolation boundary. */
export function runNative(request: ProcessRequest, signal: AbortSignal): Promise<ProcessResult> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const child = spawn(request.program, request.arguments, { cwd: request.cwd, env: request.environment, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let state: 'cancelled' | 'timed_out' | undefined; let output = ''; let bytes = 0; let truncated = false; let killTimer: ReturnType<typeof setTimeout> | undefined; let error: Error | undefined;
        const kill = (hard: boolean) => { if (!child.pid) return; try { if (process.platform === 'win32') spawn(`${process.env.SystemRoot || 'C:\\Windows'}\\System32\\taskkill.exe`, ['/PID', String(child.pid), '/T', ...(hard ? ['/F'] : [])], { shell: false, windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill()); else process.kill(-child.pid, hard ? 'SIGKILL' : 'SIGTERM'); } catch { /* Already exited. */ } };
        const stop = (reason: 'cancelled' | 'timed_out') => { if (state) return; state = reason; request.onStopping?.(); kill(false); killTimer = setTimeout(() => kill(true), 1500); };
        const abort = () => stop('cancelled'); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
        const timer = setTimeout(() => stop('timed_out'), request.timeoutMs);
        const append = (buffer: Buffer) => { request.onOutput?.(buffer); const remaining = request.outputLimit - bytes; const kept = buffer.subarray(0, Math.max(0, remaining)); bytes += kept.length; output += kept.toString('utf8'); if (buffer.length > remaining) truncated = true; };
        child.stdout.on('data', buffer => { request.onStdout?.(buffer); append(buffer); }); child.stderr.on('data', append); child.on('error', value => { error = value; });
        child.on('close', (exitCode, exitSignal) => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); signal.removeEventListener('abort', abort); kill(true); if (error) reject(error); else resolve({ state: state || (exitCode === 0 ? 'passed' : 'failed'), exitCode, signal: exitSignal, output, truncated }); });
    });
}
