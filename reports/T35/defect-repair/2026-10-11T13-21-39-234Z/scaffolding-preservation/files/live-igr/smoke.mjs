import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
const root="D:/workspace/src/weblabel",temp="target/defect-repair/2026-10-11T13-21-39-234Z/live-igr",report="target/worktrees/live-evidence-proposal/reports/T32/defect-repair/2026-10-11T13-21-39-234Z/igr-fix",script=temp+'/verify-live.mjs';
const env=Object.fromEntries(['PATH','Path','PATHEXT','SystemRoot','WINDIR','COMSPEC','USERPROFILE','HOME','APPDATA','LOCALAPPDATA'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
Object.assign(env,{TEMP:root+'/'+temp,TMP:root+'/'+temp,WEBLABEL_TEST_REPORT_DIR:root+'/'+temp+'/smoke-output'});
const commands=[];
async function command(name,exe,args,extra={}) {const started=Date.now();const child=spawn(exe,args,{cwd:root,env:{...env,...extra},shell:false});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const [code,signal]=await new Promise((r,j)=>{child.on('error',j);child.on('exit',(...a)=>r(a));});await writeFile(report+'/'+name+'.stdout.log',stdout);await writeFile(report+'/'+name+'.stderr.log',stderr);const row={name,argv:[exe,...args],code,signal,duration_ms:Date.now()-started,stdout:report+'/'+name+'.stdout.log',stderr:report+'/'+name+'.stderr.log'};commands.push(row);return row;}
for(const kind of ['missing','stale','corrupt']) {const dir=temp+'/offline-'+kind;await mkdir(dir,{recursive:true});if(kind==='stale') await writeFile(dir+'/index.json',JSON.stringify({schema_version:1,evidence_kind:'required_channel_live_index',identity:{},channels:[]}));if(kind==='corrupt')await writeFile(dir+'/index.json','{');const out=report+'/offline-'+kind;await mkdir(out,{recursive:true});const row=await command('offline-'+kind,process.execPath,[script,'--live-evidence',dir,'--report-dir',out,'--skip-security']);assert.equal(row.code,kind==='corrupt'?1:2);const aggregate=JSON.parse(await readFile(out+'/result.json','utf8'));assert.equal(aggregate.aggregation_model_calls,0);assert.equal(aggregate.outbound_model_calls,0);}
const requests=[];
const server=createServer((req,res)=>{requests.push(req.url);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({items:[{profile_id:'t32-openai',provider_id:'openai_api',model_id:'gpt-6-luna',auth_kind:'api_key',availability:'ready',verification:'not_run',runtime_version:null,verified_at:null,capabilities:{image_input:true,tools:true,structured_output:true,bbox_output:false,attributes:true}}]}));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
try {
 const port=server.address().port,base_url='http://127.0.0.1:'+port+'/';
 const host={apiBase:base_url.slice(0,-1),providers:[{provider:'openai_api',config:{profile_id:'t32-openai',model_id:'gpt-6-luna',credential:{secret_ref:'env:ENGINEERING_NONCREDENTIAL'},budgets:{max_tool_turns:2,max_total_bytes:65536,max_run_ms:10000,max_output_tokens:512,max_image_bytes:1048576,max_pixels:1000000,max_crops:1}}}]};
 const config={base_url,provider_id:'openai_api',profile_id:'t32-openai',model_id:'gpt-6-luna',host_config_path:temp+'/public-host.json',authorization:{provider_id:'openai_api',sample_set:'t32-programmatic-v1',allow_generated_images:true,allow_external_processing:true,expires_at:new Date(Date.now()+300000).toISOString(),max_model_runs:2,max_provider_calls_per_run:2,acknowledge_unknown_cost:true}};
 await writeFile(temp+'/public-host.json',JSON.stringify(host));await writeFile(temp+'/public-config.json',JSON.stringify(config));
 const out=report+'/interactive-interrupt-'+Date.now();const line=[process.execPath,script,'--run','--config',temp+'/public-config.json','--report-dir',out,'--skip-security'].map(v=>JSON.stringify(v)).join(' ');
 const row=await command('interactive-interrupt','powershell.exe',['-NoProfile','-File',temp+'/interrupt-conpty.ps1','-CommandLine',line],{WEBLABEL_LIVE_SESSION_COOKIE:'t32_engineering=noncredential',WEBLABEL_LIVE_CSRF:'t32-engineering-noncredential'});
 assert.equal(row.code,2);assert.deepEqual(requests,['/api/model-profiles']);
 const result=JSON.parse(await readFile(out+'/result.json','utf8'));const capture=JSON.parse(await readFile(root+'/'+result.evidence_path,'utf8'));const index=JSON.parse(await readFile(out+'/index.json','utf8'));
 assert.match(capture.run_error,/abort/i);assert.equal(capture.resources.terminal,'closed');assert.equal(capture.resources.browser,'not_opened');assert.equal(capture.samples.length,0);assert.equal(index.channels.find(c=>c.provider_id==='openai_api').summaries.length,1);assert.equal(result.outbound_model_calls,0);
} finally {await new Promise(r=>server.close(r));await writeFile(report+'/smoke-commands.json',JSON.stringify({commands,requests,actual_model_calls:0},null,2));}
console.log('Offline CLI 3/3; physical ConPTY interrupt persisted summary/index; model calls 0');
