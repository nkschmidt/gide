require('reflect-metadata');
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const {execFileSync}=require('node:child_process');
const {ProjectTools}=require('../lib/node/harness/project-tool-service');const {ToolRegistry}=require('../lib/node/harness/core/contracts');const {ToolPolicies}=require('../lib/node/harness/storage/tool-policies');const {WorkflowEngine}=require('../lib/node/harness/core/workflow-engine');const {WorkflowToolScope}=require('../lib/node/harness/core/workflow-tool-scope');const {TaskRuntime}=require('../lib/node/harness/core/runtime');const {SqliteStore}=require('../lib/node/harness/storage/sqlite-store');const {ReadFilesExecutor,OutputSizeLimit}=require('../lib/node/harness/modules/file-tools');const {AskUserTool}=require('../lib/node/harness/modules/question-tool');const {GitCommand}=require('../lib/node/harness/modules/git-command');const {registerGitTools}=require('../lib/node/harness/modules/git-tools');const {registerWriteTools}=require('../lib/node/harness/modules/write-tools');const {registerWorkflowTools}=require('../lib/node/harness/workflows/workflow-tools');const {BuiltinFamilies}=require('../lib/node/harness/core/tool-families');const {scriptedProvider}=require('./scripted-provider.cjs');
const call=(tool,method,args={})=>({text:'',calls:[{id:crypto.randomUUID(),tool,args:{call:{method,arguments:args}}}]});const sleep=ms=>new Promise(r=>setTimeout(r,ms));async function until(fn){for(let n=0;n<300;n++){if(fn())return;await sleep(20);}throw new Error('Timed out');}
async function fixture(t,respond){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'governed-methods-')));const project=path.join(root,'project'),repo=path.join(root,'repo');await fs.mkdir(path.join(project,'repositories'),{recursive:true});await fs.mkdir(repo);await fs.writeFile(path.join(repo,'app.ts'),'export const value=1;\n');
 const git=args=>execFileSync('git',args,{cwd:repo,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},stdio:'pipe'}).toString();git(['init','-b','main']);git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']);await fs.symlink(repo,path.join(project,'repositories/back'),'dir');await fs.writeFile(path.join(project,'project.theia-workspace'),JSON.stringify({folders:[{path:'.'}],governedRepositories:[{id:'back',path:repo}]}));
 const registry=new ToolRegistry(),policies=new ToolPolicies(registry),tools=new ProjectTools(registry,policies,path.join(root,'executions.sqlite')),store=new SqliteStore(path.join(root,'tasks.sqlite'));
 const definition={id:'custom',name:'Fixture workflow',revision:1,steps:[{id:'prepare',title:'Prepare',instructions:'Prepare the agreed branch.',definitionOfReady:[],definitionOfDone:[],tools:['builtin.git#status','builtin.git#prepare_branch'],approval:false,enabled:true}]};const definitions={get:async()=>definition,list:async()=>[{id:'custom',name:definition.name,description:'A fixture process.',stepCount:1,updatedAt:1}]};const engine=new WorkflowEngine(store,definitions,registry);
 registry.registerModule({id:'builtin.workflow',version:'1.0.0',register:r=>{engine.register(r);registerWorkflowTools(r,definitions,store);}});registry.registerModule({id:'builtin.files',version:'1.0.0',register:r=>{r.register(new ReadFilesExecutor());r.register(new (require('../lib/node/harness/modules/repository-tools').SearchRepositoryExecutor)());}});registry.registerModule({id:'builtin.questions',version:'1.0.0',register:r=>r.register(new AskUserTool())});registry.registerModule({id:'builtin.git',version:'1.0.0',register:r=>{registerGitTools(r,engine);r.register(new GitCommand(engine));}});registry.registerModule({id:'builtin.changes',version:'1.0.0',register:r=>registerWriteTools(r,engine)});
 for(const family of BuiltinFamilies.filter(f=>['git','github','files','changesets','workflow'].includes(f.id)))registry.registerFamily(family);
 const runtime=new TaskRuntime(store,scriptedProvider({id:'fixture',respond:respond||(async()=>({text:'done',calls:[]}))}),registry,policies,new OutputSizeLimit(),undefined,engine);const task=runtime.create(project);await runtime.setWorkflow(task.id,'chat');
 t.after(async()=>{runtime.shutdown();await tools.onStop();tools.close();store.close();await fs.rm(root,{recursive:true,force:true});});return{root,project,repo,git,registry,policies,tools,store,engine,definition,runtime,task};
}
test('Git, Files and ChangeSets expose one callable function per family; method policies share one manifest',async t=>{
 const f=await fixture(t);const catalog=await f.tools.list(f.project);assert.deepEqual(catalog.errors,[]);assert.deepEqual(catalog.tools.map(x=>x.tool.id).sort(),['builtin.ask_user','builtin.changesets','builtin.files','builtin.git','builtin.github','builtin.workflow']);await f.registry.refreshProject(f.project);assert.throws(()=>f.registry.get('git_status',f.project),/not available/);const git=catalog.tools.find(x=>x.tool.id==='builtin.git');assert.deepEqual(git.methods.map(m=>m.id),['status','diff','prepare_branch','command','commit_changeset','pull_request']);assert.equal(git.tool.policy['status--registered-git-read'],'allow');assert.equal(git.tool.policy['command--network'],'ask');assert.equal(git.tool.implementation.configuration.methods.length,6);await assert.rejects(()=>fs.access(path.join(f.project,'tools/builtin.git_status.json')));assert.throws(()=>f.registry.call('git',{call:{method:'constructor',arguments:{}}},f.project),/not available/);
 const schema=f.registry.get('git',f.project).definition.parameters;assert.equal(schema.properties.call.anyOf.length,6);assert.ok(schema.properties.call.anyOf[0].description);assert.deepEqual(schema.required,['call']);
});
test('workflow sends only selected methods plus workflow support, and method-level Deny removes a method',async t=>{
 const f=await fixture(t);await f.tools.list(f.project);await f.registry.refreshProject(f.project);await f.engine.select(f.task.id,'custom');const context={projectPath:f.project,taskId:f.task.id,signal:new AbortController().signal,purpose:'chat'};const scope=new WorkflowToolScope(f.registry);let entries=scope.entries(f.store.task(f.task.id),context);assert.deepEqual(Object.keys(entries.find(x=>x.executor.definition.name==='git').executor.methods),['status','prepare_branch']);assert.deepEqual(Object.keys(entries.find(x=>x.executor.definition.name==='workflow').executor.methods),['ready','report','revise']);assert.throws(()=>scope.assert('git',f.store.task(f.task.id),context,'command'),/not enabled/);
 const saved=await f.tools.get(f.project,'builtin.git');await f.tools.save(f.project,{...saved.tool,policy:{...saved.tool.policy,'status--registered-git-read':'deny'}},saved.revision);entries=scope.entries(f.store.task(f.task.id),context);assert.deepEqual(Object.keys(entries.find(x=>x.executor.definition.name==='git').executor.methods),['prepare_branch']);assert.throws(()=>scope.assert('git',f.store.task(f.task.id),context,'status'),/not enabled/);
});
test('grouped status/diff return structured results and grouped file reads retain canonical evidence',async t=>{
 let turn=0;let state;let diff;const f=await fixture(t,async messages=>{if(++turn===1)return call('git','status',{repository:'back'});if(turn===2){state=JSON.parse(messages.filter(m=>m.role==='tool').at(-1).text);return call('git','diff',{repository:'back',path:''});}if(turn===3){diff=JSON.parse(messages.filter(m=>m.role==='tool').at(-1).text);return call('files','read',{paths:['repositories/back/app.ts']});}return{text:'done',calls:[]};});f.runtime.send(f.task.id,'Inspect','one');await until(()=>f.store.task(f.task.id).state==='completed');assert.equal(state.branch,'main');assert.ok(Array.isArray(diff.files));const actions=f.runtime.snapshot(f.task.id).actions;assert.deepEqual(actions.map(a=>[a.tool,a.method,a.handlerTool]),[['git','status','git_status'],['git','diff','git_diff'],['files','read','files_read']]);assert.equal(actions[2].result,undefined);assert.equal(actions[2].readFiles[0].path,'repositories/back/app.ts');
});
test('grouped branch preparation still enforces Ready and approved ChangeSet and records the task branch across modules',async t=>{
 const f=await fixture(t);await f.tools.list(f.project);await f.registry.refreshProject(f.project);await f.engine.select(f.task.id,'custom');f.engine.start(f.task.id);const context={projectPath:f.project,taskId:f.task.id,signal:new AbortController().signal,purpose:'chat'};const status=f.registry.registration('git',f.project,'status').executor;const state=JSON.parse(await status.execute({repository:'back'},await status.prepare({repository:'back'},context),context));const branch=f.registry.registration('git',f.project,'prepare_branch').executor;const args={repository:'back',baseBranch:'main',branch:'feature/grouped',expectedHead:state.head,expectedState:state.fingerprint};await assert.rejects(()=>branch.prepare(args,context),/ready workflow step/);f.engine.ready({criteria:[]},context);await assert.rejects(()=>branch.prepare(args,context),/approved ChangeSet scope/);
 const plan=await f.engine.documents.write(f.project,'plan.md','Change only app.ts.',[{repository:'back',paths:['app.ts'],baseBranch:'main'}],null);const task=f.store.task(f.task.id);task.workflow.steps.unshift({id:'plan',title:'Plan',instructions:'Approved plan.',tools:[],definitionOfReady:[],definitionOfDone:[],approval:true,enabled:true,dependsOn:[]});task.workflow.index++;task.workflow.results.push({stepId:'plan',revision:1,summary:'Approved plan',ready:[],done:[],artifacts:[{path:plan.path,digest:plan.digest}],approvedAt:1});f.store.putTask(task);await branch.execute(args,await branch.prepare(args,context),context);assert.equal(f.git(['branch','--show-current']).trim(),'feature/grouped');assert.equal(f.store.task(f.task.id).workflow.branches.back.branch,'feature/grouped');
});
test('one custom tool can mix native commands and installed handlers with separate method approval and durable execution',async t=>{
 let turn=0;let result;const f=await fixture(t,async messages=>++turn===1?call('project_mixed','version',{repository:'back'}):(result=JSON.parse(messages.filter(m=>m.role==='tool').at(-1).text),{text:'done',calls:[]}));const tool={schemaVersion:2,id:'mixed',toolName:'project_mixed',name:'Mixed tool',description:'Commands and installed handlers.',implementation:{executor:'methods',configuration:{methods:[{id:'version',name:'Node version',description:'Report Node version.',implementation:{executor:'local-process',configuration:{directory:'.',program:process.execPath,arguments:['--version'],environment:'local',timeoutSeconds:10,outputLimit:1024}}},{id:'status',name:'Status',description:'Inspect current Git state.',implementation:{executor:'handler',configuration:{handler:'builtin.git/git_status',version:'1',settings:{}}}}]}},policy:{'version--execute':'ask','status--registered-git-read':'allow'}};await f.tools.save(f.project,tool,null);f.runtime.send(f.task.id,'Run version','one');await until(()=>f.store.task(f.task.id).state==='awaiting_approval');const pending=f.runtime.snapshot(f.task.id).interactions.find(x=>x.kind==='action_approval');assert.equal(pending.review.method,'version');assert.deepEqual(await f.tools.jobs(f.project),[]);await f.runtime.respondInteraction(pending.id,{approved:true});await until(()=>f.store.task(f.task.id).state==='completed');assert.equal(result.state,'passed');assert.match(result.output,/v\d+\./);assert.equal((await f.tools.jobs(f.project))[0].method,'version');
});
test('Tools.propose pauses the grouped method, saves one definition, then exposes the new family in the same run',async t=>{
 const {registerProjectToolManagement}=require('../lib/node/harness/project-tool-service');let turn=0;let outcome;const proposal={schemaVersion:2,id:'inspect',toolName:'project_inspect',name:'Inspect',description:'Read registered repository files.',implementation:{executor:'methods',configuration:{methods:[{id:'read',name:'Read',description:'Read a batch of files.',implementation:{executor:'handler',configuration:{handler:'builtin.files/files_read',version:'1',settings:{}}}}]}},policy:{'read--registered-repository':'allow','read--project':'ask'}};
 const f=await fixture(t,async(messages,definitions)=>{if(++turn===1)return call('tools','propose',{tool:JSON.stringify(proposal),expectedRevision:null});if(turn===2){const result=JSON.parse(messages.filter(m=>m.role==='tool').at(-1).text);assert.equal(result.executed,false);assert.ok(definitions.some(x=>x.name==='project_inspect'));return call(result.functionName,'read',{paths:['repositories/back/app.ts']});}outcome=JSON.parse(messages.filter(m=>m.role==='tool').at(-1).text);return{text:'done',calls:[]};});
 f.registry.registerModule({id:'builtin.tools',version:'1.0.0',register:r=>registerProjectToolManagement(r,f.tools)});f.registry.registerFamily(BuiltinFamilies.find(x=>x.id==='tools'));f.runtime.send(f.task.id,'Propose','one');await until(()=>f.store.task(f.task.id).state==='waiting_input');const pending=f.runtime.snapshot(f.task.id).interactions.find(x=>x.kind==='tool_proposal');assert.equal(pending.tool.id,'inspect');assert.equal(f.runtime.snapshot(f.task.id).actions[0].method,'propose');await f.runtime.respondInteraction(pending.id,{save:true,tool:proposal});await until(()=>f.store.task(f.task.id).state==='completed');assert.equal(outcome.files[0].content,'export const value=1;\n');assert.equal(f.store.runs(f.task.id).length,1);
});

