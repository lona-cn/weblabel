import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { root, entries, sha } from '../../../scripts/build.mjs';
import { validateRelease } from '../../../scripts/start-local.mjs';
const report = path.join(root, 'reports/T33/active-host-shutdown');
const privateRoot = path.join(report, 'private');
const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; const closed = once(server, 'close'); server.close(); await closed; return port;
}
async function until(check, label, milliseconds = 20000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(50); }
  throw new Error(typeof label === 'function' ? label() : label);
}
function jsonFile(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
function clean(text) { return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/WEBLABEL_BOOTSTRAP_CODE=[a-f0-9]+/g, 'WEBLABEL_BOOTSTRAP_CODE=[REDACTED]'); }
async function closedPort(port) { try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }); return false; } catch { return true; } }
// Compilation is fixture preparation, not part of the physical/API bootstrap clock.
export async function prepareTerminalAssembly() {
  assert.equal(process.platform, 'win32', 'Terminal interop preparation requires Windows PowerShell 5.1');
  const directory = path.join(privateRoot, 'terminal-assembly-' + crypto.randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  const assemblyPath = path.join(directory, 'T33Terminal.dll');
  const compilerEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|PRIVATE_KEY|BOOTSTRAP_CODE)/i.test(key)));
  const compiler = spawn(powershell, ['-NoProfile', '-NonInteractive', '-File', path.join(report, 'conpty.ps1'), '-Prepare', '-AssemblyPath', assemblyPath], { cwd: root, env: compilerEnv, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  compiler.stdout.on('data', chunk => output += String(chunk));
  compiler.stderr.on('data', chunk => output += String(chunk));
  try {
    const [code, signal] = await once(compiler, 'close');
    assert.equal(code, 0, 'Terminal assembly compilation failed (' + signal + '): ' + clean(output));
    assert.ok(fs.statSync(assemblyPath).isFile(), 'Compiler did not produce the owned assembly');
    return { assembly_path: assemblyPath, sha256: sha(assemblyPath), preparation_directory: directory };
  } finally { fs.writeFileSync(path.join(directory, 'compile.log'), clean(output)); }
}
export async function activeHostShutdown(mode, preparedTerminal, release = path.join(privateRoot, 'release')) {
  assert.equal(process.platform, 'win32', 'This actual physical console regression requires Windows ConPTY');
  assert.ok(['packaged', 'direct-api'].includes(mode));
  assert.equal(sha(preparedTerminal.assembly_path), preparedTerminal.sha256, 'Prepared terminal assembly changed');
  release = path.resolve(release);
  validateRelease(release);
  const runDirectory = path.join(privateRoot, `${mode}-${crypto.randomUUID()}`); fs.mkdirSync(runDirectory, { recursive: true });
  const data = path.join(runDirectory, '中文 owned data'); fs.mkdirSync(data);
  const marker = path.join(runDirectory, 'owned-host'), configFile = path.join(runDirectory, 'host.json');
  const apiPort = await freePort(), webPort = await freePort();
  const apiBase = `http://127.0.0.1:${apiPort}`, base = mode === 'packaged' ? `http://127.0.0.1:${webPort}` : apiBase;
  jsonFile(configFile, { fixture_kind: 'synthetic_controlled_ndjson_host_no_inference', apiBase, marker, providers: [] });
  let fixtureRelease = release;
  if (mode === 'packaged') {
    fixtureRelease = path.join(runDirectory, 'fixture-release'); fs.cpSync(release, fixtureRelease, { recursive: true });
    fs.copyFileSync(path.join(report, 'controlled-host.mjs'), path.join(fixtureRelease, 'host/runtime.mjs'));
    const manifest = JSON.parse(fs.readFileSync(path.join(release, 'release.json'), 'utf8'));
    manifest.files = entries(fixtureRelease).filter(entry => entry.path !== 'release.json');
    manifest.engineering_fixture = 'Only host/runtime.mjs replaced with controlled NDJSON fixture; original release API/WASM/web/mcp untouched';
    jsonFile(path.join(fixtureRelease, 'release.json'), manifest); validateRelease(fixtureRelease);
  }
  const argv = mode === 'packaged'
    ? [process.execPath, path.join(root, 'scripts/start-local.mjs'), '--build-dir', fixtureRelease, '--data-dir', data, '--port', String(webPort), '--api-port', String(apiPort)]
    : [path.join(release, 'api/weblabel-api.exe')];
  const env = Object.fromEntries(['SystemRoot', 'SystemDrive', 'TEMP', 'TMP', 'WINDIR', 'PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { WEBLABEL_HOST_CONFIG: configFile, WEBLABEL_ENV: 'production', WEBLABEL_BIND: `127.0.0.1:${apiPort}`, WEBLABEL_DATABASE_URL: `sqlite:${path.join(data, 'api.sqlite')}`, WEBLABEL_OBJECT_ROOT: path.join(data, 'objects'), WEBLABEL_COOKIE_SECURE: 'false' });
  if (mode === 'direct-api') Object.assign(env, { WEBLABEL_HOST_EXECUTABLE: process.execPath, WEBLABEL_HOST_SCRIPT: path.join(report, 'controlled-host.mjs'), WEBLABEL_HOST_CWD: data });
  const readyFile = path.join(runDirectory, 'signal-ready.txt'), resultFile = path.join(runDirectory, 'physical-result.json');
  const ptyArgv = [powershell, '-NoProfile', '-File', path.join(report, 'conpty.ps1'), '-AssemblyPath', preparedTerminal.assembly_path, '-CommandLine', argv.map(arg => '"' + arg + '"').join(' '), '-ReadyFile', readyFile, '-ResultFile', resultFile];
  if (mode === 'packaged') ptyArgv.push('-Keyboard');
  const terminal = spawn(ptyArgv[0], ptyArgv.slice(1), { cwd: root, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const terminated = new Promise(resolve => terminal.once('exit', (code, signal) => resolve({ code, signal })));
  let output = '', diagnostics = ''; terminal.stdout.on('data', chunk => output += String(chunk)); terminal.stderr.on('data', chunk => diagnostics += String(chunk));
  const evidence = { evidence_kind: 'real_release_api_physical_ctrl_c_engineering_host_fixture_not_model_inference', mode, source_commit: JSON.parse(fs.readFileSync(path.join(release, 'release.json'), 'utf8')).source_commit, argv, pty_argv: ptyArgv, run_directory: runDirectory, api_sha256: sha(path.join(release, 'api/weblabel-api.exe')), requests: [], cleanup: {} };
  let host;
  const identities = new Map();
  const identity = pid => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    const probe = spawnSync(powershell, ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object ProcessId,CommandLine,@{Name='creation_filetime';Expression={$_.CreationDate.ToFileTimeUtc().ToString()}} | ConvertTo-Json -Compress`], { shell: false, encoding: 'utf8' });
    return probe.status === 0 && probe.stdout.trim() ? JSON.parse(probe.stdout) : null;
  };
  const bootstrapCondition = { started_at_ms: Date.now(), token_observed_at_ms: null, normalized_token_detected: false, endpoint_status: null, endpoint_error: null };
  evidence.bootstrap_condition = bootstrapCondition;
  const bootstrapDiagnostic = () => JSON.stringify({ ...bootstrapCondition, elapsed_ms: Date.now() - bootstrapCondition.started_at_ms, terminal_exit_code: terminal.exitCode, vt_controls: [...output.matchAll(/\x1b\[[0-9;?]*[ -/]*[@-~]/g)].slice(0, 32).map(match => match[0]), terminal_output: clean(output + diagnostics) });
  try {
    const code = await until(async () => {
      const pid = Number(output.match(/T33_PTY_PID=(\d+)/)?.[1]);
      if (pid > 0 && !identities.has(pid)) { identities.set(pid, identity(pid)); evidence.owned_cleanup_identities = [...identities.values()]; }
      if (terminal.exitCode !== null) throw new Error('PTY exited before bootstrap: ' + bootstrapDiagnostic());
      const found = output.match(/WEBLABEL_BOOTSTRAP_CODE=([a-f0-9]+)/)?.[1];
      bootstrapCondition.normalized_token_detected = /WEBLABEL_BOOTSTRAP_CODE=\[REDACTED\]/.test(clean(output));
      if (!found) return false;
      bootstrapCondition.token_observed_at_ms ??= Date.now();
      try { bootstrapCondition.endpoint_status = (await fetch(base + '/api/session')).status; bootstrapCondition.endpoint_error = null; return bootstrapCondition.endpoint_status === 401 && found; } catch (error) { bootstrapCondition.endpoint_error = error.name; return false; }
    }, () => 'actual bootstrap missing: ' + bootstrapDiagnostic());
    const initialTerminalPid = Number(output.match(/T33_PTY_PID=(\d+)/)?.[1]);
    identities.set(initialTerminalPid, identity(initialTerminalPid));
    const bootstrap = await fetch(base + '/api/session/bootstrap', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ launch_code: code, password: 'T33-engineering-owned-password' }) });
    const auth = await bootstrap.json(); assert.equal(bootstrap.status, 200, JSON.stringify(auth));
    const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
    async function request(method, route, body, expected = 200) {
      const response = await fetch(base + route, { method, headers: { origin: base, cookie, 'x-csrf-token': auth.csrf_token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const result = await response.json(); evidence.requests.push({ method, route, status: response.status, response: result }); assert.equal(response.status, expected, JSON.stringify(result)); return result;
    }
    const unauthenticated = await fetch(base + '/api/ai/runs', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(unauthenticated.status, 401); const denied = await unauthenticated.json(); assert.equal(denied.code, 'UNAUTHENTICATED'); assert.equal(denied.details, null);
    evidence.unauthenticated_start = { status: unauthenticated.status, response: denied };
    const project = await request('POST', '/api/projects', { name: 'T33 engineering shutdown', description: 'Owned synthetic fixture only', allow_self_review: false }, 201);
    const golden = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/golden/ontology.json'), 'utf8'));
    const ontology = await request('POST', `/api/projects/${project.project_id}/ontologies`, { guidelines_markdown: golden.guidelines_markdown, labels: golden.labels }, 201);
    const form = new FormData(); form.append('images', new Blob([fs.readFileSync(path.join(root, 'tests/fixtures/media/orientation-1.jpg'))], { type: 'image/jpeg' }), 'owned-public-fixture.jpg');
    const upload = await fetch(base + `/api/projects/${project.project_id}/assets`, { method: 'POST', headers: { origin: base, cookie, 'x-csrf-token': auth.csrf_token, 'idempotency-key': crypto.randomUUID() }, body: form }); assert.equal(upload.status, 202, await upload.text());
    const asset = await until(async () => (await request('GET', `/api/projects/${project.project_id}/assets`)).items[0], 'release media worker missing asset');
    const annotation = await request('GET', `/api/assets/${asset.asset_revision_id}/annotation?ontology_version_id=${ontology.ontology_version_id}`);
    await request('PUT', `/api/projects/${project.project_id}/external-processing-policy`, { allow_external_processing: true });
    // Operator configuration in this owned database, same T32 production-profile fixture convention.
    const db = new DatabaseSync(path.join(data, 'api.sqlite'));
    try { db.prepare("INSERT INTO model_profiles(profile_id,provider_id,model_id,auth_kind,capabilities_json,availability,verification,runtime_version,verified_at,config_json,secret_ref,created_at) VALUES(?,'openai_api','T33-engineering-no-inference','api_key',?,'ready','not_run',NULL,NULL,?,NULL,?)").run('t33-controlled-host', JSON.stringify({ image_input: true, tools: true, structured_output: true, bbox_output: false, attributes: true }), JSON.stringify({ fixture_kind: 'synthetic_controlled_ndjson_host_no_inference', budgets: { max_tool_turns: 1, max_run_ms: 120000 } }), new Date().toISOString()); } finally { db.close(); }
    const body = { operation_id: crypto.randomUUID(), profile_id: 't33-controlled-host', context: { project_id: project.project_id, asset_revision_id: asset.asset_revision_id, annotation_revision_id: annotation.annotation_revision_id, ontology_version_id: ontology.ontology_version_id, draft_generation: 0, canonical_sha256: asset.canonical_sha256, selected_object_ids: [], object_hashes: {}, input_fingerprint: 't33-engineering-preview-will-bind' }, intent: 'find_issues', prompt: 'Engineering process shutdown only; no provider calls', consent_id: null };
    const preview = await request('POST', '/api/ai/previews', { request: body, grants: { allow_image: true, allow_object_context: true, preview_crop: null } }, 201);
    // The real authority refuses START before consent, without starting a Host.
    const missingConsent = await fetch(base + '/api/ai/runs', { method: 'POST', headers: { origin: base, cookie, 'x-csrf-token': auth.csrf_token, 'content-type': 'application/json' }, body: JSON.stringify(preview.request) });
    const missing = await missingConsent.json(); assert.equal(missingConsent.status, 403, JSON.stringify(missing)); assert.equal(missing.details, null); assert.equal(fs.existsSync(marker + '.started.json'), false);
    evidence.no_consent_start = { status: missingConsent.status, response: missing };
    const consent = await request('POST', '/api/ai/consents', { preview_id: preview.preview_id }, 201);
    const run = await request('POST', '/api/ai/runs', { ...preview.request, consent_id: consent.consent_id }, 202);
    host = await until(() => fs.existsSync(marker + '.started.json') && JSON.parse(fs.readFileSync(marker + '.started.json', 'utf8')), 'actual production Host not started');
    identities.set(host.root_pid, identity(host.root_pid));
    evidence.owned_cleanup_identities = [...identities.values()];
    assert.equal(host.run_id, run.run_id); assert.equal(host.profile.provider_id, 'openai_api'); assert.equal(host.profile.verification, 'not_run'); assert.equal(host.actual_run_token_context.project_id, project.project_id);
    assert.equal(host.request.context.input_fingerprint, preview.request.context.input_fingerprint); assert.equal(host.request.consent_id, consent.consent_id);
    const events = await until(async () => { const response = await request('GET', `/api/ai/runs/${run.run_id}/events?limit=200&after=0`); return response.items?.some(event => event.message === 'Engineering lifecycle fixture active; no inference') && response; }, 'persisted real Host progress missing');
    const running = events.run; assert.equal(running.state, 'running');
    evidence.events_before_signal = events;
    assert.equal(await (await fetch(`http://127.0.0.1:${host.port}/`)).text(), 'T33-owned-stubborn-descendant');
    const terminalPid = Number(output.match(/T33_PTY_PID=(\d+)/)?.[1]); assert.ok(terminalPid > 0);
    const apiPid = mode === 'direct-api' ? terminalPid : (() => {
      const result = spawnSync(powershell, ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${terminalPid}' | Where-Object Name -eq 'weblabel-api.exe' | Select-Object -ExpandProperty ProcessId`], { encoding: 'utf8', shell: false }); assert.equal(result.status, 0); return Number(result.stdout.trim());
    })(); assert.ok(apiPid > 0);
    evidence.host_marker = host; evidence.pre_signal = { terminal_pid: terminalPid, api_pid: apiPid, host_root_pid: host.root_pid, descendant_pid: host.descendant_pid, listener_port: host.port, model_state: running.state, listener_output: 'T33-owned-stubborn-descendant', lock_present: fs.existsSync(path.join(data, 'runtime.lock')) };
    if (mode === 'packaged') assert.equal(evidence.pre_signal.lock_present, true);
    // Atomic ready-file publish occurs only after authenticated START, live marker and persisted progress.
    fs.writeFileSync(readyFile + '.tmp', [apiPid, host.root_pid, host.descendant_pid].join('\n')); fs.renameSync(readyFile + '.tmp', readyFile);
    const physical = await until(() => fs.existsSync(resultFile) && JSON.parse(fs.readFileSync(resultFile, 'utf8')), 'physical harness result missing: ' + clean(output), 65000);
    evidence.physical = physical;
    assert.equal(physical.harness_error, undefined, physical.harness_error);
    for (const key of ['api_exit_code', 'terminal_exit_code', 'root_exit_at_api', 'descendant_exit_at_api', 'root_exit_at_terminal', 'descendant_exit_at_terminal']) assert.equal(typeof physical[key], 'number', key);
    evidence.harness_exit = await terminated;
    assert.equal(physical.signal_count, 1); assert.notEqual(physical.root_exit_at_api, 259, 'Host root alive at API termination'); assert.notEqual(physical.descendant_exit_at_api, 259, 'descendant alive at API termination');
    assert.notEqual(physical.root_exit_at_terminal, 259); assert.notEqual(physical.descendant_exit_at_terminal, 259);
    assert.equal(await closedPort(host.port), true, 'descendant listener survived'); assert.equal(await closedPort(apiPort), true, 'API listener survived');
    if (mode === 'packaged') assert.equal(await closedPort(webPort), true, 'launcher listener survived');
    assert.equal(fs.existsSync(path.join(data, 'runtime.lock')), false, 'runtime lock survived');
    const checked = new DatabaseSync(path.join(data, 'api.sqlite'), { readOnly: true });
    try { evidence.cleanup.sqlite_integrity = checked.prepare('PRAGMA integrity_check').get().integrity_check; evidence.cleanup.foreign_key_errors = checked.prepare('PRAGMA foreign_key_check').all(); evidence.cleanup.authorized_run = checked.prepare('SELECT run_id,preview_id,capability_expires_at FROM model_run_authorizations WHERE run_id=?').get(run.run_id); } finally { checked.close(); }
    assert.equal(evidence.cleanup.sqlite_integrity, 'ok'); assert.deepEqual(evidence.cleanup.foreign_key_errors, []); assert.equal(evidence.cleanup.authorized_run.preview_id, preview.preview_id);
    Object.assign(evidence.cleanup, { host_listener_closed: true, api_listener_closed: true, web_listener_closed: mode === 'packaged' ? true : 'not applicable', runtime_lock_absent: true, backstop_used_before_observation: false });
    evidence.root_sigint_marker = fs.existsSync(marker + '.root-sigint.json') ? JSON.parse(fs.readFileSync(marker + '.root-sigint.json', 'utf8')) : null;
    evidence.result = 'passed';
    return evidence;
  } catch (error) { evidence.result = 'failed'; evidence.error = error.stack; throw error; }
  finally {
    fs.writeFileSync(path.join(report, `${mode}.log`), clean(output + diagnostics));
    // Successful observations need no backstop; never taskkill an already-dead PID.
    evidence.emergency_cleanup = [];
    if (evidence.result !== 'passed') {
      const owned = [host?.root_pid, Number(output.match(/T33_PTY_PID=(\d+)/)?.[1])].filter(pid => Number.isSafeInteger(pid) && pid > 0);
      for (const pid of owned) {
        // Retain exact creation identity before any signal; reused PIDs are never killed.
        const original = identities.get(pid), current = identity(pid);
        const command = current?.CommandLine;
        const ours = original && current && original.creation_filetime === current.creation_filetime
          && typeof command === 'string' && (command.includes(fixtureRelease) || command.includes(path.join(report, 'controlled-host.mjs')) || command.includes(readyFile));
        if (ours) {
          const kill = spawnSync(path.join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { shell: false, encoding: 'utf8' });
          evidence.emergency_cleanup.push({ pid, exit_code: kill.status, output: kill.stdout + kill.stderr });
        }
      }
      if (terminal.exitCode === null) terminal.kill();
    }
    terminal.stdout.destroy(); terminal.stderr.destroy();
    jsonFile(path.join(report, `${mode}.json`), evidence);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? 'packaged';
  const preparedTerminal = await prepareTerminalAssembly();
  await activeHostShutdown(mode, preparedTerminal, process.env.WEBLABEL_T33_RELEASE);
  console.log(`T33 ${mode}: actual physical Ctrl+C acceptance passed; see ${mode}.json`);
}
