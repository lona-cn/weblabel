import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, sha } from '../../../scripts/build.mjs';
const report = path.join(root, 'reports/T33/active-host-shutdown');
const read = name => JSON.parse(fs.readFileSync(path.join(report, name), 'utf8'));
const manifest = read('private/release/release.json');
const source = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', shell: false });
assert.equal(source.status, 0);
const direct = read('direct-api.json'), packaged = read('packaged.json');
for (const evidence of [direct, packaged]) { assert.equal(evidence.result, 'passed'); assert.equal(evidence.source_commit, manifest.source_commit); assert.deepEqual(evidence.emergency_cleanup, []); }
assert.equal(packaged.physical.signal_method, 'physical owned ConPTY keyboard input byte 0x03');
const tests = read('physical-final-command.json'); assert.equal(tests.exit_code, 0);
const log = fs.readFileSync(path.join(report, 'physical-final.log'), 'utf8'); assert.match(log, /Tests\s+2 passed \(2\)/);
const types = read('regression-types-final-command.json'); assert.equal(types.exit_code, 0);
fs.writeFileSync(path.join(report, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const result = {
  task_id: 'T33', status: 'review', base_commit: '4e17017e663e448ccff27dafb7926d1a9a0dd89d',
  compiled_source_commit: manifest.source_commit, source_commit: source.stdout.trim(),
  required_cleanup_fix_ancestor: '2ef6dc7cc13c9352e70d58281d1e1ba9b5b72601',
  artifact_ref: `${root.replaceAll('\\', '/')}/reports/T33/active-host-shutdown/result.json`,
  private_release_path: path.join(report, 'private/release'), release_api_sha256: sha(path.join(report, 'private/release/api/weblabel-api.exe')),
  evidence_commit_note: 'The full subsequent evidence commit SHA is returned in the terminal structured task result; a commit cannot contain its own hash.',
  changed_files: [...fs.readdirSync(report).filter(name => name !== 'private').map(name => `reports/T33/active-host-shutdown/${name}`), 'reports/T33/active-host-shutdown/result.json', 'tests/integration/t33_active_host_shutdown.test.ts'].filter((name, index, all) => all.indexOf(name) === index).sort(),
  commands: [
    { ...read('build-command.json'), log_path: 'reports/T33/active-host-shutdown/build.log' },
    { ...tests, tests_passed: 2, tests_failed: 0, tests_skipped: 0, tests_filtered: 0, test_files_passed: 1, log_path: 'reports/T33/active-host-shutdown/physical-final.log' },
    { ...types, tests: 'not applicable: strict TypeScript check', log_path: 'reports/T33/active-host-shutdown/regression-types-final.log' },
    { ...read('packaged-keyboard-smoke-command.json'), assertions: 'Actual standalone packaged Ctrl+C keyboard smoke; not counted as a test case', log_path: 'reports/T33/active-host-shutdown/packaged-keyboard-smoke.log' },
    { argv: ['git', 'merge-base', '--is-ancestor', '2ef6dc7cc13c9352e70d58281d1e1ba9b5b72601', 'HEAD'], exit_code: 0, tests: 'not applicable: source ancestry check' }
  ],
  earlier_experiments: 'reports/T33/active-host-shutdown/experiments.json',
  scenarios: [direct, packaged].map(evidence => ({ mode: evidence.mode, fixture_kind: evidence.host_marker.fixture_kind, pre_signal: evidence.pre_signal, physical: evidence.physical, harness_exit: evidence.harness_exit, cleanup: evidence.cleanup, no_consent_start: evidence.no_consent_start, unauthenticated_start: evidence.unauthenticated_start, emergency_cleanup: evidence.emergency_cleanup, log_path: `reports/T33/active-host-shutdown/${evidence.mode}.log`, complete_marker_and_http_evidence: `reports/T33/active-host-shutdown/${evidence.mode}.json` })),
  contract_changes: [], author_review: 'reports/T33/active-host-shutdown/review.md',
  known_limits: [
    'Windows ConPTY required. Permanent tests do not silently skip or substitute POSIX/mock signals.',
    'Controlled synthetic NDJSON Host only: no subscription, paid provider, account login, inference, weights, hardware GPU or G4 claim. Profile remains verification=not_run.',
    'Packaged API exits 1 under the unchanged launcher force-tree cleanup; direct API exits 0 and independently proves RuntimeLease runtime-joined cleanup. No new assertion about immediate interrupted-job retry.',
    'Earlier T33 observed harness exit 512 remains historical 512; this new native-handle/PowerShell harness observed packaged launcher exit 130 and reports it separately.',
    'Author-reviewed only. Main must integrate/replay and decide T33 status; root manifests/STATUS/docs outside this owned report remain intentionally unchanged.',
    'Initial isolated dependency/type-resolution issues and failed harness experiments are preserved, not counted as functional RED. Compiler retains pre-existing unused_mut/dead-code and cache config warnings.'
  ], external_blockers: []
};
fs.writeFileSync(path.join(report, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ task_id: result.task_id, status: result.status, compiled_source_commit: result.compiled_source_commit, source_commit: result.source_commit, tests: 2, scenarios: result.scenarios.map(row => ({ mode: row.mode, api_exit_code: row.physical.api_exit_code, terminal_exit_code: row.physical.terminal_exit_code, root_exit_at_api: row.physical.root_exit_at_api, descendant_exit_at_api: row.physical.descendant_exit_at_api })) }, null, 2));