test('grouped routing exposes only choice methods, and an alternate user choice starts the actual workflow',async t=>{
 let turn=0;
 const f=await fixture(t,async(_messages,definitions)=>{
  if(++turn===1){
   assert.deepEqual(definitions.map(item=>item.name).sort(),['ask_user','workflow']);
   assert.deepEqual(definitions.find(item=>item.name==='workflow').parameters.properties.call.anyOf.map(branch=>branch.properties.method.enum[0]),['route']);
   return call('workflow','route',{id:'chat',reason:'This may be a discussion.'});
  }
  if(turn===2)return call('workflow','ready',{criteria:[]});
  return call('workflow','report',{status:'completed',summary:'Finished the selected process.',criteria:[],artifacts:[]});
 });
 await f.runtime.setWorkflow(f.task.id,'auto');
 await f.registry.refreshProject(f.project);
 const context={projectPath:f.project,taskId:f.task.id,signal:new AbortController().signal,purpose:'chat'};
 assert.throws(()=>new WorkflowToolScope(f.registry).assert('git',f.store.task(f.task.id),context,'status'),/not enabled/);
 f.runtime.send(f.task.id,'Please consider this task','start');await until(()=>f.store.task(f.task.id).state==='waiting_input');
 const request=f.runtime.snapshot(f.task.id).interactions[0];assert.equal(request.recommendedId,'chat');assert.equal(f.store.task(f.task.id).workflow,undefined);
 await f.runtime.respondInteraction(request.id,{optionId:'custom'});await until(()=>f.store.task(f.task.id).state==='completed');
 assert.equal(f.store.task(f.task.id).workflow.id,'custom');assert.equal(f.store.task(f.task.id).workflow.phase,'completed');assert.equal(f.store.runs(f.task.id).length,1);
 assert.deepEqual(f.runtime.snapshot(f.task.id).actions.map(action=>[action.tool,action.method]),[['workflow','route'],['workflow','ready'],['workflow','report']]);
});

