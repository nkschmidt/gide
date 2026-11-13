require('reflect-metadata');
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const {execFileSync}=require('node:child_process');
const {GitCommand,gitArguments,gitCategory}=require('../lib/node/harness/modules/git-command');
const {ProjectTools}=require('../lib/node/harness/project-tool-service');const {ToolRegistry}=require('../lib/node/harness/core/contracts');const {ToolPolicies}=require('../lib/node/harness/storage/tool-policies');const {TaskRuntime}=require('../lib/node/harness/core/runtime');const {SqliteStore}=require('../lib/node/harness/storage/sqlite-store');const {OutputSizeLimit}=require('../lib/node/harness/modules/file-tools');const {scriptedProvider}=require('./scripted-provider.cjs');const {runNative}=require('../lib/node/harness/modules/native-process');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));async function until(fn){for(let n=0;n<300;n++){if(fn())return;await sleep(20);}throw new Error('Timed out');}
async function fixture(t){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'governed-git-command-')));const root=path.join(base,'project');const repo=path.join(base,'repo');await fs.mkdir(path.join(root,'repositories'),{recursive:true});await fs.mkdir(repo);
 const git=args=>execFileSync('git',args,{cwd:repo,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},stdio:'pipe'}).toString();
 git(['init','-b','main']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.invalid']);await fs.writeFile(path.join(repo,'app.txt'),'original\n');git(['add','.']);git(['commit','-m','fixture']);git(['branch','feature']);await fs.symlink(repo,path.join(root,'repositories','back'),'dir');await fs.writeFile(path.join(root,'project.theia-workspace'),JSON.stringify({governedRepositories:[{id:'back',path:repo}]}));
 const context={projectPath:root,signal:new AbortController().signal};const tool=new GitCommand();const run=async arguments_=>{const args={repository:'back',arguments:arguments_};return JSON.parse(await tool.execute(args,await tool.prepare(args,context),context));};
 t.after(()=>fs.rm(base,{recursive:true,force:true}));return{base,root,repo,git,context,tool,run};
}
test('one Git tool lists, switches and rebases native Git without invoking checkout hooks',async t=>{
 const f=await fixture(t);assert.match((await f.run(['branch','--list'])).output,/feature/);
 await fs.writeFile(path.join(f.repo,'.git/hooks/post-checkout'),'#!/bin/sh\ntouch hook-must-not-run\n',{mode:0o700});
 const switched=await f.run(['switch','feature']);assert.equal(switched.exitCode,0);assert.equal(f.git(['branch','--show-current']).trim(),'feature');await assert.rejects(()=>fs.access(path.join(f.repo,'hook-must-not-run')));
 const rebased=await f.run(['rebase','main']);assert.equal(rebased.state,'passed');assert.equal(gitCategory(['rebase','main']),'local');
 const failed=await f.run(['switch','no-such-branch']);assert.equal(failed.state,'failed');assert.notEqual(failed.exitCode,0);
});
test('Git rejects boundary overrides, external programs, abbreviations, aliases, unsafe links and unregistered repositories',async t=>{
 const f=await fixture(t);
 for(const arguments_ of [['-C','/tmp','status'],['diff','--output=../outside'],['diff','--output=.git/config'],['rebase','--ex=touch nope'],['merge','-sevil'],['bisect','run','sh'],['grep','-Osh','value'],['log','--show-signature'],['config','--global','x','y'],['fetch','ext::sh command'],['commit','-S']])assert.throws(()=>gitArguments(arguments_),/Git|Arguments|handler|command/);
 f.git(['config','alias.bad','!touch alias-must-not-run']);await assert.rejects(()=>f.tool.prepare({repository:'back',arguments:['bad']},f.context),/Unknown Git/);await assert.rejects(()=>fs.access(path.join(f.repo,'alias-must-not-run')));
 await fs.symlink(f.base,path.join(f.repo,'outside'),'dir');await assert.rejects(()=>f.tool.prepare({repository:'back',arguments:['diff','--output=outside/escape.txt']},f.context),/link outside/);
 await assert.rejects(()=>f.tool.prepare({repository:'unknown',arguments:['status']},f.context),/not connected/);
 f.git(['config','filter.bad.process','touch filter-must-not-run']);await assert.rejects(()=>f.tool.prepare({repository:'back',arguments:['status']},f.context),/custom filters/);
});
test('dirty source cannot be switched or silently stashed; edits after review invalidate a command',async t=>{
 const f=await fixture(t);const args={repository:'back',arguments:['switch','feature']};const prepared=await f.tool.prepare(args,f.context);
 await fs.writeFile(path.join(f.repo,'app.txt'),'uncommitted');await assert.rejects(()=>f.tool.execute(args,prepared,f.context),/clean working tree/);assert.equal(f.git(['branch','--show-current']).trim(),'main');assert.equal(await fs.readFile(path.join(f.repo,'app.txt'),'utf8'),'uncommitted');
 const branch={repository:'back',arguments:['branch','another']};const reviewed=await f.tool.prepare(branch,f.context);await fs.writeFile(path.join(f.repo,'app.txt'),'different uncommitted contents');await assert.rejects(()=>f.tool.execute(branch,reviewed,f.context),/changed after review/);
});
test('runtime runs Git reads automatically and pauses a switch until its exact project-policy permission',async t=>{
 const f=await fixture(t);const tools=new ToolRegistry();tools.registerModule({id:'builtin.git',version:'1.0.0',register:r=>r.register(f.tool)});const policies=new ToolPolicies(tools);const manifests=new ProjectTools(tools,policies,path.join(f.base,'executions.sqlite'));t.after(async()=>{await manifests.onStop();manifests.close();});const store=new SqliteStore(path.join(f.base,'tasks.sqlite'));let turn=0;
 const provider=scriptedProvider({id:'fixture',respond:async()=>++turn===1?{text:'',calls:[{id:'status',tool:'git',args:{repository:'back',arguments:['status','--short']}}]}:turn===2?{text:'',calls:[{id:'switch',tool:'git',args:{repository:'back',arguments:['switch','feature']}}]}:{text:'done',calls:[]}});
 const runtime=new TaskRuntime(store,provider,tools,policies,new OutputSizeLimit());t.after(()=>{runtime.shutdown();store.close();});const task=runtime.create(f.root);runtime.send(task.id,'Switch branch','start');await until(()=>store.task(task.id).state==='awaiting_approval');assert.equal(turn,2);assert.equal(f.git(['branch','--show-current']).trim(),'main');const request=runtime.snapshot(task.id).interactions.find(i=>i.kind==='action_approval');assert.deepEqual(request.review.arguments,['switch','feature']);assert.equal(request.review.category,'local');
 await runtime.respondInteraction(request.id,{approved:true});await until(()=>store.task(task.id).state==='completed');assert.equal(f.git(['branch','--show-current']).trim(),'feature');assert.equal(runtime.snapshot(task.id).actions.length,2);
});
test('workflow branch binding cannot be bypassed by allowing a universal Git command',async t=>{
 const f=await fixture(t);const task={workflow:{branches:{back:{branch:'main',base:'main',head:f.git(['rev-parse','HEAD']).trim()}}}};
 const guard={store:{task:()=>task},branch:()=>task.workflow.branches.back};const tool=new GitCommand(guard);
 await assert.rejects(()=>tool.prepare({repository:'back',arguments:['switch','feature']},{...f.context,taskId:'bound-task'}),/bound to its approved feature branch/);
 await assert.rejects(()=>tool.prepare({repository:'back',arguments:['update-ref','refs/heads/main','HEAD']},{...f.context,taskId:'bound-task'}),/bound to its approved feature branch/);
});
test('native process adapter bounds output and supports timeout and cancellation',async()=>{
 const base={program:process.execPath,cwd:os.tmpdir(),environment:{PATH:process.env.PATH},outputLimit:1024,timeoutMs:2000};
 const output=await runNative({...base,arguments:['-e','console.log("x".repeat(4000));console.error("end")']},new AbortController().signal);assert.equal(output.state,'passed');assert.equal(output.truncated,true);assert.ok(output.output.length<=1024);
 const timeout=await runNative({...base,arguments:['-e','setInterval(()=>{},1000)'],timeoutMs:100},new AbortController().signal);assert.equal(timeout.state,'timed_out');
 const controller=new AbortController();const running=runNative({...base,arguments:['-e','setInterval(()=>{},1000)']},controller.signal);setTimeout(()=>controller.abort(),100);assert.equal((await running).state,'cancelled');
});
test('repository log signature settings cannot execute a configured signing program during an automatic read',async t=>{
 const f=await fixture(t);const sentinel=path.join(f.repo,'signer-must-not-run');const handler=path.join(f.repo,'.git/evil-signer');await fs.writeFile(handler,`#!/bin/sh\ntouch '${sentinel}'\nexit 1\n`,{mode:0o700});
 f.git(['config','gpg.program',handler]);f.git(['config','log.showSignature','true']);
 const tree=f.git(['rev-parse','HEAD^{tree}']).trim();const commit=`tree ${tree}\nparent ${f.git(['rev-parse','HEAD']).trim()}\nauthor Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n fake\n -----END PGP SIGNATURE-----\n\nfixture signature\n`;
 const object=execFileSync('git',['hash-object','-t','commit','-w','--stdin'],{cwd:f.repo,input:commit}).toString().trim();f.git(['update-ref','HEAD',object]);
 const result=await f.run(['log','-1']);assert.equal(result.state,'passed');await assert.rejects(()=>fs.access(sentinel));assert.throws(()=>gitArguments(['tag','--ver','HEAD']),/Arguments/);
});

