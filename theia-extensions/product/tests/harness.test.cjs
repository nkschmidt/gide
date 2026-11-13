const { scriptedProvider } = require('./scripted-provider.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { TaskRuntime } = require('../lib/node/harness/core/runtime');
const { SqliteStore } = require('../lib/node/harness/storage/sqlite-store');
const { ToolRegistry } = require('../lib/node/harness/core/contracts');
const { ReadFilesExecutor, DefaultPolicy, OutputSizeLimit } = require('../lib/node/harness/modules/file-tools');
const { buildTaskTimeline, summarizeReads } = require('../lib/common/task-timeline');
const { OpenAiProvider, ProviderError } = require('../lib/node/harness/modules/openai-provider');
const { registerRepositoryTools } = require('../lib/node/harness/modules/repository-tools');
const { execFileSync } = require('node:child_process');

async function until(check) {
    for (let i = 0; i < 150; i++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail('Runtime did not reach the expected state');
}
async function fixture(t, model) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'governed-harness-'));
    const project = path.join(root, 'project'); await fs.mkdir(project);
    await fs.writeFile(path.join(project, 'project.theia-workspace'), JSON.stringify({ folders: [{ path: '.' }], governedRepositories: [] }));
    await fs.writeFile(path.join(project, 'project.yaml'), 'name: example\n');
    await fs.writeFile(path.join(project, 'README.md'), 'A harmless project description.');
    const database = path.join(root, 'runtime', 'tasks.sqlite'); const store = new SqliteStore(database);
    const tools = new ToolRegistry(); tools.register(new ReadFilesExecutor());
    registerRepositoryTools(tools);
    const runtime = new TaskRuntime(store, scriptedProvider(model || { id: 'test', respond: async () => ({ text: 'Done.', calls: [] }) }), tools, new DefaultPolicy(), new OutputSizeLimit());
    const task = runtime.create(project);
    t.after(async () => { runtime.shutdown(); await new Promise(resolve => setTimeout(resolve, 30)); try { store.close(); } catch { } await fs.rm(root, { recursive: true, force: true }); });
    return { root, project, database, store, tools, runtime, task };
}
function readReply(id = randomUUID()) {
    return { text: 'I will inspect the project description.', calls: [{ id, tool: 'files_read', args: { paths: ['README.md'] } }], continuation: [{ type: 'function_call', call_id: id, name: 'files_read', arguments: '{"paths":["README.md"]}' }] };
}

test('model → requested file → approval → safe result → model; task and draft survive restart', async t => {
    let calls = 0; let continuation;
    const f = await fixture(t, { id: 'fake', respond: async messages => { calls++; if (calls === 1) return readReply(); continuation = messages; return { text: 'The project description is harmless.', calls: [] }; } });
    f.runtime.saveDraft(f.task.id, 'saved draft');
    f.runtime.send(f.task.id, 'Inspect the README', 'request-1');
    await until(() => f.runtime.snapshot(f.task.id).task.state === 'awaiting_approval');
    let snapshot = f.runtime.snapshot(f.task.id); assert.equal(calls, 1); assert.equal(snapshot.actions[0].result, undefined); assert.equal(snapshot.approvals[0].state, 'pending');
    assert.equal(snapshot.actions[0].prepared, undefined, 'private execution data is not exposed in the UI snapshot');
    assert.throws(() => f.runtime.send(f.task.id, 'A second run', 'request-2'), /active run/);
    f.runtime.send(f.task.id, 'Inspect the README', 'request-1'); assert.equal(f.store.runs(f.task.id).length, 1, 'retry is idempotent');
    await until(() => { try { f.runtime.decide(snapshot.actions[0].id, true); return true; } catch { return false; } });
    await until(() => f.runtime.snapshot(f.task.id).task.state === 'completed');
    snapshot = f.runtime.snapshot(f.task.id); assert.equal(calls, 2); assert.equal(snapshot.actions[0].state, 'succeeded');
    assert.match(continuation.find(message => message.role === 'tool').text, /harmless project/);
    assert.deepEqual(snapshot.messages.map(message => message.role), ['user', 'assistant', 'assistant']);
    assert.ok(snapshot.events.some(event => event.type === 'approval.approved'));
    f.runtime.saveDraft(f.task.id, 'Next task draft');
    const reopened = new SqliteStore(f.database); assert.equal(reopened.task(f.task.id).draft, 'Next task draft'); assert.equal(reopened.messages(f.task.id).length, 4); reopened.close();
});