test('explicit step tool approval enables notes in the same run without changing the plan, policies or workflow definition',async t=>{
 let turn=0;let digest;let noteResult;
 const f=await fixture(t,async(messages,definitions)=>{
  if(++turn===1)return call('workflow','request_tools',{tools:['builtin.changesets#notes'],reason:'Record actual branch preparation in the approved ChangeSet.'});
  if(turn===2){
   const access=JSON.parse(messages.filter(m=>m.role==='tool').at(-1).text);assert.equal(access.approved,true);
   const methods=definitions.find(item=>item.name==='changesets').parameters.properties.call.anyOf.map(branch=>branch.properties.method.enum[0]);assert.ok(methods.includes('notes'));
   assert.equal(f.store.task(f.task.id).workflow.ready,undefined);
   return call('workflow','ready',{criteria:[]});
  }
  if(turn===3)return call('changesets','read',{name:'plan.md'});
  if(turn===4){digest=JSON.parse(messages.filter(m=>m.role==='tool').at(-1).text).digest;return call('changesets','notes',{name:'plan.md',notes:'The task feature branch was prepared. Implementation has not started.',expectedDigest:digest});}
  noteResult=JSON.parse(messages.filter(m=>m.role==='tool').at(-1).text);return call('workflow','report',{status:'completed',summary:'Actual branch state recorded.',criteria:[],artifacts:[]});
 });
 f.definition.steps[0].tools.push('builtin.changesets#read');await f.runtime.setWorkflow(f.task.id,'custom');
 const plan=await f.engine.documents.write(f.project,'plan.md','Approved scoped plan.',[{repository:'back',paths:['app.ts'],baseBranch:'main'}],null);
 const task=f.store.task(f.task.id);task.workflow.steps.unshift({id:'plan',title:'Plan',instructions:'Approved plan.',tools:[],definitionOfReady:[],definitionOfDone:[],approval:true,enabled:true,dependsOn:[]});task.workflow.index++;task.workflow.results.push({stepId:'plan',revision:1,summary:'Approved',ready:[],done:[],artifacts:[{path:plan.path,digest:plan.digest}],approvedAt:1});f.store.putTask(task);
 f.runtime.send(f.task.id,'Record branch preparation','access');await until(()=>f.store.task(f.task.id).state==='waiting_input');
 const pending=f.runtime.snapshot(f.task.id).interactions.find(item=>item.kind==='workflow_tools');assert.deepEqual(pending.toolAccess.tools.map(item=>item.id),['builtin.changesets#notes']);assert.ok(!f.store.task(f.task.id).workflow.steps[0].tools.includes('builtin.changesets#notes'));
 assert.throws(()=>f.runtime.send(f.task.id,'Enable it','plain'),/Review the requested/);
 const manifest=await f.tools.get(f.project,'builtin.changesets');
 await f.runtime.respondInteraction(pending.id,{approved:true});await until(()=>f.store.task(f.task.id).state==='completed');
 assert.equal(f.store.runs(f.task.id).length,1);assert.equal((await f.tools.get(f.project,'builtin.changesets')).revision,manifest.revision);assert.ok(!f.definition.steps[0].tools.includes('builtin.changesets#notes'));
 const final=await f.engine.documents.read(f.project,'plan.md');assert.equal(final.planDigest,plan.digest);assert.match(final.executionNotes,/feature branch was prepared/);assert.equal(noteResult.planDigest,plan.digest);
 assert.equal(f.git(['branch','--show-current']).trim(),'main');
 await f.runtime.respondInteraction(pending.id,{approved:true});assert.equal(turn,5);
});

