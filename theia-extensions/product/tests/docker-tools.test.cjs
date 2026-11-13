require('reflect-metadata');
const { test } = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs/promises'); const path = require('node:path'); const os = require('node:os'); const { execFileSync } = require('node:child_process');
const { DockerConnectionProvider } = require('../lib/node/harness/connections/docker');
const { DockerToolMethod, dockerMethod } = require('../lib/node/harness/modules/docker-tools');
const { LocalProcessExecutor } = require('../lib/node/harness/executors/local-process');
const { ProjectTools } = require('../lib/node/harness/project-tool-service'); const { ToolRegistry } = require('../lib/node/harness/core/contracts'); const { ToolPolicies } = require('../lib/node/harness/storage/tool-policies'); const { ExecutorRegistry } = require('../lib/node/harness/core/execution');
const context = { projectPath: '/project', signal: new AbortController().signal };
function host(platform, endpoint, overrides = {}) {
 const calls = []; const machine = { platform, home: platform === 'win32' ? 'C:\\Users\\fixture' : '/home/fixture', env: { PATH: '/bin', AWS_SECRET_ACCESS_KEY: 'must-not-inherit', OPENAI_API_KEY: 'must-not-inherit' }, settings: async () => ({ schemaVersion: 1 }), executable: async () => ({ path: platform === 'win32' ? 'C:\\Docker\\docker.exe' : '/bin/docker', digest: 'binary' }), inspect: async (_program, args, env) => { calls.push({ args, env }); return args.at(-1) === 'show' ? 'selected-context\n' : JSON.stringify([{ Name: args.at(-1), Endpoints: { docker: { Host: endpoint } } }]); }, ...overrides }; return { machine, calls };
}
for (const [platform, endpoint] of [['darwin','unix:///Users/fixture/.docker/run/docker.sock'],['linux','unix:///run/user/1000/docker.sock'],['win32','npipe:////./pipe/docker_engine'],['linux','tcp://engine.internal:2376'],['linux','ssh://user@engine.internal']]) {
 test(`Docker connection discovers ${platform} ${endpoint.split(':')[0]} through the selected context`, async () => {
  const f = host(platform, endpoint); const provider = new DockerConnectionProvider(f.machine); const first = await provider.resolve(context); const second = await provider.resolve(context);
  assert.equal(first.target, endpoint); assert.equal(first.identity, second.identity); assert.deepEqual(first.argumentsPrefix.slice(-2), ['--context','selected-context']); assert.equal(first.environment.HOME, f.machine.home); assert.equal(first.environment.AWS_SECRET_ACCESS_KEY, undefined); assert.equal(first.environment.OPENAI_API_KEY,undefined); assert.ok(first.environment.DOCKER_CONFIG); assert.equal(f.calls[0].args[2],'context');
 });
}
test('explicit Docker settings and environment follow context/host precedence and retain TLS/SSH essentials', async () => {
 const f = host('linux','ssh://docker@remote',{ env: { PATH:'/bin', DOCKER_CONTEXT:'remote', DOCKER_HOST:'tcp://ignored:2375', DOCKER_TLS_VERIFY:'1', DOCKER_CERT_PATH:'/certs', SSH_AUTH_SOCK:'/agent', DOCKER_CONFIG:'/custom/docker', CLOUD_TOKEN:'secret' } });
 const provider = new DockerConnectionProvider(f.machine); let selected = await provider.resolve(context); assert.equal(selected.label,'Docker context: remote'); assert.equal(selected.environment.SSH_AUTH_SOCK,'/agent'); assert.equal(selected.environment.CLOUD_TOKEN,undefined); assert.equal(selected.environment.DOCKER_HOST,undefined); assert.equal(selected.environment.DOCKER_CONTEXT,undefined); assert.equal(selected.argumentsPrefix[1],'/custom/docker');
 f.machine.env.DOCKER_CONTEXT=undefined; f.machine.env.DOCKER_HOST='tcp://daemon:2376'; selected=await provider.resolve(context); assert.deepEqual(selected.argumentsPrefix.slice(-2),['--host','tcp://daemon:2376']); assert.equal(selected.environment.DOCKER_TLS_VERIFY,'1'); assert.equal(selected.environment.DOCKER_CERT_PATH,'/certs');
 f.machine.settings=async()=>({schemaVersion:1,context:'explicit',configDirectory:'/machine/docker'}); selected=await provider.resolve(context); assert.equal(selected.label,'Docker context: explicit'); assert.equal(selected.argumentsPrefix[1],'/machine/docker');
});
test('Docker discovery never silently falls back from a broken context, embeds passwords or accepts command connection overrides', async () => {
 const f=host('linux','unix:///engine.sock');const provider=new DockerConnectionProvider(f.machine);
 for(const args of [['--host','tcp://other:2375','build','.'],['build','--context=other','.'],['--config','/other','build','.'],['-Htcp://other','info']])assert.throws(()=>provider.validateArguments(args),/overrides/);
 provider.validateArguments(['build','--network=host','.']);
 f.machine.inspect=async()=>{throw new Error('broken context')};await assert.rejects(()=>provider.resolve(context),/broken context/);
 f.machine.settings=async()=>({schemaVersion:1,host:'ssh://user:password@host'});await assert.rejects(()=>provider.resolve(context),/password/);
 f.machine.settings=async()=>({schemaVersion:1,context:'one',host:'unix:///two'});await assert.rejects(()=>provider.resolve(context),/settings/);
 f.machine.settings=async()=>({schemaVersion:1});f.machine.executable=async()=>{throw new Error('missing')};await assert.rejects(()=>provider.resolve(context),/not installed/);
});
test('Docker CLI discovery can use standard macOS and Windows installation locations without project paths', async () => {
 for(const platform of ['darwin','win32']){const seen=[];const f=host(platform,platform==='win32'?'npipe:////./pipe/docker_engine':'unix:///engine.sock',{env:{ProgramFiles:'C:\\Program Files'},executable:async name=>{seen.push(name);if(name==='docker')throw new Error('not in PATH');return{path:name,digest:'binary'};}});const selected=await new DockerConnectionProvider(f.machine).resolve(context);assert.equal(seen.length,2);assert.equal(selected.program,seen[1]);assert.ok(!selected.argumentsPrefix.includes(selected.program));}
});
async function fixture(t) {
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'governed-connections-')));const project=path.join(root,'project'),repo=path.join(root,'repo');await fs.mkdir(path.join(project,'repositories'),{recursive:true});await fs.mkdir(repo);await fs.writeFile(path.join(repo,'source.txt'),'unchanged\n');
 const git=args=>execFileSync('git',args,{cwd:repo,stdio:'pipe'}).toString();git(['init','-b','main']);git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']);await fs.symlink(repo,path.join(project,'repositories/sample'));await fs.writeFile(path.join(project,'project.theia-workspace'),JSON.stringify({folders:[{path:'.'}],governedRepositories:[{id:'sample',path:repo}]}));
 const f=host('linux','unix:///engine.sock'); let ran=0;
 const provider=new DockerConnectionProvider(f.machine);const runner=async request=>{ran++;return {state:'passed',exitCode:0,signal:null,output:JSON.stringify(request.arguments),truncated:false};};
 t.after(()=>fs.rm(root,{recursive:true,force:true}));return {root,project,repo,provider,machine:f.machine,runner,ran:()=>ran,git,context:{projectPath:project,signal:new AbortController().signal}};
}
test('Docker methods classify mutations independently of model-selected permission', async t=>{
 const f=await fixture(t);const read=new DockerToolMethod('read',f.provider,f.runner);
 for(const args of [['build','.'],['image','push','image'],['system','prune'],['exec','container','sh'],['compose','up']])await assert.rejects(()=>read.prepare({repository:'sample',arguments:args},f.context),/requires docker/);
 assert.equal(dockerMethod(['buildx','build','--push','.']),'manage');assert.equal(dockerMethod(['build','--cache-to=type=registry,ref=remote','.']),'push');assert.equal(dockerMethod(['build','--builder=other','.']),'manage');assert.equal(dockerMethod(['build','--output','/tmp/export','.']),'push');assert.equal(dockerMethod(['container','rm','x']),'remove');assert.equal(dockerMethod(['network','create','x']),'manage');
 assert.equal(new DockerToolMethod('remove').access.categories[0].defaultDecision,'deny');assert.equal(new DockerToolMethod('read').access.categories[0].defaultDecision,'allow');assert.equal(new DockerToolMethod('build').access.categories[0].defaultDecision,'ask');assert.equal(f.ran(),0);
});
test('Docker build pins its endpoint, validates registered repository and records actual output',async t=>{
 const f=await fixture(t);const build=new DockerToolMethod('build',f.provider,f.runner);const args={repository:'sample',arguments:['build','-t','fixture:local','.']};const prepared=await build.prepare(args,f.context);
 assert.equal(prepared.review.endpoint,'unix:///engine.sock');assert.equal(prepared.review.kind,'docker');assert.ok(!JSON.stringify(prepared).includes('AWS_SECRET'));
 const result=JSON.parse(await build.execute(args,prepared,f.context));assert.equal(result.exitCode,0);assert.equal(result.sourceChanged,false);assert.deepEqual(JSON.parse(result.output).slice(-4),args.arguments);assert.equal(f.ran(),1);
 await assert.rejects(()=>build.prepare({...args,repository:'missing'},f.context));await assert.rejects(()=>build.prepare({...args,arguments:['build','--context=other','.']},f.context),/overrides/);
 const native=new LocalProcessExecutor(path.join(f.root,'isolated'));assert.notEqual(native.environment().HOME,os.homedir());
});
test('changed Docker endpoint, executable or source revokes review before execution',async t=>{
 const f=await fixture(t);const build=new DockerToolMethod('build',f.provider,f.runner);const args={repository:'sample',arguments:['build','.']};const plan=await build.prepare(args,f.context);
 f.machine.settings=async()=>({schemaVersion:1,host:'tcp://different:2376'});await assert.rejects(()=>build.execute(args,plan,f.context),/changed after review/);assert.equal(f.ran(),0);
 f.machine.settings=async()=>({schemaVersion:1});await fs.writeFile(path.join(f.repo,'source.txt'),'modified');await assert.rejects(()=>build.execute(args,plan,f.context),/changed after review/);assert.equal(f.ran(),0);
});
test('Docker connection inspection does not execute a daemon command', async t=>{
 const f=await fixture(t);const inspect=new DockerToolMethod('connection',f.provider,f.runner);const plan=await inspect.prepare({},f.context);const result=JSON.parse(await inspect.execute({},plan,f.context));assert.equal(result.endpoint,'unix:///engine.sock');assert.equal(f.ran(),0);
});
test('installed Docker is one project tool; editable method policies control real runtime approval',async t=>{
 const f=await fixture(t);const registry=new ToolRegistry();registry.registerModule({id:'builtin.docker',version:'1.0.0',register:r=>{for(const method of require('../lib/node/harness/modules/docker-tools').dockerMethods)r.register(new DockerToolMethod(method,f.provider,f.runner));}});registry.registerFamily(require('../lib/node/harness/core/tool-families').BuiltinFamilies.find(x=>x.id==='docker'));
 const policies=new ToolPolicies(registry),tools=new ProjectTools(registry,policies,path.join(f.root,'executions.sqlite'));t.after(()=>tools.close());const catalog=await tools.list(f.project);assert.deepEqual(catalog.errors,[]);assert.deepEqual(catalog.tools.map(x=>x.tool.id),['builtin.docker']);assert.equal(catalog.tools[0].methods.length,8);await registry.refreshProject(f.project);assert.throws(()=>registry.get('docker_build',f.project),/not available/);
 const {SqliteStore}=require('../lib/node/harness/storage/sqlite-store');const {TaskRuntime}=require('../lib/node/harness/core/runtime');const {OutputSizeLimit}=require('../lib/node/harness/modules/file-tools');const {scriptedProvider}=require('./scripted-provider.cjs');const store=new SqliteStore(path.join(f.root,'tasks.sqlite'));let turn=0;
 const model=scriptedProvider({id:'fixture',respond:async()=>++turn===1?{text:'',calls:[{id:'call-build',tool:'docker',args:{call:{method:'build',arguments:{repository:'sample',arguments:['build','.']}}}}]}:{text:'Completed',calls:[]}});
 const runtime=new TaskRuntime(store,model,registry,policies,new OutputSizeLimit());t.after(()=>{runtime.shutdown();store.close();});const task=runtime.create(f.project);runtime.send(task.id,'Build','one');
 const until=async fn=>{for(let n=0;n<300;n++){if(fn())return;await new Promise(r=>setTimeout(r,20));}throw new Error('Timed out');};
 await until(()=>store.task(task.id).state==='awaiting_approval');assert.equal(f.ran(),0);const request=runtime.snapshot(task.id).interactions[0];assert.equal(request.review.endpoint,'unix:///engine.sock');await runtime.respondInteraction(request.id,{approved:true});await until(()=>store.task(task.id).state==='completed');assert.equal(f.ran(),1);const action=runtime.snapshot(task.id).actions[0];assert.equal(action.tool,'docker');assert.equal(action.method,'build');assert.equal(JSON.parse(action.result).exitCode,0);
 const saved=await tools.get(f.project,'builtin.docker');await tools.save(f.project,{...saved.tool,policy:{...saved.tool.policy,'build--execute':'deny'}},saved.revision);const verdict=await policies.evaluate({...action,state:'requested'},registry.registration('docker',f.project,'build').access,f.context);assert.equal(verdict.decision,'deny');
});
test('container cleanup permission excludes volumes, links, unknown flags and bulk pruning', async t=>{
 const {containerRemoval}=require('../lib/node/harness/modules/docker-tools');const {DefaultPolicy}=require('../lib/node/harness/core/tool-access');const f=await fixture(t);const tool=new DockerToolMethod('remove',f.provider,f.runner);const policy=new DefaultPolicy();
 for(const args of [['rm','test-container'],['container','remove','--force','test-container'],['container','rm','-f','one','two']]){assert.ok(containerRemoval(args));assert.equal(policy.check({args:{repository:'sample',arguments:args}},tool.access),'approve');}
 for(const args of [['rm','--volumes','test-container'],['rm','-fv','test-container'],['rm','--link','web/db'],['rm'],['rm','--force=true','x'],['container','prune','--force'],['system','prune','-a'],['image','rm','image'],['volume','rm','volume']]){assert.equal(containerRemoval(args),undefined);assert.equal(policy.check({args:{repository:'sample',arguments:args}},tool.access),'deny');}
 assert.equal(f.ran(),0);
});
test('cleanup reviews names and full IDs, then deletes only the pinned IDs without deleting volumes',async t=>{
 const f=await fixture(t);const calls=[];const ids={one:'a'.repeat(64),two:'b'.repeat(64)};
 const runner=async request=>{calls.push(request.arguments);return {state:'passed',exitCode:0,signal:null,output:request.arguments.includes('inspect')?ids[request.arguments.at(-1)]+'\n':'removed',truncated:false};};
 const tool=new DockerToolMethod('remove',f.provider,runner);const args={repository:'sample',arguments:['rm','-f','one','two']};const plan=await tool.prepare(args,f.context);assert.deepEqual(plan.review.containers,[{name:'one',id:ids.one},{name:'two',id:ids.two}]);assert.ok(calls.every(x=>x.includes('inspect')));
 const result=JSON.parse(await tool.execute(args,plan,f.context));assert.equal(result.exitCode,0);assert.deepEqual(result.executedArguments,['container','rm','--force',ids.one,ids.two]);assert.deepEqual(calls.at(-1).slice(-5),result.executedArguments);assert.ok(!result.executedArguments.includes('--volumes'));
});
test('replacing a container under the same name invalidates cleanup approval',async t=>{
 const f=await fixture(t);let id='a'.repeat(64);let removals=0;const runner=async request=>{if(!request.arguments.includes('inspect'))removals++;return {state:'passed',exitCode:0,signal:null,output:id,truncated:false};};const tool=new DockerToolMethod('remove',f.provider,runner);const args={repository:'sample',arguments:['rm','verify']};const plan=await tool.prepare(args,f.context);id='b'.repeat(64);await assert.rejects(()=>tool.execute(args,plan,f.context),/container identity.*changed after review/);assert.equal(removals,0);
});
test('cleanup fails closed for missing containers, malformed or truncated inspection results',async t=>{
 const f=await fixture(t);for(const result of [{state:'failed',exitCode:1,output:'not found',truncated:false},{state:'passed',exitCode:0,output:'not-an-id',truncated:false},{state:'passed',exitCode:0,output:'a'.repeat(64),truncated:true}]){const calls=[];const tool=new DockerToolMethod('remove',f.provider,async request=>{calls.push(request.arguments);return result;});await assert.rejects(()=>tool.prepare({repository:'sample',arguments:['rm','verify']},f.context),/Cannot verify container/);assert.ok(calls.every(x=>x.includes('inspect')));}
 for(const argv of [['container','logs','verify'],['container','port','verify'],['container','top','verify'],['image','history','image']])assert.equal(dockerMethod(argv),'read');
});

