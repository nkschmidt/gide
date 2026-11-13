import { BackLink } from './back-link';
import { ConnectedRepositoryList, RepositoryConnectForm } from './repository-connect-form';
import { Message } from '@theia/core/lib/browser/widgets/widget';
import * as React from '@theia/core/shared/react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { ChatGptStatus, ConnectedRepository, ProjectService, RecentProject } from '../common/project-service';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog/file-dialog-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import URI from '@theia/core/lib/common/uri';
import { WindowService } from '@theia/core/lib/browser/window/window-service';

@injectable()
export class GovernanceWidget extends ReactWidget {
    static readonly ID = 'governed-ide:new-project'; static readonly LABEL = 'Project';
    @inject(ProjectService) protected readonly projects: ProjectService;
    @inject(FileService) protected readonly files: FileService;
    @inject(FileDialogService) protected readonly dialogs: FileDialogService;
    @inject(WorkspaceService) protected readonly workspace: WorkspaceService;
    @inject(WindowService) protected readonly windows: WindowService;
    protected async openProject(project: RecentProject): Promise<void> {
        try { const path = await this.projects.openProject(project); await this.workspace.openWorkspace(new URI(path).withScheme('file'), { preserveWindow: true }); this.finishAndClose(); }
        catch (error) { this.status = error instanceof Error ? error.message : 'Could not open project.'; this.update(); }
    }
    protected view: 'home' | 'create' | 'repositories' | 'chatgpt' = 'home';
    protected chatGpt?: ChatGptStatus;
    protected loginUrl = '';
    protected loginBusy = false;
    protected polling?: ReturnType<typeof setInterval>;

    protected async refreshChatGpt(): Promise<void> {
        try { this.chatGpt = await this.projects.chatGptStatus(); }
        catch { this.status = 'Cannot check the ChatGPT connection. Please retry.'; }
        this.update();
    }

    protected showChatGpt(): void {
        this.view = 'chatgpt'; this.status = ''; this.update(); void this.refreshChatGpt();
        if (!this.polling) {
            this.polling = setInterval(() => { if (this.view === 'chatgpt') void this.refreshChatGpt(); }, 1500);
            this.toDispose.push({ dispose: () => clearInterval(this.polling) });
        }
    }

    protected async signIn(): Promise<void> {
        if (this.loginBusy) return;
        this.loginBusy = true; this.status = ''; this.update();
        try { const login = await this.projects.startChatGptLogin(); this.loginUrl = login.authUrl; await this.windows.openNewWindow(login.authUrl, { external: true }); await this.refreshChatGpt(); }
        catch (error) { this.status = error instanceof Error ? error.message : 'Could not open ChatGPT sign-in.'; }
        finally { this.loginBusy = false; this.update(); }
    }
    protected async finishSetup(): Promise<void> {
        if (!this.current || this.busy) return;
        this.status = '';
        this.busy = true; this.update();
        try { await this.projects.saveModels(this.current.path); await this.openProject(this.current); }
        catch (error) { this.status = error instanceof Error ? error.message : 'Could not save model settings.'; }
        finally { this.busy = false; this.update(); }
    }
    protected name = ''; protected description = ''; protected parentDirectory = '';
    protected current?: RecentProject; protected recent: RecentProject[] = []; protected status = '';
    protected connectedRepositories: ConnectedRepository[] = [];
    protected async removeRepository(id: string): Promise<void> {
        if (!this.current || this.busy) return;
        this.busy = true; this.status = ''; this.update();
        try { await this.projects.removeRepository(this.current.path, id); this.connectedRepositories = await this.projects.listRepositories(this.current.path); }
        catch { this.status = 'Could not disconnect the repository. Please try again.'; }
        finally { this.busy = false; this.update(); }
    }
    protected busy = false;
    constructor() { super(); this.id = GovernanceWidget.ID; this.title.label = GovernanceWidget.LABEL; this.title.closable = false; this.addClass('governance-widget'); this.update(); }
    private projectOpened = false;
    protected finishAndClose(): void { this.projectOpened = true; this.title.closable = true; this.close(); }
    protected override onCloseRequest(message: Message): void {
        if (this.projectOpened) super.onCloseRequest(message);
    }
    @postConstruct() protected initializeProjects(): void {
        this.toDispose.push(this.workspace.onWorkspaceLocationChanged(workspace => {
            if (workspace?.resource.path.base === 'project.theia-workspace') this.finishAndClose();
        }));
        void this.refresh();
    }
    protected async refresh(): Promise<void> { this.recent = await this.projects.listRecent(); this.update(); }
    protected set(field: 'name' | 'description' | 'parentDirectory', value: string): void {
        this[field] = value; this.status = ''; this.update();
    }
    protected async create(): Promise<void> {
        try {
            this.current = await this.projects.createProject({ name: this.name, description: this.description, parentDirectory: this.parentDirectory });
            this.connectedRepositories = [];
           
            this.status = '';
            this.view = 'repositories';
            await this.refresh();
        } catch (error) {
            this.status = error instanceof Error ? error.message : 'Could not create project.';
            this.update();
        }
    }
    protected render(): React.ReactNode { return <div className="governance-root project-setup-root"><div className="project-page"><header className="governance-header"><div>
        {this.view !== 'home' && <nav className="project-navigation" aria-label="Project navigation"><BackLink destination={this.view === 'chatgpt' ? 'Repositories' : 'Projects'}
            onClick={() => { this.view = this.view === 'chatgpt' ? 'repositories' : 'home'; this.status = ''; this.update(); }} /></nav>}
        <strong>{this.view === 'home' ? 'Welcome' : this.view === 'create' ? 'Create a project' : this.view === 'chatgpt' ? 'Connect ChatGPT' : 'Connect repositories'}</strong><span>{this.view === 'home' ? 'Open a recent project or create a new one.' : this.view === 'create' ? 'Project context stays separate from code repositories.' : this.view === 'chatgpt' ? 'Use your ChatGPT plan for this project.' : 'Repositories stay in their existing folders, or are cloned into the project.'}</span></div></header>{this.view === 'home' ? this.home() : this.view === 'create' ? this.createForm() : this.view === 'chatgpt' ? this.chatGptSetup() : this.repositories()}</div></div>; }
    protected home(): React.ReactNode { return <div className="governance-body project-form"><button className="primary-setup" onClick={() => { this.view = 'create'; this.update(); }}>Create project</button><section className="recent-projects"><h3>RECENT PROJECTS</h3>{this.recent.length ? this.recent.map(project => <button key={project.path} className="recent-project" onClick={() => void this.openProject(project)}><strong>{project.name}</strong><small>{project.description || project.path}</small></button>) : <p>No recent projects yet.</p>}</section>{this.message()}</div>; }
    protected async browseProjectFolder(): Promise<void> {
        const path = this.parentDirectory.trim();
        const initial = path ? await this.files.resolve(URI.fromFilePath(path)).catch(() => undefined) : undefined;
        try {
            const folder = await this.dialogs.showOpenDialog({
                title: 'Select projects folder', canSelectFiles: false, canSelectFolders: true, canSelectMany: false
            }, initial?.isDirectory ? initial : undefined);
            if (folder) this.set('parentDirectory', folder.path.toString());
        } catch (error) {
            this.status = error instanceof Error ? error.message : 'Could not browse folders.';
            this.update();
        }
    }

