import { familyReferences } from './tool-families';
import { WorkflowToolScope } from './workflow-tool-scope';
import { scopeAccess } from './tool-access';
import { isTaskClosed, Task } from '../../../common/task-service';
import { randomUUID } from 'crypto';
import { CriterionResult, WorkflowArtifact, WorkflowOperation, WorkflowStepResult, WorkflowRun, WorkflowObservation } from '../../../common/workflow-run';
import { materializeSteps, nextUnresolvedStep, reopenStep, resultInputs, resultIsCurrent, transitionPhase } from './workflow-machine';
import { WorkflowService, WorkflowSummary, WorkflowView, editableStep, workflowNextIds, WorkflowEvidenceProvider } from '../../../common/workflow-service';
import { HarnessStore, ToolContext, ToolRegistry } from './contracts';
import { ChangeScope, ChangeSetStore } from '../modules/changesets';
import { SafeToolError } from '../modules/file-tools';
import { InteractionManager } from './interactions';
import { InteractionRequest, InteractionResponse, ToolInteraction } from '../../../common/interaction';
import { WorkflowToolAccess } from './workflow-tool-access';

export interface WorkflowObserver extends WorkflowEvidenceProvider { capture(task: Task, signal: AbortSignal): Promise<WorkflowObservation>; }
export class WorkflowEngine {
    readonly documents = new ChangeSetStore();
    private supports(task: Task, context: ToolContext, operation: WorkflowOperation): boolean {
        return !!this.tools && new WorkflowToolScope(this.tools).entries(task, context).some(item => item.executor.workflowOperations?.includes(operation));
    }
    private readonly interactions: InteractionManager;
    constructor(readonly store: HarnessStore, private readonly definitions: WorkflowService, private readonly tools: ToolRegistry, private readonly observers: readonly WorkflowObserver[] = []) { this.interactions = new InteractionManager(store); if (new Set(observers.map(observer => observer.id)).size !== observers.length) throw new Error('Duplicate workflow observer.'); }
    private save(task: Task, event: string, data: Record<string, unknown> = {}): void { task.updatedAt = Date.now(); this.store.putTask(task); this.store.event(task.id, undefined, event, { step: task.workflow?.index, revision: task.workflow?.revision, ...data }); }
    private transcript(task: Task, text: string, runId?: string): void {
        const messages = this.store.messages(task.id); const last = messages[messages.length - 1];
        if (runId && last?.role === 'assistant' && last.runId === runId && last.text.trim() === text.trim()) return;
        this.store.putMessage({ id: randomUUID(), taskId: task.id, runId, role: 'assistant', text, createdAt: Date.now(), localOnly: true });
    }
    async select(taskId: string, choice: string, routing = false, request?: InteractionRequest): Promise<void> {
        const task = this.store.task(taskId);
        const canSelect = () => { const current = this.store.task(taskId); return !this.store.messages(taskId).length && !this.store.runs(taskId).length && !current.workflow?.results.length && !current.workflow?.pending && !current.workflow?.ready; };
        if (isTaskClosed(task)) throw new SafeToolError('This task is closed.');
        if (routing ? task.workflowMode !== 'auto' || !!task.workflow : !canSelect()) throw new SafeToolError('Choose a workflow before sending the first message.');
        if (['chat', 'auto'].includes(choice) && (!routing || choice === 'chat')) { task.workflowMode = choice as 'chat' | 'auto'; delete task.workflow; this.save(task, 'workflow.mode'); return; }
        const view = await this.definitions.get(task.projectPath, choice);
        const latest = this.store.task(taskId);
        if (request && this.store.interaction(request.id).state !== 'pending') throw new SafeToolError('This workflow choice is no longer pending.');
        if (isTaskClosed(latest) || (routing ? !!latest.workflow : !canSelect())) throw new SafeToolError('The task changed while selecting its workflow.');
        const steps = materializeSteps(view.steps.map(editableStep));
        if (!steps.length) throw new SafeToolError('This workflow has no enabled steps. Add a step before starting it.');
        latest.workflowMode = 'selected'; latest.workflow = this.snapshot(view, routing ? 'active' : 'draft');
        this.save(latest, routing ? 'workflow.started' : 'workflow.selected');
    }
    snapshot(view: WorkflowView, phase: 'draft' | 'active' = 'draft'): WorkflowRun {
        const steps = materializeSteps(view.steps.map(editableStep));
        if (!steps.length) throw new SafeToolError('This workflow has no enabled steps.');
        return { id: view.id, name: view.name, definitionRevision: view.revision, steps, index: 0, phase, revision: 1, results: [], branches: {} };
    }
    async followUpOptions(task: Task): Promise<WorkflowSummary[]> {
        if (!isTaskClosed(task) || !task.workflow) return [];
        const definition = await this.definitions.get(task.projectPath, task.workflow.id);
        const result: WorkflowSummary[] = [];
        for (const id of workflowNextIds(definition.nextWorkflows)) {
            const target = await this.definitions.get(task.projectPath, id);
            if (target.steps.some(step => step.enabled)) result.push({
                id: target.id, name: target.name, description: target.description,
                stepCount: target.steps.filter(step => step.enabled).length, updatedAt: target.updatedAt
            });
        }
        return result;
    }
    async followUpDefinition(task: Task, workflowId: string): Promise<WorkflowView> {
        if (!isTaskClosed(task)) throw new SafeToolError('Complete this task before starting a follow-up workflow.');
        if (!(await this.followUpOptions(task)).some(option => option.id === workflowId)) throw new SafeToolError('This workflow is not configured as a completion action.');
        return this.definitions.get(task.projectPath, workflowId);
    }
    start(taskId: string): void {
        const task = this.store.task(taskId);
        if (task.workflow?.phase === 'draft') { transitionPhase(task.workflow, 'start'); this.save(task, 'workflow.started'); }
    }
    async instructions(task: Task): Promise<string> {
        if (!task.workflow && task.workflowMode === 'auto') return familyReferences(`WORKFLOW SELECTION: assess the user's first message and recommend a suitable saved workflow using workflow_route with its id and a short reason in the user's language. Available processes: ${JSON.stringify(await this.definitions.list(task.projectPath))}. Recommend id "chat" for a discussion that does not need a workflow. This proposes a choice; ONLY the user's selection starts the workflow or conversation. Do not execute the task, inspect repositories, or answer it before selection. If the request is too ambiguous to recommend a process, ask one clarifying question with ask_user. A workflow_route call must be the only tool call in its response.`);
        const workflow = task.workflow; if (!workflow) return '';
        const step = editableStep(workflow.steps[workflow.index]);
        const evidence = { userMessages: this.store.messageRecords(task.id).filter(item => item.role === 'user').slice(-10).map(item => ({ id: item.id, text: item.text.slice(0, 800) })), actions: this.store.runs(task.id).flatMap(run => this.store.actions(run.id)).filter(action => action.state === 'succeeded').slice(-30).map(action => ({ id: action.id, tool: action.tool, ...(action.method?{method:action.method}:{}) })) };
        const discussion = workflow.phase === 'review' && workflow.discussion ? `REVIEW DISCUSSION: the user sent a message about the pending result. Classify its intent. For a question, answer concisely in ordinary chat and remain on this review; a message is permitted in this mode. For an explicit request to change work, use workflow_revise to select a configured rework target and record the requested changes. If scope changes, reopen the relevant agreement/plan step instead of silently editing beyond its scope. If ambiguous, ask_user. Never treat prose as approval. Pending result revision ${workflow.pending?.revision} stays unapproved. Source mutations, execution and publishing are forbidden during discussion; transition first.\n` : '';
        return discussion + familyReferences(`ACTIVE WORKFLOW (persisted snapshot): ${JSON.stringify({ id: workflow.id, name: workflow.name, phase: workflow.phase, revision: workflow.revision, current: step, rework: workflow.rework, recordedBranches: Object.fromEntries(Object.entries(workflow.branches).map(([id, { commits, ...branch }]) => [id, { ...branch, commits: commits?.slice(-5) }])), recordedEdits: workflow.edits || {}, priorResults: workflow.results.map(result => ({ step: result.stepId, revision: result.revision, inputs: result.inputs, artifacts: result.artifacts, approved: !!result.approvedAt })), retiredReports: workflow.history?.slice(-10).map(entry => ({ id: `${entry.result.stepId}@${entry.result.revision}`, reason: entry.reason })), evidence })}
Work only on this step. Use workflow_ready to assess every Ready criterion before performing mutations. Use successful action IDs or user-message IDs as references; do not invent evidence. For ALL questions, clarification requests and user decisions, call ask_user instead of writing a question in ordinary chat or workflow_report. Supply 2–5 meaningful options, or options: [] for an open-ended answer. The engine pauses until the real user answers; stay on this step. For a technical blocker that cannot be resolved by a user answer, use workflow_report with status blocked. Outside REVIEW DISCUSSION, this is an executing workflow: a standalone message is not a permitted end-of-turn outcome. Include the next tool call, ask_user for a question, or workflow_report for a step result/blocker. Narrative text may accompany tool calls as commentary; it never creates a wait, approves a result or advances a step. Explicit interaction requests and step results control those transitions. The summary in workflow_report is shown directly to the user. Write it in the user’s language as 2–5 short Markdown bullets, aiming for at most 900 characters. Describe the outcome, a material blocker or risk, and what comes next. Format file paths and commands as inline code. Detailed architecture inventories, full Git hashes, command logs and criterion-by-criterion evidence belong in ChangeSets and criterion assessments. Prior step reports are stored in task memory; use task_memory_read_step to retrieve a specific report when needed. For a finished step, call workflow_report with status completed, a concise result, every Done criterion and saved ChangeSet artifact paths where relevant. Criteria statuses are met, unmet or not_applicable; explain each. Only the engine advances steps and obtains required approvals. Never interpret ordinary chat text as approval. If a plan must change, use workflow_revise to reopen its step; dependent results and approvals are invalidated; unaffected results, recorded branches and actual edits are preserved. A workflow control call must be the ONLY tool call in its response. Only tools selected for this step and workflow support tools are available. If an installed method is missing from this step, use workflow_request_tools with explicit tool ID#method references and a reason. Wait for the actual access-review result; an ordinary ask_user response never changes access. After approval reassess Ready before using mutations. If access is denied, report the blocker rather than repeating the request. Never substitute another tool to bypass restrictions. A newly saved tool is not automatically enabled for this step. When tools_propose is available, it can propose definitions but cannot grant step access. Saving a tool is not execution evidence. Report actual results and limitations; ask the user only for unavailable prerequisites or scenarios the tools cannot perform. Architecture memory is optional: store only durable code-backed project knowledge, never task progress, observations about a test run, logs or verification reports. Those belong in ChangeSets. Use context_update only for a concrete, reviewed memory change; otherwise explicitly record no memory change in the step report.`);
    }
    private current(context: ToolContext): Task {
        if (!context.taskId) throw new SafeToolError('This operation needs a task.'); const task = this.store.task(context.taskId);
        if (!task.workflow || task.workflow.waitingFor || task.workflow.phase !== 'active' || task.workflow.index >= task.workflow.steps.length) throw new SafeToolError('No active workflow step.');
        resultInputs(task.workflow);
        if (task.workflow.results.some(result => !resultIsCurrent(task.workflow!, result))) throw new SafeToolError('Workflow dependency results are stale. Reopen the affected prerequisite.');
        return task;
    }
    private criteria(task: Task, input: unknown, kind: 'definitionOfReady' | 'definitionOfDone'): CriterionResult[] {
        const expected = task.workflow!.steps[task.workflow!.index][kind];
        if (!Array.isArray(input) || input.length !== expected.length) throw new SafeToolError(`Report all ${kind} criteria, exactly once.`);
        const seen = new Set<number>();
        return input.map(item => {
            if (!item || !Number.isInteger(item.index) || item.index < 0 || item.index >= expected.length || seen.has(item.index) || !['met', 'unmet', 'not_applicable'].includes(item.status) || typeof item.explanation !== 'string' || !item.explanation.trim() || item.explanation.length > 1000 || !Array.isArray(item.references) || item.references.length > 10) throw new SafeToolError('Invalid criterion assessment. Include index, status, explanation and evidence references.');
            seen.add(item.index);
            for (const ref of item.references) {
                const message = this.store.messages(task.id).find(message => message.id === ref && message.role === 'user');
                const action = this.store.runs(task.id).flatMap(run => this.store.actions(run.id)).find(action => action.id === ref && action.state === 'succeeded');
                if (!message && !action) throw new SafeToolError('A criterion references missing or unsuccessful evidence.');
            }
            return { index: item.index, status: item.status, explanation: item.explanation, references: item.references };
        });
    }
    ready(args: Record<string, unknown>, context: ToolContext): string {
        const task = this.current(context); const ready = this.criteria(task, args.criteria, 'definitionOfReady'); task.workflow!.ready = ready;
        if (ready.some(item => item.status === 'unmet')) { transitionPhase(task.workflow!, 'block'); task.workflow!.notice = 'Ready criteria are not met. Reply to resolve the prerequisites.'; }
        this.save(task, 'workflow.ready'); return JSON.stringify({ ready: task.workflow!.phase === 'active', criteria: ready });
    }
    async report(args: Record<string, unknown>, context: ToolContext): Promise<string> {
        const task = this.current(context); const workflow = task.workflow!;
        if (typeof args.summary !== 'string' || !args.summary.trim() || args.summary.length > 1800 || !['blocked', 'completed'].includes(String(args.status))) throw new SafeToolError('Provide a brief user-facing Markdown result or technical blocker, up to 1800 characters. Put technical details in criteria or the ChangeSet.');
        if (args.status === 'blocked') { transitionPhase(workflow, 'block'); workflow.notice = args.summary; this.transcript(task, args.summary, context.runId); this.save(task, 'workflow.waiting'); return JSON.stringify({ state: workflow.phase }); }
        if (!workflow.ready || workflow.ready.some(item => item.status === 'unmet')) throw new SafeToolError('Assess Ready criteria first.');
        const done = this.criteria(task, args.criteria, 'definitionOfDone'); if (done.some(item => item.status === 'unmet')) throw new SafeToolError('Done criteria are unmet. Report a blocker or request clarification.');
        if (!Array.isArray(args.artifacts) || args.artifacts.length > 10) throw new SafeToolError('Provide an array of saved ChangeSet paths.');
        const artifacts: WorkflowArtifact[] = [];
        for (const path of args.artifacts) { if (typeof path !== 'string' || !/^changesets\//.test(path)) throw new SafeToolError('Artifacts must be saved ChangeSets.'); const doc = await this.documents.read(task.projectPath, path.slice(11)); artifacts.push({ path: doc.path, digest: doc.planDigest }); }
        const step = workflow.steps[workflow.index];
        const observations: Record<string, WorkflowObservation> = {};
        const captured = new Map<string, WorkflowObservation>();
        const capture = async (id: string) => {
            if (captured.has(id)) return captured.get(id)!;
            const observer = this.observers.find(item => item.id === id);
            if (!observer) throw new SafeToolError(`Review safeguard "${id}" is not installed.`);
            const value = await observer.capture(task, context.signal); captured.set(id, value); return value;
        };
        for (const result of workflow.results) for (const [id, observation] of Object.entries(result.observations || {})) {
            if ((await capture(id)).fingerprint !== observation.fingerprint) throw new SafeToolError(`Reviewed evidence from "${result.stepId}" changed. Reopen that step or its affected prerequisite before reporting completion.`);
        }
        if (step.approval) for (const id of step.reviewEvidence || []) {
            observations[id] = await capture(id);
        }
        if (this.supports(task, context, 'changeset-write') && !artifacts.length) throw new SafeToolError('Link the saved ChangeSet before completing this step.');
        if (this.store.task(task.id).workflow?.revision !== workflow.revision) throw new SafeToolError('The step changed while its result was being checked.');
        return this.store.transaction(() => {
            const result: WorkflowStepResult = { stepId: step.id, revision: ++workflow.revision, inputs: resultInputs(workflow), summary: [String(args.summary), ...Object.values(observations).flatMap(value => value.summary ? [value.summary] : [])].join('\n\n'), ready: workflow.ready!, done, artifacts, ...(step.approval ? { observations } : {}) };
            if (step.approval) {
                workflow.pending = result; transitionPhase(workflow, 'requestReview'); workflow.notice = result.summary;
                workflow.waitingFor = this.interactions.create({ key: `workflow:${result.stepId}:${result.revision}`, taskId: task.id, runId: context.runId, kind: 'workflow_approval', stepId: result.stepId, revision: result.revision, review: { step, result } }).id;
            } else this.advance(task, result);
            this.transcript(task, result.summary, context.runId);
            this.save(task, 'workflow.reported');
            return JSON.stringify({ phase: workflow.phase, step: workflow.index });
        });
    }
    private advance(task: Task, result: WorkflowStepResult): void {
        const workflow = task.workflow!;
        transitionPhase(workflow, 'acceptResult'); workflow.results.push(result);
        const next = nextUnresolvedStep(workflow); workflow.index = next < 0 ? workflow.steps.length : next;
        workflow.ready = undefined;
        workflow.pending = undefined;
        workflow.notice = undefined;
        workflow.waitingFor = undefined;
        workflow.discussion = undefined;
        if (workflow.index < workflow.steps.length) {
            workflow.phase = 'active';
            return;
        }
        transitionPhase(workflow, 'complete');
        task.closedAt = Date.now();
        task.state = 'completed';
        task.draft = '';
        this.interactions.invalidate(task.id, () => true);
        this.store.event(task.id, undefined, 'task.closed', { workflow: workflow.id });
    }
    async approve(taskId: string, revision: number): Promise<void> {
        const task = this.store.task(taskId); const workflow = task.workflow;
        if (workflow?.phase !== 'review' || !workflow.pending || workflow.pending.revision !== revision) throw new SafeToolError('The step result changed. Review its current revision.');
        if (workflow.results.some(result => !resultIsCurrent(workflow, result)) || (workflow.pending.inputs && JSON.stringify(workflow.pending.inputs) !== JSON.stringify(resultInputs(workflow)))) throw new SafeToolError('The reviewed dependency versions changed. Request a fresh result.');
        const request = workflow.waitingFor && this.store.interaction(workflow.waitingFor);
        if (workflow.discussion) throw new SafeToolError('Wait for the current discussion to finish before approving.');
        if (!request || request.kind !== 'workflow_approval' || request.state !== 'pending' || request.revision !== revision) throw new SafeToolError('The approval request changed. Review the current step.');
        for (const artifact of workflow.pending.artifacts) if ((await this.documents.read(task.projectPath, artifact.path.slice(11))).planDigest !== artifact.digest) throw new SafeToolError('ChangeSet changed after review was requested. Send feedback to revise and submit it again.');
        for (const [id, observed] of Object.entries(workflow.pending.observations || {})) {
            const observer = this.observers.find(item => item.id === id);
            if (!observer || (await observer.capture(task, AbortSignal.timeout(30000))).fingerprint !== observed.fingerprint) throw new SafeToolError('The reviewed source state changed. Request a fresh review before approving.');
        }
        if (this.store.task(taskId).workflow?.revision !== workflow.revision || this.store.task(taskId).workflow?.discussion) throw new SafeToolError('The result changed while being approved.');
        this.store.transaction(() => {
            this.interactions.approve(request, true);
            workflow.pending!.approvedAt = Date.now(); const approved = workflow.pending!;
            this.advance(task, approved); workflow.revision++; this.save(task, 'workflow.approved');
            this.store.putMessage({ id: `workflow-approval:${task.id}:${approved.revision}`, taskId: task.id, role: 'user', providerOnly: true, text: `[IDE approval receipt] The user clicked Approve and continue for step "${approved.stepId}", result revision ${approved.revision}. The engine verified this result and its ChangeSet plan digests. This step is approved. Continue with the current step "${workflow.steps[workflow.index]?.title || 'Completed'}" from the active workflow snapshot; do not ask to approve the previous result again.`, createdAt: Date.now() });
            this.store.putMessage({ id: `workflow-approval-display:${task.id}:${approved.revision}`, taskId: task.id, role: 'user', text: `Approved “${workflow.steps.find(step => step.id === approved.stepId)?.title || approved.stepId}”.`, createdAt: Date.now(), localOnly: true });
        });
    }
    feedback(taskId: string, discussion = false): void {
        const task = this.store.task(taskId); if (!task.workflow || task.workflow.phase === 'completed') return;
        if (discussion && task.workflow.phase === 'review') { transitionPhase(task.workflow, 'discuss'); task.workflow.discussion = true; this.save(task, 'workflow.discussion_started'); return; }
        if (task.workflow.notice && !this.store.messages(taskId).some(message => message.role === 'assistant' && message.text === task.workflow!.notice)) this.transcript(task, task.workflow.notice);
        this.interactions.invalidate(taskId, item => item.kind === 'workflow_approval');
        if (task.workflow.pending) { task.workflow.ready = undefined; task.workflow.history ||= []; task.workflow.history.push({ result: task.workflow.pending, invalidatedAt: Date.now(), reason: 'User requested revision of this result.' }); }
        transitionPhase(task.workflow, 'feedback'); task.workflow.discussion = undefined; task.workflow.waitingFor = undefined; task.workflow.pending = undefined; task.workflow.notice = undefined; task.workflow.revision++; this.save(task, 'workflow.feedback');
    }
    finishDiscussion(taskId: string): void { const task = this.store.task(taskId); if (task.workflow?.discussion) { task.workflow.discussion = undefined; this.save(task, 'workflow.discussion_finished'); } }
    revise(args: Record<string, unknown>, context: ToolContext): string {
        if (!context.taskId) throw new SafeToolError('This operation needs a task.');
        const task = this.store.task(context.taskId); const workflow = task.workflow;
        if (!workflow || isTaskClosed(task) || !['active', 'review', 'blocked'].includes(workflow.phase) || typeof args.stepId !== 'string' || typeof args.reason !== 'string') throw new SafeToolError('No revisable workflow step.');
        const transition = reopenStep(workflow, args.stepId, args.reason);
        this.interactions.invalidate(task.id, item => !!item.stepId); workflow.waitingFor = undefined;
        this.save(task, 'workflow.revised', { ...transition, target: args.stepId, reason: args.reason }); return JSON.stringify({ step: workflow.index, ...transition, retained: workflow.results.map(result => result.stepId) });
    }
    async authorize(context: ToolContext, operation: WorkflowOperation, repository?: string, path?: string): Promise<ChangeScope[]> {
        const task = this.current(context); const workflow = task.workflow!;
        if (!this.supports(task, context, operation) || !workflow.ready || workflow.ready.some(item => item.status === 'unmet')) throw new SafeToolError('This operation is not enabled for the active, ready workflow step.');
        if (!['repository-edit', 'branch-create', 'repository-commit', 'repository-publish'].includes(operation)) return [];
        return this.approvedScope(task, repository, path);
    }
    async preparationScope(context: ToolContext, repository: string): Promise<ChangeScope[]> {
        const task = this.current(context);
        if (!this.supports(task, context, 'branch-create')) throw new SafeToolError('Restore before branch creation is available only during Git preparation.');
        return this.approvedScope(task, repository);
    }
    private async approvedScope(task: Task, repository?: string, path?: string): Promise<ChangeScope[]> {
        const artifacts = task.workflow!.results.filter(result => result.approvedAt).flatMap(result => result.artifacts);
        const allowed: ChangeScope[] = [];
        for (const artifact of artifacts) {
            const doc = await this.documents.read(task.projectPath, artifact.path.slice(11)); if (doc.planDigest !== artifact.digest) throw new SafeToolError('An approved ChangeSet changed. Reopen its step and obtain approval again.');
            allowed.push(...doc.scope.filter(scope => scope.repository === repository && (path === undefined || scope.paths.includes(path))));
        }
        if (!allowed.length) throw new SafeToolError('The repository or file is outside the approved ChangeSet scope. Revise the plan and obtain approval first.');
        return allowed;
    }
    recordBranch(context: ToolContext, repository: string, value: { branch: string; base: string; head: string }): void { const task = this.current(context); task.workflow!.branches[repository] = value; this.save(task, 'workflow.branch_prepared'); }
    branch(context: ToolContext, repository: string): WorkflowRun['branches'][string] | undefined { return context.taskId ? this.store.task(context.taskId).workflow?.branches[repository] : undefined; }
    recordCommit(context: ToolContext, repository: string, parent: string, head: string): void {
        const task = this.current(context); const branch = task.workflow!.branches[repository];
        if (!branch || (branch.tip || branch.head) !== parent || !/^[a-f0-9]{40,64}$/.test(head)) throw new SafeToolError('The recorded task commit changed.');
        branch.commits ||= []; branch.commits.push({ parent, head }); branch.tip = head; this.save(task, 'workflow.commit_recorded');
    }
    edits(context: ToolContext, repository: string): Record<string, string | null> { return context.taskId ? this.store.task(context.taskId).workflow?.edits?.[repository] || {} : {}; }
    recordEdit(context: ToolContext, repository: string, path: string, digest: string | null): void { const task = this.current(context); task.workflow!.edits ||= {}; task.workflow!.edits[repository] ||= {}; task.workflow!.edits[repository][path] = digest; this.save(task, 'workflow.file_changed'); }
    register(tools: ToolRegistry): void {
        const assessment = { type: 'array', items: { type: 'object', properties: { index: { type: 'integer' }, status: { type: 'string', enum: ['met', 'unmet', 'not_applicable'] }, explanation: { type: 'string' }, references: { type: 'array', items: { type: 'string' } } }, required: ['index', 'status', 'explanation', 'references'], additionalProperties: false } };
        const add = (name: string, description: string, properties: Record<string, unknown>, run: (args: Record<string, unknown>, context: ToolContext) => Promise<string> | string, routing = false) => tools.register({ access: scopeAccess({ 'workflow-control': 'allow' }, undefined, ['write']), turnControl: true, workflowSupport: !routing, definition: { name, description, parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } }, available: context => !!context.taskId && context.purpose !== 'repository-analysis' && (routing ? this.store.task(context.taskId).workflowMode === 'auto' && !this.store.task(context.taskId).workflow : !!this.store.task(context.taskId).workflow), prepare: async () => ({ scope: 'workflow-control' }), execute: async (args, _prepared, context) => run(args, context) });
        add('workflow_ready', 'Assess every prerequisite before starting this step. Read-only discovery is allowed before this assessment.', { criteria: assessment }, (args, context) => this.ready(args, context));
        add('workflow_report', 'Submit the current step result or a technical blocker that cannot be resolved by a user answer. Summary is a brief Markdown message to the user: 2–5 short bullets in their language, ideally under 900 characters. Keep detailed evidence in criterion assessments and ChangeSets. For questions and decisions use ask_user instead. Required approvals and transitions are controlled by the engine.', { status: { type: 'string', enum: ['blocked', 'completed'] }, summary: { type: 'string', maxLength: 1800, description: 'Brief user-facing Markdown, 2–5 short bullets. Outcome, material blocker/risk, next action. Technical inventories and logs belong in ChangeSets or criteria.' }, criteria: assessment, artifacts: { type: 'array', items: { type: 'string' } } }, (args, context) => this.report(args, context));
        add('workflow_revise', 'Request rework at a configured current or earlier step. Record the user feedback or technical reason. The dependency graph invalidates only affected results and approvals, preserves history and real branches/edits, and schedules the necessary repeat passes. Use this for requested changes, not for a question or ordinary discussion.', { stepId: { type: 'string' }, reason: { type: 'string' } }, (args, context) => this.revise(args, context));
        const toolAccess = new WorkflowToolAccess(this.store, this.tools);
        tools.register({
            access: scopeAccess({ 'workflow-control': 'allow' }, undefined, ['write']), workflowSupport: true, turnControl: true, interaction: true,
            definition: { name: 'workflow_request_tools', description: 'Request explicit user approval to add installed tool methods to the CURRENT task step. Use stable project tool IDs, e.g. builtin.changesets#notes. Presents an access review and pauses; an ordinary ask_user answer does not enable tools. Approval resets readiness and does not change tool policies, approved ChangeSet scope, future steps or project workflow definitions. A denied request must not be repeated unless the user asks.', parameters: { type: 'object', properties: { tools: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 }, reason: { type: 'string' } }, required: ['tools', 'reason'], additionalProperties: false } },
            available: context => !!context.taskId && context.purpose !== 'repository-analysis' && this.store.task(context.taskId).workflow?.phase === 'active',
            prepare: async () => ({ scope: 'workflow-control' }), execute: async (args, _prepared, context) => toolAccess.propose(args, context), respond: async (request, response, context) => toolAccess.respond(request, response, context)
        });
        tools.register({
            access: scopeAccess({ 'workflow-control': 'allow' }, undefined, ['write']), turnControl: true, interaction: true,
            definition: { name: 'workflow_route', description: 'Recommend a saved workflow or chat from the first message and explain why. Presents all available choices to the user and pauses. Only the user can select and start a process.', parameters: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id', 'reason'], additionalProperties: false } },
            available: context => !!context.taskId && context.purpose !== 'repository-analysis' && this.store.task(context.taskId).workflowMode === 'auto' && !this.store.task(context.taskId).workflow,
            prepare: async () => ({ scope: 'workflow-control' }),
            execute: async (args, _prepared, context): Promise<ToolInteraction> => {
                if (typeof args.id !== 'string' || typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 2000) throw new SafeToolError('Recommend a workflow ID and provide a short reason.');
                const choices = (await this.definitions.list(context.projectPath)).filter(item => item.stepCount > 0).map(item => ({ id: item.id, label: item.name, description: item.description }));
                choices.push({ id: 'chat', label: 'Continue without workflow', description: 'Discuss this request without a step-by-step process.' });
                if (!choices.some(item => item.id === args.id)) throw new SafeToolError('Recommend one of the available workflows or chat.');
                choices.sort((a, b) => Number(b.id === args.id) - Number(a.id === args.id));
                return { kind: 'workflow_selection', recommendedId: args.id, question: { question: args.reason.trim(), options: choices } };
            },
            respond: async (request: InteractionRequest, response: InteractionResponse) => {
                if (!response || !('optionId' in response) || typeof response.optionId !== 'string' || Object.keys(response).length !== 1 || !request.question?.options.some(option => option.id === response.optionId)) throw new SafeToolError('Select one of the offered workflows.');
                await this.select(request.taskId, response.optionId, true, request);
                return JSON.stringify({ selected: response.optionId, optionId: response.optionId, text: request.question.options.find(option => option.id === response.optionId)!.label });
            }
        });
    }
}
