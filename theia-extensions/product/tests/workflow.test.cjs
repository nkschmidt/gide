const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { WorkflowRepository } = require('../lib/node/harness/workflows/workflow-repository');
const { DevelopmentWorkflow } = require('../lib/node/harness/workflows/default-workflow');
const { workflowIssues, editableStep, canMoveWorkflowStep } = require('../lib/common/workflow-service');
const { registerWorkflowTools } = require('../lib/node/harness/workflows/workflow-tools');
const { ToolRegistry } = require('../lib/node/harness/core/contracts');
const { DefaultPolicy } = require('../lib/node/harness/modules/file-tools');
const copy = value => structuredClone(value);
async function fixture(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'governed-workflow-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }
const draft = view => ({ expectedRevision: view.revision, steps: view.steps.map(editableStep) });
const custom = () => ({ id: 'project-api-review', title: 'Review API compatibility', instructions: 'Compare the public API with existing clients and record any compatibility changes.', definitionOfReady: [], definitionOfDone: ['Compatibility risks are documented.'], tools: [], approval: true, enabled: true });

test('Ready and Done criteria validate count and individual fields before saving', async t => {
    const root = await fixture(t); const repository = new WorkflowRepository(); const view = await repository.get(root); const changes = draft(view);
    changes.steps[0].definitionOfReady = [''];
    assert.ok(workflowIssues(changes.steps).some(issue => issue.field === 'definitionOfReady.0'));
    await assert.rejects(() => repository.save(root, changes), /criterion/);
    changes.steps[0].definitionOfReady = []; changes.steps[0].definitionOfDone = Array(21).fill('Criterion');
    await assert.rejects(() => repository.save(root, changes), /20 criteria/);
    assert.equal((await repository.get(root)).revision, view.revision);
});

test('catalog creates empty and copied workflows, persists their steps independently, and reopens them by ID', async t => {
    const root = await fixture(t); const repository = new WorkflowRepository();
    assert.deepEqual((await repository.list(root)).map(item => item.id), ['development']);
    const empty = await repository.create(root, { name: 'Исследование проекта', description: 'Архитектура и паттерны' });
    assert.deepEqual(empty.steps, []);
    await repository.save(root, { id: empty.id, expectedRevision: empty.revision, steps: [custom()] });
    const copied = await repository.create(root, { name: 'API review', description: '', sourceId: empty.id });
    assert.equal(copied.steps.length, 1);
    await repository.save(root, { id: copied.id, expectedRevision: copied.revision, steps: [] });
    const reopened = new WorkflowRepository();
    assert.equal((await reopened.get(root, empty.id)).steps.length, 1);
    assert.deepEqual((await reopened.get(root, copied.id)).steps, []);
    assert.equal((await reopened.get(root)).steps.length, DevelopmentWorkflow.steps.length);
    assert.equal((await reopened.list(root)).find(item => item.id === empty.id).stepCount, 1);
    const otherProject = await fixture(t); assert.equal((await reopened.list(otherProject)).length, 1);
});

test('workflow creation rejects duplicate names, missing sources and path escapes without making files', async t => {
    const root = await fixture(t); const repository = new WorkflowRepository(); await repository.list(root);
    const attempts = await Promise.allSettled([repository.create(root, { name: 'Review', description: '' }), repository.create(root, { name: 'review', description: '' })]);
    assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
    await assert.rejects(() => repository.create(root, { name: '', description: '' }), /workflow name/);
    await assert.rejects(() => repository.create(root, { name: 'Missing source', description: '', sourceId: 'missing' }), /not found/);
    await assert.rejects(() => repository.get(root, '../development'), /Invalid workflow ID/);
    await assert.rejects(() => repository.create(root, { name: 'Bad source', description: '', sourceId: '../development' }), /Invalid workflow ID/);
    assert.equal((await repository.list(root)).length, 2);
});


test('each project receives an independent full template copy and later template changes do not affect it', async t => {
    const root = await fixture(t); const repository = new WorkflowRepository(); let view = await repository.get(root);
    assert.equal(view.steps.length, DevelopmentWorkflow.steps.length);
    let stored = JSON.parse(await fs.readFile(path.join(root, 'workflows', 'development.json'), 'utf8'));
    assert.equal(stored.schemaVersion, 5); assert.equal(stored.steps.length, DevelopmentWorkflow.steps.length);
    assert.equal(stored.extends, undefined); assert.equal(stored.overrides, undefined);
    assert.ok(stored.steps.every(step => !('required' in step) && !('locked' in step)));
    const changes = draft(view); changes.steps[1].instructions += ' Check API compatibility.'; changes.steps.splice(3, 0, custom());
    view = await repository.save(root, changes);
    const next = copy(DevelopmentWorkflow); next.version = '2.0.0'; next.steps[1].instructions = 'Changed template instructions.';
    const updated = new WorkflowRepository(next); const reloaded = await updated.get(root);
    assert.equal(reloaded.steps.length, DevelopmentWorkflow.steps.length + 1); assert.match(reloaded.steps[1].instructions, /Check API compatibility/);
    const other = await fixture(t); const otherView = await updated.get(other);
    assert.equal(otherView.steps[1].instructions, 'Changed template instructions.');
    assert.ok(!DevelopmentWorkflow.steps[1].instructions.includes('Check API compatibility.'));
});

test('every copied step can be moved, disabled, changed or deleted, including the whole workflow', async t => {
    const root = await fixture(t); const repository = new WorkflowRepository(); const view = await repository.get(root);
    assert.equal(canMoveWorkflowStep(view.steps, 1, 1), true);
    assert.equal(canMoveWorkflowStep(view.steps, 0, -1), false);
    const changes = draft(view); const [memory] = changes.steps.splice(changes.steps.findIndex(step => step.id === 'memory'), 1); memory.definitionOfDone = ['Document the result.']; memory.enabled = false; changes.steps.unshift(memory);
    changes.steps = changes.steps.filter(step => step.id !== 'verify');
    const saved = await repository.save(root, changes);
    assert.equal(saved.steps[0].id, 'memory'); assert.equal(saved.steps[0].enabled, false); assert.deepEqual(saved.steps[0].definitionOfDone, ['Document the result.']);
    assert.ok(!saved.steps.some(step => step.id === 'verify'));
    const empty = await repository.save(root, { expectedRevision: saved.revision, steps: [] });
    assert.deepEqual(empty.steps, []); assert.deepEqual((await repository.get(root)).steps, []);
});

test('concurrent saves detect stale revisions instead of overwriting another draft', async t => {
    const root = await fixture(t); const repository = new WorkflowRepository(); const view = await repository.get(root); const first = draft(view); const second = draft(view);
    first.steps[0].title = 'Clarify the task'; second.steps[0].title = 'Understand requested behavior';
    const results = await Promise.allSettled([repository.save(root, first), repository.save(root, second)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.match(results.find(result => result.status === 'rejected').reason.message, /another window/);
});

test('validation still rejects invalid fields without changing saved steps', async t => {
    const root = await fixture(t); const repository = new WorkflowRepository(); const view = await repository.get(root);
    const changes = draft(view); changes.steps[0].instructions = '';
    assert.ok(workflowIssues(changes.steps).some(issue => issue.stepId === 'understand' && issue.field === 'instructions'));
    await assert.rejects(() => repository.save(root, changes), /instructions/);
    changes.steps = [custom(), custom()]; await assert.rejects(() => repository.save(root, changes), /unique/);
    assert.equal((await repository.get(root)).revision, view.revision);
});

test('the agent reads the independent project workflow and its selected tools', async t => {
    const root = await fixture(t); const repository = new WorkflowRepository();
    const tools = new ToolRegistry(); registerWorkflowTools(tools, { get: project => repository.get(project) });
    const tool = tools.get('workflow_get'); const context = { projectPath: root, signal: new AbortController().signal, purpose: 'chat' }; const prepared = await tool.prepare({}, context);
    assert.equal(new DefaultPolicy().check({ tool: 'workflow_get', prepared }, tools.registration('workflow_get').access), 'allow');
    const result = JSON.parse(await tool.execute({}, prepared, context)); assert.ok(result.steps.find(step => step.id === 'verify').tools.length); assert.equal(result.automatedStageExecution, false);
    assert.equal(result.base, undefined); assert.ok(result.steps.every(step => !('required' in step)));
    assert.equal(tool.available({ ...context, purpose: 'repository-analysis' }), false);
});

test('completion actions persist, validate target workflows and initialize editable Code Review', async t => {
    const root = await fixture(t);
    const repository = new WorkflowRepository();
    await repository.initialize(root);
    assert.equal((await repository.get(root, 'code-review')).steps.length, 3);
    const development = await repository.get(root);
    assert.deepEqual(development.nextWorkflows, ['code-review']);
    const saved = await repository.save(root, { ...draft(development), nextWorkflows: [] });
    assert.deepEqual(saved.nextWorkflows, []);
    await assert.rejects(() => repository.save(root, { ...draft(saved), nextWorkflows: ['missing'] }), /not found/);
    await assert.rejects(() => repository.save(root, { ...draft(saved), nextWorkflows: ['../outside'] }), /completion actions/);
    await assert.rejects(() => repository.save(root, { ...draft(saved), nextWorkflows: null }), /completion actions/);
    const linked = await repository.save(root, { ...draft(saved), nextWorkflows: ['code-review'] });
    const copied = await repository.create(root, { name: 'Another process', description: '', sourceId: linked.id });
    assert.deepEqual(copied.nextWorkflows, ['code-review']);
    const reopened = new WorkflowRepository();
    assert.deepEqual((await reopened.get(root)).nextWorkflows, ['code-review']);
});

test('result dependencies, configured rework and review safeguards persist in independent workflow copies',async t=>{
 const root=await fixture(t);const repository=new WorkflowRepository();const view=await repository.get(root);const next=draft(view);const review=next.steps.find(step=>step.id==='review-implementation');assert.ok(review);assert.equal(review.approval,true);assert.deepEqual(review.dependsOn,['implement']);assert.deepEqual(review.reviewEvidence,['repository-source']);
 review.reworkTargets=['implement'];await repository.save(root,next);const loaded=await repository.get(root);assert.deepEqual(loaded.steps.find(step=>step.id===review.id).reworkTargets,['implement']);const copied=await repository.create(root,{name:'Alternative process',description:'Independent graph.',sourceId:view.id});assert.deepEqual(copied.steps.find(step=>step.id===review.id).reviewEvidence,['repository-source']);
});
