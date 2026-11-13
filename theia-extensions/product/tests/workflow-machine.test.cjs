const {test}=require('node:test');const assert=require('node:assert/strict');
const {materializeSteps,reopenStep,nextUnresolvedStep,resultInputs,resultIsCurrent,transitionPhase}=require('../lib/node/harness/core/workflow-machine');
const {workflowIssues}=require('../lib/common/workflow-service');
const step=(id,dependsOn)=>({id,title:id,instructions:'Do work.',tools:[],definitionOfReady:[],definitionOfDone:[],approval:false,enabled:true,...(dependsOn===undefined?{}:{dependsOn})});
const result=(stepId,revision,inputs={})=>({stepId,revision,inputs,summary:stepId,ready:[],done:[],artifacts:[]});
const run=()=>({id:'any-process',name:'Any process',definitionRevision:1,steps:materializeSteps([step('a'),step('b'),step('independent',[]),step('review',['b'])]),index:3,phase:'review',revision:6,results:[result('a',1),result('b',2,{a:1}),result('independent',3)],pending:result('review',6,{b:2}),branches:{repo:{branch:'feature',base:'main',head:'base'}},edits:{repo:{file:'digest'}},waitingFor:'approval'});
test('rework invalidates the dependency closure, preserves independent results and real effects, and archives reports',()=>{
 const workflow=run();const branches=structuredClone(workflow.branches),edits=structuredClone(workflow.edits);
 const change=reopenStep(workflow,'b','Adjust an implementation detail.');assert.deepEqual(change.invalidated,['b','review']);assert.deepEqual(workflow.results.map(x=>x.stepId),['a','independent']);assert.deepEqual(workflow.history.map(x=>x.result.stepId),['b','review']);assert.deepEqual(workflow.branches,branches);assert.deepEqual(workflow.edits,edits);assert.equal(workflow.phase,'active');assert.equal(workflow.pending,undefined);assert.equal(workflow.waitingFor,undefined);
 assert.deepEqual(resultInputs(workflow),{a:1});workflow.results.push(result('b',8,{a:1}));assert.equal(nextUnresolvedStep(workflow),3);assert.equal(resultIsCurrent(workflow,result('review',9,{b:2})),false);assert.equal(resultIsCurrent(workflow,result('review',10,{b:8})),true);
});
test('disabled steps expand dependencies; implicit order remains sequential and explicit independent steps stay independent',()=>{
 const definitions=[step('a'),{...step('disabled'),enabled:false},step('c'),step('other',[])];const materialized=materializeSteps(definitions);
 assert.deepEqual(materialized.map(x=>x.id),['a','c','other']);assert.deepEqual(materialized[1].dependsOn,['a']);assert.deepEqual(materialized[2].dependsOn,[]);
});
test('illegal transitions and unconfigured or forward rework leave workflow data unchanged',()=>{
 for(const target of ['missing','review']){const workflow=run();workflow.steps[3].reworkTargets=['b'];const original=JSON.stringify(workflow);assert.throws(()=>reopenStep(workflow,target,'Change'));assert.equal(JSON.stringify(workflow),original);}
 const workflow=run();workflow.phase='completed';assert.throws(()=>transitionPhase(workflow,'start'));assert.throws(()=>transitionPhase(workflow,'reopen'));assert.throws(()=>reopenStep(workflow,'a','Change'));
 const draft=run();draft.phase='draft';const original=JSON.stringify(draft);assert.throws(()=>reopenStep(draft,'a','Change'));assert.equal(JSON.stringify(draft),original);
});
test('definition validation rejects cycles, future or missing dependencies and forward transitions',()=>{
 for(const definitions of [[step('a',['b']),step('b')],[step('a'),step('b',['b'])],[step('a'),{...step('b'),reworkTargets:['missing']}],[{...step('a'),reworkTargets:['b']},step('b')]])assert.ok(workflowIssues(definitions).length>0);
 assert.deepEqual(workflowIssues([step('a'),{...step('b'),reworkTargets:['a']}]),[]);
});
test('an approval-required result cannot satisfy dependencies until approved',()=>{
 const workflow=run();workflow.steps[0].approval=true;assert.equal(resultIsCurrent(workflow,workflow.results[0]),false);workflow.results[0].approvedAt=1;assert.equal(resultIsCurrent(workflow,workflow.results[0]),true);
});
