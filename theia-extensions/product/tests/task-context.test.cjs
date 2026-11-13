const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'); const os = require('node:os'); const path = require('node:path');
const { SqliteStore } = require('../lib/node/harness/storage/sqlite-store');
const { TaskContextManager, ModelTaskSummarizer, BpeTokenCounter } = require('../lib/node/harness/core/task-context');
const { historyBoundaries } = require('../lib/node/harness/core/task-memory-history');
const { registerTaskMemoryTools } = require('../lib/node/harness/modules/task-memory-tools');
const { ToolRegistry } = require('../lib/node/harness/core/contracts');
const { modelInput } = require('../lib/node/harness/core/model-input');
const counter = { id: 'fixture-counter', count: text => Math.ceil(text.length / 4) };
const budget = { windowTokens: 12000, reserveTokens: 2000, triggerRatio: .7, targetRatio: .45, batchTokens: 7000, summaryTokens: 1000, recentMessages: 6, resultCharacters: 1000 };
const summary = sources => ({ goal: { text: 'Implement the requested change; preserve the user constraints.', refs: [sources[0].id] }, requirements: [], decisions: [], progress: [], verification: [], openQuestions: [], nextSteps: [] });
async function fixture(t) {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'governed-task-context-')); const file = path.join(root, 'tasks.sqlite'); const store = new SqliteStore(file);
 const task = { id: crypto.randomUUID(), projectPath: root, title: 'Context test', state: 'idle', draft: '', createdAt: 1, updatedAt: 1 }; store.putTask(task);
 t.after(async () => { try { store.close(); } catch {} await fs.rm(root, { recursive: true, force: true }); });
 const message = (id, role, text, more = {}) => { const item = { id, taskId: task.id, role, text, createdAt: Date.now(), ...more }; store.putMessage(item); return item; };
 return { root, file, store, task, message };
}
function history(f, count = 70) { for (let n = 0; n < count; n++) f.message(`m${n}`, n % 2 ? 'assistant' : 'user', `${n}: ${'The requested behavior and evidence are described here. '.repeat(20)}`); }

test('full tool results are stored once, shared by action and message, and recovered losslessly', async t => {
 const f = await fixture(t); const run = { id: 'r', taskId: f.task.id, kind: 'model', state: 'completed', steps: 1, createdAt: 1, updatedAt: 1 }; f.store.putRun(run);
 const output = JSON.stringify({ output: 'full output\n'.repeat(1000), exitCode: 1 });
 f.store.putAction({ id: 'a', taskId: f.task.id, runId: 'r', callId: 'c', tool: 'test', args: {}, state: 'succeeded', reason: '', result: output, createdAt: 1, updatedAt: 1 });
 f.message('result:a', 'tool', output, { callId: 'c', runId: 'r' });
 const record = f.store.messageRecords(f.task.id)[0]; assert.equal(record.text, ''); assert.ok(record.resultRef);
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM task_results').get().n, 1); assert.equal(f.store.action('a').result, output); assert.equal(f.store.messages(f.task.id)[0].text, output);
 const reopened = new SqliteStore(f.file); assert.equal(reopened.result(f.task.id, record.resultRef).text, output); reopened.close();
 const other = { ...f.task, id: 'other' }; f.store.putTask(other); assert.throws(() => f.store.result(other.id, record.resultRef), /not found/);
});

test('database update normalizes existing results without changing message order or losing text', async t => {
 const f = await fixture(t); f.message('u', 'user', 'Original request.');
 const old = { id: 'old-result', taskId: f.task.id, role: 'tool', callId: 'old-call', text: 'Original full result. '.repeat(1000), createdAt: 2 };
 f.store.db.prepare('INSERT INTO messages VALUES(?,?,?)').run(old.id, old.taskId, JSON.stringify(old)); f.store.db.exec('PRAGMA user_version=5');
 const reopened = new SqliteStore(f.file); assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version,6);
 const records = reopened.messageRecords(f.task.id); assert.deepEqual(records.map(message => message.id), ['u','old-result']); assert.ok(records[1].resultRef); assert.equal(records[1].text,''); assert.equal(reopened.messages(f.task.id)[1].text,old.text); reopened.close();
});

