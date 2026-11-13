const { scriptedProvider } = require('./scripted-provider.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { TaskRuntime } = require('../lib/node/harness/core/runtime');
const { ToolRegistry } = require('../lib/node/harness/core/contracts');
const { SqliteStore } = require('../lib/node/harness/storage/sqlite-store');
const { ReadFilesExecutor, DefaultPolicy, OutputSizeLimit } = require('../lib/node/harness/modules/file-tools');
const { registerRepositoryTools } = require('../lib/node/harness/modules/repository-tools');
const { ProjectMemory } = require('../lib/node/harness/modules/project-memory');
const { registerMemoryTools, observedSources } = require('../lib/node/harness/modules/memory-tools');

const code = 'export function createInvoice(input) { return database.transaction(() => repository.save(input)); }\n';
const sourcePath = 'repositories/back/main.ts';
const fact = 'Invoice creation wraps persistence in a database transaction.';
const when = 'When adding a business operation that must persist several related changes.';
function publication() {
    return { repository: 'back', summary: 'Back-end business operations with transaction-scoped persistence.', topics: [
        { id: 'architecture', title: 'Architecture', summary: 'Handlers delegate persistence through business operations.', whenToUse: 'When deciding where to place a new business operation.', facts: [{ text: 'The invoice operation delegates persistence to a repository.', evidence: [sourcePath] }], examples: [{ purpose: 'Follow this entry point for a new invoice operation.', path: sourcePath, symbol: 'createInvoice' }], unknowns: ['Deployment topology has not been verified.'] },
        { id: 'data', title: 'Data access', summary: 'Transaction entry points.', whenToUse: when, facts: [{ text: fact, evidence: [sourcePath] }], examples: [{ purpose: 'Use the existing transaction boundary as a reference.', path: sourcePath, symbol: 'createInvoice' }], unknowns: ['The underlying database engine has not been verified.'] }
    ] };
}
function call(tool, args) { const id = randomUUID(); return { text: '', calls: [{ id, tool, args }], continuation: [{ type: 'function_call', call_id: id, name: tool, arguments: JSON.stringify(args) }] }; }
async function until(check) { for (let i = 0; i < 400; i++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('Expected research state was not reached'); }
async function fixture(t, respond) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'governed-memory-')); const project = path.join(root, 'project'); const repo = path.join(root, 'repo');
    await fs.mkdir(path.join(project, 'repositories'), { recursive: true }); await fs.mkdir(repo);
    execFileSync('git', ['init', '-q', repo]); await fs.writeFile(path.join(repo, 'main.ts'), code); await fs.writeFile(path.join(repo, 'README.md'), 'Synthetic invoice backend.');
    await fs.symlink(repo, path.join(project, 'repositories', 'back'));
    await fs.writeFile(path.join(project, 'project.theia-workspace'), JSON.stringify({ folders: [{ path: '.' }], governedProject: { name: 'Invoice project', description: 'Synthetic test project' }, governedRepositories: [{ id: 'back', path: repo }] }));
    const store = new SqliteStore(path.join(root, 'runtime', 'tasks.sqlite')); const memory = new ProjectMemory(); const tools = new ToolRegistry(); tools.register(new ReadFilesExecutor()); registerRepositoryTools(tools);
    let runtime;
    registerMemoryTools(tools, { memory, store, index: (project, signal) => memory.index(project, signal), analyze: async (project, repository) => runtime.analyzeRepository(project, repository) });
    runtime = new TaskRuntime(store, scriptedProvider({ id: 'fake', respond: respond || (async () => ({ text: 'Done.', calls: [] })) }), tools, new DefaultPolicy(), new OutputSizeLimit(), memory);
    const context = { projectPath: project, signal: new AbortController().signal };
    t.after(async () => { runtime.shutdown(); await new Promise(resolve => setTimeout(resolve, 50)); store.close(); await fs.rm(root, { recursive: true, force: true }); });
    return { root, project, repo, memory, store, runtime, tools, context };
}
async function observed(f) {
    const prepared = await f.tools.get('files_read').prepare({ paths: [sourcePath] }, f.context);
    return new Map([[sourcePath, { path: sourcePath, digest: prepared.files[0].digest, content: code }]]);
}

