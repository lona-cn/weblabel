import fs from 'node:fs';
import { startupSmoke } from './startup-smoke.mjs';
const base = 'D:/workspace/src/weblabel/target/defect-repair/2026-10-11T13-21-39-234Z/startup-proposal';
const run = base + '/run-' + crypto.randomUUID(); fs.mkdirSync(run, { recursive: true }); fs.mkdirSync(run + '/temp');
const env = Object.fromEntries(['PATH','PATHEXT','SystemRoot','WINDIR','COMSPEC','USERPROFILE','HOME','APPDATA','LOCALAPPDATA'].filter(k => process.env[k]).map(k => [k,process.env[k]]));
Object.assign(env,{TEMP:run+'/temp',TMP:run+'/temp',TMPDIR:run+'/temp'});
const result = await startupSmoke('D:/workspace/src/weblabel/target/defect-repair/2026-10-11T13-21-39-234Z/release', {reportDir:run+'/report',temporary:run,env,identity:{evidence_scope:'old_source_helper_engineering_only_not_current_release_G3_G5',release_source_commit:'18172d5bd36932a7a202f174f1969e16dc055738'}});
console.log(JSON.stringify({run,result})); process.exitCode=result.runner_exit_code;
