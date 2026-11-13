import { injectable } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { DiskFileSystemProvider } from '@theia/filesystem/lib/node/disk-file-system-provider';
import { FileDeleteOptions, FileOpenOptions, FileOverwriteOptions, FilePermission, FileWriteOptions, Stat, createFileSystemProviderError, FileSystemProviderErrorCode } from '@theia/filesystem/lib/common/files';
import { assertRemovableProjectPath, assertWritableProjectPath, isReadOnlyProjectPath } from './harness/storage/project-protection';

@injectable()
export class ProjectFileSystemProvider extends DiskFileSystemProvider {
    override async stat(resource: URI): Promise<Stat> {
        const stat = await super.stat(resource);
        if (await isReadOnlyProjectPath(this.toFilePath(resource))) {
            return { ...stat, permissions: (stat.permissions ?? 0) | FilePermission.Readonly };
        }
        return stat;
    }
    private async removable(resource: URI): Promise<void> {
        try { await assertRemovableProjectPath(this.toFilePath(resource)); }
        catch (error) { throw createFileSystemProviderError(error as Error, FileSystemProviderErrorCode.NoPermissions); }
    }
    private async writable(resource: URI): Promise<void> {
        try { await assertWritableProjectPath(this.toFilePath(resource)); }
        catch (error) { throw createFileSystemProviderError(error as Error, FileSystemProviderErrorCode.NoPermissions); }
    }
    override async writeFile(resource: URI, content: Uint8Array, options: FileWriteOptions): Promise<void> {
        await this.writable(resource);
        return super.writeFile(resource, content, options);
    }
    override async open(resource: URI, options: FileOpenOptions): Promise<number> {
        if (options.create) await this.writable(resource);
        return super.open(resource, options);
    }
    override async delete(resource: URI, options: FileDeleteOptions): Promise<void> {
        await this.removable(resource);
        return super.delete(resource, options);
    }
    override async rename(from: URI, to: URI, options: FileOverwriteOptions): Promise<void> {
        await this.removable(from);
        await this.removable(to);
        return super.rename(from, to, options);
    }
    override async copy(from: URI, to: URI, options: FileOverwriteOptions): Promise<void> {
        // Copy with overwrite may recursively replace its target.
        await this.writable(to);
        if (options.overwrite) await this.removable(to);
        return super.copy(from, to, options);
    }
}