test('research reads evidence, publishes bounded memory, and new tasks retrieve only selected topics', async t => {
    let researchTurns = 0; let normalTurns = 0; let requested;
    const f = await fixture(t, async (messages, definitions, instructions) => {
        if (instructions.includes('DEDICATED RESEARCH TASK:')) {
            assert.ok(definitions.some(tool => tool.name === 'context_publish')); assert.ok(!definitions.some(tool => tool.name === 'repository_analyze'));
            if (++researchTurns === 1) return call('files_read', { paths: [sourcePath] });
            return call('context_publish', publication());
        }
        assert.ok(!definitions.some(tool => tool.name === 'context_publish'));
        assert.match(instructions, /Invoice project/); assert.ok(!instructions.includes('Shared invoice product')); assert.ok(!instructions.includes('Synthetic test project')); assert.match(instructions, /data:/); assert.ok(instructions.includes(when));
        assert.ok(instructions.length < 11000); assert.ok(!instructions.includes(fact)); assert.ok(!instructions.includes(code.trim()));
        if (++normalTurns === 1) return call('context_get', { repository: 'back', topics: ['data'] });
        requested = JSON.parse(messages.filter(message => message.role === 'tool').at(-1).text);
        return { text: 'I will follow the existing transaction boundary.', calls: [] };
    });
    await fs.mkdir(path.join(f.project, 'context')); await fs.writeFile(path.join(f.project, 'context', 'project.md'), 'Shared invoice product. Legacy manual overview must be ignored.');
    const research = f.runtime.analyzeRepository(f.project, 'back');
    assert.deepEqual(f.runtime.list(f.project), [], 'system research is not a user chat');
    assert.equal(f.runtime.researchJobs(f.project)[0].id, research.id);
    assert.equal(f.runtime.analyzeRepository(f.project, 'back').id, research.id, 'duplicate requests reuse the active research task');
    await until(() => ['completed', 'failed'].includes(f.runtime.snapshot(research.id).task.state));
    assert.equal(f.runtime.snapshot(research.id).task.state, 'completed', JSON.stringify(f.runtime.snapshot(research.id).actions.map(action => action.error)));
    assert.deepEqual(f.runtime.list(f.project), [], 'completed research remains hidden');
    assert.equal(researchTurns, 2); assert.equal(f.runtime.snapshot(research.id).approvals.length, 0);
    const index = await f.memory.index(f.project, f.context.signal); assert.equal(index.project, 'Invoice project'); assert.equal(index.repositories[0].context.topics.length, 2);
    assert.doesNotMatch(JSON.stringify(index), /createInvoice|database\.transaction/);
    const task = f.runtime.create(f.project); f.runtime.send(task.id, 'Add a related business operation', randomUUID());
    assert.deepEqual(f.runtime.list(f.project).map(item => item.id), [task.id]);
    await until(() => f.runtime.snapshot(task.id).task.state === 'completed');
    assert.deepEqual(requested.topics.map(topic => topic.id), ['data']); assert.equal(requested.topics[0].facts[0].text, fact);
    assert.equal(requested.sources[0].path, sourcePath); assert.doesNotMatch(JSON.stringify(requested), /export function/);
    const reopened = new ProjectMemory(); assert.equal((await reopened.get(f.project, 'back', ['data'], f.context.signal)).topics[0].facts[0].text, fact);
    const observedMap = observedSources(f.store, research.id, 'back'); assert.equal(observedMap.size, 1);
});

test('stored system jobs stay separate from ordinary chats after recovery without deleting their history', async t => {
    const f = await fixture(t);
    const chat = f.runtime.create(f.project);
    const system = f.runtime.create(f.project);
    system.kind = 'repository-analysis'; system.repository = 'back'; system.state = 'failed';
    f.store.putTask(system);
    f.store.event(system.id, undefined, 'research.test-history');
    const recovered = new TaskRuntime(f.store, scriptedProvider({ id: 'fake', respond: async () => ({ text: '', calls: [] }) }), f.tools, new DefaultPolicy(), new OutputSizeLimit(), f.memory);
    assert.deepEqual(recovered.list(f.project).map(task => task.id), [chat.id]);
    assert.equal(recovered.researchJobs(f.project)[0].id, system.id);
    assert.ok(recovered.snapshot(system.id).events.some(event => event.type === 'research.test-history'));
    system.state = 'cancelled'; f.store.putTask(system);
    assert.deepEqual(recovered.list(f.project).map(task => task.id), [chat.id]);
    recovered.shutdown();
});

