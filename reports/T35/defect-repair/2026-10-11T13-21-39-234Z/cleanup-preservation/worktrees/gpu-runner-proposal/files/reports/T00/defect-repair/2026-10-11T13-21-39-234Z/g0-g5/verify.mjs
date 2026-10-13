import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { finished } from 'node:stream/promises';
import { runArgv, resolveArgv } from './task.mjs';
import { captureEvidenceIdentity } from './evidence-identity.mjs';
import { ownedReportRoot, projectOutputPath } from '../tests/support/report-paths.mjs';

const root = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const gates = new Set(['fast', 'integration', 'browser', 'gpu', 'live', 'release']);
const sha = value => createHash('sha256').update(value).digest('hex');
const relative = file => path.relative(root, file).replaceAll('\\', '/');
const clean = text => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
const identityKeys = ['source_snapshot_sha256', 'manifest_sha256', 'runner_sha256'];
const securityNames = [
  'F10/F11',
  'real Node host dispatch: denied', 'real Node host dispatch: changed_model', 'real Node host dispatch: changed_budget',
  'never exposes private approved execution configuration through provider MCP tools',
  'binds actual HTTP preview approval to media, profile and crop and never runs before consent',
  'root development port refused', 'root preview port refused', 'remote service refused', 'inline credentials refused',
  'expired authorization', 'overlong window', 'wrong provider scope', 'unapproved images',
  'fractional model run budget', 'unbounded call budget', 'unknown cost not acknowledged', 'egress unapproved',
  'cannot reduce declared call authorization below the actual Host tool-turn bound',
  'rejects injectable/private Host configuration rather than forwarding it',
  'T32 engineering authoritative service rejects unauthenticated profiles and unavailable real-profile preview without creating a run',
  'default locked-file diagnostic refuses a symlink escape and does not hash a size-matching public file',
  'actual preview binds the checked public provider budget to Rust-WASM canonical configuration before consent/START',
];
const escapePattern = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function checkEvidenceIdentity(document, identity) {
  if (!document || document.schema_version !== 1 || !document.identity) return { status: 'blocked', blockers: ['EVIDENCE_IDENTITY_MISSING'] };
  const actual = document.identity;
  if (!/^[a-f0-9]{40}$/.test(actual.source_commit ?? '') || !actual.source_hashes || typeof actual.source_hashes !== 'object' || Array.isArray(actual.source_hashes)) return { status: 'blocked', blockers: ['EVIDENCE_IDENTITY_INCOMPLETE'] };
  const sorted = Object.fromEntries(Object.keys(actual.source_hashes).sort().map(key => [key, actual.source_hashes[key]]));
  if (sha(JSON.stringify(sorted)) !== actual.source_snapshot_sha256) return { status: 'failed', blockers: ['EVIDENCE_SNAPSHOT_CORRUPT'] };
  const stale = identityKeys.filter(key => actual[key] !== identity[key]);
  return stale.length ? { status: 'blocked', blockers: stale.map(key => `EVIDENCE_STALE_${key}`) } : { status: 'passed', blockers: [] };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function counts(values, extra = {}) {
  const names = ['collected', 'passed', 'failed', 'skipped'];
  if (names.some(name => !Number.isSafeInteger(values[name]) || values[name] < 0) || (values.flaky !== null && (!Number.isSafeInteger(values.flaky) || values.flaky < 0))) throw new Error('TEST_COUNTS_INVALID');
  if (values.passed + values.failed + values.skipped + (values.flaky ?? 0) + (extra.todo ?? 0) + (extra.cancelled ?? 0) !== values.collected) throw new Error('TEST_COUNTS_INCONSISTENT');
  return { ...values, ...extra };
}
export function readTestEvidence(kind, { logPath, reportPath }) {
  if (kind === 'command') return { tests: null, parse_status: 'not_a_test_command' };
  if (kind === 'node') {
    const text = clean(fs.readFileSync(logPath, 'utf8'));
    const value = label => {
      const matches = [...text.matchAll(new RegExp(`(?:ℹ|#) ${label} (\\d+)(?:\\r?\\n|$)`, 'g'))];
      return matches.length ? Number(matches.at(-1)[1]) : null;
    };
    const tests = counts({ collected: value('tests'), passed: value('pass'), failed: value('fail'), skipped: value('skipped'), flaky: null }, { todo: value('todo') ?? 0, cancelled: value('cancelled') ?? 0 });
    return { tests, parse_status: tests.collected === 0 ? 'zero_tests' : 'parsed' };
  }
  if (kind === 'cargo') {
    const text = clean(fs.readFileSync(logPath, 'utf8'));
    const summaries = [...text.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out/g)];
    if (!summaries.length) throw new Error('TEST_SUMMARY_MISSING');
    const values = { collected: 0, passed: 0, failed: 0, skipped: 0, flaky: null };
    for (const summary of summaries) {
      values.passed += Number(summary[1]); values.failed += Number(summary[2]); values.skipped += Number(summary[3]);
      if (Number(summary[4]) !== 0) throw new Error('BENCHMARK_NOT_TEST_EVIDENCE');
    }
    values.collected = values.passed + values.failed + values.skipped;
    const tests = counts(values);
    return { tests, parse_status: tests.collected === 0 ? 'zero_tests' : 'parsed', target_summaries: summaries.length };
  }
  if (!reportPath || !fs.existsSync(reportPath)) throw new Error('TEST_REPORT_MISSING');
  const report = readJson(reportPath);
  if (kind === 'vitest') {
    if (!Array.isArray(report.testResults) || typeof report.success !== 'boolean') throw new Error('VITEST_REPORT_INVALID');
    const assertions = report.testResults.flatMap(suite => {
      if (!Array.isArray(suite.assertionResults)) throw new Error('VITEST_ASSERTIONS_MISSING');
      return suite.assertionResults;
    });
    const statuses = { passed: 0, failed: 0, skipped: 0, todo: 0 };
    for (const assertion of assertions) {
      if (assertion.status === 'passed' || assertion.status === 'failed') statuses[assertion.status] += 1;
      else if (['pending', 'skipped', 'disabled', 'todo'].includes(assertion.status)) statuses.skipped += 1;
      else throw new Error('VITEST_ASSERTION_STATUS_INVALID');
    }
    const tests = counts({ collected: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests, skipped: assertions.length - statuses.passed - statuses.failed, flaky: null });
    if (assertions.length !== tests.collected || statuses.passed !== tests.passed || statuses.failed !== tests.failed || statuses.skipped !== tests.skipped) throw new Error('VITEST_COUNTS_INCONSISTENT');
    return { tests, parse_status: tests.collected === 0 ? 'zero_tests' : 'parsed', reporter_success: report.success };
  }
  if (kind === 'playwright') {
    const stats = report.stats;
    if (!stats || !Array.isArray(report.suites) || !Array.isArray(report.errors)) throw new Error('PLAYWRIGHT_REPORT_INVALID');
    const statuses = { expected: 0, unexpected: 0, skipped: 0, flaky: 0 };
    const ids = new Set();
    const walk = suites => {
      for (const suite of suites) {
        if (!suite || !Array.isArray(suite.specs) || (suite.suites !== undefined && !Array.isArray(suite.suites))) throw new Error('PLAYWRIGHT_SUITE_INVALID');
        for (const spec of suite.specs) {
          if (!spec || !Array.isArray(spec.tests) || spec.tests.length === 0) throw new Error('PLAYWRIGHT_SPEC_INVALID');
          for (const test of spec.tests) {
            if (!test || !Object.hasOwn(statuses, test.status) || !Array.isArray(test.results) || test.results.length === 0 || typeof test.expectedStatus !== 'string') throw new Error('PLAYWRIGHT_TEST_INVALID');
            const id = spec.id + ':' + test.projectId;
            if (typeof spec.id !== 'string' || typeof test.projectId !== 'string' || ids.has(id)) throw new Error('PLAYWRIGHT_TEST_ID_INVALID');
            ids.add(id);
            for (const result of test.results) if (!['passed', 'failed', 'timedOut', 'skipped', 'interrupted'].includes(result.status)) throw new Error('PLAYWRIGHT_RESULT_INVALID');
            const last = test.results.at(-1).status;
            if (test.status === 'skipped' ? last !== 'skipped' : test.status === 'unexpected' ? last === test.expectedStatus || last === 'skipped' : last !== test.expectedStatus) throw new Error('PLAYWRIGHT_STATUS_INCONSISTENT');
            if (test.status === 'flaky' && !test.results.slice(0, -1).some(result => result.status !== test.expectedStatus && result.status !== 'skipped')) throw new Error('PLAYWRIGHT_FLAKY_INCONSISTENT');
            statuses[test.status] += 1;
          }
        }
        walk(suite.suites ?? []);
      }
    };
    walk(report.suites);
    for (const key of Object.keys(statuses)) if (!Number.isSafeInteger(stats[key]) || stats[key] < 0 || stats[key] !== statuses[key]) throw new Error('PLAYWRIGHT_COUNTS_INCONSISTENT');
    const tests = counts({ collected: ids.size, passed: statuses.expected, failed: statuses.unexpected, skipped: statuses.skipped, flaky: statuses.flaky });
    return { tests, parse_status: tests.collected === 0 ? 'zero_tests' : 'parsed', global_errors: report.errors.length };
  }
  throw new Error('TEST_REPORT_KIND_UNKNOWN');
}

