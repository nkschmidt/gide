require('reflect-metadata');
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const {DatabaseSync}=require('node:sqlite');
const {ExecutionStore}=require('../lib/node/harness/storage/executions');
test('unfinished generic executions are interrupted on startup and never replayed',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'governed-execution-recover-'));const file=path.join(root,'executions.sqlite');const store=new ExecutionStore(file);store.open();const tool={schemaVersion:2,id:'fixture',toolName:'project_fixture',name:'Fixture',description:'Recovery',implementation:{executor:'fixture-executor',configuration:{}},policy:{execute:'ask'}};store.put({id:'run',project:root,tool,state:'running',output:'partial',truncated:false,startedAt:1});store.close();t.after(()=>{store.close();return fs.rm(root,{recursive:true,force:true});});const job=store.get(root,'run');assert.equal(job.state,'interrupted');assert.equal(job.output,'partial');assert.match(job.error,/No automatic replay/);assert.equal(store.list(root).length,1);
});