test('checkpoints preserve full history, pin the original request, survive recovery, and do not rerun tools', async t => {
 const f = await fixture(t); history(f); const original = f.store.messages(f.task.id); let calls = 0;
 const state = { ...f.task, workflow: { id: 'fixture', index: 3, phase: 'active', revision: 7, branches: { back: { branch: 'feature/existing', base: 'main', head: 'recorded-head' } }, results: [{ approvedAt: 1, artifacts: [{ path: 'changesets/approved.md', digest: 'approved-digest' }] }], steps: [] } }; f.store.putTask(state);
 const manager = new TaskContextManager(f.store, { summarize: async (_previous, sources) => { calls++; return summary(sources); } }, counter, budget);
 const projected = await manager.prepare(f.task, [], 'Instructions', new AbortController().signal); const checkpoint = f.store.checkpoint(f.task.id);
 assert.ok(checkpoint); assert.ok(calls > 0); assert.equal(projected[0].id, 'm0'); assert.ok(projected.some(message => message.id === checkpoint.id));
 assert.deepEqual(f.store.messages(f.task.id), original); assert.deepEqual(f.store.task(f.task.id), state); assert.ok(projected.length < original.length); assert.deepEqual(f.store.runs(f.task.id), []);
 const reopened = new SqliteStore(f.file); let repeated = 0; const next = new TaskContextManager(reopened, { summarize: async () => { repeated++; throw new Error('unexpected'); } }, counter, budget);
 await next.prepare(f.task, [], 'Instructions', new AbortController().signal); assert.equal(repeated, 0); assert.equal(reopened.checkpoint(f.task.id).id, checkpoint.id); reopened.close();
});

test('concurrent summary builders cannot overwrite an already committed checkpoint', async t => {
 const f = await fixture(t); history(f); let release; let entered;
 const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
 const first = new TaskContextManager(f.store, { summarize: async (_prev, sources) => { entered(); await gate; return summary(sources); } }, counter, budget);
 const pending = first.prepare(f.task, [], '', new AbortController().signal); await started;
 const second = new TaskContextManager(f.store, { summarize: async (_prev, sources) => summary(sources) }, counter, budget); await second.prepare(f.task, [], '', new AbortController().signal); const head = f.store.checkpoint(f.task.id);
 release(); await assert.rejects(() => pending, /changed while preparing/); assert.equal(f.store.checkpoint(f.task.id).id, head.id);
});

test('large execution previews retain real failure status and output ahead of source metadata', () => {
 const { BoundedTaskResultView } = require('../lib/node/harness/core/task-result-view');
 const raw = JSON.stringify({ id: 'job', state: 'failed', sourceBefore: 'source observations '.repeat(5000), exitCode: 1, output: 'Cannot connect to the Docker daemon.', sourceChanged: false });
 const view = JSON.parse(new BoundedTaskResultView().project(raw, 'result:source', 1000));
 assert.equal(view.excerpt.exitCode, 1); assert.equal(view.excerpt.state, 'failed'); assert.match(view.excerpt.output, /Docker daemon/); assert.equal(view.resultRef, 'result:source'); assert.ok(JSON.stringify(view).length < 2000);
});

test('failed or cancelled summarization preserves the current checkpoint and complete transcript', async t => {
 const f = await fixture(t); history(f); let fail = false;
 const manager = new TaskContextManager(f.store, { summarize: async (_prev, sources) => { if (fail) throw new Error('provider unavailable'); return summary(sources); } }, counter, budget);
 await manager.prepare(f.task, [], '', new AbortController().signal); const head = f.store.checkpoint(f.task.id);
 for (let n = 70; n < 140; n++) f.message(`m${n}`, 'user', 'A subsequent requirement. '.repeat(50)); fail = true;
 const original = f.store.messages(f.task.id); await assert.rejects(() => manager.prepare(f.task, [], '', new AbortController().signal), /Could not prepare task memory/);
 assert.equal(f.store.checkpoint(f.task.id).id, head.id); assert.deepEqual(f.store.messages(f.task.id), original);
 const abort = new AbortController(); const cancelled = new TaskContextManager(f.store, { summarize: async (_prev, sources) => { abort.abort(); return summary(sources); } }, counter, budget);
 await assert.rejects(() => cancelled.prepare(f.task, [], '', abort.signal), /abort/i); assert.equal(f.store.checkpoint(f.task.id).id, head.id);
});

