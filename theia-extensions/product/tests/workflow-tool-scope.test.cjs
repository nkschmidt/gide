require('reflect-metadata');
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {ToolRegistry}=require('../lib/node/harness/core/contracts');const {WorkflowToolScope}=require('../lib/node/harness/core/workflow-tool-scope');const {WorkflowEngine}=require('../lib/node/harness/core/workflow-engine');const {WorkflowRepository}=require('../lib/node/harness/workflows/workflow-repository');const {TaskRuntime}=require('../lib/node/harness/core/runtime');const {SqliteStore}=require('../lib/node/harness/storage/sqlite-store');const {AskUserTool}=require('../lib/node/harness/modules/question-tool');const {DefaultPolicy,scopeAccess}=require('../lib/node/harness/core/tool-access');const {OutputSizeLimit}=require('../lib/node/harness/modules/file-tools');const {scriptedProvider}=require('./scripted-provider.cjs');const {workflowIssues}=require('../lib/common/workflow-service');
const step=(id,tools)=>({id,title:id,instructions:'Perform the bounded step.',tools,definitionOfReady:[],definitionOfDone:[],approval:false,enabled:true});const report={status:'completed',summary:'Done.',criteria:[],artifacts:[]};const call=(tool,args={})=>({text:'',calls:[{id:crypto.randomUUID(),tool,args}]});
async function until(fn){for(let n=0;n<300;n++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('Timed out');}
async function fixture(t,steps,respond,count=3,ask=false){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'governed-step-tools-')));await fs.writeFile(path.join(root,'project.theia-workspace'),'{}');const store=new SqliteStore(path.join(root,'tasks.sqlite'));const registry=new ToolRegistry();registry.register(new AskUserTool());const executed=[];
 for(let n=0;n<count;n++)registry.register({access:scopeAccess({read:ask?'ask':'allow'}),definition:{name:`tool_${n}`,description:'Fixture capability.',parameters:{type:'object',properties:{},required:[],additionalProperties:false}},prepare:async()=>({scope:'read'}),execute:async()=>{executed.push(n);return 'result '+n;}});
 const definitions={get:async()=>({id:'custom',name:'Fixture',revision:1,steps}),list:async()=>[]};const engine=new WorkflowEngine(store,definitions,registry);engine.register(registry);const runtime=new TaskRuntime(store,scriptedProvider({id:'fixture',respond:async(...args)=>!store.task(task.id).workflow.ready ? call('workflow_ready',{criteria:[]}) : respond(...args)}),registry,new DefaultPolicy(),new OutputSizeLimit(),undefined,engine);const task=runtime.create(root);await engine.select(task.id,'custom');t.after(()=>{runtime.shutdown();store.close();return fs.rm(root,{recursive:true,force:true});});return{root,store,registry,runtime,engine,task,executed};
}
test('a thousand registered tools yield only the selected schemas plus support; guessed excluded calls never execute',async t=>{
 let turn=0;let denied;const f=await fixture(t,[step('research',['tool_1'])],async(messages,tools)=>{
  assert.deepEqual(tools.map(x=>x.name).sort(),['ask_user','tool_1','workflow_ready','workflow_report','workflow_revise','workflow_request_tools'].sort());
  if(++turn===1)return call('tool_2');if(turn===2){denied=messages.filter(m=>m.role==='tool').at(-1).text;return call('tool_1');}return call('workflow_report',report);
 },1000);f.runtime.send(f.task.id,'Start','one');await until(()=>f.store.task(f.task.id).state==='completed');assert.deepEqual(f.executed,[1]);assert.match(denied,/not enabled for the current workflow step/);
});
test('step transition replaces the schema set and revokes access to tools from the preceding step',async t=>{
 let turn=0;let denied;const f=await fixture(t,[step('first',['tool_1']),step('second',['tool_2'])],async(messages,tools)=>{
  const names=tools.map(x=>x.name);const current=++turn;
  if(current<=2){assert.ok(names.includes('tool_1'));assert.ok(!names.includes('tool_2'));return current===1?call('tool_1'):call('workflow_report',report);}
  assert.ok(names.includes('tool_2'));assert.ok(!names.includes('tool_1'));if(current===3)return call('tool_1');if(current===4){denied=messages.filter(m=>m.role==='tool').at(-1).text;return call('tool_2');}return call('workflow_report',report);
 });f.runtime.send(f.task.id,'Start','one');await until(()=>f.store.task(f.task.id).state==='completed');assert.deepEqual(f.executed,[1,2]);assert.match(denied,/not enabled/);
});
test('an approved action is checked against the current step again before execution',async t=>{
 let turn=0;const f=await fixture(t,[step('first',['tool_1']),step('second',[])],async()=>++turn===1?call('tool_1'):call('workflow_report',report),3,true);f.runtime.send(f.task.id,'Start','one');await until(()=>f.store.task(f.task.id).state==='awaiting_approval');const pending=f.runtime.snapshot(f.task.id).interactions.find(x=>x.kind==='action_approval');const task=f.store.task(f.task.id);task.workflow.results.push({stepId:'first',revision:task.workflow.revision,summary:'First finished externally in this fixture.',ready:[],done:[],artifacts:[],inputs:{}});task.workflow.index=1;task.workflow.ready=undefined;f.store.putTask(task);await f.runtime.respondInteraction(pending.id,{approved:true});await until(()=>f.store.task(f.task.id).state==='completed');assert.deepEqual(f.executed,[]);assert.equal(f.runtime.snapshot(f.task.id).actions.find(action=>action.tool==='tool_1').state,'failed');
});
test('explicit empty selection keeps only support, while non-workflow chat stays unchanged and aliases require their own manifest ID',()=>{
 const registry=new ToolRegistry();const executor={definition:{name:'renamed_function',description:'Fixture',parameters:{}},prepare:async()=>({}),execute:async()=>''};registry.setProjectLoader(async()=>[]);registry.projects.set('/project',[{executor,manifestId:'stable-id',access:scopeAccess({read:'allow'}),module:'sample',version:'1.0.0'}]);const scope=new WorkflowToolScope(registry);const context={projectPath:'/project'};
 assert.equal(scope.entries({},context).length,1);assert.equal(scope.entries({workflow:{id:'custom',index:0,steps:[step('one',[])]}},context).length,0);assert.equal(scope.entries({workflow:{id:'custom',index:0,steps:[step('one',['stable-id'])]}},context)[0].executor.definition.name,'renamed_function');assert.equal(scope.entries({workflow:{id:'custom',index:0,steps:[step('one',['renamed_function'])]}},context).length,0);
});
test('selected handler capabilities replace duplicate step permissions while Ready and approved scope stay required',async t=>{
 const f=await fixture(t,[step('edit',['tool_1'])],async()=>call('workflow_report',report));
 f.registry.get('tool_1').workflowOperations=['memory-update','repository-edit'];f.engine.start(f.task.id);
 const context={projectPath:f.root,taskId:f.task.id,signal:new AbortController().signal,purpose:'chat'};
 await assert.rejects(()=>f.engine.authorize(context,'memory-update'),/ready workflow step/);
 await f.engine.ready({criteria:[]},context);assert.deepEqual(await f.engine.authorize(context,'memory-update'),[]);
 await assert.rejects(()=>f.engine.authorize(context,'repository-edit','back','app.ts'),/approved ChangeSet scope/);
 const task=f.store.task(f.task.id);assert.equal(task.workflow.steps[0].operations,undefined);task.workflow.steps[0].tools=[];f.store.putTask(task);
 await assert.rejects(()=>f.engine.authorize(context,'memory-update'),/not enabled/);
});

test('an approval cannot move to another step even when the same tool remains selected',async t=>{
 let turn=0;const f=await fixture(t,[step('first',['tool_1']),step('second',['tool_1'])],async()=>++turn===1?call('tool_1'):call('workflow_report',report),3,true);
 f.runtime.send(f.task.id,'Start','one');await until(()=>f.store.task(f.task.id).state==='awaiting_approval');const request=f.runtime.snapshot(f.task.id).interactions.find(x=>x.kind==='action_approval');const task=f.store.task(f.task.id);
 task.workflow.results.push({stepId:'first',revision:task.workflow.revision,summary:'First result.',ready:[],done:[],artifacts:[],inputs:{}});task.workflow.index=1;task.workflow.revision++;task.workflow.ready=undefined;f.store.putTask(task);
 await f.runtime.respondInteraction(request.id,{approved:true});await until(()=>f.store.task(f.task.id).state==='completed');assert.deepEqual(f.executed,[]);assert.match(f.runtime.snapshot(f.task.id).actions.find(action=>action.tool==='tool_1').error,/workflow step or version changed/);
});
