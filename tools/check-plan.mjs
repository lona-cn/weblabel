import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export function validateTaskGraph(tasks) {
 const errors=[];
 if(!Array.isArray(tasks) || tasks.length===0) return ['tasks must be a non-empty array'];
 const byId=new Map();
 for(const t of tasks){
  if(!/^T\d{2}$/.test(t.id??'')) errors.push(`invalid task id: ${t.id}`);
  if(byId.has(t.id)) errors.push(`duplicate task: ${t.id}`);
  byId.set(t.id,t);
  if(!Array.isArray(t.depends_on)) errors.push(`${t.id}: depends_on must be array`);
  if(!Array.isArray(t.locks)||!t.locks.length) errors.push(`${t.id}: missing locks`);
  if(!Array.isArray(t.checks)||!t.checks.length||t.checks.some(a=>!Array.isArray(a)||!a.length||a.some(x=>typeof x!=='string'||!x))) errors.push(`${t.id}: invalid checks`);
 }
 for(const t of tasks) for(const d of t.depends_on??[]) if(!byId.has(d)) errors.push(`${t.id}: unknown dependency ${d}`);
 const visiting=new Set(),visited=new Set();
 function visit(id){
  if(visiting.has(id)){ errors.push(`dependency cycle at ${id}`); return; }
  if(visited.has(id)||!byId.has(id))return;
  visiting.add(id); for(const d of byId.get(id).depends_on??[])visit(d);
  visiting.delete(id);visited.add(id);
 }
 for(const t of tasks)visit(t.id);
 return errors;
}

export function checkPack(root){
 const errors=[];
 let manifest,state;
 try { manifest=JSON.parse(fs.readFileSync(path.join(root,'TASKS.json'),'utf8')); state=JSON.parse(fs.readFileSync(path.join(root,'STATUS.json'),'utf8')); }
 catch(e){return {ok:false,errors:[String(e)]};}
 errors.push(...validateTaskGraph(manifest.tasks));
 const expected=Array.from({length:36},(_,i)=>`T${String(i).padStart(2,'0')}`);
 if(JSON.stringify(manifest.tasks.map(t=>t.id))!==JSON.stringify(expected))errors.push('expected exactly T00..T35');
 if(manifest.max_parallel_writers!==3||manifest.max_parallel_reviewers!==1)errors.push('unexpected concurrency budget');
 const allowed=['pending','running','review','done','blocked','failed'];
 const safeExists=rel=>{
  const abs=path.resolve(root,rel);
  return abs.startsWith(path.resolve(root)+path.sep)&&fs.existsSync(abs);
 };
 for(const t of manifest.tasks){
  if(!safeExists(t.card))errors.push(`${t.id}: missing card ${t.card}`);
  if(t.owner!=='main'&&!safeExists(`.omp/agents/${t.owner}.md`))errors.push(`${t.id}: missing owner ${t.owner}`);
  const s=state.tasks[t.id];
  if(!s||!allowed.includes(s.status)){errors.push(`${t.id}: invalid status`);continue;}
  if(s.status==='done'){
   if(!/^[0-9a-f]{40,64}$/.test(s.integrated_commit??''))errors.push(`${t.id}: done without actual commit`);
   if(!Array.isArray(s.evidence)||!s.evidence.length||s.evidence.some(p=>!safeExists(p)))errors.push(`${t.id}: done without existing evidence`);
   for(const d of t.depends_on)if(state.tasks[d]?.status!=='done')errors.push(`${t.id}: dependency not done: ${d}`);
  }
 }
 for(const f of ['PLAN.md','AGENTS.md','START_HERE.md','START_PROMPT.md','docs/architecture.md','docs/contracts.md','docs/testing-contracts.md','docs/execution.md','docs/verification.md','docs/reference/original-proposal.md','docs/sources.md','prompts/RESUME.md'])if(!safeExists(f))errors.push(`missing required file: ${f}`);
 return {ok:errors.length===0,scope:'plan_structure_only_not_product_verification',task_count:manifest.tasks.length,dependency_edges:manifest.tasks.reduce((n,t)=>n+t.depends_on.length,0),ready_tasks:manifest.tasks.filter(t=>state.tasks[t.id]?.status==='pending'&&t.depends_on.every(d=>state.tasks[d]?.status==='done')).map(t=>t.id),errors};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const result=checkPack(root); console.log(JSON.stringify(result,null,2));process.exitCode=result.ok?0:1;
}
