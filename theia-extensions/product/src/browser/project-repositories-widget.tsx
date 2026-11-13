import { BackLink } from './back-link';
import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { ConfirmDialog } from '@theia/core/lib/browser/dialogs';
import { CommandService } from '@theia/core/lib/common/command';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog/file-dialog-service';
import { ConnectedRepository, ProjectService } from '../common/project-service';
import { TaskService } from '../common/task-service';
import { ConnectedRepositoryList, RepositoryConnectForm } from './repository-connect-form';

@injectable()
export class ProjectRepositoriesWidget extends ReactWidget {
    static readonly ID = 'governed-ide:repositories';
    @inject(WorkspaceService) protected readonly workspace: WorkspaceService;
    @inject(ProjectService) protected readonly projects: ProjectService;
    @inject(TaskService) protected readonly tasks: TaskService;
    @inject(FileDialogService) protected readonly dialogs: FileDialogService;
    @inject(CommandService) protected readonly commands: CommandService;
    protected projectPath = '';
    protected repositories: ConnectedRepository[] = [];
    protected loading = true;
    protected busy = false;
    protected error = '';
    protected status = '';

    constructor() {
        super();
        this.id = ProjectRepositoriesWidget.ID;
        this.title.label = 'Repositories';
        this.title.iconClass = 'codicon codicon-repo';
        this.title.closable = true;
        this.addClass('project-context-widget');
    }

    @postConstruct() protected initialize(): void {
        this.projectPath = this.workspace.workspace?.resource.parent.path.toString() || '';
        void this.refresh().catch(error => this.showError(error));
    }

    protected async refresh(): Promise<void> {
        try { this.repositories = await this.projects.listRepositories(this.projectPath); }
        finally { this.loading = false; this.update(); }
    }

    protected showError(error: unknown): void {
        this.error = error instanceof Error ? error.message : 'Could not update repositories.';
        this.update();
    }

    protected async disconnect(id: string): Promise<void> {
        const confirmed = await new ConfirmDialog({
            title: `Disconnect ${id}?`,
            msg: 'The Git checkout stays on disk. Project analysis will restart for the remaining repositories.',
            ok: 'Disconnect'
        }).open();
        if (!confirmed || this.busy || this.isDisposed) return;
        this.busy = true;
        this.error = '';
        this.status = '';
        this.update();
        try {
            await this.projects.removeRepository(this.projectPath, id);
            await this.refresh();
            await this.tasks.analyzeProject(this.projectPath);
            if (this.repositories.length) {
                this.status = 'Analysis restarted for the remaining repositories.';
            } else this.status = 'Connect a repository to start a new analysis.';
        } catch (error) { this.showError(error); }
        finally { this.busy = false; this.update(); }
    }

    protected render(): React.ReactNode {
        return <div className="project-context-root"><div className="project-page repositories-page">
            <BackLink destination="Workbench" onClick={() => void this.commands.executeCommand('governed-ide:open-chat')} />
            <header className="context-page-header">
                <div><h1>Repositories</h1><p>Manage the Git repositories connected to this project.</p></div>
            </header>
            <div className="project-form repository-management">
                {this.error && <div className="context-alert" role="alert">{this.error}</div>}
                {this.status && <p role="status">{this.status}</p>}
                {this.loading ? <p>Loading repositories…</p> : <>
                    {this.repositories.length > 0 && <ConnectedRepositoryList repositories={this.repositories} busy={this.busy} onRemove={id => void this.disconnect(id)} />}
                    <h2>{this.repositories.length ? 'Connect another repository' : 'Connect your first repository'}</h2>
                    <RepositoryConnectForm projectPath={this.projectPath} projects={this.projects} dialogs={this.dialogs}
                        repositories={this.repositories} busy={this.busy} onBusy={busy => { this.busy = busy; this.update(); }}
                        onConnected={async () => { this.error = ''; await this.refresh(); this.status = 'Repository connected. Run project analysis in Workbench.'; this.update(); }} />
                </>}
            </div>
        </div></div>;
    }
}
