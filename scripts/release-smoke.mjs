import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { options, requireNode, mainGuard } from './build.mjs';

function check(condition, code) { if (!condition) throw new Error(code); }
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const same = isDeepStrictEqual;
async function response(base, route, init = {}) {
  return fetch(new URL(route, base), { ...init, signal: AbortSignal.timeout(10000) });
}
async function jsonRequest(base, auth, method, route, payload, status) {
  const result = await response(base, route, { method, headers: { origin: base, ...(auth ? { cookie: auth.cookie, 'x-csrf-token': auth.csrf } : {}), ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  check(result.status === status, `http_status_${method}_${route.split('?')[0]}_expected_${status}_actual_${result.status}`);
  return result.status === 204 ? null : result.json();
}
function authentication(result, body) {
  const cookie = (result.headers.get('set-cookie') ?? '').split(';')[0];
  check(cookie.length > 0 && typeof body.csrf_token === 'string' && body.csrf_token.length > 0, 'authentication_missing');
  return { cookie, csrf: body.csrf_token };
}
async function login(base, username, password) {
  const result = await response(base, '/api/session/login', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  check(result.status === 200, 'login_failed');
  return { ...authentication(result, await result.json()), username, password };
}
// An actual deterministic 64x48 PNG, not a mock worker or a source-tree fixture.
function syntheticPng() {
  const chunk = (type, data) => {
    const payload = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of payload) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length); payload.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
    return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(64, 0); header.writeUInt32BE(48, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((64 * 3 + 1) * 48, 128);
  for (let row = 0; row < 48; row++) pixels[row * (64 * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

/** Returns synthetic public IDs/revisions plus private in-memory auth. Never serialize state to logs. */
export async function exerciseRuntime(base, launchCode) {
  const checks = [];
  const html = await response(base, '/');
  check(html.status === 200 && (await html.text()).includes('<div id="root">'), 'http_static_failed');
  const wasm = await response(base, '/wasm/wasm_bridge_bg.wasm');
  const wasmBytes = Buffer.from(await wasm.arrayBuffer());
  check(wasm.status === 200 && wasm.headers.get('content-type') === 'application/wasm' && wasmBytes.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109])), 'http_wasm_failed');
  checks.push('http-static', 'http-wasm');
  check((await response(base, '/api/projects')).status === 401, 'unauthorized_projects_not_denied');
  check((await response(base, '/api/projects', { headers: { origin: 'https://attacker.invalid' } })).status === 403, 'cross_origin_not_denied');
  checks.push('unauthorized-rejected', 'cross-origin-rejected');
  const password = `synthetic-portable-${randomUUID()}`;
  const boot = await response(base, '/api/session/bootstrap', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ launch_code: launchCode, password }) });
  check(boot.status === 200, 'bootstrap_failed');
  const bootstrap = await boot.json();
  authentication(boot, bootstrap);
  check(bootstrap.username === 'local-admin', 'bootstrap_identity_unexpected');
  const auth = await login(base, bootstrap.username, password);
  checks.push('bootstrap', 'login');
  const project = await jsonRequest(base, auth, 'POST', '/api/projects', { name: 'Portable synthetic 中文 project', description: 'Disposable engineering smoke; no business data', allow_self_review: true }, 201);
  const projectId = project.project_id;
  const ontology = await jsonRequest(base, auth, 'POST', `/api/projects/${projectId}/ontologies`, { guidelines_markdown: 'Synthetic portable smoke', labels: [{ label_id: 'person', name: 'Person', color: '#0099ff', shortcut: null, allowed_geometry_types: ['bbox_xyxy'], attributes: [] }] }, 201);
  const ontologyId = ontology.ontology_version_id;
  const form = new FormData(); form.append('images', new Blob([syntheticPng()], { type: 'image/png' }), '合成 image.png');
  const upload = await response(base, `/api/projects/${projectId}/assets`, { method: 'POST', headers: { cookie: auth.cookie, origin: base, 'x-csrf-token': auth.csrf, 'idempotency-key': randomUUID() }, body: form });
  check(upload.status === 202, 'image_upload_failed');
  let asset;
  for (let i = 0; i < 100; i++) {
    const list = await jsonRequest(base, auth, 'GET', `/api/projects/${projectId}/assets`, undefined, 200);
    asset = list.items?.[0]; if (asset) break; await delay(100);
  }
  check(typeof asset?.asset_revision_id === 'string', 'media_worker_asset_missing');
  const assetId = asset.asset_revision_id;
  const image = await response(base, `/api/assets/${assetId}/image`, { headers: { cookie: auth.cookie, origin: base } });
  check(image.status === 200 && image.headers.get('content-type') === 'image/png', 'image_read_failed');
  const mediaSha256 = digest(Buffer.from(await image.arrayBuffer()));
  check((await response(base, `/api/assets/${assetId}/image`)).status === 401, 'unauthorized_media_not_denied');
  check((await response(base, `/api/assets/${assetId}/image`, { headers: { cookie: auth.cookie, origin: 'https://attacker.invalid' } })).status === 403, 'cross_origin_media_not_denied');
  checks.push('project-create', 'image-upload-worker', 'image-read', 'media-permission');
  const route = `/api/assets/${assetId}/annotation`;
  const head = await jsonRequest(base, auth, 'GET', `${route}?ontology_version_id=${ontologyId}`, undefined, 200);
  check(head.document.coordinate_space.width === 64 && head.document.coordinate_space.height === 48, 'canonical_dimensions_wrong');
  const document = { ...head.document, completion: 'complete', objects: [{ object_id: 'portable-object', label_id: 'person', geometry: { type: 'bbox_xyxy', x_min: 10.25, y_min: 5.5, x_max: 40.75, y_max: 30.125 }, attributes: {}, origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null } }] };
  const save = { operation_id: randomUUID(), base_revision_id: head.annotation_revision_id, document, lease: null, suggestion_decisions: [] };
  const saved = await jsonRequest(base, auth, 'PUT', route, save, 200);
  const revisionId = saved.revision.annotation_revision_id, revisionNo = saved.revision.revision_no;
  check(typeof revisionId === 'string' && Number.isSafeInteger(revisionNo) && revisionNo > 0 && same(saved.revision.document, document), 'annotation_save_wrong');
  const replay = await jsonRequest(base, auth, 'PUT', route, save, 200);
  check(replay.revision.annotation_revision_id === revisionId && replay.revision.revision_no === revisionNo, 'save_idempotency_wrong');
  await jsonRequest(base, auth, 'PUT', route, { ...save, document: { ...document, completion: 'in_progress' } }, 409);
  await jsonRequest(base, auth, 'PUT', route, { ...save, operation_id: randomUUID() }, 409);
  const state = { projectId, ontologyId, assetId, revisionId, revisionNo, document, mediaSha256, auth, checks };
  await verifyPersisted(base, state);
  checks.push('annotation-save-readback', 'idempotent-save', 'operation-payload-conflict', 'cas-conflict');
  return state;
}

