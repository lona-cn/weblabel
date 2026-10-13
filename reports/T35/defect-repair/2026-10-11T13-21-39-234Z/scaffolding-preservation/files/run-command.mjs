import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { captureEvidenceIdentity } from '../../../scripts/evidence-identity.mjs';
const root = fs.realpathSync(path.resolve(import.meta.dirname, '../../..'));
const R = path.join(root, 'reports/T35/defect-repair/2026-10-11T13-21-39-234Z');
const T = path.join(root, 'target/defect-repair/2026-10-11T13-21-39-234Z');
const B = path.join(root, 'target/build-cache/defect-repair/main');
for (const p of [R, path.join(T, 'runtime'), B]) fs.mkdirSync(p, { recursive: true });
const allowed = ['PATH','Path','PATHEXT','SystemRoot','WINDIR','COMSPEC','SystemDrive','USERPROFILE','HOME','APPDATA','LOCALAPPDATA','PNPM_HOME','COREPACK_HOME','CARGO_HOME','RUSTUP_HOME','RUSTUP_TOOLCHAIN','RUSTC','RUSTDOC','VCINSTALLDIR','WindowsSdkDir','INCLUDE','LIB','LIBPATH'];
const env = Object.fromEntries(allowed.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
env.PATH = path.dirname(process.execPath) + path.delimiter + (env.PATH ?? env.Path ?? '');
delete env.Path;
Object.assign(env, { TEMP: path.join(T,'runtime'), TMP: path.join(T,'runtime'), TMPDIR: path.join(T,'runtime'), CARGO_TARGET_DIR: B, CARGO_NET_OFFLINE:'true', RUSTUP_AUTO_INSTALL:'0', RUSTUP_TOOLCHAIN:'1.96.0', COREPACK_ENABLE_NETWORK:'0', WEBLABEL_TEST_REPORT_DIR: path.join(R,'tasks'), WEBLABEL_T30_TEST_ROOT: path.join(R,'tasks/T30'), WEBLABEL_SKIP_SECURITY:'1', WEBLABEL_T33_RELEASE: path.join(T,'release'), WEBLABEL_T30_HOST_SCRIPT: path.join(T,'host/runtime.mjs') });
// Existing installed toolchain; resolve, never install or change shared configuration.
env.RUSTC = execFileSync('rustup', ['which','--toolchain','1.96.0','rustc'], { cwd:'D:/cache/cargo/bin', env, encoding:'utf8', windowsHide:true }).trim();
env.WEBLABEL_CARGO_CWD = 'D:/cache/cargo/bin';
let [name, ...argv] = process.argv.slice(2);
if (name === 'baseline') {
  const identity = captureEvidenceIdentity();
  fs.writeFileSync(path.join(R,'baseline.json'), JSON.stringify({ project_root:root, captured_at:new Date().toISOString(), identity, original_changes:execFileSync('git',['status','--short'],{cwd:root,encoding:'utf8'}), credential_environment:'not_forwarded', account_state:'not_inspected', model_calls:0 },null,2));
  console.log(JSON.stringify({snapshot:identity.source_snapshot_sha256,source_files:Object.keys(identity.source_hashes).length}));
} else {
  if (!name || !argv.length) throw new Error('name and argv required');
  let cwd = root;
  if (argv[0] === '--cwd') { cwd = fs.realpathSync(path.resolve(root, argv[1])); argv.splice(0, 2); if (!cwd.startsWith(root + path.sep)) throw new Error('CWD_OUTSIDE_PROJECT'); }
  if (argv[0] === 'N') argv[0] = process.execPath;
  if (argv[0] === 'pnpm') argv = [process.execPath,path.join(env.APPDATA,'npm/node_modules/pnpm/bin/pnpm.cjs'),...argv.slice(1)];
  const log = path.join(R,`${name}.log`);
  const file = fs.createWriteStream(log, {flags:'wx'});
  const start = new Date().toISOString();
  const child = spawn(argv[0],argv.slice(1),{cwd,env,shell:false,windowsHide:true,stdio:['inherit','pipe','pipe']});
  for (const stream of [child.stdout,child.stderr]) stream.on('data',chunk=>{file.write(chunk);process.stdout.write(chunk);});
  const result = await new Promise(resolve=>{child.once('error',error=>resolve({exit_code:1,error:error.message}));child.once('close',(code,signal)=>resolve({exit_code:code,signal}));});
  await new Promise(resolve=>file.end(resolve));
  fs.writeFileSync(path.join(R,`${name}.json`),JSON.stringify({argv,cwd,start,end:new Date().toISOString(),...result,log_path:path.relative(root,log),log_sha256:createHash('sha256').update(fs.readFileSync(log)).digest('hex'),identity:captureEvidenceIdentity()},null,2));
  process.exitCode=result.exit_code??1;
}
