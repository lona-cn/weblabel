import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, cp, readFile, writeFile, rm} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const root=resolve(process.argv[2]??'.');
const main=resolve(root,'../../..');
const evidence=join(root,'reports/T27/ux-improvement/lease-regression');
const data=join(evidence,'http-data-'+randomUUID());
const source=join(main,'target/ux19-primary-20261013');
const binary=join(main,'target/build-cache/ux23-api/debug/weblabel-api.exe');
const origin='http://127.0.0.1:48239';
const sha=b=>createHash('sha256').update(b).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await mkdir(join(data,'tmp'),{recursive:true});
// Read-only SQLite snapshot includes committed WAL state, never edits source.
const sourceDb=new DatabaseSync(join(source,'api.sqlite'),{readOnly:true});
sourceDb.exec(`VACUUM INTO '${join(data,'api.sqlite').replaceAll("'","''")}'`);
sourceDb.close();
await cp(join(source,'objects'),join(data,'objects'),{recursive:true});
const db=new DatabaseSync(join(data,'api.sqlite'),{readOnly:true});
const snapshots=db.prepare('SELECT dataset_version_id,manifest_json FROM dataset_versions').all().map(r=>({id:r.dataset_version_id,manifest:JSON.parse(r.manifest_json)}));
const small=snapshots.filter(s=>s.manifest.items.length>2).sort((a,b)=>a.manifest.items.length-b.manifest.items.length)[0];
assert(small);db.close();
const report={origin,binary_sha256:sha(await readFile(binary)),fixture_policy:'Read-only primary synthetic SQLite VACUUM snapshot and object copy; new export operation against isolated owned API; original fixture unchanged.',snapshot_id:small.id,item_count:small.manifest.items.length};
const child=spawn(binary,[],{cwd:root,env:{...process.env,TEMP:join(data,'tmp'),TMP:join(data,'tmp'),WEBLABEL_BIND:'127.0.0.1:48239',WEBLABEL_DATABASE_URL:'sqlite:'+join(data,'api.sqlite'),WEBLABEL_OBJECT_ROOT:join(data,'objects'),WEBLABEL_ENV:'development',WEBLABEL_COOKIE_SECURE:'false'},stdio:['ignore','pipe','pipe']});
let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
try {
 for(let i=0;i<600;i++){assert.equal(child.exitCode,null,'Owned API exited');try{if((await fetch(origin+'/health')).status===204)break;}catch{}await sleep(100);if(i===599)throw Error('Readiness timeout');}
 const {login_at_origin_for_test,download_for_test}=await import(pathToFileURL(join(root,'tests/support/app.ts')).href);
 const admin=await login_at_origin_for_test(origin,{username:'local-admin',password:'ux19-synthetic-admin-20261013'});
 const admitted=await admin.request('POST',`/api/dataset-versions/${small.id}/exports`,{format:'native',loss_ack:false,operation_id:randomUUID()});
 assert.equal(admitted.status,202,JSON.stringify(admitted.json));report.admission=admitted;
 let terminal;
 for(let i=0;i<3000;i++){const r=await admin.request('GET',`/api/jobs/${admitted.json.job_id}`);assert.equal(r.status,200);terminal=r.json;if(['failed','succeeded'].includes(terminal.state))break;await sleep(100);}
 assert.equal(terminal.state,'succeeded',JSON.stringify(terminal));report.terminal=terminal;
 const download=await download_for_test(admin,terminal.result.download_url);
 assert.equal(download.status,200);assert.equal(download.bytes.length,terminal.result.byte_size);assert.equal(sha(download.bytes),terminal.result.object_sha256);assert.equal(Buffer.from(download.bytes).readUInt32LE(0),0x04034b50);
 report.download={status:download.status,bytes:download.bytes.length,sha256:sha(download.bytes)};report.complete=true;
 await writeFile(join(evidence,'loopback-result.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
} finally {
 if(child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}
 await writeFile(join(evidence,'http-api.log'),output);
 await rm(data,{recursive:true,force:true});
}