test('appended messages remain fresh, stale source rewrites cannot commit, and references cannot escape the task', async t => {
 const f = await fixture(t); history(f); let appended = false;
 const manager = new TaskContextManager(f.store, { summarize: async (_prev, sources) => { if (!appended) { appended = true; f.message('newest', 'user', 'An important new requirement arrived while preparing context.'); } return summary(sources); } }, counter, budget);
 const projected = await manager.prepare(f.task, [], '', new AbortController().signal); assert.equal(projected.at(-1).id, 'newest');
 const head = f.store.checkpoint(f.task.id); for (let n = 70; n < 140; n++) f.message(`m${n}`, 'user', 'More requirements. '.repeat(70));
 const badRefs = new TaskContextManager(f.store, { summarize: async (_prev, sources) => ({ ...summary(sources), goal: { text: 'Other task', refs: ['foreign-task-message'] } }) }, counter, budget);
 await assert.rejects(() => badRefs.prepare(f.task, [], '', new AbortController().signal), /source references/); assert.equal(f.store.checkpoint(f.task.id).id, head.id);
 const stale = new TaskContextManager(f.store, { summarize: async (_prev, sources) => { f.message(sources[0].id, 'user', 'Source changed during preparation.'); return summary(sources); } }, counter, budget);
 await assert.rejects(() => stale.prepare(f.task, [], '', new AbortController().signal), /changed while preparing/); assert.equal(f.store.checkpoint(f.task.id).id, head.id);
});

test('checkpoint boundaries and projections preserve complete tool-call/result pairs and bound large output', async t => {
 const f = await fixture(t); f.message('u', 'user', 'Inspect the repository.');
 f.message('a', 'assistant', '', { continuation: [{ type: 'reasoning', encrypted_content: 'opaque' }, { type: 'function_call', call_id: 'one', name: 'read', arguments: '{}' }, { type: 'function_call', call_id: 'two', name: 'read', arguments: '{}' }] });
 f.message('o1', 'tool', 'x'.repeat(10000), { callId: 'one' }); f.message('o2', 'tool', 'second result', { callId: 'two' });
 assert.deepEqual(historyBoundaries(f.store.messageRecords(f.task.id)), [1, 4]);
 const manager = new TaskContextManager(f.store, { summarize: async () => { throw new Error('not needed'); } }, counter, budget);
 const projected = await manager.prepare(f.task, [], '', new AbortController().signal); const wire = modelInput(projected);
 assert.equal(wire.filter(item => item.type === 'function_call').length, 2); assert.equal(wire.filter(item => item.type === 'function_call_output').length, 2);
 const partial = JSON.parse(projected.find(message => message.id === 'o1').text); assert.equal(partial.truncated, true); assert.equal(f.store.result(f.task.id, partial.resultRef).text.length, 10000); assert.ok(partial.excerpt.length <= 1000);
});

test('memory tools provide paged exact data, search, and neighborhoods inside this task only', async t => {
 const f = await fixture(t); f.message('decision', 'user', 'Use the existing architecture; do not add a dependency.'); f.message('result', 'tool', 'LOG '.repeat(10000), { callId: 'call' });
 const foreign = { ...f.task, id: 'foreign' }; f.store.putTask(foreign); f.store.putMessage({ id: 'foreign-message', taskId: foreign.id, role: 'user', text: 'private foreign data', createdAt: 1 });
 const tools = new ToolRegistry(); registerTaskMemoryTools(tools, f.store); const context = { taskId: f.task.id, projectPath: f.root, signal: new AbortController().signal };
 const invoke = async (name, args, ctx = context) => { const executor = tools.get(name); return JSON.parse(await executor.execute(args, await executor.prepare(args, ctx), ctx)); };
 const found = await invoke('task_memory_search', { query: 'dependency', offset: 0, limit: 10 }); assert.equal(found.matches[0].id, 'decision');
 const ref = f.store.messageRecords(f.task.id).find(message => message.id === 'result').resultRef;
 const page = await invoke('task_memory_read_result', { id: ref, offset: 4, limit: 100 }); assert.equal(page.text, 'LOG '.repeat(25)); assert.equal(page.nextOffset, 104);
 const near = await invoke('task_memory_read_range', { anchor: 'decision', before: 0, after: 1 }); assert.equal(near.messages.length, 2);
 const step = { id: 'study', title: 'Study', instructions: 'Study the project.', definitionOfReady: [], definitionOfDone: [], tools: [], approval: false, enabled: true };
 const previousReport = { stepId: 'study', revision: 2, summary: 'Detailed historical architecture findings retained on demand.', ready: [], done: [], artifacts: [] };
 f.task.workflow = { id: 'test', name: 'Test', index: 1, phase: 'active', revision: 3, steps: [step, { ...step, id: 'implement' }], results: [previousReport], branches: {} };
 f.store.putTask(f.task);
 const report = await invoke('task_memory_read_step', { id: 'study', offset: 0, limit: 12000 });
 assert.equal(JSON.parse(report.text).summary, previousReport.summary);
 await assert.rejects(() => invoke('task_memory_read_step', { id: 'missing', offset: 0, limit: 100 }), /not found/);
 await assert.rejects(() => invoke('task_memory_read_step', { id: 'study', offset: 0, limit: 100 }, { ...context, taskId: foreign.id }), /not found/);
 const { WorkflowEngine } = require('../lib/node/harness/core/workflow-engine');
 const instructions = await new WorkflowEngine(f.store, {}, tools).instructions(f.task);
 assert.ok(instructions.includes('"step":"study"'));
 assert.ok(!instructions.includes(previousReport.summary));

 await assert.rejects(() => invoke('task_memory_read', { id: 'foreign-message', offset: 0, limit: 100 }), /not found/);
 await assert.rejects(() => invoke('task_memory_read', { id: 'decision', offset: 0, limit: 12001 }), /limit/);
 await assert.rejects(() => invoke('task_memory_search', { query: 'private', offset: 0, limit: 10 }, { ...context, projectPath: '/different-project' }), /limited/);
 assert.equal((await invoke('task_memory_search', { query: 'private', offset: 0, limit: 10 })).matches.length, 0);
 f.message('receipt', 'user', 'The engine recorded the actual approval.', { providerOnly: true });
 f.message('function', 'assistant', '', { providerOnly: true, continuation: [{ type: 'reasoning', encrypted_content: 'opaque-secret-reasoning' }, { type: 'function_call', call_id: 'history-call', name: 'read', arguments: '{"path":"file.ts"}' }] });
 assert.match((await invoke('task_memory_read', { id: 'receipt', offset: 0, limit: 1000 })).text, /actual approval/);
 const call = await invoke('task_memory_read', { id: 'function', offset: 0, limit: 1000 }); assert.match(call.text, /file.ts/); assert.doesNotMatch(call.text, /opaque-secret-reasoning/);
});

