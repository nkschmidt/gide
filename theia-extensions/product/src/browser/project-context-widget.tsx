import { BackLink } from './back-link';
import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { CommandService } from '@theia/core/lib/common/command';
import { OpenerService, open } from '@theia/core/lib/browser';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { TaskService } from '../common/task-service';
import { ContextSelection, ProjectContextIndex } from '../common/project-context';

@injectable()
export class ProjectContextWidget extends ReactWidget {
    static readonly ID = 'governed-ide:project-context';
    @inject(TaskService) protected readonly tasks: TaskService;
    @inject(WorkspaceService) protected readonly workspace: WorkspaceService;
    @inject(CommandService) protected readonly commands: CommandService;
    @inject(OpenerService) protected readonly opener: OpenerService;
    protected projectPath = '';
    protected index?: ProjectContextIndex;
    protected repository?: string;
    protected topic?: string;
    protected selection?: ContextSelection;
    protected generation?: string;
    protected refreshing = false;
    protected starting?: string;
    protected loadingTopic = false;
    protected error = '';
    protected feedback = '';

    constructor() { super(); this.id = ProjectContextWidget.ID; this.title.label = 'Project Context'; this.title.closable = true; this.title.iconClass = 'codicon codicon-book'; this.addClass('project-context-widget'); }
    @postConstruct() protected initialize(): void {
        this.projectPath = this.workspace.workspace?.resource.parent.path.toString() || '';
        void this.refresh(); const interval = setInterval(() => void this.refresh(), 5000);
        this.toDispose.push({ dispose: () => clearInterval(interval) }); this.update();
    }
    protected async refresh(): Promise<void> {
        if (this.refreshing || this.isDisposed) return; this.refreshing = true;
        try {
            const index = await this.tasks.projectContext(this.projectPath); this.index = index;
            this.error = '';
            if (this.feedback.startsWith('Research started') && !index.repositories.some(repo => repo.job && ['running', 'awaiting_approval'].includes(repo.job.state)) && index.repositories.some(repo => repo.job?.state === 'completed' && repo.context)) this.feedback = 'Research complete. Saved context is ready.';
            if (!index.repositories.some(repo => repo.id === this.repository)) this.repository = index.repositories[0]?.id;
            const repo = index.repositories.find(repo => repo.id === this.repository);
            if (repo?.context && this.generation !== repo.context.generation) {
                this.generation = repo.context.generation;
                const topic = repo.context.topics.find(topic => topic.id === this.topic) || repo.context.topics[0];
                if (topic) await this.loadTopic(repo.id, topic.id);
            }
        } catch (error) { this.error = error instanceof Error ? error.message : 'Could not load project context.'; }
        finally { this.refreshing = false; this.update(); }
    }
    protected async loadTopic(repository: string, topic: string): Promise<void> {
        this.repository = repository; this.topic = topic; this.selection = undefined; this.loadingTopic = true; this.update();
        try { const value = await this.tasks.contextTopics(this.projectPath, repository, [topic]); if (this.repository === repository && this.topic === topic) this.selection = value; }
        catch (error) { this.error = error instanceof Error ? error.message : 'Could not load this topic.'; }
        finally { this.loadingTopic = false; this.update(); }
    }
    protected chooseRepository(repository: string): void {
        this.repository = repository; this.topic = undefined; this.selection = undefined;
        const repo = this.index?.repositories.find(repo => repo.id === repository); this.generation = repo?.context?.generation;
        if (repo?.context?.topics[0]) void this.loadTopic(repository, repo.context.topics[0].id); this.update();
    }
    protected async analyze(repository: string): Promise<void> {
        this.starting = repository; this.error = ''; this.feedback = ''; this.update();
        try { await this.tasks.analyzeRepository(this.projectPath, repository); this.feedback = `Research started for ${repository}. You can keep working while it runs.`; await this.refresh(); }
        catch (error) { this.error = error instanceof Error ? error.message : 'Could not start research.'; }
        finally { this.starting = undefined; this.update(); }
    }
    protected source(path: string): React.ReactNode {
        return <button className="context-source" key={path} title="Open source file" onClick={() => { const resource = this.workspace.workspace?.resource.parent.resolve(path); if (resource) void open(this.opener, resource); }}>{path}</button>;
    }
    protected render(): React.ReactNode {
        const current = this.index?.repositories.find(repo => repo.id === this.repository); const selected = this.selection?.topics[0];
        return <div className="project-context-root"><div className="project-page project-context-page">
            <BackLink destination="Workbench" onClick={() => void this.commands.executeCommand('governed-ide:open-chat')} />
            <header className="context-page-header"><div><h1>Project context</h1><p>Generated from repository research. The short index is included automatically; topics are loaded when needed.</p></div></header>
            {this.error && <div className="context-alert" role="alert">{this.error}</div>}{this.feedback && <div className="context-feedback" role="status">{this.feedback}</div>}
            <div className="context-layout"><aside className="context-repositories"><h2>Repositories</h2>{!this.index && <p>Loading project context…</p>}{this.index?.repositories.length === 0 && <p>No repositories connected.</p>}{this.index?.repositories.map(repo => {
                const working = repo.job && ['running', 'awaiting_approval'].includes(repo.job.state); const status = repo.job?.review ? 'Review required' : working ? 'Researching…' : repo.context ? repo.context.freshness === 'current' ? 'Saved context' : repo.context.freshness === 'changed' ? 'Code changed' : 'Needs verification' : 'Not analyzed';
                return <section className={`context-repository${repo.id === this.repository ? ' selected' : ''}`} key={repo.id}><button className="context-repository-select" onClick={() => this.chooseRepository(repo.id)}><strong>{repo.id}</strong><small>{status}</small></button><p>{repo.context?.summary || 'Research the architecture, existing patterns and useful implementation examples.'}</p><div className="context-repository-actions"><button className="context-secondary" disabled={!!working || this.starting === repo.id} onClick={() => void this.analyze(repo.id)}>{working || this.starting === repo.id ? 'Researching…' : repo.context ? 'Refresh analysis' : 'Analyze repository'}</button>{working && <button className="context-text-button" onClick={() => void this.tasks.cancel(repo.job!.taskId).then(() => this.refresh()).catch(error => { this.error = String(error.message || error); this.update(); })}>Stop</button>}</div>{repo.job && ['failed', 'cancelled', 'interrupted'].includes(repo.job.state) && <p className="context-job-error">{repo.job.error || `Research ${repo.job.state}. Run the analysis again to retry.`}</p>}{repo.job?.review && <details className="context-memory-review"><summary>Review memory update</summary><p>Only durable architecture belongs here. Existing facts stay unless explicitly retired. Review the proposed facts and retirements before saving.</p><pre>{JSON.stringify(repo.job.review.proposal, undefined, 2)}</pre><button className="context-primary" onClick={() => void this.tasks.respondInteraction(repo.job!.review!.interactionId, { approved: true }).then(() => this.refresh()).catch(error => { this.error = String(error.message || error); this.update(); })}>Approve memory update</button><button className="context-secondary" onClick={() => void this.tasks.respondInteraction(repo.job!.review!.interactionId, { approved: false }).then(() => this.refresh()).catch(error => { this.error = String(error.message || error); this.update(); })}>Reject update</button></details>}{repo.context && <small className="context-revision">Updated {new Date(repo.context.updatedAt).toLocaleString()} · {repo.context.revision === 'uncommitted' ? 'Uncommitted snapshot' : repo.context.revision.slice(0, 8)}{repo.context.dirty ? ' · Working-tree changes' : ''}</small>}</section>;
            })}</aside><main className="context-topics">{current?.context ? <><div className="context-section-heading"><div><h2>Architecture topics</h2><p>Load one topic at a time. Source files stay in the repository.</p></div></div>{current.context.freshness !== 'current' && <div className="context-stale">{current.context.note}</div>}<nav className="context-topic-tabs" aria-label="Context topics">{current.context.topics.map(topic => <button key={topic.id} className={topic.id === this.topic ? 'active' : ''} title={topic.whenToUse} onClick={() => void this.loadTopic(current.id, topic.id)}>{topic.title}</button>)}</nav>{this.loadingTopic ? <p>Loading selected topic…</p> : selected && <article className="context-topic"><h3>{selected.title}</h3><p className="context-topic-summary">{selected.summary}</p><div className="context-when"><strong>Use for</strong> {selected.whenToUse}</div>{selected.facts.length > 0 && <><h4>Observed patterns</h4><ul>{selected.facts.map((fact, index) => <li key={index}><p>{fact.text}</p><div className="context-evidence">{fact.evidence.map(path => this.source(path))}</div></li>)}</ul></>}{selected.examples.length > 0 && <><h4>Existing examples</h4>{selected.examples.map((example, index) => <div className="context-example" key={index}><p>{example.purpose}</p>{this.source(example.path)}{example.symbol && <code>{example.symbol}</code>}</div>)}</>}{selected.unknowns.length > 0 && <><h4>Not yet verified</h4><ul className="context-unknowns">{selected.unknowns.map((unknown, index) => <li key={index}>{unknown}</li>)}</ul></>}<footer>Generated observations from selected source files. They do not replace team rules or a check of the current code.</footer></article>}</> : <div className="context-empty"><span className="codicon codicon-book" /><h2>{current ? `Build context for ${current.id}` : 'Repository context'}</h2><p>Research saves a compact map of responsibilities, patterns and examples. Future tasks can request only the topics they need.</p>{current && <button className="context-primary" disabled={this.starting === current.id || current.job?.state === 'running'} onClick={() => void this.analyze(current.id)}>Analyze repository</button>}</div>}</main></div>
        </div></div>;
    }
}