test('denial continues the model with a denial result and never reads content', async t => {
    let count = 0; let result;
    const f = await fixture(t, { id: 'fake', respond: async messages => { if (++count === 1) return readReply(); result = messages.find(message => message.role === 'tool').text; return { text: 'Read denied.', calls: [] }; } });
    f.runtime.send(f.task.id, 'Read README', randomUUID()); await until(() => f.runtime.snapshot(f.task.id).task.state === 'awaiting_approval');
    const action = f.runtime.snapshot(f.task.id).actions[0]; await until(() => { try { f.runtime.decide(action.id, false); return true; } catch { return false; } });
    await until(() => f.runtime.snapshot(f.task.id).task.state === 'completed');
    assert.match(result, /denied/); assert.doesNotMatch(result, /harmless/); assert.equal(f.runtime.snapshot(f.task.id).actions[0].state, 'denied');
    assert.throws(() => f.runtime.decide(action.id, true), /no longer pending/);
});

test('stop aborts the model; a late response cannot append messages; explicit resume works', async t => {
    let resolveModel;
    let count = 0;
    const f = await fixture(t, { id: 'fake', respond: async () => { if (++count === 1) return new Promise(resolve => { resolveModel = resolve; }); return { text: 'Resumed.', calls: [] }; } });
    f.runtime.send(f.task.id, 'Start', randomUUID()); await until(() => resolveModel);
    f.runtime.cancel(f.task.id); assert.equal(f.runtime.snapshot(f.task.id).task.state, 'cancelled');
    resolveModel({ text: 'Stale result', calls: [] }); await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.runtime.snapshot(f.task.id).messages.length, 1);
    f.runtime.resume(f.task.id); await until(() => f.runtime.snapshot(f.task.id).task.state === 'completed'); assert.equal(f.runtime.snapshot(f.task.id).messages.at(-1).text, 'Resumed.');
});

test('pending approval survives restart and interrupted execution is never replayed', async t => {
    const f = await fixture(t); f.runtime.readFiles(f.task.id, ['README.md']); await until(() => f.runtime.snapshot(f.task.id).task.state === 'awaiting_approval');
    const other = new SqliteStore(f.database); const runtime = new TaskRuntime(other, scriptedProvider({ id: 'unused', respond: async () => assert.fail('Manual read must not call a model') }), f.tools, new DefaultPolicy(), new OutputSizeLimit());
    assert.equal(runtime.snapshot(f.task.id).task.state, 'awaiting_approval');
    runtime.decide(runtime.snapshot(f.task.id).actions[0].id, true); await until(() => runtime.snapshot(f.task.id).task.state === 'completed');
    const run = other.runs(f.task.id)[0]; run.state = 'running'; other.putRun(run); const action = other.actions(run.id)[0]; action.state = 'running'; other.putAction(action);
    other.recover(); assert.equal(other.run(run.id).state, 'interrupted'); assert.equal(other.action(action.id).state, 'interrupted');
    assert.equal(other.messages(f.task.id).length, 0, 'standalone read never creates a provider tool message'); runtime.shutdown(); other.close();
});

