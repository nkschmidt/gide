const { scriptedProvider } = require('./scripted-provider.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { SqliteStore } = require('../lib/node/harness/storage/sqlite-store');
const { TaskRuntime } = require('../lib/node/harness/core/runtime');
const { WorkflowEngine } = require('../lib/node/harness/core/workflow-engine');
const { ToolRegistry } = require('../lib/node/harness/core/contracts');
const { DefaultPolicy, OutputSizeLimit, ReadFilesExecutor } = require('../lib/node/harness/modules/file-tools');
const { registerGitTools, gitRoot, gitState } = require('../lib/node/harness/modules/git-tools');
const { registerWriteTools } = require('../lib/node/harness/modules/write-tools');
const { hashText } = require('../lib/node/harness/modules/changesets');
const { AskUserTool } = require('../lib/node/harness/modules/question-tool');
const step = (id, operations = [], approval = false) => ({ id, title: id, instructions: `Perform ${id}.`, definitionOfReady: [], definitionOfDone: [], enabled: true, operations, approval });
function call(tool, args) { const id = randomUUID(); return { text: '', calls: [{ id, tool, args }], continuation: [{ type: 'function_call', call_id: id, name: tool, arguments: JSON.stringify(args) }] }; }
const report = (summary = 'Step result.', criteria = [], artifacts = []) => ({ status: 'completed', summary, criteria, artifacts });
async function until(check) { for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('Expected state was not reached'); }
async function fixture(t, steps, respond, observers = []) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'governed-workflow-runtime-')); const project = path.join(root, 'project'); const repo = path.join(root, 'repo');
    await fs.mkdir(path.join(project, 'repositories'), { recursive: true }); await fs.mkdir(repo);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]); await fs.writeFile(path.join(repo, 'app.ts'), 'export const value = 1;\n');
    execFileSync('git', ['-C', repo, 'add', 'app.ts']); execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Initial']);
    await fs.symlink(repo, path.join(project, 'repositories', 'back'));
    await fs.writeFile(path.join(project, 'project.theia-workspace'), JSON.stringify({ folders: [{ path: '.' }], governedRepositories: [{ id: 'back', path: repo }] }));
    const database = path.join(root, 'tasks.sqlite'); const store = new SqliteStore(database);
    const definition = { schemaVersion: 5, id: 'custom', name: 'Custom process', description: '', revision: 1, updatedAt: 1, steps };
    const definitions = { get: async (_project, id) => { if (id !== 'custom') throw new Error('Unknown workflow'); return structuredClone(definition); }, list: async () => [{ id: 'custom', name: 'Custom process', description: '', stepCount: steps.length, updatedAt: 1 }] };
    const tools = new ToolRegistry(); tools.register(new AskUserTool()); const engine = new WorkflowEngine(store, definitions, tools, observers); engine.register(tools); tools.register(new ReadFilesExecutor()); registerGitTools(tools, engine); registerWriteTools(tools, engine);
    for (const item of steps) { if (item.tools === undefined) item.tools = tools.catalog().filter(entry => !entry.executor.workflowOperations?.length || entry.executor.workflowOperations.every(operation => item.operations?.includes(operation))).map(entry => entry.executor.definition.name); delete item.operations; }
    const runtime = new TaskRuntime(store, scriptedProvider({ id: 'fake', respond: respond || (async () => ({ text: 'Need clarification.', calls: [] })) }), tools, new DefaultPolicy(), new OutputSizeLimit(), undefined, engine);
    const task = runtime.create(project); const context = { projectPath: project, taskId: task.id, signal: new AbortController().signal, purpose: 'chat' };
    const execute = async (name, args) => { const tool = tools.get(name); const prepared = await tool.prepare(args, context); return JSON.parse(await tool.execute(args, prepared, context)); };
    t.after(async () => { runtime.shutdown(); await new Promise(resolve => setTimeout(resolve, 40)); store.close(); await fs.rm(root, { recursive: true, force: true }); });
    return { root, project, repo, database, store, definition, definitions, tools, engine, runtime, task, context, execute };
}

