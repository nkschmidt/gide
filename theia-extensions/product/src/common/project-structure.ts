/** Paths protected against deletion, renaming and moving. Repository source files remain ordinary editable files. */
export const projectDirectories = ['changesets', 'tools', 'context', 'repositories', 'workflows'];
export function protectedProjectPath(relative: string): boolean {
    const parts = relative.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
    if (!parts.length) return true;
    if (parts.length === 1 && ['project.theia-workspace', 'models.yaml'].includes(parts[0])) return true;
    if (!projectDirectories.includes(parts[0])) return false;
    return parts[0] !== 'repositories' || parts.length <= 2;
}
