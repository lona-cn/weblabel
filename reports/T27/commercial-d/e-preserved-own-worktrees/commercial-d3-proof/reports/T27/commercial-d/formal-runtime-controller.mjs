import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = 'D:/workspace/src/weblabel';
const ownScaleURL = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'formal-scale-smoke.mjs'));
const { SOURCE_ROOT, rootPath, prepareScaleEnvironment, seedFormalFixture, fixtureEvidence, runFormalScales } = await import(ownScaleURL.href);
assert.equal(SOURCE_ROOT, ROOT);
await rootPath(fileURLToPath(import.meta.url));
await rootPath(fileURLToPath(ownScaleURL));
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  assert(['--release-dir', '--data-dir', '--evidence-dir'].includes(key) && process.argv[i + 1] && !options[key], 'Expected unique --release-dir, --data-dir, --evidence-dir pairs');
  options[key] = process.argv[i + 1];
}
const evidenceDir = await prepareScaleEnvironment(options['--evidence-dir']);
const releaseDir = await rootPath(options['--release-dir']);
const dataDir = await rootPath(options['--data-dir'], { createDirectory: true });
assert.equal((await readdir(dataDir)).length, 0, 'Main must supply a fresh empty dataDir');
assert(dataDir !== evidenceDir && dataDir !== releaseDir && evidenceDir !== releaseDir, 'Runtime directories must be distinct');
const cliPath = await rootPath(path.join(ROOT, 'scripts/start-local.mjs'));
const appPath = await rootPath(path.join(ROOT, 'tests/support/app.ts'));
const { stopTree } = await import(pathToFileURL(cliPath).href);
const { login_at_origin_for_test } = await import(pathToFileURL(appPath).href);
const env = { ...process.env };
for (const suffix of ['HOST_CONFIG', 'HOST_EXECUTABLE', 'HOST_CWD', 'HOST_SCRIPT', 'HOST_ALLOWED_ENV', 'API_BINARY', 'T33_RELEASE', 'TEST_MANUAL_MODEL_WORKER']) {
  delete env['WEBLABEL_' + suffix]; delete env[suffix];
}
async function freePort(port = 0) {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const actual = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return actual;
}
const port = await freePort();
let apiPort = await freePort();
while (apiPort === port) apiPort = await freePort();
const origin = 'http://127.0.0.1:' + port;
const apiOrigin = 'http://127.0.0.1:' + apiPort;
const password = randomUUID() + randomUUID();
const secrets = [password];
const username = 'local-admin';
let bootstrapCode = '';
let receivedCode;
const codeReady = new Promise(resolve => { receivedCode = resolve; });
const child = spawn(process.execPath, [cliPath, '--build-dir', releaseDir, '--data-dir', dataDir, '--port', String(port), '--api-port', String(apiPort)],
  { cwd: ROOT, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let childClosed = false;
let spawnError;
const closed = new Promise(resolve => { child.once('close', (code, signal) => { childClosed = true; resolve({ code, signal }); }); });
child.once('error', error => { spawnError = error; });
// Never forward raw child output: stdout contains a one-use authentication secret.
for (const stream of [child.stdout, child.stderr]) {
  let remainder = '';
  stream.on('data', chunk => {
    const lines = (remainder + String(chunk)).split(/\r?\n/);
    remainder = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('WEBLABEL_BOOTSTRAP_CODE=') && !bootstrapCode) {
        bootstrapCode = line.slice('WEBLABEL_BOOTSTRAP_CODE='.length);
        if (bootstrapCode) receivedCode(bootstrapCode);
      }
    }
  });
}
const emit = result => process.stdout.write(JSON.stringify(result) + '\n');
const errorDetails = error => {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [...secrets, bootstrapCode]) if (secret) message = message.split(secret).join('[REDACTED]');
  return { name: error?.name ?? 'Error', message, ...(error?.code === undefined ? {} : { code: error.code }) };
};
let stopping;
async function stop() {
  return stopping ??= (async () => {
    await stopTree(child);
    await closed;
    if (spawnError) throw spawnError;
    assert(childClosed, 'Owned CLI child has not closed');
    // Both services must be gone before touching the lock, including unexpected CLI exits.
    await freePort(port); await freePort(apiPort);
    const lockPath = await rootPath(path.join(dataDir, 'runtime.lock'));
    let lock;
    try { lock = JSON.parse(await readFile(lockPath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { stopped: true, owned_pid: child.pid, lock_removed: false }; throw error; }
    assert.equal(lock.pid, child.pid, 'Refusing to remove a runtime lock not owned by this exact CLI child');
    await unlink(lockPath);
    return { stopped: true, owned_pid: child.pid, lock_removed: true };
  })();
}
let queue = Promise.resolve();
let input;
let shutdownRequested = false;
function requestShutdown(signal) {
  shutdownRequested = true;
  input?.close();
  queue = queue.then(async () => {
    try { emit({ command_id: null, signal, ok: true, result: await stop() }); }
    catch (error) { process.exitCode = 1; emit({ command_id: null, signal, ok: false, error: errorDetails(error) }); }
  });
}
process.once('SIGINT', () => requestShutdown('SIGINT'));
process.once('SIGTERM', () => requestShutdown('SIGTERM'));
let admin;
let fixture;
let seedAttempted = false;
let scalesAttempted = false;
let apiHealthStatus = null;
let webStatus = null;
try {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !shutdownRequested) {
    if (spawnError) throw spawnError;
    if (childClosed) throw new Error('Actual start-local CLI closed before bootstrap/health');
    try {
      apiHealthStatus = (await fetch(apiOrigin + '/health', { signal: AbortSignal.timeout(1000) })).status;
    } catch (error) { if (childClosed) throw error; apiHealthStatus = null; }
    try {
      const web = await fetch(origin + '/', { signal: AbortSignal.timeout(1000) });
      webStatus = web.status;
      await web.text();
    } catch (error) { if (childClosed) throw error; webStatus = null; }
    if (apiHealthStatus === 204 && webStatus === 200 && bootstrapCode) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(!shutdownRequested, 'Startup interrupted');
  assert(apiHealthStatus === 204 && webStatus === 200 && bootstrapCode,
    'Actual CLI did not produce bootstrap code, direct API HTTP 204 health and frontdoor HTTP 200 within 60 seconds');
  admin = await login_at_origin_for_test(origin, { launch_code: await codeReady, password });
  const session = await admin.request('GET', '/api/session');
  assert.equal(session.status, 200, JSON.stringify(session.json));
  assert.equal(session.json.username, username, 'Bootstrap must return the actual local-admin identity');
  await writeFile(await rootPath(path.join(evidenceDir, 'formal-runtime.json')), JSON.stringify({ origin, api_origin: apiOrigin, owned_pid: child.pid,
    release_dir: releaseDir, data_dir: dataDir, admin_actor_id: session.json.user_id, api_health_status: apiHealthStatus, web_status: webStatus, bootstrap_authenticated: true }, null, 2) + '\n', { flag: 'wx' });
  emit({ command_id: null, event: 'ready', ok: true, result: { origin, owned_pid: child.pid } });
  input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => {
    queue = queue.then(async () => {
      let command;
      try {
        command = JSON.parse(line);
        assert(command && typeof command === 'object' && Object.hasOwn(command, 'command_id'), 'NDJSON command_id is required');
        assert(!shutdownRequested && !stopping, 'Controller is stopping');
        assert(!childClosed, 'Owned actual CLI child has closed');
        let result;
        switch (command.action) {
          case 'info': result = { username, password, origin, owned_pid: child.pid }; break;
          case 'seed': {
            assert(!seedAttempted, 'Seed may be attempted only once in this fresh runtime'); seedAttempted = true;
            fixture = await seedFormalFixture({ base_url: origin, admin }, command.count ?? 1301);
            result = fixtureEvidence(fixture);
            await writeFile(await rootPath(path.join(evidenceDir, 'formal-fixture.json')), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
            break;
          }
          case 'scales': {
            assert(fixture, 'Run seed before scales'); assert(!scalesAttempted, 'Scales may be attempted only once'); scalesAttempted = true;
            result = await runFormalScales({ base_url: origin, admin, fixture, evidenceDir }); break;
          }
          case 'create_user': {
            const { username: user, password: userPassword, project_id, role } = command;
            assert(typeof user === 'string' && user && typeof userPassword === 'string' && userPassword && typeof project_id === 'string' && project_id);
            assert(['admin', 'annotator', 'reviewer', 'viewer'].includes(role));
            secrets.push(userPassword);
            const created = await admin.request('POST', '/api/users', { username: user, password: userPassword });
            assert.equal(created.status, 201, JSON.stringify(created.json));
            const userId = created.json.user_id; assert.equal(typeof userId, 'string');
            const membership = await admin.request('POST', '/api/projects/' + encodeURIComponent(project_id) + '/members', { user_id: userId, role });
            assert.equal(membership.status, 200, JSON.stringify(membership.json));
            result = { user_id: userId, project_id, role }; break;
          }
          case 'stop': result = await stop(); shutdownRequested = true; input.close(); break;
          default: throw new Error('Unknown controller action: ' + command.action);
        }
        emit({ command_id: command.command_id, ok: true, result });
      } catch (error) {
        process.exitCode = 1;
        emit({ command_id: command?.command_id ?? null, ok: false, error: errorDetails(error) });
      }
    });
  });
  input.on('close', () => {
    if (!shutdownRequested) {
      queue = queue.then(async () => {
        if (shutdownRequested) return;
        shutdownRequested = true;
        try { emit({ command_id: null, event: 'stdin_closed', ok: true, result: await stop() }); }
        catch (error) { process.exitCode = 1; emit({ command_id: null, event: 'stop_failed', ok: false, error: errorDetails(error) }); }
      });
    }
  });
} catch (error) {
  process.exitCode = 1;
  emit({ command_id: null, event: 'startup_failed', ok: false, error: errorDetails(error),
    diagnostic: { api_health_status: apiHealthStatus, web_status: webStatus, code_received: Boolean(bootstrapCode), child_closed: childClosed, owned_pid: child.pid } });
  try { await stop(); } catch (stopError) { emit({ command_id: null, event: 'stop_failed', ok: false, error: errorDetails(stopError) }); }
}