test('restore --worktree restores an explicit file and retains repository boundary checks', async t => {
    const f = await fixture(t);
    const args = ['restore', '--worktree', '--', 'app.txt'];
    assert.deepEqual(gitArguments(args), args);
    assert.equal(gitCategory(args), 'destructive');
    for (const unsafe of [
        ['restore', '--work-tree=/tmp', '--', 'app.txt'],
        ['restore', '--git-dir=/tmp', '--', 'app.txt'],
        ['restore', '--worktree', '--', '../outside'],
        ['restore', '--worktree', '--', '.git/config']
    ]) assert.throws(() => gitArguments(unsafe), /Arguments/);
    await fs.writeFile(path.join(f.repo, 'app.txt'), 'unwanted change\n');
    const result = await f.run(args);
    assert.equal(result.state, 'passed');
    assert.equal(await fs.readFile(path.join(f.repo, 'app.txt'), 'utf8'), 'original\n');
});

test('pre-branch restore is scoped to the approved ChangeSet and rechecks source after review', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.repo, 'app.txt'), 'unwanted change\n');
    await fs.writeFile(path.join(f.repo, 'unrelated.txt'), 'keep this\n');
    const guard = {
        store: { task: () => ({ workflow: {} }) },
        branch: () => undefined,
        preparationScope: async () => [{ repository: 'back', paths: ['app.txt'] }]
    };
    const tool = new GitCommand(guard);
    const context = { ...f.context, taskId: 'preparation' };
    const args = { repository: 'back', arguments: ['restore', '--worktree', '--', 'app.txt'] };
    const prepared = await tool.prepare(args, context);
    await fs.writeFile(path.join(f.repo, 'app.txt'), 'new external change\n');
    await assert.rejects(() => tool.execute(args, prepared, context), /changed after review/);
    await assert.rejects(() => tool.prepare({ ...args, arguments: ['restore', '--worktree', '--', 'unrelated.txt'] }, context), /approved ChangeSet/);
    await assert.rejects(() => tool.prepare({ ...args, arguments: ['restore', '--staged', '--', 'app.txt'] }, context), /working-tree/);
    const result = JSON.parse(await tool.execute(args, await tool.prepare(args, context), context));
    assert.equal(result.state, 'passed');
    assert.equal(await fs.readFile(path.join(f.repo, 'app.txt'), 'utf8'), 'original\n');
    assert.equal(await fs.readFile(path.join(f.repo, 'unrelated.txt'), 'utf8'), 'keep this\n');
});

