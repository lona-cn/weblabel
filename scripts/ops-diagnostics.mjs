import fs from 'node:fs';
import path from 'node:path';
import { root } from './build.mjs';

export async function exportUsage(data) {
 let scratch, db;
 try {
  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(path.join(root, 'target'), { recursive: true });
  scratch = fs.mkdtempSync(path.join(root, 'target/export-usage-'));
  for (const suffix of ['', '-wal']) {
   const file = path.join(data, 'api.sqlite' + suffix);
   if (suffix && !fs.existsSync(file)) continue;
   const stat = fs.lstatSync(file);
   if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 268435456) throw new Error('database_scan_limit_or_link');
   fs.copyFileSync(file, path.join(scratch, 'api.sqlite' + suffix));
  }
  db = new DatabaseSync(path.join(scratch, 'api.sqlite'), { readOnly: true });
  const rows = db.prepare('SELECT object_sha256 AS hash FROM annotation_exports UNION SELECT object_sha256 AS hash FROM dataset_exports LIMIT 10001').all();
  if (rows.length > 10000) throw new Error('scan_limit');
  let bytes = 0;
  for (const { hash } of rows) {
   if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('export_hash_invalid');
   let file = data;
   for (const component of ['objects', hash.slice(0, 2), hash.slice(2, 4), hash]) {
    file = path.join(file, component);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('link_refused');
   }
   const usage = scanUsage(file); if (usage.status !== 'measured') throw new Error('export_object_unknown');
   bytes += usage.bytes;
  }
  return { status: 'measured', bytes, objects: rows.length, scope: 'unique referenced export objects; included in objects total', consistency: 'isolated filesystem snapshot; not a transaction guarantee' };
 } catch (error) { return { status: 'unknown', bytes: null, code: error.code ?? error.message }; }
 finally { db?.close(); if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); }
}
export function scanUsage(directory, { maxEntries = 10000, maxDepth = 8 } = {}) {
 let bytes=0, count=0;
 try {
  const visit=(file,depth)=>{
   if (++count>maxEntries || depth>maxDepth) throw new Error('scan_limit');
   const stat=fs.lstatSync(file);
   if(stat.isSymbolicLink()) throw new Error('link_refused');
   if(stat.isFile()) { bytes+=stat.size; return; }
   if(!stat.isDirectory()) throw new Error('nonregular_refused');
   const dir=fs.opendirSync(file);
   try { let entry; while((entry=dir.readSync())) visit(path.join(file,entry.name),depth+1); } finally {dir.closeSync();}
  };
  visit(directory,0); return {status:'measured',bytes,entries:count};
 }catch(error){ return {status:count===1&&error.code==='ENOENT'?'absent':'unknown',bytes:null,code:error.code??error.message}; }
}
export function diagnoseLock(data) {
 const file=path.join(data,'runtime.lock');
 try {
  const stat=fs.lstatSync(file); if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096) return {status:'unknown',action:'inspect-only'};
  const lock=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!Number.isSafeInteger(lock.pid)||lock.pid<=0) return {status:'unknown',action:'inspect-only'};
  try {process.kill(lock.pid,0);return {status:'pid_alive_identity_unknown',pid:lock.pid,action:'do-not-remove-or-kill'};}
  catch(error){return {status:error.code==='ESRCH'?'stale_candidate':'unknown',pid:lock.pid,action:'inspect-only-no-auto-removal'};}
 }catch(error){return {status:error.code==='ENOENT'?'absent':'unknown',action:'inspect-only'};}
}
export async function storageDiagnostics(directory) {
 const data=path.resolve(directory);
 const result={data_dir:data,available_bytes:null,total_bytes:null,database:{status:'unknown',bytes:null},objects:{status:'unknown',bytes:null},exports:{status:'unknown',bytes:null},warnings:[],lock:{status:'unknown'}};
 try {
  if(fs.lstatSync(data).isSymbolicLink()) throw new Error('link_refused');
  result.data_dir=fs.realpathSync.native(data);
  const disk=fs.statfsSync(data,{bigint:true});
  const available=disk.bavail*disk.bsize,total=disk.blocks*disk.bsize;
  result.available_bytes=available.toString();result.total_bytes=total.toString();
  if(available<1073741824n || (total>0n&&available*10n<total)) result.warnings.push('LOW_CAPACITY_IMPORT_BACKUP_EXPORT');
  result.database=scanUsage(path.join(data,'api.sqlite'));
  const sidecars=['-wal','-shm'].map(s=>scanUsage(path.join(data,'api.sqlite'+s)));
  result.database.sidecars=sidecars;
  result.objects=scanUsage(path.join(data,'objects'));
  result.exports = await exportUsage(data);
  result.lock=diagnoseLock(data);
 }catch(error){result.code=error.code??error.message;result.warnings.push('CAPACITY_UNKNOWN');}
 if ([result.database, result.objects, result.exports].some(item => item.status === 'unknown')) result.warnings.push('USAGE_PARTIAL_OR_UNKNOWN');
 result.warnings.push('IO_SUCCESS_REQUIRED_NO_CAPACITY_GUARANTEE');
 return result;
}
export async function probeReady(base, timeoutMs=1000) {
 const url=new URL('/ready',base);
 if(url.protocol!=='http:'||!['127.0.0.1','[::1]','localhost'].includes(url.hostname)||url.username||url.password) throw new Error('readiness_loopback_required');
 try {
  const response=await fetch(url,{signal:AbortSignal.timeout(timeoutMs),redirect:'error'});
  const reader = response.body?.getReader(); if (!reader) return {status:'invalid'};
  let text = '', size = 0; const decoder = new TextDecoder();
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 1024) { await reader.cancel(); return {status:'invalid'}; } text += decoder.decode(value, {stream:true}); }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  const body=JSON.parse(text);
  if(Object.keys(body).sort().join(',')!=='mode,ready'||typeof body.ready!=='boolean'||!['normal','password_recovery'].includes(body.mode)) return {status:'invalid'};
  if(response.status===200&&body.ready&&body.mode==='normal') return {status:'ready',...body};
  if(response.status===503&&!body.ready) return {status:body.mode==='password_recovery'?'maintenance':'not_ready',...body};
  return {status:'invalid'};
 }catch{return {status:'unavailable'};}
}
export async function waitReady(base,{maintenance=false,child,timeoutMs=30000}={}) {
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){
  if(child&&(child.exitCode!==null||child.signalCode!==null)) throw new Error('api_exited_before_ready');
  const result=await probeReady(base,Math.min(1000,Math.max(1,deadline-Date.now())));
  if(result.status==='ready'&&!maintenance || result.status==='maintenance'&&maintenance) return result;
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 throw new Error('api_readiness_timeout');
}
export const backupBoundary={scope:'sensitive-whole-server-database',encryption:'none',integrity:'sha256-not-a-signature',browser_drafts:'not-included',preservation:['Before backup, export unresolved/unknown/foreign-author browser drafts from each browser without replaying writes.','Keep backup and draft rescue packages private; neither is a support receipt.']};
export const restoreChecklist=[
 'Start with --data-dir pointing to the NEW restored directory; use terminal bootstrap to choose fresh credentials for an existing administrator.',
 'Inspect accounts and project members as administrator; re-establish credentials and confirm role access without replacing historical user IDs.',
 'Open each old-author browser draft under its original identity; otherwise export it read-only. New credentials do not grant old-author draft write authority.',
 'Reconfigure AI profiles and secrets explicitly, then inspect availability; restoration does not authorize external calls or restart interrupted runs.',
 'Verify revisions, media, snapshots and exports before handing over; preserve the original backup and draft packages.'
];