export async function executeVerificationCommand(descriptor, context) {
  const directory = projectOutputPath(path.join(context.reportDir, 'commands', descriptor.name));
  fs.mkdirSync(directory, { recursive: true });
  const logPath = path.join(directory, 'command.log');
  const log = fs.createWriteStream(logPath, { flags: 'wx' });
  let logError;
  log.on('error', error => { logError = error; });
  const row = { name: descriptor.name, argv: null, cwd: context.cwd ?? root, started_at: new Date().toISOString(), ended_at: null, exit_code: null, signal: null, signal_observation: 'not_spawned', runner_exit_code: null, expected_exit_code: descriptor.expectedExitCode ?? 0, log_path: relative(logPath), tests: null, parse_status: 'not_parsed', status: 'failed', blockers: [] };
  try {
    row.argv = resolveArgv(descriptor.argv);
    if (descriptor.reportPath && fs.existsSync(descriptor.reportPath)) throw new Error('PREEXISTING_TEST_REPORT_REFUSED');
    if (descriptor.reportPath) fs.mkdirSync(path.dirname(descriptor.reportPath), { recursive: true });
    row.runner_exit_code = await runArgv(descriptor.argv, row.cwd, {
      env: context.env, signal: context.signal,
      onSpawnError: error => { row.spawn_error = { code: error.code ?? null, message: error.message, syscall: error.syscall ?? null, path: error.path ?? null }; },
      onStdout: chunk => log.write(chunk), onStderr: chunk => log.write(chunk),
      onClose: (code, signal) => { row.exit_code = code; row.signal = signal; row.signal_observation = 'native_close'; },
    });
  } catch (error) {
    row.blockers.push(error.code ?? error.message);
    row.status = ['ENOENT', 'ENOTDIR'].includes(error.code) || error.message === 'Installed pnpm entrypoint unavailable' ? 'blocked' : 'failed';
  } finally {
    log.end();
    try { await finished(log); } catch (error) { logError = error; }
    row.ended_at = new Date().toISOString();
  }
  if (logError) { row.blockers.push('COMMAND_LOG_WRITE_FAILED'); row.parse_status = 'log_write_failed'; return row; }
  row.log_sha256 = sha(fs.readFileSync(logPath));
  if (context.signal?.aborted) { row.status = 'cancelled'; row.runner_exit_code = context.signal.reason === 'SIGTERM' ? 143 : 130; row.parse_status = 'cancelled'; return row; }
  if (row.spawn_error) { row.status = ['ENOENT', 'ENOTDIR'].includes(row.spawn_error.code) ? 'blocked' : 'failed'; row.runner_exit_code = row.status === 'blocked' ? 2 : 1; row.parse_status = 'spawn_error'; row.blockers.push(row.spawn_error.code ?? row.spawn_error.message); return row; }
  if (row.runner_exit_code === null) { row.runner_exit_code = row.status === 'blocked' ? 2 : 1; return row; }
  try {
    if (['gpu', 'live'].includes(descriptor.kind)) {
      if (!fs.existsSync(descriptor.reportPath)) throw new Error('GATE_REPORT_MISSING');
      const report = readJson(descriptor.reportPath);
      const bound = checkEvidenceIdentity(report, context.identity);
      row.tests = report.tests ?? null;
      row.parse_status = 'gate_result';
      row.evidence = { path: relative(descriptor.reportPath), sha256: sha(fs.readFileSync(descriptor.reportPath)) };
      if (bound.status !== 'passed') { row.status = bound.status; row.blockers.push(...bound.blockers); }
      else if (report.status === 'passed' && row.runner_exit_code === 0) row.status = 'passed';
      else if (report.status === 'blocked' && row.runner_exit_code === 2) { row.status = 'blocked'; row.blockers.push(...(report.blockers ?? (report.blocker ? [report.blocker] : ['GATE_PREREQUISITES_MISSING']))); }
      else { row.status = 'failed'; row.blockers.push('GATE_RESULT_NOT_PASSED'); }
    } else {
      const parsed = readTestEvidence(descriptor.kind ?? 'command', { logPath, reportPath: descriptor.reportPath });
      Object.assign(row, parsed);
      const executed = parsed.tests === null || parsed.tests.passed > 0 || parsed.tests.failed > 0;
      row.status = row.runner_exit_code === row.expected_exit_code && executed && parsed.parse_status !== 'zero_tests' && !(parsed.tests?.failed) && !(parsed.tests?.flaky) && !(parsed.tests?.cancelled) && parsed.reporter_success !== false && !(parsed.global_errors) ? 'passed' : 'failed';
      if (parsed.parse_status === 'zero_tests') row.blockers.push('ZERO_TESTS_COLLECTED');
      else if (!executed) row.blockers.push('ZERO_TESTS_EXECUTED');
      if (row.runner_exit_code !== row.expected_exit_code) row.blockers.push('COMMAND_EXIT_FAILED');
      if (descriptor.reportPath && fs.existsSync(descriptor.reportPath)) row.evidence = { path: relative(descriptor.reportPath), sha256: sha(fs.readFileSync(descriptor.reportPath)) };
    }
  } catch (error) { row.tests = null; row.parse_status = error.message === 'TEST_REPORT_MISSING' ? 'missing_report' : 'invalid_report'; row.status = 'failed'; row.blockers.push(error.message); }
  return row;
}

