import { basename } from 'path';
import { readProjectText } from './project-files';
export async function projectIdentity(project: string): Promise<{ name: string; description: string; repositoryRevision?: string }> {
    const workspace = JSON.parse(await readProjectText(project, [], 'project.theia-workspace') || '{}');
    return { name: typeof workspace.governedProject?.name === 'string' ? workspace.governedProject.name : basename(project), ...(typeof workspace.governedRepositoryRevision === 'string' ? { repositoryRevision: workspace.governedRepositoryRevision } : {}), description: typeof workspace.governedProject?.description === 'string' ? workspace.governedProject.description : '' };
}