test('clarification pauses the same step, approval survives recovery, and workflow definitions are snapshotted', async t => {
    const first = { ...step('clarify', [], true), definitionOfReady: ['Request available.'], definitionOfDone: ['Scope is clear.'] }; let turns = 0;
    const f = await fixture(t, [first, step('finish')], async messages => {
        const ref = messages.filter(item => item.role === 'user').at(-1).id;
        const criterion = [{ index: 0, status: 'met', explanation: 'Confirmed by the user request.', references: [ref] }];
        return [
            () => call('ask_user', { question: 'Which account type?', options: [] }),
            () => call('workflow_ready', { criteria: criterion }),
            () => call('workflow_report', report('Scope: personal accounts.', criterion))
        ][turns++]();
    });
    await f.runtime.setWorkflow(f.task.id, 'custom'); f.definition.steps[0].instructions = 'Changed after selection';
    f.runtime.send(f.task.id, 'Add account search', 'first');
    await until(() => f.store.task(f.task.id).state === 'waiting_input');
    assert.equal(turns, 1); assert.equal(f.store.task(f.task.id).workflow.index, 0);
    assert.equal(f.store.task(f.task.id).workflow.steps[0].instructions, 'Perform clarify.');
    await assert.rejects(() => f.runtime.setWorkflow(f.task.id, 'chat'), /pending question|before sending/);
    f.runtime.send(f.task.id, 'Personal accounts only', 'answer');
    await until(() => f.store.task(f.task.id).state === 'waiting_review');
    assert.equal(turns, 3); const pending = f.store.task(f.task.id).workflow.pending;
    const review = f.runtime.snapshot(f.task.id).interactions.find(item => item.kind === 'workflow_approval');
    assert.equal(review.review.step.id, 'clarify');
    assert.equal(review.review.result.revision, pending.revision);
    assert.equal(review.review.result.summary, 'Scope: personal accounts.');

    assert.ok(f.runtime.snapshot(f.task.id).actions.some(action => action.tool === 'ask_user' && action.args.question === 'Which account type?' && action.state === 'succeeded'), 'question cards remain visible after the answer');
    await assert.rejects(() => f.runtime.approveStep(f.task.id, pending.revision - 1), /changed/);
    const reopened = new SqliteStore(f.database); const tools = new ToolRegistry(); const engine = new WorkflowEngine(reopened, f.definitions, tools); engine.register(tools);
    let resumed = 0;
    const runtime = new TaskRuntime(reopened, scriptedProvider({ id: 'fake', respond: async () => ++resumed === 1 ? call('workflow_ready', { criteria: [] }) : call('workflow_report', report('Finished.')) }), tools, new DefaultPolicy(), new OutputSizeLimit(), undefined, engine);
    await runtime.approveStep(f.task.id, pending.revision); await until(() => reopened.task(f.task.id).state === 'completed');
    assert.ok(reopened.task(f.task.id).closedAt);
    assert.equal(reopened.task(f.task.id).draft, '');
    assert.throws(() => runtime.send(f.task.id, 'Reopen it', 'too-late'), /task is closed/i);
    assert.throws(() => runtime.resume(f.task.id), /task is closed/i);
    assert.throws(() => runtime.saveDraft(f.task.id, 'late draft'), /task is closed/i);
    assert.throws(() => runtime.readFiles(f.task.id, ['app.ts']), /task is closed/i);
    await assert.rejects(() => runtime.setWorkflow(f.task.id, 'chat'), /task is closed/i);
    assert.ok(runtime.snapshot(f.task.id).messages.some(message => message.text === 'Finished.'));
    assert.equal(reopened.events(f.task.id).filter(event => event.type === 'task.closed').length, 1);
    assert.equal(reopened.task(f.task.id).workflow.results.length, 2); assert.ok(reopened.task(f.task.id).workflow.results[0].approvedAt);
    assert.ok(reopened.messages(f.task.id).some(message => message.providerOnly && message.text.startsWith('[IDE approval receipt]')));
    assert.ok(!runtime.snapshot(f.task.id).messages.some(message => message.text.startsWith('[IDE approval receipt]')), 'internal receipts are not technical chat text');
    runtime.shutdown(); reopened.close();
});

test('workflow selection remains a changeable draft until sending the first message, preserving text typed during selection', async t => {
    let calls = 0; const f = await fixture(t, [step('clarify')], async () => { calls++; return call('ask_user', { question: 'What behavior is expected?', options: [] }); });
    f.runtime.saveDraft(f.task.id, 'Повысить версию ноды в Docker');
    const selection = f.runtime.setWorkflow(f.task.id, 'custom');
    f.runtime.saveDraft(f.task.id, 'Повысить версию ноды в Docker до актуальной');
    await selection;
    assert.equal(f.store.task(f.task.id).draft, 'Повысить версию ноды в Docker до актуальной');
    assert.equal(f.store.task(f.task.id).workflow.phase, 'draft'); assert.equal(calls, 0);
    assert.equal(f.store.runs(f.task.id).length, 0); assert.equal(f.store.messages(f.task.id).length, 0);
    assert.ok(!f.store.events(f.task.id).some(event => event.type === 'workflow.started'));
    assert.throws(() => f.engine.ready({ criteria: [] }, f.context), /No active workflow/);
    await f.runtime.setWorkflow(f.task.id, 'chat'); assert.equal(f.store.task(f.task.id).workflow, undefined);
    await f.runtime.setWorkflow(f.task.id, 'auto'); assert.equal(f.store.task(f.task.id).workflowMode, 'auto');
    await f.runtime.setWorkflow(f.task.id, 'custom');
    const reopened = new SqliteStore(f.database); assert.equal(reopened.task(f.task.id).workflow.phase, 'draft'); reopened.close();
    const draft = f.store.task(f.task.id).draft; f.runtime.send(f.task.id, draft, 'start-on-send');
    await until(() => f.store.task(f.task.id).state === 'waiting_input');
    assert.equal(calls, 1); assert.equal(f.store.task(f.task.id).workflow.index, 0);
    assert.equal(f.store.events(f.task.id).filter(event => event.type === 'workflow.started').length, 1);
    await assert.rejects(() => f.runtime.setWorkflow(f.task.id, 'chat'), /pending question|before sending/);
});

