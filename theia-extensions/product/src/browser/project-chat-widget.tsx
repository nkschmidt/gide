import { WorkflowSummary } from '../common/workflow-service';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { ProjectContextIndex } from '../common/project-context';
import { isTaskClosed, toolOperation } from '../common/task-service';
import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Message } from '@theia/core/lib/browser/widgets/widget';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { CommandService } from '@theia/core/lib/common/command';
import { Action, ReadFileSummary, Task, TaskService, TaskSnapshot } from '../common/task-service';
import { InteractionRequest } from '../common/interaction';
import { buildTaskTimeline, readPaths, summarizeReads } from '../common/task-timeline';
import { OpenerService, open } from '@theia/core/lib/browser';
import { ToolPlan, ProjectToolService, ImplementationChoice } from '../common/project-tool-service';
import { ToolEditor, ToolRunReview } from './tool-editor';
import { ChatMarkdown, CompactChatReport } from './chat-markdown';
import { chatLink } from '../common/chat-markdown';
import URI from '@theia/core/lib/common/uri';

const stateLabel = (state: string) => ({ idle: 'Draft', paused: 'Paused', waiting_input: 'Waiting for answer', waiting_review: 'Needs review', blocked: 'Blocked', running: 'Working', awaiting_approval: 'Needs approval', completed: 'Completed', failed: 'Stopped with an error', cancelled: 'Cancelled', interrupted: 'Interrupted', requested: 'Checking', succeeded: 'Completed', denied: 'Denied' }[state] || state);
const toolLabel = (tool: string) => ({ tools_list: 'List project tools', tools_get: 'Read tool definition', tools_propose: 'Propose tool', jobs_get: 'Inspect execution', jobs_cancel: 'Stop execution', files_read: 'Read files', git_status: 'Inspect Git state', git_diff: 'Review changes', git_branch_create: 'Prepare feature branch', git_commit_changeset: 'Commit ChangeSet', git_pull_request: 'Publish branch', github_pull_request: 'Create GitHub pull request', repository_edit: 'Apply file change', repository_replace: 'Replace text', changeset_list: 'List ChangeSets', changeset_read: 'Read ChangeSet', changeset_write: 'Save ChangeSet plan', changeset_notes: 'Update execution notes', context_update: 'Review memory update', workflow_ready: 'Check prerequisites', workflow_report: 'Report step result', workflow_revise: 'Revise workflow step', workflow_route: 'Choose workflow', repositories_list: 'List repositories', repository_list: 'Browse repository', repository_search: 'Search files', repository_analyze: 'Start repository research', context_index: 'Find project context', context_get: 'Load context topics', context_publish: 'Save repository context', workflow_get: 'Load project workflow' }[tool] || tool.replace(/_/g, ' ').replace(/^./, letter => letter.toUpperCase()));

function publicationResult(action: Action): { status: 'published' | 'created' | 'existing'; url: string; linkKind?: string } | undefined {
    if (!['git_pull_request', 'github_pull_request'].includes(toolOperation(action)) || action.state !== 'succeeded') return undefined;
    try {
        const result = JSON.parse(action.result || '');
        const url = new URL(result.url);
        if (url.protocol === 'https:' && !url.username && !url.password && ['published', 'created', 'existing'].includes(result.status)) return result;
    } catch { /* Older actions may lack a publication result. */ }
    return undefined;
}

function Icon({ name }: { name: 'plus' | 'send' | 'stop' | 'history' | 'chat' | 'search' }): React.ReactElement {
    const paths = { plus: 'M12 5v14M5 12h14', send: 'M12 19V5m-6 6 6-6 6 6', stop: 'M7 7h10v10H7z', history: 'M4 5h16v14H4zM9 5v14', chat: 'M20 11a8 8 0 0 1-8 8H5l-3 3V11a9 9 0 0 1 18 0Z', search: 'm20 20-5-5m2-5a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z' };
    return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} fill={name === 'stop' ? 'currentColor' : 'none'} /></svg>;
}

@injectable()
export class ProjectChatWidget extends ReactWidget {
    static readonly ID = 'governed-ide:project-chat';
    @inject(WorkspaceService) protected readonly workspace: WorkspaceService;
    @inject(TaskService) protected readonly tasks: TaskService;
    @inject(CommandService) protected readonly commands: CommandService;
    @inject(ProjectToolService) protected readonly projectTools: ProjectToolService;
    protected implementationChoices: ImplementationChoice[] = [];
    private proposalCatalogId?: string;
    @inject(WindowService) protected readonly windows: WindowService;
    private readonly pendingPublicationLinks = new Set<string>();
    @inject(OpenerService) protected readonly opener: OpenerService;
    protected conversations: Task[] = [];
    protected snapshot?: TaskSnapshot;
    protected activeId?: string;
    private followUpOptions: WorkflowSummary[] = [];
    private followUpError = '';
    private followUpRequest?: { sourceId: string; workflowId: string; requestId: string };
    protected query = '';
    protected historyVisible = true;
    protected historyWidth = 230;
    protected resizingHistory = false;
    protected storageKey = '';
    protected projectPath = '';
    protected projectName = '';
    protected storageWarning = '';
    protected scrollToLatest = false;
    protected loading = true;
    protected contextIndex?: ProjectContextIndex;
    protected contextError = '';
    protected checkingContext = false;
    protected startingAnalysis = false;
    protected analysisError = '';
    private initializedTasks = false;
    protected busy = false;
    protected refreshing = false;
    protected readonly drafts = new Map<string, string>();
    protected draftTimer?: ReturnType<typeof setTimeout>;
    protected draftQueue = Promise.resolve();
    protected pendingSend?: { taskId: string; text: string; id: string };

