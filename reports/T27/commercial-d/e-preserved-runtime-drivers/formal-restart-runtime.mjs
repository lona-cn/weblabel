import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { realpath, stat, readFile, unlink } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = 'D:/workspace/src/weblabel';
const physicalRoot = await realpath(ROOT);
async function rootPath(value) {
  assert.equal(typeof value, 'string', 'An absolute Root-owned path is required');
  assert(path.isAbsolute(value), 'Paths must be absolute');
  const candidate = path.resolve(value);
  const inside = actual => {
    const relative = path.relative(physicalRoot, actual);
    assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'Path must be physically inside immutable source Root: ' + value);
  };
  inside(candidate);
  let ancestor = candidate;
  for (;;) {
    try { inside(await realpath(ancestor)); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      ancestor = path.dirname(ancestor);
      if (ancestor === physicalRoot) break;
    }
  }
  return candidate;
}
await rootPath(fileURLToPath(import.meta.url));
assert.equal(Number(process.versions.node.split('.')[0]), 24, 'Node 24 is required');
assert(process.env.TEMP, 'Main must supply Root-owned TEMP');
for (const key of ['TEMP', 'TMP', 'TMPDIR']) if (process.env[key]) {
  const temporary = await rootPath(process.env[key]);
  assert((await stat(temporary)).isDirectory(), 'Temporary directory must already exist');
}
await rootPath(tmpdir());
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  assert(['--release-dir', '--data-dir', '--port', '--api-port'].includes(key) && process.argv[i + 1] && !Object.hasOwn(options, key), 'Expected unique --release-dir, --data-dir, --port, --api-port pairs');
  options[key] = process.argv[i + 1];
}
const releaseDir = await rootPath(options['--release-dir']);
const dataDir = await rootPath(options['--data-dir']);
assert((await stat(releaseDir)).isDirectory() && (await stat(dataDir)).isDirectory(), 'Existing release and data directories required');
assert.notEqual(releaseDir, dataDir, 'Release and existing data directories must differ');
const database = await rootPath(path.join(dataDir, 'api.sqlite'));
const databaseStat = await stat(database);
assert(databaseStat.isFile() && databaseStat.size > 0, 'Existing nonempty synthetic database is required; never seed or create fresh data');
assert((await stat(await rootPath(path.join(dataDir, 'objects')))).isDirectory(), 'Existing media object directory is required');
const port = Number(options['--port']);
const apiPort = Number(options['--api-port']);
assert([port, apiPort].every(value => Number.isInteger(value) && value > 0 && value <= 65535) && port !== apiPort, 'Supply distinct fixed same-origin ports');
const origin = 'http://127.0.0.1:' + port;
const apiOrigin = 'http://127.0.0.1:' + apiPort;
const cliPath = await rootPath(path.join(ROOT, 'scripts/start-local.mjs'));
const { stopTree } = await import(pathToFileURL(cliPath).href);
async function requireFreePort(value) {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(value, '127.0.0.1', resolve); });
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
// Main must stop the old owner first. Never remove an inherited runtime.lock.
const lockPath = await rootPath(path.join(dataDir, 'runtime.lock'));
try { await stat(lockPath); throw new Error('Existing runtime.lock: normal-stop the old controller before restarting'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await requireFreePort(port);
await requireFreePort(apiPort);
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(WEBLABEL_)?(?:HOST_|MODEL_)/.test(key) || ['API_BINARY', 'T33_RELEASE', 'TEST_MANUAL_MODEL_WORKER', 'RESTORE_AUTH'].some(suffix => key === suffix || key === 'WEBLABEL_' + suffix)) delete env[key];
}
const child = spawn(process.execPath, [cliPath, '--build-dir', releaseDir, '--data-dir', dataDir, '--port', String(port), '--api-port', String(apiPort)],
  { cwd: ROOT, env, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let childClosed = false;
let spawnError;
let localMarkerReceived = false;
let bootstrapCodeReceived = false;
const closed = new Promise(resolve => child.once('close', (code, signal) => { childClosed = true; resolve({ code, signal }); }));
child.once('error', error => { spawnError = error; });
// Consume all actual output without forwarding, storing or persisting bootstrap secrets.
for (const stream of [child.stdout, child.stderr]) {
  let remainder = '';
  stream.on('data', chunk => {
    const lines = (remainder + String(chunk)).split(/\r?\n/);
    remainder = lines.pop() ?? '';
    for (const line of lines) {
      if (stream === child.stdout && line === 'WEBLABEL_LOCAL_URL=' + origin) localMarkerReceived = true;
      if (line.startsWith('WEBLABEL_BOOTSTRAP_CODE=')) bootstrapCodeReceived = true;
    }
  });
}
const emit = result => process.stdout.write(JSON.stringify(result) + '\n');
const errorDetails = error => ({ name: error?.name ?? 'Error', message: error instanceof Error ? error.message : String(error), ...(error?.code === undefined ? {} : { code: error.code }) });
const info = () => ({ origin, api_origin: apiOrigin, owned_pid: child.pid, release_dir: releaseDir, data_dir: dataDir });
let apiHealthStatus = null;
let webStatus = null;
let stopping;
async function stop() {
  return stopping ??= (async () => {
    await stopTree(child);
    await closed;
    if (spawnError) throw spawnError;
    assert(childClosed, 'Owned new CLI child must close before lock removal');
    await requireFreePort(port);
    await requireFreePort(apiPort);
    await rootPath(lockPath);
    let lock;
    try { lock = JSON.parse(await readFile(lockPath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { stopped: true, owned_pid: child.pid, lock_removed: false }; throw error; }
    assert.equal(lock.pid, child.pid, 'Refusing to remove a runtime.lock not owned by this exact new CLI child');
    await unlink(lockPath);
    return { stopped: true, owned_pid: child.pid, lock_removed: true };
  })();
}
let queue = Promise.resolve();
let input;
let shutdownRequested = false;
function shutdown(signal) {
  if (shutdownRequested) return;
  shutdownRequested = true;
  input?.close();
  queue = queue.then(async () => {
    try { emit({ command_id: null, event: signal, ok: true, result: await stop() }); }
    catch (error) { process.exitCode = 1; emit({ command_id: null, event: 'stop_failed', ok: false, error: errorDetails(error) }); }
  });
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
try {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !shutdownRequested) {
    if (spawnError) throw spawnError;
    if (childClosed) throw new Error('Actual new CLI child closed before restart readiness');
    try { apiHealthStatus = (await fetch(apiOrigin + '/health', { signal: AbortSignal.timeout(1000) })).status; }
    catch (error) { if (childClosed) throw error; apiHealthStatus = null; }
    try {
      const web = await fetch(origin + '/', { signal: AbortSignal.timeout(1000) });
      webStatus = web.status;
      await web.text();
    } catch (error) { if (childClosed) throw error; webStatus = null; }
    if (apiHealthStatus === 204 && webStatus === 200 && localMarkerReceived) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(!shutdownRequested, 'Restart interrupted');
  assert(apiHealthStatus === 204 && webStatus === 200 && localMarkerReceived, 'Actual restart requires direct API health 204, frontdoor 200 and matching CLI local URL marker');
  const lock = JSON.parse(await readFile(await rootPath(lockPath), 'utf8'));
  assert.equal(lock.pid, child.pid, 'Runtime lock must belong to exact new CLI child');
  assert.equal(lock.port, port); assert.equal(lock.apiPort, apiPort);
  emit({ command_id: null, event: 'ready', ok: true, result: { ...info(), api_health_status: apiHealthStatus, web_status: webStatus, local_marker_received: localMarkerReceived } });
  input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => {
    queue = queue.then(async () => {
      let command;
      try {
        command = JSON.parse(line);
        assert(command && !Array.isArray(command) && typeof command === 'object' && Object.keys(command).length === 2 && Object.hasOwn(command, 'command_id') && Object.hasOwn(command, 'action'), 'Strict NDJSON requires command_id and action only');
        assert((typeof command.command_id === 'string' && command.command_id.length > 0) || Number.isInteger(command.command_id), 'command_id must be a nonempty string or integer');
        assert(!shutdownRequested && !stopping, 'Restart controller is stopping');
        assert(!childClosed, 'Owned new CLI child has closed');
        let result;
        switch (command.action) {
          case 'info': result = info(); break;
          case 'stop': result = await stop(); shutdownRequested = true; input.close(); break;
          default: throw new Error('Restart controller only accepts info or stop');
        }
        emit({ command_id: command.command_id, ok: true, result });
      } catch (error) {
        process.exitCode = 1;
        emit({ command_id: command?.command_id ?? null, ok: false, error: errorDetails(error) });
      }
    });
  });
  input.on('close', () => {
    if (!shutdownRequested) queue = queue.then(async () => {
      if (shutdownRequested) return;
      shutdownRequested = true;
      try { emit({ command_id: null, event: 'stdin_closed', ok: true, result: await stop() }); }
      catch (error) { process.exitCode = 1; emit({ command_id: null, event: 'stop_failed', ok: false, error: errorDetails(error) }); }
    });
  });
  child.once('close', () => {
    if (!stopping && !shutdownRequested) {
      process.exitCode = 1;
      emit({ command_id: null, event: 'runtime_closed', ok: false, error: { name: 'Error', message: 'Owned new CLI child closed unexpectedly' }, result: info() });
      shutdown('runtime_closed_cleanup');
    }
  });
} catch (error) {
  process.exitCode = 1;
  emit({ command_id: null, event: 'startup_failed', ok: false, error: errorDetails(error), diagnostic: { ...info(), api_health_status: apiHealthStatus, web_status: webStatus, local_marker_received: localMarkerReceived, bootstrap_code_received: bootstrapCodeReceived, child_closed: childClosed } });
  try { await stop(); }
  catch (stopError) { emit({ command_id: null, event: 'stop_failed', ok: false, error: errorDetails(stopError) }); }
}
