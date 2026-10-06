import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { expect, it } from 'vitest';
import { bootstrap_admin_for_test, database_path_for_test, start_test_app } from '../support/app';
import { authorize, seed, startRunBody } from '../support/t25-ai';
import { addMember, head, id, jsonObject, loginClient, persistentCopy, silentProvider, writeEvidence } from '../support/faults';
import type { AnnotationObject } from '../../packages/contracts/generated/AnnotationObject';
import type { PersistentApi } from '../support/faults';
import type { SaveRequest } from '../../packages/contracts/generated/SaveRequest';
import type { SaveResponse } from '../../packages/contracts/generated/SaveResponse';
import { isProcessAlive } from '../../apps/agent-host/src/security/spawn';

const person:AnnotationObject={object_id:'t30-person',label_id:'label_person',geometry:{type:'bbox_xyxy',x_min:1,y_min:2,x_max:12,y_max:18},attributes:{helmet_state:'unknown'},origin:{type:'manual',prediction_id:null,model_run_id:null,import_batch_id:null}};

it('F10/F11 concurrent real CAS plus transferred and expired lease reject without partial revisions',async()=>{
  const app=await start_test_app();
  try{
    const admin=await bootstrap_admin_for_test(app), pins=await seed(admin,app);
    const writer=await addMember(admin,app.base_url,pins.projectId,'annotator');
    const secondSession=await loginClient(app.base_url,writer.username,writer.password);
    const initial=await head(admin,pins.assetRevisionId,pins.ontologyId);
    const task=await admin.request('POST',`/api/projects/${pins.projectId}/tasks`,{asset_revision_id:pins.assetRevisionId,ontology_version_id:pins.ontologyId,assignee_id:writer.userId});
    expect(task.status).toBe(200);const taskId=id(task.json,'task_id');
    const lease=await writer.api.request<{fencing_token:number}>('POST',`/api/tasks/${taskId}/lease`,{action:'acquire'});
    expect(lease.status).toBe(200);
    const request=(state:string):SaveRequest=>({operation_id:crypto.randomUUID(),base_revision_id:initial.annotation_revision_id,document:{...initial.document,completion:'in_progress',objects:[{...person,attributes:{helmet_state:state}}]},lease:{task_id:taskId,fencing_token:lease.json.fencing_token},suggestion_decisions:[]});
    const left=request('wearing'),right=request('not_wearing');
    const responses=await Promise.all([writer.api.request<SaveResponse>('PUT',`/api/assets/${pins.assetRevisionId}/annotation`,left),secondSession.api.request<SaveResponse>('PUT',`/api/assets/${pins.assetRevisionId}/annotation`,right)]);
    expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
    const winner=responses[0].status===200?left:right;
    const committed=await head(admin,pins.assetRevisionId,pins.ontologyId);
    expect(committed.document).toEqual(winner.document);
    expect(committed.parent_revision_id).toBe(initial.annotation_revision_id);
    expect(committed.revision_no).toBe(initial.revision_no+1);
    const replay=await writer.api.request<SaveResponse>('PUT',`/api/assets/${pins.assetRevisionId}/annotation`,winner);
    expect(replay.status).toBe(200);expect(replay.json.idempotent_replay).toBe(true);expect(replay.json.revision).toEqual(committed);
    const reused=await writer.api.request<{code:string}>('PUT',`/api/assets/${pins.assetRevisionId}/annotation`,{...winner,document:{...winner.document,completion:'complete'}});
    expect(reused.status).toBe(409);expect(reused.json.code).toBe('IDEMPOTENCY_KEY_REUSE');
    const replacement=await addMember(admin,app.base_url,pins.projectId,'annotator');
    const transfer=await admin.request<{fencing_token:number}>('POST',`/api/tasks/${taskId}/lease`,{action:'transfer',holder_id:replacement.userId});
    expect(transfer.status).toBe(200);expect(transfer.json.fencing_token).toBeGreaterThan(lease.json.fencing_token);
    const stale=await replacement.api.request<{code:string}>('PUT',`/api/assets/${pins.assetRevisionId}/annotation`,{...winner,operation_id:crypto.randomUUID(),base_revision_id:committed.annotation_revision_id});
    expect(stale.status).toBe(409);expect(stale.json.code).toBe('STALE_FENCING_TOKEN');
    // Exact expired fixture time, not a shorter production lease duration or changed threshold.
    const db=new DatabaseSync(database_path_for_test(app));
    try{db.prepare('UPDATE task_leases SET expires_at=1577836800 WHERE task_id=?').run(taskId);}finally{db.close();}
    const expired=await replacement.api.request<{code:string}>('PUT',`/api/assets/${pins.assetRevisionId}/annotation`,{...winner,operation_id:crypto.randomUUID(),base_revision_id:committed.annotation_revision_id,lease:{task_id:taskId,fencing_token:transfer.json.fencing_token}});
    expect(expired.status).toBe(409);expect(expired.json.code).toBe('LEASE_EXPIRED');
    expect(await head(admin,pins.assetRevisionId,pins.ontologyId)).toEqual(committed);
    const inspect=new DatabaseSync(database_path_for_test(app));
    try{expect(inspect.prepare('SELECT count(*) AS n FROM annotation_revisions WHERE asset_revision_id=?').get(pins.assetRevisionId)?.n).toBe(2);}finally{inspect.close();}
    await writeEvidence('cas-fencing',{api_port:new URL(app.base_url).port,initial,committed,response_statuses:responses.map(r=>r.status),operation_ids:[left.operation_id,right.operation_id],stale:stale.json,expired:expired.json});
  }finally{await app.stop();}
},30000);

