import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { root, pins, options, requireNode, validateEntries, checkedPath, mainGuard } from './build.mjs';

export const taskkillPath = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/taskkill.exe') : null;
function proxyError(response, status, code, message) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ code, message, request_id: randomUUID(), details: null }));
}
export function validateRelease(build) {
  if (!fs.existsSync(path.join(build, 'release.json'))) throw new Error('build_missing: run the release build first');
  const manifest = JSON.parse(fs.readFileSync(path.join(build, 'release.json'), 'utf8'));
  if (manifest.format !== 'weblabel-local-release' || manifest.version !== 1 || manifest.platform !== process.platform || manifest.arch !== process.arch || JSON.stringify(manifest.pins) !== JSON.stringify(pins)) throw new Error('build_incompatible');
  validateEntries(build, manifest.files);
  const api = `api/${process.platform === 'win32' ? 'weblabel-api.exe' : 'weblabel-api'}`;
  for (const name of [api, 'host/runtime.mjs', 'host/mcp.mjs', 'web/index.html', 'web/wasm/wasm_bridge.js', 'web/wasm/wasm_bridge_bg.wasm']) if (!manifest.files.some(item => item.path === name && item.size > 0)) throw new Error(`build_missing: ${name}`);
  return { manifest, api: checkedPath(build, api) };
}
export async function stopTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  if (process.platform === 'win32') {
    const killer = spawn(taskkillPath, ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    const [code] = await once(killer, 'close');
    if (code !== 0 && child.exitCode === null && child.signalCode === null) throw new Error('owned_tree_stop_failed');
  } else {
    try { process.kill(-child.pid, 'SIGINT'); } catch { child.kill('SIGINT'); }
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000);
    timer.unref();
    await closed; clearTimeout(timer); return;
  }
  await closed;
}
export async function startLocal(argv = process.argv.slice(2)) {
  const args = options(argv, ['--build-dir', '--data-dir', '--port', '--api-port']);
  requireNode();
  const build = path.resolve(args['--build-dir'] ?? path.join(root, 'target/local-release'));
  const { manifest, api } = validateRelease(build);
  if (taskkillPath && !fs.existsSync(taskkillPath)) throw new Error('process_tree_tool_missing: Windows System32/taskkill.exe required');
  const port = Number(args['--port'] ?? 48100), apiPort = Number(args['--api-port'] ?? 48101);
  if (![port, apiPort].every(n => Number.isInteger(n) && n > 0 && n <= 65535) || port === apiPort) throw new Error('invalid_loopback_ports');
  const data = path.resolve(args['--data-dir'] ?? path.join(root, 'data'));
  fs.mkdirSync(data, { recursive: true });
  let restoreAuth = false;
  if (fs.existsSync(path.join(data, 'restore.json'))) {
    const marker = JSON.parse(fs.readFileSync(checkedPath(data, 'restore.json'), 'utf8'));
    if (marker.format !== 'weblabel-restored-data' || marker.version !== 1 || marker.authentication !== 'scrubbed-fresh-local-bootstrap-required' || !/^[0-9a-f]{64}$/.test(marker.backup_manifest_sha256)) throw new Error('restore_marker_invalid');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(checkedPath(data, 'api.sqlite'), { readOnly: true });
    try {
      restoreAuth = db.prepare('SELECT COUNT(*) AS count FROM users').get().count > 0
        && db.prepare("SELECT COUNT(*) AS count FROM users WHERE password_hash<>''").get().count === 0
        && db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count === 0;
    } finally { db.close(); }
  }
  const lockPath = path.join(data, 'runtime.lock');
  let lock;
  try { lock = fs.openSync(lockPath, 'wx'); } catch { throw new Error('data_in_use: runtime.lock exists; never remove it while a service is alive'); }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, port, apiPort })); fs.closeSync(lock);
  const base = `http://127.0.0.1:${port}`, apiBase = `http://127.0.0.1:${apiPort}`;
  const env = { ...process.env, WEBLABEL_ENV: 'production', WEBLABEL_BIND: `127.0.0.1:${apiPort}`, WEBLABEL_COOKIE_SECURE: 'false', WEBLABEL_DATABASE_URL: `sqlite:${path.join(data, 'api.sqlite')}`, WEBLABEL_OBJECT_ROOT: path.join(data, 'objects') };
  delete env.WEBLABEL_RESTORE_AUTH;
  if (restoreAuth) env.WEBLABEL_RESTORE_AUTH = '1';
  // AI is optional. Only explicit private configuration activates the packaged Host.
  if (process.env.WEBLABEL_HOST_CONFIG) {
    env.WEBLABEL_HOST_EXECUTABLE = process.execPath;
    env.WEBLABEL_HOST_CWD = data;
    env.WEBLABEL_HOST_SCRIPT = path.join(build, 'host/runtime.mjs');
  } else {
    for (const key of ['WEBLABEL_HOST_EXECUTABLE', 'WEBLABEL_HOST_SCRIPT', 'WEBLABEL_HOST_CWD', 'WEBLABEL_HOST_ALLOWED_ENV']) delete env[key];
  }
  const allowed = new Set(manifest.files.filter(item => item.path.startsWith('web/')).map(item => item.path));
  const server = http.createServer((request, response) => {
    if (request.headers.host !== `127.0.0.1:${port}` || (request.headers.origin && request.headers.origin !== base)) { proxyError(response, 403, 'LOOPBACK_ORIGIN_DENIED', 'Host or Origin is not the configured local entrypoint'); return; }
    let url; try { url = new URL(request.url ?? '/', base); } catch { proxyError(response, 400, 'INVALID_URL', 'Request URL is invalid'); return; }
    if (url.pathname.startsWith('/api/')) {
      const headers = { ...request.headers, host: `127.0.0.1:${apiPort}` };
      if (request.headers.origin) headers.origin = apiBase;
      const upstream = http.request(new URL(url.pathname + url.search, apiBase), { method: request.method, headers }, incoming => { response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response); });
      upstream.on('error', () => { if (response.headersSent) response.destroy(); else proxyError(response, 503, 'API_UNAVAILABLE', 'The local API is unavailable'); });
      request.on('aborted', () => upstream.destroy()); request.pipe(upstream); return;
    }
    if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(405).end(); return; }
    let name; try { name = `web${decodeURIComponent(url.pathname)}`; } catch { response.writeHead(400).end(); return; }
    if (name === 'web/') name = 'web/index.html';
    if (!allowed.has(name)) { response.writeHead(404).end(); return; }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png' };
    response.writeHead(200, { 'content-type': types[path.extname(name)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' });
    if (request.method === 'HEAD') response.end();
    else {
      const stream = fs.createReadStream(path.join(build, name));
      stream.on('error', () => response.destroy());
      response.on('close', () => stream.destroy());
      stream.pipe(response);
    }
  });
  let child;
  let stopping;
  const stop = () => stopping ??= (async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (child) await stopTree(child);
    fs.unlinkSync(lockPath);
  })();
  const interrupt = () => { stop().then(() => { process.exitCode = 130; }).catch(error => { console.error(error.message); process.exitCode = 1; }); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    child = spawn(api, [], { cwd: data, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', error => { console.error(error.message); process.exitCode = 1; void stop(); });
    child.once('exit', code => { if (!stopping) { process.exitCode = code ?? 1; void stop(); } });
    console.log(`WEBLABEL_LOCAL_URL=${base}`);
  } catch (error) { await stop(); throw error; }
  return { stop, child, base_url: base, data };
}
mainGuard(import.meta.url, () => startLocal());