test('summary adapter has only one non-executable output tool, and budget counts multilingual text with BPE', async () => {
 const sources = [{ id: 'm', role: 'user', text: 'Добавить поиск по товарам.' }]; let received;
 const summarizer = new ModelTaskSummarizer({ id: 'fixture', respond: async (...args) => { received = args; return { outcome: 'actions', text: '', calls: [{ id: 'c', tool: 'submit_task_summary', args: summary(sources) }] }; } });
 assert.deepEqual(await summarizer.summarize(undefined, sources, new AbortController().signal), summary(sources)); assert.deepEqual(received[1].map(tool => tool.name), ['submit_task_summary']); assert.equal(received[4].allowMessage, false);
 const bpe = new BpeTokenCounter(); assert.ok(bpe.count('Добавить поиск по товарам.') > 0); assert.ok(bpe.count('<|endoftext|>') > 0);
});

test('runtime reports memory preparation failures explicitly and retry does not replay completed actions', async t => {
 const f = await fixture(t); history(f); const { TaskRuntime } = require('../lib/node/harness/core/runtime'); const { DefaultPolicy, OutputSizeLimit } = require('../lib/node/harness/modules/file-tools');
 let fail = true; let modelCalls = 0;
 const memory = new TaskContextManager(f.store, { summarize: async (_previous, sources) => { if (fail) throw new Error('summary failure'); return summary(sources); } }, counter, { ...budget, windowTokens: 20000, batchTokens: 9000 });
 f.store.putRun({ id: 'completed-run', taskId: f.task.id, state: 'completed', kind: 'model', steps: 1, createdAt: 1, updatedAt: 1 });
 f.store.putAction({ id: 'completed-action', taskId: f.task.id, runId: 'completed-run', callId: 'completed-call', tool: 'mutation', args: {}, state: 'succeeded', reason: '', result: 'Performed once.', createdAt: 1, updatedAt: 1 });
 const runtime = new TaskRuntime(f.store, { id: 'fixture', respond: async () => { modelCalls++; return { outcome: 'message', text: 'Continued using task memory.', calls: [] }; } }, new ToolRegistry(), new DefaultPolicy(), new OutputSizeLimit(), undefined, undefined, memory);
 t.after(() => runtime.shutdown());
 const until = async predicate => { for (let n = 0; n < 300; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('Runtime did not settle.'); };
 runtime.send(f.task.id, 'Retry verification after starting the environment.', 'retry'); await until(() => f.store.task(f.task.id).state === 'failed');
 assert.match(f.store.runs(f.task.id).at(-1).error, /Could not prepare task memory/); assert.equal(modelCalls, 0); assert.equal(f.store.action('completed-action').state, 'succeeded');
 fail = false; runtime.resume(f.task.id); await until(() => f.store.task(f.task.id).state === 'completed'); assert.equal(modelCalls, 1);
 assert.equal(f.store.runs(f.task.id).flatMap(run => f.store.actions(run.id)).length, 1); assert.ok(f.store.checkpoint(f.task.id).version >= 1);
});
