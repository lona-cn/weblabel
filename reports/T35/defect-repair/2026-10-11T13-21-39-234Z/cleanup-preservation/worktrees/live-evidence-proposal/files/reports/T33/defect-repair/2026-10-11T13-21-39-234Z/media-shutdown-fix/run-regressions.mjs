import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const report=path.dirname(fileURLToPath(import.meta.url));
const env=Object.fromEntries(['SystemRoot','SystemDrive','WINDIR','PATH','PATHEXT','COMSPEC'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
const temp=path.join(report,'regression-temp');fs.mkdirSync(temp,{recursive:true});
Object.assign(env,{TEMP:temp,TMP:temp,TMPDIR:temp});
const commands=[];
for(const stage of ['before','after']){
 const argv=[path.join(report,`regression-${stage}.exe`),'--exact','long_windows_object_paths_publish_atomically_deduplicate_and_survive_reopen','--nocapture'];
 const result=spawnSync(argv[0],argv.slice(1),{cwd:'D:/workspace/src/weblabel',env,encoding:'utf8',shell:false,timeout:20000});
 fs.writeFileSync(path.join(report,`regression-${stage}.log`),result.stdout+result.stderr);
 commands.push({stage,argv,cwd:'D:/workspace/src/weblabel',env,exit_code:result.status,signal:result.signal,error:result.error?.message,log_path:`regression-${stage}.log`});
 console.log(stage+' exit '+result.status);console.log(result.stdout+result.stderr);
}
fs.writeFileSync(path.join(report,'regression-commands.json'),JSON.stringify({commands,outbound_model_calls:0,scope:'Exact new permanent consumer regression extracted into standalone harness, no project-wide build'},null,2));
if(commands[0].exit_code!==101||commands[1].exit_code!==0)process.exitCode=1;