    constructor() {
        super(); this.id = ProjectChatWidget.ID; this.title.label = 'Workbench';
        this.title.caption = 'Project workbench — pinned'; this.title.closable = false;
        this.title.iconClass = 'codicon codicon-comment-discussion';
        this.addClass('project-chat-widget'); this.update();
    }
    @postConstruct() protected initializeChat(): void {
        const resource = this.workspace.workspace?.resource;
        this.projectName = resource?.path.base === 'project.theia-workspace' ? resource.parent.path.base : resource?.path.base || 'Project';
        this.projectPath = resource?.parent.path.toString() || '';
        this.storageKey = `governed-ide:chat:v1:${resource?.toString() || 'project'}`;
        try {
            const width = Number(localStorage.getItem('governed-ide:tasks-width'));
            if (Number.isFinite(width) && width >= 190) this.historyWidth = Math.min(520, width);
        } catch { /* Use the default width when browser storage is unavailable. */ }
        void this.refreshContext();
        const contextInterval = setInterval(() => { if (this.isVisible) void this.refreshContext(); }, 5000);
        this.toDispose.push({ dispose: () => clearInterval(contextInterval) });
        const interval = setInterval(() => { if (!this.loading && !this.busy) void this.refresh().catch(() => { this.storageWarning = 'Connection lost. Your tasks remain saved locally. Reconnecting…'; this.update(); }); }, 1200);
        this.toDispose.push({ dispose: () => { clearInterval(interval); if (this.draftTimer) clearTimeout(this.draftTimer); void this.flushDrafts(); } });
    }
    protected override onActivateRequest(message: Message): void {
        super.onActivateRequest(message);
        if (this.projectPath) void this.refreshContext();
    }

    protected get contextReady(): boolean {
        const repositories = this.contextIndex?.repositories;
        return !this.contextError && !!repositories?.length && repositories.every(repository => !!repository.context);
    }

    protected async refreshContext(): Promise<void> {
        if (this.checkingContext || this.isDisposed) return;
        this.checkingContext = true;
        try {
            this.contextIndex = await this.tasks.projectContext(this.projectPath);
            this.contextError = '';
            if (this.contextReady && !this.initializedTasks) {
                this.initializedTasks = true;
                await this.initializeTasks();
            }
        } catch (error) {
            this.contextError = error instanceof Error ? error.message : 'Could not check project context.';
        } finally {
            this.checkingContext = false;
            this.update();
        }
    }

    protected async analyzeProject(): Promise<void> {
        if (this.startingAnalysis) return;
        this.startingAnalysis = true;
        this.analysisError = '';
        this.update();
        try {
            await this.tasks.analyzeProject(this.projectPath);
            await this.refreshContext();
        } catch (error) {
            this.analysisError = error instanceof Error ? error.message : 'Could not start project analysis.';
        } finally {
            this.startingAnalysis = false;
            this.update();
        }
    }

    protected renderSetup(): React.ReactNode {
        const repositories = this.contextIndex?.repositories;
        const pending = repositories?.filter(repository => !repository.context) || [];
        const working = pending.some(repository => ['running', 'awaiting_approval'].includes(repository.job?.state || ''));
        const needsReview = pending.some(repository => repository.job?.review);
        const failure = pending.find(repository => ['failed', 'cancelled', 'interrupted'].includes(repository.job?.state || ''));
        return <div className="chat-transcript"><section className="chat-welcome" aria-label="Project setup">
            <div className="chat-welcome-icon"><span className="codicon codicon-repo" aria-hidden="true" /></div>
            {this.contextError ? <>
                <h1>Could not check project readiness</h1>
                <p role="alert">{this.contextError}</p>
                <button className="context-primary" onClick={() => void this.refreshContext()}>Retry</button>
            </> : !repositories ? <h1>Checking project readiness…</h1> : repositories.length === 0 ? <>
                <h1>Connect your first repository</h1>
                <p>Add an existing Git folder or clone a repository to start working on this project.</p>
                <button className="context-primary" onClick={() => void this.commands.executeCommand('governed-ide:open-repositories')}>Connect repository</button>
            </> : <>
                <h1>{needsReview ? 'Review project analysis' : working || this.startingAnalysis ? 'Analyzing project…' : 'Analyze your project'}</h1>
                <p>Workbench opens when the connected repositories have saved project context.</p>
                <ul className="workbench-repository-status">{repositories.map(repository => <li key={repository.id}>
                    <strong>{repository.id}</strong>
                    <span>{repository.context ? 'Ready' : repository.job?.review ? 'Review required' : repository.job?.state === 'running' ? 'Analyzing…' : repository.job?.state === 'completed' ? 'No context saved' : repository.job?.state || 'Analysis required'}</span>
                </li>)}</ul>
                {this.analysisError && <p className="chat-runtime-error" role="alert">{this.analysisError}</p>}
                {failure && <p className="chat-runtime-error" role="alert">{failure.job?.error || 'Analysis ended before context was saved.'}</p>}
                <div className="context-repository-actions">
                    {!working && <button className="context-primary" disabled={this.startingAnalysis} onClick={() => void this.analyzeProject()}>Analyze project</button>}
                    {(working || failure) && <button className="context-secondary" onClick={() => void this.commands.executeCommand('governed-ide:open-context')}>Open project context</button>}
                </div>
            </>}
        </section></div>;
    }