test('read-only Git commands keep their category across the path delimiter and diff flags', async t => {
    const f = await fixture(t);
    for (const arguments_ of [
        ['diff', 'main...HEAD', '--', 'app.txt'],
        ['diff', '-D', '-B', '--', 'app.txt'],
        ['log', '-1', '--', 'app.txt'],
        ['show', 'HEAD', '--', 'app.txt'],
        ['diff', '--', '--output']
    ]) assert.equal(gitCategory(gitArguments(arguments_)), 'read');
    assert.equal(gitCategory(gitArguments(['diff', '--output=report.txt', 'HEAD', '--', 'app.txt'])), 'local');
    assert.equal(gitCategory(gitArguments(['diff', '--out', 'report.txt'])), 'local');
    assert.equal(gitCategory(gitArguments(['add', '--', '-f'])), 'local');
    assert.equal(gitCategory(gitArguments(['branch', '--', 'new-branch'])), 'local');
    assert.throws(() => gitArguments(['diff', '--', '../outside']), /Arguments/);
    assert.throws(() => gitArguments(['diff', '--', '.git/config']), /Arguments/);
    const workflow = { store: { task: () => ({ workflow: { branches: {} } }) }, branch: () => undefined };
    const tool = new GitCommand(workflow);
    const context = { ...f.context, taskId: 'code-review' };
    await fs.writeFile(path.join(f.repo, 'app.txt'), 'reviewed change\n');
    f.git(['add', 'app.txt']);
    f.git(['commit', '-m', 'Change under review']);
    const args = { repository: 'back', arguments: ['diff', 'feature...HEAD', '--', 'app.txt'] };
    const prepared = await tool.prepare(args, context);
    assert.equal(prepared.target.category, 'read');
    const result = JSON.parse(await tool.execute(args, prepared, context));
    assert.equal(result.state, 'passed');
    assert.match(result.output, /reviewed change/);
    assert.equal(f.git(['status', '--porcelain']).trim(), '');
});