test('first message proposes a workflow and only the real selection starts it in the same run', async t => {
    let turns = 0; const f = await fixture(t, [step('work')], async (_messages, definitions) => {
        if (++turns === 1) {
            assert.deepEqual(definitions.map(item => item.name).sort(), ['ask_user', 'workflow_route']);
            return call('workflow_route', { id: 'custom', reason: 'This request needs a development process.' });
        }
        return { text: 'Here is a progress update.', calls: [] };
    });
    assert.equal(f.task.workflowMode, 'auto'); assert.equal(turns, 0); assert.equal(f.task.workflow, undefined);
    const unsent = f.store.task(f.task.id); delete unsent.workflowMode; f.store.putTask(unsent);
    f.runtime.saveDraft(f.task.id, 'An unsent message'); assert.equal(turns, 0);
    f.runtime.send(f.task.id, 'Please implement a feature', 'auto');
    await until(() => f.store.task(f.task.id).state === 'waiting_input');
    const request = f.runtime.snapshot(f.task.id).interactions.find(item => item.kind === 'workflow_selection');
    assert.equal(turns, 1); assert.equal(f.store.task(f.task.id).workflow, undefined);
    assert.equal(request.recommendedId, 'custom'); assert.deepEqual(request.question.options.map(item => item.id), ['custom', 'chat']);
    assert.throws(() => f.runtime.send(f.task.id, 'yes', 'plain-text'), /Select a workflow/);
    await assert.rejects(() => f.runtime.respondInteraction(request.id, { optionId: 'missing' }), /offered workflows/);
    await assert.rejects(() => f.runtime.respondInteraction(request.id, { text: 'custom' }), /offered workflows/);
    await f.runtime.respondInteraction(request.id, { optionId: 'custom' });
    await until(() => f.store.task(f.task.id).state === 'failed');
    const snapshot = f.runtime.snapshot(f.task.id);
    assert.equal(turns, 2); assert.equal(snapshot.task.workflow.phase, 'active'); assert.equal(snapshot.task.workflow.index, 0);
    assert.equal(snapshot.task.workflow.results.length, 0); assert.equal(snapshot.interactions[0].state, 'answered'); assert.equal(snapshot.runs.length, 1);
    assert.match(snapshot.runs[0].error, /explicit action/);
    assert.ok(!snapshot.messages.some(message => message.text === 'Here is a progress update.'));
});

test('workflow recommendation survives recovery and the user can choose a different process', async t => {
    const f = await fixture(t, [step('work')], async () => call('workflow_route', { id: 'custom', reason: 'A structured process may help.' }));
    f.runtime.send(f.task.id, 'Consider this change', 'start');
    await until(() => f.store.task(f.task.id).state === 'waiting_input');
    const request = f.runtime.snapshot(f.task.id).interactions[0];
    f.runtime.shutdown();
    const reopened = new SqliteStore(f.database); const tools = new ToolRegistry(); const engine = new WorkflowEngine(reopened, f.definitions, tools); engine.register(tools);
    let resumed = 0;
    const runtime = new TaskRuntime(reopened, scriptedProvider({ id: 'fake', respond: async () => { resumed++; return { text: 'We can discuss it.', calls: [] }; } }), tools, new DefaultPolicy(), new OutputSizeLimit(), undefined, engine);
    await runtime.respondInteraction(request.id, { optionId: 'chat' });
    await until(() => reopened.task(f.task.id).state === 'completed');
    assert.equal(reopened.task(f.task.id).workflowMode, 'chat'); assert.equal(reopened.task(f.task.id).workflow, undefined);
    assert.equal(resumed, 1); assert.equal(reopened.runs(f.task.id).length, 1);
    await runtime.respondInteraction(request.id, { optionId: 'chat' }); assert.equal(resumed, 1);
    runtime.shutdown(); reopened.close();
});

test('cancelled workflow recommendations cannot start a process later', async t => {
    const f = await fixture(t, [step('work')], async () => call('workflow_route', { id: 'custom', reason: 'Use this process.' }));
    f.runtime.send(f.task.id, 'Implement a feature', 'start');
    await until(() => f.store.task(f.task.id).state === 'waiting_input');
    const request = f.runtime.snapshot(f.task.id).interactions[0]; f.runtime.cancel(f.task.id);
    await assert.rejects(() => f.runtime.respondInteraction(request.id, { optionId: 'custom' }), /no longer/);
    assert.equal(f.store.task(f.task.id).workflow, undefined); assert.equal(f.store.interaction(request.id).state, 'cancelled');
});

test('workflow reports expose only step results and technical blockers', async t => {
    const f = await fixture(t, [step('clarify')]); await f.engine.select(f.task.id, 'custom'); f.engine.start(f.task.id);
    const schema = f.tools.definitions(f.context).find(tool => tool.name === 'workflow_report');
    assert.deepEqual(schema.parameters.properties.status.enum, ['blocked', 'completed']);
    await assert.rejects(() => f.engine.report({ status: 'need_input', summary: 'Old protocol', criteria: [], artifacts: [] }, f.context), /technical blocker/);
    assert.equal(f.store.interactions(f.task.id).length, 0); assert.equal(f.store.task(f.task.id).workflow.index, 0);
});

test('an out-of-contract workflow message fails visibly without hidden retries or fabricated input', async t => {
    let turns = 0; const f = await fixture(t, [step('clarify')], async () => { turns++; return { text: 'A normal message.', calls: [] }; });
    await f.runtime.setWorkflow(f.task.id, 'custom'); f.runtime.send(f.task.id, 'Start', 'first');
    await until(() => f.store.task(f.task.id).state === 'failed');
    assert.equal(turns, 1); assert.equal(f.store.task(f.task.id).workflow.index, 0);
    const snapshot = f.runtime.snapshot(f.task.id); assert.match(snapshot.runs[0].error, /explicit action/);
    assert.ok(!snapshot.messages.some(message => message.text === 'A normal message.'));
    assert.equal(snapshot.interactions.length, 0);
});

