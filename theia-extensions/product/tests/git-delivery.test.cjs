require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtemp, mkdir, realpath, rm, symlink, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { ToolRegistry } = require('../lib/node/harness/core/contracts');
const { hashText } = require('../lib/node/harness/modules/changesets');
const { registerGitDelivery } = require('../lib/node/harness/modules/git-delivery');
const gitTools = require('../lib/node/harness/modules/git-tools');

test('commit includes only recorded task edits and remote publication targets the exact reviewed commit', async t => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'governed-git-delivery-')));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const repo = join(directory, 'repo');
    const project = join(directory, 'project');
    await mkdir(repo);
    await mkdir(join(project, 'repositories'), { recursive: true });
    const git = (...args) => execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe' }).toString().trim();
    git('init', '-b', 'main');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('remote', 'add', 'origin', 'https://bitbucket.org/workspace/repo.git');
    await writeFile(join(repo, 'app.txt'), 'old\n');
    await writeFile(join(repo, 'removed.txt'), 'old\n');
    git('add', '.');
    git('commit', '-m', 'Initial');
    const branch = { branch: 'feature/test', base: 'main', head: git('rev-parse', 'HEAD') };
    git('switch', '-c', branch.branch);
    await symlink(repo, join(project, 'repositories', 'back'), 'dir');
    await writeFile(join(project, 'project.theia-workspace'), JSON.stringify({ governedRepositories: [{ id: 'back', path: repo }] }));

    const edits = { 'app.txt': hashText('new\n'), 'added.txt': hashText('added\n'), 'removed.txt': null };
    const registry = new ToolRegistry();
    registerGitDelivery(registry, {
        authorize: async (_context, _operation, repository) => {
            assert.equal(repository, 'back');
            return [{ repository, paths: Object.keys(edits) }];
        },
        branch: () => branch,
        recordCommit: (_context, _repository, parent, head) => { assert.equal(parent, branch.tip || branch.head); branch.tip = head; },
        edits: () => edits,
        store: { task: () => ({ workflow: {} }) }
    });
    const context = { projectPath: project, signal: new AbortController().signal, taskId: 'task' };
    const commit = registry.get('git_commit_changeset');
    const args = { repository: 'back', message: 'Apply the approved change' };
    await writeFile(join(repo, 'app.txt'), 'new\n');
    await writeFile(join(repo, 'added.txt'), 'added\n');
    await rm(join(repo, 'removed.txt'));
    await writeFile(join(repo, 'unrelated.txt'), 'preserve me');
    await assert.rejects(() => commit.prepare(args, context), /outside the exact files/);
    await rm(join(repo, 'unrelated.txt'));
    const prepared = await commit.prepare(args, context);
    await writeFile(join(repo, 'app.txt'), 'external edit\n');
    await assert.rejects(() => commit.execute(args, prepared, context), /outside the exact files/);
    await writeFile(join(repo, 'app.txt'), 'new\n');
    const {sourceIdentity}=require('../lib/node/harness/modules/git-snapshot');const beforeCommit=await sourceIdentity('back',context,{includeRevision:false});
    const result = JSON.parse(await commit.execute(args, prepared, context));
    assert.equal(await sourceIdentity('back',context,{includeRevision:false}),beforeCommit,'committing additions/deletions does not invalidate source-only review evidence');
    assert.equal(result.commit, git('rev-parse', 'HEAD'));
    assert.equal(git('status', '--porcelain'), '');
    assert.deepEqual(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n'), Object.keys(edits).sort());
    assert.equal(JSON.parse(await commit.execute(args, await commit.prepare(args, context), context)).commit, result.commit);

    const publish = registry.get('git_pull_request');
    assert.equal(publish.requiresApproval, true);
    const request = { repository: 'back', title: 'Approved change', description: 'Verification passed.' };
    const reviewed = await publish.prepare(request, context);
    assert.equal(reviewed.review.destination, 'https://bitbucket.org/workspace/repo');
    assert.equal(reviewed.review.commit, result.commit);
    const pushes = [];
    const realGit = gitTools.git;
    t.mock.method(gitTools, 'git', async (root, argv, ...rest) => {
        if (!argv.includes('push')) return realGit(root, argv, ...rest);
        pushes.push(argv);
        return argv.includes('merge_request.create') ? 'remote: https://gitlab.com/team/subgroup/repo/-/merge_requests/42' : '';
    });
    assert.equal(pushes.length, 0);
    const published = JSON.parse(await publish.execute(request, reviewed, context));
    assert.equal(published.status, 'published');
    assert.equal(published.url, 'https://bitbucket.org/workspace/repo/pull-requests/new?source=feature%2Ftest&dest=main');
    assert.deepEqual(pushes[0].slice(-2), ['https://bitbucket.org/workspace/repo.git', `${result.commit}:refs/heads/${branch.branch}`]);

    git('remote', 'set-url', 'origin', 'git@gitlab.com:team/subgroup/repo.git');
    await assert.rejects(() => publish.execute(request, reviewed, context), /destination changed/);
    const gitlab = JSON.parse(await publish.execute(request, await publish.prepare(request, context), context));
    assert.equal(gitlab.status, 'created');
    assert.equal(gitlab.url, 'https://gitlab.com/team/subgroup/repo/-/merge_requests/42');
    assert.ok(pushes[1].includes('merge_request.target=main'));

    git('remote', 'set-url', 'origin', 'git@github.com:team/repo.git');
    const github = registry.get('github_pull_request');
    const native = require('../lib/node/harness/modules/native-process');
    const executable = t.mock.method(native, 'nativeExecutable', async () => ({ path: '/fixture/gh' }));
    t.mock.method(native, 'runNative', async ({ arguments: argv }) => {
        if (argv[0] === 'auth') return { state: 'passed' };
        if (argv[1] === 'list') return { state: 'passed', output: '[]' };
        assert.equal(argv[1], 'create');
        assert.equal(argv[argv.indexOf('--head') + 1], branch.branch);
        return { state: 'passed', output: 'https://github.com/team/repo/pull/42' };
    });
    const resultGh = JSON.parse(await github.execute(request, await github.prepare(request, context), context));
    assert.equal(resultGh.status, 'created');
    assert.equal(resultGh.url, 'https://github.com/team/repo/pull/42');
    executable.mock.mockImplementation(async () => { throw new Error('gh is missing'); });
    const fallback = JSON.parse(await github.execute(request, await github.prepare(request, context), context));
    assert.equal(fallback.status, 'published');
    assert.match(fallback.url, /github\.com\/team\/repo\/compare\/main\.\.\.feature%2Ftest/);
});