    protected createForm(): React.ReactNode {
        return <div className="governance-body project-form">
            <label>Project name<input autoFocus value={this.name} placeholder="for example, payments-platform" onChange={e => this.set('name', e.currentTarget.value)} /></label>
            <label>Short description <em>optional</em><textarea rows={3} value={this.description} placeholder="What product or team is this for?" onChange={e => this.set('description', e.currentTarget.value)} /></label>
            <label htmlFor="project-parent-folder">Projects folder</label>
            <div className="folder-input">
                <input id="project-parent-folder" value={this.parentDirectory} onChange={e => this.set('parentDirectory', e.currentTarget.value)} />
                <button type="button" onClick={() => void this.browseProjectFolder()}>Browse…</button>
            </div>
            <p className="form-hint">A folder named after the project will be created here.</p>
            {this.message()}
            <button className="primary-setup" onClick={() => void this.create()}>Create project</button>
        </div>;
    }
    protected repositories(): React.ReactNode {
        return <div className="governance-body project-form">
            {this.connectedRepositories.length > 0 && <ConnectedRepositoryList repositories={this.connectedRepositories} busy={this.busy} onRemove={id => void this.removeRepository(id)} />}
            {this.current && <RepositoryConnectForm projectPath={this.current.path} projects={this.projects} dialogs={this.dialogs}
                repositories={this.connectedRepositories} busy={this.busy} onBusy={busy => { this.busy = busy; this.update(); }}
                onConnected={async () => { this.connectedRepositories = await this.projects.listRepositories(this.current!.path); this.update(); }} />}
            {this.message()}
            <button className="project-finish" disabled={this.busy} onClick={() => this.showChatGpt()}>Next: connect ChatGPT →</button>
        </div>;
    }
    protected message(): React.ReactNode { return this.status ? <div className="form-error">{this.status}</div> : undefined; }
    protected chatGptSetup(): React.ReactNode {
        const connected = !!this.chatGpt?.planEnabled;
        return <div className="governance-body project-form models-form">
            <section className="model-section"><p>{!this.chatGpt ? 'Checking saved connection…' : connected ? `Connected${this.chatGpt?.email ? ` as ${this.chatGpt.email}` : ''}.` : 'Sign in and allow Governed IDE to use your ChatGPT plan.'}</p>
                {this.chatGpt?.error && <div className="form-error" role="alert">{this.chatGpt.error}</div>}
                {this.chatGpt && !connected && <button className="chatgpt-signin" disabled={this.loginBusy || this.chatGpt?.pending} onClick={() => void this.signIn()}>{this.chatGpt?.pending ? 'Waiting for sign-in…' : this.loginBusy ? 'Opening sign-in…' : 'Continue with ChatGPT'}</button>}
                {this.chatGpt?.pending && <div className="signin-actions">{this.loginUrl && <a href={this.loginUrl} target="_blank" rel="noopener noreferrer">Open sign-in page</a>}<button className="project-back" onClick={() => void this.projects.cancelChatGptLogin().then(() => this.refreshChatGpt())}>Cancel sign-in</button></div>}
                {connected && <p className="form-hint">Using your ChatGPT plan. <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage usage</a></p>}
            </section>
            {this.message()}<button className="primary-setup" disabled={this.busy || !connected} onClick={() => void this.finishSetup()}>{this.busy ? 'Opening project…' : 'Open project →'}</button>
        </div>;
    }
}
