import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { root, sha } from '../../scripts/build.mjs';
import { validateRelease } from '../../scripts/release-manifest.mjs';
import { ownedReportRoot } from './report-paths.mjs';
import { nativeLifecycleFixture } from './native-lifecycle-fixture.mjs';
const fixtureRoot = path.join(root, 'tests/fixtures/active-host-shutdown');
async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; const closed = once(server, 'close'); server.close(); await closed; return port;
}
async function until(check, label, milliseconds = 20000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(50); }
  throw new Error(label);
}
function jsonFile(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
function clean(text) { return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/WEBLABEL_BOOTSTRAP_CODE=[a-f0-9]+/g, 'WEBLABEL_BOOTSTRAP_CODE=[REDACTED]'); }
async function closedPort(port) { try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }); return false; } catch { return true; } }
export async function activeHostShutdown(mode, release, { reportDir, skipSecurity = false }) {
  if (!reportDir) throw new Error('REPORT_DIR_REQUIRED');
  assert.equal(process.platform, 'win32', 'Physical console acceptance requires Windows ConPTY');
  assert.ok(['packaged', 'direct-api'].includes(mode));
  const { manifest, executable } = validateRelease(release);
  const report = ownedReportRoot(reportDir);
  const runDirectory = path.join(report, 'runtime', `${mode}-${crypto.randomUUID()}`); fs.mkdirSync(runDirectory, { recursive: true });
  const data = path.join(runDirectory, '中文 owned data'); fs.mkdirSync(data);
  const fixture = nativeLifecycleFixture(runDirectory);
  const config = { profile_id: 't33-native-lifecycle', model_id: 'claude-t33-native-lifecycle-fixture', executable: fixture, timeout_ms: 120000, max_tool_turns: 4, max_tool_result_bytes: 65536 };
  const configuration = path.join(runDirectory, 'runtime.json'); jsonFile(configuration, { schema_version: 1, timeout_ms: 120000, providers: [{ provider: 'claude_local', config }] });
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const argv = mode === 'packaged' ? [executable, 'serve', '--build-dir', release, '--data-dir', data, '--port', String(port)] : [executable, 'serve-api'];
  const env = Object.fromEntries(['SystemRoot', 'SystemDrive', 'WINDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { PATH: '', TEMP: runDirectory, TMP: runDirectory, TMPDIR: runDirectory, WEBLABEL_RUNTIME_CONFIG: configuration, WEBLABEL_ENV: 'production', WEBLABEL_BIND: `127.0.0.1:${port}`, WEBLABEL_DATABASE_URL: `sqlite:${path.join(data, 'api.sqlite')}`, WEBLABEL_OBJECT_ROOT: path.join(data, 'objects'), WEBLABEL_COOKIE_SECURE: 'false' });
  const powershell = path.join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const readyFile = path.join(runDirectory, 'signal-ready.txt'), resultFile = path.join(runDirectory, 'physical-result.json');
  const quote = value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
  const ptyArgv = [powershell, '-NoProfile', '-File', path.join(fixtureRoot, 'conpty.ps1'), '-CommandLine', argv.map(quote).join(' '), '-ReadyFile', readyFile, '-ResultFile', resultFile];
  if (mode === 'packaged') ptyArgv.push('-Keyboard');
  const terminal = spawn(ptyArgv[0], ptyArgv.slice(1), { cwd: root, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const terminated = new Promise(resolve => terminal.once('close', (code, signal) => resolve({ code, signal })));
  let terminalResult; void terminated.then(result => { terminalResult = result; });
  let output = ''; terminal.stdout.on('data', chunk => { output += chunk; }); terminal.stderr.on('data', chunk => { output += chunk; });
  const evidence = { evidence_kind: 'real_native_release_physical_ctrl_c_with_explicit_non_inference_process_fixture', mode, source_commit: manifest.source_commit, argv, pty_argv: ptyArgv, run_directory: runDirectory, api_sha256: sha(executable), fixture_sha256: sha(fixture), helper_sha256: sha(fileURLToPath(import.meta.url)), release_manifest_sha256: sha(path.join(release, 'release.json')), outbound_model_calls: 0, product_PATH: 'empty', requests: [], cleanup: {} };
  try {
    const code = await until(async () => {
      if (terminalResult) throw new Error('PTY exited before bootstrap: ' + clean(output));
      const found = /WEBLABEL_BOOTSTRAP_CODE=([a-f0-9]+)/.exec(output)?.[1];
      if (!found) return false;
      try { return (await fetch(base + '/api/session')).status === 401 && found; } catch { return false; }
    }, 'Native bootstrap missing');
    const bootstrap = await fetch(base + '/api/session/bootstrap', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ launch_code: code, password: 'T33-engineering-owned-password' }) });
    const auth = await bootstrap.json(); assert.equal(bootstrap.status, 200, JSON.stringify(auth));
    const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
    async function request(method, route, body, expected = 200) {
      const response = await fetch(base + route, { method, headers: { origin: base, cookie, 'x-csrf-token': auth.csrf_token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const result = await response.json(); evidence.requests.push({ method, route, status: response.status, response: result }); assert.equal(response.status, expected, JSON.stringify(result)); return result;
    }
    if (!skipSecurity) {
      const denied = await fetch(base + '/api/ai/runs', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(denied.status, 401); assert.equal((await denied.json()).code, 'UNAUTHENTICATED');
    } else evidence.skipped_scope = ['unauthenticated_start', 'no_consent_start'];
    const project = await request('POST', '/api/projects', { name: 'T33 native lifecycle', description: 'Owned synthetic process fixture only', allow_self_review: false }, 201);
    const golden = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/golden/ontology.json'), 'utf8'));
    const ontology = await request('POST', `/api/projects/${project.project_id}/ontologies`, { guidelines_markdown: golden.guidelines_markdown, labels: golden.labels }, 201);
    const form = new FormData(); form.append('images', new Blob([fs.readFileSync(path.join(root, 'tests/fixtures/media/orientation-1.jpg'))], { type: 'image/jpeg' }), 'owned-public-fixture.jpg');
    const upload = await fetch(base + `/api/projects/${project.project_id}/assets`, { method: 'POST', headers: { origin: base, cookie, 'x-csrf-token': auth.csrf_token, 'idempotency-key': crypto.randomUUID() }, body: form }); assert.equal(upload.status, 202);
    const asset = await until(async () => (await request('GET', `/api/projects/${project.project_id}/assets`)).items[0], 'Native media worker missing asset');
    const image = await fetch(base + '/api/assets/' + asset.asset_revision_id + '/image', { headers: { origin: base, cookie } });
    const png = Buffer.from(await image.arrayBuffer()); assert.equal(image.status, 200); assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(createHash('sha256').update(png).digest('hex'), asset.canonical_sha256);
    const annotation = await request('GET', `/api/assets/${asset.asset_revision_id}/annotation?ontology_version_id=${ontology.ontology_version_id}`);
    await request('PUT', `/api/projects/${project.project_id}/external-processing-policy`, { allow_external_processing: true });
    const db = new DatabaseSync(path.join(data, 'api.sqlite'));
    try { db.prepare("INSERT INTO model_profiles(profile_id,provider_id,model_id,auth_kind,capabilities_json,availability,verification,config_json,created_at) VALUES(?,'claude_local',?,'official_user_login',?,'ready','not_run',?,?)").run(config.profile_id, config.model_id, JSON.stringify({ image_input: true, tools: true, structured_output: true, bbox_output: false, attributes: true }), JSON.stringify(config), new Date().toISOString()); } finally { db.close(); }
    const body = { operation_id: crypto.randomUUID(), profile_id: config.profile_id, context: { project_id: project.project_id, asset_revision_id: asset.asset_revision_id, annotation_revision_id: annotation.annotation_revision_id, ontology_version_id: ontology.ontology_version_id, draft_generation: 0, canonical_sha256: asset.canonical_sha256, selected_object_ids: [], object_hashes: {}, input_fingerprint: 'native-preview-will-bind' }, intent: 'find_issues', prompt: 'Engineering native process shutdown only; no inference', consent_id: null };
    const preview = await request('POST', '/api/ai/previews', { request: body, grants: { allow_image: true, allow_object_context: true, preview_crop: null } }, 201);
    const marker = path.join(runDirectory, 'native-started.json');
    if (!skipSecurity) {
      const denied = await fetch(base + '/api/ai/runs', { method: 'POST', headers: { origin: base, cookie, 'x-csrf-token': auth.csrf_token, 'content-type': 'application/json' }, body: JSON.stringify(preview.request) });
      assert.equal(denied.status, 403); assert.equal(fs.existsSync(marker), false);
    }
    const consent = await request('POST', '/api/ai/consents', { preview_id: preview.preview_id }, 201);
    const run = await request('POST', '/api/ai/runs', { ...preview.request, consent_id: consent.consent_id }, 202);
    const host = await until(() => fs.existsSync(marker) && JSON.parse(fs.readFileSync(marker, 'utf8')), 'Actual native child did not start');
    assert.equal(host.fixture_kind, 'synthetic_native_lifecycle_no_inference'); assert.equal(host.actual_run_token_context_status, 200);
    assert.equal(host.run_id, run.run_id); assert.equal(host.model_id, config.model_id); assert.equal(host.actual_run_token_context.project_id, project.project_id);
    assert.equal(host.actual_run_token_context.context.input_fingerprint, preview.request.context.input_fingerprint);
    assert.equal(host.descendant_detached, true); assert.equal(host.root_console_handler_registered, true);
    const events = await request('GET', `/api/ai/runs/${run.run_id}/events?limit=200&after=0`); assert.equal(events.run.state, 'running');
    assert.equal(await (await fetch(`http://127.0.0.1:${host.port}/`)).text(), 'T33-owned-stubborn-descendant');
    const apiPid = Number(/T33_PTY_PID=(\d+)/.exec(output)?.[1]); assert.ok(apiPid > 0);
    evidence.host_marker = host; evidence.events_before_signal = events; evidence.pre_signal = { terminal_pid: apiPid, api_pid: apiPid, host_root_pid: host.root_pid, descendant_pid: host.descendant_pid, listener_port: host.port, model_state: events.run.state, persistent_OS_lock_present: fs.existsSync(path.join(data, 'api.sqlite.runtime.lock')) };
    assert.equal(evidence.pre_signal.persistent_OS_lock_present, true);
    fs.writeFileSync(readyFile + '.tmp', [apiPid, host.root_pid, host.descendant_pid].join('\n')); fs.renameSync(readyFile + '.tmp', readyFile);
    const physical = await until(() => fs.existsSync(resultFile) && JSON.parse(fs.readFileSync(resultFile, 'utf8')), 'Physical native harness result missing: ' + clean(output), 65000);
    evidence.physical = physical; assert.equal(physical.harness_error, undefined, physical.harness_error);
    evidence.harness_exit = await terminated;
    assert.equal(physical.signal_count, 1); assert.equal(physical.api_exit_code, 0); assert.equal(physical.terminal_exit_code, 0); assert.equal(evidence.harness_exit.code, 0);
    for (const key of ['root_exit_at_api', 'descendant_exit_at_api', 'root_exit_at_terminal', 'descendant_exit_at_terminal']) { assert.equal(typeof physical[key], 'number'); assert.notEqual(physical[key], 259, 'Owned native process survived API/terminal termination'); }
    assert.equal(await closedPort(host.port), true); assert.equal(await closedPort(port), true);
    const doctor = spawnSync(executable, ['doctor', '--mode', 'runtime', '--build-dir', release, '--data-dir', data], { cwd: root, env, encoding: 'utf8', shell: false });
    assert.equal(doctor.status, 0, doctor.stderr); assert.equal(JSON.parse(doctor.stdout).storage.lock.status, 'available');
    const checked = new DatabaseSync(path.join(data, 'api.sqlite'), { readOnly: true });
    try {
      evidence.cleanup.sqlite_integrity = checked.prepare('PRAGMA integrity_check').get().integrity_check;
      evidence.cleanup.foreign_key_errors = checked.prepare('PRAGMA foreign_key_check').all();
      evidence.cleanup.authorized_run = checked.prepare('SELECT run_id,preview_id,capability_expires_at FROM model_run_authorizations WHERE run_id=?').get(run.run_id);
      evidence.cleanup.run = checked.prepare('SELECT state,cost_display FROM model_runs WHERE run_id=?').get(run.run_id);
    } finally { checked.close(); }
    assert.equal(evidence.cleanup.sqlite_integrity, 'ok'); assert.deepEqual(evidence.cleanup.foreign_key_errors, []); assert.equal(evidence.cleanup.authorized_run.preview_id, preview.preview_id);
    assert.equal(evidence.cleanup.run.state, 'interrupted'); assert.equal(evidence.cleanup.run.cost_display, 'unknown');
    Object.assign(evidence.cleanup, { host_listener_closed: true, api_listener_closed: true, persistent_OS_lock_available: true, backstop_used_before_observation: false });
    evidence.result = 'passed'; return evidence;
  } catch (error) { evidence.result = 'failed'; evidence.error = error.stack; throw error; }
  finally {
    if (!terminalResult) {
      // The ConPTY owner retains its original CreateProcess HANDLE. Ask that
      // owner to abort after recording failure; never turn observed PIDs into kills.
      fs.writeFileSync(readyFile + '.abort', 'abort-owned-console');
      try { await until(() => terminalResult, 'Owned ConPTY abort deadline', 65000); }
      catch { terminal.kill(); await terminated; evidence.wrapper_backstop_used = true; }
    }
    fs.writeFileSync(path.join(report, `${mode}.log`), clean(output));
    jsonFile(path.join(report, `${mode}.json`), evidence);
    terminal.stdout.destroy(); terminal.stderr.destroy();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? 'packaged';
  await activeHostShutdown(mode, process.argv[3], { reportDir: process.argv[4], skipSecurity: process.env.WEBLABEL_SKIP_SECURITY === '1' });
  console.log(`T33 ${mode}: native physical Ctrl+C acceptance passed; see ${mode}.json`);
}