test('memory publication rejects invented evidence, copied code, oversized prose and broad topic requests', async t => {
    const f = await fixture(t); const evidence = await observed(f); const valid = publication();
    const invented = structuredClone(valid); invented.topics[0].facts[0].evidence = ['repositories/back/not-read.ts'];
    assert.throws(() => f.memory.validate(invented, evidence), /actually read/);
    const copied = structuredClone(valid); copied.topics[0].facts[0].text = code.trim(); assert.throws(() => f.memory.validate(copied, evidence), /copy source/);
    const fenced = structuredClone(valid); fenced.topics[0].facts[0].text = '```ts\ncode\n```'; assert.throws(() => f.memory.validate(fenced, evidence), /without code/);
    const long = structuredClone(valid); long.summary = 'x'.repeat(351); assert.throws(() => f.memory.validate(long, evidence), /350/);
    await f.memory.publish(f.project, valid, evidence, f.context.signal);
    await assert.rejects(() => f.memory.get(f.project, 'back', ['architecture', 'data', 'patterns'], f.context.signal), /one or two/);
    await assert.rejects(() => f.memory.get(f.project, 'back', ['../../main.ts'], f.context.signal), /topic IDs/);
    await assert.rejects(() => f.memory.get(f.project, 'unknown', ['data'], f.context.signal), /not connected/);
});

test('source changes mark context stale and prevent publishing a map based on old reads', async t => {
    const f = await fixture(t); const evidence = await observed(f); await f.memory.publish(f.project, publication(), evidence, f.context.signal);
    assert.equal((await f.memory.index(f.project, f.context.signal)).repositories[0].context.freshness, 'current');
    await fs.writeFile(path.join(f.repo, 'main.ts'), code + '// changed after research\n');
    const selected = await f.memory.get(f.project, 'back', ['data'], f.context.signal); assert.equal(selected.freshness, 'changed');
    await assert.rejects(() => f.memory.publish(f.project, publication(), evidence, f.context.signal), /changed during analysis/);
    assert.equal((await f.memory.index(f.project, f.context.signal)).repositories[0].context.topics.length, 2, 'previous published map remains available');
});

test('context writes stay within the project and cancelled publication preserves the previous generation', async t => {
    const f = await fixture(t); const evidence = await observed(f); const first = await f.memory.publish(f.project, publication(), evidence, f.context.signal);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(() => f.memory.publish(f.project, publication(), evidence, controller.signal));
    assert.equal((await f.memory.index(f.project, f.context.signal)).repositories[0].context.generation, first.generation);
    const other = path.join(f.root, 'other-project'); await fs.mkdir(path.join(other, 'repositories'), { recursive: true }); await fs.symlink(f.root, path.join(other, 'context')); await fs.symlink(f.repo, path.join(other, 'repositories', 'back'));
    await fs.writeFile(path.join(other, 'project.theia-workspace'), JSON.stringify({ governedRepositories: [{ id: 'back', path: f.repo }] }));
    await assert.rejects(() => f.memory.publish(other, publication(), evidence, f.context.signal), /real project directories/);
});

test('ordinary tasks cannot publish memory and research without publication cannot report completion', async t => {
    const f = await fixture(t);
    const publish = f.tools.get('context_publish'); assert.equal(publish.available(f.context), false);
    await assert.rejects(() => publish.prepare(publication(), f.context), /dedicated research/);
    const research = f.runtime.analyzeRepository(f.project, 'back');
    await until(() => f.runtime.snapshot(research.id).task.state === 'failed');
    assert.match(f.runtime.snapshot(research.id).runs.at(-1).error, /without saving/);
    assert.equal((await f.memory.index(f.project, f.context.signal)).repositories[0].context, undefined);
});

test('refresh merges durable facts, preserves unrelated topics, deduplicates and retains only the final snapshot', async t => {
    const f = await fixture(t); const evidence = await observed(f); const first = await f.memory.publish(f.project, publication(), evidence, f.context.signal);
    const next = publication(); next.topics = [next.topics[1]]; next.topics[0].facts.push({ text: 'The exported invoice entry point accepts its input as an argument.', evidence: [sourcePath] });
    const second = await f.memory.publish(f.project, next, evidence, f.context.signal);
    assert.notEqual(second.generation, first.generation);
    const saved = await f.memory.get(f.project, 'back', ['architecture', 'data'], f.context.signal);
    assert.equal(saved.topics.length, 2); assert.equal(saved.topics.find(topic => topic.id === 'data').facts.length, 2);
    const repeated = await f.memory.publish(f.project, next, evidence, f.context.signal); assert.equal(repeated.generation, second.generation); assert.equal(repeated.changed, false);
    const folder = path.join(f.project, 'context/memory/repositories/back'); const files = await fs.readdir(folder);
    assert.deepEqual(files.sort(), [second.generation + '.json', second.generation + '.md'].sort());
});

