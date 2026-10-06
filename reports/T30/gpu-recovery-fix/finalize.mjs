import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const report=import.meta.dirname,root=path.resolve(report,'../../..');
const base='efc611f61be0b0b8c6c5f1fd52b6ac6eb9adcfa0';
const source='95dad722c0da7b64124c28a49e821bc13db278e3';
const owned=['crates/renderer-wgpu/src/renderer.rs','crates/renderer-wgpu/Cargo.toml','crates/wasm-bridge/src/facade.rs','crates/wasm-bridge/Cargo.toml','apps/web/src/lib/editor/EditorHost.ts','apps/web/src/lib/editor/types.ts','apps/web/src/lib/editor/t09_lifecycle.test.ts','apps/web/src/features/workbench/CanvasView.tsx'];
await writeFile(path.join(report,'source.patch'),execFileSync('git',['diff','--binary',base,source,'--',...owned],{cwd:root}));
const commands=(await readFile(path.join(report,'commands.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
let failedDenseInvocation=0;
for(const command of commands){
 const argv=command.argv;
 command.tests_passed=command.exit_code!==0?0:argv.includes('test')&&argv.includes('annotation-domain')?108:argv.includes('vitest')?22:argv.includes('playwright')&&argv.includes('F14')?1:argv.includes('playwright')?2:0;
 command.tests_failed=argv.includes('playwright')&&command.exit_code!==0?(argv.includes('F14')?1:++failedDenseInvocation):0;
 command.log_path=command.log_path.replaceAll('\\','/');
}
const browser=JSON.parse(await readFile(path.join(report,'browser-results.json'),'utf8'));
const dense=JSON.parse(await readFile(path.join(report,'dense-results.json'),'utf8'));
if(browser.stats.expected!==1||browser.stats.unexpected||browser.stats.skipped||dense.stats.expected!==2||dense.stats.unexpected||dense.stats.skipped)throw new Error('Final hardware results are not complete');
const result={
 task_id:'T30',status:'review',base_commit:base,source_commits:['6b9350d0039afdbe1ce67ee8eae41d863b145a5e',source],
 artifact_kind:'owned_source_patch_and_committed_evidence',artifact_ref:'reports/T30/gpu-recovery-fix/source.patch',
 changed_files:owned,
 evidence_files:['reports/T30/gpu-recovery-fix/result.json','reports/T30/gpu-recovery-fix/review.md','reports/T30/gpu-recovery-fix/commands.jsonl','reports/T30/gpu-recovery-fix/browser-results.json','reports/T30/gpu-recovery-fix/dense-results.json','reports/T30/gpu-recovery-fix/browser-artifacts/browser/**','reports/T30/gpu-recovery-fix/browser-artifacts/dense/**'],
 commands,
 setup_commands:[
  {argv:['git','rev-parse','HEAD','&&','rustup','show','active-toolchain'],exit_code:0,tests_passed:0,observed_base:base,toolchain:'1.96.0-x86_64-pc-windows-msvc'},
  {argv:['pnpm','exec','vitest','run','apps/web/src/lib/editor/t09_lifecycle.test.ts'],exit_code:1,tests_passed:0,reason:'Before locked dependency install: vitest not found'},
  {argv:['pnpm','--filter','@weblabel/web','typecheck'],exit_code:1,tests_passed:0,reason:'Before locked dependency install: missing type definitions/node_modules'},
  {argv:['pnpm','install','--frozen-lockfile'],exit_code:0,tests_passed:0},
  {argv:['pnpm','exec','vitest','run','apps/web/src/lib/editor/t09_lifecycle.test.ts'],exit_code:0,tests_passed:22},
  {argv:['pnpm','--filter','@weblabel/web','typecheck'],exit_code:2,tests_passed:0,reason:'Controlled fake state narrowing corrected before final typecheck'},
  {argv:['D:/cache/cargo/bin/bin/rustfmt.exe','--edition','2021','crates/renderer-wgpu/src/renderer.rs','crates/wasm-bridge/src/facade.rs'],exit_code:0,tests_passed:0},
  {argv:['node','reports/T30/gpu-recovery-fix/verify.mjs','prepare'],exit_code:1,tests_passed:0,reason:'Initial report bootstrap failed to find CRLF lock package block after command generate-lockfile itself returned 0; fixed to preserve isolated locked resolution'},
  {argv:['node','reports/T30/gpu-recovery-fix/verify.mjs','browser'],exit_code:1,tests_passed:0,reason:'Writer commit object was not in this isolated repository; corrected read-only git show cwd to writer checkout'},
 ],
 final_verification:{native:{passed:108,failed:0,ignored:0},lifecycle:{passed:22,failed:0},wasm_build_exit_code:0,wasm_bindgen_exit_code:0,frontend_typecheck_exit_code:0,hardware_smoke_typecheck_exit_code:0,F14:{passed:1,failed:0,skipped:0},hardware_dense_lifecycle:{passed:2,failed:0,skipped:0},integration_patch_check_exit_code:0},
 contract_changes:[{contract:'C3',baseline_version:'1.0.0',baseline_docs_sha256:'506c9321af812b03d6b5c3e36c86c3fbfde9144293dbdd34d6137fd976e50872',required_methods:['device_lost(): Promise<string>','get_device_state(): ready | lost | recovering | disposed','recover_renderer(): Promise<void>'],details:'Owned one-shot actual loss notification; renderer-only asynchronous recovery without a WASM/session borrow across await; every facade implementation migrated',integration_patch:'reports/T30/gpu-recovery-fix/integration.patch'},
  {contract:'C1',change:'Recovery errors reuse the existing explicit-null serializer; ApiError.details remains null rather than undefined'},
  {contract:'testing gpu-status',change:'recovering diagnostics/readonly state and gpu-retry control documented in integration patch'},
  {contract:'Cargo.lock integration only',change:'renderer-wgpu direct futures-channel=0.3.34 + js-sys=0.3.105; wasm-bridge direct js-sys=0.3.105, all already resolved; root lock untouched',integration_patch:'reports/T30/gpu-recovery-fix/lock.integration.patch'}],
 evidence:{authoritative_red:'C:/Users/admin/.omp/wt/tcdfc858cd/m/reports/T30/browser-2026-10-06T08-27-36.007Z/t30_recovery-F14-actual-ha-c333c--without-application-reload-chromium-webgpu/device-loss-baseline.json',acceptance_consumer_commit:'6eb06eca',private_origin:'http://127.0.0.1:5192',adapter:'backend=BrowserWebGpu; vendor=nvidia; architecture=blackwell; device_type=Other',software_adapter:false,F14_assertions:['real lost.reason=destroyed','devices 1->2','same native object hashes/generation/one Host session','unsaved CPU document exact before/after','Undo enabled then restores empty document','zero application navigations','new edit plus unsynced native draft export'],dense_assertions:['10000 native objects preserved','selected/hidden projection preserved','locked mutation rejected','pre-loss preview continues and commits','two native Undo transitions restore original document','10000 idle native render calls leave all GPU/CPU counters unchanged','zero-size rebuild submits no frame'],real_lifecycle_assertions:['pending real adapter request is fenced on asset switch','pending real adapter request is fenced on unmount/free','no retired replacement device touches new facade','native recovery rejection retains document/generation','explicit retry succeeds and Undo history survives','recovery ApiError.details is explicit null']},
 known_limits:['Only externally destroyed real hardware devices were forced; Unknown driver/device loss and GPU-process crash were not forced.','Verification used the frozen assigned base. Main reported later 66166686147199be75f4a392c3314c24dc36ec3c float_roundtrip/C1 change and docs SHA 1ba6bf9a8cefe9fe6961b3a011c1e560df9f94b665e2ef073bf25240a7bc91b6; Main must integrate/replay against that newer baseline and preserve those changes.','Prediction storage stays owned by the same native session; no paid/live AI invocation was performed.','Legacy T05 simulate_device_loss remains unchanged and still exported in production Renderer; Main production-tightening decision is separate.','Dense/lifetime smokes exercise actual native facade/Host on an isolated canvas, not the whole workbench; F14 exercises the normal real workbench/SaveQueue.','Root generated contracts and STATUS were not changed; integrated contract gate belongs to Main.'],
 external_blockers:[],
 intentionally_unchanged:['apps/web/src/lib/editor/loader.ts: existing method proxy preserves required capability and identity without fallback','root manifests/lockfiles/router/STATUS/generated contracts','acceptance writer tests/e2e/t30_recovery.spec.ts and tests/support/faults.ts: copied transiently only, not committed'],
};
await writeFile(path.join(report,'result.json'),JSON.stringify(result,null,2)+'\n');
