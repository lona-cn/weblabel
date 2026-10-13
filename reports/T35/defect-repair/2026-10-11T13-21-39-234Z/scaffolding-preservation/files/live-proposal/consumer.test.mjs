import { it as nodeIt } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import {resolve} from 'node:path';
import {aggregateLiveEvidence,parseLiveArguments} from './verify-live.mjs';
import {taskReportPath} from 'file:///D:/workspace/src/weblabel/tests/support/report-paths.mjs';
const root='D:/workspace/src/weblabel';
const it=Object.assign(nodeIt,{each:values=>(name,fn)=>{for(const value of values)nodeIt(name.replace('%s',value),()=>fn(value));}});


// Synthetic filesystem consumer fixtures only. Never provider/GPU/live/G4 evidence.
const consumerIdentity = {source_commit:'fixture-commit',source_snapshot_sha256:'a'.repeat(64),manifest_sha256:'b'.repeat(64),runner_sha256:'c'.repeat(64),source_hashes:{'fixture':'d'.repeat(64)}};
async function consumerFixture() {
  const directory = await mkdtemp(taskReportPath('T32','offline-consumer-'));
  const manifest = JSON.parse(await readFile(resolve(root,'tests/live/manifest.json'),'utf8'));
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  async function put(name,value,binary=false) { const bytes=binary?value:JSON.stringify(value); await writeFile(resolve(directory,name),bytes); return {path:name,sha256:hash(bytes)}; }
  const index={schema_version:1,evidence_kind:'required_channel_live_index',identity:consumerIdentity,channels:[]};
  const summaries=[];
  for (const required of manifest.required) {
    const provider=required.provider_id; const model=provider==='detector_local'?JSON.parse(await readFile(resolve(root,manifest.detector.lock_path),'utf8')).model_id:provider+'-full-fixture';
    const config={provider_id:provider,model_id:model};
    const capture={schema_version:1,evidence_kind:'actual_channel_live_capture',identity:consumerIdentity,provider_id:provider,requested_model_id:model,capture_status:'completed',run_error:null,run_configuration_sha256:hash(JSON.stringify(config)),public_config_artifact:await put(provider+'-config.json',config),host_config_artifact:await put(provider+'-host.json',{providers:[{provider}]}),samples:[],error_paths:{}};
    for (const sample of manifest.samples) {
      const prefix=provider+'-'+sample; const run_id=prefix+'-run';
      const receipt={provider_id:provider,actual_model_id:model,requested_model_id:model,auth_kind:required.auth_kind,response_id:prefix+'-response',runtime_version:'fixture-runtime',weights_loaded:provider==='detector_local'};
      const before={annotation_revision_id:prefix+'-before',document:{objects:[]}};
      const object={object_id:'object',label_id:'person',attributes:{},geometry:{kind:'bbox_xyxy',x1:0,y1:0,x2:1,y2:1}};
      const changes=[{kind:'create',change_id:'change',object}]; const set=prefix+'-set';
      const row={sample,run_id,terminal:'succeeded',receipt,receipts:[receipt],canonical_sha256:'e'.repeat(64),input_fingerprint:'f'.repeat(64),execution_configuration_hash:'1'.repeat(64),host_configuration_sha256:capture.host_config_artifact.sha256,human_visual_review:'Synthetic consumer oracle, not real visual review',accept_save:prefix+'-accept',undo_save:prefix+'-undo'};
      const bytes=Buffer.from('fixture-input'); row.source_sha256=hash(bytes); row.input_artifact=await put(prefix+'-input.png',bytes,true);
      row.preview_artifact=await put(prefix+'-preview.json',{execution_configuration_hash:row.execution_configuration_hash,request:{context:{input_fingerprint:row.input_fingerprint,canonical_sha256:row.canonical_sha256}}});
      row.start_artifact=await put(prefix+'-start.json',{run_id});
      row.observation_artifact=await put(prefix+'-events.json',{run_id,terminal:'succeeded',receipts:[receipt],events:[{run_id,seq:1,type:'succeeded',message:'synthetic',data:{receipts:[receipt]}}]});
      row.candidate_diff={suggestion_set_id:set,base_annotation_revision_id:before.annotation_revision_id,changes,screenshot:await put(prefix+'-diff.png',Buffer.from('fixture-screenshot'),true)};
      row.suggestion_artifact=await put(prefix+'-suggestion.json',{suggestion_set_id:set,model_run_id:run_id,context:{annotation_revision_id:before.annotation_revision_id},changes});
      row.before_artifact=await put(prefix+'-before.json',before);
      row.accept_artifact=await put(prefix+'-accepted.json',{request:{suggestion_decisions:[{suggestion_set_id:set,decision:'accept'}]},response:{revision:{annotation_revision_id:row.accept_save,document:{objects:[object]}}}});
      row.undo_artifact=await put(prefix+'-undone.json',{request:{suggestion_decisions:[{suggestion_set_id:set,decision:'revert'}]},response:{revision:{annotation_revision_id:row.undo_save,document:before.document}}});
      capture.samples.push(row);
    }
    for (const kind of ['quota_error','cancel','unsupported_image']) {
      const run_id=provider+'-'+kind; const terminal=kind==='cancel'?'cancelled':'failed'; const code=kind==='quota_error'?'quota_exceeded':'unsupported_image';
      const events=[{run_id,seq:1,type:terminal,message:'synthetic',data:{error_code:code}}];
      capture.error_paths[kind]={run_id,code};
      capture.samples.push({sample:'error-'+kind,run_id,terminal,observation_artifact:await put(run_id+'-events.json',{run_id,terminal,receipts:[],events})});
    }
    summaries.push(capture);
    index.channels.push({provider_id:provider,summaries:[await put(provider+'-summary.json',capture)]});
  }
  async function save() { for(let i=0;i<summaries.length;i++) index.channels[i].summaries=[await put(index.channels[i].provider_id+'-summary.json',summaries[i])]; await writeFile(resolve(directory,'index.json'),JSON.stringify(index)); }
  await save();
  return {directory,manifest,index,summaries,save,aggregate:()=>aggregateLiveEvidence(directory,{repository:root,manifest,identity:consumerIdentity,skipSecurity:true})};
}
it('four synthetic consumer channels can be non-security complete but never full-ready when scope skipped',async()=>{
  const f=await consumerFixture();try {const result=await f.aggregate();assert.equal(result.non_security_channels_complete,true);assert.equal(result.exit_code,2);assert.equal(result.status,'blocked');assert.equal(result.aggregation_model_calls,0);assert.ok(result.channels.every(c=>c.full_channel_evidence.missing.includes('tool_restriction:skipped_by_user')));}finally{await rm(f.directory,{recursive:true,force:true});}
});
it.each(['identity','field','provider','stale','diagnostic','fixture'])('offline consumer rejects %s without live operations',async(kind)=>{
  const f=await consumerFixture();try {
    if(kind==='identity') delete f.summaries[0].identity;
    if(kind==='field') delete f.summaries[0].samples[0].human_visual_review;
    if(kind==='provider') f.summaries[0].provider_id='anthropic_api';
    if(kind==='stale') f.summaries[0].identity={...consumerIdentity,runner_sha256:'9'.repeat(64)};
    if(kind==='diagnostic') f.summaries[0].evidence_kind='local_default_diagnostic_not_live';
    if(kind==='fixture') f.summaries[0].fixture=true;
    await f.save();const result=await f.aggregate();assert.equal(result.non_security_channels_complete,false);assert.equal(result.exit_code,2);
  }finally{await rm(f.directory,{recursive:true,force:true});}
});
it('offline consumer treats corrupt JSON and changed bytes as failures',async()=>{
  const f=await consumerFixture();try {
    await writeFile(resolve(f.directory,'index.json'),'{');assert.equal((await f.aggregate()).exit_code,1);
    await f.save();await writeFile(resolve(f.directory,f.index.channels[0].summaries[0].path),'{}');assert.equal((await f.aggregate()).exit_code,1);
  }finally{await rm(f.directory,{recursive:true,force:true});}
});
it('same-byte source committed later remains fresh while unexpected actual errors fail',async()=>{
  const f=await consumerFixture();try {
    f.summaries[0].identity={...consumerIdentity,source_commit:'later-commit'};await f.save();assert.equal((await f.aggregate()).non_security_channels_complete,true);
    f.summaries[0].run_error='UNEXPECTED_RUNTIME_FAILURE';await f.save();assert.equal((await f.aggregate()).exit_code,1);
  }finally{await rm(f.directory,{recursive:true,force:true});}
});

it('CLI modes reject ambiguity and duplicates',()=>{for(const args of [['--run','--live-evidence','x'],['--report-dir','x','--report-dir','y'],['--config','x'],['--bad'],['--skip-security','--skip-security']]) assert.throws(()=>parseLiveArguments(args));assert.equal(parseLiveArguments(['--run']).mode,'run');});
