import {expect,it} from 'vitest';
import {existsSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {DetectorLocalAdapter} from '../src/providers/detector-local';
import {isProcessAlive,reclaimProcessTree} from '../src/security/spawn';

async function fixture(mode:string,body:(adapter:DetectorLocalAdapter,pidPath:string)=>Promise<void>) {
 const dir=mkdtempSync(join(tmpdir(),'t18-lifecycle-'));const pidPath=join(dir,'pid');const started=Date.now();
 writeFileSync(join(dir,'lock.json'),JSON.stringify({model_id:'synthetic-lifecycle'}));writeFileSync(join(dir,'labels.json'),JSON.stringify({person:'person'}));
 const adapter=new DetectorLocalAdapter({spawnPolicy:{trusted_executable_roots:[dirname(process.execPath)],cwd_root:dir,allowed_env:['SystemRoot'],source_env:{SystemRoot:process.env.SystemRoot}},workerCommand:{executable:process.execPath,argv:[resolve('apps/agent-host/test/fixtures/detector-worker.mjs'),mode,pidPath]},workerCwd:dir,lockPath:join(dir,'lock.json'),labelMapPath:join(dir,'labels.json'),imageSource:()=>({grant_id:'synthetic',region:null}),probeTimeoutMs:500,runTimeoutMs:500});
 try {await body(adapter,pidPath);}finally {
  if(existsSync(pidPath)){const pid=Number(readFileSync(pidPath,'utf8'));if(isProcessAlive(pid))await reclaimProcessTree({root_pid:pid,spawned_at_ms:started},'test backstop');}
  rmSync(dir,{recursive:true,force:true});
 }
}
async function bounded<T>(operation:Promise<T>):Promise<T> {
 // Real platform deadlines cannot be driven by fake time in a spawned Node child.
 let timer:NodeJS.Timeout|undefined;
 try{return await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('lifecycle exceeded 8s settle limit')),8000);})]);}finally{clearTimeout(timer);}
}
function gone(pidPath:string){const pid=Number(readFileSync(pidPath,'utf8'));expect(isProcessAlive(pid)).toBe(false);console.log(JSON.stringify({synthetic_lifecycle:true,pid,alive:false}));}

