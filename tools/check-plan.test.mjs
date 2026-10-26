import test from 'node:test';
import assert from 'node:assert/strict';
import {validateTaskGraph,checkPack} from './check-plan.mjs';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const t=(id,deps=[])=>({id,depends_on:deps,locks:['x'],checks:[['node','test.mjs']]});
test('accepts an acyclic graph',()=>assert.deepEqual(validateTaskGraph([t('T00'),t('T01',['T00'])]),[]));
test('rejects a cycle',()=>assert.ok(validateTaskGraph([t('T00',['T01']),t('T01',['T00'])]).some(x=>x.includes('cycle'))));
test('rejects a missing dependency',()=>assert.ok(validateTaskGraph([t('T00',['T99'])]).some(x=>x.includes('unknown dependency'))));
test('rejects duplicate ids',()=>assert.ok(validateTaskGraph([t('T00'),t('T00')]).some(x=>x.includes('duplicate'))));
test('rejects empty check arrays',()=>assert.ok(validateTaskGraph([{...t('T00'),checks:[]}]).some(x=>x.includes('checks'))));
test('validates the actual execution pack',()=>assert.equal(checkPack(fileURLToPath(new URL('../',import.meta.url))).ok,true));

test('accepts the independent rebuild graph without relaxing original task IDs',()=>{
 const tasks=[t('R00'),t('R01',['R00'])];
 assert.deepEqual(validateTaskGraph(tasks,/^R\d{2}$/),[]);
 assert.ok(validateTaskGraph(tasks).some(x=>x.includes('invalid task id')));
 assert.ok(validateTaskGraph([t('R00'),t('R01',['T00'])],/^R\d{2}$/).some(x=>x.includes('unknown dependency')));
});

const root=fileURLToPath(new URL('../',import.meta.url));
function fixture(run){
 const parent=path.join(root,'target','test-artifacts','html-rust-rebuild','metadata');
 fs.mkdirSync(parent,{recursive:true});
 const directory=fs.mkdtempSync(path.join(parent,'graph-'));
 try{return run(directory);}finally{fs.rmSync(directory,{recursive:true,force:true});}
}

test('task CLI executes a rebuild task from the independent graph',()=>fixture(directory=>{
 fs.writeFileSync(path.join(directory,'TASKS.json'),JSON.stringify({
  tasks:[{id:'T00',checks:[[process.execPath,'-e','process.exit(7)']]}],
  refactor_tasks:[{id:'R00',checks:[[process.execPath,'-e','console.log("rebuild-check-ran")']]}]
 }));
 fs.mkdirSync(path.join(directory,'scripts'));
 fs.copyFileSync(path.join(root,'scripts/task.mjs'),path.join(directory,'scripts/task.mjs'));
 const result=spawnSync(process.execPath,['scripts/task.mjs','R00'],{cwd:directory,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 assert.match(result.stdout,/rebuild-check-ran/);
}));

test('task CLI rejects ambiguous IDs before executing either check',()=>fixture(directory=>{
 const marker=path.join(directory,'must-not-run');
 const task={id:'R00',checks:[[process.execPath,'-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')`]]};
 fs.writeFileSync(path.join(directory,'TASKS.json'),JSON.stringify({tasks:[task],refactor_tasks:[task]}));
 fs.mkdirSync(path.join(directory,'scripts'));
 fs.copyFileSync(path.join(root,'scripts/task.mjs'),path.join(directory,'scripts/task.mjs'));
 const result=spawnSync(process.execPath,['scripts/task.mjs','R00'],{cwd:directory,encoding:'utf8'});
 assert.equal(result.status,1);
 assert.match(result.stderr,/duplicate|ambiguous/);
 assert.equal(fs.existsSync(marker),false);
}));

function packFixture(run){return fixture(directory=>{
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'TASKS.json'),'utf8'));
 manifest.tasks=manifest.tasks.map(task=>({...task,owner:'main',card:'card.md'}));
 manifest.refactor_tasks=Array.from({length:12},(_,i)=>({...t(`R${String(i).padStart(2,'0')}`,i?['R00']:[]),owner:'main',card:'card.md'}));
 const state={tasks:Object.fromEntries(manifest.tasks.map(task=>[task.id,{status:'pending'}])),user_requests:{html_rust_rebuild:{tasks:Object.fromEntries(manifest.refactor_tasks.map(task=>[task.id,{status:'pending'}]))}}};
 const required=['PLAN.md','AGENTS.md','START_HERE.md','START_PROMPT.md','docs/architecture.md','docs/contracts.md','docs/testing-contracts.md','docs/execution.md','docs/verification.md','docs/reference/original-proposal.md','docs/sources.md','prompts/RESUME.md','card.md'];
 for(const file of required){fs.mkdirSync(path.dirname(path.join(directory,file)),{recursive:true});fs.writeFileSync(path.join(directory,file),'Synthetic plan-checker fixture\n');}
 const check=()=>{
  fs.writeFileSync(path.join(directory,'TASKS.json'),JSON.stringify(manifest));
  fs.writeFileSync(path.join(directory,'STATUS.json'),JSON.stringify(state));
  return checkPack(directory);
 };
 return run({directory,manifest,state,check});
});}

test('independent rebuild states cannot borrow completion evidence from the original graph',()=>packFixture(({state,check})=>{
 state.tasks.T00={status:'done',integrated_commit:'a'.repeat(40),evidence:['card.md']};
 state.user_requests.html_rust_rebuild.tasks.R00={status:'done'};
 const result=check();
 assert.equal(result.ok,false);
 assert.ok(result.errors.includes('R00: done without actual commit'));
 assert.ok(result.errors.includes('R00: done without existing evidence'));
}));

test('rebuild completion requires its own dependencies to be done',()=>packFixture(({state,check})=>{
 state.user_requests.html_rust_rebuild.tasks.R01={status:'done',integrated_commit:'b'.repeat(40),evidence:['card.md']};
 assert.ok(check().errors.includes('R01: dependency not done: R00'));
 state.user_requests.html_rust_rebuild.tasks.R00={status:'done',integrated_commit:'a'.repeat(40),evidence:['card.md']};
 assert.equal(check().ok,true);
}));

test('adding a rebuild graph does not permit dropping an original task',()=>packFixture(({manifest,check})=>{
 manifest.tasks.pop();
 assert.ok(check().errors.includes('expected exactly T00..T35'));
}));
