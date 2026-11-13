import { taskOriginOverview } from './task-origin';
import { WorkflowToolScope } from './workflow-tool-scope';
import { isTaskClosed, toolOperation } from '../../../common/task-service';
import { randomUUID, createHash } from 'crypto';
import { Action, Run, Task, TaskSnapshot } from '../../../common/task-service';
import { HarnessStore, ModelProvider, ModelProtocolError, OutputFilter, Policy, ProjectContextSource, ToolContext, ToolRegistry } from './contracts';
import { ContextBuilder } from './context';
import { summarizeReads } from '../../../common/task-timeline';

import { WorkflowEngine } from './workflow-engine';
import { InteractionRequest, InteractionResponse, QuestionAnswer } from '../../../common/interaction';
import { InteractionManager, questionAnswer } from './interactions';
import { SafeToolError } from '../modules/file-tools';
import { TaskContextManager, ModelTaskSummarizer } from './task-context';
import { analyzeToolAction } from './tool-access';
import { isReadOnly } from './command-analysis';

const active = (run: Run) => run.state === 'running' || run.state === 'awaiting_approval';
export class TaskRuntime {
    private readonly controllers = new Map<string, AbortController>();
    private readonly context: ContextBuilder;
    private readonly interactions: InteractionManager;
    private readonly taskContext: TaskContextManager;
    constructor(private readonly store: HarnessStore, private readonly model: ModelProvider, private readonly tools: ToolRegistry, private readonly policy: Policy, private readonly filter: OutputFilter, projectContext?: ProjectContextSource, private readonly workflows?: WorkflowEngine, taskContext?: TaskContextManager) {
        this.context = new ContextBuilder(projectContext, task => task.origin ? taskOriginOverview(store, task) : undefined); this.interactions = new InteractionManager(store); this.taskContext = taskContext || new TaskContextManager(store, new ModelTaskSummarizer(model)); store.recover();
    }
    list(projectPath: string): Task[] { return this.store.tasks(projectPath).filter(task => task.kind !== 'repository-analysis'); }
    researchJobs(projectPath: string): Task[] { return this.store.tasks(projectPath).filter(task => task.kind === 'repository-analysis'); }
    private taskDraft(projectPath: string): Task {
        return { id: randomUUID(), projectPath, title: 'New task', draft: '', state: 'idle', ...(this.workflows ? { workflowMode: 'auto' as const } : {}), createdAt: Date.now(), updatedAt: Date.now() };
    }
    create(projectPath: string): Task {
        const task = this.taskDraft(projectPath);
        this.store.transaction(() => { this.store.putTask(task); this.store.event(task.id, undefined, 'task.created'); }); return task;
    }
    async followUpOptions(taskId: string): Promise<import('../../../common/workflow-service').WorkflowSummary[]> {
        return this.workflows ? this.workflows.followUpOptions(this.store.task(taskId)) : [];
    }
    async startFollowUp(taskId: string, workflowId: string, requestId: string): Promise<Task> {
        if (!this.workflows || !/^[\w-]{1,100}$/.test(requestId)) throw new Error('Provide a valid follow-up request.');
        const source = this.store.task(taskId);
        const previous = () => this.store.tasks(source.projectPath).find(task => task.origin?.taskId === taskId && task.origin.requestId === requestId);
        const reuse = (task: Task) => {
            if (task.origin?.workflowId !== workflowId) throw new Error('This request already created a different follow-up workflow.');
            return task;
        };
        const existing = previous();
        if (existing) return reuse(existing);
        const view = await this.workflows.followUpDefinition(source, workflowId);
        const workflow = this.workflows.snapshot(view, 'active');
        const outcome = this.store.transaction(() => {
            const duplicate = previous();
            if (duplicate) return { task: reuse(duplicate) };
            if (!isTaskClosed(this.store.task(taskId))) throw new Error('The source task must be complete.');
            const task = this.taskDraft(source.projectPath);
            task.origin = { taskId, workflowId, requestId };
            task.title = `${view.name} · ${source.title}`.slice(0, 160);
            task.workflowMode = 'selected';
            task.workflow = workflow;
            this.store.putTask(task);
            this.store.event(task.id, undefined, 'task.created');
            const run = this.newRun(task, 'model');
            this.store.putMessage({
                id: `follow-up:${task.id}`, taskId: task.id, runId: run.id, role: 'user',
                text: `Run ${view.name} for the completed task “${source.title}”.`,
                createdAt: Date.now()
            });
            this.store.event(task.id, run.id, 'task.follow_up_created', { sourceTaskId: source.id, workflowId });
            this.store.event(source.id, undefined, 'task.follow_up_created', { taskId: task.id, workflowId });
            return { task, run };
        });
        if (outcome.run) this.schedule(outcome.run);
        return outcome.task;
    }
    analyzeRepository(projectPath: string, repository: string, repositoryRevision?: string): Task {
        if (!/^[a-z0-9][a-z0-9-]*$/i.test(repository)) throw new Error('Choose a connected repository.');
        const existing = this.store.tasks(projectPath).find(task => task.kind === 'repository-analysis' && task.repository === repository && task.repositoryRevision === repositoryRevision && ['running', 'awaiting_approval'].includes(task.state));
        if (existing) return existing;
        const task = this.create(projectPath); task.kind = 'repository-analysis'; task.workflowMode = 'chat'; task.repository = repository; task.repositoryRevision = repositoryRevision; task.title = `Analyze ${repository}`; this.store.putTask(task);
        this.send(task.id, `Analyze repository ${repository} and save its compact architecture context with source references.`, randomUUID());
        return this.store.task(task.id);
    }
    snapshot(taskId: string): TaskSnapshot {
        const runs = this.store.runs(taskId); const actions = runs.flatMap(run => this.store.actions(run.id));
        return { task: this.store.task(taskId), messages: this.store.messageRecords(taskId).filter(message => message.role !== 'tool' && !message.providerOnly && !!message.text).map(({ continuation, ...message }) => message), runs, actions: actions.map(({ prepared, ...action }) => {
            if (toolOperation(action) === 'repository_replace') { const { replacements, ...args } = action.args; return { ...action, args: { ...args, replacementCount: Array.isArray(replacements) ? replacements.length : 0 } }; }
            if (toolOperation(action) === 'repository_edit') { const { content, ...args } = action.args; return { ...action, args: { ...args, edit: content === null ? 'delete' : 'write', bytes: typeof content === 'string' ? Buffer.byteLength(content) : 0 } }; }
            if (toolOperation(action) !== 'files_read') return action;
            const { result, ...metadata } = action; return { ...metadata, readFiles: summarizeReads(action) };
        }), interactions: this.store.interactions(taskId), approvals: actions.flatMap(action => this.store.approvals(action.id)), events: this.store.events(taskId) };
    }
    async setWorkflow(taskId: string, choice: string): Promise<void> { this.ensureIdle(taskId); if (!this.workflows) throw new Error('Workflow engine unavailable.'); await this.workflows.select(taskId, choice); }
    async approveStep(taskId: string, revision: number): Promise<void> {
        this.ensureIdle(taskId); if (!this.workflows) throw new Error('Workflow engine unavailable.');
        await this.workflows.approve(taskId, revision);
        if (!isTaskClosed(this.store.task(taskId))) this.resume(taskId);
    }
    saveDraft(taskId: string, text: string): void {
        if (typeof text !== 'string' || text.length > 32000) throw new Error('Draft is too long.');
        const task = this.openTask(taskId); task.draft = text; this.store.putTask(task);
    }
    private pendingQuestion(taskId: string): InteractionRequest | undefined { return this.store.interactions(taskId).find(item => ['question', 'tool_proposal', 'workflow_selection', 'workflow_tools'].includes(item.kind) && item.state === 'pending'); }
    private openTask(taskId: string): Task {
        const task = this.store.task(taskId);
        if (isTaskClosed(task)) throw new Error('This task is closed. Start a new task to continue.');
        return task;
    }
    private ensureIdle(taskId: string, answering = false): void {
        this.openTask(taskId);
        if (this.controllers.has(taskId) || this.store.runs(taskId).some(active)) throw new Error('This task already has an active run. Stop it or answer its approval request first.');
        if (!answering && this.pendingQuestion(taskId)) throw new Error('Answer the pending question or stop the task first.');
    }
    private newRun(task: Task, kind: Run['kind']): Run {
        const run: Run = { id: randomUUID(), taskId: task.id, state: 'running', kind, steps: 0, createdAt: Date.now(), updatedAt: Date.now() };
        task.state = 'running'; task.updatedAt = Date.now(); this.store.putTask(task); this.store.putRun(run); this.store.event(task.id, run.id, 'run.started', { provider: kind === 'model' ? this.model.id : 'manual-action' }); return run;
    }
    send(taskId: string, text: string, requestId: string): void {
        if (typeof text !== 'string' || !text.trim() || text.length > 32000 || !/^[\w-]{1,100}$/.test(requestId)) throw new Error('Enter a message of up to 32,000 characters.');
        const messageId = `user:${taskId}:${requestId}`;
        if (this.store.messages(taskId).some(message => message.id === messageId)) return;
        this.openTask(taskId);
        const question = this.pendingQuestion(taskId);
        if (question) { if (question.kind !== 'question') throw new Error(question.kind === 'workflow_tools' ? 'Review the requested step tools above first.' : question.kind === 'workflow_selection' ? 'Select a workflow in the choice above first.' : 'Save or reject the pending tool proposal first.'); this.answerInteractionQuestion(question.id, { text }, messageId); return; }
        this.ensureIdle(taskId);
        // The configured output hook currently enforces only size limits.
        const safe = this.filter.filter(text.trim());
        const run = this.store.transaction(() => {
            this.workflows?.start(taskId);
            this.workflows?.feedback(taskId, true);
            const task = this.store.task(taskId);
            if (this.workflows && task.kind !== 'repository-analysis' && !task.workflowMode && !task.workflow && !this.store.messages(taskId).some(message => message.role === 'user')) task.workflowMode = 'auto';
            if (task.kind !== 'repository-analysis' && !this.store.messages(taskId).some(message => message.role === 'user')) task.title = safe.replace(/\s+/g, ' ').slice(0, 64);
            task.draft = ''; const started = this.newRun(task, 'model');
            this.store.putMessage({ id: messageId, taskId, runId: started.id, role: 'user', text: safe, createdAt: Date.now() });
            this.store.event(taskId, started.id, 'message.added', { role: 'user' }); return started;
        }); this.schedule(run);
    }
    resume(taskId: string): void {
        this.ensureIdle(taskId);
        const phase = this.store.task(taskId).workflow?.phase;
        if (phase === 'review' && !this.store.task(taskId).workflow?.discussion) throw new Error('Approve the step or send feedback before continuing.');
        if (phase === 'blocked') this.workflows?.feedback(taskId);
        if (!this.store.messages(taskId).some(message => message.role === 'user')) throw new Error('Send a message to start this task.');
        const run = this.store.transaction(() => this.newRun(this.store.task(taskId), 'model')); this.schedule(run);
    }
    readFiles(taskId: string, paths: string[]): void {
        this.ensureIdle(taskId);
        if (!Array.isArray(paths) || !paths.length || paths.length > 20 || paths.some(path => typeof path !== 'string' || !path.trim() || path.length > 4096)) throw new Error('Enter 1–20 project-relative file paths.');
        const normalized = [...new Set(paths.map(path => path.trim()))];
        const run = this.store.transaction(() => {
            const task = this.store.task(taskId); if (task.title === 'New task') task.title = normalized.length === 1 ? `Read ${normalized[0]}`.slice(0, 64) : `Read ${normalized.length} files`;
            const started = this.newRun(task, 'action');
            this.store.putAction({ id: randomUUID(), taskId, runId: started.id, callId: randomUUID(), ...this.tools.canonicalCall('files_read',task.projectPath), args: { paths: normalized }, reason: 'Read these files locally. This standalone action does not call the external model.', state: 'requested', createdAt: Date.now(), updatedAt: Date.now() });
            return started;
        }); this.schedule(run);
    }
    cancel(taskId: string): void {
        if (isTaskClosed(this.store.task(taskId))) return;
        const question = this.pendingQuestion(taskId);
        const run = this.store.runs(taskId).find(run => active(run) || run.id === question?.runId); if (!run) return;
        this.controllers.get(taskId)?.abort();
        this.store.transaction(() => {
            for (const action of this.store.actions(run.id)) {
                if (['requested', 'running', 'awaiting_approval', 'waiting'].includes(action.state)) {
                    action.state = 'cancelled'; action.error = 'Cancelled by the user.'; action.updatedAt = Date.now(); this.store.putAction(action);
                    for (const approval of this.store.approvals(action.id).filter(item => item.state === 'pending')) { approval.state = 'revoked'; this.store.putApproval(approval); }
                    this.toolResult(action, JSON.stringify({ error: action.error }));
                }
            }
            this.interactions.invalidate(taskId, item => item.runId === run.id, 'cancelled');
            const task = this.store.task(taskId); if (task.workflow?.waitingFor === question?.id && task.workflow) { task.workflow.waitingFor = undefined; this.store.putTask(task); }
            this.finish(run, 'cancelled');
        });
    }
    async respondInteraction(id: string, response: InteractionResponse): Promise<void> {
        const request = this.store.interaction(id);
        if (request.kind === 'tool_proposal' || request.kind === 'workflow_selection' || request.kind === 'workflow_tools') { await this.respondToolInteraction(request, response); return; }
        if (request.kind === 'question') { this.answerInteractionQuestion(id, response as QuestionAnswer); return; }
        if (!response || !('approved' in response) || typeof response.approved !== 'boolean' || Object.keys(response).length !== 1) throw new Error('Choose approve or deny.');
        if (request.state === 'answered' && JSON.stringify(request.response) === JSON.stringify(response)) return;
        if (request.state !== 'pending') throw new Error('This approval is no longer pending.');
        if (request.kind === 'action_approval' && request.actionId) { this.decide(request.actionId, response.approved); return; }
        if (!response.approved) {
            this.ensureIdle(request.taskId);
            const workflow = this.store.task(request.taskId).workflow;
            if (!this.workflows || workflow?.waitingFor !== id || workflow.pending?.revision !== request.revision) throw new Error('This approval is no longer pending.');
            this.store.transaction(() => {
                this.interactions.approve(request, false); this.workflows!.feedback(request.taskId);
                const task = this.store.task(request.taskId); task.state = 'idle'; this.store.putTask(task);
                this.store.putMessage({ id: `decline:${id}`, taskId: task.id, role: 'user', text: 'I requested changes to this step result. I will provide further feedback; no approval was granted.', createdAt: Date.now() });
            }); return;
        }
        await this.approveStep(request.taskId, request.revision!);
    }
    private readonly resolvingInteractions = new Set<string>();
    private async respondToolInteraction(request: InteractionRequest, response: InteractionResponse): Promise<void> {
        if (request.state === 'answered' && JSON.stringify(request.response) === JSON.stringify(response)) return;
        this.ensureIdle(request.taskId, true);
        const task = this.store.task(request.taskId); const workflow = task.workflow;
        if (request.state !== 'pending' || !request.actionId || !request.runId || this.resolvingInteractions.has(request.id) || (request.stepId && (workflow?.steps[workflow.index]?.id !== request.stepId || workflow.revision !== request.revision))) throw new Error('This proposal is no longer awaiting a response.');
        await this.tools.refreshProject(task.projectPath);
        const action = this.store.action(request.actionId); const run = this.store.run(request.runId); const registration = this.tools.registration(action.tool, task.projectPath, action.method);
        const executor = registration.executor; action.handlerId = registration.handlerId; action.handlerTool = registration.handlerTool;
        if (!executor.respond || action.state !== 'waiting' || run.state !== 'waiting_input' || run.waitingFor !== request.id) throw new Error('This proposal is no longer pending.');
        this.resolvingInteractions.add(request.id);
        try {
            const context = { projectPath: task.projectPath, signal: AbortSignal.timeout(15000), taskId: task.id, runId: run.id };
            new WorkflowToolScope(this.tools).assert(action.tool, this.store.task(task.id), context, action.method);
            this.assertWorkflowAction(action);
            const operation = analyzeToolAction(registration.access, action.args, action.prepared || {});
            if (action.operation && JSON.stringify(action.operation) !== JSON.stringify(operation)) throw new SafeToolError('Tool operation semantics changed during review. Request this proposal again.');
            const verdict = await this.policy.evaluate(action, this.tools.registration(action.tool, task.projectPath, action.method).access, context);
            if (this.tools.registration(action.tool, task.projectPath, action.method).revision !== registration.revision) throw new SafeToolError('Tool manifest changed during review. Request this proposal again.');
            if (verdict.decision === 'deny' || (action.authorization && JSON.stringify(action.authorization) !== JSON.stringify(verdict))) throw new SafeToolError('Tool policy changed while this proposal was waiting. Stop and request a new proposal under the current policy.');
            const result = this.filter.filter(await executor.respond(request, response, context));
            // A user may stop the task while a response is being persisted. Never restart it then.
            if (this.store.interaction(request.id).state !== 'pending') return;
            this.store.transaction(() => {
                request.state = 'answered'; request.response = response; request.result = result; request.resolvedAt = Date.now(); this.store.putInteraction(request);
                action.state = 'succeeded'; action.result = result; action.updatedAt = Date.now(); this.store.putAction(action); this.toolResult(action, result);
                run.state = 'running'; run.waitingFor = undefined; run.outcome = undefined; run.updatedAt = Date.now(); this.store.putRun(run);
                const latest = this.store.task(task.id);
                latest.state = 'running'; latest.updatedAt = Date.now(); if (latest.workflow) latest.workflow.waitingFor = undefined; this.store.putTask(latest);
                if (request.kind === 'workflow_tools') this.store.putMessage({ id: `tool-access:${request.id}`, taskId: task.id, runId: run.id, role: 'user', text: 'approved' in response && response.approved ? `Enabled for this step: ${request.toolAccess!.tools.map(item => item.label).join(', ')}.` : 'Kept the current step tools.', createdAt: Date.now(), localOnly: true });
                if (request.kind === 'workflow_selection') this.store.putMessage({ id: `selection:${request.id}`, taskId: task.id, runId: run.id, role: 'user', text: JSON.parse(result).text, createdAt: Date.now() });
                this.store.event(task.id, run.id, 'interaction.answered', { interactionId: request.id });
            });
            this.schedule(run);
        } finally { this.resolvingInteractions.delete(request.id); }
    }
    private answerInteractionQuestion(id: string, answer: QuestionAnswer, messageId?: string): void {
        const request = this.store.interaction(id);
        if (request.kind !== 'question' || !request.question || !request.actionId || !request.runId) throw new Error('This interaction is not a question.');
        const result = this.filter.filter(questionAnswer(request.question, answer));
        if (request.state === 'answered' && request.result === result) return;
        this.ensureIdle(request.taskId, true);
        const task = this.store.task(request.taskId); const workflow = task.workflow;
        if (request.state !== 'pending' || (request.stepId && (workflow?.steps[workflow.index]?.id !== request.stepId || workflow.revision !== request.revision))) throw new Error('This question is no longer awaiting an answer.');
        const response = JSON.parse(result) as { text: string };
        const run = this.store.transaction(() => {
            request.state = 'answered'; request.response = answer; request.result = result; request.resolvedAt = Date.now(); this.store.putInteraction(request);
            const action = this.store.action(request.actionId!); const current = this.store.run(request.runId!);
            if (action.state !== 'waiting' || current.waitingFor !== id || current.state !== 'waiting_input') throw new Error('This question is no longer awaiting an answer.');
            action.state = 'succeeded'; action.result = result; action.updatedAt = Date.now(); this.store.putAction(action); this.toolResult(action, result);
            current.state = 'running'; current.waitingFor = undefined; current.outcome = undefined; current.updatedAt = Date.now(); this.store.putRun(current);
            task.state = 'running'; task.draft = ''; task.updatedAt = Date.now(); if (workflow) workflow.waitingFor = undefined; this.store.putTask(task);
            this.store.putMessage({ id: messageId || `answer:${id}`, taskId: task.id, runId: current.id, role: 'user', text: response.text, createdAt: Date.now() });
            this.store.event(task.id, current.id, 'interaction.answered', { interactionId: id }); return current;
        });
        this.schedule(run);
    }
    decide(actionId: string, approve: boolean): void {
        const action = this.store.action(actionId); const run = this.store.run(action.runId);
        this.openTask(action.taskId);
        if (run.state !== 'awaiting_approval' || action.state !== 'awaiting_approval' || this.controllers.has(run.taskId)) throw new Error('This approval is no longer pending.');
        const approval = this.store.approvals(actionId).find(item => item.state === 'pending');
        if (!approval || approval.fingerprint !== this.fingerprint(action)) throw new Error('Action parameters changed; this approval is invalid.');
        const request = this.interactions.pending(action.taskId, 'action_approval');
        if (!request || request.approvalId !== approval.id) throw new Error('This approval is no longer pending.');
        this.store.transaction(() => {
            this.interactions.approve(request, approve); run.waitingFor = undefined; run.outcome = undefined;
            approval.state = approve ? 'approved' : 'denied'; approval.decidedAt = Date.now(); this.store.putApproval(approval);
            if (!approve) { action.state = 'denied'; action.error = 'The user denied this action.'; this.store.putAction(action); this.toolResult(action, JSON.stringify({ error: action.error })); }
            run.state = 'running'; this.store.putRun(run); const task = this.store.task(run.taskId); task.state = 'running'; this.store.putTask(task);
            this.store.event(run.taskId, run.id, approve ? 'approval.approved' : 'approval.denied', { actionId });
        }); this.schedule(run);
    }
    private assertWorkflowAction(action: Action): void {
        const workflow = this.store.task(action.taskId).workflow;
        if (workflow && (!action.workflowContext || action.workflowContext.stepId !== workflow.steps[workflow.index]?.id || action.workflowContext.revision !== workflow.revision)) throw new SafeToolError('The workflow step or version changed. Request a new action; the old permission cannot be reused.');
    }
    private fingerprint(action: Action): string { return createHash('sha256').update(JSON.stringify({ tool: action.tool, method: action.method, args: action.args, prepared: action.prepared, operation: action.operation, workflowContext: action.workflowContext, authorization: action.authorization })).digest('hex'); }
    private schedule(run: Run): void {
        const controller = new AbortController(); this.controllers.set(run.taskId, controller);
        // Run independently of the RPC call and browser connection.
        void this.drive(run.id, controller.signal).catch(() => { /* drive persists a safe error before returning. */ }).finally(() => { if (this.controllers.get(run.taskId) === controller) this.controllers.delete(run.taskId); });
    }
    private current(runId: string, signal: AbortSignal): Run {
        signal.throwIfAborted(); const run = this.store.run(runId); if (!active(run)) throw new Error('Run is no longer active.'); return run;
    }
    private finish(run: Run, state: Run['state'], error?: string): void {
        run.state = state; run.error = error; run.updatedAt = Date.now(); this.store.putRun(run);
        const task = this.store.task(run.taskId); task.state = isTaskClosed(task) ? 'completed' : state; task.updatedAt = Date.now(); this.store.putTask(task);
        this.store.event(task.id, run.id, `run.${state}`, error ? { error } : {});
    }
    private toolResult(action: Action, result: string): void {
        if (this.store.run(action.runId).kind !== 'model') return;
        this.store.putMessage({ id: `result:${action.id}`, taskId: action.taskId, runId: action.runId, role: 'tool', text: result, callId: action.callId, createdAt: Date.now() });
    }
    private async dispatch(action: Action, signal: AbortSignal): Promise<boolean> {
        const run = this.current(action.runId, signal); const task = this.store.task(action.taskId);
        const context: ToolContext = { projectPath: task.projectPath, signal, taskId: task.id, runId: run.id, purpose: task.kind || 'chat', repository: task.repository };
        try {
            await this.tools.refreshProject(task.projectPath);
            new WorkflowToolScope(this.tools).assert(action.tool, this.store.task(task.id), context, action.method);
            const registration = this.tools.registration(action.tool, task.projectPath, action.method);
            const executor = registration.executor; action.handlerId = registration.handlerId; action.handlerTool = registration.handlerTool;
            if (action.state === 'requested' && task.workflow) action.workflowContext = { stepId: task.workflow.steps[task.workflow.index].id, revision: task.workflow.revision };
            const evaluate = async (prepared = action.prepared) => {
                this.assertWorkflowAction(action);
                const operation = analyzeToolAction(registration.access, action.args, prepared || {});
                const workflow = this.store.task(task.id).workflow;
                if (workflow && !executor.workflowSupport && !isReadOnly(operation) && (workflow.phase !== 'active' || !workflow.ready || workflow.ready.some(item => item.status === 'unmet'))) throw new SafeToolError(workflow.phase === 'review' ? 'Review discussion permits only reads and workflow decisions. Reopen an allowed step before changing files or running commands.' : 'Assess Ready criteria in an active step before changing files or running commands.');
                if (action.operation && JSON.stringify(action.operation) !== JSON.stringify(operation)) throw new SafeToolError('Tool operation semantics changed after preparation. Request this action again.');
                const verdict = await this.policy.evaluate({ ...action, prepared }, registration.access, context);
                if (this.tools.registration(action.tool, task.projectPath, action.method).revision !== registration.revision) throw new SafeToolError('Tool manifest changed during preparation. Request this action again.');
                return executor.requiresApproval && verdict.decision === 'allow' ? { ...verdict, decision: 'ask' as const } : verdict;
            };
            if (executor.available && !executor.available(context)) throw new Error('This tool is not available in this task.');
            const args = action.args;
            if (action.state === 'requested') {
                const prepared = await executor.prepare(args, context); this.current(run.id, signal);
                action.operation = analyzeToolAction(registration.access, args, prepared); action.prepared = prepared;
                const verdict = await evaluate(); this.current(run.id, signal);
                action.authorization = verdict;
                if (verdict.decision === 'deny') throw new SafeToolError('This action is blocked by project policy. Review its access rules in Tools.');
                if (verdict.decision === 'ask') { this.store.transaction(() => {
                    action.state = 'awaiting_approval'; action.updatedAt = Date.now(); this.store.putAction(action);
                    const approval = { id: randomUUID(), actionId: action.id, state: 'pending' as const, fingerprint: this.fingerprint(action), createdAt: Date.now() }; this.store.putApproval(approval);
                    const request = this.interactions.create({ key: `approval:${approval.id}`, taskId: action.taskId, runId: run.id, actionId: action.id, approvalId: approval.id, kind: 'action_approval', review: prepared.review as Record<string, unknown> | undefined });
                    run.waitingFor = request.id; run.outcome = { kind: 'interaction', interactionId: request.id };
                    this.finish(run, 'awaiting_approval'); this.store.event(action.taskId, run.id, 'action.awaiting_approval', { actionId: action.id });
                }); return false; }
                this.store.putAction(action);
            }
            const verdict = await evaluate(); this.current(run.id, signal);
            if (action.authorization && JSON.stringify(action.authorization) !== JSON.stringify(verdict)) throw new SafeToolError('Tool policy changed after this action was prepared. Request the action again under the current policy.');
            if (verdict.decision === 'deny') throw new SafeToolError('This action is no longer allowed by project policy.');
            if (verdict.decision === 'ask') {
                if (!action.authorization) throw new SafeToolError('This action has no current authorization. Request it again.');
                const approved = this.store.approvals(action.id).find(item => item.state === 'approved' && item.fingerprint === this.fingerprint(action));
                if (!approved) return false;
            }
            action.state = 'running'; action.updatedAt = Date.now(); this.store.putAction(action); this.store.event(action.taskId, run.id, 'action.running', { actionId: action.id });
            new WorkflowToolScope(this.tools).assert(action.tool, this.store.task(task.id), context, action.method);
            const raw = await executor.execute(args, action.prepared!, context); this.current(run.id, signal);
            if (typeof raw !== 'string') {
                this.store.transaction(() => {
                    const workflow = this.store.task(task.id).workflow;
                    const request = this.interactions.create({ key: `question:${action.id}`, taskId: task.id, runId: run.id, actionId: action.id, ...raw, ...(workflow ? { stepId: workflow.steps[workflow.index]?.id, revision: workflow.revision } : {}) });
                    action.state = 'waiting'; action.updatedAt = Date.now(); this.store.putAction(action);
                    run.waitingFor = request.id; run.outcome = { kind: 'interaction', interactionId: request.id };
                    if (workflow) { workflow.waitingFor = request.id; task.workflow = workflow; this.store.putTask(task); }
                    this.finish(run, 'waiting_input');
                }); return false;
            }
            const result = this.filter.filter(raw);
            this.store.transaction(() => { action.state = 'succeeded'; action.result = result; action.updatedAt = Date.now(); this.store.putAction(action); this.toolResult(action, result); this.store.event(action.taskId, run.id, 'action.succeeded', { actionId: action.id }); });
            return true;
        } catch (error) {
            this.current(run.id, signal);
            this.interactions.invalidate(action.taskId, item => item.actionId === action.id);
            for (const approval of this.store.approvals(action.id).filter(item => item.state === 'pending')) { approval.state = 'revoked'; this.store.putApproval(approval); }
            const code = (error as NodeJS.ErrnoException)?.code;
            const safe = error instanceof Error && error.name === 'SafeToolError' ? error.message : code === 'ENOENT' ? 'File or directory not found. List the repository to discover existing paths.' : code === 'ENOTDIR' ? 'The requested path is not a directory.' : code === 'EACCES' || code === 'EPERM' ? 'The operating system denied access to this path.' : 'The action could not be completed safely.';
            this.store.transaction(() => { action.state = 'failed'; action.error = safe; action.updatedAt = Date.now(); this.store.putAction(action); this.toolResult(action, JSON.stringify({ error: safe })); this.store.event(action.taskId, run.id, 'action.failed', { actionId: action.id, error: safe }); });
            return true;
        }
    }
    private async drive(runId: string, signal: AbortSignal): Promise<void> {
        try {
            for (;;) {
                let run = this.current(runId, signal);
                for (const action of this.store.actions(runId).filter(item => ['requested', 'awaiting_approval'].includes(item.state))) {
                    if (!await this.dispatch(action, signal)) return;
                }
                run = this.current(runId, signal);
                const task = this.store.task(run.taskId);
                if (task.workflow && task.workflow.phase !== 'active' && !(task.workflow.phase === 'review' && task.workflow.discussion)) {
                    const state = task.workflow.phase === 'review' ? 'waiting_review' : task.workflow.phase === 'completed' ? 'completed' : task.workflow.phase === 'blocked' ? 'blocked' : 'waiting_input';
                    run.outcome = task.workflow.waitingFor ? { kind: 'interaction', interactionId: task.workflow.waitingFor } : { kind: task.workflow.phase === 'blocked' ? 'blocked' : 'step_result' };
                    this.store.transaction(() => this.finish(run, state)); return;
                }
                if (run.kind === 'action') { this.store.transaction(() => this.finish(run, this.store.actions(runId).some(action => action.state === 'failed' || action.state === 'denied' || (toolOperation(action) === 'files_read' && summarizeReads(action).some(file => file.status === 'failed'))) ? 'failed' : 'completed')); return; }
                if (task.kind === 'repository-analysis' && this.store.runs(task.id).some(item => this.store.actions(item.id).some(action => toolOperation(action) === 'context_publish' && action.state === 'succeeded'))) { this.store.transaction(() => this.finish(run, 'completed')); return; }
                if (run.steps >= (task.workflow || task.workflowMode === 'auto' ? 80 : task.kind === 'repository-analysis' ? 24 : 12)) throw new Error('Run reached its action limit. Review the task before continuing.');
                run.steps++; this.store.putRun(run); this.store.event(run.taskId, run.id, 'model.started', { step: run.steps });
                const instructions = await this.context.instructions(task.projectPath, signal, task) + '\n' + (this.workflows ? await this.workflows.instructions(task) : ''); this.current(runId, signal);
                const policy = { allowMessage: (!task.workflow && task.workflowMode !== 'auto') || !!(task.workflow?.phase === 'review' && task.workflow.discussion) };
                await this.tools.refreshProject(task.projectPath);
                const definitions = new WorkflowToolScope(this.tools).entries(task, { projectPath: task.projectPath, signal, taskId: task.id, runId, purpose: task.kind || 'chat', repository: task.repository }).map(item => item.executor.definition);
                const messages = await this.taskContext.prepare(task, definitions, instructions, signal); this.current(runId, signal);
                const reply = await this.model.respond(messages, definitions, instructions, signal, policy);
                run = this.current(runId, signal);
                const text = this.filter.filter(reply.text);
                if (!['message', 'actions'].includes(reply.outcome) || (reply.outcome === 'message' ? reply.calls.length !== 0 : reply.calls.length === 0)) throw new ModelProtocolError('The model provider returned an invalid turn outcome.');
                if (!policy.allowMessage && reply.outcome === 'message') throw new ModelProtocolError('The workflow provider returned a message instead of an explicit action, question or step result. Continue to retry this step.');
                this.filter.filter(JSON.stringify(reply.continuation || []));
                this.filter.filter(JSON.stringify(reply.calls));
                if (reply.calls.length > 8 || new Set(reply.calls.map(call => call.id)).size !== reply.calls.length || reply.calls.some(call => this.store.messages(task.id).some(message => message.callId === call.id))) throw new Error('The model returned invalid tool calls.');
                const calls=reply.calls.map(call=>({...call,...this.tools.call(call.tool,call.args,task.projectPath)}));
                if (calls.some(call => call.registration?.executor.turnControl) && reply.calls.length !== 1) throw new Error('Workflow control and user question calls must run separately.');
                this.store.transaction(() => {
                    this.store.putMessage({ id: randomUUID(), taskId: task.id, runId, role: 'assistant', text, continuation: reply.continuation, ...(calls.some(call => call.registration?.executor.interaction) ? { providerOnly: true } : {}), createdAt: Date.now() });
                    for (const call of calls) this.store.putAction({ id: randomUUID(), taskId: task.id, runId, callId: call.id, tool: call.tool, ...(call.method ? {method:call.method} : {}), args: call.args, reason: call.tool === 'files_read' ? 'Read the requested file and return its contents to the external model. Connected repository reads run automatically; project-context files require approval.' : `Run ${call.tool} within its validated project scope.`, state: 'requested', createdAt: Date.now(), updatedAt: Date.now() });
                    this.store.event(task.id, runId, 'model.completed', { toolCalls: reply.calls.length });
                    if (reply.outcome === 'message') {
                        run.outcome = { kind: 'message' };
                        const reviewing = task.workflow?.phase === 'review'; this.workflows?.finishDiscussion(task.id);
                        this.finish(run, task.kind === 'repository-analysis' ? 'failed' : reviewing ? 'waiting_review' : task.workflow || task.workflowMode === 'auto' ? 'idle' : 'completed', task.kind === 'repository-analysis' ? 'Research ended without saving a context map. Run the analysis again to retry.' : undefined);
                    }
                });
                if (reply.outcome === 'message') return;
            }
        } catch (error) {
            const run = this.store.run(runId);
            if (active(run)) this.store.transaction(() => this.finish(run, signal.aborted ? 'cancelled' : 'failed', signal.aborted ? undefined : this.safeError(error)));
        }
    }
    private safeError(error: unknown): string {
        return error instanceof Error && ['ProviderError', 'SafeToolError', 'ModelProtocolError', 'TaskContextError'].includes(error.name) ? error.message : 'The task stopped because of an internal error. Its history is preserved. Review the task before continuing.';
    }
    shutdown(): void { for (const controller of this.controllers.values()) controller.abort(); }
}
