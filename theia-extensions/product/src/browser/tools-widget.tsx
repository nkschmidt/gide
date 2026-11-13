import { BackLink } from './back-link';
import { ConnectedRepository, ProjectService } from '../common/project-service';
import { methodTool } from '../common/tool-methods';
import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Message } from '@theia/core/lib/browser/widgets/widget';
import { CommandService } from '@theia/core/lib/common/command';
import { ConfirmDialog } from '@theia/core/lib/browser/dialogs';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { OpenerService, open } from '@theia/core/lib/browser';
import URI from '@theia/core/lib/common/uri';
import { ProjectToolService, ToolJob, ToolPlan, SavedTool, ToolProblem, ImplementationChoice } from '../common/project-tool-service';
import { ToolEditor, ToolRunReview, emptyProjectTool } from './tool-editor';
@injectable()
export class ToolsWidget extends ReactWidget {
    static readonly ID = 'governed-ide:tools';
    @inject(CommandService) protected readonly commands: CommandService;
    @inject(ProjectService) protected readonly projects: ProjectService;
    @inject(ProjectToolService) protected readonly tools: ProjectToolService;
    @inject(WorkspaceService) protected readonly workspace: WorkspaceService;
    @inject(OpenerService) protected readonly opener: OpenerService;
    protected project = ''; protected items: SavedTool[] = []; protected unavailable: ToolProblem[] = []; protected implementations: ImplementationChoice[] = []; protected jobs: ToolJob[] = [];
    protected errors: string[] = []; protected error = ''; protected busy = false; protected dirty = false; protected query = ''; protected filter = 'all';
    protected selected?: SavedTool; protected problem?: ToolProblem; protected creating = false; protected plan?: ToolPlan;
    protected runTarget?: { method?: string; repository: string; choices: ConnectedRepository[] };
    private page = '';
    constructor() { super(); this.id = ToolsWidget.ID; this.title.label = 'Tools'; this.title.closable = true; this.title.iconClass = 'codicon codicon-tools'; this.addClass('tools-widget'); }
    @postConstruct() protected initialize(): void {
        this.project = this.workspace.workspace?.resource.parent.path.toString() || ''; void this.perform(() => this.reload());
        const timer = window.setInterval(() => { if (!this.isDisposed) void this.tools.jobs(this.project).then(jobs => { this.jobs = jobs; this.update(); }).catch(() => undefined); }, 1500); this.toDispose.push({ dispose: () => window.clearInterval(timer) });
        const beforeUnload = (event: BeforeUnloadEvent) => { if (this.dirty) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', beforeUnload); this.toDispose.push({ dispose: () => window.removeEventListener('beforeunload', beforeUnload) });
    }
    protected onCloseRequest(message: Message): void { if (!this.dirty) { super.onCloseRequest(message); return; } void this.discard().then(discard => { if (discard) super.onCloseRequest(message); }); }
    protected onActivateRequest(message: Message): void { super.onActivateRequest(message); if (this.project && !this.dirty && !this.busy && !this.selected && !this.creating) void this.perform(() => this.reload()); }
    protected async discard(): Promise<boolean> { if (!this.dirty) return true; const result = await new ConfirmDialog({ title: 'Unsaved tool', msg: 'Discard the unsaved manifest changes?', ok: 'Discard changes', cancel: 'Keep editing' }).open(); if (result) this.dirty = false; return !!result; }
    protected async back(): Promise<void> { if (!await this.discard()) return; this.selected = undefined; this.problem = undefined; this.creating = false; this.plan = undefined; this.runTarget = undefined; await this.perform(() => this.reload()); }
    protected async perform(action: () => Promise<void>): Promise<void> { if (this.busy) return; this.busy = true; this.error = ''; this.update(); try { await action(); } catch (error) { this.error = error instanceof Error ? error.message : 'Operation failed.'; } finally { this.busy = false; this.update(); } }
    protected async reload(): Promise<void> { const result = await this.tools.list(this.project); this.items = result.tools; this.unavailable = result.unavailable; this.implementations = result.implementations; this.errors = result.errors; this.jobs = await this.tools.jobs(this.project); this.update(); }
    protected reviewRun(method?: string): void {
        void this.perform(async () => {
            if (!this.selected || this.dirty) throw new Error('Save changes before reviewing a run.');
            const selected = method ? methodTool(this.selected, method) : this.selected;
            this.plan = undefined;
            if (selected.tool.implementation.executor === 'local-process') {
                const choices = await this.projects.listRepositories(this.project);
                this.runTarget = { method, repository: choices.length === 1 ? choices[0].id : '', choices };
            } else {
                this.runTarget = undefined;
                this.plan = await this.tools.plan(this.project, selected.tool.id, method);
            }
        });
    }
    protected reviewSelectedRepository(): void {
        const target = this.runTarget;
        if (!target?.repository || !this.selected || this.dirty) return;
        void this.perform(async () => {
            this.plan = await this.tools.plan(this.project, this.selected!.tool.id, target.method, { repository: target.repository });
            this.runTarget = undefined;
        });
    }
    protected json(id: string): void { void open(this.opener, new URI(this.project).withScheme('file').resolve(`tools/${id}.json`)).catch(error => { this.error = String(error); this.update(); }); }
    protected render(): React.ReactNode {
        const detail = !!this.selected || this.creating || !!this.problem;
        const page = this.selected?.tool.id || this.problem?.id || (this.creating ? 'new' : 'catalog');
        return <div className="project-page tools-page" ref={element => { if (element && page !== this.page) { this.node.scrollTop = 0; this.page = page; } }}>
            <BackLink destination={detail ? 'Tools' : 'Workbench'} disabled={this.busy}
                onClick={() => detail ? void this.back() : void this.commands.executeCommand('governed-ide:open-chat')} />
            <header><div><h1>{this.selected?.tool.name || this.problem?.name || (this.creating ? 'New tool' : 'Tools')}</h1><p>{this.selected?.origin === 'builtin' ? this.selected.tool.description : detail ? 'Definition, implementation and access rules in one manifest.' : 'Installed capabilities and tools added to this project.'}</p></div>{!detail && <button className="theia-button" disabled={this.busy} onClick={() => { this.creating = true; this.dirty = false; this.update(); }}>New tool</button>}{this.selected && this.selected.origin !== 'builtin' && <button className="theia-button secondary" disabled={this.busy || this.dirty} onClick={() => this.json(this.selected!.tool.id)}>Open JSON</button>}</header>
            {this.error && <p className="chat-runtime-error" role="alert">{this.error}</p>}{this.errors.map(error => <p className="chat-runtime-error" key={error}>{error}</p>)}
            {this.problem ? <section><p className="chat-runtime-error" role="alert">Unavailable · {this.problem.error}</p><p>The manifest is preserved. Restore a compatible installed handler or correct its JSON; no code is downloaded automatically.</p><button className="theia-button secondary" onClick={() => this.json(this.problem!.id)}>Open manifest JSON</button></section> : detail ? <>
                <span className="tool-origin">{this.selected?.origin === 'builtin' ? 'Built-in' : 'Project tool'}</span>
                <ToolEditor key={this.selected ? `${this.selected.tool.id}:${this.selected.revision}` : 'new'} tool={this.selected?.tool || emptyProjectTool()} implementations={this.implementations} editing={!!this.selected} builtin={this.selected?.origin === 'builtin'} busy={this.busy} onReview={this.selected ? method => this.reviewRun(method) : undefined} onDirty={() => { this.dirty = true; }} onSave={tool => void this.perform(async () => { this.selected = await this.tools.save(this.project, tool, this.selected?.revision || null); this.creating = false; this.dirty = false; this.plan = undefined; this.runTarget = undefined; await this.reload(); })} />
                {this.selected && !['handler','methods'].includes(this.selected.tool.implementation.executor) && <div className="tool-buttons"><button className="theia-button secondary" disabled={this.busy || this.dirty} onClick={() => this.reviewRun()}>Review run</button></div>}
                {this.selected?.tool.implementation.executor === 'handler' && <p className="tool-muted">Invoke this handler through chat with its declared input parameters.</p>}
                {this.runTarget && <section className="tool-review-card tool-editor" aria-label="Choose run repository">
                    <strong>Run in a repository</strong>
                    {this.runTarget.choices.length ? <label>Repository<select value={this.runTarget.repository} disabled={this.busy} onChange={event => { this.runTarget!.repository = event.currentTarget.value; this.update(); }}><option value="">Choose a connected repository</option>{this.runTarget.choices.map(repository => <option key={repository.id} value={repository.id}>{repository.id}</option>)}</select></label> : <p>No repositories are connected to this project.</p>}
                    <div className="tool-buttons"><button className="theia-button" disabled={this.busy || this.dirty || !this.runTarget.repository} onClick={() => this.reviewSelectedRepository()}>Review command</button><button className="theia-button secondary" onClick={() => { this.runTarget = undefined; this.update(); }}>Cancel</button></div>
                </section>}
                {this.plan && <section className="tool-review-card"><ToolRunReview plan={this.plan} share={false} /><div className="tool-buttons"><button className="theia-button" disabled={this.busy || this.dirty} onClick={() => void this.perform(async () => { await this.tools.start(this.plan!); this.plan = undefined; await this.reload(); })}>Allow this run</button><button className="theia-button secondary" onClick={() => { this.plan = undefined; this.update(); }}>Cancel</button></div></section>}
            </> : <>
                <div className="tool-catalog-controls"><input className="theia-input" type="search" aria-label="Find a tool" placeholder="Find a tool…" value={this.query} onChange={event => { this.query = event.currentTarget.value; this.update(); }} /><div>{['all', 'builtin', 'project'].map(filter => <button key={filter} aria-pressed={this.filter === filter} onClick={() => { this.filter = filter; this.update(); }}>{({ all: 'All', builtin: 'Built-in', project: 'Project' })[filter]}</button>)}</div><button className="theia-button secondary" disabled={this.busy} onClick={() => void this.perform(() => this.reload())}>Refresh</button></div>
                {this.items.filter(item => (this.filter === 'all' || item.origin === this.filter) && `${item.tool.name} ${item.functionName} ${item.tool.description}`.toLowerCase().includes(this.query.toLowerCase())).map(item => <button className="tool-catalog-item" key={item.tool.id} onClick={() => { this.selected = item; this.dirty = false; this.update(); }}><span><strong>{item.tool.name}</strong><small>{item.tool.description.split('. ')[0].slice(0, 160)}</small><code>{item.functionName}{item.methods ? ` · ${item.methods.length} methods` : ''}</code></span><span className="tool-catalog-kind">{item.origin === 'builtin' ? 'Built-in' : 'Project'}<span aria-hidden="true"> ›</span></span></button>)}
                {this.unavailable.filter(item => `${item.id} ${item.name}`.toLowerCase().includes(this.query.toLowerCase())).map(item => <button className="tool-catalog-item" key={item.id} onClick={() => { this.problem = item; this.update(); }}><span><strong>{item.name}</strong><small>{item.error}</small></span><span>Unavailable ›</span></button>)}
                <section className="tool-history"><h2>Execution history</h2>{!this.jobs.length && <p>No process executions yet.</p>}{this.jobs.map(job => <article className="tool-job" key={job.id}><div className="tool-section-heading"><strong>{job.tool.name} · {job.state.replace('_', ' ')}</strong>{['running', 'cancelling'].includes(job.state) && <button className="theia-button secondary" disabled={this.busy || job.state === 'cancelling'} onClick={() => void this.perform(async () => { await this.tools.cancel(this.project, job.id); await this.reload(); })}>{job.state === 'cancelling' ? 'Stopping…' : 'Stop'}</button>}</div><small>{new Date(job.startedAt).toLocaleString()} · {job.tool.implementation.executor}{job.exitCode !== undefined ? ` · Exit ${job.exitCode}` : ''}</small>{job.error && <p className="chat-runtime-error">{job.error}</p>}{job.sourceChanged && <p>Source changed during this execution; final source remains unverified.</p>}<details><summary>Output{job.truncated ? ' · limited' : ''}</summary><pre>{job.output || 'No output.'}</pre></details></article>)}</section>
                <p className="tool-storage-note">Each tools/*.json file contains the full definition, implementation binding and policy. Built-ins bind installed handlers; new JSON manifests can reuse installed implementations. Saving never executes a tool.</p>
            </>}
        </div>;
    }
}
