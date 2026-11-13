require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { SqliteStore } = require('../lib/node/harness/storage/sqlite-store');
const { ToolRegistry } = require('../lib/node/harness/core/contracts');
const { WorkflowEngine } = require('../lib/node/harness/core/workflow-engine');
const { TaskRuntime } = require('../lib/node/harness/core/runtime');
const { DefaultPolicy, OutputSizeLimit } = require('../lib/node/harness/modules/file-tools');
const { AskUserTool } = require('../lib/node/harness/modules/question-tool');
const { registerTaskMemoryTools } = require('../lib/node/harness/modules/task-memory-tools');
const { scriptedProvider } = require('./scripted-provider.cjs');

const step = id => ({ id, title: id, instructions: 'Review the change.', definitionOfReady: [], definitionOfDone: [], tools: [], enabled: true, approval: false });
const document = (id, name, nextWorkflows = []) => ({ schemaVersion: 5, id, name, description: '', revision: 1, updatedAt: 1, nextWorkflows, steps: [step('review')] });
const until = async check => {
    for (let i = 0; i < 150; i++) {
        if (check()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Expected state not reached');
};

test('follow-up starts the selected workflow once, links bounded source context and keeps approvals independent', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'governed-follow-up-'));
    const database = path.join(root, 'tasks.sqlite');
    const store = new SqliteStore(database);
    let runtime;
    t.after(async () => { runtime?.shutdown(); await new Promise(resolve => setTimeout(resolve, 20)); store.close(); await fs.rm(root, { recursive: true, force: true }); });
    const docs = { development: document('development', 'Development', ['code-review']), 'code-review': document('code-review', 'Code Review') };
    const definitions = { get: async (_project, id) => {
        if (!docs[id]) throw new Error('Workflow not found.');
        return structuredClone(docs[id]);
    } };
    const registry = new ToolRegistry();
    const engine = new WorkflowEngine(store, definitions, registry);
    engine.register(registry);
    registry.register(new AskUserTool());
    registerTaskMemoryTools(registry, store);
    let calls = 0;
    let instructions = '';
    const provider = scriptedProvider({ id: 'follow-up-fixture', respond: async (_messages, _tools, text) => {
        calls++;
        instructions = text;
        return { text: '', calls: [{ id: 'review-question', tool: 'ask_user', args: { question: 'Which scenario matters most?', options: [] } }] };
    } });
    runtime = new TaskRuntime(store, provider, registry, new DefaultPolicy(), new OutputSizeLimit(), undefined, engine);
    const source = runtime.create(root);
    source.title = 'Update Docker';
    source.state = 'completed';
    source.closedAt = Date.now();
    source.workflowMode = 'selected';
    source.workflow = {
        ...engine.snapshot(docs.development), phase: 'completed', index: 1,
        branches: { back: { base: 'main', branch: 'feature/docker', head: 'base-commit' } },
        results: [{ stepId: 'review', revision: 2, summary: 'Docker was updated and verified.', approvedAt: 1,
            ready: [], done: [], artifacts: [{ path: 'changesets/docker.md', digest: 'approved-plan' }] }]
    };
    store.putTask(source);
    store.putMessage({ id: 'original', taskId: source.id, role: 'user', text: 'Update Node in Docker.', createdAt: 1 });
    const foreign = runtime.create(root);
    store.putMessage({ id: 'foreign-message', taskId: foreign.id, role: 'user', text: 'Other private task', createdAt: 1 });

    assert.deepEqual((await runtime.followUpOptions(source.id)).map(item => item.id), ['code-review']);
    await assert.rejects(() => runtime.startFollowUp(foreign.id, 'code-review', 'active-task'), /Complete this task/);
    await assert.rejects(() => runtime.startFollowUp(source.id, 'missing', 'bad-target'), /not configured/);

    const [first, retry] = await Promise.all([
        runtime.startFollowUp(source.id, 'code-review', 'same-click'),
        runtime.startFollowUp(source.id, 'code-review', 'same-click')
    ]);
    assert.equal(first.id, retry.id);
    await until(() => store.task(first.id).state === 'waiting_input');
    assert.equal(calls, 1);
    const child = store.task(first.id);
    assert.equal(child.workflow.id, 'code-review');
    assert.equal(child.workflow.index, 0);
    assert.equal(child.workflow.phase, 'active');
    assert.deepEqual(child.workflow.branches, {});
    assert.deepEqual(child.workflow.results, []);
    assert.equal(child.workflow.ready, undefined);
    assert.equal(child.origin.taskId, source.id);
    assert.equal(store.task(source.id).closedAt, source.closedAt);
    assert.match(instructions, /Docker was updated and verified/);
    assert.match(instructions, /sourceTaskId/);
    assert.equal(store.messageRecords(child.id).filter(message => message.role === 'user').length, 1);

    const context = { projectPath: root, taskId: child.id, signal: new AbortController().signal };
    const reader = registry.get('task_memory_read_source');
    const read = async (resource, id) => {
        const args = { resource, id, offset: 0, limit: 12000 };
        return JSON.parse(await reader.execute(args, await reader.prepare(args, context), context));
    };
    assert.equal(JSON.parse((await read('step', 'review')).text).summary, source.workflow.results[0].summary);
    assert.equal((await read('message', 'original')).text, 'Update Node in Docker.');
    await assert.rejects(() => read('message', 'foreign-message'), /not found/);

    const copiedRevision = child.workflow.definitionRevision;
    docs['code-review'].revision++;
    docs['code-review'].steps[0].instructions = 'Changed future definition.';
    assert.equal(store.task(child.id).workflow.definitionRevision, copiedRevision);
    assert.equal((await runtime.startFollowUp(source.id, 'code-review', 'same-click')).id, child.id);
    docs.development.nextWorkflows = [];
    assert.deepEqual(await runtime.followUpOptions(source.id), []);
    await assert.rejects(() => runtime.startFollowUp(source.id, 'code-review', 'new-click'), /not configured/);
    assert.equal((await runtime.startFollowUp(source.id, 'code-review', 'same-click')).id, child.id);
    const reopened = new SqliteStore(database);
    assert.equal(reopened.task(child.id).origin.taskId, source.id);
    reopened.close();
});
