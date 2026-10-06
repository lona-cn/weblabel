import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const report = import.meta.dirname, root = path.resolve(report, '../..');
const commands = [];
let logs = '';
for (const name of fs.readdirSync(report).filter(name => name.endsWith('.json')).sort()) {
  const file = path.join(report,name); let value; try { value=JSON.parse(fs.readFileSync(file,'utf8')); } catch { continue; }
  if (!Array.isArray(value.argv) || !Object.hasOwn(value,'exit_code')) continue;
  const logName=name.slice(0,-5)+'.log'; const output=fs.existsSync(path.join(report,logName))?fs.readFileSync(path.join(report,logName),'utf8'):'';
  const line=output.replace(/\u001b\[[0-9;]*m/g,'').split(/\r?\n/).find(line=>/^\s*Tests\s+/.test(line));
  const counts={tests_passed:line?Number(line.match(/(\d+) passed/)?.[1]??0):null,tests_failed:line?Number(line.match(/(\d+) failed/)?.[1]??0):null,tests_skipped_or_filtered:line?Number(line.match(/(\d+) skipped/)?.[1]??0):null};
  commands.push({...value,...counts,test_status:line?'实际运行':'未运行（非测试命令或未收集）',log_path:`reports/T33/${logName}`});
  logs+=`\n===== ${name} ${JSON.stringify(value)} =====\n${output}`;
}
fs.writeFileSync(path.join(report,'tests.log'),logs);
const head=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',shell:false});if(head.status!==0)throw new Error('source_commit_missing');
const final=commands.find(command=>command.log_path==='reports/T33/registered-final.log');
if(!final||final.exit_code!==0||final.tests_passed!==6||final.tests_failed!==0||final.tests_skipped_or_filtered!==0)throw new Error('full_registered_evidence_not_complete');
const smoke=JSON.parse(fs.readFileSync(path.join(report,'actual-cli-data-smoke.json'),'utf8'));if(smoke.error||!smoke.observations.authenticated_snapshot_download)throw new Error('actual_cli_data_smoke_not_complete');
const release=process.argv[2];if(!release)throw new Error('release_path_required');fs.copyFileSync(path.join(release,'release.json'),path.join(report,'release-manifest.json'));
const result={task_id:'T33',status:'review',base_commit:'05cc4ce7f14a715b99ebb7fb435a38fe86542064',artifact_kind:'source_commits',artifact_ref:head.stdout.trim(),changed_files:['scripts/build.mjs','scripts/start-local.mjs','scripts/doctor.mjs','scripts/backup.mjs','scripts/restore.mjs','tests/integration/t33_packaging.test.ts','docs/getting-started.md','docs/operations.md','docs/backup-restore.md','docs/known-limitations.md','README.md','reports/T33/**'],commands,contract_changes:[{kind:'Main-only integration',proposal:'reports/T33/integration.patch',summary:'root build/start/backup/restore commands; remove obsolete dev local wrapper and verify build/postBuildBlocker'},{kind:'Main-owned API integration',summary:'strict restore-auth mode creates fresh unique local admin with all restored project memberships; dedicated production media-import worker discovered by actual release test'}],known_limits:['Windows x64 source release, not signed exe/installer or bit-for-bit binary reproducibility','No G4/model/account/GPU/performance acceptance inferred; T32 five live channels blocked','Backup is local operator whole-store action, unencrypted/unsigned, excludes unsynced browser drafts and credential directories; no automatic GC','Windows tree termination is forced with SQLite WAL crash-consistency, not remote model cancellation acknowledgement','Actual console Ctrl+C harness reported exit512; postcheck observed listener/lock cleanup and integrity ok, not an invented exit130','Full registered acceptance uses freshly composed release; optional explicit release override is recorded rather than treated as proof of freshness by itself'],external_blockers:[]};
result.contract_changes.push({kind:'existing C1 ApiError consumption',summary:'Local proxy rejects hostile Host/Origin with LOOPBACK_ORIGIN_DENIED/403 and unavailable upstream with API_UNAVAILABLE/503 using existing code/message/request_id/details shape; no DTO change'});
result.integration_source_used='57690326012bd35c79fc6d7c8b71a03a618d64ff';
result.release_provenance=JSON.parse(fs.readFileSync(path.join(release,'release.json'),'utf8')).source_commit;
result.known_limits.push('Fresh compiled release source c11dcfa includes Main 576903 auth/media fixes; subsequent 409d614 backup guard is interpreted CLI source and is exercised by registered-final. Compiler retains pre-existing unused_mut/dead DRAIN_MAX_JOBS and cache build.rust-wrapper warnings.');
result.known_limits.push('Actual physical Ctrl+C proof covers core API/Web; actual nested process-tree proof covers stopTree. Active Host physical Ctrl+C ownership race in earlier Main API RuntimeLease shutdown is not claimed fixed by these tests.');
result.external_blockers.push('Main-owned final active-Host graceful shutdown source/proof was requested; not available at evidence publication. Main must integrate/rebuild/replay that path before claiming the full active-Host SIGINT criterion.');
fs.writeFileSync(path.join(report,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({task_id:result.task_id,status:result.status,artifact_ref:result.artifact_ref,registered:final,smoke:smoke.observations},null,2));