test('a required approval still blocks execution under an Allow project policy', async t => {
    const { TaskRuntime } = require('../lib/node/harness/core/runtime');
    const { SqliteStore } = require('../lib/node/harness/storage/sqlite-store');
    const { OutputSizeLimit } = require('../lib/node/harness/modules/file-tools');
    const { scriptedProvider } = require('./scripted-provider.cjs');
    const registry = new ToolRegistry();
    let executions = 0;
    registry.register({
        definition: { name: 'publish_fixture', description: 'Publish test data', parameters: { type: 'object' } },
        requiresApproval: true,
        prepare: async () => ({ review: { kind: 'pull-request' } }),
        execute: async () => { executions++; return 'published'; }
    });
    const provider = scriptedProvider({ id: 'fixture', respond: async messages => messages.some(message => message.role === 'tool')
        ? { text: 'Done.', calls: [] }
        : { text: '', calls: [{ id: 'publish', tool: 'publish_fixture', args: {} }] } });
    const directory = await mkdtemp(join(tmpdir(), 'governed-pr-approval-'));
    const store = new SqliteStore(join(directory, 'tasks.sqlite'));
    const runtime = new TaskRuntime(store, provider, registry, {
        evaluate: async () => ({ decision: 'allow', revision: 'fixture', category: 'publish' })
    }, new OutputSizeLimit());
    t.after(async () => { runtime.shutdown(); store.close(); await rm(directory, { recursive: true, force: true }); });
    const task = runtime.create(tmpdir());
    runtime.send(task.id, 'Publish', 'send');
    for (let i = 0; i < 100 && store.task(task.id).state !== 'awaiting_approval'; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    const request = runtime.snapshot(task.id).interactions.find(item => item.kind === 'action_approval');
    assert.ok(request);
    assert.equal(executions, 0);
    await runtime.respondInteraction(request.id, { approved: false });
    for (let i = 0; i < 100 && store.task(task.id).state === 'running'; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(store.interaction(request.id).response.approved, false);
    assert.equal(executions, 0);
});
