import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { root, requireNode } from '../../scripts/build.mjs';
import { validateRelease } from '../../scripts/release-manifest.mjs';
import { ownedReportRoot, projectOutputPath } from './report-paths.mjs';
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const now = () => new Date().toISOString();
const blocked = message => Object.assign(new Error(message), { blocked: true });
async function pollUntil(check, message, timeout = 30000, signal) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { signal?.throwIfAborted(); const value = await check(); signal?.throwIfAborted(); if (value) return value; await delay(100, undefined, { signal }); }
  throw new Error(message);
}
async function reservePorts() {
  const servers = [createServer()];
  try {
    for (const server of servers) await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return { ports: servers.map(server => server.address().port), reserved_at: now(), release: async () => {
      await Promise.all(servers.map(server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
    } };
  } catch (error) { for (const server of servers) if (server.listening) server.close(); throw error; }
}
async function portClosed(port) {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', error => { socket.destroy(); resolve(error.code === 'ECONNREFUSED'); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}
function quote(value) { return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'; }
async function command(argv, env, signal) {
  signal?.throwIfAborted();
  return new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), { cwd: root, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    let error;
    const abort = () => child.kill(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    child.once('error', value => { error = value.message; });
    child.once('close', (code, nativeSignal) => { signal?.removeEventListener('abort', abort); resolve({ code, signal: nativeSignal, stdout, stderr, ...(error ? { error } : {}) }); });
  });
}
async function browserSmoke(base, code, report, env, evidence, signal) {
  const until = (check, message, timeout) => pollUntil(check, message, timeout, signal);
  signal?.throwIfAborted();
  const require = createRequire(path.join(root, 'package.json'));
  let playwright, sharp;
  try { playwright = require('@playwright/test'); sharp = require('sharp'); } catch (error) { throw blocked('Installed Playwright/sharp missing: ' + error.message); }
  let browser, context, page;
  let abortClose = Promise.resolve();
  const abort = () => { abortClose = browser?.close().catch(() => {}) ?? Promise.resolve(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    try { browser = await playwright.chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu'], env }); }
    catch (error) { throw blocked('Installed Chromium unavailable: ' + error.message); }
    signal?.throwIfAborted();
    context = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 1000 } });
    page = await context.newPage(); page.setDefaultTimeout(15000);
    evidence.browser_requests = []; page.on('response', response => { if (response.url().startsWith(base + '/api/')) evidence.browser_requests.push({ url: response.url(), method: response.request().method(), status: response.status(), observed_at: now() }); });
    const password = randomUUID();
    const csrfResponse = await context.request.post(base + '/api/session/bootstrap', { headers: { origin: base }, data: { launch_code: code, password } });
    assert.equal(csrfResponse.status(), 200, await csrfResponse.text());
    const session = await csrfResponse.json(); assert.equal(session.username, 'local-admin'); assert.ok(session.csrf_token);
    const request = async (method, route, data, expected = 200) => {
      const response = await context.request.fetch(base + route, { method, headers: { origin: base, 'x-csrf-token': session.csrf_token }, ...(data === undefined ? {} : { data }) });
      assert.equal(response.status(), expected, await response.text()); return response.json();
    };
    const project = await request('POST', '/api/projects', { name: 'Startup synthetic ' + randomUUID(), description: 'Owned procedural lifecycle smoke', allow_self_review: true }, 201);
    const ontology = await request('POST', '/api/projects/' + project.project_id + '/ontologies', {
      guidelines_markdown: 'Synthetic canonical continuous pixel box.', labels: [{ label_id: 'label_person', name: 'Person', color: '#0099ff', shortcut: null, allowed_geometry_types: ['bbox_xyxy'], attributes: [] }],
    }, 201);
    const image = await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 70, g: 110, b: 140 } } }).png().toBuffer();
    const imageFile = path.join(report, 'synthetic.png'); fs.writeFileSync(imageFile, image, { flag: 'wx' });
    const upload = await context.request.post(base + '/api/projects/' + project.project_id + '/assets', { headers: { origin: base, 'x-csrf-token': session.csrf_token, 'idempotency-key': randomUUID() }, multipart: { images: { name: 'startup.png', mimeType: 'image/png', buffer: image } } });
    assert.equal(upload.status(), 202, await upload.text()); evidence.upload = await upload.json();
    const asset = await until(async () => {
      const list = await request('GET', '/api/projects/' + project.project_id + '/assets'); return list.items.length === 1 ? list.items[0] : null;
    }, 'Canonical public media worker deadline');
    assert.equal(asset.canonical_width, 320); assert.equal(asset.canonical_height, 240);
    const url = base + '/?project_id=' + project.project_id + '&ontology_version_id=' + ontology.ontology_version_id;
    evidence.browser = { actual_url: url, project, ontology, asset, generated_image_sha256: hash(imageFile), hardware: null };
    await context.clearCookies(); await page.goto(base + '/');
    await page.getByTestId('login-username').fill('local-admin'); await page.getByTestId('login-password').fill(password); await page.getByTestId('login-submit').click();
    await playwright.expect(page.getByTestId('login-submit')).toHaveCount(0);
    await page.goto(url);
    await playwright.expect(page.locator('.r07-project-name')).toHaveText(project.name);
    await page.getByTestId('asset-item-' + asset.asset_revision_id).click();
    const gpu = page.getByTestId('gpu-status');
    try { await playwright.expect(gpu).toHaveAttribute('data-device-state', 'ready', { timeout: 20000 }); }
    catch { evidence.browser.hardware = await gpu.evaluate(el => ({ text: el.textContent, attributes: Object.fromEntries([...el.attributes].map(a => [a.name, a.value])) })); throw blocked('Native hardware WebGPU device unavailable'); }
    evidence.browser.hardware = await gpu.evaluate(el => ({ text: el.textContent, attributes: Object.fromEntries([...el.attributes].map(a => [a.name, a.value])) }));
    if (await gpu.getAttribute('data-actual-backend') !== 'webgpu' || await gpu.getAttribute('data-adapter-kind') !== 'hardware' || /cpu|software|swiftshader|llvmpipe|lavapipe|mesa|basic render/i.test(await gpu.innerText())) throw blocked('Native backend is not hardware WebGPU');
    const canvas = page.getByTestId('annotation-canvas'); await playwright.expect(canvas).toBeVisible();
    const rect = await canvas.boundingBox(); assert.ok(rect && rect.width > 0 && rect.height > 0);
    const scale = Math.min(rect.width / 320, rect.height / 240);
    const point = (x, y) => [rect.x + (rect.width - 320 * scale) / 2 + x * scale, rect.y + (rect.height - 240 * scale) / 2 + y * scale];
    const savedResponse = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith('/annotation')); savedResponse.catch(() => {});
    await page.getByTestId('tool-box').click(); await page.mouse.move(...point(40, 50)); await page.mouse.down(); await page.mouse.move(...point(180, 160), { steps: 5 }); await page.mouse.up();
    await playwright.expect(page.getByTestId('object-list').getByRole('option')).toHaveCount(1);
    const save = await savedResponse;
    evidence.browser.save_request = save.request().postDataJSON(); evidence.browser.save_status = save.status(); evidence.browser.save_response = await save.json(); assert.equal(save.status(), 200, JSON.stringify(evidence.browser.save_response));
    const route = '/api/assets/' + asset.asset_revision_id + '/annotation?ontology_version_id=' + ontology.ontology_version_id;
    const before = await request('GET', route); assert.equal(before.document.objects.length, 1);
    const object = before.document.objects[0]; assert.equal(object.label_id, 'label_person'); assert.equal(object.geometry.type, 'bbox_xyxy');
    for (const [key, value] of Object.entries({ x_min: 40, y_min: 50, x_max: 180, y_max: 160 })) assert.ok(Math.abs(object.geometry[key] - value) < 0.02, key + ': ' + object.geometry[key]);
    await page.reload(); await playwright.expect(page.getByTestId('object-list').getByRole('option')).toHaveCount(1);
    const after = await request('GET', route); assert.equal(after.annotation_revision_id, before.annotation_revision_id); assert.deepEqual(after.document, before.document);
    evidence.browser.saved_revision = before; evidence.browser.reloaded_revision = after;
    await playwright.expect(gpu).toHaveAttribute('data-device-state', 'ready', { timeout: 20000 });
    await playwright.expect(gpu).toHaveAttribute('data-actual-backend', 'webgpu');
    await playwright.expect(gpu).toHaveAttribute('data-adapter-kind', 'hardware');
    evidence.browser.reloaded_hardware = await gpu.evaluate(el => ({ text: el.textContent, attributes: Object.fromEntries([...el.attributes].map(a => [a.name, a.value])) }));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: path.join(report, 'editor.png'), fullPage: true }); evidence.browser.completed_at = now();
  } catch (error) {
    if (page && !page.isClosed()) { try { await page.screenshot({ path: path.join(report, 'editor-failure.png'), fullPage: true }); } catch (captureError) { evidence.failure_screenshot_error = captureError.message; } }
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort); await abortClose;
    const errors = []; try { if (context) await context.close(); } catch (error) { errors.push(error.message); }
    try { if (browser) await browser.close(); } catch (error) { errors.push(error.message); }
    evidence.browser_cleanup = { observed_at: now(), context_closed: !context || errors.length === 0, browser_closed: !browser || !browser.isConnected(), errors };
    if (errors.length) throw new Error('Owned browser cleanup failed: ' + errors.join('; '));
  }
}
export async function startupSmoke(release, { reportDir, temporary, env, identity, signal }) {
  const until = (check, message, timeout) => pollUntil(check, message, timeout, signal);
  if (!reportDir || !temporary || !env || !identity) throw new Error('STARTUP_OPTIONS_REQUIRED');
  const report = ownedReportRoot(reportDir), temporaryRoot = projectOutputPath(temporary);
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const runtime = fs.mkdtempSync(path.join(temporaryRoot, 'startup-')), data = path.join(runtime, 'runtime-data'); fs.mkdirSync(data);
  const logPath = path.join(report, 'startup.log'), evidencePath = path.join(report, 'startup-evidence.json');
  const readyFile = path.join(runtime, 'ready.txt'), physicalFile = path.join(report, 'startup-physical.json');
  const evidence = { schema_version: 1, evidence_kind: 'actual_native_release_startup_physical_ctrl_c', identity, helper_sha256: hash(fileURLToPath(import.meta.url)), started_at: now(), model_calls: 0, requests: [], cleanup: {}, artifacts: [] };
  const row = { name: 'release-startup-smoke', argv: [], cwd: root, exit_code: null, signal: null, runner_exit_code: 2, expected_exit_code: 0, log_path: path.relative(root, logPath).replaceAll('\\', '/'), tests: null, parse_status: 'not_run', status: 'blocked', blockers: [], evidence: path.relative(root, evidencePath).replaceAll('\\', '/') };
  let terminal, terminated, wrapperResult, output = '', native, ps, port;
  const cim = async pid => {
    const result = await command([ps, '-NoProfile', '-Command', '$p=Get-CimInstance Win32_Process -Filter "ProcessId=' + pid + '"; if($p){$p|Select-Object ProcessId,ParentProcessId,ExecutablePath,@{n=\'CreationDate\';e={$_.CreationDate.ToUniversalTime().ToString(\'o\')}}|ConvertTo-Json -Compress}'], env);
    if (result.code !== 0) throw new Error('Owned process observation failed: ' + result.stderr);
    return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  };
  try {
    signal?.throwIfAborted();
    if (process.platform !== 'win32') throw blocked('Windows physical ConPTY startup fixture required; no synthetic Ctrl+C substitute');
    requireNode(); const validated = validateRelease(release);
    evidence.release = { path: release, source_commit: validated.manifest.source_commit, manifest_sha256: hash(path.join(release, 'release.json')), executable_sha256: hash(validated.executable), executable_path: validated.executable };
    if (Object.keys(env).some(key => /^(WEBLABEL_RUNTIME_|OPENAI_|ANTHROPIC_|MIMO_)/i.test(key))) throw new Error('Startup requires an explicitly model-free environment');
    ps = path.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const fixture = path.join(root, 'tests/fixtures/active-host-shutdown/conpty.ps1');
    if (!fs.existsSync(ps) || !fs.existsSync(fixture)) throw blocked('Installed PowerShell/physical ConPTY fixture missing');
    evidence.fixture_sha256 = hash(fixture);
    const reservation = await reservePorts(); [port] = reservation.ports;
    evidence.ports = { web: port, reserved_at: reservation.reserved_at };
    row.argv = [validated.executable, 'serve', '--build-dir', release, '--data-dir', data, '--port', String(port)];
    const argv = [ps, '-NoProfile', '-File', fixture, '-CommandLine', row.argv.map(quote).join(' '), '-ReadyFile', readyFile, '-ResultFile', physicalFile, '-Keyboard', '-Startup']; evidence.pty_argv = argv;
    await reservation.release(); evidence.ports.handed_off_at = now(); signal?.throwIfAborted();
    terminal = spawn(argv[0], argv.slice(1), { cwd: root, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    terminated = new Promise(resolve => { terminal.once('error', error => resolve({ code: null, signal: null, error: error.message })); terminal.once('close', (code, signal) => resolve({ code, signal })); });
    void terminated.then(result => { wrapperResult = result; });
    terminal.stdout.on('data', chunk => { output += chunk; }); terminal.stderr.on('data', chunk => { output += chunk; });
    const plain = () => output.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
    const live = () => { if (wrapperResult) throw new Error('ConPTY exited before readiness: ' + JSON.stringify(wrapperResult)); };
    const pid = await until(() => { live(); return Number(/T33_PTY_PID=(\d+)/.exec(plain())?.[1]) || null; }, 'Owned native PID deadline');
    native = await cim(pid); assert.ok(native);
    assert.equal(path.resolve(native.ExecutablePath).toLowerCase(), path.resolve(validated.executable).toLowerCase());
    evidence.process = native;
    const base = 'http://127.0.0.1:' + port; evidence.actual_service_url = base;
    const code = await until(() => { live(); return /WEBLABEL_BOOTSTRAP_CODE=([a-f0-9]+)/.exec(plain())?.[1]; }, 'Owned bootstrap stdout deadline');
    await until(async () => { live(); try { const response = await fetch(base + '/', { signal: AbortSignal.timeout(1000) }); if (response.status !== 200) return false; evidence.requests.push({ method: 'GET', url: base + '/', status: 200, observed_at: now() }); return true; } catch { return false; } }, 'Native web readiness deadline');
    await until(async () => { live(); try { const response = await fetch(base + '/api/session/bootstrap', { signal: AbortSignal.timeout(1000) }); const body = await response.json(); if (response.status !== 200 || body.mode !== 'initial' || !body.bootstrap_available) return false; evidence.requests.push({ method: 'GET', url: base + '/api/session/bootstrap', status: 200, body, observed_at: now() }); return true; } catch { return false; } }, 'Native bootstrap readiness deadline');
    assert.ok(plain().includes('WEBLABEL_LOCAL_URL=' + base)); evidence.ready_at = now();
    await browserSmoke(base, code, report, env, evidence, signal); signal?.throwIfAborted();
    assert.deepEqual(await cim(pid), native);
    fs.writeFileSync(readyFile + '.tmp', String(pid) + '\n', { flag: 'wx' }); fs.renameSync(readyFile + '.tmp', readyFile); evidence.ready_file_published_at = now();
    await until(() => wrapperResult, 'Physical ConPTY closure deadline', 65000);
    evidence.wrapper = wrapperResult; evidence.physical = JSON.parse(fs.readFileSync(physicalFile, 'utf8'));
    const physical = evidence.physical; row.exit_code = physical.terminal_exit_code; row.signal = wrapperResult.signal;
    assert.equal(physical.signal_count, 1); assert.equal(physical.signal_method, 'physical owned ConPTY keyboard input byte 0x03'); assert.equal(physical.terminal_pid, pid);
    assert.equal(physical.api_exit_code, 0); assert.equal(physical.terminal_exit_code, 0); assert.equal(wrapperResult.code, 0); assert.equal(wrapperResult.signal, null);
    assert.equal(await cim(pid), null); assert.equal(await portClosed(port), true);
    const doctor = await command([validated.executable, 'doctor', '--mode', 'runtime', '--build-dir', release, '--data-dir', data], env);
    assert.equal(doctor.code, 0); assert.equal(JSON.parse(doctor.stdout).storage.lock.status, 'available');
    const db = new DatabaseSync(path.join(data, 'api.sqlite'), { readOnly: true });
    try { evidence.sqlite_integrity = db.prepare('PRAGMA integrity_check').all(); evidence.foreign_key_errors = db.prepare('PRAGMA foreign_key_check').all(); assert.deepEqual(evidence.sqlite_integrity.map(row => row.integrity_check), ['ok']); assert.deepEqual(evidence.foreign_key_errors, []); } finally { db.close(); }
    row.status = 'passed'; row.runner_exit_code = 0; row.parse_status = 'parsed';
  } catch (error) {
    row.status = signal?.aborted ? 'cancelled' : error.blocked ? 'blocked' : 'failed'; row.runner_exit_code = signal?.aborted ? (signal.reason === 'SIGTERM' ? 143 : 130) : error.blocked ? 2 : 1;
    row.blockers.push(signal?.aborted ? signal.reason : error.message); evidence.error = error.stack;
  } finally {
    evidence.cleanup.observed_before_backstop_at = now(); evidence.cleanup.backstops = [];
    if (terminal && !wrapperResult) {
      // The ConPTY owner, not a PID lookup, retains original kill authority.
      fs.writeFileSync(readyFile + '.abort', 'abort-owned-native-startup');
      try { await pollUntil(() => wrapperResult, 'Owned native ConPTY abort deadline', 65000); }
      catch { terminal.kill(); await terminated; evidence.cleanup.backstops.push({ target: 'original-owned-wrapper-handle', observed_at: now() }); }
    }
    evidence.wrapper = wrapperResult ?? null; row.signal = wrapperResult?.signal ?? null;
    evidence.cleanup.after = { process: native ? await cim(native.ProcessId) : null, port_closed: port ? await portClosed(port) : null, wrapper: wrapperResult ?? null };
    if (evidence.cleanup.after.process || evidence.cleanup.after.port_closed === false || terminal && !wrapperResult) { row.status = 'failed'; row.runner_exit_code = 1; row.blockers.push('Owned native cleanup incomplete'); }
    if (fs.existsSync(physicalFile)) { evidence.physical = JSON.parse(fs.readFileSync(physicalFile, 'utf8')); row.exit_code = evidence.physical.terminal_exit_code ?? null; }
    const sanitized = output.replace(/WEBLABEL_BOOTSTRAP_CODE=[a-f0-9]+/g, 'WEBLABEL_BOOTSTRAP_CODE=[REDACTED_SYNTHETIC_LAUNCH_CODE]');
    fs.writeFileSync(logPath, sanitized, { flag: 'wx' }); evidence.finished_at = now(); evidence.row = row; evidence.runtime_directory = runtime;
    for (const file of fs.readdirSync(report)) { const absolute = path.join(report, file); if (fs.statSync(absolute).isFile() && file !== path.basename(evidencePath)) evidence.artifacts.push({ path: file, sha256: hash(absolute) }); }
    json(evidencePath, evidence);
  }
  return row;
}
