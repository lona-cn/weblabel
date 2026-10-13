import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';

// Main launches this with its already sanitized Driver env; retain only tool keys.
const toolKeys = ['PATH','Path','PATHEXT','SystemRoot','WINDIR','COMSPEC','USERPROFILE','HOME','APPDATA','LOCALAPPDATA','PNPM_HOME','COREPACK_HOME','CARGO_HOME','RUSTUP_HOME','RUSTUP_TOOLCHAIN','RUSTC','RUSTDOC','VCINSTALLDIR','WindowsSdkDir','INCLUDE','LIB','LIBPATH','PYTHON'];
const toolEnv = Object.fromEntries(toolKeys.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
const configured = { binary: process.env.WEBLABEL_API_BINARY, wasm: process.env.WEBLABEL_WASM_BRIDGE_DIR };
for (const k of Object.keys(process.env)) delete process.env[k];
Object.assign(process.env, toolEnv, { CARGO_NET_OFFLINE:'true', RUSTUP_AUTO_INSTALL:'0', COREPACK_ENABLE_NETWORK:'0', WEBLABEL_SKIP_SECURITY:'1' });
const [rootArg, runtimeArg, reportArg] = process.argv.slice(2);
assert(rootArg && runtimeArg && reportArg, 'argv: <Main permanent root> <new private runtime> <new report leaf>');
const root = await fs.realpath(rootArg);
function inside(p, base = root) { const r = path.relative(base, path.resolve(p)); assert(r && !r.startsWith('..') && !path.isAbsolute(r), 'Path must stay inside the owned project root'); return path.resolve(p); }
async function existing(p) { const q = await fs.realpath(inside(p)); inside(q); return q; }
const runtime = inside(runtimeArg), report = inside(reportArg);
await fs.mkdir(runtime, { recursive:false }); await fs.mkdir(report, { recursive:false });
await existing(runtime); await existing(report);
const temp = path.join(runtime,'temp'); await fs.mkdir(temp);
Object.assign(process.env, { TEMP:temp, TMP:temp, TMPDIR:temp, WEBLABEL_API_BINARY:await existing(configured.binary), WEBLABEL_WASM_BRIDGE_DIR:await existing(configured.wasm) });
const requireMain = createRequire(path.join(root,'apps/web/package.json'));
const sha = b => createHash('sha256').update(b).digest('hex');
const save = (name, value) => fs.writeFile(path.join(report,name), JSON.stringify(value,null,2));
const emit = value => process.stdout.write(JSON.stringify(value)+'\n');
const helperPaths = ['tests/support/app.ts','tests/support/dataset-delivery.ts','apps/web/vite.config.ts','scripts/evidence-identity.mjs'];
const helperSha = Object.fromEntries(await Promise.all(helperPaths.map(async p => [p,sha(await fs.readFile(path.join(root,p)))])));
const appHelpers = await import(pathToFileURL(path.join(root,'tests/support/app.ts')).href);
const delivery = await import(pathToFileURL(path.join(root,'tests/support/dataset-delivery.ts')).href);
const { captureEvidenceIdentity } = await import(pathToFileURL(path.join(root,'scripts/evidence-identity.mjs')).href);
const sharp = requireMain('sharp');
const { createServer } = await import(pathToFileURL(requireMain.resolve('vite')).href);
let app, vite, apiChild, fixture, frozen, task, actor, browserOrigin;
const sessionFile = path.join(runtime,'browser-session.json');
const evidence = { schema_version:1, evidence_kind:'temporary_loopback_browser_support_not_UI_or_G5_proof', identity:captureEvidenceIdentity(), helper_sha256:helperSha, model_calls:0, archives:[], cleanup:null };
async function api(client, method, p, body, status = 200) { const r = await client.request(method,p,body); assert.equal(r.status,status,`${method} ${p}: unexpected status ${r.status}`); return r.json; }
async function portClosed(origin) { const u=new URL(origin); return await new Promise(ok=>{const s=connect({host:'127.0.0.1',port:Number(u.port)});s.once('connect',()=>{s.destroy();ok(false);});s.once('error',()=>ok(true));}); }
let stopped=false;
async function stop() {
 if(stopped)return; stopped=true;
 const errors=[];
 try { if(vite)await vite.close(); } catch {errors.push('vite_close_failed');}
 try {if(app)await app.stop();}catch{errors.push('owned_api_stop_failed');}
 await fs.rm(sessionFile,{force:true});
 const closed={api:app?await portClosed(app.base_url):true,web:browserOrigin?await portClosed(browserOrigin):true};
 evidence.cleanup={closed,owned_api_pid:apiChild?.pid??null,owned_api_exited:!apiChild||apiChild.exitCode!==null||apiChild.signalCode!==null,errors};
 await save('result.json',evidence);
 if(!closed.api||!closed.web||errors.length)throw new Error('Owned process cleanup incomplete');
}
async function expectedFile(name='expected.json') { await save(name,{datasetId:frozen.datasetId,projectId:fixture.projectId,ontology:fixture.ontology,snapshotHash:frozen.snapshotHash,expected:frozen.expected,excluded:frozen.excluded,request:frozen.request}); }
async function oracle(c) {
 assert(['native','coco','yolo'].includes(c.format)); assert.equal(typeof c.job_id,'string');
 const archivePath=await existing(c.path); const bytes=await fs.readFile(archivePath);
 const result=await delivery.pollDeliveryJob(fixture.admin,c.job_id);
 assert.equal(result.object_sha256,sha(bytes));
 if(c.format==='native')assert.deepEqual(result.loss_report,{losses:[]});
 else {assert.deepEqual(result.loss_report.losses.map(l=>l.field),['annotation.attributes','annotation.object_ids']);for(const loss of result.loss_report.losses)assert(typeof loss.reason==='string'&&loss.reason.trim().length>0);}
 const receipt=await delivery.verifyDeliveryArchive(frozen,c.format,bytes,result,result.loss_report);
 // Supplement the reused Python schema/geometry/fullNative parser and Sharp hash
 // with direct equality over EVERY decoded RGBA byte, against original inputs.
 const scratch=path.join(runtime,'pixel-'+randomUUID()); await fs.mkdir(scratch);
 try {
  const extractor="import pathlib,sys,zipfile,json\nz=zipfile.ZipFile(sys.argv[1]); items=json.loads(sys.argv[3]); root=pathlib.Path(sys.argv[2])\nfor n,i in enumerate(items): (root/(str(n)+'.png')).write_bytes(z.read(i))\n";
  const names=frozen.expected.map(a=>c.format==='native'?`media/${a.media.asset_revision_id}.png`:`images/${a.split}/${a.media.asset_revision_id}.png`);
  childProcess.execFileSync(process.env.PYTHON??'python',['-c',extractor,archivePath,scratch,JSON.stringify(names)],{stdio:['ignore','pipe','pipe']});
  let rgbaBytes=0;
  for(let i=0;i<frozen.expected.length;i++) {
   const a=frozen.expected[i], actual=await sharp(await fs.readFile(path.join(scratch,i+'.png'))).ensureAlpha().raw().toBuffer({resolveWithObject:true});
   const original=await sharp(Buffer.from(a.originalBase64,'base64')).ensureAlpha().raw().toBuffer({resolveWithObject:true});
   assert.equal(actual.info.width,a.width); assert.equal(actual.info.height,a.height); assert.equal(actual.info.channels,4);
   assert.deepEqual(actual.data,original.data); rgbaBytes+=actual.data.length;
  }
  const retained=`${evidence.archives.length}-${c.format}.zip`; await fs.writeFile(path.join(report,retained),bytes);
  const checked={...receipt,jobId:c.job_id,actual_input_path:path.relative(root,archivePath),retained_archive:retained,full_rgba_bytes_compared:rgbaBytes,provenance:c.provenance??'Main_UI_download',identity:evidence.identity};
  evidence.archives.push(checked);await save('result.json',evidence);return checked;
 }finally{await fs.rm(scratch,{recursive:true,force:true});}
}
try {
 // Observe only the child spawned by the existing fixture helper. No PID scan.
 const originalSpawn=childProcess.spawn;
 childProcess.spawn=(...args)=>{if(path.resolve(args[0])===path.resolve(process.env.WEBLABEL_API_BINARY)&&process.platform==='win32')args[2].env.WEBLABEL_OBJECT_ROOT=path.toNamespacedPath(args[2].env.WEBLABEL_OBJECT_ROOT);const child=originalSpawn(...args);if(path.resolve(args[0])===path.resolve(process.env.WEBLABEL_API_BINARY))apiChild=child;return child;};syncBuiltinESMExports();
 try{app=await appHelpers.start_test_app('false','manual');}finally{childProcess.spawn=originalSpawn;syncBuiltinESMExports();}
 fixture=await delivery.createDeliveryFixture(app,4,1); // 3 positive + index-0 negative
 frozen=await delivery.freezeDelivery(fixture,[0,1,2,3]); await expectedFile('initial-expected.json'); await expectedFile();
 // Browser actor owns this project only; reviewer remains a DIFFERENT local user.
 const username='browser-'+randomUUID(), password=randomUUID()+randomUUID();
 const created=await api(fixture.admin,'POST','/api/users',{username,password},201); const actorId=created.user_id;
 await api(fixture.admin,'POST',`/api/projects/${fixture.projectId}/members`,{user_id:actorId,role:'admin'});
 actor=await appHelpers.login_at_origin_for_test(app.base_url,{username,password});
 task=await api(fixture.admin,'POST',`/api/projects/${fixture.projectId}/tasks`,{asset_revision_id:fixture.assets[1].media.asset_revision_id,ontology_version_id:fixture.ontologyId,assignee_id:actorId});
 const webPort=5173;browserOrigin=`http://127.0.0.1:${webPort}`;assert(await portClosed(browserOrigin),'Configured product dev port 5173 is occupied; no existing service will be stopped');
 vite=await createServer({root:path.join(root,'apps/web'),configFile:path.join(root,'apps/web/vite.config.ts'),configLoader:'native',cacheDir:path.join(runtime,'vite-cache'),logLevel:'silent',server:{host:'127.0.0.1',port:webPort,strictPort:true,proxy:{'/api':{target:app.base_url,changeOrigin:true}}}});
 await vite.listen();assert.equal((await fetch(browserOrigin)).status,200);
 const wasm=await fs.readFile(path.join(process.env.WEBLABEL_WASM_BRIDGE_DIR,'wasm_bridge_bg.wasm'));
 assert.equal(sha(new Uint8Array(await (await fetch(browserOrigin+'/wasm/wasm_bridge_bg.wasm')).arrayBuffer())),sha(wasm));
 const login=await fetch(browserOrigin+'/api/session/login',{method:'POST',headers:{'content-type':'application/json',origin:browserOrigin},body:JSON.stringify({username,password})});assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie').split(';',1)[0], split=cookie.indexOf('=');
 // Secret is exclusively in a disposable runtime file. Browser imports cookies;
 // product fetches its own CSRF via its normal authenticated session endpoint.
 await fs.writeFile(sessionFile,JSON.stringify({cookies:[{name:cookie.slice(0,split),value:cookie.slice(split+1),url:browserOrigin,httpOnly:true,secure:false,sameSite:'Lax'}]}),{mode:0o600});
 const params=new URLSearchParams({project_id:fixture.projectId,asset_revision_id:task.asset_revision_id,ontology_version_id:fixture.ontologyId,task_id:task.task_id});
 const metadata={event:'ready',browser_origin:browserOrigin,api_origin:app.base_url,service_pid:process.pid,api_pid:apiChild?.pid,session_file:sessionFile,workbench_url:browserOrigin+'/?'+params,datasets_url:browserOrigin+'/?project_id='+fixture.projectId+'&dataset_view=1',project_id:fixture.projectId,ontology_version_id:fixture.ontologyId,task,actor:{user_id:actorId,project_role:'admin'},independent_reviewer_id:fixture.reviewerId,initial_dataset_version_id:frozen.datasetId,assets:fixture.assets.map(a=>({media:a.media,annotation_revision_id:a.revision.annotation_revision_id,document:a.revision.document,review:a.review})),identity:evidence.identity,api_binary_sha256:sha(await fs.readFile(process.env.WEBLABEL_API_BINARY)),served_wasm_sha256:sha(wasm),helper_sha256:helperSha,model_calls:0};
 await save('metadata.json',metadata); emit(metadata);
 const input=createInterface({input:process.stdin,crlfDelay:Infinity});
 for await(const line of input) {
  if(!line.trim())continue;
  let c;
  try {
   c=JSON.parse(line); let result;
   if(c.command==='stop'){await stop();emit({event:'stopped',cleanup:evidence.cleanup});break;}
   else if(c.command==='head') {result=await api(actor,'GET',`/api/assets/${task.asset_revision_id}/annotation?ontology_version_id=${fixture.ontologyId}`);await save('observed-head.json',result);}
   else if(c.command==='approve_freeze') {
    assert(c.expected_document,'Main must supply its independently expected full Native document');
    const head=await api(actor,'GET',`/api/assets/${task.asset_revision_id}/annotation?ontology_version_id=${fixture.ontologyId}`);assert.deepEqual(head.document,c.expected_document);
    const submitted=await api(actor,'POST',`/api/tasks/${task.task_id}/submit`,{annotation_revision_ids:[head.annotation_revision_id]});
    const review=await api(fixture.reviewer,'POST',`/api/reviews/${submitted.review_id}/decision`,{decision:'approve',reason:'Independent local reviewer of actual browser edit',revision_ids:[head.annotation_revision_id]});
    fixture.assets[1].revision=await api(fixture.admin,'GET',`/api/annotation-revisions/${head.annotation_revision_id}`);fixture.assets[1].review=review;
    frozen=await delivery.freezeDelivery(fixture,[0,1,2,3]);await expectedFile(); result={dataset_version_id:frozen.datasetId,revision:fixture.assets[1].revision,review,snapshot_sha256:frozen.snapshotHash};
   }
   else if(c.command==='oracle')result=await oracle(c);
   else if(c.command==='api_oracle_smoke') {
    // Explicitly NOT UI evidence: exercise identical oracle with this own API ZIP.
    const receipts=[];
    for(const format of ['native','coco','yolo']) {
     const r=await delivery.exportAndVerifyDelivery(frozen,format);const job=await delivery.pollDeliveryJob(fixture.admin,r.jobId);const d=await appHelpers.download_for_test(fixture.admin,job.download_url);assert.equal(d.status,200);
     const p=path.join(runtime,'API-only-'+format+'.zip');await fs.writeFile(p,d.bytes);receipts.push(await oracle({format,path:p,job_id:r.jobId,provenance:'API_only_not_UI_validation'}));
    } result=receipts;
   } else throw new Error('Unknown command');
   emit({event:'command_complete',command:c.command,result});
  } catch {emit({event:'command_failed',command:c?.command??null});}
 }
} catch(error) {evidence.startup_failed=true;evidence.startup_error={name:error.name,code:error.code,frames:error.stack?.split('\n').filter(s=>s.trimStart().startsWith('at '))};emit({event:'startup_failed',error:evidence.startup_error});process.exitCode=1;}
finally {try{await stop();}catch{process.exitCode=1;emit({event:'cleanup_failed'});}finally{process.stdin.destroy();}}
