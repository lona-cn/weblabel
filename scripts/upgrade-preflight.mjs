import fs from 'node:fs';
import path from 'node:path';
import { root, checkedPath, sha } from './build.mjs';

import { validateRelease } from './start-local.mjs';
export async function upgradePreflight(data, target) {
 const { schemaHash, migrations, validateDatabase } = await import('./backup.mjs');
 const { DatabaseSync }=await import('node:sqlite');
 const result={status:'unsupported',readonly_source:true,rollback:'not-verified',source_schema:null,target_schema:null,pending_migrations:[],support_boundary:'Only exact shipped schemas or an exact migration prefix that applies cleanly on an isolated copy are supported.'};
 const release=path.resolve(target); const {manifest}=validateRelease(release);
 const sqlFiles=manifest.files.filter(f=>/^migrations\/\d+_.+\.sql$/.test(f.path)).map(f=>f.path).sort();
 if(!sqlFiles.length){result.code='TARGET_MIGRATIONS_MISSING';return result;}
 if(fs.existsSync(path.join(data,'runtime.lock'))){result.code='STOP_SOURCE_BEFORE_PREFLIGHT';return result;}
 fs.mkdirSync(path.join(root,'target'),{recursive:true});
 const scratch=fs.mkdtempSync(path.join(root,'target/upgrade-preflight-'));
 let source;
 try {
  const copies=[];
  for(const suffix of ['','-wal']) {
   const relative='api.sqlite'+suffix;
   if(suffix&&!fs.existsSync(path.join(data,relative))) continue;
   const original=checkedPath(data,relative),hash=sha(original);
   fs.copyFileSync(original,path.join(scratch,relative));copies.push({original,hash});
  }
  if(copies.some(c=>sha(c.original)!==c.hash)){result.code='SOURCE_CHANGED';return result;}
  source=new DatabaseSync(path.join(scratch,'api.sqlite'));
  validateDatabase(source);result.source_schema=schemaHash(source);
  const applied=migrations(source).map(r=>r.version);
  const versions=sqlFiles.filter(f=>!f.endsWith('/0001_core.sql')).map(f=>path.basename(f,'.sql'));
  if(applied.some((v,i)=>v!==versions[i])||applied.length>versions.length){result.code='SOURCE_MIGRATIONS_UNSUPPORTED';return result;}
  const expected=new DatabaseSync(':memory:');
  try {
   expected.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
   const core=sqlFiles.find(f=>f.endsWith('/0001_core.sql'));if(!core){result.code='TARGET_CORE_MISSING';return result;}
   expected.exec(fs.readFileSync(checkedPath(release,core),'utf8'));
   for(const version of applied) expected.exec(fs.readFileSync(checkedPath(release,sqlFiles.find(f=>f.endsWith('/'+version+'.sql'))),'utf8'));
   if(schemaHash(expected)!==result.source_schema){result.code='SOURCE_SCHEMA_UNSUPPORTED';return result;}
   for(const version of versions.slice(applied.length)){
    const sql=fs.readFileSync(checkedPath(release,sqlFiles.find(f=>f.endsWith('/'+version+'.sql'))),'utf8');
    expected.exec(sql);source.exec(sql);result.pending_migrations.push(version);
   }
   result.target_schema=schemaHash(expected);validateDatabase(source);
   if(schemaHash(source)!==result.target_schema){result.code='TARGET_SCHEMA_MISMATCH';return result;}
   if(copies.some(c=>sha(c.original)!==c.hash)){result.code='SOURCE_CHANGED';return result;}
   result.status='compatible';return result;
  }finally{expected.close();}
 }catch(error){result.code='PREFLIGHT_FAILED';result.error_kind=error.code??'sqlite-or-filesystem';return result;}
 finally{source?.close();fs.rmSync(scratch,{recursive:true,force:true});}
}
export function supportReceipt(result) {
 return {format:'weblabel-support-receipt',version:1,mode:result.mode,status:result.status,tools:result.tools.map(({name,status})=>({name,status})),release:{status:result.release.status},api:result.api?{status:result.api.status}:null,storage:result.storage?{capacity:result.storage.available_bytes===null?'unknown':'measured',warnings:result.storage.warnings,lock_status:result.storage.lock.status}:null,upgrade:result.upgrade?{status:result.upgrade.status,code:result.upgrade.code??null,source_schema:result.upgrade.source_schema,target_schema:result.upgrade.target_schema,pending_count:result.upgrade.pending_migrations.length,rollback:result.upgrade.rollback}:null,models:'not-run',payloads:'excluded',credentials:'not-inspected'};
}
