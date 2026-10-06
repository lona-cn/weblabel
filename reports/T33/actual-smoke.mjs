import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { sha } from '../../scripts/build.mjs';
import { taskkillPath } from '../../scripts/start-local.mjs';
const root = path.resolve(import.meta.dirname, '../..');
const build = process.argv[2] ?? path.join(root, 'target/本地 release & 发行');
const scratch = path.join(root, 'target', `T33-cli-data-${crypto.randomUUID()}`); fs.mkdirSync(scratch);
const result = { format: 'T33-actual-cli-data-smoke', source_release_manifest_sha256: sha(path.join(build,'release.json')), commands: [], observations: {} };
const children = [];
async function freePort() { const server = createServer(); server.listen(0,'127.0.0.1'); await once(server,'listening'); const address = server.address(); const closed=once(server,'close');server.close();await closed;return address.port; }
function assert(condition, detail) { if (!condition) throw new Error(detail); }
function cli(script, args) { const argv=[process.execPath,path.join(root,'scripts',script),...args];const r=spawnSync(argv[0],argv.slice(1),{cwd:root,encoding:'utf8',shell:false});result.commands.push({argv,exit_code:r.status,stdout:r.stdout,stderr:r.stderr});assert(r.status===0,script+': '+r.stderr); }
async function launch(data) {
  const port=await freePort(),apiPort=await freePort();const argv=[process.execPath,path.join(root,'scripts/start-local.mjs'),'--build-dir',build,'--data-dir',data,'--port',String(port),'--api-port',String(apiPort)];
  const env = { ...process.env, PATH: path.dirname(taskkillPath), WEBLABEL_HOST_CONFIG: '' };
  const child=spawn(argv[0],argv.slice(1),{cwd:root,env,shell:false,stdio:['ignore','pipe','pipe']});children.push(child);let output='';child.stdout.on('data',chunk=>output+=String(chunk));child.stderr.on('data',chunk=>output+=String(chunk));
  const base=`http://127.0.0.1:${port}`;
  for(let i=0;i<200;i++){const code=output.match(/WEBLABEL_BOOTSTRAP_CODE=([a-f0-9]+)/)?.[1];if(code){try{if((await fetch(base+'/api/session')).status===401){result.commands.push({argv,started:true,port,apiPort});return{child,base,code};}}catch{}}assert(child.exitCode===null,'start failed');await delay(50);}throw new Error('bootstrap_missing');
}
async function authenticate(app){const r=await fetch(app.base+'/api/session/bootstrap',{method:'POST',headers:{origin:app.base,'content-type':'application/json'},body:JSON.stringify({launch_code:app.code,password:'T33-independent-synthetic-password'})});const b=await r.json();assert(r.status===200,'bootstrap failed '+JSON.stringify(b));const cookie=r.headers.get('set-cookie').split(';')[0];return{user:b.user_id,username:b.username,cookie,csrf:b.csrf_token,async request(method,route,payload){const response=await fetch(app.base+route,{method,headers:{origin:app.base,cookie,'x-csrf-token':b.csrf_token,...(payload!==undefined?{'content-type':'application/json'}:{})},body:payload===undefined?undefined:JSON.stringify(payload)});const body=await response.json();assert(response.ok,route+' '+response.status+' '+JSON.stringify(body));return body;}};}
try {
  const data=path.join(scratch,'original 中文 & data');const app=await launch(data);const auth=await authenticate(app);
  const project=await auth.request('POST','/api/projects',{name:'T33 actual CLI business',description:'independent smoke',allow_self_review:true});
  const ontology=await auth.request('POST',`/api/projects/${project.project_id}/ontologies`,{guidelines_markdown:'smoke',labels:[{label_id:'person',name:'Person',color:'#0099ff',shortcut:null,allowed_geometry_types:['bbox_xyxy'],attributes:[]}]});
  const form=new FormData();form.append('images',new Blob([fs.readFileSync(path.join(root,'tests/fixtures/media/orientation-1.jpg'))],{type:'image/jpeg'}),'generated test image.jpg');
  const uploaded=await fetch(app.base+`/api/projects/${project.project_id}/assets`,{method:'POST',headers:{origin:app.base,cookie:auth.cookie,'x-csrf-token':auth.csrf,'idempotency-key':crypto.randomUUID()},body:form});assert(uploaded.status===202,'upload failed');
  let asset;for(let i=0;i<100;i++){asset=(await auth.request('GET',`/api/projects/${project.project_id}/assets`)).items[0];if(asset)break;await delay(100);}assert(asset,'production media job did not complete');
  const head=await auth.request('GET',`/api/assets/${asset.asset_revision_id}/annotation?ontology_version_id=${ontology.ontology_version_id}`);
  const document={...head.document,completion:'complete',objects:[{object_id:'smoke-object',label_id:'person',geometry:{type:'bbox_xyxy',x_min:10,y_min:5,x_max:40,y_max:30},attributes:{},origin:{type:'manual',prediction_id:null,model_run_id:null,import_batch_id:null}}]};
  const saved=await auth.request('PUT',`/api/assets/${asset.asset_revision_id}/annotation`,{operation_id:crypto.randomUUID(),base_revision_id:head.annotation_revision_id,document,lease:null,suggestion_decisions:[]});
  const task=await auth.request('POST',`/api/projects/${project.project_id}/tasks`,{asset_revision_id:asset.asset_revision_id,ontology_version_id:ontology.ontology_version_id,assignee_id:auth.user});
  await auth.request('POST',`/api/tasks/${task.task_id}/lease`,{action:'acquire'});
  const submission=await auth.request('POST',`/api/tasks/${task.task_id}/submit`,{annotation_revision_ids:[saved.revision.annotation_revision_id]});
  await auth.request('POST',`/api/reviews/${submission.review_id}/decision`,{decision:'approve',reason:'actual CLI smoke',revision_ids:[saved.revision.annotation_revision_id]});
  const snapshot=await auth.request('POST',`/api/projects/${project.project_id}/dataset-versions`,{operation_id:crypto.randomUUID(),ontology_version_id:ontology.ontology_version_id,items:[{asset_revision_id:asset.asset_revision_id,annotation_revision_id:saved.revision.annotation_revision_id,split:'train'}],excluded:[],split_seed:null,split_ratios:null});
  const backupDir=path.join(scratch,'backup 中文 spaces');cli('backup.mjs',['--data-dir',data,'--backup-dir',backupDir]);
  const restored=path.join(scratch,'restored fresh');cli('restore.mjs',['--backup-dir',backupDir,'--data-dir',restored]);
  const recovered=await launch(restored);const fresh=await authenticate(recovered);assert(fresh.user!==auth.user,'old identity reused');assert(fresh.username.startsWith('restore-admin-'),'fresh recovery username missing');
  const revision=await fresh.request('GET',`/api/annotation-revisions/${saved.revision.annotation_revision_id}`);assert(JSON.stringify(revision)===JSON.stringify(saved.revision),'revision changed');
  const image=await fetch(recovered.base+`/api/assets/${asset.asset_revision_id}/image`,{headers:{origin:recovered.base,cookie:fresh.cookie}});assert(image.status===200,'restored media inaccessible');
  const imageBytes=Buffer.from(await image.arrayBuffer());const imageFile=path.join(scratch,'canonical.png');fs.writeFileSync(imageFile,imageBytes);assert(sha(imageFile)===asset.canonical_sha256,'media hash changed');
  const exported=await fresh.request('POST',`/api/dataset-versions/${snapshot.dataset_version_id}/exports`,{operation_id:crypto.randomUUID(),format:'native',loss_ack:false});let job;for(let i=0;i<100;i++){job=await fresh.request('GET',`/api/jobs/${exported.job_id}`);if(job.state==='succeeded'||job.state==='failed')break;await delay(100);}assert(job.state==='succeeded','restored snapshot export failed');
  const download=await fetch(recovered.base+job.result.download_url,{headers:{origin:recovered.base,cookie:fresh.cookie}});assert(download.status===200,'restored snapshot download failed');await download.arrayBuffer();
  const db=new DatabaseSync(path.join(restored,'api.sqlite'),{readOnly:true});assert(db.prepare('SELECT manifest_sha256 FROM dataset_versions').get().manifest_sha256===snapshot.manifest_sha256,'snapshot drifted');assert(db.prepare('PRAGMA integrity_check').get().integrity_check==='ok','DB invalid');db.close();
  result.observations={fresh_auth_identity:true,old_audit_identity_preserved:revision.created_by===auth.user,revision_exact:true,canonical_media_sha256:asset.canonical_sha256,snapshot_manifest_sha256:snapshot.manifest_sha256,authenticated_snapshot_download:true,sqlite_integrity:'ok',models_called:0};
} catch(error){result.error=error.message;process.exitCode=1;} finally {
  for(const child of children){if(child.exitCode===null){const exit=once(child,'exit');const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{shell:false,stdio:'ignore'});await once(killer,'close');await exit;}}
  fs.rmSync(scratch,{recursive:true,force:true});
  fs.writeFileSync(path.join(import.meta.dirname,'actual-cli-data-smoke.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
