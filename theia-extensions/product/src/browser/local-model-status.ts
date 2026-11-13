import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar/status-bar';
import { CommandContribution, CommandRegistry } from '@theia/core/lib/common/command';
import { inject, injectable } from '@theia/core/shared/inversify';
import { DEFAULT_LOCAL_MODEL, ProjectService } from '../common/project-service';

const entryId = 'governed-ide:local-model';
const retryCommand = { id: 'governed-ide:retry-local-model', label: 'Retry local model setup' };

@injectable()
export class LocalModelStatusContribution implements FrontendApplicationContribution, CommandContribution {
    @inject(ProjectService) protected readonly projects: ProjectService;
    @inject(StatusBar) protected readonly statusBar: StatusBar;
    protected timer?: ReturnType<typeof setTimeout>;
    protected stopped = false;

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(retryCommand, { execute: async () => {
            await this.projects.installLocalModel();
            clearTimeout(this.timer);
            await this.refresh();
        } });
    }

    onStart(): void {
        void this.refresh();
    }

    onStop(): void {
        this.stopped = true;
        clearTimeout(this.timer);
    }

    protected async refresh(): Promise<void> {
        const status = await this.projects.modelStatus().catch(() => undefined);
        if (this.stopped) return;
        const job = status?.job;
        if (job?.state === 'done') {
            await this.statusBar.removeElement(entryId);
            return;
        }
        if (job?.state === 'error') {
            await this.statusBar.setElement(entryId, {
                text: '$(warning) Retry local model setup',
                alignment: StatusBarAlignment.LEFT,
                tooltip: job.error || job.phase,
                command: retryCommand.id
            });
            return;
        }
        if (job) {
            const percentage = job.total > 0 ? ` ${Math.min(100, Math.floor(job.completed / job.total * 100))}%` : '';
            await this.statusBar.setElement(entryId, {
                text: `$(sync~spin) ${DEFAULT_LOCAL_MODEL}${percentage}`,
                alignment: StatusBarAlignment.LEFT,
                tooltip: job.phase
            });
        }
        if (!this.stopped) this.timer = setTimeout(() => void this.refresh(), 1500);
    }
}
