import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = 'D:/workspace/src/weblabel';
const report = path.join(root, 'reports/T35/release-audit-20261011-18172d5');
const scratch = path.join(root, 'target/build-cache/release-audit-20261011');
const nodeDir = path.join(root, 'target/t31-node-runtime-v24.16.0/node-v24.16.0-win-x64');
for (const p of [report,scratch,path.join(report,'logs'),path.join(scratch,'tmp')]) fs.mkdirSync(p,{recursive:true});
for (const p of [report,scratch,nodeDir]) if (!fs.realpathSync(p).toLowerCase().startsWith(fs.realpathSync(root).toLowerCase()+path.sep)) throw new Error('outside project');
const env = {...process.env,PATH:nodeDir+path.delimiter+process.env.PATH,TEMP:path.join(scratch,'tmp'),TMP:path.join(scratch,'tmp'),TMPDIR:path.join(scratch,'tmp'),CARGO_TARGET_DIR:path.join(root,'target/build-cache/release-rc2/native'),RUSTUP_TOOLCHAIN:'1.96.0',RUSTC:'D:/cache/cargo/toolchains/1.96.0-x86_64-pc-windows-msvc/bin/rustc.exe'};
for(const k of Object.keys(env)) if(k.startsWith('WEBLABEL_')) delete env[k];
const sha = p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const git = args=>spawnSync('git',args,{cwd:root,encoding:'utf8'});
if(process.argv[2]==='baseline') {
 const tracked=git(['ls-files','-z']).stdout.split('\0').filter(Boolean);
 const files=tracked.map(p=>({path:p,exists:fs.existsSync(path.join(root,p)),sha256:fs.existsSync(path.join(root,p))?sha(path.join(root,p)):null}));
 const status=git(['status','--porcelain=v1','-uall']);
 const diff=git(['diff','--binary']);
 fs.writeFileSync(path.join(report,'baseline-diff.patch'),diff.stdout);
 const baseline={time:new Date().toISOString(),tree:'working_tree',head:git(['rev-parse','HEAD']).stdout.trim(),status:status.stdout,contract_sha256:sha(path.join(root,'docs/contracts.md')),environment:{platform:process.platform,arch:process.arch,node:process.version,node_executable:process.execPath,temp:env.TEMP,cargo_target:env.CARGO_TARGET_DIR},physical_paths:[root,report,scratch,nodeDir,env.CARGO_TARGET_DIR].map(p=>({path:p,real:fs.existsSync(p)?fs.realpathSync(p):null})),files};
 fs.writeFileSync(path.join(report,'baseline.json'),JSON.stringify(baseline,null,2));
 const statusJson=JSON.parse(fs.readFileSync(path.join(root,'STATUS.json'),'utf8'));
 fs.writeFileSync(path.join(report,'status-snapshot.json'),JSON.stringify(statusJson,null,2));
 fs.writeFileSync(path.join(report,'tasks-snapshot.json'),fs.readFileSync(path.join(root,'TASKS.json')));
 console.log(JSON.stringify({baseline:path.join(report,'baseline.json'),status_keys:Object.keys(statusJson),tracked:files.length,environment:baseline.environment,physical_paths:baseline.physical_paths},null,2));
} else {
 const id=process.argv[2], executable=process.argv[3], args=process.argv.slice(4);
 const start=new Date().toISOString();
 const cwd=executable==='cargo'?'D:/cache/cargo/bin':root;
 const r=spawnSync(executable==='node'?path.join(nodeDir,'node.exe'):executable,args,{cwd,env,encoding:'utf8',maxBuffer:128*1024*1024,timeout:1800000});
 const raw=(r.stdout??'')+(r.stderr??'');
 const log=path.join(report,'logs',id+'.log'); fs.writeFileSync(log,raw);
 const entry={id,argv:[executable,...args],cwd,start,end:new Date().toISOString(),head:git(['rev-parse','HEAD']).stdout.trim(),baseline:'baseline.json',exit_code:r.status,signal:r.signal,error:r.error?.message??null,log:'logs/'+id+'.log',tests:{passed:null,failed:null,skipped:null},fixture:'engineering/programmatic only; no live provider authorization',node:process.version};
 fs.writeFileSync(path.join(report,'logs',id+'.json'),JSON.stringify(entry,null,2));
 console.log(JSON.stringify(entry,null,2)); console.log(raw); process.exitCode=r.status??1;
}