it('silent probe settles unavailable and reclaims its actual child',async()=>fixture('silent',async(adapter,pidPath)=>{
 const result=await bounded(adapter.probe());expect(result[0].availability).toBe('needs_configuration');gone(pidPath);
}),12000);
const input={intent:'detect'} as import('../../../packages/contracts/generated/StartRunRequest').StartRunRequest;
function context(rejectCandidate=false):import('../src/registry').RuntimeContext {
 return {run_id:'synthetic-run',read_region:async()=>({bytes:new Uint8Array([1]),mime:'image/png',transform_to_canonical:[1,0,0,1,0,0]}),get_ontology:async()=>({labels:[{label_id:'person'}]} as never),get_document:async()=>({coordinate_space:{width:640,height:480}} as never),submit_candidates:async()=>{if(rejectCandidate)throw Object.assign(new Error('candidate rejected'),{code:'invalid_candidate'});return {} as never;},report_issues:async()=>{}};
}
async function collect(adapter:DetectorLocalAdapter,signal:AbortSignal,ctx=context()) {
 const events=[];for await(const event of adapter.run(input,ctx,signal))events.push(event);return events;
}
it('silent run deadline settles once with run_timeout and reclaims child',async()=>fixture('silent',async(adapter,pidPath)=>{
 const events=await bounded(collect(adapter,new AbortController().signal));expect(events).toMatchObject([{type:'failed',data:{code:'run_timeout'}}]);gone(pidPath);
}),12000);
for(const mode of ['partial','response-hang','crash','malformed','normal','stderr-pressure']) {
 it('probe observes complete response and actual exit: '+mode,async()=>fixture(mode,async(adapter,pidPath)=>{
  const profiles=await bounded(adapter.probe());expect(profiles[0]).toMatchObject({availability:['normal','stderr-pressure'].includes(mode)?'ready':'needs_configuration',verification:'not_run'});gone(pidPath);
 }),12000);
}
for(const mode of ['partial','response-hang','crash','malformed','normal','stderr-pressure','candidate']) {
 it('run observes streams and exit exactly once: '+mode,async()=>fixture(mode,async(adapter,pidPath)=>{
  const events=await bounded(collect(adapter,new AbortController().signal));const terminal=events.filter(e=>['failed','cancelled','succeeded'].includes(e.type));
  expect(terminal).toHaveLength(1);expect(terminal[0]).toMatchObject(['normal','stderr-pressure','candidate'].includes(mode)?{type:'succeeded'}:{type:'failed',data:{code:mode==='crash'?'child_crashed':mode==='malformed'?'invalid_json':'run_timeout'}});gone(pidPath);
 }),12000);
}
it('candidate rejection reclaims child without a success terminal',async()=>fixture('candidate',async(adapter,pidPath)=>{
 const events=await bounded(collect(adapter,new AbortController().signal,context(true)));expect(events).toMatchObject([{type:'failed',data:{code:'invalid_candidate'}}]);gone(pidPath);
}),12000);
it('already cancelled run does not spawn a child',async()=>fixture('normal',async(adapter,pidPath)=>{
 const abort=new AbortController();abort.abort();expect(await collect(adapter,abort.signal)).toMatchObject([{type:'cancelled'}]);expect(existsSync(pidPath)).toBe(false);
}));
it('cancellation after actual child launch settles once and reclaims child',async()=>fixture('silent',async(adapter,pidPath)=>{
 const abort=new AbortController();const pending=collect(adapter,abort.signal);
 // Poll the fixture launch artifact, not a guessed platform startup duration.
 // Native realpath expands Windows 8.3 aliases; JS realpath retains them.
 const watch=await import('node:fs/promises');if(!existsSync(pidPath)){const watcher=watch.watch(realpathSync.native(dirname(pidPath)));try{for await(const _event of watcher){if(existsSync(pidPath))break;}}finally{await watcher.return?.();}}
 abort.abort();expect(await bounded(pending)).toMatchObject([{type:'cancelled'}]);gone(pidPath);
}),12000);
it('candidate deadline interrupts an uncooperative submission after worker exit',async()=>fixture('candidate',async(adapter,pidPath)=>{
 const submitted=Promise.withResolvers<never>();const ctx=context();ctx.submit_candidates=()=>submitted.promise;
 const pending=collect(adapter,new AbortController().signal,ctx);
 try {
  const events=await bounded(pending);expect(events).toMatchObject([{type:'failed',data:{code:'run_timeout'}}]);gone(pidPath);
  expect(existsSync(readFileSync(pidPath+'.stage','utf8'))).toBe(false);
 } finally {submitted.reject(new Error('test cleanup'));await pending;}
}),15000);
for (const behavior of ['delayed','never'] as const) for (const stop of ['deadline','cancel'] as const) {
 it('candidate '+behavior+' submission settles on '+stop+' and removes staging',async()=>fixture('candidate',async(adapter,pidPath)=>{
  const abort=new AbortController();const started=Promise.withResolvers<AbortSignal | undefined>();
  const submission=Promise.withResolvers<import('../../../packages/contracts/generated/SuggestionSet').SuggestionSet>();
  let timer:NodeJS.Timeout|undefined;const ctx=context();
  // Real 10s operation versus real 500ms child deadline cannot use fake time.
  ctx.submit_candidates=(_candidate,operationSignal)=>{started.resolve(operationSignal);if(behavior==='delayed')timer=setTimeout(()=>submission.resolve({} as never),10000);return submission.promise;};
  const pending=collect(adapter,abort.signal,ctx);
  try {
   const operationSignal=await bounded(started.promise);if(stop==='cancel')abort.abort();
   const events=await bounded(pending);expect(events).toMatchObject(stop==='cancel'?[{type:'cancelled'}]:[{type:'failed',data:{code:'run_timeout'}}]);
   expect(operationSignal?.aborted).toBe(true);gone(pidPath);
   const imagePath=readFileSync(pidPath+'.stage','utf8');expect(existsSync(dirname(imagePath))).toBe(false);
   console.log(JSON.stringify({candidate_operation:behavior,stop,staging_removed:true,operation_aborted:true}));
  } finally {clearTimeout(timer);submission.reject(new Error('late synthetic submission rejection'));await pending;}
 }),15000);
}
for(const stop of ['operation','run','none'] as const) {
 it('production candidate HTTP observes '+stop+' signal without model calls',async()=>{
  const {createServer}=await import('node:http');const {ServerRuntimeContext}=await import('../src/runtime/context');
  const received=Promise.withResolvers<void>();const closed=Promise.withResolvers<void>();let requests=0;
  const server=createServer((request,response)=>{
   request.resume();response.setHeader('content-type','application/json');
   if(request.url?.endsWith('get_context'))response.end(JSON.stringify({run_id:'synthetic-run',media:{width:640,height:480},ontology:{labels:[]},allow_image:false,allow_object_context:false,approved_grant_ids:[],approved_image_region:null}));
   else {requests++;response.once('close',()=>closed.resolve());received.resolve();if(stop==='none')response.end(JSON.stringify({suggestion_set_id:'synthetic-set',prediction_id:'synthetic-prediction',state:'pending'}));}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const runAbort=new AbortController(),operationAbort=new AbortController();
  try {
   const port=(server.address() as import('node:net').AddressInfo).port;
   const ctx=await ServerRuntimeContext.open({apiBase:'http://127.0.0.1:'+port,token:'synthetic-local-token',run_id:'synthetic-run',request:{...input,context:{asset_revision_id:'synthetic-asset',ontology_version_id:'synthetic-ontology'}} as never},runAbort.signal);
   const submission=ctx.submit_candidates({changes:[],issues:[],score:null},stop==='none'?undefined:operationAbort.signal);
   const settled=submission.then(value=>({value,error:null}),error=>({value:null,error}));
   await bounded(received.promise);
   if(stop==='operation')operationAbort.abort();else if(stop==='run')runAbort.abort();
   const result=await bounded(settled);if(stop==='none')expect(result.value).toMatchObject({suggestion_set_id:'synthetic-set'});else expect(result.error).toMatchObject({name:'AbortError'});
   await bounded(closed.promise);expect(requests).toBe(1);
   console.log(JSON.stringify({production_http:true,stop,request_observed:true,connection_closed:true,model_calls:0}));
  } finally {runAbort.abort();operationAbort.abort();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 },12000);
}
