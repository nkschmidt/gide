const { scriptedProvider } = require('./scripted-provider.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TaskRuntime } = require('../lib/node/harness/core/runtime');
const { ToolRegistry } = require('../lib/node/harness/core/contracts');
const { SqliteStore } = require('../lib/node/harness/storage/sqlite-store');
const { DefaultPolicy, OutputSizeLimit } = require('../lib/node/harness/modules/file-tools');
const { AskUserTool } = require('../lib/node/harness/modules/question-tool');
const { questionAnswer } = require('../lib/node/harness/core/interactions');
const question = { question: 'Какую базу использовать?', options: [{ id: 'local', label: 'Локальный master', description: 'Продолжить с текущим локальным коммитом.' }, { id: 'refresh', label: 'Сначала обновить', description: 'Я самостоятельно обновлю базу.' }] };
const reply = () => ({ text: question.question, calls: [{ id: 'question-call', tool: 'ask_user', args: question }], continuation: [{ type: 'function_call', call_id: 'question-call', name: 'ask_user', arguments: JSON.stringify(question) }] });
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) { await new Promise(r => setTimeout(r, 5)); return; } await new Promise(r => setTimeout(r, 5)); } assert.fail('Expected task state'); }
async function fixture(t, provider) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'governed-question-')); const database = path.join(root, 'tasks.sqlite');
    const tools = new ToolRegistry(); tools.register(new AskUserTool()); let store = new SqliteStore(database);
    const create = () => new TaskRuntime(store, scriptedProvider(provider), tools, new DefaultPolicy(), new OutputSizeLimit()); let runtime = create();
    const task = runtime.create(root);
    t.after(async () => { runtime.shutdown(); await new Promise(r => setTimeout(r, 30)); store.close(); await fs.rm(root, { recursive: true, force: true }); });
    return { get store() { return store; }, get runtime() { return runtime; }, task, restart() { runtime.shutdown(); store.close(); store = new SqliteStore(database); runtime = create(); } };
}
test('question pauses before further model calls, survives restart, and returns the exact selected answer once', async t => {
    let turns = 0; let result; const f = await fixture(t, { id: 'test', respond: async messages => { turns++; if (turns === 1) return reply(); result = JSON.parse(messages.find(m => m.role === 'tool').text); return { text: 'Continuing with your answer.', calls: [] }; } });
    f.runtime.send(f.task.id, 'Start synthetic task', 'first'); await until(() => f.store.task(f.task.id).state === 'waiting_input');
    const action = f.runtime.snapshot(f.task.id).actions[0]; const interaction = f.runtime.snapshot(f.task.id).interactions.find(item => item.kind === 'question'); assert.equal(action.state, 'waiting'); assert.equal(turns, 1); assert.equal(f.runtime.snapshot(f.task.id).approvals.length, 0);
    assert.ok(!f.runtime.snapshot(f.task.id).messages.some(message => message.text === question.question), 'questions appear only in their card, without duplicate ordinary messages');
    assert.throws(() => f.runtime.resume(f.task.id), /pending question/);
    await assert.rejects(() => f.runtime.respondInteraction(interaction.id, { optionId: 'invented' }), /does not belong/);
    f.restart(); assert.equal(f.runtime.snapshot(f.task.id).actions[0].state, 'waiting'); assert.equal(turns, 1);
    await f.runtime.respondInteraction(interaction.id, { optionId: 'local' }); await f.runtime.respondInteraction(interaction.id, { optionId: 'local' });
    await until(() => f.store.task(f.task.id).state === 'completed');
    assert.equal(turns, 2); assert.equal(result.optionId, 'local'); assert.equal(result.text, question.options[0].label); assert.equal(result.question, question.question);
    assert.equal(f.store.messages(f.task.id).filter(m => m.id === `answer:${interaction.id}`).length, 1);
    await assert.rejects(() => f.runtime.respondInteraction(interaction.id, { optionId: 'refresh' }), /no longer/);
    assert.equal(f.store.runs(f.task.id).length, 1);
});
test('normal composer text answers the pending question, preserves the current workflow step, and retries do not duplicate it', async t => {
    let turns = 0; let modelMessages; const f = await fixture(t, { id: 'test', respond: async messages => { if (!turns++) return reply(); modelMessages = messages; return { text: '', calls: [{ id: 'followup-call', tool: 'ask_user', args: { question: 'Anything else?', options: [] } }] }; } });
    const task = f.store.task(f.task.id); task.workflow = { id: 'custom', name: 'Custom', steps: [{ id: 'prepare' }], index: 0, phase: 'active', results: [], revision: 1 }; f.store.putTask(task);
    f.runtime.send(task.id, 'Start', 'first'); await until(() => f.store.task(task.id).state === 'waiting_input');
    f.runtime.send(task.id, 'Я сначала обновлю master и сообщу.', 'custom-answer'); f.runtime.send(task.id, 'Я сначала обновлю master и сообщу.', 'custom-answer');
    await until(() => turns === 2 && f.store.task(task.id).state === 'waiting_input');
    assert.equal(JSON.parse(modelMessages.find(m => m.role === 'tool').text).text, 'Я сначала обновлю master и сообщу.');
    assert.equal(f.store.messages(task.id).filter(m => m.id === `user:${task.id}:custom-answer`).length, 1);
    assert.equal(f.store.task(task.id).workflow.index, 0); assert.equal(f.store.task(task.id).workflow.results.length, 0);
});
test('cancelled questions reject later answers and emit a tool result for explicit continuation', async t => {
    const f = await fixture(t, { id: 'test', respond: async () => reply() });
    f.runtime.send(f.task.id, 'Start', 'first'); await until(() => f.store.task(f.task.id).state === 'waiting_input');
    const action = f.runtime.snapshot(f.task.id).actions[0]; const interaction = f.runtime.snapshot(f.task.id).interactions.find(item => item.kind === 'question'); f.runtime.cancel(f.task.id);
    assert.equal(f.store.task(f.task.id).state, 'cancelled'); assert.equal(f.store.action(action.id).state, 'cancelled');
    await assert.rejects(() => f.runtime.respondInteraction(interaction.id, { optionId: 'local' }), /no longer/);
    assert.ok(f.store.messages(f.task.id).some(m => m.role === 'tool' && m.callId === 'question-call'));
});
test('questions validate bounded distinct options and cannot be combined with other model tool calls', async t => {
    const tool = new AskUserTool();
    await assert.rejects(() => tool.prepare({ ...question, options: [question.options[0], question.options[0]] }), /distinct/);
    await assert.rejects(() => tool.prepare({ ...question, options: [question.options[0]] }), /2–5/);
    assert.throws(() => questionAnswer(question, { optionId: 'local', text: 'both' }), /Choose/);
    assert.throws(() => questionAnswer(question, { text: ' ' }), /Enter/);
    assert.equal(tool.available({ purpose: 'repository-analysis' }), false);
    const f = await fixture(t, { id: 'test', respond: async () => ({ ...reply(), calls: [...reply().calls, { id: 'other', tool: 'ask_user', args: question }] }) });
    f.runtime.send(f.task.id, 'Start', 'first'); await until(() => f.store.task(f.task.id).state === 'failed');
    assert.equal(f.runtime.snapshot(f.task.id).actions.length, 0);
});

test('an invalid explicit provider outcome fails validation without a correction loop', async t => {
    let calls = 0; const f = await fixture(t, { id: 'invalid', respond: async () => { calls++; return { outcome: 'actions', text: 'Not an action', calls: [] }; } });
    f.runtime.send(f.task.id, 'Start', 'first'); await until(() => f.store.task(f.task.id).state === 'failed');
    assert.equal(calls, 1); assert.match(f.runtime.snapshot(f.task.id).runs[0].error, /turn outcome/);
    assert.equal(f.store.interactions(f.task.id).length, 0);
});