export async function verifyPersisted(base, state) {
  state.auth = await login(base, state.auth.username, state.auth.password);
  const projects = await jsonRequest(base, state.auth, 'GET', '/api/projects', undefined, 200);
  check(projects.items.some(item => item.project_id === state.projectId), 'persisted_project_missing');
  const current = await jsonRequest(base, state.auth, 'GET', `/api/assets/${state.assetId}/annotation?ontology_version_id=${state.ontologyId}`, undefined, 200);
  check(current.annotation_revision_id === state.revisionId && same(current.document, state.document), 'persisted_annotation_head_changed');
  const revision = await jsonRequest(base, state.auth, 'GET', `/api/annotation-revisions/${state.revisionId}`, undefined, 200);
  check(revision.annotation_revision_id === state.revisionId && revision.revision_no === state.revisionNo && same(revision.document, state.document), 'persisted_revision_changed');
  const media = await response(base, `/api/assets/${state.assetId}/image`, { headers: { cookie: state.auth.cookie, origin: base } });
  check(media.status === 200 && digest(Buffer.from(await media.arrayBuffer())) === state.mediaSha256, 'persisted_media_changed');
  return { checks: ['persisted-project', 'same-revision', 'same-document', 'same-media'] };
}

async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; const closed = once(server, 'close'); server.close(); await closed; return port;
}
async function ready(base, child) {
  for (let i = 0; i < 200; i++) {
    check(child.exitCode === null && child.signalCode === null, 'owned_api_exited');
    try { if ((await response(base, '/api/session')).status === 401) return; } catch {}
    await delay(50);
  }
  throw new Error('owned_api_readiness_timeout');
}
async function closedEndpoint(base) {
  try { await response(base, '/api/session'); } catch { return; }
  throw new Error('owned_endpoint_still_open');
}