test('saved flag permissions compose per method and cannot expose denied methods',async t=>{
 const f=await fixture(t);const registry=new ToolRegistry();registry.registerModule({id:'builtin.docker',version:'1.0.0',register:r=>{for(const method of require('../lib/node/harness/modules/docker-tools').dockerMethods)r.register(new DockerToolMethod(method,f.provider,f.runner));}});registry.registerFamily(require('../lib/node/harness/core/tool-families').BuiltinFamilies.find(x=>x.id==='docker'));
 const policies=new ToolPolicies(registry),tools=new ProjectTools(registry,policies,path.join(f.root,'flags.sqlite'));t.after(()=>tools.close());await tools.list(f.project);await registry.refreshProject(f.project);
 const action={tool:'docker',method:'read',args:{repository:'sample',arguments:['inspect','--future-flag','container']},prepared:{}};
 const evaluate=()=>policies.evaluate(action,registry.registration('docker',f.project,'read').access,f.context);
 assert.equal((await evaluate()).decision,'ask');
 for(const decision of ['allow','deny']){const saved=await tools.get(f.project,'builtin.docker');await tools.save(f.project,{...saved.tool,policy:{...saved.tool.policy,'read--extra-flags':decision}},saved.revision);assert.equal((await evaluate()).decision,decision);}
 const saved=await tools.get(f.project,'builtin.docker');await tools.save(f.project,{...saved.tool,policy:{...saved.tool.policy,'read--extra-flags':'allow','read--execute':'deny'}},saved.revision);
 assert.equal((await evaluate()).decision,'deny');await registry.refreshProject(f.project);assert.equal(registry.registration('docker',f.project,'read').enabled,false);assert.equal(f.ran(),0);
});