test('curated memory updates require the read generation, explicitly retire obsolete facts and reject task noise', async t => {
    const f = await fixture(t); const evidence = await observed(f); const first = await f.memory.publish(f.project, publication(), evidence, f.context.signal);
    const update = publication(); update.topics = [update.topics[1]]; const oldText = update.topics[0].facts[0].text; update.topics[0].facts = [{ text: 'Business persistence runs inside the invoice transaction boundary.', evidence: [sourcePath] }];
    await assert.rejects(() => f.memory.publish(f.project, update, evidence, f.context.signal, { expectedGeneration: 'stale', retire: [] }), /Memory changed/);
    await f.memory.publish(f.project, update, evidence, f.context.signal, { expectedGeneration: first.generation, retire: [{ topic: 'data', kind: 'fact', key: oldText }] });
    const saved = await f.memory.get(f.project, 'back', ['architecture', 'data'], f.context.signal);
    assert.equal(saved.topics[1].facts.length, 1); assert.equal(saved.topics[1].facts[0].text, update.topics[0].facts[0].text); assert.equal(saved.topics[0].id, 'architecture');
    const noise = publication(); noise.topics[0].facts[0].text = 'We ran the tests and observed no failures during this task.';
    assert.throws(() => f.memory.validate(noise, evidence), /belong in ChangeSets/);
});

test('a normal task reads current memory and source, proposes a reviewed update, then publishes only after approval', async t => {
    let f; let turn = 0; let generation;
    const update = publication(); update.topics = [update.topics[1]]; update.topics[0].facts = [{ text: 'The invoice operation is exported as createInvoice.', evidence: [sourcePath] }];
    f = await fixture(t, async () => {
        if (++turn === 1) return call('context_get', { repository: 'back', topics: ['data'] });
        if (turn === 2) return call('files_read', { paths: [sourcePath] });
        if (turn === 3) return call('context_update', { ...update, expectedGeneration: generation, retire: [], reason: 'The exported operation is a durable entry point for future invoice changes.' });
        return { text: 'The approved durable memory update is saved.', calls: [] };
    });
    generation = (await f.memory.publish(f.project, publication(), await observed(f), f.context.signal)).generation;
    const task = f.runtime.create(f.project); f.runtime.send(task.id, 'Update the architecture entry point context', randomUUID());
    await until(() => f.store.task(task.id).state === 'awaiting_approval');
    assert.equal((await f.memory.index(f.project, f.context.signal)).repositories[0].context.generation, generation);
    const action = f.runtime.snapshot(task.id).actions.find(action => action.tool === 'context_update');
    await until(() => { try { f.runtime.decide(action.id, true); return true; } catch { return false; } });
    await until(() => f.store.task(task.id).state === 'completed');
    const saved = await f.memory.get(f.project, 'back', ['data'], f.context.signal);
    assert.equal(saved.topics[0].facts.length, 2); assert.notEqual(saved.generation, generation);
});

test('refreshing an existing map pauses for final review without creating a user conversation', async t => {
    let generation; let turn = 0;
    const f = await fixture(t, async () => {
        if (++turn === 1) return call('context_get', { repository: 'back', topics: ['data'] });
        if (turn === 2) return call('files_read', { paths: [sourcePath] });
        const value = publication(); value.topics = [value.topics[1]];
        return call('context_publish', { ...value, expectedGeneration: generation, retire: [] });
    });
    generation = (await f.memory.publish(f.project, publication(), await observed(f), f.context.signal)).generation;
    const job = f.runtime.analyzeRepository(f.project, 'back');
    await until(() => f.store.task(job.id).state === 'awaiting_approval');
    assert.deepEqual(f.runtime.list(f.project), []);
    const action = f.runtime.snapshot(job.id).actions.find(action => action.tool === 'context_publish');
    await until(() => { try { f.runtime.decide(action.id, true); return true; } catch { return false; } });
    await until(() => f.store.task(job.id).state === 'completed');
    assert.equal((await f.memory.get(f.project, 'back', ['architecture', 'data'], f.context.signal)).topics.length, 2);
});

test('changing repository connections requires fresh analysis and rejects publication from an older analysis', async t => {
    const f = await fixture(t);
    const evidence = await observed(f);
    const first = await f.memory.publish(f.project, publication(), evidence, f.context.signal);
    const file = path.join(f.project, 'project.theia-workspace');
    const workspace = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(file, JSON.stringify({ ...workspace, governedRepositoryRevision: 'new-connections' }));
    const index = await f.memory.index(f.project, f.context.signal);
    assert.equal(index.repositories[0].context, undefined);
    await assert.rejects(() => f.memory.publish(f.project, publication(), evidence, f.context.signal, undefined, {}), /connected repositories changed/);
    const fresh = await f.memory.publish(f.project, publication(), evidence, f.context.signal, undefined, { revision: 'new-connections' });
    assert.notEqual(fresh.generation, first.generation);
    assert.equal((await f.memory.index(f.project, f.context.signal)).repositories[0].context.generation, fresh.generation);
});
