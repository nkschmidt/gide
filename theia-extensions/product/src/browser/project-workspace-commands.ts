import { injectable } from '@theia/core/shared/inversify';
import { CommandRegistry } from '@theia/core/lib/common/command';
import URI from '@theia/core/lib/common/uri';
import { WorkspaceCommandContribution, WorkspaceCommands } from '@theia/workspace/lib/browser/workspace-commands';
import { protectedProjectPath } from '../common/project-structure';

@injectable()
export class ProjectWorkspaceCommands extends WorkspaceCommandContribution {
    private protectedSelection(uris: URI[]): boolean {
        const workspace = this.workspaceService.workspace?.resource;
        return workspace?.path.base === 'project.theia-workspace' && uris.some(uri => {
            const relative = workspace.parent.path.relative(uri.path);
            return relative !== undefined && protectedProjectPath(relative.toString());
        });
    }
    override registerCommands(registry: CommandRegistry): void {
        super.registerCommands(registry);
        // Preserve Theia's rename dialog/validation and change only the access guard.
        const command = WorkspaceCommands.FILE_RENAME;
        const handlers = registry.getAllHandlers(command.id);
        registry.unregisterCommand(command);
        registry.registerCommand(command, this.newMultiUriAwareCommandHandler({
            isVisible: uris => handlers.some(handler => !handler.isVisible || handler.isVisible(uris)),
            isEnabled: uris => !this.protectedSelection(uris) && handlers.some(handler => !handler.isEnabled || handler.isEnabled(uris)),
            execute: uris => {
                if (this.protectedSelection(uris)) return;
                return handlers.find(handler => !handler.isEnabled || handler.isEnabled(uris))?.execute(uris);
            }
        }));
    }
}
