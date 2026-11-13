const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseArguments,analyzeCommand,isReadOnly}=require('../lib/node/harness/core/command-analysis');
const {analyzeToolAction}=require('../lib/node/harness/core/tool-access');
const {analyzeGitCommand,analyzeDockerCommand,parseDockerArguments,githubCommandProfile}=require('../lib/node/harness/modules/command-profiles');
const {DockerConnectionProvider}=require('../lib/node/harness/connections/docker');

test('shared argv parser separates flags, values, clusters, abbreviations and literal operands',()=>{
 const syntax={abbreviations:true,options:[{name:'--output',aliases:['-o'],value:true},{name:'--quiet',aliases:['-q']}]};
 for(const argv of [['--output=x'],['--out','x'],['-ox'],['-qo','x']]){
  const parsed=parseArguments(argv,syntax);assert.deepEqual(parsed.errors,[]);assert.equal(parsed.options.find(x=>x.name==='--output').value,'x');
 }
 const parsed=parseArguments(['--','--output','../file'],syntax);assert.deepEqual(parsed.options,[]);assert.deepEqual(parsed.literalOperands,['--output','../file']);
 assert.equal(parseArguments(['--output','--'],syntax).errors.length,1);
 assert.equal(parseArguments(['--quiet=true'],syntax).errors.length,1);
 assert.equal(parseArguments(['--o'],{abbreviations:true,options:[...syntax.options,{name:'--other'}]}).options[0].known,false);
 assert.equal(parseArguments(['--output','--quiet'],syntax).options.length,1);
});
test('command profiles select nested commands and fail conservatively on unknown syntax',()=>{
 const profile={id:'fixture',fallback:{category:'execute',effects:['unknown']},rules:[{command:['object'],category:'execute',effects:['write']},{command:['object','show'],category:'read',effects:['read'],options:[{name:'--format',value:true}]}]};
 assert.equal(isReadOnly(analyzeCommand(profile,['object','show','--format','--destroy'])),true);
 for(const argv of [['object','show','--new-flag'],['object','show','--format'],['plugin','run']])assert.equal(isReadOnly(analyzeCommand(profile,argv)),false);
 const payload=parseArguments(['-e','VALUE=--host','image','--host','remote'],{stopAtOperand:true,options:[{name:'--env',aliases:['-e'],value:true}]});
 assert.deepEqual(payload.options.map(x=>x.name),['--env']);assert.deepEqual(payload.operands,['image','--host','remote']);
});
test('Git effects reflect syntax rather than coincidental text or policy names',()=>{
 for(const argv of [['diff','master...HEAD','--','Dockerfile'],['diff','--','--output'],['log','--format=--output'],['status','--porcelain=v1'],['diff','-U3','HEAD'],['log','-10']]){
  const result=analyzeGitCommand(argv);assert.equal(result.category,'read',JSON.stringify(argv));assert.equal(isReadOnly(result),true);
 }
 for(const argv of [['diff','--output=out'],['log','--out','out'],['diff','--future-flag'],['diff','--output'],['log','--format','--output=out'],['log','--pretty','--output=out'],['log','-m','--output=out']])assert.equal(isReadOnly(analyzeGitCommand(argv)),false);
 assert.equal(analyzeGitCommand(['restore','--worktree','--','Dockerfile']).category,'destructive');
 assert.equal(analyzeGitCommand(['branch','-D','old']).category,'destructive');
 assert.equal(analyzeGitCommand(['branch','-vv']).category,'read');
 assert.equal(analyzeGitCommand(['push','--force-with-lease']).category,'destructive');
 assert.equal(analyzeGitCommand(['add','--','-f']).category,'local');
});
test('Docker payloads cannot become publication flags or connection overrides',()=>{
 for(const argv of [['build','--build-arg','--push','.'],['build','--tag=--push','.'],['build','--','--push']])assert.equal(analyzeDockerCommand(argv).category,'build');
 for(const argv of [['build','--push','.'],['build','-oout','.'],['image','build','--cache-to=x','.']])assert.equal(analyzeDockerCommand(argv).category,'push');
 assert.equal(analyzeDockerCommand(['build','--output']).category,'manage');
 assert.equal(analyzeDockerCommand(['inspect','--unknown']).category,'read');
 assert.deepEqual(analyzeDockerCommand(['inspect','--unknown']).unrecognizedFlags,['--unknown']);
 assert.equal(isReadOnly(analyzeDockerCommand(['inspect','--unknown'])),false);
 const connection=new DockerConnectionProvider();
 for(const argv of [['run','-e','VALUE=--host','image','--host','remote'],['exec','container','program','--context=payload'],['build','--build-arg','--context=payload','.'],['run','-c','128','image'],['run','-it','image','program','--host','payload'],['inspect','--format','--context=payload','container']])assert.doesNotThrow(()=>connection.validateArguments(argv));
 for(const argv of [['run','--context=other','image'],['build','--host','tcp://other','.'],['build','-Htcp://other','.']])assert.throws(()=>connection.validateArguments(argv),/overrides/);
 assert.deepEqual(parseDockerArguments(['exec','container','cmd','--config','x']).options,[]);
});
test('all implementations share a checked analysis contract and unknown handlers remain unknown',()=>{
 const access={categories:[{id:'inspect',label:'Inspect',defaultDecision:'allow'}],classify:()=> 'inspect'};
 assert.deepEqual(analyzeToolAction(access,{},{}),{category:'inspect',effects:['unknown']});
 assert.throws(()=>analyzeToolAction({...access,analyze:()=>({category:'other',effects:['read']})},{},{}),/inconsistent/);
 assert.throws(()=>analyzeToolAction({...access,analyze:()=>({category:'inspect',effects:[]})},{},{}),/inconsistent/);
 assert.equal(analyzeToolAction({...access,analyze:()=>({category:'inspect',effects:['read']})},{},{}).effects[0],'read');
 assert.equal(analyzeCommand(githubCommandProfile,['pr','create','--title','A']).effects.includes('publish'),true);
 assert.equal(analyzeCommand(githubCommandProfile,['extension','exec','something']).effects.includes('unknown'),true);
});

