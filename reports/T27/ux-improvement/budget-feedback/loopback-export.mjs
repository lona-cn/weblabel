import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {cp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const root=resolve(process.argv[2]??'.');
const data=join(root,'target','budget-feedback-loopback-'+randomUUID());
const source=join(root,'target','ux19-data-serial');
const evidence=join(root,'reports','T27','ux-improvement','budget-feedback');
const origin='http://127.0.0.1:48229';
const binary=join(root,'target','build-cache','debug','weblabel-api.exe');
const sha=b=>createHash('sha256').update(b).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await mkdir(join(data,'tmp'),{recursive:true});
await cp(join(source,'objects'),join(data,'objects'),{recursive:true});
for(const name of ['api.sqlite','api.sqlite-wal','api.sqlite-shm']) { try {await cp(join(source,name),join(data,name));} catch(e) {if(e.code!=='ENOENT')throw e;} }
const db=new DatabaseSync(join(data,'api.sqlite'),{readOnly:true});
const rows=db.prepare('SELECT dataset_version_id,manifest_json FROM dataset_versions').all();
const snapshots=rows.map(r=>({id:r.dataset_version_id,manifest:JSON.parse(r.manifest_json)}));
const boundary=snapshots.find(s=>s.id==='e9f46264-c5d9-476b-bae2-e364163e3fc5');
const small=snapshots.filter(s=>s.manifest.items.length>2).sort((a,b)=>a.manifest.items.length-b.manifest.items.length)[0];
assert(boundary&&small);db.close();
const report={origin,fixture_policy:'Read-only source fixture copied into new root-local temporary data directory; source DB/objects/driver unchanged. New jobs exercise the changed binary, not a rerun to reconfirm the old failure.',binary_sha256:sha(await readFile(binary)),source_hashes:{},exports:[]};
for(const path of ['crates/weblabel-api/src/datasets/export.rs','crates/dataset-formats/src/archive.rs','crates/dataset-formats/src/lib.rs'])report.source_hashes[path]=sha(await readFile(join(root,path)));
const child=spawn(binary,[],{cwd:root,env:{...process.env,TEMP:join(data,'tmp'),TMP:join(data,'tmp'),WEBLABEL_BIND:'127.0.0.1:48229',WEBLABEL_DATABASE_URL:'sqlite:'+join(data,'api.sqlite'),WEBLABEL_OBJECT_ROOT:join(data,'objects'),WEBLABEL_ENV:'development',WEBLABEL_COOKIE_SECURE:'false'},stdio:['ignore','pipe','pipe']});
let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
try {
 for(let i=0;i<600;i++){assert.equal(child.exitCode,null,'Owned API exited');try{if((await fetch(origin+'/health')).status===204)break;}catch{}await sleep(100);if(i===599)throw Error('Readiness timeout');}
 const {login_at_origin_for_test,download_for_test}=await import(pathToFileURL(join(root,'tests/support/app.ts')).href);
 const admin=await login_at_origin_for_test(origin,{username:'local-admin',password:'ux19-synthetic-admin-20261013'});
 for(const [snapshot,expected] of [[boundary,'failed'],[small,'succeeded']]) {
  const admitted=await admin.request('POST',`/api/dataset-versions/${snapshot.id}/exports`,{format:'native',loss_ack:false,operation_id:randomUUID()});
  assert.equal(admitted.status,202,JSON.stringify(admitted.json));let terminal;
  for(let i=0;i<3000;i++){const r=await admin.request('GET',`/api/jobs/${admitted.json.job_id}`);assert.equal(r.status,200);terminal=r.json;if(['failed','succeeded'].includes(terminal.state))break;await sleep(100);}
  assert.equal(terminal.state,expected,JSON.stringify(terminal));
  const entry={dataset_version_id:snapshot.id,item_count:snapshot.manifest.items.length,admission_status:admitted.status,admission:admitted.json,terminal};
  if(expected==='failed') {
   assert.equal(terminal.result.code,'EXPORT_SIZE_LIMIT');assert.equal(terminal.result.limit_bytes,100663296);assert(terminal.result.observed_bytes>terminal.result.limit_bytes);assert.equal(terminal.result.budget,'uncompressed archive members');
   entry.actual_media_bytes=100662272;entry.annotation_bytes=1188;entry.minimum_native_payload_bytes=100663460;
   const download=await download_for_test(admin,`/api/exports/${admitted.json.job_id}/download`);assert.notEqual(download.status,200);entry.download_status=download.status;
  } else {
   const download=await download_for_test(admin,terminal.result.download_url);assert.equal(download.status,200);assert.equal(download.bytes.length,terminal.result.byte_size);assert.equal(sha(download.bytes),terminal.result.object_sha256);assert.equal(Buffer.from(download.bytes).readUInt32LE(0),0x04034b50);
   entry.download={status:download.status,bytes:download.bytes.length,sha256:sha(download.bytes)};
  }
  report.exports.push(entry);
 }
 report.complete=true;await mkdir(evidence,{recursive:true});await writeFile(join(evidence,'loopback-result.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
} finally {
 if(child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}
 await rm(data,{recursive:true,force:true});
}