test('step tool reviews reject changed methods, and denial or cancellation never grant access',async t=>{
 const f=await fixture(t,async()=>call('workflow','request_tools',{tools:['builtin.changesets#notes'],reason:'Save execution notes.'}));await f.runtime.setWorkflow(f.task.id,'custom');f.runtime.send(f.task.id,'Request access','one');await until(()=>f.store.task(f.task.id).state==='waiting_input');
 const pending=f.runtime.snapshot(f.task.id).interactions[0];const saved=await f.tools.get(f.project,'builtin.changesets');await f.tools.save(f.project,{...saved.tool,policy:{...saved.tool.policy,'notes--workflow-changeset':'deny'}},saved.revision);
 await assert.rejects(()=>f.runtime.respondInteraction(pending.id,{approved:true}),/unavailable or denied|changed/);
 assert.ok(!f.store.task(f.task.id).workflow.steps[0].tools.includes('builtin.changesets#notes'));
 f.runtime.cancel(f.task.id);await assert.rejects(()=>f.runtime.respondInteraction(pending.id,{approved:true}),/no longer/);assert.equal(f.store.interaction(pending.id).state,'cancelled');
 const task=f.runtime.create(f.project);await f.runtime.setWorkflow(task.id,'custom');
 await f.tools.save(f.project,saved.tool,(await f.tools.get(f.project,'builtin.changesets')).revision);
 let requests=0;f.runtime.model.respond=async()=>{if(++requests===1)return {...call('workflow','request_tools',{tools:['builtin.changesets#notes'],reason:'Save execution notes.'}),outcome:'actions'};return {...call('workflow','report',{status:'blocked',summary:'Required note access was declined.',criteria:[],artifacts:[]}),outcome:'actions'};};
 f.runtime.send(task.id,'Request access','two');await until(()=>f.store.task(task.id).state==='waiting_input');const denied=f.runtime.snapshot(task.id).interactions[0];await f.runtime.respondInteraction(denied.id,{approved:false});await until(()=>f.store.task(task.id).state==='blocked');assert.ok(!f.store.task(task.id).workflow.steps[0].tools.includes('builtin.changesets#notes'));
});