async function approvedPlan(f) {
    await f.engine.select(f.task.id, 'custom'); f.engine.start(f.task.id); f.engine.ready({ criteria: [] }, f.context);
    const doc = await f.execute('changeset_write', { name: 'feature.md', body: '# Feature\n\nChange app.ts to expose value 2.', scope: [{ repository: 'back', paths: ['app.ts', 'new/note.ts', 'link.ts', 'hard.ts'], baseBranch: '' }], expectedDigest: null });
    await f.engine.report(report('Review the scoped plan.', [], [doc.path]), f.context);
    await f.engine.approve(f.task.id, f.store.task(f.task.id).workflow.pending.revision); f.engine.ready({ criteria: [] }, f.context);
    return doc;
}

test('Study completion continues into a saved ChangeSet and review under an explicit required-action policy', async t => {
    let turns = 0; let document; const policies = [];
    const f = await fixture(t, [step('study'), step('plan', ['changeset-write'], true)], async (_messages, _tools, _instructions, _signal, policy) => {
        policies.push(policy);
        switch (++turns) {
            case 1: return call('workflow_ready', { criteria: [] });
            case 2: return { ...call('workflow_report', report('Study complete.')), text: 'Study complete. Next: prepare the ChangeSet.' };
            case 3: return call('workflow_ready', { criteria: [] });
            case 4: return call('changeset_write', { name: 'next-step.md', body: '# Proposed change\n\nUpdate only the approved literal.', scope: [{ repository: 'back', paths: ['app.ts'] }], expectedDigest: null });
            case 5: document = await f.engine.documents.read(f.project, 'next-step.md'); return call('workflow_report', report('ChangeSet ready for review.', [], [document.path]));
            default: assert.fail('Workflow must pause for review');
        }
    });
    await f.runtime.setWorkflow(f.task.id, 'custom'); f.runtime.send(f.task.id, 'Prepare a small scoped change', 'start');
    await until(() => f.store.task(f.task.id).state === 'waiting_review');
    assert.equal(turns, 5); assert.ok(policies.every(policy => policy.allowMessage === false));
    assert.equal(f.store.task(f.task.id).workflow.index, 1); assert.equal(f.store.task(f.task.id).workflow.pending.artifacts[0].path, 'changesets/next-step.md');
    assert.equal(await fs.readFile(path.join(f.repo, 'app.ts'), 'utf8'), 'export const value = 1;\n');
});
const editSteps = () => [step('plan', ['changeset-write'], true), step('branches', ['branch-create']), step('edit', ['repository-edit'])];
async function branch(f) {
    const state = await f.execute('git_status', { repository: 'back' });
    const result = await f.execute('git_branch_create', { repository: 'back', baseBranch: 'main', branch: 'feature/example', expectedHead: state.head, expectedState: state.fingerprint });
    await f.engine.report(report('Feature branch prepared.'), f.context); f.engine.ready({ criteria: [] }, f.context); return result;
}