export function readAcceptanceEvidence(reportDir, identity) {
  const requirements = {
    'review.json': { kind: 'independent_spec_quality_review', status: 'approved_scoped' },
    'smoke.json': { kind: 'actual_browser_zip_smoke', status: 'passed' },
  };
  const results = [];
  for (const [name, requirement] of Object.entries(requirements)) {
    const file = path.join(reportDir, name);
    if (!fs.existsSync(file)) { results.push({ name, status: 'blocked', blockers: ['ACCEPTANCE_EVIDENCE_MISSING'] }); continue; }
    try {
      const document = readJson(file), bound = checkEvidenceIdentity(document, identity);
      if (bound.status !== 'passed') { results.push({ name, ...bound }); continue; }
      if (document.evidence_kind === requirement.kind && (document.status === 'failed' || (name === 'smoke.json' && Array.isArray(document.scenarios) && document.scenarios.some(scenario => scenario.status === 'failed')))) { results.push({ name, status: 'failed', blockers: ['ACCEPTANCE_OBSERVED_FAILURE'] }); continue; }
      const artifacts = document.artifacts;
      if (document.evidence_kind !== requirement.kind || document.status !== requirement.status || !Array.isArray(artifacts) || artifacts.length === 0) { results.push({ name, status: 'blocked', blockers: ['ACCEPTANCE_EVIDENCE_PARTIAL'] }); continue; }
      if (name === 'review.json' && (!Array.isArray(document.findings) || document.findings.some(finding => finding.status !== 'closed') || document.coverage?.skipped_product_files !== 0 || document.coverage?.coverage_rate !== 1)) { results.push({ name, status: 'blocked', blockers: ['INDEPENDENT_REVIEW_INCOMPLETE'] }); continue; }
      const requiredScenarios = ['draft_branches', 'legacy_idb_upgrade', 'unknown_raw_rescue', 'late_ack', 'task_lineage', 'workbench_edit_save_reload', 'review_immutable_revision', 'native_export', 'coco_export', 'yolo_export', 'primary_action_states', 'retired_history', 'manual_media_model_split'];
      if (name === 'smoke.json' && requiredScenarios.some(id => !document.scenarios?.some(scenario => scenario.id === id && scenario.status === 'passed' && Array.isArray(scenario.artifacts) && scenario.artifacts.length))) { results.push({ name, status: 'blocked', blockers: ['BROWSER_ZIP_SMOKE_INCOMPLETE'] }); continue; }
      for (const artifact of artifacts) {
        if (!artifact || typeof artifact.path !== 'string' || path.isAbsolute(artifact.path) || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '')) throw new Error('ACCEPTANCE_ARTIFACT_INVALID');
        const actual = fs.realpathSync(path.resolve(reportDir, artifact.path)), rel = path.relative(fs.realpathSync(reportDir), actual);
        if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('ACCEPTANCE_ARTIFACT_OUTSIDE_REPORT');
        if (sha(fs.readFileSync(actual)) !== artifact.sha256) throw new Error('ACCEPTANCE_ARTIFACT_CORRUPT');
      }
      if (name === 'smoke.json') {
        for (const id of requiredScenarios) {
          const scenario = document.scenarios.find(item => item.id === id);
          for (const reference of scenario.artifacts) {
            const artifact = typeof reference === 'string' ? artifacts.find(item => item.path === reference) : artifacts.find(item => item.path === reference?.path && item.sha256 === reference.sha256);
            if (!artifact) throw new Error('SMOKE_SCENARIO_ARTIFACT_UNBOUND');
          }
        }
      }
      results.push({ name, status: 'passed', blockers: [], path: relative(file), sha256: sha(fs.readFileSync(file)) });
    } catch (error) { results.push({ name, status: 'failed', blockers: [error.message] }); }
  }
  return { status: results.some(item => item.status === 'failed') ? 'failed' : results.some(item => item.status === 'blocked') ? 'blocked' : 'passed', evidence: results };
}