it('F09/F17 real SQLite timeout and killed owned API preserve atomic revision and replay after restart',async()=>{
  const app=await start_test_app();
  let service:PersistentApi|undefined;
  try{
    const admin=await bootstrap_admin_for_test(app),pins=await seed(admin,app);
    const owner=await addMember(admin,app.base_url,pins.projectId,'admin');
    const before=await head(admin,pins.assetRevisionId,pins.ontologyId);
    service=await persistentCopy(app,path.resolve(`reports/T30/runtime/crash-${crypto.randomUUID()}`));
    await service.start();
    let client=(await loginClient(service.base,owner.username,owner.password)).api;
    const body:SaveRequest={operation_id:crypto.randomUUID(),base_revision_id:before.annotation_revision_id,document:{...before.document,completion:'in_progress',objects:[person]},lease:null,suggestion_decisions:[]};
    const db=new DatabaseSync(service.database);db.exec('BEGIN IMMEDIATE');
    try{
      const timeout=await client.request<{code:string}>('PUT',`/api/assets/${pins.assetRevisionId}/annotation`,body);
      expect(timeout.status).toBe(503);expect(timeout.json.code).toBe('SAVE_UNAVAILABLE');
      expect(db.prepare('SELECT count(*) AS n FROM annotation_revisions WHERE asset_revision_id=?').get(pins.assetRevisionId)?.n).toBe(1);
      const pendingFailure=expect(client.request('PUT',`/api/assets/${pins.assetRevisionId}/annotation`,body)).rejects.toThrow();
      // Real request must reach the locked service before it is killed; no artificial successful response.
      await delay(100);
      await service.crash();
      await pendingFailure;
    }finally{db.exec('ROLLBACK');db.close();}
    await service.start();client=(await loginClient(service.base,owner.username,owner.password)).api;
    expect(await head(client,pins.assetRevisionId,pins.ontologyId)).toEqual(before);
    const saved=await client.request<SaveResponse>('PUT',`/api/assets/${pins.assetRevisionId}/annotation`,body);
    expect(saved.status).toBe(200);expect(saved.json.idempotent_replay).toBe(false);expect(saved.json.revision.document).toEqual(body.document);
    await service.crash();await service.start();client=(await loginClient(service.base,owner.username,owner.password)).api;
    const replay=await client.request<SaveResponse>('PUT',`/api/assets/${pins.assetRevisionId}/annotation`,body);
    expect(replay.status).toBe(200);expect(replay.json.idempotent_replay).toBe(true);expect(replay.json.revision).toEqual(saved.json.revision);
    const inspect=new DatabaseSync(service.database);
    try{expect(inspect.prepare('SELECT count(*) AS n FROM annotation_revisions WHERE asset_revision_id=?').get(pins.assetRevisionId)?.n).toBe(2);expect(inspect.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');}finally{inspect.close();}
    await writeEvidence('atomic-crash-restart',{api_port:new URL(service.base).port,operation_id:body.operation_id,before,committed:saved.json.revision,replay:replay.json});
  }finally{await service?.stop();await app.stop();}
},30000);

it('F10/F12/F13 export ACK disconnect then changed head keeps original approved snapshot and download bytes',async()=>{
  const app=await start_test_app();
  const proxy=createServer();
  try{
    const admin=await bootstrap_admin_for_test(app),pins=await seed(admin,app);
    // T25 seed forbids self-review; use a real independent reviewer.
    const reviewer=await addMember(admin,app.base_url,pins.projectId,'reviewer');
    const original=await head(admin,pins.assetRevisionId,pins.ontologyId);
    const saved=await admin.request<SaveResponse>('PUT',`/api/assets/${pins.assetRevisionId}/annotation`,{operation_id:crypto.randomUUID(),base_revision_id:original.annotation_revision_id,document:{...original.document,completion:'complete',objects:[{...person,attributes:{helmet_state:'wearing'}}]},lease:null,suggestion_decisions:[]});
    expect(saved.status).toBe(200);const pinned=saved.json.revision;
    const actor=id((await admin.request('GET','/api/session')).json,'user_id');
    const task=await admin.request('POST',`/api/projects/${pins.projectId}/tasks`,{asset_revision_id:pins.assetRevisionId,ontology_version_id:pins.ontologyId,assignee_id:actor});expect(task.status).toBe(200);
    const taskId=id(task.json,'task_id');expect((await admin.request('POST',`/api/tasks/${taskId}/lease`,{action:'acquire'})).status).toBe(200);
    const submitted=await admin.request('POST',`/api/tasks/${taskId}/submit`,{annotation_revision_ids:[pinned.annotation_revision_id]});expect(submitted.status).toBe(200);
    const reviewId=id(submitted.json,'review_id');expect((await reviewer.api.request('POST',`/api/reviews/${reviewId}/decision`,{decision:'approve',reason:'T30 immutable revision approval',revision_ids:[pinned.annotation_revision_id]})).status).toBe(200);
    const snapshotBody={operation_id:crypto.randomUUID(),ontology_version_id:pins.ontologyId,items:[{asset_revision_id:pins.assetRevisionId,annotation_revision_id:pinned.annotation_revision_id,split:'train'}],excluded:[],split_seed:null,split_ratios:null};
    const snapshot=await admin.request('POST',`/api/projects/${pins.projectId}/dataset-versions`,snapshotBody);expect(snapshot.status).toBe(201);const dataset=id(snapshot.json,'dataset_version_id');
    const exportPath=`/api/dataset-versions/${dataset}/exports`,exportBody={format:'native',loss_ack:false,operation_id:crypto.randomUUID()};
    const committedAck=Promise.withResolvers<Record<string,unknown>>();
    proxy.on('request',async(request,response)=>{request.resume();try{const committed=await admin.request('POST',exportPath,exportBody);if(committed.status!==202)throw new Error(JSON.stringify(committed));committedAck.resolve(jsonObject(committed.json));response.destroy();}catch(error){committedAck.reject(error);response.destroy();}});
    const listening=Promise.withResolvers<void>();proxy.listen(0,'127.0.0.1',listening.resolve);await listening.promise;
    const address=proxy.address();if(!address||typeof address==='string')throw new Error('Missing disconnect proxy port');
    await expect(fetch(`http://127.0.0.1:${address.port}/export`,{method:'POST'})).rejects.toThrow();
    const queued=await committedAck.promise;
    const nextTask=await admin.request('POST',`/api/projects/${pins.projectId}/tasks`,{asset_revision_id:pins.assetRevisionId,ontology_version_id:pins.ontologyId,assignee_id:actor});expect(nextTask.status).toBe(200);
    const nextTaskId=id(nextTask.json,'task_id'),nextLease=await admin.request<{fencing_token:number}>('POST',`/api/tasks/${nextTaskId}/lease`,{action:'acquire'});expect(nextLease.status).toBe(200);
    const changed=await admin.request<SaveResponse>('PUT',`/api/assets/${pins.assetRevisionId}/annotation`,{operation_id:crypto.randomUUID(),base_revision_id:pinned.annotation_revision_id,document:{...pinned.document,objects:[{...person,attributes:{helmet_state:'not_wearing'}}]},lease:{task_id:nextTaskId,fencing_token:nextLease.json.fencing_token},suggestion_decisions:[]});expect(changed.status).toBe(200);
    const unapproved=await admin.request<{code:string}>('POST',`/api/projects/${pins.projectId}/dataset-versions`,{...snapshotBody,operation_id:crypto.randomUUID(),items:[{...snapshotBody.items[0],annotation_revision_id:changed.json.revision.annotation_revision_id}]});
    expect(unapproved.status).toBe(422);expect(unapproved.json.code).toBe('SNAPSHOT_NOT_APPROVED');
    const replay=await admin.request('POST',exportPath,exportBody);expect(replay.status).toBe(200);expect(id(replay.json,'job_id')).toBe(id(queued,'job_id'));
    const reuse=await admin.request<{code:string}>('POST',exportPath,{...exportBody,format:'yolo',loss_ack:true});expect(reuse.status).toBe(409);expect(reuse.json.code).toBe('IDEMPOTENCY_KEY_REUSE');
    let result:Record<string,unknown>={};
    await expect.poll(async()=>{const job=await admin.request('GET',`/api/jobs/${id(queued,'job_id')}`);expect(job.status).toBe(200);const row=jsonObject(job.json);if(row.state==='succeeded')result=jsonObject(row.result);return row.state;},{timeout:15000}).toBe('succeeded');
    const downloadMember=await addMember(admin,app.base_url,pins.projectId,'annotator');
    const download=await fetch(new URL(id(result,'download_url'),app.base_url),{headers:{cookie:downloadMember.cookie,origin:app.base_url}});expect(download.status).toBe(200);
    const reader=download.body!.getReader();await reader.read();await reader.cancel();
    const retry=await fetch(new URL(id(result,'download_url'),app.base_url),{headers:{cookie:downloadMember.cookie,origin:app.base_url}});expect(retry.status).toBe(200);
    const bytes=new Uint8Array(await retry.arrayBuffer());expect(createHash('sha256').update(bytes).digest('hex')).toBe(result.object_sha256);
    await mkdir('reports/T30/runtime',{recursive:true});const archive=path.resolve(`reports/T30/runtime/export-${crypto.randomUUID()}.zip`);await writeFile(archive,bytes);
    const parsed=JSON.parse(execFileSync(process.env.PYTHON??'python',['-c','import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({"manifest":json.loads(z.read("manifest.json")),"revision":json.loads(z.read("annotations/"+sys.argv[2]+".json"))}))',archive,pins.assetRevisionId],{encoding:'utf8'}));
    const manifestItems=parsed.manifest.items as Record<string,unknown>[];
    expect(manifestItems.map(item=>({asset_revision_id:item.asset_revision_id,annotation_revision_id:item.annotation_revision_id,split:item.split}))).toEqual(snapshotBody.items);
    expect(manifestItems[0]).toMatchObject({annotation_content_hash:pinned.content_hash,review_id:reviewId,review_status:'approved',review_reason:'T30 immutable revision approval'});
    expect(parsed.revision).toEqual(pinned);
    expect((await head(admin,pins.assetRevisionId,pins.ontologyId)).document.objects[0].attributes.helmet_state).toBe('not_wearing');
    await writeEvidence('export-disconnect',{api_port:new URL(app.base_url).port,disconnect_proxy_port:address.port,operation_id:exportBody.operation_id,dataset_version_id:dataset,job_id:id(queued,'job_id'),pinned,changed_revision:changed.json.revision,download_sha256:result.object_sha256,parsed});
  }finally{proxy.closeAllConnections();const closed=Promise.withResolvers<void>();proxy.close(()=>closed.resolve());await closed.promise;await app.stop();}
},30000);

it('F17/F23 actual supervised Node host times out once, preserves unknown cost across restart and allows manual revision',async()=>{
  const app=await start_test_app(),provider=await silentProvider();
  let service:PersistentApi|undefined;
  try{
    const admin=await bootstrap_admin_for_test(app),pins=await seed(admin,app),owner=await addMember(admin,app.base_url,pins.projectId,'admin');
    const capabilities={image_input:true,tools:true,structured_output:true,bbox_output:true,attributes:true};
    const config={profile_id:'t30-silent-provider',model_id:'engineering-synthetic-model',credential:{secret_ref:'env:T30_SYNTHETIC_KEY'},account_model_verified:true,capabilities,api_base:provider.base,base_approval:{approved:true,approved_by:'engineering-admin',approved_at:'2026-10-06T00:00:00Z',allow_private_network:true,allow_insecure_http:true},local_admins:['engineering-admin']};
    const db=new DatabaseSync(database_path_for_test(app));
    try{db.prepare("INSERT INTO model_profiles(profile_id,provider_id,model_id,auth_kind,capabilities_json,availability,verification,runtime_version,verified_at,config_json,secret_ref,created_at) VALUES(?,'mimo_api',?,'api_key',?,'ready','not_run',NULL,NULL,?,'env:T30_SYNTHETIC_KEY','2026-10-06T00:00:00Z')").run(config.profile_id,config.model_id,JSON.stringify(capabilities),JSON.stringify(config));}finally{db.close();}
    expect((await admin.request('PUT',`/api/projects/${pins.projectId}/external-processing-policy`,{allow_external_processing:true})).status).toBe(200);
    service=await persistentCopy(app,path.resolve(`reports/T30/runtime/model-${crypto.randomUUID()}`));
    const setup=async(base:string)=>{
      const file=path.resolve('reports/T30/runtime/t30-host.json');
      // Keep default provider HTTP timeout 60000ms and production parent deadline 120s unchanged.
      await writeFile(file,JSON.stringify({apiBase:base,timeoutMs:120000,providers:[{provider:'mimo_api',config}]}));
      return {WEBLABEL_HOST_EXECUTABLE:process.execPath,WEBLABEL_HOST_CWD:path.resolve('reports/T30/runtime'),WEBLABEL_HOST_CONFIG:file,WEBLABEL_HOST_SCRIPT:path.resolve('target/agent-host/runtime.mjs'),WEBLABEL_HOST_ALLOWED_ENV:'T30_SYNTHETIC_KEY',T30_SYNTHETIC_KEY:'t30-synthetic-not-a-credential'};
    };
    await service.start(setup);
    let client=(await loginClient(service.base,owner.username,owner.password)).api;
    const authorized=await authorize(client,startRunBody(pins,crypto.randomUUID(),'Synthetic timeout, no business image',{profile_id:config.profile_id}));
    const queued=await client.request('POST','/api/ai/runs',authorized);expect(queued.status).toBe(202);const runId=id(queued.json,'run_id');
    let events:Record<string,unknown>={};
    await expect.poll(async()=>{const response=await client.request('GET',`/api/ai/runs/${runId}/events`);expect(response.status).toBe(200);events=jsonObject(response.json);return jsonObject(events.run).state;},{timeout:80000,interval:500}).toBe('failed');
    expect(provider.calls()).toBe(1);expect(jsonObject(events.run).cost_display).toBe('unknown');
    const eventItems=events.items;if(!Array.isArray(eventItems))throw new Error('No events');expect(eventItems.map(item=>jsonObject(item).type)).toContain('failed');
    const before=await head(client,pins.assetRevisionId,pins.ontologyId);
    expect(before.annotation_revision_id).toBe(pins.annotationRevisionId);
    const saved=await client.request<SaveResponse>('PUT',`/api/assets/${pins.assetRevisionId}/annotation`,{operation_id:crypto.randomUUID(),base_revision_id:before.annotation_revision_id,document:{...before.document,objects:[person],completion:'in_progress'},lease:null,suggestion_decisions:[]});expect(saved.status).toBe(200);expect(saved.json.revision.document.objects).toEqual([person]);
    await service.crash();await service.start(setup);client=(await loginClient(service.base,owner.username,owner.password)).api;
    for(let index=0;index<4;index+=1){const polled=await client.request('GET',`/api/ai/runs/${runId}/events`);expect(jsonObject(polled.json).run).toMatchObject({state:'failed',cost_display:'unknown'});await delay(500);}
    expect(provider.calls()).toBe(1);expect(await head(client,pins.assetRevisionId,pins.ontologyId)).toEqual(saved.json.revision);
    const inspection=new DatabaseSync(service.database);try{expect(inspection.prepare('SELECT count(*) AS n FROM predictions WHERE run_id=?').get(runId)?.n).toBe(0);expect(inspection.prepare('SELECT count(*) AS n FROM model_runs WHERE operation_id=?').get(authorized.operation_id as string)?.n).toBe(1);}finally{inspection.close();}
    await writeEvidence('model-timeout',{provider_port:new URL(provider.base).port,api_port:new URL(service.base).port,run_id:runId,operation_id:authorized.operation_id,events,provider_calls:provider.calls(),manual_revision:saved.json.revision,default_http_timeout_ms:60000,parent_deadline_ms:120000,verification:'synthetic loopback error path; no live provider call'});
  }finally{await service?.stop();await provider.stop();await app.stop();}
},100000);

for(const scenario of ['crash','oversized','spawn_child'] as const){
  it(`F17 real service supervises synthetic protocol ${scenario}, reclaims descendants, and manual saves stay atomic`,async()=>{
    const app=await start_test_app();let service:PersistentApi|undefined;
    try{
      const admin=await bootstrap_admin_for_test(app),pins=await seed(admin,app),owner=await addMember(admin,app.base_url,pins.projectId,'admin');
      const db=new DatabaseSync(database_path_for_test(app));
      try{db.prepare("INSERT INTO model_profiles SELECT 't30-fault-runtime','mimo_api','synthetic-fault-protocol','api_key',capabilities_json,'ready','not_run',NULL,NULL,'{}',NULL,created_at FROM model_profiles WHERE profile_id='profile_mock_local'").run();}finally{db.close();}
      expect((await admin.request('PUT',`/api/projects/${pins.projectId}/external-processing-policy`,{allow_external_processing:true})).status).toBe(200);
      const directory=path.resolve(`reports/T30/runtime/child-${scenario}-${crypto.randomUUID()}`),pidFile=path.join(directory,'pids.json');
      service=await persistentCopy(app,directory);
      const hostConfig=path.join(directory,'host.json');await writeFile(hostConfig,JSON.stringify({providers:[],timeoutMs:120000,apiBase:'http://127.0.0.1:1'}));
      await service.start({WEBLABEL_HOST_EXECUTABLE:process.execPath,WEBLABEL_HOST_SCRIPT:path.resolve('tests/support/fake-runtime.mjs'),WEBLABEL_HOST_CWD:directory,WEBLABEL_HOST_CONFIG:hostConfig,WEBLABEL_HOST_ALLOWED_ENV:'TEST_SCENARIO,FAKE_RUNTIME_PID_FILE,FAKE_RUNTIME_SPAWN_CHILD',TEST_SCENARIO:scenario,FAKE_RUNTIME_PID_FILE:pidFile,FAKE_RUNTIME_SPAWN_CHILD:'1'});
      const client=(await loginClient(service.base,owner.username,owner.password)).api;
      const before=await head(client,pins.assetRevisionId,pins.ontologyId);
      const approved=await authorize(client,startRunBody(pins,crypto.randomUUID(),'Explicit synthetic protocol fault, not live provider',{profile_id:'t30-fault-runtime'}));
      const queued=await client.request('POST','/api/ai/runs',approved);expect(queued.status).toBe(202);const runId=id(queued.json,'run_id');
      await expect.poll(async()=>{try{return JSON.parse(await readFile(pidFile,'utf8'));}catch{return null;}},{timeout:10000}).not.toBeNull();
      const processIds=jsonObject(JSON.parse(await readFile(pidFile,'utf8')));
      const rootPid=processIds.pid,descendant=processIds.grandchild_pid;
      if(typeof rootPid!=='number'||typeof descendant!=='number')throw new Error('Fixture did not report exact owned process IDs');
      if(scenario==='spawn_child'){expect(isProcessAlive(descendant)).toBe(true);expect((await client.request('POST',`/api/ai/runs/${runId}/cancel`,{})).status).toBe(200);}
      let events:Record<string,unknown>={};
      await expect.poll(async()=>{const result=await client.request('GET',`/api/ai/runs/${runId}/events`);expect(result.status).toBe(200);events=jsonObject(result.json);return jsonObject(events.run).state;},{timeout:20000}).toBe(scenario==='spawn_child'?'cancelled':'failed');
      await expect.poll(()=>({root:isProcessAlive(rootPid),descendant:isProcessAlive(descendant)}),{timeout:10000}).toEqual({root:false,descendant:false});
      expect(jsonObject(events.run).cost_display).toBe('unknown');
      const terminal=Array.isArray(events.items)?events.items.map(jsonObject).filter(event=>event.type===(scenario==='spawn_child'?'cancelled':'failed')):[];
      expect(terminal).toHaveLength(1);
      if(scenario==='spawn_child')expect(terminal[0].data).toMatchObject({reason:'user requested',cost_display:'unknown'});
      else expect(terminal[0].data).toMatchObject({code:scenario==='crash'?'HOST_CLOSED':'HOST_PROTOCOL'});
      expect(await head(client,pins.assetRevisionId,pins.ontologyId)).toEqual(before);
      expect((await client.request<{items:unknown[]}>('GET',`/api/ai/runs/${runId}/suggestions`)).json.items).toEqual([]);
      const saved=await client.request<SaveResponse>('PUT',`/api/assets/${pins.assetRevisionId}/annotation`,{operation_id:crypto.randomUUID(),base_revision_id:before.annotation_revision_id,document:{...before.document,completion:'in_progress',objects:[person]},lease:null,suggestion_decisions:[]});
      expect(saved.status).toBe(200);expect(saved.json.revision.document.objects).toEqual([person]);expect(saved.json.revision.parent_revision_id).toBe(before.annotation_revision_id);
      const inspect=new DatabaseSync(service.database);try{expect(inspect.prepare('SELECT count(*) AS n FROM annotation_revisions WHERE asset_revision_id=?').get(pins.assetRevisionId)?.n).toBe(2);}finally{inspect.close();}
      await writeEvidence(`child-${scenario}`,{verification:'synthetic protocol fixture through actual Rust production supervisor; not live provider',run_id:runId,operation_id:approved.operation_id,rootPid,descendant,events,before,saved:saved.json.revision,api_port:new URL(service.base).port});
    }finally{await service?.stop();await app.stop();}
  },40000);
}