    // Close All/Close Others skip non-closable titles; also ignore direct close requests.
    protected onCloseRequest(_message: Message): void { /* Chat remains attached for the project lifetime. */ }
    protected activeChat(): Task | undefined { return this.conversations.find(chat => chat.id === this.activeId); }
    protected async initializeTasks(): Promise<void> {
        try {
            this.conversations = await this.tasks.list(this.projectPath);
            try { this.activeId = localStorage.getItem(`${this.storageKey}:selected`) || undefined; } catch { /* Selection is optional. */ }
            if (!this.conversations.some(task => task.id === this.activeId)) {
                this.activeId = this.conversations[0]?.id;
            }
            if (!this.conversations.length) this.activeId = (await this.tasks.create(this.projectPath)).id;
            await this.refresh();
        } catch (error) { this.storageWarning = this.errorText(error); }
        finally { this.loading = false; this.update(); }
    }
    protected async refresh(): Promise<void> {
        if (this.refreshing || this.isDisposed) return;
        this.refreshing = true;
        try {
            this.conversations = await this.tasks.list(this.projectPath);
            for (const task of this.conversations) if (isTaskClosed(task)) this.drafts.delete(task.id);
            const id = this.activeId;
            if (id) {
                const snapshot = await this.tasks.snapshot(id);
                if (id === this.activeId) {
                    this.conversations = this.conversations.map(task => task.id === id ? snapshot.task : task);
                    for (const action of snapshot.actions) {
                        if (!this.pendingPublicationLinks.has(action.id) || ['requested', 'awaiting_approval', 'running'].includes(action.state)) continue;
                        this.pendingPublicationLinks.delete(action.id);
                        const result = publicationResult(action);
                        if (result?.status === 'published' && result.linkKind === 'form') {
                            try { this.windows.openNewWindow(result.url, { external: true }); } catch { /* The result card still links to the form. */ }
                        }
                    }
                    if (isTaskClosed(snapshot.task)) this.drafts.delete(id);
                    if (this.snapshot?.messages.length !== snapshot.messages.length || this.snapshot?.actions.length !== snapshot.actions.length || this.snapshot?.interactions.length !== snapshot.interactions.length) this.scrollToLatest = true;
                    this.snapshot = snapshot;
                    if (isTaskClosed(snapshot.task)) {
                        try {
                            const options = await this.tasks.followUpOptions(id);
                            if (id === this.activeId) { this.followUpOptions = options; this.followUpError = ''; }
                        } catch (error) {
                            if (id === this.activeId) { this.followUpOptions = []; this.followUpError = this.errorText(error); }
                        }
                    } else { this.followUpOptions = []; this.followUpError = ''; }
                }
            }
            const proposal = this.snapshot?.interactions.find(request => request.kind === 'tool_proposal' && request.state === 'pending');
            if (proposal && proposal.id !== this.proposalCatalogId) { this.implementationChoices = (await this.projectTools.list(this.projectPath)).implementations; this.proposalCatalogId = proposal.id; }
            this.update();
        } finally { this.refreshing = false; }
    }
    protected errorText(error: unknown): string { return error instanceof Error ? error.message : 'The operation failed. Please try again.'; }
    protected async perform(operation: () => Promise<void>): Promise<void> {
        if (this.busy) return; this.busy = true; this.storageWarning = ''; this.update();
        try { await operation(); await this.refresh(); }
        catch (error) { this.storageWarning = this.errorText(error); }
        finally { this.busy = false; this.update(); }
    }
    protected resizeHistory(width: number): void {
        const available = this.node.querySelector('.project-chat')?.clientWidth || 1000;
        this.historyWidth = Math.round(Math.max(190, Math.min(520, available / 2, width)));
        this.update();
    }
    protected saveHistoryWidth(): void {
        this.resizingHistory = false;
        try { localStorage.setItem('governed-ide:tasks-width', String(this.historyWidth)); } catch { /* Resizing still works for this session. */ }
        this.update();
    }
    protected selectTask(id: string): void {
        this.activeId = id; this.followUpOptions = []; this.followUpError = ''; this.snapshot = undefined; this.scrollToLatest = true;
        this.rememberActiveTask();
        void this.refresh().catch(error => { this.storageWarning = this.errorText(error); this.update(); }); this.update();
    }
    private rememberActiveTask(): void {
        try {
            const key = `${this.storageKey}:selected`;
            if (this.activeId) localStorage.setItem(key, this.activeId);
            else localStorage.removeItem(key);
        } catch { /* Selection is optional. */ }
    }
    revealTask(id: string): void { if (this.conversations.some(task => task.id === id)) this.selectTask(id); }
    protected newChat(): void { if (!this.contextReady) return; void this.perform(async () => { await this.flushDrafts(); const task = await this.tasks.create(this.projectPath); this.conversations.unshift(task); this.selectTask(task.id); }); }
    protected setDraft(text: string): void {
        const task = this.activeChat();
        if (!task || isTaskClosed(task) || this.busy) return; this.drafts.set(task.id, text);
        if (this.draftTimer) clearTimeout(this.draftTimer);
        this.draftTimer = setTimeout(() => { void this.flushDrafts().catch(error => { this.storageWarning = this.errorText(error); this.update(); }); }, 250);
        this.update();
    }
    protected async flushDrafts(): Promise<void> {
        if (this.draftTimer) clearTimeout(this.draftTimer);
        const pending = [...this.drafts];
        this.draftQueue = this.draftQueue.catch(() => undefined).then(async () => { for (const [id, text] of pending) { if (this.drafts.get(id) === text) await this.tasks.saveDraft(id, text); } });
        await this.draftQueue;
    }
    protected send(): void {
        if (!this.contextReady) return;
        const task = this.activeChat(); const text = task && (this.drafts.get(task.id) ?? task.draft).trim();
        if (!task || isTaskClosed(task) || !text || ['running', 'awaiting_approval'].includes(task.state)) return;
        if (this.pendingSend?.taskId !== task.id || this.pendingSend.text !== text) this.pendingSend = { taskId: task.id, text, id: crypto.randomUUID() };
        const request = this.pendingSend;
        void this.perform(async () => { await this.flushDrafts(); await this.tasks.send(task.id, text, request.id); this.drafts.set(task.id, ''); this.pendingSend = undefined; this.scrollToLatest = true; });
    }
    private startFollowUp(workflowId: string): void {
        const source = this.activeChat();
        if (!source || !isTaskClosed(source)) return;
        if (this.followUpRequest?.sourceId !== source.id || this.followUpRequest.workflowId !== workflowId) {
            this.followUpRequest = { sourceId: source.id, workflowId, requestId: crypto.randomUUID() };
        }
        const request = this.followUpRequest;
        void this.perform(async () => {
            const task = await this.tasks.startFollowUp(request.sourceId, request.workflowId, request.requestId);
            this.conversations = [task, ...this.conversations.filter(item => item.id !== task.id)];
            this.followUpRequest = undefined;
            this.selectTask(task.id);
        });
    }
    protected renderHistory(): React.ReactNode {
        const conversations = this.conversations.filter(chat => chat.title.toLowerCase().includes(this.query.toLowerCase()));
        const today = new Date().toDateString();
        return <aside className="chat-history" aria-label="Project tasks" style={{ width: this.historyWidth }}>
            <div className="chat-history-heading"><strong>Tasks</strong><button className="chat-icon-button" title="New task" aria-label="New task" disabled={this.busy || this.loading} onClick={() => this.newChat()}><Icon name="plus" /></button></div>
            <div className="chat-search"><Icon name="search" /><input aria-label="Search tasks" placeholder="Search tasks" value={this.query} onChange={event => { this.query = event.currentTarget.value; this.update(); }} /></div>
            <div className="chat-history-list">{conversations.length ? ['Today', 'Earlier'].map(group => {
                const entries = conversations.filter(chat => (new Date(chat.updatedAt).toDateString() === today ? 'Today' : 'Earlier') === group);
                return entries.length > 0 && <section key={group}><h3>{group}</h3>{entries.map(chat => <button key={chat.id} className={`chat-history-item${this.activeId === chat.id ? ' active' : ''}`} onClick={() => this.selectTask(chat.id)}><Icon name="chat" /><div><strong>{chat.title}</strong><small>{stateLabel(isTaskClosed(chat) ? 'completed' : chat.state === 'idle' && chat.workflow?.phase === 'active' ? 'paused' : chat.state)}</small></div></button>)}</section>;
            }) : <div className="chat-history-empty"><Icon name="chat" /><strong>{this.query ? 'No matches' : 'No tasks yet'}</strong><p>{this.query ? 'Try another search.' : 'Your project tasks will appear here.'}</p></div>}</div>
            <footer className="chat-history-footer">Saved on this computer · this project only</footer>
        </aside>;
    }
    protected render(): React.ReactNode {
        const active = this.activeChat(); const snapshot = this.snapshot?.task.id === this.activeId ? this.snapshot : undefined;
        const messages = snapshot?.messages || []; const actions = snapshot?.actions || [];
        const running = !!active && ['running', 'awaiting_approval'].includes(active.state);
        const readOnly = !!active && isTaskClosed(active);
        const showChat = this.contextReady || running || readOnly;
        const pausedWorkflow = active?.state === 'idle' && active.workflow?.phase === 'active';
        const draft = active ? this.drafts.get(active.id) ?? active.draft : '';
        const latestRun = snapshot?.runs[snapshot.runs.length - 1];
        const workflowSelection = snapshot?.interactions.find(request => request.kind === 'workflow_selection' && request.state === 'pending');
        const toolAccess = snapshot?.interactions.find(request => request.kind === 'workflow_tools' && request.state === 'pending');
        const review = snapshot?.interactions.find(request => request.kind === 'workflow_approval' && request.state === 'pending' && active?.workflow?.waitingFor === request.id);
        const question = snapshot?.interactions.find(request => request.kind === 'question' && request.state === 'pending');
        return <div className={`project-chat${this.historyVisible ? '' : ' history-hidden'}${this.resizingHistory ? ' resizing-history' : ''}`}>
            <main className="chat-main">
                <header className="chat-main-header"><div className="chat-header-left"><div><strong>{(showChat && active?.title) || 'Project workbench'}</strong><span>{this.projectName} · ChatGPT</span></div></div><div className="chat-header-actions"><button className="chat-context-button" onClick={() => void this.commands.executeCommand('governed-ide:open-repositories')}>Repositories</button><button className="chat-context-button" onClick={() => void this.commands.executeCommand('governed-ide:open-tools')}>Tools</button><button className="chat-context-button" onClick={() => void this.commands.executeCommand('governed-ide:open-context')}>Project context</button><button className="chat-context-button" onClick={() => void this.commands.executeCommand('governed-ide:open-workflow')}>Workflow</button>{showChat && <button className="chat-icon-button" aria-label={this.historyVisible ? 'Hide tasks' : 'Show tasks'} title="Toggle tasks" onClick={() => { this.historyVisible = !this.historyVisible; this.update(); }}><Icon name="history" /></button>}</div></header>
                {showChat ? <>
                <div className="chat-transcript" ref={element => { if (element && this.scrollToLatest) { element.scrollTop = element.scrollHeight; this.scrollToLatest = false; } }}>
                    {messages.length || actions.length ? <div className="chat-message-column">{buildTaskTimeline(messages, actions.filter(action => !['workflow_ready', 'workflow_report', 'workflow_revise', 'workflow_route'].includes(toolOperation(action))), snapshot?.interactions).filter(entry => entry.kind !== 'interaction' || entry.request.id !== review?.id).map(entry => entry.kind === 'interaction' ? this.renderQuestion(entry.request) : entry.kind === 'reads' ? this.renderReadGroup(entry.id, entry.actions, snapshot!) : entry.kind === 'action' ? this.renderAction(entry.action, snapshot!) : <article className={entry.message.role === 'user' ? 'chat-user-message' : 'chat-assistant-message'} key={entry.message.id}><div className="chat-message-author">{entry.message.role === 'user' ? 'You' : 'Assistant'}</div>{entry.message.role === 'user' ? <p>{entry.message.text}</p> : <>{entry.message.localOnly ? <CompactChatReport text={entry.message.text} onLink={href => void this.openChatLink(href)} /> : <ChatMarkdown text={entry.message.text} onLink={href => void this.openChatLink(href)} />}</>}<time dateTime={new Date(entry.message.createdAt).toISOString()}>{new Date(entry.message.createdAt).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false })}</time></article>)}{review && this.renderWorkflowReview(review)}</div>
                        : null}
                </div>
                {readOnly && <div className="chat-composer-area">
                    {this.renderWorkflow(active!)}
                    <div className="chat-completed-actions">
                        <button className="theia-button" disabled={this.busy || !this.contextReady} onClick={() => this.newChat()}>New task</button>
                        {this.followUpOptions.map(workflow => <button key={workflow.id} className="theia-button secondary" disabled={this.busy || !this.contextReady}
                            onClick={() => this.startFollowUp(workflow.id)}>Start {workflow.name}</button>)}
                    </div>
                    {this.followUpError && <div className="chat-runtime-error" role="alert">{this.followUpError}</div>}
                </div>}
                {active && !readOnly && <div className="chat-composer-area">
                    {active && this.renderWorkflow(active)}
                    {latestRun?.error && <div className="chat-runtime-error" role="alert">{latestRun.error}</div>}
                    {active && (pausedWorkflow || ['failed', 'cancelled', 'interrupted'].includes(active.state)) && <div className="chat-run-controls"><span>{pausedWorkflow ? 'Workflow paused before the step result.' : `${stateLabel(active.state)}. Nothing will restart automatically.`}</span>{snapshot?.messages.some(message => message.role === 'user') && <button disabled={this.busy} onClick={() => void this.perform(() => this.tasks.resume(active.id))}>Continue</button>}</div>}
                    <form className="chat-composer" onSubmit={event => { event.preventDefault(); this.send(); }}><textarea aria-label="Message" placeholder={toolAccess ? 'Review the requested step tools above…' : workflowSelection ? 'Choose how to proceed above…' : question ? (question.question?.options.length ? 'Choose an option above, or type your answer…' : 'Type your answer…') : active?.workflow?.phase === 'review' ? 'Ask about the result or describe changes…' : 'Describe a task or answer the current questions…'} rows={3} maxLength={32000} disabled={this.loading || !active || !!workflowSelection || !!toolAccess} value={draft} onChange={event => this.setDraft(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); this.send(); } }} /><div className="chat-composer-toolbar"><button type={running ? 'button' : 'submit'} aria-label={running ? 'Stop' : 'Send message'} title={running ? 'Stop' : 'Send message'} disabled={this.busy || this.loading || !active || (!running && (!!workflowSelection || !!toolAccess || !draft.trim()))} onClick={running ? () => void this.perform(() => this.tasks.cancel(active!.id)) : undefined}><Icon name={running ? 'stop' : 'send'} /></button></div></form><div className={`chat-composer-hint${this.storageWarning ? ' chat-runtime-error' : ''}`} role={this.storageWarning ? 'alert' : undefined}>{this.storageWarning || (toolAccess ? 'Review the requested step tools above to continue.' : workflowSelection ? 'Select a workflow above to continue.' : 'Enter to send · Shift + Enter for a new line')}</div></div>}
                </> : this.renderSetup()}
            </main>
            {showChat && this.historyVisible && <><div className="chat-history-resizer" role="separator" aria-label="Resize tasks panel" aria-orientation="vertical" aria-valuemin={190} aria-valuemax={520} aria-valuenow={this.historyWidth} tabIndex={0}
                onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); this.resizingHistory = true; this.update(); }}
                onPointerMove={event => { if (this.resizingHistory) this.resizeHistory(event.currentTarget.parentElement!.getBoundingClientRect().right - event.clientX); }}
                onPointerUp={event => { if (this.resizingHistory) { event.currentTarget.releasePointerCapture(event.pointerId); this.saveHistoryWidth(); } }}
                onLostPointerCapture={() => { if (this.resizingHistory) this.saveHistoryWidth(); }}
                onDoubleClick={() => { this.resizeHistory(230); this.saveHistoryWidth(); }}
                onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); this.resizeHistory(this.historyWidth + (event.key === 'ArrowLeft' ? 20 : -20)); this.saveHistoryWidth(); } }}
            />{this.renderHistory()}</>}
        </div>;
    }
    protected async openChatLink(href: string): Promise<void> {
        const target = chatLink(href); if (!target) return;
        try {
            if (target.kind === 'external') await open(this.opener, new URI(target.href));
            else { const root = this.workspace.workspace?.resource.parent; if (root) await open(this.opener, root.resolve(target.path)); }
        } catch (error) { this.storageWarning = this.errorText(error); this.update(); }
    }
    protected renderWorkflow(task: Task): React.ReactNode {
        const workflow = task.workflow;
        if (!workflow || !this.snapshot?.messages.some(message => message.role === 'user')) return null;
        const step = workflow.steps[workflow.index];
        const status = task.state === 'waiting_input' ? 'Waiting for reply' : ({
            draft: 'Not started', active: 'In progress', blocked: 'Blocked', review: 'Review required', completed: 'Completed'
        })[workflow.phase];
        const title = step ? `${workflow.name} · ${workflow.index + 1}/${workflow.steps.length} · ${step.title}` : workflow.name;
        return <div className="chat-workflow-state" key={`${task.id}:${workflow.index}`} aria-label="Workflow progress">
            <div className="chat-workflow-title">
                <strong title={title}>{title}</strong>
                <small className="chat-workflow-status" data-phase={workflow.phase}>{status}</small>
            </div>
        </div>;
    }
    protected renderAction(action: Action, snapshot: TaskSnapshot): React.ReactNode {
        const request = snapshot.interactions.find(item => item.kind === 'action_approval' && item.actionId === action.id && item.state === 'pending');
        const pending = action.state === 'awaiting_approval' && !!request;
        const published = publicationResult(action);
        if (published) {
            const label = published.status === 'published' ? 'Branch published' : 'Pull request ready';
            return <section className="chat-question" key={action.id} aria-label={label}><h3>{label}</h3>
                <a href={published.url} target="_blank" rel="noopener noreferrer">
                    {published.status !== 'published' ? 'Open pull request' : published.linkKind === 'form' ? 'Open pull request form' : 'Open remote repository'}
                </a>
            </section>;
        }
        if (['git_pull_request', 'github_pull_request'].includes(toolOperation(action)) && pending) {
            const review = request.review;
            return <section className="chat-question" key={action.id} aria-label="Create remote pull request">
                <h3>Create remote pull request?</h3>
                <p><strong>{String(review?.title)}</strong></p>
                <p>{String(review?.destination)} · <code>{String(review?.branch)}</code> → <code>{String(review?.base)}</code></p>
                <p>Publish commit <code>{String(review?.commit)}</code> and open a pull request or its form.</p>
                <details><summary>Pull request description</summary><ChatMarkdown text={String(review?.description || '')} onLink={href => void this.openChatLink(href)} /></details>
                <div className="chat-action-buttons">
                    <button disabled={this.busy} onClick={() => void this.perform(async () => {
                        this.pendingPublicationLinks.add(action.id);
                        try { await this.tasks.respondInteraction(request.id, { approved: true }); }
                        catch (error) { this.pendingPublicationLinks.delete(action.id); throw error; }
                    })}>Publish and open PR</button>
                    <button disabled={this.busy} onClick={() => void this.perform(() => this.tasks.respondInteraction(request.id, { approved: false }))}>Keep commit local</button>
                </div>
            </section>;
        }
        if (toolOperation(action).startsWith('docker_')) {
            let result: { state?: string; exitCode?: number; output?: string; truncated?: boolean; sourceChanged?: boolean; endpoint?: string } = {};
            try { result = JSON.parse(action.result || '{}'); } catch { /* Interrupted action. */ }
            const review = request?.review;
            return <section className="chat-git-review" key={action.id}><strong>Docker · {action.method || toolOperation(action).slice(7)} · {result.state || stateLabel(action.state)}</strong><pre>{JSON.stringify(action.args.arguments || [])}</pre>{action.error && <p className="chat-runtime-error">{action.error}</p>}{pending && <><p>{String(review?.label)}<br /><code>{String(review?.endpoint)}</code></p>{Array.isArray(review?.containers) && review.containers.length > 0 && <ul>{(review.containers as { name: string; id: string }[]).map(container => <li key={container.id}>{container.name} · <code>{container.id}</code></li>)}</ul>}<p>Repository: {String(action.args.repository)} · Timeout: {String(review?.timeoutSeconds)}s · Output limit: {String(review?.outputLimit)} bytes</p><p className="check-local-notice">{String(review?.warning)}</p><div className="check-buttons"><button className="theia-button" disabled={this.busy} onClick={() => void this.perform(() => this.tasks.respondInteraction(request!.id, { approved: true }))}>Allow Docker action</button><button className="theia-button secondary" disabled={this.busy} onClick={() => void this.perform(() => this.tasks.respondInteraction(request!.id, { approved: false }))}>Deny</button></div></>}{result.sourceChanged && <p>Repository source changed during this run. Verify the final source again.</p>}{action.state === 'running' && <p>Running. Use Stop below to cancel.</p>}{action.result && <details><summary>Result{result.exitCode !== undefined ? ` · Exit ${result.exitCode}` : ''}{result.truncated ? ' · output limited' : ''}</summary><pre>{result.output || action.result}</pre></details>}</section>;
        }
        if (toolOperation(action) === 'git') {
            let result: { state?: string; exitCode?: number; output?: string; truncated?: boolean } = {};
            try { result = JSON.parse(action.result || '{}'); } catch { /* Interrupted actions may not have a structured result. */ }
            const review = request?.review;
            return <section className="chat-git-review" key={action.id}><strong>Git · {String(action.args.repository)} · {result.state || stateLabel(action.state)}</strong><pre>{JSON.stringify(action.args.arguments)}</pre>{action.error && <p className="chat-runtime-error">{action.error}</p>}{pending && <><p>Branch: <strong>{String(review?.branch || 'Detached HEAD')}</strong> · Working tree: {review?.clean ? 'clean' : 'has changes'} · Policy category: {String(review?.category)}</p><p className="check-local-notice">{String(review?.warning)}</p><div className="check-buttons"><button className="theia-button" disabled={this.busy} onClick={() => void this.perform(() => this.tasks.respondInteraction(request!.id, { approved: true }))}>Allow Git action</button><button className="theia-button secondary" disabled={this.busy} onClick={() => void this.perform(() => this.tasks.respondInteraction(request!.id, { approved: false }))}>Deny</button></div></>}{action.result && <details><summary>Result{result.exitCode !== undefined ? ` · Exit ${result.exitCode}` : ''}{result.truncated ? ' · output limited' : ''}</summary><pre>{result.output || action.result}</pre></details>}</section>;
        }
        if ((!action.handlerId && action.tool.startsWith('project_')) || request?.review?.kind === 'project-tool') {
            let result: { state?: string; toolName?: string; error?: string; sourceChanged?: boolean } = {};
            try { result = JSON.parse(action.result || '{}'); } catch { /* Interrupted runs may have no result. */ }
            const plan = request?.review as unknown as ToolPlan | undefined;
            return <section className="chat-tool-run" key={action.id}><strong>{plan?.tool.name || result.toolName || action.tool} · {result.state || stateLabel(action.state)}</strong>{action.error && <p className="chat-runtime-error">{action.error}</p>}{result.error && <p className="chat-runtime-error">{result.error}</p>}{pending && plan && <><ToolRunReview plan={plan} share={true} /><div className="tool-buttons"><button className="theia-button" disabled={this.busy} onClick={() => void this.perform(() => this.tasks.respondInteraction(request!.id, { approved: true }))}>Allow tool execution</button><button className="theia-button secondary" disabled={this.busy} onClick={() => void this.perform(() => this.tasks.respondInteraction(request!.id, { approved: false }))}>Deny</button></div></>}{result.sourceChanged && <p>Source changed during this run. Final source remains unverified.</p>}{action.state === 'running' && <p>Running. Use Stop below to cancel.</p>}</section>;
        }
        const target = toolOperation(action).startsWith('changeset_') ? String(action.args.name || 'changesets') : toolOperation(action).startsWith('workflow_') ? String(action.args.stepId || 'Current step') : toolOperation(action) === 'context_get' ? `${action.args.repository} · ${(action.args.topics as string[] || []).join(', ')}` : ['context_index', 'context_publish', 'repository_analyze'].includes(toolOperation(action)) ? String(action.args.repository || 'Project context') : action.args.repository ? `${action.args.repository} / ${action.args.path || '.'}${action.args.query ? ` · ${action.args.query}` : ''}` : String(action.args.path || action.args.query || action.args.id || action.args.anchor || (toolOperation(action) === 'repositories_list' ? 'Connected repositories' : 'Project'));
        return <details className="chat-tool-row" key={action.id} aria-label={toolLabel(toolOperation(action))}><summary><span>{toolLabel(toolOperation(action))}</span><code>{target}</code><small>{stateLabel(action.state)}</small></summary><div className="chat-tool-details">{action.error && <p className="chat-runtime-error">{action.error}</p>}{toolOperation(action) === 'context_update' && pending && <><p>This proposal changes durable architecture memory. Task execution notes belong in ChangeSets.</p><pre>{JSON.stringify(action.args, undefined, 2)}</pre></>}{action.result && <pre>{action.result}</pre>}{pending && <div className="chat-action-buttons"><button disabled={this.busy} onClick={() => void this.perform(() => this.tasks.respondInteraction(request!.id, { approved: true }))}>Approve</button><button disabled={this.busy} onClick={() => void this.perform(() => this.tasks.respondInteraction(request!.id, { approved: false }))}>Deny</button></div>}</div></details>;
    }
    protected renderWorkflowReview(request: InteractionRequest): React.ReactNode {
        const task = this.snapshot?.task;
        const workflow = task?.workflow;
        const pending = task && !isTaskClosed(task) && request.state === 'pending' && workflow?.phase === 'review'
            && workflow.waitingFor === request.id && workflow.pending?.revision === request.revision;
        if (!pending) return null;
        return <div className="chat-workflow-approval" key={request.id} aria-label="Workflow step review">
            <button className="theia-button" disabled={this.busy || task?.state === 'running' || !!workflow?.discussion} onClick={() => void this.perform(() =>
                this.tasks.respondInteraction(request.id, { approved: true }))}>Approve and continue</button>
        </div>;
    }
    protected renderQuestion(request: InteractionRequest): React.ReactNode {
        if (request.kind === 'workflow_approval') return this.renderWorkflowReview(request);
        if (request.kind === 'workflow_tools') return <section className="chat-question" key={request.id} aria-label="Step tool access"><h3>Enable tools for this step</h3><strong>{request.toolAccess?.stepTitle}</strong><p>{request.toolAccess?.reason}</p><ul>{request.toolAccess?.tools.map(tool => <li key={tool.id}><strong>{tool.label}</strong><p>{tool.description}</p></li>)}</ul><p>Applies to this task step only. Tool policies and required approvals remain in effect.</p>{request.state === 'pending' ? <div className="chat-action-buttons"><button disabled={this.busy} onClick={() => void this.perform(() => this.tasks.respondInteraction(request.id, { approved: true }))}>Enable and continue</button><button disabled={this.busy} onClick={() => void this.perform(() => this.tasks.respondInteraction(request.id, { approved: false }))}>Keep current tools</button></div> : <small>{request.state === 'answered' ? (request.response && 'approved' in request.response && request.response.approved ? 'Methods enabled for this step.' : 'Current tools kept.') : 'Access request closed.'}</small>}</section>;
        if (request.kind === 'tool_proposal') return <section className="chat-question" key={request.id} aria-label="Tool proposal"><strong>Proposed tool · {request.tool?.name}</strong>{request.state === 'pending' ? <ToolEditor tool={request.tool!} implementations={this.implementationChoices.length ? this.implementationChoices : undefined} builtin={request.tool?.id.startsWith('builtin.')} editing busy={this.busy} saveLabel="Approve tool definition" cancelLabel="Reject proposal" onSave={tool => void this.perform(() => this.tasks.respondInteraction(request.id, { save: true, tool }))} onCancel={() => void this.perform(() => this.tasks.respondInteraction(request.id, { save: false }))} /> : <p>{request.state === 'answered' ? (request.response && 'save' in request.response && request.response.save ? 'Tool saved and available. No execution was performed.' : 'Proposal rejected.') : 'Proposal closed.'}</p>}</section>;
        const question = request.question!;
        let selected: string | undefined;
        try { selected = request.result && JSON.parse(request.result).optionId; } catch { /* Old interrupted actions may not have an answer. */ }
        const pending = request.state === 'pending';
        const isWorkflowSelection = request.kind === 'workflow_selection';
        return <section className="chat-question" key={request.id} aria-label={isWorkflowSelection ? 'Choose workflow' : 'Question from assistant'}>
            {isWorkflowSelection && <h3>Choose how to proceed</h3>}
            <strong>{question.question}</strong>
            {question.options.length > 0 && <div className="chat-question-options">{question.options.map(option => {
                const chosen = selected === option.id;
                return <button key={option.id} type="button" aria-pressed={chosen} disabled={this.busy || !pending}
                    onClick={() => void this.perform(() => this.tasks.respondInteraction(request.id, { optionId: option.id }))}>
                    <span className="chat-option-copy">
                        <span className="chat-option-label">{option.label}{isWorkflowSelection && request.recommendedId === option.id && <small className="chat-workflow-recommended">Recommended</small>}</span>
                        {option.description && <small>{option.description}</small>}
                    </span>
                    {(pending || chosen) && <span className={`chat-option-icon codicon codicon-${chosen ? 'check' : 'chevron-right'}`} aria-hidden="true" />}
                </button>;
            })}</div>}
            <small>{request.kind === 'workflow_selection' ? (pending ? 'Your selection starts the process. Nothing runs before you choose.' : request.state === 'answered' ? 'Selection confirmed.' : 'Selection closed.') : pending ? (question.options.length ? 'Choose an option, or type your own answer below.' : 'Type your answer below.') : request.state === 'cancelled' || request.state === 'invalidated' ? 'Question closed.' : 'Answer sent.'}</small>
        </section>;
    }
    protected renderReadGroup(id: string, actions: Action[], snapshot: TaskSnapshot): React.ReactNode {
        const byPath = new Map<string, ReadFileSummary>();
        for (const action of actions) for (const file of summarizeReads(action)) byPath.set(file.path, file);
        const files = [...byPath.values()]; const read = files.filter(file => file.status === 'read').length;
        const failed = files.filter(file => ['failed', 'denied', 'cancelled'].includes(file.status)).length;
        const approvals = actions.filter(action => action.state === 'awaiting_approval' && snapshot.approvals.some(approval => approval.actionId === action.id && approval.state === 'pending'));
        const working = actions.some(action => ['requested', 'running'].includes(action.state));
        const title = approvals.length ? `Read ${files.length} ${files.length === 1 ? 'file' : 'files'} · approval needed` : working ? `Reading files · ${read}/${files.length}` : failed ? `Read ${read} of ${files.length} files · ${failed} failed` : `Read ${read} ${read === 1 ? 'file' : 'files'}`;
        return <section className={`chat-read-group${failed ? ' has-errors' : ''}`} key={id} aria-label="File reads"><details><summary><span className="chat-read-icon" aria-hidden="true">{working ? '◌' : failed ? '!' : '✓'}</span><span>{title}</span></summary><ul>{files.map(file => <li key={file.path}><code title={file.path}>{file.path}</code><small>{file.status === 'read' ? 'Read' : file.status === 'reading' ? 'Reading…' : stateLabel(file.status)}</small>{file.error && <p className="chat-runtime-error">{file.error}</p>}</li>)}</ul>{files.length === 0 && actions.filter(action => action.error).map(action => <p className="chat-runtime-error" key={action.id}>{action.error}</p>)}</details>{approvals.map(action => <div className="chat-read-approval" key={action.id}><span>{action.reason}</span><div className="chat-action-buttons"><button disabled={this.busy} onClick={() => void this.perform(() => this.tasks.respondInteraction(snapshot.interactions.find(item => item.actionId === action.id && item.state === 'pending')!.id, { approved: true }))}>Approve {readPaths(action).length} {readPaths(action).length === 1 ? 'file' : 'files'}</button><button disabled={this.busy} onClick={() => void this.perform(() => this.tasks.respondInteraction(snapshot.interactions.find(item => item.actionId === action.id && item.state === 'pending')!.id, { approved: false }))}>Deny</button></div></div>)}</section>;
    }
}
