import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { executeVerificationCommand, readTestEvidence, checkEvidenceIdentity, readAcceptanceEvidence } from '../../scripts/verify.mjs';
import { captureEvidenceIdentity } from '../../scripts/evidence-identity.mjs';
import { loadedWasmMatches } from '../../scripts/verify-gpu.mjs';
import { taskReportPath } from '../support/report-paths.mjs';
import { prepare_test_api } from '../support/app.ts';
import { pins, entries, root } from '../../scripts/build.mjs';

function releaseFixture(directory, sourceCommit) {
  const release = path.join(directory, 'release');
  const names = [process.platform === 'win32' ? 'weblabel.exe' : 'weblabel', 'web/index.html', 'web/wasm/wasm_bridge.js', 'web/wasm/wasm_bridge_bg.wasm', 'migrations/0001_fixture.sql'];
  for (const name of names) { const file = path.join(release, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'Hash-validation fixture; not an executable release.'); }
  fs.writeFileSync(path.join(release, 'release.json'), JSON.stringify({ format: 'weblabel-local-release', version: 2, platform: process.platform, arch: process.arch, source_commit: sourceCommit, pins, files: entries(release) }));
  return release;
}


const env = Object.fromEntries(['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const directory = fs.mkdtempSync(taskReportPath('T00', 'verification-'));
  const identity = captureEvidenceIdentity({ env });
  return { directory, identity, context: { reportDir: directory, env, cwd: directory, identity }, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
async function nodeTests(source) {
  const f = fixture();
  try {
    const file = path.join(f.directory, 'consumer.test.mjs');
    if (source !== null) fs.writeFileSync(file, source);
    return await executeVerificationCommand({ name: 'actual-node-tests', kind: 'node', argv: [process.execPath, '--test', '--test-reporter=spec', ...(source !== null ? [file] : [])] }, f.context);
  } finally { f.cleanup(); }
}

test('security skip blocks unpartitioned verification gates before any command', () => {
  const directory = fs.mkdtempSync(taskReportPath('T00', 'security-skip-scope-'));
  try {
    for (const gate of ['fast', 'integration', 'browser', 'release']) {
      const reportDir = path.join(directory, gate);
      const run = spawnSync(process.execPath, ['scripts/verify.mjs', gate, '--skip-security', '--report-dir', path.relative(root, reportDir)], { cwd: root, env, encoding: 'utf8' });
      assert.equal(run.status, 2, `${gate}: ${run.stderr}`);
      const result = JSON.parse(fs.readFileSync(path.join(reportDir, 'result.json'), 'utf8'));
      assert.equal(result.status, 'blocked');
      assert.ok(result.blockers.includes('SECURITY_SKIP_PARTITION_INCOMPLETE'));
      assert.deepEqual(result.skipped_scope, ['security']);
      assert.deepEqual(result.commands, []);
      assert.equal(result.full_1_0_ready, false);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('audited nonsecurity verification runs reviewed consumers without claiming the unreviewed suites', () => {
  const directory = fs.mkdtempSync(taskReportPath('T00', 'nonsecurity-partition-'));
  try {
    const reportDir = path.join(directory, 'report');
    const toolEnv = { ...env };
    for (const key of ['CARGO_HOME', 'RUSTUP_HOME', 'RUSTC_WRAPPER']) if (Object.hasOwn(process.env, key)) toolEnv[key] = process.env[key];
    const run = spawnSync(process.execPath, ['scripts/verify.mjs', 'nonsecurity-audited', '--skip-security', '--report-dir', path.relative(root, reportDir)], { cwd: root, env: toolEnv, encoding: 'utf8', timeout: 900_000 });
    assert.equal(run.status, 2, run.stderr);
    const result = JSON.parse(fs.readFileSync(path.join(reportDir, 'result.json'), 'utf8'));
    assert.equal(result.status, 'blocked');
    assert.ok(result.blockers.includes('NONSECURITY_PARTITION_INCOMPLETE'));
    assert.ok(result.skipped_scope.includes('security'));
    assert.ok(result.commands.some(row => row.name === 'nonsecurity-geometry' && row.status === 'passed' && row.tests.passed > 0));
    assert.ok(result.commands.some(row => row.name === 'nonsecurity-editor-core' && row.status === 'passed' && row.tests.passed > 0));
    assert.equal(result.commands.filter(row => row.name.startsWith('nonsecurity-format-') && row.status === 'passed' && row.tests.passed === 1).length, 8);
    assert.ok(result.commands.some(row => row.name === 'nonsecurity-web' && row.status === 'passed' && row.tests.passed > 0));
    assert.ok(result.commands.every(row => row.status === 'passed'));
    assert.equal(result.full_1_0_ready, false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('actual Node report distinguishes passed, skipped and failed consumer assertions', async () => {
  const success = await nodeTests("import test from 'node:test';import assert from 'node:assert/strict';test('normal',()=>assert.equal(2+2,4));test.skip('not exercised',()=>{});");
  assert.equal(success.status, 'passed');
  assert.equal(success.exit_code, 0);
  assert.deepEqual(success.tests, { collected: 2, passed: 1, failed: 0, skipped: 1, flaky: null, todo: 0, cancelled: 0 });
  const failure = await nodeTests("import test from 'node:test';import assert from 'node:assert/strict';test('consumer failure',()=>assert.equal(2+2,5));");
  assert.equal(failure.status, 'failed');
  assert.equal(failure.exit_code, 1);
  assert.equal(failure.tests.collected, 1);
  assert.equal(failure.tests.failed, 1);
});

test('zero actual collection cannot pass despite native exit zero', async () => {
  const row = await nodeTests(null);
  assert.equal(row.exit_code, 0);
  assert.equal(row.runner_exit_code, 1);
  assert.equal(row.status, 'failed');
  assert.equal(row.tests.collected, 0);
  assert.equal(row.parse_status, 'zero_tests');
});

test('an entirely skipped actual suite supplies no passing consumer evidence', async () => {
  const row = await nodeTests("import test from 'node:test';test.skip('not exercised',()=>{});");
  assert.equal(row.tests.collected, 1);
  assert.equal(row.tests.skipped, 1);
  assert.equal(row.status, 'failed');
});

test('malformed or missing reporter JSON is not a successful zero-test report', () => {
  const f = fixture();
  try {
    const file = path.join(f.directory, 'vitest.json');
    assert.throws(() => readTestEvidence('vitest', { reportPath: file }), { message: 'TEST_REPORT_MISSING' });
    fs.writeFileSync(file, '{');
    assert.throws(() => readTestEvidence('vitest', { reportPath: file }), SyntaxError);
    fs.writeFileSync(file, JSON.stringify({ success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, testResults: [{ assertionResults: [{ status: 'failed' }] }] }));
    assert.throws(() => readTestEvidence('vitest', { reportPath: file }), { message: 'VITEST_COUNTS_INCONSISTENT' });
  } finally { f.cleanup(); }
});

test('evidence freshness follows source bytes, manifest and runner rather than commit alone', () => {
  const identity = captureEvidenceIdentity({ env });
  const current = { schema_version: 1, identity: structuredClone(identity) };
  assert.equal(checkEvidenceIdentity(current, identity).status, 'passed');
  current.identity.source_commit = 'a'.repeat(40);
  assert.equal(checkEvidenceIdentity(current, identity).status, 'passed');
  const staleExpected = { ...identity, runner_sha256: 'b'.repeat(64) };
  assert.equal(checkEvidenceIdentity(current, staleExpected).status, 'blocked');
  delete current.identity.source_hashes;
  assert.equal(checkEvidenceIdentity(current, identity).status, 'blocked');
});

test('partial current-source review and smoke records cannot promote acceptance', () => {
  const f = fixture();
  try {
    assert.equal(readAcceptanceEvidence(f.directory, f.identity).status, 'blocked');
    fs.writeFileSync(path.join(f.directory, 'review.json'), JSON.stringify({ schema_version: 1, identity: f.identity, evidence_kind: 'independent_spec_quality_review', status: 'approved_scoped', artifacts: [] }));
    fs.writeFileSync(path.join(f.directory, 'smoke.json'), JSON.stringify({ schema_version: 1, identity: f.identity, evidence_kind: 'actual_browser_zip_smoke', status: 'passed', artifacts: [] }));
    const result = readAcceptanceEvidence(f.directory, f.identity);
    assert.equal(result.status, 'blocked');
    assert.ok(result.evidence.every(item => item.status === 'blocked'));
  } finally { f.cleanup(); }
});

test('a changed declared review artifact is a failure rather than missing prerequisite', () => {
  const f = fixture();
  try {
    const file = path.join(f.directory, 'review-coverage.json');
    fs.writeFileSync(file, '{}');
    const document = { schema_version: 1, identity: f.identity, evidence_kind: 'independent_spec_quality_review', status: 'approved_scoped', findings: [], coverage: { skipped_product_files: 0, coverage_rate: 1 }, artifacts: [{ path: 'review-coverage.json', sha256: hash(fs.readFileSync(file)) }] };
    fs.writeFileSync(path.join(f.directory, 'review.json'), JSON.stringify(document));
    assert.equal(readAcceptanceEvidence(f.directory, f.identity).evidence.find(item => item.name === 'review.json').status, 'passed');
    fs.writeFileSync(file, '{"changed":true}');
    assert.equal(readAcceptanceEvidence(f.directory, f.identity).status, 'failed');
  } finally { f.cleanup(); }
});


test('unavailable actual executable retains native close and full diagnostic', async () => {
  const f = fixture();
  try {
    const row = await executeVerificationCommand({ name: 'missing', argv: [path.join(f.directory, 'missing-executable.exe')] }, f.context);
    assert.equal(row.status, 'blocked'); assert.equal(row.runner_exit_code, 2);
    assert.equal(row.spawn_error.code, 'ENOENT'); assert.equal(row.signal_observation, 'native_close');
    const log = fs.readFileSync(path.resolve(row.log_path), 'utf8');
    assert.ok(log.includes(row.spawn_error.message)); assert.ok(log.includes('ENOENT'));
  } finally { f.cleanup(); }
});

test('cancelled command cannot spawn a subsequent owned child', async () => {
  const f = fixture(), controller = new AbortController();
  const ready = path.join(f.directory, 'ready.json'), marker = path.join(f.directory, 'later.txt');
  const context = { ...f.context, signal: controller.signal };
  try {
    const run = executeVerificationCommand({ name: 'cancelled', argv: [process.execPath, '-e', "const fs=require('node:fs'),net=require('node:net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,port:s.address().port})));setInterval(()=>{},1000)", ready] }, context);
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(fs.existsSync(ready)); const owned = JSON.parse(fs.readFileSync(ready));
    controller.abort('SIGTERM'); const row = await run;
    assert.equal(row.status, 'cancelled'); assert.equal(row.runner_exit_code, 143);
    const later = await executeVerificationCommand({ name: 'later', argv: [process.execPath, '-e', "require('node:fs').writeFileSync(process.argv[1],'unexpected')", marker] }, context);
    assert.equal(later.status, 'cancelled'); assert.equal(later.exit_code, null); assert.equal(fs.existsSync(marker), false);
    assert.throws(() => process.kill(owned.pid, 0), /ESRCH/);
    const net = await import('node:net');
    await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(owned.port, '127.0.0.1', () => server.close(resolve)); });
  } finally { controller.abort('SIGTERM'); f.cleanup(); }
});

test('Playwright counts require real consistent nested test records', () => {
  const f = fixture();
  const reportPath = path.join(f.directory, 'pw.json');
  const parse = report => { fs.writeFileSync(reportPath, JSON.stringify(report)); return readTestEvidence('playwright', { reportPath }); };
  const stats = { expected: 1, unexpected: 0, skipped: 0, flaky: 0 };
  const spec = { id: 'spec', tests: [{ projectId: 'hardware', expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed' }] }] };
  try {
    assert.throws(() => parse({ stats, suites: [], errors: [] }), /COUNTS_INCONSISTENT/);
    assert.throws(() => parse({ stats, suites: [{ specs: [], suites: [] }], errors: [] }), /COUNTS_INCONSISTENT/);
    assert.throws(() => parse({ stats, suites: [{ specs: [{ id: 'spec', tests: [] }], suites: [] }], errors: [] }), /SPEC_INVALID/);
    assert.equal(parse({ stats, suites: [{ specs: [], suites: [{ specs: [spec], suites: [] }] }], errors: [] }).tests.passed, 1);
    assert.equal(parse({ stats, suites: [{ specs: [spec] }], errors: [] }).tests.passed, 1);
    assert.throws(() => parse({ stats, suites: [{ specs: [spec], suites: null }], errors: [] }), /SUITE_INVALID/);
    assert.equal(parse({ stats: { ...stats, expected: 0 }, suites: [], errors: [] }).parse_status, 'zero_tests');
    assert.equal(parse({ stats, suites: [{ specs: [spec], suites: [] }], errors: [{ message: 'global error' }] }).global_errors, 1);
    const skipped = structuredClone(spec); skipped.tests[0].status = 'skipped'; skipped.tests[0].results[0].status = 'skipped';
    assert.equal(parse({ stats: { ...stats, expected: 0, skipped: 1 }, suites: [{ specs: [skipped], suites: [] }], errors: [] }).tests.passed, 0);
  } finally { f.cleanup(); }
});

test('GPU provenance accepts repeated identical lifecycle loads and rejects missing or mismatched bytes', () => {
  const expected = 'a'.repeat(64), other = 'b'.repeat(64);
  assert.equal(loadedWasmMatches([expected], expected), true);
  assert.equal(loadedWasmMatches(Array(6).fill(expected), expected), true);
  assert.equal(loadedWasmMatches([], expected), false);
  assert.equal(loadedWasmMatches([expected, other], expected), false);
  assert.equal(loadedWasmMatches([expected, null], expected), false);
  assert.equal(loadedWasmMatches([expected], undefined), false);
  assert.equal(loadedWasmMatches(['not-a-sha256'], 'not-a-sha256'), false);
});



test('actual wrappers classify prerequisites and preserve invalid-hash failure', async () => {
  const f = fixture();
  try {
    const { pins, root } = await import('../../scripts/build.mjs');
    const absent = Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== 'path')); absent.PATH = '';
    const context = { ...f.context, cwd: root, env: absent };
    const bridge = await executeVerificationCommand({ name: 'bridge-missing', kind: 'web-bridge', argv: [process.execPath, 'scripts/build-web-bridge.mjs'] }, context);
    assert.equal(bridge.exit_code, 2); assert.equal(bridge.status, 'blocked');
    const release = path.join(f.directory, 'release');
    const argv = [prepare_test_api(), 'doctor', '--mode', 'build', '--build-dir', release];
    const missing = await executeVerificationCommand({ name: 'doctor-missing', kind: 'doctor', argv }, context);
    assert.equal(missing.exit_code, 2); assert.equal(missing.status, 'blocked');
    const ordinary = await executeVerificationCommand({ name: 'unregistered-doctor', argv }, context);
    assert.equal(ordinary.exit_code, 2); assert.equal(ordinary.status, 'failed');
    releaseFixture(f.directory, f.identity.source_commit);
    const manifestFile = path.join(release, 'release.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); manifest.files[0].sha256 = '0'.repeat(64);
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const invalid = await executeVerificationCommand({ name: 'doctor-invalid', kind: 'doctor', argv }, context);
    assert.equal(invalid.exit_code, 1); assert.equal(invalid.status, 'failed');
    assert.equal(invalid.parse_status, 'not_a_test_command');
    assert.deepEqual(invalid.blockers, ['COMMAND_EXIT_FAILED']);
    for (const [kind, argv] of [['doctor', [prepare_test_api(), 'doctor', '--unsupported']], ['web-bridge', [process.execPath, 'scripts/build-web-bridge.mjs', '--unsupported']]]) {
      const unsupported = await executeVerificationCommand({ name: kind + '-unsupported', kind, argv }, context);
      assert.equal(unsupported.exit_code, 1); assert.equal(unsupported.status, 'failed');
    }
  } finally { f.cleanup(); }
});

test('actual doctor with valid release hashes is consumable without a test report', async t => {
  const f = fixture();
  try {
    const release = releaseFixture(f.directory, f.identity.source_commit);
    const row = await executeVerificationCommand({ name: 'doctor-valid', kind: 'doctor', argv: [prepare_test_api(), 'doctor', '--mode', 'runtime', '--build-dir', release] }, { ...f.context, cwd: root });
    assert.equal(row.exit_code, 0); assert.equal(row.status, 'passed');
    assert.equal(row.parse_status, 'not_a_test_command'); assert.equal(row.tests, null); assert.deepEqual(row.blockers, []);
  } finally { f.cleanup(); }
});

test('actual probe browser and release wrappers preserve prerequisite diagnostics', async () => {
  const f = fixture();
  try {
    const { root } = await import('../../scripts/build.mjs');
    const absent = Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== 'path')); absent.PATH = '';
    const context = { ...f.context, cwd: root, env: absent };
    const commands = [['wgpu-probe', [process.execPath, 'scripts/build-wgpu-probe.mjs']], ['browser-playwright', [process.execPath, 'scripts/test-e2e.mjs', '--require-device']], ['release-build', [process.execPath, 'scripts/build.mjs', '--build-dir', path.join(f.directory, 'release'), '--intermediate-dir', path.join(f.directory, 'intermediate')]]];
    for (const [kind, argv] of commands) {
      const row = await executeVerificationCommand({ name: kind, kind, argv }, context);
      assert.equal(row.exit_code, 2); assert.equal(row.status, 'blocked');
      assert.equal(row.parse_status, 'wrapper_prerequisites'); assert.equal(row.tests, null);
      assert.ok(row.blockers.some(code => code.startsWith('PINNED_TOOL_UNAVAILABLE')));
    }
    for (const [kind, script] of [['wgpu-probe', 'build-wgpu-probe.mjs'], ['release-build', 'build.mjs']]) {
      const row = await executeVerificationCommand({ name: kind + '-invalid', kind, argv: [process.execPath, 'scripts/' + script, '--unsupported'] }, context);
      assert.equal(row.exit_code, 1); assert.equal(row.status, 'failed'); assert.equal(row.parse_status, 'not_a_test_command');
    }
  } finally { f.cleanup(); }
});