test('changed files invalidate approval; path escape, Git metadata and unknown tools are blocked', async t => {
    const f = await fixture(t); f.runtime.readFiles(f.task.id, ['README.md']); await until(() => f.runtime.snapshot(f.task.id).task.state === 'awaiting_approval');
    const action = f.runtime.snapshot(f.task.id).actions[0]; await fs.writeFile(path.join(f.project, 'README.md'), 'changed');
    await until(() => { try { f.runtime.decide(action.id, true); return true; } catch { return false; } });
    await until(() => f.runtime.snapshot(f.task.id).task.state === 'failed'); assert.match(f.runtime.snapshot(f.task.id).actions[0].readFiles[0].error, /changed/);
    await new Promise(resolve => setTimeout(resolve, 20));
    await fs.mkdir(path.join(f.project, '.git')); await fs.writeFile(path.join(f.project, '.git', 'config'), 'metadata');
    for (const file of ['../outside.md', '.git/config']) {
        f.runtime.readFiles(f.task.id, [file]); await until(() => f.runtime.snapshot(f.task.id).task.state === 'failed'); await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(f.runtime.snapshot(f.task.id).approvals.length, 1, 'blocked paths never reach approval'); assert.throws(() => f.tools.get('shell'), /not available/);
});

test('repository links are allowed only for registered roots; nested escape links are denied', async t => {
    const f = await fixture(t); const repo = path.join(f.root, 'repo'); await fs.mkdir(repo); await fs.mkdir(path.join(f.project, 'repositories'));
    await fs.writeFile(path.join(repo, 'README.md'), 'Repository text.'); await fs.symlink(repo, path.join(f.project, 'repositories', 'backend'));
    await fs.writeFile(path.join(f.project, 'project.theia-workspace'), JSON.stringify({ governedRepositories: [{ id: 'backend', path: repo }] }));
    const tool = new ReadFilesExecutor(); const context = { projectPath: f.project, signal: new AbortController().signal };
    const prepared = await tool.prepare({ paths: ['repositories/backend/README.md'] }, context); assert.match(await tool.execute({ paths: ['repositories/backend/README.md'] }, prepared, context), /Repository text/);
    await fs.writeFile(path.join(f.root, 'outside.md'), 'outside'); await fs.symlink(path.join(f.root, 'outside.md'), path.join(repo, 'escape.md'));
    await assert.rejects(() => tool.prepare({ paths: ['repositories/backend/escape.md'] }, context), /outside/);
});

test('credential-like text is unchanged in messages, model replies and approved .env reads', async t => {
    let received;
    const f = await fixture(t, { id: 'fake', respond: async messages => { received = messages; return { text: '{"password":"synthetic-example-value"}', calls: [] }; } });
    f.runtime.send(f.task.id, 'password=synthetic-example-value', randomUUID());
    await until(() => f.runtime.snapshot(f.task.id).task.state === 'completed');
    assert.equal(received[0].text, 'password=synthetic-example-value');
    assert.equal(f.runtime.snapshot(f.task.id).messages.at(-1).text, '{"password":"synthetic-example-value"}');
    await new Promise(resolve => setTimeout(resolve, 20));
    await fs.writeFile(path.join(f.project, '.env'), 'PASSWORD=synthetic-example-value');
    f.runtime.readFiles(f.task.id, ['.env']); await until(() => f.runtime.snapshot(f.task.id).task.state === 'awaiting_approval');
    await until(() => { try { f.runtime.decide(f.runtime.snapshot(f.task.id).actions[0].id, true); return true; } catch { return false; } });
    await until(() => f.runtime.snapshot(f.task.id).task.state === 'completed');
    assert.equal(JSON.parse(f.store.action(f.runtime.snapshot(f.task.id).actions[0].id).result).files[0].content, 'PASSWORD=synthetic-example-value');
    assert.equal(f.runtime.snapshot(f.task.id).actions[0].result, undefined);
    const limit = new OutputSizeLimit();
    assert.equal(limit.filter('-----BEGIN PRIVATE KEY-----'), '-----BEGIN PRIVATE KEY-----');
    assert.throws(() => limit.filter('x'.repeat(100001)), /character limit/);
});

test('OpenAI adapter handles split SSE frames, tool calls, continuation and provider errors', async () => {
    const reply = readReply('call-1'); const output = [{ type: 'reasoning', encrypted_content: 'opaque' }, ...reply.continuation]; let sent;
    const adapter = new OpenAiProvider({ streamResponse: async (...args) => {
        sent = args;
        const bytes = Buffer.from(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\r\n\r\n`);
        return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.subarray(i, i + 7)); controller.close(); } }));
    } });
    const result = await adapter.respond([{ role: 'user', text: 'Read', id: 'm', taskId: 't', createdAt: 0 }], [], 'Instructions', new AbortController().signal);
    assert.equal(result.calls[0].tool, 'files_read'); assert.equal(result.continuation[0].type, 'reasoning'); assert.equal(sent[0][0].content, 'Read');
    assert.equal(sent[4], 'auto');
    await adapter.respond([], [{ name: 'files_read', description: 'Read', parameters: {} }], 'Workflow', new AbortController().signal, { allowMessage: false });
    assert.equal(sent[4], 'required');
    const broken = new OpenAiProvider({ streamResponse: async () => new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n') });
    await assert.rejects(() => broken.respond([], [], '', new AbortController().signal), /before completion/);
});

test('provider failure is persisted and can be continued explicitly', async t => {
    let count = 0; const f = await fixture(t, { id: 'fake', respond: async () => { if (++count === 1) throw new ProviderError('Provider unavailable.'); return { text: 'Back online.', calls: [] }; } });
    f.runtime.send(f.task.id, 'Hello', randomUUID()); await until(() => f.runtime.snapshot(f.task.id).task.state === 'failed');
    assert.equal(f.runtime.snapshot(f.task.id).runs[0].error, 'Provider unavailable.'); await new Promise(resolve => setTimeout(resolve, 20));
    f.runtime.resume(f.task.id); await until(() => f.runtime.snapshot(f.task.id).task.state === 'completed'); assert.equal(f.store.runs(f.task.id).length, 2);
});

async function repositoryFixture(t, model) {
    const f = await fixture(t, model); const repo = path.join(f.root, 'repo'); await fs.mkdir(repo);
    execFileSync('git', ['init', '-q', repo]);
    await fs.mkdir(path.join(repo, 'src')); await fs.mkdir(path.join(repo, 'node_modules'));
    await fs.writeFile(path.join(repo, '.gitignore'), 'ignored.txt\n');
    await fs.writeFile(path.join(repo, 'ignored.txt'), 'marker ignored');
    await fs.writeFile(path.join(repo, '.env'), 'PASSWORD=not-for-model');
    await fs.writeFile(path.join(repo, 'config.json'), '{"password":"not-for-model","label":"marker"}');
    await fs.writeFile(path.join(repo, 'node_modules', 'index.js'), 'marker generated');
    await fs.writeFile(path.join(repo, 'src', 'main.ts'), 'const marker = "safe source";\n');
    await fs.writeFile(path.join(repo, 'src', 'tokenizer.ts'), 'const tokenizer = true;\n');
    await fs.writeFile(path.join(repo, 'guide.md'), 'A marker for the repository test.');
    await fs.writeFile(path.join(f.root, 'outside.md'), 'marker outside');
    await fs.symlink(path.join(f.root, 'outside.md'), path.join(repo, 'escape.md'));
    await fs.mkdir(path.join(f.project, 'repositories')); await fs.symlink(repo, path.join(f.project, 'repositories', 'back'));
    await fs.writeFile(path.join(f.project, 'project.theia-workspace'), JSON.stringify({ governedRepositories: [{ id: 'back', path: repo, source: 'local' }] }));
    const context = { projectPath: f.project, signal: new AbortController().signal };
    const call = async (name, args) => { const tool = f.tools.get(name); return JSON.parse(await tool.execute(args, await tool.prepare(args, context), context)); };
    return { ...f, repo, call, context };
}

test('repository tools include credential-like names/content but exclude ignored/generated/escaped paths', async t => {
    const f = await repositoryFixture(t);
    const repositories = await f.call('repositories_list', {});
    assert.deepEqual(repositories, { repositories: [{ id: 'back', path: 'repositories/back', source: 'local' }] });
    assert.doesNotMatch(JSON.stringify(repositories), new RegExp(f.root));
    const listing = await f.call('repository_list', { repository: 'back', path: '.', offset: 0 });
    assert.ok(listing.entries.some(entry => entry.name === 'src' && entry.type === 'directory'));
    assert.ok(listing.entries.some(entry => entry.name === 'guide.md'));
    assert.ok(listing.entries.some(entry => entry.name === '.env'));
    assert.ok(!listing.entries.some(entry => ['.git', 'ignored.txt', 'node_modules', 'escape.md'].includes(entry.name)));
    const paths = await f.call('repository_search', { repository: 'back', path: '.', offset: 0, query: 'MAIN', mode: 'paths' });
    assert.deepEqual(paths.matches, [{ path: 'repositories/back/src/main.ts' }]);
    const content = await f.call('repository_search', { repository: 'back', path: '.', offset: 0, query: 'marker', mode: 'content' });
    assert.deepEqual(content.matches.map(match => match.path).sort(), ['repositories/back/config.json', 'repositories/back/guide.md', 'repositories/back/src/main.ts']);
    assert.match(JSON.stringify(content), /not-for-model/);
    assert.doesNotMatch(JSON.stringify(content), /outside|ignored|generated/);
    assert.equal(content.matches.find(match => match.path.endsWith('main.ts')).line, 1);
    const named = await f.call('repository_search', { repository: 'back', path: '.', offset: 0, query: 'token', mode: 'paths' });
    assert.deepEqual(named.matches, [{ path: 'repositories/back/src/tokenizer.ts' }]);
    const environment = await f.call('repository_search', { repository: 'back', path: '.', offset: 0, query: 'PASSWORD=', mode: 'content' });
    assert.deepEqual(environment.matches, [{ path: 'repositories/back/.env', line: 1, text: 'PASSWORD=not-for-model' }]);
});

test('repository tools reject unregistered IDs, parent paths, external links and invalid parameters', async t => {
    const f = await repositoryFixture(t);
    await assert.rejects(() => f.call('repository_list', { repository: 'missing', path: '.', offset: 0 }), /not connected/);
    await assert.rejects(() => f.call('repository_list', { repository: 'back', path: '../', offset: 0 }), /traversal/);
    await assert.rejects(() => f.call('repository_list', { repository: 'back', path: '/tmp', offset: 0 }), /relative/);
    await assert.rejects(() => f.call('repository_list', { repository: 'back', path: '.git', offset: 0 }), /excluded/);
    await assert.rejects(() => f.call('repository_list', { repository: 'back', path: '.', offset: -1 }), /Offset/);
    await assert.rejects(() => f.call('repository_search', { repository: 'back', path: '.', offset: 0, query: '', mode: 'content' }), /query/);
    await assert.rejects(() => f.call('repositories_list', { root: '/tmp' }), /parameters/);
    await fs.symlink(f.root, path.join(f.repo, 'outside'));
    await assert.rejects(() => f.call('repository_list', { repository: 'back', path: 'outside', offset: 0 }), /outside/);
    assert.equal(new DefaultPolicy().check({ tool: 'repository_search', prepared: {} }), 'deny');
    assert.equal(new DefaultPolicy().check({ tool: 'files_read', prepared: { scope: 'registered-repository' } }, new ReadFilesExecutor().access), 'allow');
    assert.equal(new DefaultPolicy().check({ tool: 'files_read', prepared: { scope: 'project' } }, new ReadFilesExecutor().access), 'approve');
});

test('discovery → listing → content search → model completes without any approval prompts', async t => {
    const calls = [
        { tool: 'repositories_list', args: {} },
        { tool: 'repository_list', args: { repository: 'back', path: '.', offset: 0 } },
        { tool: 'repository_search', args: { repository: 'back', path: '.', offset: 0, query: 'marker', mode: 'content' } }
    ]; let turn = 0;
    const f = await repositoryFixture(t, { id: 'fake', respond: async messages => {
        if (turn === calls.length) { assert.match(messages.filter(message => message.role === 'tool').at(-1).text, /safe source/); return { text: 'Repository explored.', calls: [] }; }
        const call = { id: `discover-${turn}`, ...calls[turn++] };
        return { text: '', calls: [call], continuation: [{ type: 'function_call', call_id: call.id, name: call.tool, arguments: JSON.stringify(call.args) }] };
    } });
    f.runtime.send(f.task.id, 'Explore back', randomUUID());
    await until(() => f.runtime.snapshot(f.task.id).task.state === 'completed');
    const snapshot = f.runtime.snapshot(f.task.id);
    assert.equal(snapshot.actions.length, 3); assert.ok(snapshot.actions.every(action => action.state === 'succeeded'));
    assert.equal(snapshot.approvals.length, 0); assert.ok(!snapshot.events.some(event => event.type.includes('awaiting_approval')));
});

test('directory pages can be continued and missing files have an actionable error', async t => {
    const f = await repositoryFixture(t);
    await Promise.all(Array.from({ length: 205 }, (_, index) => fs.writeFile(path.join(f.repo, `page-${String(index).padStart(3, '0')}.txt`), 'page')));
    const first = await f.call('repository_list', { repository: 'back', path: '.', offset: 0 }); assert.equal(first.entries.length, 200); assert.equal(first.nextOffset, 200);
    const second = await f.call('repository_list', { repository: 'back', path: '.', offset: first.nextOffset }); assert.ok(second.entries.length > 0); assert.equal(second.nextOffset, null);
    assert.equal(new Set([...first.entries, ...second.entries].map(entry => entry.name)).size, first.entries.length + second.entries.length);
    f.runtime.readFiles(f.task.id, ['repositories/back/README.md']); await until(() => f.runtime.snapshot(f.task.id).task.state === 'failed');
    assert.match(f.runtime.snapshot(f.task.id).actions[0].error, /not found.*List the repository/);
});

test('full repository reads run automatically and return contents to the model', async t => {
    let turn = 0; let contents;
    const f = await repositoryFixture(t, { id: 'fake', respond: async messages => {
        if (++turn === 1) return { text: '', calls: [{ id: 'repo-read', tool: 'files_read', args: { paths: ['repositories/back/guide.md'] } }], continuation: [{ type: 'function_call', call_id: 'repo-read', name: 'files_read', arguments: '{"paths":["repositories/back/guide.md"]}' }] };
        contents = JSON.parse(messages.filter(message => message.role === 'tool').at(-1).text).files[0].content;
        return { text: 'Repository read completed.', calls: [] };
    } });
    f.runtime.send(f.task.id, 'Read the connected repository guide', randomUUID());
    await until(() => f.runtime.snapshot(f.task.id).task.state === 'completed');
    const snapshot = f.runtime.snapshot(f.task.id);
    assert.equal(contents, 'A marker for the repository test.'); assert.equal(snapshot.actions[0].state, 'succeeded');
    assert.equal(snapshot.approvals.length, 0); assert.ok(!snapshot.events.some(event => event.type.includes('awaiting_approval')));
});

test('automatic repository permission cannot survive registration removal or escaped links', async t => {
    const f = await repositoryFixture(t); const executor = f.tools.get('files_read'); const args = { paths: ['repositories/back/guide.md'] };
    const prepared = await executor.prepare(args, f.context); assert.equal(prepared.scope, 'registered-repository');
    await fs.writeFile(path.join(f.project, 'project.theia-workspace'), '{"governedRepositories":[]}');
    assert.match(JSON.parse(await executor.execute(args, prepared, f.context)).files[0].error, /outside/);
    await fs.writeFile(path.join(f.project, 'project.theia-workspace'), JSON.stringify({ governedRepositories: [{ id: 'back', path: f.repo }] }));
    await assert.rejects(() => executor.prepare({ paths: ['repositories/back/escape.md'] }, f.context), /outside/);
});

test('batch reads return individual results and hide all file contents from UI snapshots', async t => {
    let returned;
    const paths = ['repositories/back/guide.md', 'repositories/back/src/main.ts', 'repositories/back/missing.md'];
    let turn = 0;
    const f = await repositoryFixture(t, { id: 'fake', respond: async messages => {
        if (++turn === 1) return { text: '', calls: [{ id: 'batch-read', tool: 'files_read', args: { paths } }], continuation: [{ type: 'function_call', call_id: 'batch-read', name: 'files_read', arguments: JSON.stringify({ paths }) }] };
        returned = JSON.parse(messages.filter(message => message.role === 'tool').at(-1).text).files;
        return { text: 'Two files read; one was missing.', calls: [] };
    } });
    f.runtime.send(f.task.id, 'Read a group of files', randomUUID()); await until(() => f.runtime.snapshot(f.task.id).task.state === 'completed');
    assert.equal(returned.length, 3); assert.equal(returned[0].content, 'A marker for the repository test.'); assert.match(returned[1].content, /safe source/); assert.match(returned[2].error, /not found/);
    const snapshot = f.runtime.snapshot(f.task.id); assert.equal(snapshot.approvals.length, 0);
    assert.deepEqual(snapshot.actions[0].readFiles.map(file => file.status), ['read', 'read', 'failed']);
    assert.equal(snapshot.actions[0].result, undefined); assert.doesNotMatch(JSON.stringify(snapshot), /A marker for the repository test|const marker =/);
});

test('a mixed repository/project batch requests one approval for the whole file list', async t => {
    const f = await repositoryFixture(t);
    f.runtime.readFiles(f.task.id, ['repositories/back/guide.md', 'project.yaml']);
    await until(() => f.runtime.snapshot(f.task.id).task.state === 'awaiting_approval');
    const waiting = f.runtime.snapshot(f.task.id); assert.equal(waiting.approvals.length, 1); assert.equal(waiting.actions[0].readFiles.length, 2);
    await until(() => { try { f.runtime.decide(waiting.actions[0].id, true); return true; } catch { return false; } });
    await until(() => f.runtime.snapshot(f.task.id).task.state === 'completed');
    assert.deepEqual(f.runtime.snapshot(f.task.id).actions[0].readFiles.map(file => file.status), ['read', 'read']);
});

test('only array-shaped reads are exposed, and batches enforce count and output limits', async t => {
    const f = await repositoryFixture(t); const tool = f.tools.get('files_read');
    assert.deepEqual(Object.keys(tool.definition.parameters.properties), ['paths']);
    await assert.rejects(() => tool.prepare({ path: 'repositories/back/guide.md' }, f.context), /array/);
    await assert.rejects(() => tool.prepare({ paths: Array(21).fill('repositories/back/guide.md') }, f.context), /1–20/);
    const paths = [];
    for (let i = 0; i < 3; i++) { const name = `large-${i}.txt`; await fs.writeFile(path.join(f.repo, name), 'a'.repeat(40000)); paths.push(`repositories/back/${name}`); }
    const result = await tool.execute({ paths }, await tool.prepare({ paths }, f.context), f.context);
    assert.ok(result.length <= 90000); const files = JSON.parse(result).files;
    assert.equal(files.filter(file => file.content).length, 2); assert.match(files[2].error, /smaller batch/);
});

test('hundreds of file-read batches form one compact timeline group without crossing messages/runs', () => {
    const actions = Array.from({ length: 600 }, (_, index) => ({ id: `a-${index}`, taskId: 'task', runId: 'run', callId: `c-${index}`, tool: 'files_read', args: { paths: [`repositories/back/file-${index}.ts`] }, state: 'succeeded', result: JSON.stringify({ files: [{ path: `repositories/back/file-${index}.ts`, content: 'file content' }] }), reason: '', createdAt: index, updatedAt: index }));
    const grouped = buildTaskTimeline([], actions); assert.equal(grouped.length, 1); assert.equal(grouped[0].actions.length, 600);
    assert.deepEqual(summarizeReads(actions[0]), [{ path: 'repositories/back/file-0.ts', status: 'read', error: undefined }]);
    const message = { id: 'message', taskId: 'task', role: 'assistant', text: 'Progress update', createdAt: 299.5 };
    const split = buildTaskTimeline([message], actions); assert.deepEqual(split.map(entry => entry.kind), ['reads', 'message', 'reads']);
    const otherRun = { ...actions[0], id: 'other-run', runId: 'second', createdAt: 1000 };
    assert.equal(buildTaskTimeline([], [...actions, otherRun]).length, 2);
    const batch = { ...actions[0], args: { paths: ['a.ts', 'b.ts'] }, result: JSON.stringify({ files: [{ path: 'a.ts', content: 'source' }, { path: 'b.ts', error: 'Missing' }] }) };
    assert.deepEqual(summarizeReads(batch).map(file => file.status), ['read', 'failed']);
});

test('workflow approval is a persistent chat timeline entry', () => {
    const request = { id: 'review', key: 'workflow:understand:2', taskId: 'task', kind: 'workflow_approval',
        stepId: 'understand', revision: 2, state: 'pending', createdAt: 2 };
    const message = { id: 'report', taskId: 'task', role: 'assistant', text: 'Scope is ready for review.', createdAt: 1 };
    const pending = buildTaskTimeline([message], [], [request]);
    assert.deepEqual(pending.map(entry => entry.kind), ['message', 'interaction']);
    assert.equal(pending[1].request.id, request.id);
    assert.equal(buildTaskTimeline([message], [], [{ ...request, state: 'answered', response: { approved: true } }])[1].kind, 'interaction');
});

test('content search handles CRLF, larger UTF-8 source files, literals and match pages',async t=>{
 const f=await repositoryFixture(t);
 await fs.mkdir(path.join(f.repo,'search-pages'));
 await fs.writeFile(path.join(f.repo,'search-pages','large.ts'),'x'.repeat(70000)+'\r\nconst needle = "[a.*]";\r\n');
 const base={repository:'back',path:'search-pages',offset:0,query:'[a.*]',mode:'content'};
 let result=await f.call('repository_search',base);assert.equal(result.matches.length,1);assert.equal(result.matches[0].line,2);assert.match(result.matches[0].text,/\[a\.\*\]/);assert.equal(result.nextFileOffset,null);
 await fs.writeFile(path.join(f.repo,'search-pages','large.ts'),Array.from({length:205},(_,i)=>`needle ${i+1}`).join('\n'));
 const lines=[];let offset=0;
 do{result=await f.call('repository_search',{...base,query:'needle',offset});lines.push(...result.matches.map(match=>match.line));offset=result.nextOffset;}while(offset!==null);
 assert.deepEqual(lines,Array.from({length:205},(_,i)=>i+1));assert.equal(result.nextOffset,null);
 await fs.writeFile(path.join(f.repo,'search-pages','binary.bin'),Buffer.from([110,101,101,100,108,101,0,0]));
 await fs.writeFile(path.join(f.repo,'search-pages','too-large.txt'),'needle'.repeat(400000));
 result=await f.call('repository_search',{...base,query:'needle'});assert.ok(result.matches.every(match=>match.path.endsWith('large.ts')));assert.ok(result.skippedFiles>=1);
 await assert.rejects(()=>f.call('repository_search',{...base,fileOffset:-1}),/offset/);
});

test('content search continues beyond scan limits without skipping later files',async t=>{
 const f=await repositoryFixture(t);const directory=path.join(f.repo,'many-files');await fs.mkdir(directory);
 await Promise.all(Array.from({length:1005},(_,i)=>fs.writeFile(path.join(directory,String(i).padStart(4,'0')+'.txt'),i===1004?'later needle':'ordinary source')));
 const args={repository:'back',path:'many-files',offset:0,query:'needle',mode:'content'};
 const first=await f.call('repository_search',args);assert.equal(first.matches.length,0);assert.equal(first.scanLimited,true);assert.equal(first.nextFileOffset,1000);
 const second=await f.call('repository_search',{...args,fileOffset:first.nextFileOffset});assert.equal(second.matches.length,1);assert.match(second.matches[0].path,/1004\.txt$/);assert.equal(second.nextFileOffset,null);assert.equal(second.scanLimited,false);
});

test('bundled rg searches literal flags and Unicode paths, ignores user config and keeps output bounded',async t=>{
 const f=await repositoryFixture(t);const directory=path.join(f.repo,'space ü');await fs.mkdir(directory);
 await fs.writeFile(path.join(directory,'-flags.txt'),'--option literal\r\n');
 await fs.writeFile(path.join(directory,'long.txt'),'x'.repeat(1000000)+'needle\n');
 await fs.writeFile(path.join(directory,'late-binary.bin'),'needle\n'+String.fromCharCode(0)+'binary');
 const configuration=path.join(f.root,'rg-config');await fs.writeFile(configuration,'--glob=!**\n');const previous=process.env.RIPGREP_CONFIG_PATH;process.env.RIPGREP_CONFIG_PATH=configuration;
 t.after(()=>{if(previous===undefined)delete process.env.RIPGREP_CONFIG_PATH;else process.env.RIPGREP_CONFIG_PATH=previous;});
 const args={repository:'back',path:'space ü',offset:0,query:'--option',mode:'content'};const literal=await f.call('repository_search',args);
 assert.equal(literal.executor,'ripgrep');assert.equal(literal.matches.length,1);assert.match(literal.matches[0].path,/-flags\.txt$/);
 const result=await f.call('repository_search',{...args,query:'needle'});assert.equal(result.matches.length,1);assert.match(result.matches[0].path,/long\.txt$/);assert.ok(result.matches[0].text.length<=320);assert.ok(JSON.stringify(result).length<2000);
});
