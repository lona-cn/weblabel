import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { root, pins, entries, sha } from '../../scripts/build.mjs';
import { scanUsage, diagnoseLock, waitReady, exportUsage } from '../../scripts/ops-diagnostics.mjs';
import { upgradePreflight } from '../../scripts/upgrade-preflight.mjs';
const temporary=()=>{fs.mkdirSync(path.join(root,'target'),{recursive:true});return fs.mkdtempSync(path.join(root,'target/ux-ops-'));};
const cli=args=>spawnSync(process.execPath,['scripts/doctor.mjs',...args],{cwd:root,encoding:'utf8',env:{...process.env,PATH:''}});
test('export usage measures unique referenced object bytes and does not write source SQLite', async()=>{
 const dir=temporary();try {
  const payload=path.join(dir,'payload');fs.writeFileSync(payload,'actual-export-bytes');const hash=sha(payload);
  const object=path.join(dir,'objects',hash.slice(0,2),hash.slice(2,4),hash);fs.mkdirSync(path.dirname(object),{recursive:true});fs.copyFileSync(payload,object);
  const db=new DatabaseSync(path.join(dir,'api.sqlite'));db.exec('CREATE TABLE annotation_exports(object_sha256 TEXT); CREATE TABLE dataset_exports(object_sha256 TEXT)');
  db.prepare('INSERT INTO annotation_exports VALUES (?)').run(hash);db.prepare('INSERT INTO dataset_exports VALUES (?)').run(hash);db.close();
  const before=sha(path.join(dir,'api.sqlite'));const usage=await exportUsage(dir);assert.equal(usage.bytes,19);assert.equal(usage.objects,1);assert.equal(sha(path.join(dir,'api.sqlite')),before);
  fs.unlinkSync(object);assert.equal((await exportUsage(dir)).bytes,null);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('runtime mode does not require build tools and diagnoses capacity without creating data',()=>{
 const dir=temporary();try{
 fs.writeFileSync(path.join(dir,'api.sqlite'),'12345');const r=cli(['--mode','runtime','--data-dir',dir,'--build-dir',path.join(dir,'missing')]);
 assert.equal(r.status,2);const d=JSON.parse(r.stdout);assert.deepEqual(d.tools.map(x=>x.name),['node']);assert.equal(d.storage.database.bytes,5);assert.ok(d.storage.available_bytes>0);assert.equal(d.storage.objects.status,'absent');
 const missing=path.join(dir,'absent');cli(['--mode','runtime','--data-dir',missing]);assert.equal(fs.existsSync(missing),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('bounded scans refuse junctions and locks are never removed by diagnosis',()=>{
 const dir=temporary();try{
 fs.mkdirSync(path.join(dir,'outside'));fs.writeFileSync(path.join(dir,'outside/payload'),'secret');fs.symlinkSync(path.join(dir,'outside'),path.join(dir,'linked'),'junction');
 assert.equal(scanUsage(path.join(dir,'linked')).bytes,null);assert.equal(scanUsage(dir,{maxEntries:1}).status,'unknown');
 fs.writeFileSync(path.join(dir,'runtime.lock'),JSON.stringify({pid:process.pid}));assert.equal(diagnoseLock(dir).status,'pid_alive_identity_unknown');
 const r=cli(['--mode','ai','--data-dir',dir,'--support-receipt',path.join(dir,'receipt.json')]);assert.equal(r.status,2);assert.equal(fs.existsSync(path.join(dir,'runtime.lock')),true);
 const receipt=fs.readFileSync(path.join(dir,'receipt.json'),'utf8');assert.equal(receipt.includes(dir),false);assert.equal(receipt.includes('secret'),false);assert.equal(cli(['--mode','bad']).status,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('readiness waits for business readiness and recognizes maintenance independently',async()=>{
 let calls=0,maintenance=false;const server=http.createServer((req,res)=>{calls++;res.writeHead(maintenance||calls<3?503:200,{'content-type':'application/json'});res.end(JSON.stringify({ready:!maintenance&&calls>=3,mode:maintenance?'password_recovery':'normal'}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 try{assert.equal((await waitReady(base,{timeoutMs:1000})).status,'ready');assert.ok(calls>=3);maintenance=true;assert.equal((await waitReady(base,{maintenance:true,timeoutMs:1000})).status,'maintenance');await assert.rejects(waitReady(base,{timeoutMs:100}),/api_readiness_timeout/);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
function releaseFixture(dir){
 const release=path.join(dir,'release');fs.mkdirSync(release);
 const names=[`api/${process.platform==='win32'?'weblabel-api.exe':'weblabel-api'}`,'host/runtime.mjs','host/mcp.mjs','web/index.html','web/wasm/wasm_bridge.js','web/wasm/wasm_bridge_bg.wasm'];
 for(const name of names){fs.mkdirSync(path.dirname(path.join(release,name)),{recursive:true});fs.writeFileSync(path.join(release,name),'fixture-not-executable');}
 fs.mkdirSync(path.join(release,'migrations'));const sqlFiles=fs.readdirSync(path.join(root,'crates/weblabel-api/migrations')).filter(x=>/^\d+_.+\.sql$/.test(x)).sort();
 for(const name of sqlFiles)fs.copyFileSync(path.join(root,'crates/weblabel-api/migrations',name),path.join(release,'migrations',name));
 fs.writeFileSync(path.join(release,'release.json'),JSON.stringify({format:'weblabel-local-release',version:1,platform:process.platform,arch:process.arch,pins,files:entries(release)}));return{release,sqlFiles};
}
function databaseFixture(data,release,sqlFiles){
 fs.mkdirSync(data);const db=new DatabaseSync(path.join(data,'api.sqlite'));db.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
 for(const name of sqlFiles){db.exec(fs.readFileSync(path.join(release,'migrations',name),'utf8'));if(name!=='0001_core.sql')db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(name.slice(0,-4));}db.close();
}
test('preflight verifies actual schema and migration prefix without changing source bytes',async()=>{
 const dir=temporary();try{
 const{release,sqlFiles}=releaseFixture(dir);const data=path.join(dir,'data');databaseFixture(data,release,sqlFiles.slice(0,-1));const before=sha(path.join(data,'api.sqlite'));
 const r=await upgradePreflight(data,release);assert.equal(r.status,'compatible');assert.equal(r.pending_migrations.length,1);assert.equal(sha(path.join(data,'api.sqlite')),before);assert.deepEqual(fs.readdirSync(data),['api.sqlite']);
 const mutate=new DatabaseSync(path.join(data,'api.sqlite'));mutate.exec('CREATE TABLE unexpected (value TEXT)');mutate.close();assert.equal((await upgradePreflight(data,release)).code,'SOURCE_SCHEMA_UNSUPPORTED');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('backup and restore CLI preserve actual server database bytes',()=>{
 const dir=temporary();try{
 const{release,sqlFiles}=releaseFixture(dir);const data=path.join(dir,'data');databaseFixture(data,release,sqlFiles);const before=sha(path.join(data,'api.sqlite'));
 const backup=path.join(dir,'backup');const b=spawnSync(process.execPath,['scripts/backup.mjs','--data-dir',data,'--backup-dir',backup],{cwd:root,encoding:'utf8'});assert.equal(b.status,0,b.stderr);assert.equal(sha(path.join(data,'api.sqlite')),before);

 const restored=path.join(dir,'restored');const r=spawnSync(process.execPath,['scripts/restore.mjs','--backup-dir',backup,'--data-dir',restored],{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.equal(sha(path.join(backup,'api.sqlite')),sha(path.join(restored,'api.sqlite')));

 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
