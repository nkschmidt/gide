import { injectable } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { WorkspaceDeleteHandler } from '@theia/workspace/lib/browser/workspace-delete-handler';
import { protectedProjectPath } from '../common/project-structure';

@injectable()
export class ProjectDeleteHandler extends WorkspaceDeleteHandler {
    override isEnabled(uris: URI[]): boolean {
        const workspace = this.workspaceService.workspace?.resource;
        if (workspace?.path.base === 'project.theia-workspace' && uris.some(uri => {
            const relative = workspace.parent.path.relative(uri.path);
            return relative !== undefined && protectedProjectPath(relative.toString());
        })) return false;
        return super.isEnabled(uris);
    }
    override async execute(uris: URI[]): Promise<void> {
        if (!this.isEnabled(uris)) return;
        return super.execute(uris);
    }
}
