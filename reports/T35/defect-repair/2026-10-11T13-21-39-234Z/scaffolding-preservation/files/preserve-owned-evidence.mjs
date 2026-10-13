import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root=await fs.realpath(path.resolve(import.meta.dirname,'../../..'));
const runId='2026-10-11T13-21-39-234Z',R='reports/T35/defect-repair/2026-10-11T13-21-39-234Z';
const out=path.join(root,R,'isolated-evidence');
await fs.mkdir(out,{recursive:true});
const hash=b=>createHash('sha256').update(b).digest('hex');
const confine=p=>{const r=path.relative(root,p);assert(r&&!r.startsWith('..')&&!path.isAbsolute(r),'OWNED_ROOT_BOUNDARY');};
const entries=[];
async function copy(source,destination){
 const stat=await fs.lstat(source);assert(!stat.isSymbolicLink(),'EVIDENCE_LINK_REQUIRES_EXPLICIT_BOUNDARY');
 const actual=await fs.realpath(source);confine(actual);confine(destination);
 if(stat.isDirectory()){await fs.mkdir(destination,{recursive:true});for(const e of await fs.readdir(source))await copy(path.join(source,e),path.join(destination,e));return;}
 assert(stat.isFile(),'EVIDENCE_NOT_REGULAR_FILE');const bytes=await fs.readFile(source);const digest=hash(bytes);
 try{await fs.writeFile(destination,bytes,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;assert.equal(hash(await fs.readFile(destination)),digest,'EXISTING_PRESERVATION_CONFLICT');}
 assert.equal(hash(await fs.readFile(destination)),digest,'PRESERVATION_BYTE_MISMATCH');
 entries.push({source:path.relative(root,source).replaceAll('\\','/'),preserved:path.relative(root,destination).replaceAll('\\','/'),bytes:bytes.length,sha256:digest});
}
for(const [worktree,task] of [['gate-wrapper-prerequisites','T00'],['t15-export-readiness','T15'],['t30-browser-consumers','T30']]){
 const source=path.join(root,'target/worktrees',worktree,'reports',task,'defect-repair',runId);
 await copy(source,path.join(out,worktree,task));
}
await fs.writeFile(path.join(root,R,'isolated-evidence-preservation-v1.json'),JSON.stringify({schema_version:1,project_root:root,evidence_kind:'byte_preservation_before_owned_worktree_cleanup',identity_rebinding:false,model_calls:0,entries},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({preserved_files:entries.length,total_bytes:entries.reduce((a,e)=>a+e.bytes,0),identity_rebinding:false}));