// Describe only evidence produced by this invocation; absent commands are never successes.
function describeReleaseGates(result) {
  const fast = ['fast-format', 'fast-contracts', 'fast-web-types', 'fast-host-types', 'fast-test-types', 'fast-bootstrap', 'fast-plan-structure', 'fast-web-bridge', 'fast-host-build', 'fast-vitest'];
  const rust = ['geometry', 'annotation-domain', 'editor-core', 'renderer-wgpu', 'dataset-formats', 'weblabel-api'].map(crate => 'integration-rust-' + crate);
  const integration = [...rust, 'integration-api-build', 'integration-host-build', 'integration-web-bridge', 'integration-release-build', 'integration-vitest'];
  const doctors = ['release-first-doctor', 'release-repeat-doctor'];
  const definitions = [
    { id: 'G0', scope: 'Pinned Node/tooling, fixed source contract/types and both actual release doctors', commands: [...fast.slice(0, 7), ...doctors], evidence: ['first-release-manifest', 'repeat-release-manifest'] },
    { id: 'G1', scope: 'Actual native browser plus complete current-source edit/save/reload and Native/COCO/YOLO ZIP smoke', commands: ['browser'], acceptance: ['smoke.json'] },
    { id: 'G2', scope: 'Geometry/editor/API/format, web/Host/integration and native candidate diff/accept/undo engineering chain; not live or security certification', commands: [...fast, ...integration, 'browser'] },
    { id: 'G3', scope: 'Actual API review/snapshot/recovery, fresh independent repeat manifests/doctors, physical startup and current-source smoke; excluded security remains unverified', commands: ['integration-rust-weblabel-api', 'integration-vitest', 'integration-release-build', 'release-repeat-build', ...doctors, 'release-startup-smoke'], evidence: ['first-release-manifest', 'repeat-release-manifest', 'repeat-build', 'physical-startup'], acceptance: ['smoke.json'], security: true },
    { id: 'G4', scope: 'Actual hardware GPU and full current-source four required live channels, including the full manifest contract', commands: ['gpu', 'live'], security: true },
    { id: 'G5', scope: 'Actual engineering measurement/tooling execution, full current-source independent review and all 13 actual smoke scenarios; no 30% commercial pilot claim', commands: [...fast, ...integration, 'browser', 'gpu', 'release-repeat-build', ...doctors, 'release-startup-smoke'], evidence: ['repeat-build', 'physical-startup'], acceptance: ['review.json', 'smoke.json'] },
  ];
  const combine = items => items.some(item => item.status === 'failed') ? 'failed' : items.every(item => item.status === 'passed') ? 'passed' : 'blocked';
  const identityBlockers = [
    ...(!result.identity ? ['EVIDENCE_IDENTITY_MISSING'] : []),
    ...result.blockers.filter(code => code === 'SOURCE_CHANGED_DURING_VERIFICATION' || code === 'FINAL_IDENTITY_UNAVAILABLE' || code === 'PINNED_NODE_UNAVAILABLE'),
  ];
  return definitions.map(definition => {
    const commands = definition.commands.map(name => {
      const actual = result.commands.find(row => row.name === name);
      return actual ? { name, status: actual.status, argv: actual.argv, exit_code: actual.exit_code, signal: actual.signal, tests: actual.tests, parse_status: actual.parse_status, log_path: actual.log_path, log_sha256: actual.log_sha256, blockers: actual.blockers ?? [] } : { name, status: 'not_started', blockers: ['REQUIRED_COMMAND_NOT_STARTED'] };
    });
    const evidence = (definition.evidence ?? []).map(name => result.evidence.find(item => item.name === name) ?? { name, status: 'missing', blockers: ['REQUIRED_ARTIFACT_MISSING'] });
    const acceptance = (definition.acceptance ?? []).map(name => result.acceptance?.evidence.find(item => item.name === name) ?? { name, status: 'missing', blockers: ['ACCEPTANCE_EVIDENCE_MISSING'] });
    const identity = identityBlockers.map(code => ({ status: 'blocked', blockers: [code] }));
    const engineering = [...commands.filter(row => row.name !== 'live'), ...evidence, ...acceptance, ...identity];
    const skipped_scope = definition.security ? result.skipped_scope : [];
    const full = [...commands, ...evidence, ...acceptance, ...identity, ...skipped_scope.map(scope => ({ status: 'skipped_by_user', blockers: [scope + ':SKIPPED_BY_USER'] }))];
    return { id: definition.id, scope: definition.scope, required_commands: commands, evidence_refs: [...evidence, ...acceptance, ...commands.flatMap(row => {
      const actual = result.commands.find(item => item.name === row.name);
      return actual?.evidence && typeof actual.evidence === 'object' ? [actual.evidence] : [];
    })], status: combine(full), engineering_status: combine(engineering), skipped_scope, blockers: [...new Set(full.flatMap(item => item.status === 'passed' ? [] : (item.blockers?.length ? item.blockers : [item.name + ':' + item.status])))] };
  });
}

