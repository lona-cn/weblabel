import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer, createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { taskReportPath } from '../support/report-paths.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'apps/web/package.json'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function within(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned Vite lifecycle deadline exceeded')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function listener() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server;
}
async function fixture() {
  const directory = fs.mkdtempSync(taskReportPath('T00', 'owned-vite-'));
  const config = path.join(directory, 'vite.config.mjs');
  fs.writeFileSync(config, `import config from ${JSON.stringify(path.join(root, 'reports/T31/vite.config.ts').replaceAll('\\', '/'))};\nexport default {...config, cacheDir:${JSON.stringify(path.join(directory, 'vite-cache'))}};\n`);
  const reserved = await listener(), port = reserved.address().port;
  await new Promise(resolve => reserved.close(resolve));
  const env = Object.fromEntries(['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { TEMP: directory, TMP: directory, TMPDIR: directory });
  const argv = [path.join(root, 'scripts/owned-vite-service.mjs'), require.resolve('vite'), config, path.join(root, 'apps/web'), String(port)];
  const child = spawn(process.execPath, argv, { cwd: root, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
  child.stdin.on('error', () => {});
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  return { child, done, port, directory, output: () => output, cleanup: async () => {
    if (child.exitCode === null && child.signalCode === null) { child.stdin.end(); try { await within(done, 5000); } catch { child.kill('SIGKILL'); await within(done, 5000); } }
    fs.rmSync(directory, { recursive: true, force: true });
  } };
}
async function assertPortClosed(port) {
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); reject(new Error('Vite listener survived native close')); });
    socket.once('error', error => { socket.destroy(); try { assert.equal(error.code, 'ECONNREFUSED'); resolve(); } catch (error) { reject(error); } });
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Port observation timed out')); });
  });
}

test('actual T31 Vite listener closes normally on owned stdin EOF', async () => {
  const f = await fixture();
  try {
    await within((async () => {
      while (true) {
        assert.equal(f.child.exitCode, null, f.output());
        try { if ((await fetch(`http://127.0.0.1:${f.port}/`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
        await pause(50);
      }
    })(), 20000);
    f.child.stdin.end();
    assert.deepEqual(await within(f.done, 5000), { code: 0, signal: null }, f.output());
    await assertPortClosed(f.port);
    assert.throws(() => process.kill(f.child.pid, 0), { code: 'ESRCH' });
  } finally { await f.cleanup(); }
});

test('owned pipe closure during startup cannot leave a Vite listener or child behind', async () => {
  const f = await fixture();
  try {
    f.child.stdin.end();
    assert.deepEqual(await within(f.done, 20000), { code: 0, signal: null }, f.output());
    await assertPortClosed(f.port);
    assert.throws(() => process.kill(f.child.pid, 0), { code: 'ESRCH' });
  } finally { await f.cleanup(); }
});