test('real Git output options cannot hide behind log formatting or merge flags',async t=>{
 const f=await fixture(t);
 for(const arguments_ of [['log','--pretty=oneline','--output=pretty.txt'],['log','--format=%s','--output=format.txt'],['log','-m','--output=merge.txt']]){
  const args={repository:'back',arguments:arguments_};
  assert.notEqual(f.tool.access.classify(args,{}),'read');
  const result=await f.run(arguments_);assert.equal(result.exitCode,0);
  const filename=arguments_.find(x=>x.startsWith('--output=')).slice('--output='.length);
  assert.equal(typeof await fs.readFile(path.join(f.repo,filename),'utf8'),'string');
 }
});

test('unknown Git flags are policy controlled even in read-only workflows; hard boundaries remain',async t=>{
 const {DefaultPolicy}=require('../lib/node/harness/core/tool-access');const f=await fixture(t);
 const workflow={store:{task:()=>({workflow:{branches:{}}})},branch:()=>undefined};const tool=new GitCommand(workflow);const context={...f.context,taskId:'review'};
 const args={repository:'back',arguments:['log','--no-walk=unsorted','HEAD']};
 const prepared=await tool.prepare(args,context);assert.deepEqual(prepared.target.operation.unrecognizedFlags,['--no-walk=unsorted']);
 const policy=new DefaultPolicy();assert.equal(policy.check({args,prepared},tool.access),'approve');
 for(const decision of ['allow','deny']){
  const access={...tool.access,categories:tool.access.categories.map(category=>category.id==='extra-flags'?{...category,defaultDecision:decision}:category)};
  assert.equal(policy.check({args,prepared},access),decision);
 }
 const result=JSON.parse(await tool.execute(args,prepared,context));assert.equal(result.exitCode,0);
 await assert.rejects(()=>tool.prepare({repository:'back',arguments:['diff','--output=../escape']},context),/Arguments/);
 await assert.rejects(()=>tool.prepare({repository:'back',arguments:['diff','--ext-diff']},context),/Arguments/);
 await assert.rejects(()=>tool.prepare({repository:'back',arguments:['log','--no-walk','--output=report']},context),/feature branch/);
 assert.equal(f.git(['status','--porcelain']).trim(),'');
});
