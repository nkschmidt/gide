import { constants } from 'fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { randomUUID, createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ContextSelection, ContextSource, ContextTopic, ContextTopics, ProjectContextIndex, RepositoryContext } from '../../../common/project-context';
import { ProjectContextSource, ToolContext } from '../core/contracts';
import { ListRepositoriesExecutor, resolveRepositoryTarget } from './repository-tools';
import { ReadFilesExecutor, SafeToolError } from './file-tools';

import { projectIdentity } from '../storage/project-layout';

const exec = promisify(execFile);
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
interface Manifest { version: 1; repositories: Record<string, string>; }
interface Generation { version: 1; repositoryRevision?: string; repository: string; root: string; generation: string; summary: string; updatedAt: number; revision: string; dirty: boolean; statusDigest: string; topics: ContextTopic[]; sources: ContextSource[]; }
export interface ObservedSource extends ContextSource { content: string; }
export interface MemoryRetirement { topic: string; kind: 'fact' | 'example' | 'unknown'; key: string; }
export interface MemoryUpdate { expectedGeneration: string | null; retire: MemoryRetirement[]; }
export interface PublishContext { repository: string; summary: string; topics: ContextTopic[]; }

export class ProjectMemory implements ProjectContextSource {
    private readonly writers = new Map<string, Promise<unknown>>();
    private readonly files = new ReadFilesExecutor();
    private async folder(project: string, parts: string[], create = false): Promise<string> {
        let path = await realpath(project);
        for (const part of parts) {
            path = resolve(path, part);
            try { const entry = await lstat(path); if (!entry.isDirectory() || entry.isSymbolicLink()) throw new SafeToolError('Context storage must use real project directories, not links.'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error; await mkdir(path, { mode: 0o700 }); }
        }
        return path;
    }
    private async read(project: string, parts: string[], name: string, limit = 100000): Promise<string | undefined> {
        try {
            const directory = await this.folder(project, parts); const handle = await open(resolve(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
                const info = await handle.stat(); if (!info.isFile() || info.size > limit) throw new SafeToolError('A context file exceeds its size limit.');
                const buffer = Buffer.alloc(limit + 1); const result = await handle.read(buffer, 0, buffer.length, 0);
                if (result.bytesRead > limit) throw new SafeToolError('A context file exceeds its size limit.');
                return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, result.bytesRead));
            } finally { await handle.close(); }
        } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    }
    private async manifest(project: string): Promise<Manifest> {
        const text = await this.read(project, ['context', 'memory'], 'index.json');
        if (!text) return { version: 1, repositories: {} };
        const value = JSON.parse(text) as Manifest;
        if (value.version !== 1 || !value.repositories || Object.entries(value.repositories).some(([id, generation]) => !/^[a-z0-9][a-z0-9-]*$/i.test(id) || !/^[a-f0-9-]{36}$/.test(generation))) throw new SafeToolError('The project context index is invalid.');
        return value;
    }
    private async generation(project: string, repository: string): Promise<Generation | undefined> {
        const repositories = (await this.manifest(project)).repositories;
        const id = Object.prototype.hasOwnProperty.call(repositories, repository) ? repositories[repository] : undefined; if (!id) return undefined;
        const text = await this.read(project, ['context', 'memory', 'repositories', repository], `${id}.json`);
        if (!text) {
            const current = (await this.manifest(project)).repositories[repository];
            if (current && current !== id) return this.generation(project, repository);
            return undefined;
        } const value = JSON.parse(text) as Generation;
        if (value.version !== 1 || value.repository !== repository || value.generation !== id || !Array.isArray(value.topics) || !Array.isArray(value.sources) || value.sources.length > 32) throw new SafeToolError('The saved repository context is invalid.');
        return value.repositoryRevision === (await projectIdentity(project)).repositoryRevision ? value : undefined;
    }
    private async git(root: string, signal: AbortSignal): Promise<{ revision: string; dirty: boolean; statusDigest: string }> {
        signal.throwIfAborted(); let revision = 'uncommitted';
        try { revision = (await exec('git', ['-c', 'core.fsmonitor=false', '-C', root, 'rev-parse', 'HEAD'], { timeout: 5000, signal })).stdout.trim(); } catch { signal.throwIfAborted(); }
        const status = (await exec('git', ['-c', 'core.fsmonitor=false', '-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=normal'], { timeout: 5000, maxBuffer: 1024 * 1024, signal })).stdout;
        return { revision, dirty: !!status, statusDigest: digest(status) };
    }
    private async currentSourceHashes(projectPath: string, sources: ContextSource[], context: ToolContext): Promise<boolean> {
        for (let offset = 0; offset < sources.length; offset += 20) {
            const slice = sources.slice(offset, offset + 20);
            try {
                const prepared = await this.files.prepare({ paths: slice.map(source => source.path) }, { ...context, projectPath });
                const entries = prepared.files as { inputPath: string; digest?: string; error?: string }[];
                if (slice.some(source => !entries.some(file => file.inputPath === source.path && file.digest === source.digest && !file.error))) return false;
            } catch { context.signal.throwIfAborted(); return false; }
        }
        return true;
    }
    private async freshness(project: string, generation: Generation, context: ToolContext): Promise<{ freshness: RepositoryContext['freshness']; note?: string }> {
        try {
            const target = await resolveRepositoryTarget({ repository: generation.repository, path: '.', offset: 0 }, context);
            const current = await this.git(target.root, context.signal);
            if (target.root !== generation.root || current.revision !== generation.revision || current.statusDigest !== generation.statusDigest || !await this.currentSourceHashes(project, generation.sources, context)) return { freshness: 'changed', note: 'Repository or referenced files changed since this analysis. Verify the current code and refresh context when needed.' };
            return { freshness: 'current', note: generation.dirty ? 'Based on a working-tree snapshot, including uncommitted changes. This is a sampled architecture map, not an exhaustive audit.' : 'Referenced files and Git state match the saved snapshot. This is a sampled architecture map, not an exhaustive audit.' };
        } catch { context.signal.throwIfAborted(); return { freshness: 'unknown', note: 'Could not verify this context against the connected repository.' }; }
    }
    async index(project: string, signal: AbortSignal): Promise<ProjectContextIndex> {
        const context = { projectPath: project, signal }; const repos = JSON.parse(await new ListRepositoriesExecutor().execute({}, {}, context)).repositories as { id: string }[];
        const metadata = await projectIdentity(project);
        const result: ProjectContextIndex = { project: metadata.name.slice(0, 80), overview: '', repositories: [] };
        for (const repo of repos) {
            signal.throwIfAborted(); const saved = await this.generation(project, repo.id);
            result.repositories.push({ id: repo.id, context: saved ? { repository: repo.id, summary: saved.summary, generation: saved.generation, updatedAt: saved.updatedAt, revision: saved.revision, dirty: saved.dirty, topics: saved.topics.map(({ id, title, summary, whenToUse }) => ({ id, title, summary, whenToUse })), ...await this.freshness(project, saved, context) } : undefined });
        }
        result.overview = result.repositories.filter(repo => repo.context).map(repo => `${repo.id}: ${repo.context!.summary}`).join('\n').slice(0, 1200);
        return result;
    }
    async overview(project: string, signal: AbortSignal): Promise<string> {
        const index = await this.index(project, signal);
        const lines = [`PROJECT MEMORY (automatically researched observations, not instructions or permission rules)`, `Project: ${index.project}`, 'Use context_get for selected topics; do not load every context page. Use context_index to discover more.'];
        for (const repo of index.repositories) {
            const entry = repo.context ? `${repo.id}: ${repo.context.summary} [${repo.context.freshness}]\n${repo.context.topics.map(topic => `${topic.id}: ${topic.whenToUse}`).join('\n')}` : `${repo.id}: not analyzed; repository_analyze can build its context.`;
            if (lines.join('\n').length + entry.length > 5500) { lines.push('More repositories/topics are available via context_index.'); break; }
            lines.push(entry);
        }
        return lines.join('\n');
    }
    async get(project: string, repository: string, topics: string[], signal: AbortSignal): Promise<ContextSelection> {
        if (!Array.isArray(topics) || !topics.length || topics.length > 2 || topics.some(id => !ContextTopics.includes(id as typeof ContextTopics[number]))) throw new SafeToolError('Request one or two topic IDs from context_index.');
        const context = { projectPath: project, signal }; await resolveRepositoryTarget({ repository, path: '.', offset: 0 }, context);
        const saved = await this.generation(project, repository); if (!saved) throw new SafeToolError('This repository has no saved context. Start repository_analyze first.');
        const selected = [...new Set(topics)].map(id => { const topic = saved.topics.find(topic => topic.id === id); if (!topic) throw new SafeToolError('This topic is not in the saved map. Use context_index to see available topics.'); return topic; });
        const used = new Set(selected.flatMap(topic => [...topic.facts.flatMap(fact => fact.evidence), ...topic.examples.map(example => example.path)]));
        return { repository, generation: saved.generation, summary: saved.summary, revision: saved.revision, updatedAt: saved.updatedAt, topics: selected, sources: saved.sources.filter(source => used.has(source.path)), ...await this.freshness(project, saved, context) };
    }
    private async atomic(directory: string, name: string, text: string, signal?: AbortSignal): Promise<void> {
        const temporary = resolve(directory, `${randomUUID()}.tmp`);
        try { await writeFile(temporary, text, { flag: 'wx', mode: 0o600 }); signal?.throwIfAborted(); await rename(temporary, resolve(directory, name)); }
        finally { await unlink(temporary).catch(() => undefined); }
    }
    private sentence(value: unknown, max: number): string {
        if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n]|```/.test(value)) throw new SafeToolError(`Context text must be a short prose sentence (up to ${max} characters), without code blocks.`);
        if (/\b(?:I|we) (?:ran|tested|verified|observed|checked)|\btests? (?:passed|failed)|\b\d+ tests?\b|\bbuild (?:passed|failed)|\btask (?:completed|finished)|during (?:this|the) (?:task|run)|тесты (?:прошли|упали)|я (?:проверил|запустил)/i.test(value)) throw new SafeToolError('Task activity, test results and execution observations belong in ChangeSets, not architecture memory.');
        return value.trim();
    }
    validate(value: unknown, observed: Map<string, ObservedSource>): PublishContext {
        const input = value as PublishContext;
        if (!input || !/^[a-z0-9][a-z0-9-]*$/i.test(input.repository) || !Array.isArray(input.topics) || !input.topics.length || input.topics.length > 7) throw new SafeToolError('Publish a repository summary and 1–7 bounded context topics.');
        const summary = this.sentence(input.summary, 350); const ids = new Set<string>(); const texts = [summary];
        const evidencePath = (path: string) => { if (typeof path !== 'string' || path.length > 512 || !path.startsWith(`repositories/${input.repository}/`) || !observed.has(path)) throw new SafeToolError('Every evidence/example path must reference a file actually read during this analysis. Read that file before publishing.'); return path; };
        const topics = input.topics.map(topic => {
            if (!ContextTopics.includes(topic.id) || ids.has(topic.id) || !Array.isArray(topic.facts) || topic.facts.length > 8 || !Array.isArray(topic.examples) || topic.examples.length > 3 || !Array.isArray(topic.unknowns) || topic.unknowns.length > 4) throw new SafeToolError('Use unique topic IDs with at most 8 facts, 3 examples and 4 unknowns per topic.');
            ids.add(topic.id);
            const result: ContextTopic = { id: topic.id, title: this.sentence(topic.title, 60), summary: this.sentence(topic.summary, 180), whenToUse: this.sentence(topic.whenToUse, 160), facts: topic.facts.map(fact => {
                if (!Array.isArray(fact.evidence) || !fact.evidence.length || fact.evidence.length > 4) throw new SafeToolError('Each observed fact needs 1–4 evidence paths.');
                return { text: this.sentence(fact.text, 240), evidence: [...new Set(fact.evidence.map(evidencePath))] };
            }), examples: topic.examples.map(example => ({ purpose: this.sentence(example.purpose, 120), path: evidencePath(example.path), symbol: typeof example.symbol === 'string' && !/[\r\n`]/.test(example.symbol) ? example.symbol.slice(0, 100) : '' })), unknowns: topic.unknowns.map(value => this.sentence(value, 160)) };
            if (!result.facts.length && !result.unknowns.length) throw new SafeToolError('Each topic must contain evidence-backed facts or explicit unknowns.');
            if (JSON.stringify(result).length > 4500) throw new SafeToolError('A context topic is too long. Summarize it more tightly.');
            texts.push(result.summary, ...result.facts.map(fact => fact.text), ...result.unknowns); return result;
        });
        for (const text of texts.filter(text => text.length >= 80)) if ([...observed.values()].some(source => source.content.includes(text))) throw new SafeToolError('Do not copy source text into memory. Summarize the finding and reference the source file.');
        return { repository: input.repository, summary, topics };
    }

    private merge(previous: Generation | undefined, candidate: PublishContext, observed: Map<string, ObservedSource>, retire: MemoryRetirement[]): PublishContext {
        if (!Array.isArray(retire) || retire.length > 50) throw new SafeToolError('Use at most 50 explicit fact/example/unknown retirements.');
        const topics = JSON.parse(JSON.stringify(previous?.topics || [])) as ContextTopic[];
        for (const item of retire) {
            const topic = topics.find(topic => topic.id === item.topic);
            if (!topic || !candidate.topics.some(topic => topic.id === item.topic)) throw new SafeToolError('Retire only entries from an explicitly updated existing topic.');
            if (item.kind === 'fact') { if (!topic.facts.some(fact => fact.text === item.key)) throw new SafeToolError('Retired fact no longer matches saved memory.'); topic.facts = topic.facts.filter(fact => fact.text !== item.key); }
            else if (item.kind === 'example') { if (!topic.examples.some(example => example.path + '#' + example.symbol === item.key)) throw new SafeToolError('Retired example no longer matches.'); topic.examples = topic.examples.filter(example => example.path + '#' + example.symbol !== item.key); }
            else if (item.kind === 'unknown') { if (!topic.unknowns.includes(item.key)) throw new SafeToolError('Retired unknown no longer matches.'); topic.unknowns = topic.unknowns.filter(text => text !== item.key); }
            else throw new SafeToolError('Invalid memory retirement kind.');
        }
        const key = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase().replace(/[.!?]+$/, '');
        for (const topic of candidate.topics) {
            const existing = topics.find(item => item.id === topic.id);
            if (!existing) { topics.push(topic); continue; }
            existing.title = topic.title; existing.summary = topic.summary; existing.whenToUse = topic.whenToUse;
            for (const fact of topic.facts) { const found = existing.facts.find(item => key(item.text) === key(fact.text)); if (found) found.evidence = [...new Set([...found.evidence, ...fact.evidence])]; else existing.facts.push(fact); }
            for (const example of topic.examples) { const index = existing.examples.findIndex(item => item.path === example.path && item.symbol === example.symbol); if (index < 0) existing.examples.push(example); else existing.examples[index] = example; }
            existing.unknowns = [...new Map([...existing.unknowns, ...topic.unknowns].map(text => [key(text), text])).values()];
        }
        try { return this.validate({ repository: candidate.repository, summary: candidate.summary, topics }, observed); }
        catch (error) { throw new SafeToolError(`Memory merge was not saved: ${error instanceof Error ? error.message : 'invalid content'} Consolidate only the affected facts with explicit retirements; unrelated knowledge is preserved.`); }
    }
    async publish(project: string, value: unknown, observed: Map<string, ObservedSource>, signal: AbortSignal, update?: MemoryUpdate, analysis?: { revision?: string }): Promise<{ repository: string; generation: string; topics: string[]; changed?: boolean }> {
        const candidate = this.validate(value, observed);
        const previous = this.writers.get(project) || Promise.resolve();
        const operation = previous.catch(() => undefined).then(async () => {
            signal.throwIfAborted();
            const { repositoryRevision } = await projectIdentity(project);
            if (analysis && analysis.revision !== repositoryRevision) throw new SafeToolError('The connected repositories changed. Start a new analysis.');
            const previous = await this.generation(project, candidate.repository);
            if (update && update.expectedGeneration !== (previous?.generation || null)) throw new SafeToolError('Memory changed since it was read. Read the current topics before updating.');
            const evidence = new Map(observed);
            for (const source of previous?.sources || []) if (!evidence.has(source.path)) evidence.set(source.path, { ...source, content: '' });
            const publication = this.merge(previous, candidate, evidence, update?.retire || []);
            const target = await resolveRepositoryTarget({ repository: publication.repository, path: '.', offset: 0 }, { projectPath: project, signal });
            const used = [...new Set(publication.topics.flatMap(topic => [...topic.facts.flatMap(fact => fact.evidence), ...topic.examples.map(example => example.path)]))];
            if (used.length > 32) throw new SafeToolError('Keep the architecture map focused on at most 32 representative source files.');
            const sources = used.map(path => ({ path, digest: evidence.get(path)!.digest }));
            if (!await this.currentSourceHashes(project, sources, { projectPath: project, signal })) throw new SafeToolError('Referenced code changed during analysis. Read the changed files again before publishing.');
            const git = await this.git(target.root, signal);
            if (previous && previous.summary === publication.summary && JSON.stringify(previous.topics) === JSON.stringify(publication.topics) && JSON.stringify(previous.sources) === JSON.stringify(sources) && previous.revision === git.revision && previous.statusDigest === git.statusDigest) return { repository: previous.repository, generation: previous.generation, topics: previous.topics.map(topic => topic.id), changed: false };
            const generation = randomUUID();
            const saved: Generation = { version: 1, repositoryRevision, repository: publication.repository, root: target.root, generation, updatedAt: Date.now(), ...git, summary: publication.summary, topics: publication.topics, sources };
            const folder = await this.folder(project, ['context', 'memory', 'repositories', publication.repository], true);
            const markdown = [`# ${publication.repository}`, publication.summary, `Revision: ${git.revision}. Working-tree changes: ${git.dirty ? 'yes' : 'no'}.`, ...publication.topics.map(topic => `## ${topic.title}\n${topic.summary}\n\nWhen to use: ${topic.whenToUse}\n\n${topic.facts.map(fact => `- ${fact.text} (${fact.evidence.join(', ')})`).join('\n')}\n\nExamples:\n${topic.examples.map(example => `- ${example.purpose}: ${example.path}${example.symbol ? ` — ${example.symbol}` : ''}`).join('\n')}\n\nUnknowns:\n${topic.unknowns.map(value => `- ${value}`).join('\n')}`)].join('\n\n');
            const jsonPath = resolve(folder, `${generation}.json`); const markdownPath = resolve(folder, `${generation}.md`);
            try {
                await writeFile(jsonPath, JSON.stringify(saved, undefined, 2), { flag: 'wx', mode: 0o600 });
                await writeFile(markdownPath, markdown, { flag: 'wx', mode: 0o600 });
                const manifest = await this.manifest(project); manifest.repositories[publication.repository] = generation;
                const base = await this.folder(project, ['context', 'memory'], true);
                if ((await projectIdentity(project)).repositoryRevision !== repositoryRevision) throw new SafeToolError('The connected repositories changed. Start a new analysis.');
                await this.atomic(base, 'index.json', JSON.stringify(manifest, undefined, 2), signal);
            } catch (error) { await unlink(jsonPath).catch(() => undefined); await unlink(markdownPath).catch(() => undefined); throw error; }
            // Only the final active snapshot is retained here. Execution history stays in SQLite/ChangeSets.
            for (const file of await readdir(folder)) if (/^[a-f0-9-]{36}\.(json|md)$/.test(file) && !file.startsWith(generation + '.')) await unlink(resolve(folder, file)).catch(() => undefined);
            return { repository: publication.repository, generation, topics: publication.topics.map(topic => topic.id), changed: true };
        });
        this.writers.set(project, operation); try { return await operation; } finally { if (this.writers.get(project) === operation) this.writers.delete(project); }
    }
}
