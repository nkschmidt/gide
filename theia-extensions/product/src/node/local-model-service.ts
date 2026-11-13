import { governedDataDirectory } from './data-directory';
import { injectable } from '@theia/core/shared/inversify';
import { cpus, totalmem, platform } from 'os';
import { join } from 'path';
import { access, mkdir, open } from 'fs/promises';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { DEFAULT_LOCAL_MODEL, LocalModelStatus } from '../common/project-service';

const exec = promisify(execFile);
const endpoint = 'http://127.0.0.1:11434';

@injectable()
export class LocalModelService {
    protected job?: LocalModelStatus['job'];
    protected runtimeDirectory = governedDataDirectory('runtime', 'ollama');

    async status(): Promise<LocalModelStatus> {
        let running = false; let models: string[] = [];
        try {
            const response = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(2000) });
            if (response.ok) { const data = await response.json() as { models: { name: string }[] }; models = data.models.map(model => model.name); running = true; }
        } catch { /* Runtime is not running yet. */ }
        return { running, models, memoryGB: Math.round(totalmem() / 1024 ** 3), cpu: cpus()[0]?.model || 'Unknown CPU', credentials: { openai: !!process.env.OPENAI_API_KEY, anthropic: !!process.env.ANTHROPIC_API_KEY }, job: this.job && { ...this.job } };
    }

    onStart(): void {
        this.install();
    }

    install(): void {
        if (this.job?.state === 'running') return;
        const model = DEFAULT_LOCAL_MODEL;
        this.job = { state: 'running', phase: 'Checking Ollama', completed: 0, total: 0 };
        void this.installAndPull(model).catch(error => { this.job = { state: 'error', phase: 'Installation failed', completed: 0, total: 0, error: error instanceof Error ? error.message : 'Please try again.' }; });
    }

    protected async installAndPull(model: string): Promise<void> {
        if (!(await this.status()).running) {
            let binary = join(this.runtimeDirectory, 'ollama');
            try { await access(binary); }
            catch {
                // Prefer an existing installation before downloading a private runtime.
                try { binary = (await exec('which', ['ollama'])).stdout.trim(); }
                catch {
                    const appBinary = '/Applications/Ollama.app/Contents/Resources/ollama';
                    try { await access(appBinary); binary = appBinary; }
                    catch { binary = await this.downloadRuntime(); }
                }
            }
            this.job = { state: 'running', phase: 'Starting Ollama', completed: 0, total: 0 };
            const child = spawn(binary, ['serve'], { detached: true, stdio: 'ignore', env: { ...process.env, OLLAMA_HOST: '127.0.0.1:11434', OLLAMA_CONTEXT_LENGTH: '4096' } });
            let launchError: Error | undefined;
            child.on('error', error => { launchError = error; }); child.unref();
            for (let attempt = 0; attempt < 40; attempt++) {
                if (launchError) throw launchError;
                if ((await this.status()).running) break;
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            if (!(await this.status()).running) throw new Error('Ollama did not start. Try launching Ollama and then retry.');
        }
        if ((await this.status()).models.includes(model)) {
            this.job = { state: 'done', phase: `${model} already installed`, completed: 1, total: 1 };
            return;
        }
        this.job = { state: 'running', phase: `Downloading ${model}`, completed: 0, total: 0 };
        const response = await fetch(`${endpoint}/api/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream: true }), signal: AbortSignal.timeout(60 * 60 * 1000) });
        if (!response.ok || !response.body) throw new Error('Ollama could not start the model download.');
        const decoder = new TextDecoder(); let pending = ''; let success = false;
        const update = (line: string): void => {
            if (!line.trim()) return;
            const item = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string };
            if (item.error) throw new Error(item.error);
            this.job = { state: 'running', phase: item.status || 'Downloading model', completed: item.completed || 0, total: item.total || 0 };
            if (item.status === 'success') success = true;
        };
        for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
            pending += decoder.decode(bytes, { stream: true });
            const lines = pending.split('\n'); pending = lines.pop() || ''; lines.forEach(update);
        }
        pending += decoder.decode(); update(pending);
        if (!success) throw new Error('The download ended before Ollama confirmed success. Retry to resume.');
        const status = await this.status();
        if (!status.models.includes(model)) throw new Error('Model download finished, but the model is not available yet. Retry.');
        this.job = { state: 'done', phase: `${model} installed`, completed: 1, total: 1 };
    }

    protected async downloadRuntime(): Promise<string> {
        if (platform() !== 'darwin') throw new Error('Automatic runtime installation currently supports macOS. Install Ollama and retry.');
        this.job = { state: 'running', phase: 'Finding official Ollama release', completed: 0, total: 0 };
        const releaseResponse = await fetch('https://api.github.com/repos/ollama/ollama/releases/latest', { signal: AbortSignal.timeout(30000) });
        if (!releaseResponse.ok) throw new Error('Cannot access the official Ollama release. Check your connection and retry.');
        const release = await releaseResponse.json() as { assets: { name: string; browser_download_url: string; size: number; digest?: string }[] };
        const asset = release.assets.find(item => item.name === 'ollama-darwin.tgz');
        if (!asset || !asset.browser_download_url.startsWith('https://github.com/ollama/ollama/releases/download/')) throw new Error('Official macOS runtime package was not found.');
        const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
        if (!response.ok || !response.body) throw new Error('Could not download Ollama.');
        await mkdir(this.runtimeDirectory, { recursive: true });
        const archivePath = join(this.runtimeDirectory, 'ollama-darwin.tgz');
        const archive = await open(archivePath, 'w'); const hash = createHash('sha256');
        this.job = { state: 'running', phase: 'Downloading Ollama runtime', completed: 0, total: asset.size };
        try {
            for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
                await archive.writeFile(bytes); hash.update(bytes); this.job.completed += bytes.length;
            }
        } finally { await archive.close(); }
        if (asset.digest?.startsWith('sha256:') && asset.digest !== `sha256:${hash.digest('hex')}`) throw new Error('Ollama package checksum did not match. Retry installation.');
        this.job = { state: 'running', phase: 'Extracting Ollama runtime', completed: 0, total: 0 };
        await exec('tar', ['-xzf', archivePath, '-C', this.runtimeDirectory], { timeout: 120000 });
        const binary = join(this.runtimeDirectory, 'ollama'); await access(binary); return binary;
    }
}
