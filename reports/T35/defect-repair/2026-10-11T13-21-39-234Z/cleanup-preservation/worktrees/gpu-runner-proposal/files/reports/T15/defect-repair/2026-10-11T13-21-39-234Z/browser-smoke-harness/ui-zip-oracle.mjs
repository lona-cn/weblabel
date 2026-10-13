import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Pure offline consumer: no TestApp, authentication, HTTP or export request.
const [rootArg,expectedArg,format,archiveArg,jobArg,outputArg]=process.argv.slice(2);
assert(rootArg&&expectedArg&&archiveArg&&jobArg&&outputArg&&['native','coco','yolo'].includes(format),'argv: <permanent project root> <independent expected.json> <native|coco|yolo> <actual UI ZIP> <actual UI job.json> <new report leaf>');
const root=await fs.realpath(rootArg);
function contained(p){const q=path.resolve(p),r=path.relative(root,q);assert(r&&!r.startsWith('..')&&!path.isAbsolute(r),'Path outside permanent project root');return q;}
async function input(p){const q=await fs.realpath(contained(p));contained(q);return q;}
const expectedPath=await input(expectedArg),archivePath=await input(archiveArg),jobPath=await input(jobArg),output=contained(outputArg);
await input(path.dirname(output)); // Check actual parent BEFORE any write.
await fs.mkdir(output,{recursive:false});
const scratch=path.join(output,'runtime');await fs.mkdir(scratch);
const keys=['PATH','Path','PATHEXT','SystemRoot','WINDIR','COMSPEC','PYTHON'];
const env=Object.fromEntries(keys.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
for(const k of Object.keys(process.env))delete process.env[k];
Object.assign(process.env,env,{TEMP:scratch,TMP:scratch,TMPDIR:scratch});
globalThis.fetch=()=>{throw new Error('Offline oracle forbids network');};
const sha=b=>createHash('sha256').update(b).digest('hex');
const report={schema_version:1,evidence_kind:'independent_offline_full_ZIP_validation',input_provenance:'Supplied by Main; this oracle does not observe UI acquisition',status:'failed',format,model_calls:0,network_calls:0,ui_actions_observed_by_this_oracle:false,full_G5_claim:false};
try{
 const expectedBytes=await fs.readFile(expectedPath),jobBytes=await fs.readFile(jobPath),bytes=await fs.readFile(archivePath);
 const expected=JSON.parse(expectedBytes),job=JSON.parse(jobBytes);
 assert(Array.isArray(expected.expected)&&Array.isArray(expected.excluded));
 assert.equal(typeof expected.datasetId,'string');assert.equal(typeof expected.projectId,'string');assert.match(expected.snapshotHash,/^[a-f0-9]{64}$/);
 // Accept either the untouched completed GET-job envelope or its raw result.
 let result;
 if(Object.hasOwn(job,'state')){assert.equal(job.state,'succeeded');assert(job.result&&typeof job.result==='object');result=job.result;}
 else result=job;
 assert.equal(result.format,format);assert.equal(typeof result.export_id,'string');
 if(Object.hasOwn(job,'state')){assert.equal(job.kind,'dataset_export');assert.equal(job.project_id,expected.projectId);assert.equal(job.job_id,result.export_id);}
 assert.match(result.object_sha256,/^[a-f0-9]{64}$/);assert.equal(result.byte_size,bytes.length);assert.equal(result.object_sha256,sha(bytes));
 assert(result.loss_report&&Array.isArray(result.loss_report.losses));
 if(format==='native')assert.deepEqual(result.loss_report,{losses:[]});
 else{assert.deepEqual(result.loss_report.losses.map(x=>x.field),['annotation.attributes','annotation.object_ids']);for(const loss of result.loss_report.losses)assert(typeof loss.reason==='string'&&loss.reason.trim().length>0);}
 const helper=path.join(root,'tests/support/dataset-delivery.ts');
 const {verifyDeliveryArchive}=await import(pathToFileURL(helper).href);
 const frozen={fixture:{projectId:expected.projectId,ontology:expected.ontology},datasetId:expected.datasetId,snapshotHash:expected.snapshotHash,expected:expected.expected,excluded:expected.excluded};
 // Reuses the COMPLETE existing independent Python member/schema/immutable ID/
 // full Native/continuous geometry/negative/loss oracle and Sharp pixel hash.
 const receipt=await verifyDeliveryArchive(frozen,format,bytes,result,result.loss_report);
 const requireMain=createRequire(path.join(root,'apps/web/package.json')),sharp=requireMain('sharp');
 const pixelDir=path.join(scratch,'full-pixels');await fs.mkdir(pixelDir);
 const members=expected.expected.map(a=>format==='native'?`media/${a.media.asset_revision_id}.png`:`images/${a.split}/${a.media.asset_revision_id}.png`);
 const extract="import pathlib,sys,zipfile,json\nz=zipfile.ZipFile(sys.argv[1]); root=pathlib.Path(sys.argv[2])\nfor n,member in enumerate(json.loads(sys.argv[3])): (root/(str(n)+'.png')).write_bytes(z.read(member))\n";
 execFileSync(process.env.PYTHON??'python',['-c',extract,archivePath,pixelDir,JSON.stringify(members)],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
 const pixels=[];
 for(let i=0;i<expected.expected.length;i++){
  const a=expected.expected[i],actual=await sharp(await fs.readFile(path.join(pixelDir,i+'.png'))).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const original=await sharp(Buffer.from(a.originalBase64,'base64')).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  assert.equal(actual.info.width,a.width);assert.equal(actual.info.height,a.height);assert.equal(actual.info.channels,4);
  assert.equal(original.info.width,a.width);assert.equal(original.info.height,a.height);assert.equal(original.info.channels,4);
  assert.deepEqual(actual.data,original.data); // EVERY RGBA byte, not sample/hash only.
  assert.equal(sha(original.data),a.pixelsSha256);
  pixels.push({asset_revision_id:a.media.asset_revision_id,width:a.width,height:a.height,rgba_bytes_compared:actual.data.length,full_RGBA_equal:true});
 }
 await fs.writeFile(path.join(output,format+'.zip'),bytes);
 await fs.writeFile(path.join(output,'independent-expected.json'),expectedBytes);
 await fs.writeFile(path.join(output,'actual-job.json'),jobBytes);
 Object.assign(report,{status:'passed',dataset_version_id:expected.datasetId,project_id:expected.projectId,snapshot_sha256:expected.snapshotHash,receipt,pixels,full_RGBA_bytes_compared:pixels.reduce((n,p)=>n+p.rgba_bytes_compared,0),inputs:{expected:{path:path.relative(root,expectedPath),sha256:sha(expectedBytes)},archive:{path:path.relative(root,archivePath),sha256:sha(bytes),byte_size:bytes.length},job:{path:path.relative(root,jobPath),sha256:sha(jobBytes)}},helper_sha256:sha(await fs.readFile(helper)),oracle_sha256:sha(await fs.readFile(new URL(import.meta.url)))});
}catch(error){report.error={name:error.name,code:error.code,frames:error.stack?.split('\n').filter(s=>s.trimStart().startsWith('at '))};process.exitCode=1;}
finally{await fs.rm(scratch,{recursive:true,force:true});await fs.writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report));
