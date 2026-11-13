require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ToolRegistry } = require('../lib/node/harness/core/contracts');
const { ProjectTools } = require('../lib/node/harness/project-tool-service');
const { ToolPolicies } = require('../lib/node/harness/storage/tool-policies');
const { TaskRuntime } = require('../lib/node/harness/core/runtime');
const { OutputSizeLimit } = require('../lib/node/harness/modules/file-tools');
const { SqliteStore } = require('../lib/node/harness/storage/sqlite-store');
const { scriptedProvider } = require('./scripted-provider.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let n=0;n<300;n++) { if (fn()) return; await sleep(20); } throw new Error('Timed out'); }
function tool(name='sample_tool', access) { return { definition: { name, description: 'Fixture tool', parameters: { type:'object',properties:{},required:[],additionalProperties:false } }, access, prepare: async () => ({}), execute: async () => 'fixture result' }; }
async function fixture(t, item=tool()) {
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'governed-policy-'))); await fs.writeFile(path.join(root,'project.theia-workspace'),'{}');
 const tools=new ToolRegistry(); tools.registerModule({id:'sample.module',version:'1.0.0',register:r=>r.register(item)}); const policies=new ToolPolicies(tools);const manifests=new ProjectTools(tools,policies,path.join(root,'executions.sqlite'));t.after(async()=>{await manifests.onStop();manifests.close();});
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 return {root,tools,policies,manifests,file:path.join(root,'tools','builtin.'+item.definition.name+'.json'),context:{projectPath:root,signal:new AbortController().signal},action:{tool:item.definition.name,args:{},prepared:{}}};
}
test('registered module automatically gets a project policy; direct edits apply and defaults never overwrite choices', async t=>{
 const f=await fixture(t);let view=(await f.policies.list(f.root))[0];assert.equal(view.module,'sample.module');assert.equal(view.document.categories.execute,'ask');
 view=await f.policies.save(f.root,'sample_tool',{...view.document,categories:{execute:'allow'}},view.revision);
 assert.equal((await f.policies.evaluate(f.action,f.tools.registration('sample_tool').access,f.context)).decision,'allow');
 await assert.rejects(()=>f.policies.save(f.root,'sample_tool',view.document,'old-revision'),/changed/);
 await fs.writeFile(f.file,JSON.stringify({...JSON.parse(await fs.readFile(f.file,'utf8')),policy:{execute:'deny'}}));await f.policies.initialize(f.root);
 assert.equal((await f.policies.evaluate(f.action,f.tools.registration('sample_tool').access,f.context)).decision,'deny');
 f.tools.registerModule({id:'another.module',version:'1.0.0',register:r=>r.register(tool('new_tool'))});
 assert.equal((await f.policies.list(f.root)).length,2);assert.equal(JSON.parse(await fs.readFile(f.file,'utf8')).policy.execute,'deny');
});
test('missing, malformed and incomplete known policies fail closed without silent repair',async t=>{
 const f=await fixture(t);await f.policies.initialize(f.root);const text=await fs.readFile(f.file,'utf8');await fs.unlink(f.file);await f.policies.initialize(f.root);
 await assert.rejects(()=>fs.access(f.file));await assert.rejects(()=>f.policies.evaluate(f.action,f.tools.registration('sample_tool').access,f.context),/not available|missing/);
 await fs.writeFile(f.file,'{');assert.ok((await f.manifests.list(f.root)).unavailable.length);assert.equal(await fs.readFile(f.file,'utf8'),'{');
 await fs.writeFile(f.file,JSON.stringify({...JSON.parse(text),policy:{}}));await assert.rejects(()=>f.policies.evaluate(f.action,f.tools.registration('sample_tool').access,f.context),/Policy blocked/);
 await fs.writeFile(f.file,text);await fs.writeFile(path.join(f.root,'tools/.catalog.json'),'{');await assert.rejects(()=>f.policies.evaluate(f.action,f.tools.registration('sample_tool').access,f.context),/Policy blocked/);
});
test('module upgrades append new categories and preserve project overrides',async t=>{
 const f=await fixture(t);const previous=(await f.policies.list(f.root))[0];await f.policies.save(f.root,'sample_tool',{...previous.document,categories:{execute:'allow'}},previous.revision);
 const tools=new ToolRegistry();tools.registerModule({id:'sample.module',version:'1.1.0',register:r=>r.register(tool('sample_tool',{categories:[{id:'execute',label:'Execute',defaultDecision:'deny'},{id:'network',label:'Network',defaultDecision:'ask'}],classify:()=> 'execute'}))});
 const policies=new ToolPolicies(tools);const manifests=new ProjectTools(tools,policies,path.join(f.root,'upgrade.sqlite'));t.after(async()=>{await manifests.onStop();manifests.close();});const upgraded=(await policies.list(f.root))[0];assert.deepEqual(upgraded.document.categories,{execute:'allow',network:'ask'});
});
test('module registration is atomic and rejects conflicts and duplicate category IDs',()=>{
 const tools=new ToolRegistry();tools.register(tool('existing'));assert.throws(()=>tools.registerModule({id:'bad.module',version:'1.0.0',register:r=>{r.register(tool('new_tool'));r.register(tool('existing'));}}),/conflict/);assert.equal(tools.catalog().length,1);
 assert.throws(()=>tools.register(tool('invalid',{categories:[{id:'x',label:'X',defaultDecision:'allow'},{id:'x',label:'X',defaultDecision:'deny'}],classify:()=> 'x'})),/manifest/);
});
test('runtime applies Allow and Deny and invalidates an approved action when its policy changed',async t=>{
 let executions=0;const item=tool();item.execute=async()=>{executions++;return 'ran';};const f=await fixture(t,item);
 const store=new SqliteStore(path.join(f.root,'tasks.sqlite'));let calls=0;let result;
 const provider=scriptedProvider({id:'fixture',respond:async messages=>{if(calls++%2===0)return{text:'',calls:[{id:'call-'+calls,tool:'sample_tool',args:{}}]};result=messages.filter(m=>m.role==='tool').at(-1).text;return{text:'done',calls:[]};}});
 const runtime=new TaskRuntime(store,provider,f.tools,f.policies,new OutputSizeLimit());t.after(()=>{runtime.shutdown();store.close();});
 const task=runtime.create(f.root);runtime.send(task.id,'Run','one');await until(()=>store.task(task.id).state==='awaiting_approval');const request=runtime.snapshot(task.id).interactions[0];
 let view=(await f.policies.list(f.root))[0];view=await f.policies.save(f.root,'sample_tool',{...view.document,categories:{execute:'allow'}},view.revision);
 await runtime.respondInteraction(request.id,{approved:true});await until(()=>store.task(task.id).state==='completed');assert.equal(executions,0);assert.match(result,/policy changed/);
 runtime.send(task.id,'Run under Allow','two');await until(()=>store.task(task.id).state==='completed');assert.equal(executions,1);
 await f.policies.save(f.root,'sample_tool',{...view.document,categories:{execute:'deny'}},view.revision);runtime.send(task.id,'Run denied','three');await until(()=>store.task(task.id).state==='completed');assert.equal(executions,1);assert.match(result,/blocked by project policy/);
});