function parseOptions(argv) {
  const gate = argv[0];
  if (!gates.has(gate)) throw new Error('UNKNOWN_VERIFICATION_GATE');
  const options = { gate, skipSecurity: false };
  const seen = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (seen.has(key) || !['--report-dir', '--live-evidence', '--skip-security'].includes(key)) throw new Error('UNKNOWN_OR_DUPLICATE_VERIFICATION_OPTION');
    seen.add(key);
    if (key === '--skip-security') { options.skipSecurity = true; continue; }
    const value = argv[++index];
    if (!value || value.startsWith('--') || path.isAbsolute(value)) throw new Error('PROJECT_RELATIVE_OPTION_VALUE_REQUIRED');
    options[key === '--report-dir' ? 'reportDir' : 'liveEvidence'] = value;
  }
  if (options.liveEvidence && !['live', 'release'].includes(gate)) throw new Error('LIVE_EVIDENCE_ONLY_FOR_LIVE_OR_RELEASE');
  return options;
}
function childEnvironment(temporary, cache, reportDir, skipSecurity) {
  const allowed = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'SystemDrive', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PNPM_HOME', 'COREPACK_HOME', 'CARGO_HOME', 'RUSTUP_HOME', 'RUSTUP_TOOLCHAIN', 'RUSTC', 'RUSTDOC', 'VCINSTALLDIR', 'WindowsSdkDir', 'INCLUDE', 'LIB', 'LIBPATH'];
  const env = Object.fromEntries(allowed.filter(key => process.env[key]).map(key => [key, process.env[key]]));
  env.PATH = [path.dirname(process.execPath), env.PATH ?? env.Path ?? ''].join(path.delimiter); delete env.Path;
  const runtime = path.join(temporary, 'runtime'); fs.mkdirSync(runtime, { recursive: true });
  Object.assign(env, { TEMP: runtime, TMP: runtime, TMPDIR: runtime, CARGO_TARGET_DIR: cache, CARGO_NET_OFFLINE: 'true', RUSTUP_AUTO_INSTALL: '0', RUSTUP_TOOLCHAIN: '1.96.0', COREPACK_ENABLE_NETWORK: '0', CI: '1', NO_COLOR: '1', WEBLABEL_TEST_REPORT_DIR: path.join(reportDir, 'tasks'), WEBLABEL_T30_TEST_ROOT: path.join(reportDir, 'tasks/T30'), WEBLABEL_T33_RELEASE: path.join(temporary, 'release'), WEBLABEL_T30_HOST_SCRIPT: path.join(temporary, 'agent-host/runtime.mjs') });
  if (skipSecurity) env.WEBLABEL_SKIP_SECURITY = '1';
  const neutral = process.env.WEBLABEL_CARGO_CWD;
  if (neutral) {
    env.WEBLABEL_CARGO_CWD = neutral;
    env.RUSTC = execFileSync('rustup', ['which', 'rustc', '--toolchain', '1.96.0'], { cwd: neutral, env, encoding: 'utf8', windowsHide: true }).trim();
    env.RUSTDOC = path.join(path.dirname(env.RUSTC), process.platform === 'win32' ? 'rustdoc.exe' : 'rustdoc');
  }
  return env;
}

