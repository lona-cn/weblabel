import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=await fs.realpath(process.cwd());
const get=async relative=>JSON.parse(await fs.readFile(path.join(root,relative),'utf8'));
const status=await get('STATUS.json'), before=await get('target/build-cache/commercial-d/e-original-ledger-before-final-status.json');
assert.deepEqual(status.tasks,before);
assert.equal(status.tasks.T32.status,'blocked');assert.equal(status.tasks.T35.status,'pending');
assert.equal(Object.keys(status.tasks).length,36);
const evidence=await get('reports/T27/commercial-d/e-joint-verification-final.json');
assert.equal(evidence.gates.native_workspace,322);assert.equal(evidence.gates.web.tests,562);assert.equal(evidence.gates.whole_integration.tests,60);
for(const relative of evidence.evidence)assert.ok((await fs.stat(path.join(root,'reports/T27/commercial-d',relative))).isFile(),relative);
const review=await get('reports/T27/commercial-d/e-result-review-final.json');assert.equal(review.status,'PASS');assert.deepEqual(review.findings,[]);assert.equal(review.source_coverage.reviewed_files,5);
for(const relative of ['e-five-final-source-actual-dataset-keyboard-green.json','e-five-final-source-native-hardware-keyboard-green.json']){const proof=await get('reports/T27/commercial-d/'+relative);assert.equal(proof.viewports.length,5);for(const v of proof.viewports)assert.ok((await fs.stat(path.join(root,v.screenshot))).isFile(),v.screenshot);}
for(const directory of ['target/worktrees/commercial-d1-api','target/worktrees/commercial-d2-ui','target/worktrees/commercial-d3-proof','target/worktrees/commercial-d4-harness','target/worktrees/commercial-d5-build'])await assert.rejects(fs.stat(path.join(root,directory)),{code:'ENOENT'});
const index=await fs.readFile(path.join(root,'reports/index.md'),'utf8');for(const line of index.split(/\r?\n/).filter(l=>l.includes('E完整联合验证'))){for(const m of line.matchAll(/\]\(([^)]+)\)/g))assert.ok((await fs.stat(path.join(root,'reports',m[1]))).isFile(),m[1]);}
console.log(JSON.stringify({status:'PASS',actual_36_task_ledger_exact_unchanged:true,T32:'blocked',T35:'pending',all_named_E_evidence_and_10_images_exist:true,independent_review:'PASS0',all_5_own_worktrees_physically_absent:true,no_test_build_browser_rerun:true}));
