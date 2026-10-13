import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createInterface} from 'node:readline';
const root='D:/workspace/src/weblabel', own=import.meta.dirname;
const run='smoke-'+Date.now(), runtime=path.join(own,run+'-runtime'), report=path.join(own,run+'-report');
const gate=JSON.parse(await fs.readFile(path.join(root,'reports/T35/defect-repair/2026-10-11T13-21-39-234Z/gate-integration-current/result.json'),'utf8'));
const build=gate.commands.find(c=>c.name==='integration-api-build');
const target=build.argv[build.argv.indexOf('--target-dir')+1];
const keys=['PATH','Path','PATHEXT','SystemRoot','WINDIR','COMSPEC','USERPROFILE','HOME','APPDATA','LOCALAPPDATA','PNPM_HOME','COREPACK_HOME','CARGO_HOME','RUSTUP_HOME','RUSTUP_TOOLCHAIN','RUSTC','RUSTDOC','VCINSTALLDIR','WindowsSdkDir','INCLUDE','LIB','LIBPATH','PYTHON'];
const env=Object.fromEntries(keys.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
Object.assign(env,{WEBLABEL_API_BINARY:path.join(target,'debug/weblabel-api.exe'),WEBLABEL_WASM_BRIDGE_DIR:path.join(root,'crates/wasm-bridge/target/weblabel-web-public/wasm')});
const child=spawn(process.execPath,[path.join(own,'service.mjs'),root,runtime,report],{cwd:root,env,stdio:['pipe','pipe','pipe'],windowsHide:true});
const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
const evidence={kind:'API_only_service_and_three_ZIP_oracle_smoke_not_UI_not_final_source',events:[],stderr:'',report:path.relative(root,report),runtime:path.relative(root,runtime)};
child.stderr.on('data',b=>{evidence.stderr+=b.toString();});
const timer=setTimeout(()=>{child.stdin.write('{"command":"stop"}\n');child.stdin.end();},120000);
try {
 for await(const line of createInterface({input:child.stdout,crlfDelay:Infinity})) {
  let event;try{event=JSON.parse(line);}catch{continue;}
  evidence.events.push(event);
  if(event.event==='ready')child.stdin.write('{"command":"api_oracle_smoke"}\n');
  if(event.event==='command_complete'||event.event==='command_failed')child.stdin.write('{"command":"stop"}\n');
 }
 evidence.exit=await closed;
 evidence.status=evidence.exit.code===0&&evidence.events.some(e=>e.event==='command_complete'&&e.command==='api_oracle_smoke')?'passed':'failed';
} finally {clearTimeout(timer);await fs.writeFile(path.join(own,'smoke-result.json'),JSON.stringify(evidence,null,2));}
console.log(JSON.stringify({status:evidence.status,exit:evidence.exit,report:evidence.report,events:evidence.events.map(e=>({event:e.event,command:e.command,cleanup:e.cleanup,result:e.command==='api_oracle_smoke'?e.result:undefined})),stderr:evidence.stderr}));
process.exitCode=evidence.status==='passed'?0:1;
