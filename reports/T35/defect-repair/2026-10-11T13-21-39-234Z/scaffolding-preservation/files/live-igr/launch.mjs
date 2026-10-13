import {spawn} from 'node:child_process';
import {writeFile,mkdir} from 'node:fs/promises';
const root="D:/workspace/src/weblabel",temp="target/defect-repair/2026-10-11T13-21-39-234Z/live-igr",report="target/worktrees/live-evidence-proposal/reports/T32/defect-repair/2026-10-11T13-21-39-234Z/igr-fix";
const env=Object.fromEntries(['PATH','Path','PATHEXT','SystemRoot','WINDIR','COMSPEC','USERPROFILE','HOME','APPDATA','LOCALAPPDATA'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
Object.assign(env,{TEMP:root+'/'+temp,TMP:root+'/'+temp,WEBLABEL_TEST_REPORT_DIR:root+'/'+temp+'/test-output-final'});
const args=[root+'/node_modules/vitest/vitest.mjs','run','--config',temp+'/vitest.config.mjs','--testNamePattern','offline consumer|four synthetic consumer|same-byte source|interrupt aborts','--reporter=json','--outputFile',report+'/vitest-final.json'];
const child=spawn(process.execPath,args,{cwd:root,env,shell:false});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
const [code,signal]=await new Promise(r=>child.on('exit',(...a)=>r(a)));await writeFile(report+'/vitest-final.stdout.log',stdout);await writeFile(report+'/vitest-final.stderr.log',stderr);console.log(JSON.stringify({argv:[process.execPath,...args],code,signal}));process.exitCode=code;
