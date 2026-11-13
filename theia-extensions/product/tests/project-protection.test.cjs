const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { assertRemovableProjectPath } = require('../lib/node/harness/storage/project-protection');
const { changesetDirectory } = require('../lib/node/harness/storage/changeset-directory');
const { ChangeSetStore, hashText } = require('../lib/node/harness/modules/changesets');
const { projectDirectories, protectedProjectPath } = require('../lib/common/project-structure');
require('reflect-metadata');
const URI = require('@theia/core/lib/common/uri').default;
const { FilePermission } = require('@theia/filesystem/lib/common/files');
const { ProjectFileSystemProvider } = require('../lib/node/project-file-system-provider');

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'governed-protection-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const project = path.join(root, 'project'); await fs.mkdir(project);
    await fs.writeFile(path.join(project, 'project.theia-workspace'), JSON.stringify({ folders: [{ path: '.' }], governedProject: { name: 'Synthetic' }, governedRepositories: [] }));
    return { root, project };
}

test('service trees and required configuration cannot be removed; source files remain editable', async t => {
    const { project, root } = await fixture(t);
    for (const directory of projectDirectories) {
        await fs.mkdir(path.join(project, directory));
        await assert.rejects(() => assertRemovableProjectPath(path.join(project, directory)), /protected/);
        if (directory !== 'repositories') {
            const file = path.join(project, directory, 'example.md'); await fs.writeFile(file, 'Original');
            await assert.rejects(() => assertRemovableProjectPath(file), /protected/);
            await fs.writeFile(file, 'Edited'); assert.equal(await fs.readFile(file, 'utf8'), 'Edited');
        }
    }
    for (const file of ['models.yaml', 'project.theia-workspace']) await assert.rejects(() => assertRemovableProjectPath(path.join(project, file)), /protected/);
    await assert.rejects(() => assertRemovableProjectPath(project), /protected/);
    const repo = path.join(root, 'repo'); await fs.mkdir(repo); await fs.writeFile(path.join(repo, 'source.ts'), 'source');
    const link = path.join(project, 'repositories', 'back'); await fs.symlink(repo, link);
    await assert.rejects(() => assertRemovableProjectPath(link), /protected/);
    await assertRemovableProjectPath(path.join(link, 'source.ts'));
    await fs.unlink(path.join(link, 'source.ts')); await assert.rejects(() => fs.access(path.join(repo, 'source.ts')), { code: 'ENOENT' });
    const alias = path.join(root, 'alias'); await fs.symlink(path.join(project, 'context'), alias);
    await assert.rejects(() => assertRemovableProjectPath(path.join(alias, 'example.md')), /protected/);
    assert.equal(protectedProjectPath('repositories/back/src/context/a.ts'), false);
    assert.equal(protectedProjectPath('contextual/file.md'), false);
});

test('configuration rejects a linked service directory without touching external files', async t => {
    const { root, project } = await fixture(t); const external = path.join(root, 'external'); await fs.mkdir(external);
    await fs.writeFile(path.join(external, 'plan.md'), 'External');
    await fs.symlink(external, path.join(project, 'changesets'));
    await assert.rejects(() => changesetDirectory(project), /real directories/);
    assert.equal(await fs.readFile(path.join(external, 'plan.md'), 'utf8'), 'External');
});

test('filesystem provider rejects delete, move and overwrite-copy, while saving and source deletion work', async t => {
    const { project, root } = await fixture(t); const provider = new ProjectFileSystemProvider();
    const uri = file => new URI(`file://${file}`);
    const directory = path.join(project, 'context'); await fs.mkdir(directory);
    const file = path.join(directory, 'memory.md'); await fs.writeFile(file, 'Before');
    for (const useTrash of [false, true]) await assert.rejects(() => provider.delete(uri(file), { recursive: false, useTrash }), /protected/);
    await assert.rejects(() => provider.delete(uri(directory), { recursive: true, useTrash: false }), /protected/);
    await assert.rejects(() => provider.rename(uri(directory), uri(path.join(project, 'renamed')), { overwrite: false }), /protected/);
    const ordinary = path.join(root, 'ordinary.md'); await fs.writeFile(ordinary, 'Source');
    await assert.rejects(() => provider.rename(uri(ordinary), uri(file), { overwrite: true }), /protected/);
    await assert.rejects(() => provider.copy(uri(ordinary), uri(file), { overwrite: true }), /protected/);
    await provider.writeFile(uri(file), Buffer.from('After'), { create: false, overwrite: true });
    assert.equal(await fs.readFile(file, 'utf8'), 'After');
    const builtin = path.join(project, 'tools', 'builtin.git.json');
    await fs.mkdir(path.dirname(builtin), { recursive: true });
    await fs.writeFile(builtin, 'Original definition');
    const alias = path.join(root, 'definition.json');
    await fs.symlink(builtin, alias);
    for (const file of [builtin, alias]) assert.equal((await provider.stat(uri(file))).permissions, FilePermission.Readonly);
    assert.equal((await provider.stat(uri(ordinary))).permissions, undefined);
    await assert.rejects(() => provider.writeFile(uri(builtin), Buffer.from('Edited'), { create: false, overwrite: true }), /read-only/);
    assert.equal(await fs.readFile(builtin, 'utf8'), 'Original definition');
    await provider.delete(uri(ordinary), { recursive: false, useTrash: false });
    await assert.rejects(() => fs.access(ordinary), { code: 'ENOENT' });
    provider.dispose();
});
