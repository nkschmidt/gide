import { WorkflowOperation } from '../../../common/workflow-run';
import { scopeAccess } from '../core/tool-access';
import { realpath, rename, unlink, writeFile } from 'fs/promises';
import { assertRemovableProjectPath } from '../storage/project-protection';
import { dirname, resolve } from 'path';
import { randomUUID } from 'crypto';
import { ToolContext, ToolDefinition, ToolRegistry } from '../core/contracts';
import { WorkflowEngine } from '../core/workflow-engine';
import { SafeToolError, within } from './file-tools';
import { hashText, repositoryFilePath } from './changesets';
import { gitRoot, gitState, repositoryMutation } from './git-tools';
import { resolveRepositoryTarget } from './repository-tools';

import { replaceText } from './text-replacements';
import { fileState } from './repository-file-state';

export function registerWriteTools(tools: ToolRegistry, workflow: WorkflowEngine): void {
    const add = (definition: ToolDefinition, prepare: (args: Record<string, unknown>, context: ToolContext) => Promise<Record<string, unknown>>, execute: (args: Record<string, unknown>, prepared: Record<string, unknown>, context: ToolContext) => Promise<string>, operation?: WorkflowOperation) => tools.register({ workflowOperations: operation ? [operation] : [], access: scopeAccess({ [['repository_edit', 'repository_replace'].includes(definition.name) ? 'workflow-edit' : ['changeset_list', 'changeset_read'].includes(definition.name) ? 'changeset-read' : 'workflow-changeset']: 'allow' }, undefined, ['changeset_list', 'changeset_read'].includes(definition.name) ? ['read'] : ['write']), definition, available: context => context.purpose !== 'repository-analysis', prepare, execute });
    const definition = (name: string, description: string, properties: Record<string, unknown>): ToolDefinition => ({ name, description, parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } });
    add(definition('changeset_list', 'List saved Markdown ChangeSets in this project. No recursive search or external paths.', {}), async () => ({ scope: 'changeset-read' }), async (_args, _prepared, context) => JSON.stringify({ files: await workflow.documents.list(context.projectPath) }));
    add(definition('changeset_read', 'Read a saved project ChangeSet: plan text (without generated metadata), separate execution notes, exact repository/file scope, full digest and approved-plan digest. To revise the plan use this plan text and full digest with changeset_write.', { name: { type: 'string' } }), async args => { workflow.documents.name(args.name); return { scope: 'changeset-read' }; }, async (args, _prepared, context) => { const { body, ...document } = await workflow.documents.read(context.projectPath, args.name); return JSON.stringify(document); });
    add(definition('changeset_write', 'Create/update a Markdown plan only inside changesets/. Requires an active ready changeset-write step. Scope lists registered repository IDs and exact files that may later be edited. expectedDigest is null for creation, otherwise the digest from changeset_read. Plan edits invalidate prior plan approval. Use changeset_notes for execution history.', { name: { type: 'string' }, body: { type: 'string' }, scope: { type: 'array', items: { type: 'object', properties: { repository: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } }, baseBranch: { type: 'string', description: 'Agreed base branch, or empty string to use detected default.' } }, required: ['repository', 'paths', 'baseBranch'], additionalProperties: false } }, expectedDigest: { type: ['string', 'null'] } }), async (args, context) => { await workflow.authorize(context, 'changeset-write'); const scope = workflow.documents.scope(args.scope); for (const target of scope) await resolveRepositoryTarget({ repository: target.repository, path: '.', offset: 0 }, context); workflow.documents.name(args.name); return { scope: 'workflow-changeset' }; }, async (args, _prepared, context) => { await workflow.authorize(context, 'changeset-write'); for (const target of workflow.documents.scope(args.scope)) await resolveRepositoryTarget({ repository: target.repository, path: '.', offset: 0 }, context); return JSON.stringify(await workflow.documents.write(context.projectPath, args.name, args.body, args.scope, args.expectedDigest)); }, 'changeset-write');
    const notePermission = async (args: Record<string, unknown>, context: ToolContext) => {
        const task = context.taskId && workflow.store.task(context.taskId); const run = task && task.workflow;
        if (!run || run.phase !== 'active' || !run.ready) throw new SafeToolError('Execution notes require an active ready step.');
        const doc = await workflow.documents.read(context.projectPath, args.name);
        if (!run.results.some(result => result.approvedAt && result.artifacts.some(artifact => artifact.path === doc.path && artifact.digest === doc.planDigest))) throw new SafeToolError('Execution notes require an approved, unchanged ChangeSet plan.');
    };
    add(definition('changeset_notes', 'Replace final execution/verification notes in an approved ChangeSet without changing its approved plan or file scope. Read the current digest first. Notes are task history, never architecture memory.', { name: { type: 'string' }, notes: { type: 'string' }, expectedDigest: { type: 'string' } }), async (args, context) => { await notePermission(args, context); return { scope: 'workflow-changeset' }; }, async (args, _prepared, context) => { await notePermission(args, context); return JSON.stringify(await workflow.documents.notes(context.projectPath, args.name, args.notes, args.expectedDigest)); });
    const inspect = async (args: Record<string, unknown>, context: ToolContext) => {
        const path = repositoryFilePath(args.path); await workflow.authorize(context, 'repository-edit', String(args.repository), path);
        if ((args.expectedDigest !== null && (typeof args.expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedDigest))) || (args.content !== null && (typeof args.content !== 'string' || Buffer.byteLength(args.content) > 131072 || args.content.includes('\0')))) throw new SafeToolError('Pass UTF-8 content (or null to delete) and the exact current SHA-256 digest (or null to create).');
        const root = await gitRoot(args.repository, context); const branch = workflow.branch(context, String(args.repository)); const state = await gitState(root, context);
        if (!branch || branch.branch !== state.branch || (branch.tip || branch.head) !== state.head) throw new SafeToolError('Prepare a feature branch for this task before editing; its branch and base commit must still match.');
        const owned = workflow.edits(context, String(args.repository));
        if (state.entries.some(entry => !Object.prototype.hasOwnProperty.call(owned, entry.path) || (entry.previousPath && !Object.prototype.hasOwnProperty.call(owned, entry.previousPath)))) throw new SafeToolError('Unrelated working-tree changes appeared after branch preparation. Stop and resolve their ownership with the user; do not overwrite, reset or stash.');
        for (const [path, digest] of Object.entries(owned)) if ((await fileState(root, path)).digest !== digest) throw new SafeToolError('A task-owned file changed outside this task. Resolve the concurrent changes with the user before writing.');
        const file = await fileState(root, path);
        if (args.content === null) await assertRemovableProjectPath(resolve(root, path));
        if (file.digest !== args.expectedDigest || (args.content === null && file.digest === null)) throw new SafeToolError('Source content changed or the delete target is missing. Read it again and rebase the proposed edit.');
        return { root, path, file };
    };
    const prepareEdit = async (args: Record<string, unknown>, context: ToolContext) => { const item = await inspect(args, context); return { scope: 'workflow-edit', root: item.root, path: item.path, digest: item.file.digest, contentDigest: args.content === null ? null : hashText(String(args.content)) }; };
    const executeEdit = async (args: Record<string, unknown>, prepared: Record<string, unknown>, context: ToolContext) => repositoryMutation(args.repository, context, async () => {
        const item = await inspect(args, context);
        if (item.root !== prepared.root || item.path !== prepared.path || item.file.digest !== prepared.digest || (args.content === null ? null : hashText(String(args.content))) !== prepared.contentDigest) throw new SafeToolError('The prepared edit changed. Request a fresh edit.');
        const file = await fileState(item.root, item.path, true); const destination = resolve(item.root, item.path);
        if (file.digest !== args.expectedDigest || !within(item.root, await realpath(dirname(destination)))) throw new SafeToolError('File changed before the edit.');
        context.signal.throwIfAborted();
        if (args.content === null) { if (await gitRoot(args.repository, context) !== item.root || (await fileState(item.root, item.path)).digest !== args.expectedDigest) throw new SafeToolError('Delete target or registration changed.'); await unlink(destination); }
        else {
            const temporary = resolve(dirname(destination), `.governed-${randomUUID()}.tmp`);
            try {
                await writeFile(temporary, String(args.content), { flag: 'wx', mode: file.mode });
                const final = await fileState(item.root, item.path);
                if (final.digest !== args.expectedDigest || final.parentIdentity !== file.parentIdentity || await gitRoot(args.repository, context) !== item.root) throw new SafeToolError('Repository or source changed immediately before saving.');
                const branch = workflow.branch(context, String(args.repository)); const state = await gitState(item.root, context);
                if (branch?.branch !== state.branch || (branch.tip || branch.head) !== state.head) throw new SafeToolError('The prepared feature branch changed before saving.');
                context.signal.throwIfAborted(); await rename(temporary, destination);
            } finally { await unlink(temporary).catch(() => undefined); }
        }
        const digest = args.content === null ? null : hashText(String(args.content)); workflow.recordEdit(context, String(args.repository), item.path, digest);
        return JSON.stringify({ repository: args.repository, path: item.path, deleted: args.content === null, digest });
    });
    add(definition('repository_edit', 'Atomically create, replace or delete ONE UTF-8 file in a registered repository. Requires the exact file in the user-approved ChangeSet, a ready repository-edit step and this task feature branch. expectedDigest is SHA-256 of the current file, null only for creation. content null deletes. No external, linked, hard-linked, binary or .git paths. No shell execution.', { repository: { type: 'string' }, path: { type: 'string' }, expectedDigest: { type: ['string', 'null'] }, content: { type: ['string', 'null'] } }), prepareEdit, executeEdit, 'repository-edit');
    const expand = async (args: Record<string, unknown>, context: ToolContext) => {
        if (Object.keys(args).sort().join(',') !== 'path,replacements,repository') throw new SafeToolError('Pass repository, path and replacements only.');
        const path = repositoryFilePath(args.path); await workflow.authorize(context, 'repository-edit', String(args.repository), path);
        const root = await gitRoot(args.repository, context); const source = await fileState(root, path);
        if (source.digest === null || source.content === undefined) throw new SafeToolError('Target file does not exist. Use files.edit to create files.');
        const replacement = replaceText(source.content, args.replacements);
        return { args: { repository: args.repository, path, expectedDigest: source.digest, content: replacement.content }, changedOccurrences: replacement.changedOccurrences };
    };
    add(definition('repository_replace', 'Apply precise literal text substitutions inside ONE existing UTF-8 file, without sending its whole content through model context. Cross-platform sed-style replacement: oldText/newText are literal, with no regex, shell, scripts or escape expansion. Send 1–20 sequential replacements, each with the exact expectedMatches (normally 1). A missing/ambiguous match, concurrent source change or any later replacement failure writes nothing. Preserves untouched bytes, line endings and UTF-8 BOM. Reuses files.edit authorization: approved ChangeSet path, ready repository-edit step, prepared task branch, owned changes and atomic save. Up to 128 KiB per source/result file. Prefer this for focused changes; files.edit is for creating/deleting files or replacing their entire content.', {
        repository: { type: 'string' }, path: { type: 'string' }, replacements: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { oldText: { type: 'string', minLength: 1 }, newText: { type: 'string' }, expectedMatches: { type: 'integer', minimum: 1, maximum: 1000 } }, required: ['oldText', 'newText', 'expectedMatches'], additionalProperties: false } }
    }), async (args, context) => prepareEdit((await expand(args, context)).args, context), async (args, prepared, context) => {
        const replacement = await expand(args, context);
        const result = JSON.parse(await executeEdit(replacement.args, prepared, context));
        return JSON.stringify({ ...result, changedOccurrences: replacement.changedOccurrences });
    }, 'repository-edit');
}

