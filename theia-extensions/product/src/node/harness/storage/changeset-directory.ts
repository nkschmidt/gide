import { projectDirectory } from './project-files';
export function changesetDirectory(project: string): Promise<string> { return projectDirectory(project, ['changesets'], true); }