async function worker(bundle) {
  const { requireNode, validateEntries, sha } = await import(pathToFileURL(path.join(bundle, 'scripts/build.mjs')).href);
  requireNode();
  const node = path.join(bundle, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
  check(fs.realpathSync(process.execPath) === fs.realpathSync(node), 'not_bundled_node');
  check(fs.readdirSync(process.env.PATH).length === 0, 'developer_tools_path_not_empty');
  const cwd = fs.realpathSync(process.cwd());
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  check(cwd !== sourceRoot && !cwd.startsWith(sourceRoot + path.sep) && cwd !== bundle && !cwd.startsWith(bundle + path.sep), 'smoke_cwd_not_isolated');
  const metadata = JSON.parse(fs.readFileSync(path.join(bundle, 'bundle.json'), 'utf8'));
  check(metadata.format === 'weblabel-portable-bundle' && metadata.version === 1 && metadata.platform === process.platform && metadata.arch === process.arch && metadata.node_version === process.versions.node, 'bundle_incompatible');
  validateEntries(bundle, metadata.files);
  check(sha(node) === metadata.node_sha256 && sha(path.join(bundle, 'bin/NodeLICENSE')) === metadata.node_license_sha256, 'bundled_runtime_hash_wrong');
  const { startLocal, validateRelease } = await import(pathToFileURL(path.join(bundle, 'scripts/start-local.mjs')).href);
  const build = path.join(bundle, 'release');
  const { manifest } = validateRelease(build);
  check(manifest.source_commit === metadata.source_commit && sha(path.join(build, 'release.json')) === metadata.release_manifest_sha256, 'bundle_release_manifest_wrong');
  const data = path.join(process.cwd(), '中文 space data');
  let running;
  let launchCode;
  process.on('message', message => { if (message.launchCode) launchCode = message.launchCode; });
  const launch = async () => {
    const port = await freePort(); let apiPort = await freePort(); while (apiPort === port) apiPort = await freePort();
    const runtime = await startLocal(['--build-dir', build, '--data-dir', data, '--port', String(port), '--api-port', String(apiPort)]);
    running = runtime; await ready(runtime.base_url, runtime.child); return { ...runtime, apiBase: `http://127.0.0.1:${apiPort}` };
  };
  const stop = async runtime => {
    await runtime.stop(); running = null;
    check(!fs.existsSync(path.join(data, 'runtime.lock')), 'runtime_lock_not_removed');
    await closedEndpoint(runtime.base_url); await closedEndpoint(runtime.apiBase);
  };
  try {
    const first = await launch();
    for (let i = 0; !launchCode && i < 200; i++) await delay(25);
    check(typeof launchCode === 'string', 'bootstrap_code_not_received');
    const state = await exerciseRuntime(first.base_url, launchCode);
    launchCode = undefined;
    await stop(first);
    const restarted = await launch();
    const persisted = await verifyPersisted(restarted.base_url, state);
    await stop(restarted);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(data, 'api.sqlite'), { readOnly: true });
    try {
      check(db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok', 'sqlite_integrity_failed');
      check(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'sqlite_foreign_keys_failed');
    } finally { db.close(); }
    return { format: 'weblabel-portable-smoke', source_commit: manifest.source_commit, platform: process.platform, arch: process.arch, node_version: process.versions.node, checks: ['bundle-manifest-hashes', 'immutable-release-manifest', 'bundled-exact-node', 'no-developer-tools-path', 'non-source-cwd', 'chinese-space-data', ...state.checks, 'stop-owned-endpoints', 'runtime-lock-cleanup', 'data-restart', ...persisted.checks, 'sqlite-integrity', 'sqlite-foreign-keys'] };
  } finally { if (running) await running.stop(); }
}

export async function releaseSmoke(argv = process.argv.slice(2)) {
  const args = options(argv, ['--bundle-dir']);
  requireNode();
  check(args['--bundle-dir'] && path.isAbsolute(args['--bundle-dir']), 'required_absolute_bundle_dir');
  const bundle = fs.realpathSync(args['--bundle-dir']);
  const script = fileURLToPath(import.meta.url);
  if (process.env.WEBLABEL_PORTABLE_SMOKE_WORKER === '1') {
    check(process.send, 'worker_ipc_required');
    try { process.send({ summary: await worker(bundle) }); } catch (error) { process.send({ failure: error.message }); process.exitCode = 1; }
    process.disconnect(); return;
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'weblabel-portable-'));
  const emptyPath = path.join(scratch, 'empty-path'); fs.mkdirSync(emptyPath);
  let child;
  try {
    const env = { PATH: emptyPath, WEBLABEL_PORTABLE_SMOKE_WORKER: '1', TEMP: scratch, TMP: scratch, TMPDIR: scratch, HOME: scratch, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', WINDIR: process.env.WINDIR ?? 'C:\\Windows' } : {}) };
    child = spawn(path.join(bundle, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'), [script, '--bundle-dir', bundle], { cwd: scratch, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let partial = '', summary, failure;
    // Bootstrap and all native logs stay inside the parent; they never reach CLI output.
    child.stdout.on('data', chunk => {
      const lines = (partial + String(chunk)).split(/\r?\n/); partial = lines.pop().slice(-4096);
      for (const line of lines) { const match = /^WEBLABEL_BOOTSTRAP_CODE=([0-9a-f]+)$/.exec(line); if (match && child.connected) child.send({ launchCode: match[1] }); }
    });
    child.stderr.resume();
    child.on('message', message => { if (message.summary) summary = message.summary; if (message.failure) failure = message.failure; });
    const [code] = await once(child, 'close');
    check(code === 0 && summary, failure ?? 'portable_worker_failed');
    console.log(JSON.stringify(summary));
    return summary;
  } finally {
    // Worker owns real stop/lock cleanup before close, including its failure path.
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
mainGuard(import.meta.url, () => releaseSmoke());