test('kernel fingerprints semantics, preserves handler preparation and invalidates changed approval',async t=>{
 require('reflect-metadata');
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
 const {ToolRegistry}=require('../lib/node/harness/core/contracts');
 const {DefaultPolicy}=require('../lib/node/harness/core/tool-access');
 const {TaskRuntime}=require('../lib/node/harness/core/runtime');
 const {SqliteStore}=require('../lib/node/harness/storage/sqlite-store');
 const {OutputSizeLimit}=require('../lib/node/harness/modules/file-tools');
 const {scriptedProvider}=require('./scripted-provider.cjs');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'governed-semantics-'));
 const store=new SqliteStore(path.join(directory,'tasks.sqlite')),tools=new ToolRegistry();let effect='write',executed=0,turn=0;
 tools.register({definition:{name:'fixture',description:'fixture',parameters:{type:'object',properties:{},required:[],additionalProperties:false}},access:{categories:[{id:'execute',label:'Execute',defaultDecision:'ask'}],classify:()=> 'execute',analyze:()=>({category:'execute',effects:[effect]})},prepare:async()=>({scope:'execute',marker:true}),execute:async(_args,prepared)=>{assert.deepEqual(prepared,{scope:'execute',marker:true});executed++;return 'ok';}});
 const provider=scriptedProvider({id:'fixture',respond:async()=>++turn%2?{text:'',calls:[{id:'call-'+turn,tool:'fixture',args:{}}]}:{text:'done',calls:[]}});
 const runtime=new TaskRuntime(store,provider,tools,new DefaultPolicy(),new OutputSizeLimit());
 t.after(async()=>{runtime.shutdown();store.close();await fs.rm(directory,{recursive:true,force:true});});
 const until=async predicate=>{for(let i=0;i<300;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Timed out');};
 const task=runtime.create(directory);runtime.send(task.id,'Run','one');await until(()=>store.task(task.id).state==='awaiting_approval');
 let snapshot=runtime.snapshot(task.id);assert.deepEqual(snapshot.actions[0].operation,{category:'execute',effects:['write']});assert.deepEqual(store.actions(snapshot.actions[0].runId)[0].prepared,{scope:'execute',marker:true});
 await runtime.respondInteraction(snapshot.interactions.find(x=>x.state==='pending').id,{approved:true});await until(()=>store.task(task.id).state==='completed');assert.equal(executed,1);
 const other=runtime.create(directory);runtime.send(other.id,'Run again','two');await until(()=>store.task(other.id).state==='awaiting_approval');snapshot=runtime.snapshot(other.id);effect='delete';
 await runtime.respondInteraction(snapshot.interactions.find(x=>x.state==='pending').id,{approved:true});await until(()=>runtime.snapshot(other.id).actions[0].state==='failed');assert.equal(executed,1);assert.match(runtime.snapshot(other.id).actions[0].error,/semantics changed/);
});

test('additional flag policy composes with command permissions instead of replacing them',()=>{
 const {commandFlagAccess,DefaultPolicy,accessRequirements}=require('../lib/node/harness/core/tool-access');
 const policy=new DefaultPolicy();
 const make=(extra,primary='allow')=>{
  const access=commandFlagAccess({categories:[{id:'read',label:'Read',defaultDecision:primary}],classify:()=> 'read',analyze:()=>({category:'read',effects:['read','unknown'],unrecognizedFlags:['--future']})});
  return {...access,categories:access.categories.map(item=>item.id==='extra-flags'?{...item,defaultDecision:extra}:item)};
 };
 for(const [extra,expected] of [['allow','allow'],['ask','approve'],['deny','deny']])assert.equal(policy.check({args:{},prepared:{}},make(extra)),expected);
 assert.equal(policy.check({args:{},prepared:{}},make('allow','deny')),'deny');
 assert.equal(policy.check({args:{},prepared:{}},make('allow','ask')),'approve');
 assert.deepEqual(accessRequirements(make('allow'),{},{}),['read','extra-flags']);
 const noUnknown=commandFlagAccess({categories:[{id:'read',label:'Read',defaultDecision:'allow'}],classify:()=> 'read',analyze:()=>({category:'read',effects:['read']})});noUnknown.categories.find(item=>item.id==='extra-flags').defaultDecision='deny';assert.equal(policy.check({args:{},prepared:{}},noUnknown),'allow');
});