test('built-in definitions follow installed metadata while preserving policy decisions',async t=>{
 const f=await fixture(t);await f.tools.list(f.project);
 const file=path.join(f.project,'tools/builtin.workflow.json'),catalogFile=path.join(f.project,'tools/.catalog.json');
 const saved=JSON.parse(await fs.readFile(file,'utf8'));saved.description='My project workflow controls.';saved.policy['report--workflow-control']='ask';
 saved.implementation.configuration.methods=saved.implementation.configuration.methods.filter(method=>method.id!=='request_tools');delete saved.policy['request_tools--workflow-control'];
 const catalog=JSON.parse(await fs.readFile(catalogFile,'utf8'));catalog['builtin.workflow']=catalog['builtin.workflow'].filter(key=>!key.startsWith('request_tools--'));
 await fs.writeFile(file,JSON.stringify(saved));await fs.writeFile(catalogFile,JSON.stringify(catalog));
 const result=await f.tools.list(f.project);assert.deepEqual(result.unavailable,[]);const upgraded=result.tools.find(item=>item.tool.id==='builtin.workflow').tool;
 assert.equal(upgraded.description,f.tools.repository.builtin('builtin.workflow').tool.description);assert.equal(upgraded.policy['report--workflow-control'],'ask');assert.equal(upgraded.policy['request_tools--workflow-control'],'allow');assert.equal(upgraded.implementation.configuration.methods.filter(method=>method.id==='request_tools').length,1);
 await f.tools.list(f.project);assert.equal((await f.tools.get(f.project,'builtin.workflow')).tool.implementation.configuration.methods.length,6);
});


test('built-in tools reject definition edits and accept access rule changes', async t => {
 const f = await fixture(t);
 await f.tools.list(f.project);
 for (const id of ['builtin.ask_user', 'builtin.git']) {
  const saved = await f.tools.get(f.project, id);
  for (const field of ['name', 'description']) {
   await assert.rejects(() => f.tools.save(f.project, { ...saved.tool, [field]: 'Edited' }, saved.revision), /Only access rules/);
  }
  if (saved.tool.implementation.executor === 'methods') {
   const edited = structuredClone(saved.tool);
   edited.implementation.configuration.methods[0].name = 'Edited method';
   await assert.rejects(() => f.tools.save(f.project, edited, saved.revision), /Only access rules/);
  }
  const [rule] = Object.keys(saved.tool.policy);
  const updated = await f.tools.save(f.project, { ...saved.tool, policy: { ...saved.tool.policy, [rule]: 'deny' } }, saved.revision);
  assert.equal(updated.tool.policy[rule], 'deny');
 }
});