export async function verify(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  const runId = new Date().toISOString().replaceAll(/[:.]/g, '-') + '-' + randomUUID();
  const reportDir = ownedReportRoot(projectOutputPath(options.reportDir ?? `reports/T35/verification/${runId}`));
  const temporary = projectOutputPath(`target/defect-repair/verification/${runId}`), cache = projectOutputPath(`target/build-cache/verification/${runId}/main`);
  fs.mkdirSync(temporary, { recursive: true }); fs.mkdirSync(cache, { recursive: true });
  const result = { schema_version: 1, evidence_kind: 'current_source_engineering_verification', gate: options.gate, status: 'blocked', base_commit: null, identity: null, source_hashes: null, manifest_sha256: null, started_at: new Date().toISOString(), ended_at: null, environment: { os: os.platform(), arch: os.arch(), release: os.release(), node: process.version, credential_environment: 'not_forwarded', account_state: 'not_inspected' }, commands: [], evidence: [], blockers: [], skipped_scope: options.skipSecurity ? ['security'] : [], excluded_tests: [], full_1_0_ready: false, outbound_model_calls: 0 };
  const controller = new AbortController();
  const interrupt = () => controller.abort('SIGINT'), terminate = () => controller.abort('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  const signal = controller.signal;
  let env;
  try {
    env = childEnvironment(temporary, cache, reportDir, options.skipSecurity);
    const identity = captureEvidenceIdentity({ env });
    Object.assign(result, { identity, base_commit: identity.source_commit, source_hashes: identity.source_hashes, manifest_sha256: identity.manifest_sha256 });
    if (process.version !== 'v24.16.0') { result.blockers.push('PINNED_NODE_UNAVAILABLE'); return result; }
    const context = { reportDir, env, identity, cwd: root, signal };
    const step = async (name, command, kind = 'command', reportPath) => {
      signal.throwIfAborted();
      const row = await executeVerificationCommand({ name, argv: command, kind, reportPath }, context);
      result.commands.push(row); if (row.evidence) result.evidence.push(row.evidence);
      if (row.status !== 'passed') result.blockers.push(...row.blockers.map(code => `${name}:${code}`));
      signal.throwIfAborted();
      return row.status === 'passed';
    };
    const node = process.execPath, buildRelease = (name, directory, target, intermediate) => step(name, [node, 'scripts/build.mjs', '--build-dir', relative(directory), '--target-dir', relative(target), '--intermediate-dir', relative(intermediate), ...(env.WEBLABEL_CARGO_CWD ? ['--cargo-cwd', env.WEBLABEL_CARGO_CWD] : [])]);
    const fast = async () => {
      await step('fast-format', ['cargo', 'fmt', '--all', '--', '--check']);
      await step('fast-contracts', ['pnpm', 'contracts:check']);
      await step('fast-web-types', ['pnpm', '--filter', '@weblabel/web', 'exec', 'tsc', '--noEmit']);
      await step('fast-host-types', ['pnpm', 'typecheck:host']);
      await step('fast-test-types', ['pnpm', '--filter', '@weblabel/web', 'exec', 'tsc', '--noEmit', '-p', '../../tests/tsconfig.json']);
      await step('fast-bootstrap', [node, '--test', '--test-reporter=spec', 'tests/bootstrap/t00_cli.test.mjs', 'tests/bootstrap/verification.test.mjs', 'tools/check-plan.test.mjs'], 'node');
      await step('fast-plan-structure', [node, 'scripts/verify-plan.mjs']);
      const wasmReady = await step('fast-web-bridge', [node, 'scripts/build-web-bridge.mjs']);
      const hostReady = await step('fast-host-build', [node, 'scripts/build-agent-host.mjs', '--out-dir', relative(path.join(temporary, 'agent-host'))]);
      if (hostReady) { const runtime = path.join(temporary, 'agent-host/runtime.mjs'); result.evidence.push({ path: relative(runtime), sha256: sha(fs.readFileSync(runtime)) }); }
      if (wasmReady && hostReady) {
        const output = path.join(reportDir, 'fast-vitest.json');
        const excluded = options.skipSecurity ? ['apps/agent-host/test/t21_mcp.test.ts', 'apps/agent-host/test/t29_injection.test.ts'] : [];
        result.excluded_tests.push(...excluded, ...(options.skipSecurity ? securityNames.slice(1, 5) : []));
        await step('fast-vitest', ['pnpm', 'exec', 'vitest', 'run', '--project', 'web', '--project', 'agent-host', ...excluded.flatMap(file => ['--exclude', file]), ...(options.skipSecurity ? ['--testNamePattern', `^(?!.*(?:${securityNames.slice(1, 5).map(escapePattern).join('|')}))`] : []), '--maxWorkers=1', '--reporter=json', `--outputFile=${output}`], 'vitest', output);
      }
    };
    const integration = async () => {
      const rust = [
        ['geometry', ['t03_geometry']], ['annotation-domain', ['t01_contracts']],
        ['editor-core', ['t04_editor', 't12_tools', 't19_suggestions', 'commercial_relabel_projection']],
        ['renderer-wgpu', ['t05_renderer']], ['dataset-formats', ['t14_formats']],
        ['weblabel-api', ['t06_storage', 't07_media', 't11_save', 't17_jobs', 't22_provider_retirement', 't24_ai_prerequisites', 't26_workflow', 't27_snapshot']],
      ];
      for (const [crate, targets] of rust) await step(`integration-rust-${crate}`, ['cargo', 'test', '-p', crate, ...targets.flatMap(target => ['--test', target]), '--locked'], 'cargo');
      const apiReady = await step('integration-api-build', ['cargo', 'build', '--locked', '--manifest-path', 'Cargo.toml', '--target-dir', cache, '-p', 'weblabel-api', '--bin', 'weblabel-api']);
      const hostReady = await step('integration-host-build', [node, 'scripts/build-agent-host.mjs', '--out-dir', relative(path.join(temporary, 'agent-host'))]);
      const wasmReady = await step('integration-web-bridge', [node, 'scripts/build-web-bridge.mjs']);
      const releaseReady = await buildRelease('integration-release-build', path.join(temporary, 'release'), path.join(cache, 'release-first'), path.join(temporary, 'release-intermediate'));
      if (apiReady && hostReady && wasmReady && releaseReady) {
        env.WEBLABEL_API_BINARY = path.join(cache, 'debug', process.platform === 'win32' ? 'weblabel-api.exe' : 'weblabel-api');
        const runtime = path.join(temporary, 'agent-host/runtime.mjs');
        result.evidence.push({ path: relative(env.WEBLABEL_API_BINARY), sha256: sha(fs.readFileSync(env.WEBLABEL_API_BINARY)) }, { path: relative(runtime), sha256: sha(fs.readFileSync(runtime)) });
        const output = path.join(reportDir, 'integration-vitest.json');
        const excluded = options.skipSecurity ? ['tests/integration/t29_security.test.ts', 'tests/integration/t33_restore_state.test.ts', 'tests/integration/t10_auth.test.ts'] : [];
        result.excluded_tests.push(...excluded, ...(options.skipSecurity ? securityNames : []));
        await step('integration-vitest', ['pnpm', 'exec', 'vitest', 'run', '--project', 'integration', '--project', 'live-engineering', ...excluded.flatMap(file => ['--exclude', file]), ...(options.skipSecurity ? ['--testNamePattern', `^(?!.*(?:${securityNames.map(escapePattern).join('|')}))`] : []), '--maxWorkers=1', '--reporter=json', `--outputFile=${output}`], 'vitest', output);
      } else result.blockers.push('INTEGRATION_FRESH_PREREQUISITES_FAILED');
    };
    const browser = async () => {
      const output = path.join(reportDir, 'browser.json');
      env.PLAYWRIGHT_JSON_OUTPUT_NAME = output;
      await step('browser', [node, 'scripts/test-e2e.mjs', '--require-device', 'tests/e2e/', '--project=chromium-webgpu', '--retries=0', '--workers=1', '--reporter=json', `--output=${path.join(reportDir, 'browser-output')}`], 'playwright', output);
      delete env.PLAYWRIGHT_JSON_OUTPUT_NAME;
    };
    const gpu = () => step('gpu', [node, 'scripts/verify-gpu.mjs', '--report-dir', relative(path.join(reportDir, 'T31'))], 'gpu', path.join(reportDir, 'T31/result.json'));
    const live = () => step('live', [node, 'scripts/verify-live.mjs', ...(options.liveEvidence ? ['--live-evidence', options.liveEvidence] : ['--check-required']), '--report-dir', relative(path.join(reportDir, 'T32')), ...(options.skipSecurity ? ['--skip-security'] : [])], 'live', path.join(reportDir, 'T32/result.json'));
    const stages = { fast, integration, browser, gpu, live };
    if (options.gate !== 'release') await stages[options.gate]();
    else {
      for (const action of [fast, integration, browser, gpu, live]) { signal.throwIfAborted(); await action(); }
      const first = path.join(temporary, 'release'), repeat = path.join(temporary, 'release-repeat');
      if (!fs.existsSync(path.join(first, 'release.json'))) await buildRelease('release-first-build', first, path.join(cache, 'first'), path.join(temporary, 'first-intermediate'));
      const repeatReady = await buildRelease('release-repeat-build', repeat, path.join(cache, 'repeat'), path.join(temporary, 'repeat-intermediate'));
      for (const [name, directory] of [['first', first], ['repeat', repeat]]) {
        if (!fs.existsSync(path.join(directory, 'release.json'))) continue;
        await step(`release-${name}-doctor`, [node, 'scripts/doctor.mjs', '--build-dir', relative(directory), ...(env.WEBLABEL_CARGO_CWD ? ['--cargo-cwd', env.WEBLABEL_CARGO_CWD] : [])]);
      }
      if (repeatReady && fs.existsSync(path.join(first, 'release.json'))) {
        const a = readJson(path.join(first, 'release.json')), b = readJson(path.join(repeat, 'release.json'));
        const entries = new Map(a.files.map(file => [file.path, file]));
        const differences = b.files.filter(file => !entries.has(file.path) || entries.get(file.path).sha256 !== file.sha256 || entries.get(file.path).size !== file.size).map(file => file.path);
        const removed = a.files.filter(file => !b.files.some(other => other.path === file.path)).map(file => file.path);
        const comparison = { schema_version: 1, evidence_kind: 'actual_independent_repeat_build_comparison', identity, first_manifest_sha256: sha(fs.readFileSync(path.join(first, 'release.json'))), repeat_manifest_sha256: sha(fs.readFileSync(path.join(repeat, 'release.json'))), byte_identical: differences.length === 0 && removed.length === 0, differences, removed, limitation: 'Differences are observations, not a byte-reproducibility claim.' };
        const file = path.join(reportDir, 'repeat-build.json'); fs.writeFileSync(file, JSON.stringify(comparison, null, 2) + '\n', { flag: 'wx' });
        result.evidence.push({ name: 'repeat-build', status: 'passed', path: relative(file), sha256: sha(fs.readFileSync(file)) }, ...[['first-release-manifest', first], ['repeat-release-manifest', repeat]].map(([name, directory]) => ({ name, status: 'passed', path: relative(path.join(directory, 'release.json')), sha256: sha(fs.readFileSync(path.join(directory, 'release.json'))) })));
        const { startupSmoke } = await import('../tests/support/startup-smoke.mjs');
        const startup = await startupSmoke(first, { reportDir: path.join(reportDir, 'startup'), temporary: path.join(temporary, 'startup'), env, identity, signal });
        result.commands.push(startup);
        const startupFile = path.join(reportDir, 'startup/startup-evidence.json');
        if (fs.existsSync(startupFile)) result.evidence.push({ name: 'physical-startup', status: startup.status, path: relative(startupFile), sha256: sha(fs.readFileSync(startupFile)), blockers: startup.blockers });
        if (startup.status !== 'passed') result.blockers.push(...startup.blockers);
      }
      signal.throwIfAborted();
    }
    result.status = result.commands.some(row => row.status === 'failed') ? 'failed' : result.commands.some(row => row.status !== 'passed') || result.blockers.length ? 'blocked' : 'passed';
    result.engineering_status = result.commands.length && result.commands.filter(row => row.name !== 'live').every(row => row.status === 'passed') ? 'passed' : 'blocked';
  } catch (error) {
    result.status = signal.aborted ? 'cancelled' : ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'blocked' : 'failed'; result.blockers.push(signal.aborted ? signal.reason : error.code ?? error.message);
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
    // Finalization covers early prerequisites and cancellation, not just the happy path.
    if (result.identity) {
      try {
        const finalIdentity = captureEvidenceIdentity({ env });
        if (identityKeys.some(key => result.identity[key] !== finalIdentity[key])) result.blockers.push('SOURCE_CHANGED_DURING_VERIFICATION');
      } catch { result.blockers.push('FINAL_IDENTITY_UNAVAILABLE'); }
    }
    if (options.gate === 'release') {
      result.acceptance = result.identity ? readAcceptanceEvidence(reportDir, result.identity) : { status: 'blocked', evidence: ['review.json', 'smoke.json'].map(name => ({ name, status: 'blocked', blockers: ['EVIDENCE_IDENTITY_MISSING'] })) };
      result.evidence.push(...result.acceptance.evidence.filter(item => item.path));
      result.release_gates = describeReleaseGates(result);
      result.blockers.push(...result.release_gates.flatMap(gate => gate.blockers.map(code => gate.id + ':' + code)));
      const failed = result.status === 'failed' || result.commands.some(row => row.status === 'failed') || result.release_gates.some(gate => gate.status === 'failed');
      result.status = failed ? 'failed' : signal.aborted ? 'cancelled' : result.release_gates.every(gate => gate.status === 'passed') && result.blockers.length === 0 && result.skipped_scope.length === 0 ? 'passed' : 'blocked';
      result.engineering_status = result.release_gates.some(gate => gate.engineering_status === 'failed') ? 'failed' : result.release_gates.every(gate => gate.engineering_status === 'passed') && !signal.aborted ? 'passed' : 'blocked';
      result.full_1_0_ready = result.status === 'passed' && result.release_gates.every(gate => gate.status === 'passed') && result.skipped_scope.length === 0;
    } else if (result.blockers.includes('SOURCE_CHANGED_DURING_VERIFICATION') || result.blockers.includes('FINAL_IDENTITY_UNAVAILABLE')) {
      if (result.status === 'passed') result.status = 'blocked';
      result.engineering_status = 'blocked';
    }
    result.blockers = [...new Set(result.blockers)];
    result.ended_at = new Date().toISOString();
    result.exit_code = signal.aborted ? (signal.reason === 'SIGTERM' ? 143 : 130) : result.status === 'passed' ? 0 : result.status === 'failed' ? 1 : 2;
    fs.writeFileSync(path.join(reportDir, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ gate: result.gate, status: result.status, exit_code: result.exit_code, report: relative(path.join(reportDir, 'result.json')), blockers: result.blockers }));
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verify().then(result => { process.exitCode = result.exit_code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