test('registered Git tools create a clean scoped branch and edits compare original content before atomically applying', async t => {
    const f = await fixture(t, editSteps()); await approvedPlan(f); await branch(f);
    assert.equal(execFileSync('git', ['-C', f.repo, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), 'feature/example');
    const edited = await f.execute('repository_edit', { repository: 'back', path: 'app.ts', expectedDigest: hashText('export const value = 1;\n'), content: 'export const value = 2;\n' });
    assert.equal(edited.digest, hashText('export const value = 2;\n')); assert.equal(await fs.readFile(path.join(f.repo, 'app.ts'), 'utf8'), 'export const value = 2;\n');
    const diff = await f.execute('git_diff', { repository: 'back', path: 'app.ts' }); assert.deepEqual(diff.files, [{ status: 'M', path: 'app.ts' }]); assert.match(diff.patch, /value = 2/);
    await assert.rejects(() => f.execute('repository_edit', { repository: 'back', path: 'app.ts', expectedDigest: hashText('export const value = 1;\n'), content: 'stale' }), /Source content changed/);
    await f.execute('repository_edit', { repository: 'back', path: 'new/note.ts', expectedDigest: null, content: 'export const note = true;\n' });
    assert.match(await fs.readFile(path.join(f.repo, 'new/note.ts'), 'utf8'), /note = true/);
    const read = await f.execute('changeset_read', { name: 'feature.md' });
    const notes = await f.execute('changeset_notes', { name: 'feature.md', notes: 'Implementation updated app.ts. Tests were not run.', expectedDigest: read.digest });
    assert.equal(notes.planDigest, read.planDigest); assert.notEqual(notes.digest, read.digest);
    await f.engine.authorize(f.context, 'repository-edit', 'back', 'app.ts');
});

test('dirty/unexpected Git state is blocked without stashing, resetting or discarding user changes', async t => {
    const f = await fixture(t, editSteps()); await approvedPlan(f);
    await fs.writeFile(path.join(f.repo, 'personal.txt'), 'Unrelated work');
    const state = await f.execute('git_status', { repository: 'back' }); assert.equal(state.clean, false);
    await assert.rejects(() => f.execute('git_branch_create', { repository: 'back', baseBranch: 'main', branch: 'feature/blocked', expectedHead: state.head, expectedState: state.fingerprint }), /clean, unchanged/);
    assert.equal(await fs.readFile(path.join(f.repo, 'personal.txt'), 'utf8'), 'Unrelated work');
    assert.equal(execFileSync('git', ['-C', f.repo, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), 'main');
});

test('changed review documents invalidate approvals; changed plans invalidate mutation permissions but notes do not', async t => {
    const f = await fixture(t, editSteps()); await f.engine.select(f.task.id, 'custom'); f.engine.start(f.task.id); f.engine.ready({ criteria: [] }, f.context);
    const doc = await f.execute('changeset_write', { name: 'feature.md', body: '# First plan', scope: [{ repository: 'back', paths: ['app.ts'] }], expectedDigest: null });
    await f.engine.report(report('Approve this revision.', [], [doc.path]), f.context); const revision = f.store.task(f.task.id).workflow.pending.revision;
    const changed = await f.engine.documents.write(f.project, 'feature.md', '# Changed plan', [{ repository: 'back', paths: ['app.ts'] }], doc.digest);
    await assert.rejects(() => f.engine.approve(f.task.id, revision), /changed after review/);
    f.engine.feedback(f.task.id); f.engine.ready({criteria:[]},f.context); await f.engine.report(report('Approve the changed plan.', [], [doc.path]), f.context);
    await f.engine.approve(f.task.id, f.store.task(f.task.id).workflow.pending.revision); f.engine.ready({ criteria: [] }, f.context);
    await f.engine.documents.write(f.project, 'feature.md', '# Changed again', [{ repository: 'back', paths: ['app.ts'] }], changed.digest);
    await assert.rejects(() => f.engine.authorize(f.context, 'branch-create', 'back'), /approved ChangeSet changed/);
    f.engine.revise({ stepId: 'plan', reason: 'The plan changed.' }, f.context); assert.equal(f.store.task(f.task.id).workflow.results.length, 0);
});

test('path escapes, metadata, linked and hard-linked files, unapproved files and changed registrations are rejected', async t => {
    const f = await fixture(t, editSteps()); await approvedPlan(f); await branch(f);
    const outside = path.join(f.root, 'private.txt'); await fs.writeFile(outside, 'Outside'); await fs.symlink(outside, path.join(f.repo, 'link.ts')); await fs.link(outside, path.join(f.repo, 'hard.ts'));
    const edit = (path, expectedDigest = null) => f.execute('repository_edit', { repository: 'back', path, expectedDigest, content: 'Attempted edit' });
    for (const value of ['../private.txt', '/tmp/private.txt', '.git/config', '.GIT/config', 'missing.ts']) await assert.rejects(() => edit(value));
    await assert.rejects(() => edit('link.ts', hashText('Outside')), /non-linked|Unrelated/); await assert.rejects(() => edit('hard.ts', hashText('Outside')), /non-linked|Unrelated/);
    await fs.unlink(path.join(f.repo, 'link.ts')); await fs.unlink(path.join(f.repo, 'hard.ts'));
    const tool = f.tools.get('repository_edit'); const args = { repository: 'back', path: 'app.ts', expectedDigest: hashText('export const value = 1;\n'), content: 'Changed' }; const prepared = await tool.prepare(args, f.context);
    await fs.writeFile(path.join(f.project, 'project.theia-workspace'), JSON.stringify({ folders: [{ path: '.' }], governedRepositories: [] }));
    await assert.rejects(() => tool.execute(args, prepared, f.context), /not connected/);
    assert.equal(await fs.readFile(outside, 'utf8'), 'Outside');
    for (const name of ['../private.md', '/tmp/out.md', 'feature/plan.md']) await assert.rejects(() => f.engine.documents.read(f.project, name), /filename/);
});

test('new unrelated changes and external changes to task-owned files stop later writes', async t => {
    const f = await fixture(t, editSteps()); await approvedPlan(f); await branch(f);
    await f.execute('repository_edit', { repository: 'back', path: 'app.ts', expectedDigest: hashText('export const value = 1;\n'), content: 'export const value = 2;\n' });
    await fs.writeFile(path.join(f.repo, 'other.ts'), 'Unrelated work');
    await assert.rejects(() => f.execute('repository_edit', { repository: 'back', path: 'app.ts', expectedDigest: hashText('export const value = 2;\n'), content: 'export const value = 3;\n' }), /Unrelated working-tree/);
    await fs.unlink(path.join(f.repo, 'other.ts'));
    await fs.writeFile(path.join(f.repo, 'app.ts'), 'Concurrent external change');
    await assert.rejects(() => f.execute('repository_edit', { repository: 'back', path: 'app.ts', expectedDigest: hashText('Concurrent external change'), content: 'Overwrite' }), /changed outside this task/);
    assert.equal(await fs.readFile(path.join(f.repo, 'app.ts'), 'utf8'), 'Concurrent external change');
});

test('two projects sharing a checkout cannot race branch setup on the same clean base', async t => {
    const f = await fixture(t, editSteps()); await approvedPlan(f);
    const project = path.join(f.root, 'second-project'); await fs.mkdir(path.join(project, 'repositories'), { recursive: true });
    await fs.symlink(f.repo, path.join(project, 'repositories', 'back'));
    await fs.writeFile(path.join(project, 'project.theia-workspace'), JSON.stringify({ folders: [{ path: '.' }], governedRepositories: [{ id: 'back', path: f.repo }] }));
    const task = f.runtime.create(project); const context = { ...f.context, projectPath: project, taskId: task.id };
    const second = { ...f, project, task, context, execute: async (name, args) => { const tool = f.tools.get(name); const prepared = await tool.prepare(args, context); return JSON.parse(await tool.execute(args, prepared, context)); } };
    await approvedPlan(second);
    const state = await f.execute('git_status', { repository: 'back' });
    const args = { repository: 'back', baseBranch: 'main', expectedHead: state.head, expectedState: state.fingerprint };
    const results = await Promise.allSettled([f.execute('git_branch_create', { ...args, branch: 'feature/first-project' }), second.execute('git_branch_create', { ...args, branch: 'feature/second-project' })]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const branches = execFileSync('git', ['-C', f.repo, 'branch', '--list', 'feature/*'], { encoding: 'utf8' }).trim().split('\n');
    assert.equal(branches.length, 1);
});

test('Git refuses redirected metadata and environment variables cannot select another repository', async t => {
    const f = await fixture(t, editSteps()); const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = '/nonexistent/elsewhere';
    try { const root = await gitRoot('back', f.context); assert.equal(root, await fs.realpath(f.repo)); assert.equal((await gitState(root, f.context)).branch, 'main'); }
    finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; }
    const actual = path.join(f.repo, '.git', 'refs'); const outside = path.join(f.root, 'refs'); await fs.rename(actual, outside); await fs.symlink(outside, actual);
    await assert.rejects(() => f.execute('git_status', { repository: 'back' }), /metadata must not contain links/);
});

test('model round trip writes a reviewed plan, prepares its branch and edits only its approved file through core dispatch', async t => {
    let f; let stage = -1; let turn = 0;
    f = await fixture(t, editSteps(), async messages => {
        const run = f.store.task(f.task.id).workflow;
        if (stage !== run.index) { stage = run.index; turn = 0; }
        const current = turn++;
        const last = () => JSON.parse(messages.filter(item => item.role === 'tool').at(-1).text);
        if (current === 0) return call('workflow_ready', { criteria: [] });
        if (stage === 0) {
            if (current === 1) return call('changeset_write', { name: 'roundtrip.md', body: '# Approved plan\n\nUpdate app.ts to return value 2.', scope: [{ repository: 'back', paths: ['app.ts'], baseBranch: '' }], expectedDigest: null });
            return call('workflow_report', report('Approve this plan.', [], ['changesets/roundtrip.md']));
        }
        if (stage === 1) {
            if (current === 1) return call('git_status', { repository: 'back' });
            if (current === 2) { const state = last(); return call('git_branch_create', { repository: 'back', baseBranch: 'main', branch: 'feature/roundtrip', expectedHead: state.head, expectedState: state.fingerprint }); }
            return call('workflow_report', report('Prepared the branch.'));
        }
        if (current === 1) return call('files_read', { paths: ['repositories/back/app.ts'] });
        if (current === 2) return call('repository_edit', { repository: 'back', path: 'app.ts', expectedDigest: last().files[0].digest, content: 'export const value = 2;\n' });
        return call('workflow_report', report('Implemented the approved change.'));
    });
    await f.runtime.setWorkflow(f.task.id, 'custom'); f.runtime.send(f.task.id, 'Update the value', 'roundtrip');
    await until(() => f.store.task(f.task.id).state === 'waiting_review');
    await until(() => !f.store.runs(f.task.id).some(run => run.state === 'running'));
    await f.runtime.approveStep(f.task.id, f.store.task(f.task.id).workflow.pending.revision);
    await until(() => ['completed', 'failed'].includes(f.store.task(f.task.id).state));
    assert.equal(f.store.task(f.task.id).state, 'completed', JSON.stringify(f.store.runs(f.task.id)));
    const actions = f.store.runs(f.task.id).flatMap(run => f.store.actions(run.id));
    assert.ok(actions.some(action => action.tool === 'repository_edit' && action.state === 'succeeded'));
    assert.equal(actions.filter(action => action.state === 'failed').length, 0);
    assert.equal(await fs.readFile(path.join(f.repo, 'app.ts'), 'utf8'), 'export const value = 2;\n');
    assert.equal(f.store.task(f.task.id).workflow.results.length, 3);
    assert.ok(!('content' in f.runtime.snapshot(f.task.id).actions.find(action => action.tool === 'repository_edit').args), 'source-write payloads are not sent back in UI polling');
});

test('targeted replacement shares approved scope, branch ownership and atomic-write checks',async t=>{
 const f=await fixture(t,editSteps());await approvedPlan(f);await branch(f);
 const args={repository:'back',path:'app.ts',replacements:[{oldText:'value = 1',newText:'value = 2',expectedMatches:1}]};
 const tool=f.tools.get('repository_replace');const prepared=await tool.prepare(args,f.context);
 assert.ok(!JSON.stringify(prepared).includes('export const'));const result=JSON.parse(await tool.execute(args,prepared,f.context));
 assert.equal(result.changedOccurrences,1);assert.equal(await fs.readFile(path.join(f.repo,'app.ts'),'utf8'),'export const value = 2;\n');assert.equal(f.engine.edits(f.context,'back')['app.ts'],result.digest);
 await assert.rejects(()=>f.execute('repository_replace',args),/expected 1 occurrence/);
 const unchanged=await fs.readFile(path.join(f.repo,'app.ts'),'utf8');
 await assert.rejects(()=>f.execute('repository_replace',{...args,replacements:[{oldText:'value = 2',newText:'value = 3',expectedMatches:1},{oldText:'missing',newText:'new',expectedMatches:1}]}),/expected 1 occurrence/);
 assert.equal(await fs.readFile(path.join(f.repo,'app.ts'),'utf8'),unchanged);
 for(const path of ['../private.txt','.git/config','not-approved.ts'])await assert.rejects(()=>f.execute('repository_replace',{...args,path}));
 const second={...args,replacements:[{oldText:'value = 2',newText:'value = 3',expectedMatches:1}]};const reviewed=await tool.prepare(second,f.context);await fs.writeFile(path.join(f.repo,'app.ts'),'export const value = 2;\n// outside change\n');
 await assert.rejects(()=>tool.execute(second,reviewed,f.context),/outside this task/);assert.match(await fs.readFile(path.join(f.repo,'app.ts'),'utf8'),/outside change/);
});

test('chat questions retain the approval, requested changes repeat only affected steps, and stale approvals cannot advance',async t=>{
 let phase='initial',reworked=false;const seen=[];
 const steps=[step('agreement'),step('build'),{...step('review',[],true),reworkTargets:['build','agreement']},step('check')];
 const f=await fixture(t,steps,async(_messages,_tools,_instructions,_signal,policy)=>{
  const workflow=f.store.task(f.task.id).workflow;seen.push(workflow.steps[workflow.index].id);
  if(workflow.discussion){assert.equal(policy.allowMessage,true);if(phase==='question')return{text:'This file implements the requested behavior.',calls:[]};if(phase==='change'){phase='reworking';reworked=true;return call('workflow_revise',{stepId:'build',reason:'User asked to adjust the implementation.'});}}
  if(!workflow.ready)return call('workflow_ready',{criteria:[]});
  return call('workflow_report',report(`${workflow.steps[workflow.index].id} ${reworked?'revised':'initial'}`));
 });
 await f.runtime.setWorkflow(f.task.id,'custom');f.runtime.send(f.task.id,'Build something','start');await until(()=>f.store.task(f.task.id).state==='waiting_review');const first=f.store.task(f.task.id).workflow.pending.revision;const agreementRevision=f.store.task(f.task.id).workflow.results.find(x=>x.stepId==='agreement').revision;
 phase='question';f.runtime.send(f.task.id,'Why did you change this file?','question');await until(()=>f.store.task(f.task.id).state==='waiting_review');assert.equal(f.store.task(f.task.id).workflow.pending.revision,first);assert.equal(f.store.task(f.task.id).workflow.discussion,undefined);assert.equal(f.store.task(f.task.id).workflow.results.length,2);
 const oldRequest=f.runtime.snapshot(f.task.id).interactions.find(x=>x.kind==='workflow_approval'&&x.state==='pending');
 phase='change';f.runtime.send(f.task.id,'Please adjust the implementation.','change');await until(()=>f.store.task(f.task.id).state==='waiting_review'&&f.store.task(f.task.id).workflow.pending.revision!==first);
 const workflow=f.store.task(f.task.id).workflow;assert.equal(workflow.results.find(x=>x.stepId==='agreement').revision,agreementRevision);assert.ok(workflow.history.some(x=>x.result.stepId==='build'));assert.ok(workflow.history.some(x=>x.result.stepId==='review'));assert.equal(seen.filter(x=>x==='agreement').length,2);
 await assert.rejects(()=>f.runtime.respondInteraction(oldRequest.id,{approved:true}),/no longer pending/);
 const current=f.runtime.snapshot(f.task.id).interactions.find(x=>x.kind==='workflow_approval'&&x.state==='pending');await f.runtime.respondInteraction(current.id,{approved:true});await until(()=>!!f.store.task(f.task.id).closedAt);assert.equal(f.store.task(f.task.id).workflow.phase,'completed');assert.ok(seen.includes('check'));
});

test('review discussion cannot execute a selected mutating tool or turn prose into approval',async t=>{
 let phase='start',attempted=false,executed=0;const f=await fixture(t,[{...step('review',[],true),tools:['danger']}],async(_messages,_tools,_instructions,_signal,policy)=>{
  const workflow=f.store.task(f.task.id).workflow;if(workflow.discussion){assert.equal(policy.allowMessage,true);if(!attempted){attempted=true;return call('danger',{});}return{text:'I have explained the result; use the approval button to continue.',calls:[]};}
  if(!workflow.ready)return call('workflow_ready',{criteria:[]});return call('workflow_report',report('Review this result.'));
 });
 f.tools.register({definition:{name:'danger',description:'Mutating fixture.',parameters:{}},access:require('../lib/node/harness/core/tool-access').scopeAccess({execute:'allow'},undefined,['execute']),prepare:async()=>({scope:'execute'}),execute:async()=>{executed++;return 'ran';}});
 await f.runtime.setWorkflow(f.task.id,'custom');f.runtime.send(f.task.id,'Start','start');await until(()=>f.store.task(f.task.id).state==='waiting_review');const revision=f.store.task(f.task.id).workflow.pending.revision;
 f.runtime.send(f.task.id,'approve and run it','discussion');await until(()=>f.store.task(f.task.id).state==='waiting_review'&&attempted);assert.equal(executed,0);assert.equal(f.store.task(f.task.id).workflow.pending.revision,revision);assert.equal(f.store.task(f.task.id).closedAt,undefined);assert.match(f.runtime.snapshot(f.task.id).actions.find(x=>x.tool==='danger').error,/Review discussion/);
});

test('review safeguards survive reload and reject source changes at approval and later completion',async t=>{
 let identity='original';const observer={id:'fixture',name:'Fixture source',description:'Pin source.',capture:async()=>({fingerprint:identity,summary:'Changed files: app.ts',data:{files:['app.ts']}})};
 const f=await fixture(t,[{...step('review',[],true),reviewEvidence:['fixture']},step('verify')],undefined,[observer]);await f.engine.select(f.task.id,'custom');f.engine.start(f.task.id);f.engine.ready({criteria:[]},f.context);await f.engine.report(report('Implementation ready.'),f.context);const revision=f.store.task(f.task.id).workflow.pending.revision;
 const reopened=new SqliteStore(f.database);const engine=new WorkflowEngine(reopened,f.definitions,f.tools,[observer]);identity='changed';await assert.rejects(()=>engine.approve(f.task.id,revision),/source state changed/);assert.equal(reopened.task(f.task.id).workflow.index,0);
 identity='original';await engine.approve(f.task.id,revision);assert.equal(reopened.task(f.task.id).workflow.index,1);engine.ready({criteria:[]},f.context);identity='changed';await assert.rejects(()=>engine.report(report('All verified.'),f.context),/Reviewed evidence/);assert.equal(reopened.task(f.task.id).closedAt,undefined);reopened.close();
});

 test('repeat branch preparation revalidates task-owned edits instead of creating a new branch',async t=>{
 const f=await fixture(t,editSteps());await approvedPlan(f);await branch(f);await f.execute('repository_replace',{repository:'back',path:'app.ts',replacements:[{oldText:'value = 1',newText:'value = 2',expectedMatches:1}]});
 f.engine.revise({stepId:'branches',reason:'Revalidate setup for another pass.'},f.context);f.engine.ready({criteria:[]},f.context);const state=await f.execute('git_status',{repository:'back'});const result=await f.execute('git_branch_create',{repository:'back',baseBranch:'main',branch:'feature/example',expectedHead:state.head,expectedState:state.fingerprint});assert.equal(result.reused,true);assert.equal(await fs.readFile(path.join(f.repo,'app.ts'),'utf8'),'export const value = 2;\n');
});

test('rework after a local commit appends a new task commit, preserves branch receipts and avoids duplicate commits',async t=>{
 const f=await fixture(t,[...editSteps(),step('commit',['repository-commit']),step('later')]);await approvedPlan(f);await branch(f);
 const replace=value=>f.execute('repository_replace',{repository:'back',path:'app.ts',replacements:[{oldText:`value = ${value-1}`,newText:`value = ${value}`,expectedMatches:1}]});
 await replace(2);await f.engine.report(report('First implementation.'),f.context);f.engine.ready({criteria:[]},f.context);
 const first=await f.execute('git_commit_changeset',{repository:'back',message:'First task change'});assert.equal(f.engine.branch(f.context,'back').tip,first.commit);
 await f.engine.report(report('Committed first pass.'),f.context);f.engine.revise({stepId:'edit',reason:'User requested a focused follow-up change.'},f.context);f.engine.ready({criteria:[]},f.context);
 await replace(3);await f.engine.report(report('Revised implementation.'),f.context);f.engine.ready({criteria:[]},f.context);
 const second=await f.execute('git_commit_changeset',{repository:'back',message:'Address requested changes'});assert.notEqual(second.commit,first.commit);assert.equal(execFileSync('git',['-C',f.repo,'rev-parse','HEAD^'],{encoding:'utf8'}).trim(),first.commit);assert.equal(f.engine.branch(f.context,'back').commits.length,2);
 const retry=await f.execute('git_commit_changeset',{repository:'back',message:'Address requested changes'});assert.equal(retry.commit,second.commit);assert.equal(f.engine.branch(f.context,'back').commits.length,2);
});

test('commit receipt recovery recognizes the exact existing commit instead of committing twice',async t=>{
 const f=await fixture(t,[...editSteps(),step('commit',['repository-commit'])]);await approvedPlan(f);await branch(f);await f.execute('repository_replace',{repository:'back',path:'app.ts',replacements:[{oldText:'value = 1',newText:'value = 2',expectedMatches:1}]});await f.engine.report(report('Implemented.'),f.context);f.engine.ready({criteria:[]},f.context);
 const result=await f.execute('git_commit_changeset',{repository:'back',message:'Task change'});const task=f.store.task(f.task.id);delete task.workflow.branches.back.tip;delete task.workflow.branches.back.commits;f.store.putTask(task);
 const recovered=await f.execute('git_commit_changeset',{repository:'back',message:'Task change'});assert.equal(recovered.commit,result.commit);assert.equal(f.engine.branch(f.context,'back').tip,result.commit);assert.equal(f.engine.branch(f.context,'back').commits.length,1);
});

test('all mutating implementations require readiness even without a domain-specific workflow operation',async t=>{
 let turn=0,executed=0;const f=await fixture(t,[{...step('work'),tools:['custom_writer']}],async()=>{
  switch(++turn){case 1:return call('custom_writer',{});case 2:return call('workflow_ready',{criteria:[]});case 3:return call('custom_writer',{});default:return call('workflow_report',report('Done.'));}
 });
 f.tools.register({definition:{name:'custom_writer',description:'A future installed mutating handler.',parameters:{}},access:require('../lib/node/harness/core/tool-access').scopeAccess({execute:'allow'},undefined,['write']),prepare:async()=>({scope:'execute'}),execute:async()=>{executed++;return 'done';}});
 await f.runtime.setWorkflow(f.task.id,'custom');f.runtime.send(f.task.id,'Start','one');await until(()=>!!f.store.task(f.task.id).closedAt);assert.equal(executed,1);const actions=f.runtime.snapshot(f.task.id).actions.filter(action=>action.tool==='custom_writer');assert.equal(actions[0].state,'failed');assert.match(actions[0].error,/Assess Ready/);assert.equal(actions[1].state,'succeeded');
});
