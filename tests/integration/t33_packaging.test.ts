import { expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from 'node:child_process';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { buildRelease, root, sha, files } from '../../scripts/build.mjs';
import { validateRelease, stopTree, taskkillPath } from '../../scripts/start-local.mjs';
import { schemaHash } from '../../scripts/backup.mjs';

const scratch = path.join(root, 'target', `T33 中文 spaces & ${crypto.randomUUID()}`);
let build: string;
const children: ChildProcess[] = [];
type Value = Record<string, any>;
function cli(script: string, args: string[], env = process.env) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], { cwd: root, encoding: 'utf8', shell: false, env, timeout: 60000 });
}
function success(r: SpawnSyncReturns<string>) { expect(r.status, r.stdout + r.stderr).toBe(0); }
async function port() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('port missing');
  const closed = once(server, 'close'); server.close(); await closed; return address.port;
}
async function launch(data: string, requireBootstrap = true) {
  const webPort = await port(), apiPort = await port();
  const script = `import {startLocal} from ${JSON.stringify(new URL('../../scripts/start-local.mjs', import.meta.url).href)}; await startLocal(${JSON.stringify(['--build-dir', build, '--data-dir', data, '--port', String(webPort), '--api-port', String(apiPort)])}); process.on('message',()=>{process.emit('SIGINT');process.disconnect();});`;
  // Windows runtime PATH deliberately excludes Python, pnpm and official provider CLIs.
  const env = { ...process.env, PATH: taskkillPath ? path.dirname(taskkillPath) : '/usr/bin:/bin', WEBLABEL_HOST_CONFIG: '' };
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env, shell: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.push(child);
  let output = ''; child.stdout?.on('data', chunk => { output += String(chunk); }); child.stderr?.on('data', chunk => { output += String(chunk); });
  const base = `http://127.0.0.1:${webPort}`;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const code = output.match(/WEBLABEL_BOOTSTRAP_CODE=([0-9a-f]+)/)?.[1];
    if (code || !requireBootstrap) { try { if ((await fetch(base + '/api/session')).status === 401) return { child, base, code: code ?? '', apiPort }; } catch {} }
    if (child.exitCode !== null) throw new Error(output);
    // Real release processes and HTTP polling own independent clocks; fake timers cannot drive them.
    await delay(50);
  }
  throw new Error('bootstrap_missing: ' + output.replace(/WEBLABEL_BOOTSTRAP_CODE=\w+/g, '[private bootstrap]'));
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(15000) });
  child.send('interrupt'); await exited;
}
async function authenticated(base: string, code: string) {
  const response = await fetch(base + '/api/session/bootstrap', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ launch_code: code, password: 'T33-synthetic-new-password' }) });
  const body = await response.json() as Value;
  expect(response.status, JSON.stringify(body)).toBe(200);
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  const request = async (method: string, route: string, payload?: unknown) => {
    const result = await fetch(base + route, { method, headers: { cookie, origin: base, 'x-csrf-token': body.csrf_token, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    return { status: result.status, body: await result.json() as Value };
  };
  return { request, cookie, csrf: body.csrf_token, userId: body.user_id, username: body.username };
}
beforeAll(async () => {
  fs.mkdirSync(scratch, { recursive: true });
  build = process.env.WEBLABEL_T33_RELEASE ?? path.join(scratch, 'release');
  if (!process.env.WEBLABEL_T33_RELEASE) await buildRelease(['--build-dir', build, ...(process.env.WEBLABEL_CARGO_CWD ? ['--cargo-cwd', process.env.WEBLABEL_CARGO_CWD] : [])]);
  validateRelease(build);
}, 600000);
afterAll(async () => { await Promise.all(children.map(stop)); fs.rmSync(scratch, { recursive: true, force: true }); }, 30000);

it('start-local fails honestly when release composition is missing', () => {
  const r = cli('start-local.mjs', ['--build-dir', path.join(scratch, '不存在 release & no-build')]);
  expect(r.status).not.toBe(0); expect(r.stdout + r.stderr).toMatch(/build_missing/);
});
it('rejects tampered products and release manifests without required WASM', () => {
  const copy = path.join(scratch, 'bad release'); fs.cpSync(build, copy, { recursive: true });
  fs.appendFileSync(path.join(copy, 'web/wasm/wasm_bridge_bg.wasm'), 'corruption');
  expect(cli('start-local.mjs', ['--build-dir', copy]).stderr).toMatch(/hash_mismatch/);
  const manifest = JSON.parse(fs.readFileSync(path.join(copy, 'release.json'), 'utf8'));
  manifest.files = manifest.files.filter((entry: Value) => !entry.path.includes('wasm_bridge_bg.wasm'));
  fs.writeFileSync(path.join(copy, 'release.json'), JSON.stringify(manifest));
  expect(cli('start-local.mjs', ['--build-dir', copy]).stderr).toMatch(/build_missing/);
});
it('doctor stays read-only, reports pinned versions separately from live capability and never emits secrets', () => {
  const before = files(build).map((name: string) => [name, sha(path.join(build, name))]);
  const r = cli('doctor.mjs', ['--build-dir', build, ...(process.env.WEBLABEL_CARGO_CWD ? ['--cargo-cwd', process.env.WEBLABEL_CARGO_CWD] : [])], { ...process.env, OPENAI_API_KEY: 'T33-do-not-publish-secret' });
  success(r); const result = JSON.parse(r.stdout);
  expect(result.capabilities.models).toBe('live-not-run'); expect(result.capabilities.webgpu).toBe('browser-device-probe-required');
  expect(r.stdout + r.stderr).not.toContain('T33-do-not-publish-secret');
  expect(files(build).map((name: string) => [name, sha(path.join(build, name))])).toEqual(before);
  const missing = cli('doctor.mjs', ['--build-dir', build], { ...process.env, PATH: '' });
  expect(missing.status).not.toBe(0); expect(JSON.parse(missing.stdout).tools.find((tool: Value) => tool.name === 'rustc').status).toBe('missing');
});
it('accepts Chinese/space paths, serves complete current products, enforces origin, prevents concurrent data use and cleans the owned API on SIGINT', async () => {
  const data = path.join(scratch, '启动 & 中文 data'); const running = await launch(data);
  const web = await fetch(running.base); expect(web.status).toBe(200); expect(await web.text()).toContain('<div id="root">');
  expect((await fetch(running.base + '/wasm/wasm_bridge_bg.wasm')).headers.get('content-type')).toBe('application/wasm');
  const denied = await fetch(running.base + '/api/projects', { headers: { origin: 'https://attacker.invalid' } });
  expect(denied.status).toBe(403); expect(await denied.json()).toMatchObject({ code: 'LOOPBACK_ORIGIN_DENIED', details: null });
  expect((await fetch(running.base + '/api/projects')).status).toBe(401);
  expect(cli('start-local.mjs', ['--build-dir', build, '--data-dir', data, '--port', String(await port()), '--api-port', String(await port())]).stderr).toMatch(/data_in_use/);
  await authenticated(running.base, running.code);
  await stop(running.child); expect(fs.existsSync(path.join(data, 'runtime.lock'))).toBe(false);
  await expect(fetch(`http://127.0.0.1:${running.apiPort}/api/session`)).rejects.toThrow();
  const db = new DatabaseSync(path.join(data, 'api.sqlite'), { readOnly: true });
  expect(db.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok'); db.close();
}, 60000);
it('terminates a real owned child and grandchild tree, not just its parent PID', async () => {
  const descendantPort = await port();
  const leaf = `require('node:http').createServer((q,r)=>r.end('owned-grandchild')).listen(${descendantPort},'127.0.0.1',()=>console.log('LISTENING'));`;
  const parent = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{shell:false,stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', parent], { shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await once(child.stdout!, 'data', { signal: AbortSignal.timeout(15000) });
    expect(await (await fetch(`http://127.0.0.1:${descendantPort}`)).text()).toBe('owned-grandchild');
    await stopTree(child);
    await expect(fetch(`http://127.0.0.1:${descendantPort}`)).rejects.toThrow();
  } finally { await stopTree(child); }
}, 30000);
it('backs up live WAL consistently, scrubs authentication/configuration, refuses corrupt/schema/existing targets and restores revision, media and snapshot through fresh local auth', async () => {
  const data = path.join(scratch, '业务 data'), backupDir = path.join(scratch, '备份 & snapshot'), restored = path.join(scratch, '恢复 fresh');
  const running = await launch(data); const admin = await authenticated(running.base, running.code);
  const project = await admin.request('POST', '/api/projects', { name: 'T33 business', description: 'keep audit identity', allow_self_review: true }); expect(project.status).toBe(201);
  const projectId = project.body.project_id;
  const ontology = await admin.request('POST', `/api/projects/${projectId}/ontologies`, { guidelines_markdown: 'T33', labels: [{ label_id: 'person', name: 'Person', color: '#0099ff', shortcut: null, allowed_geometry_types: ['bbox_xyxy'], attributes: [] }] }); expect(ontology.status).toBe(201);
  const ontologyId = ontology.body.ontology_version_id;
  const form = new FormData(); form.append('images', new Blob([fs.readFileSync(path.join(root, 'tests/fixtures/media/orientation-1.jpg'))], { type: 'image/jpeg' }), '测试 image.jpg');
  const upload = await fetch(running.base + `/api/projects/${projectId}/assets`, { method: 'POST', headers: { cookie: admin.cookie, origin: running.base, 'x-csrf-token': admin.csrf, 'idempotency-key': crypto.randomUUID() }, body: form }); expect(upload.status).toBe(202);
  let asset: Value | undefined;
  // Poll the real release media worker; its OS clock cannot be advanced by Vitest.
  for (let i = 0; i < 100; i++) { const list = await admin.request('GET', `/api/projects/${projectId}/assets`); asset = list.body.items?.[0]; if (asset) break; await delay(100); }
  expect(asset).toBeDefined(); const assetId = asset!.asset_revision_id;
  const head = await admin.request('GET', `/api/assets/${assetId}/annotation?ontology_version_id=${ontologyId}`);
  const document = { ...head.body.document, completion: 'complete', objects: [{ object_id: 't33-object', label_id: 'person', geometry: { type: 'bbox_xyxy', x_min: 10, y_min: 5, x_max: 40, y_max: 30 }, attributes: {}, origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null } }] };
  const saved = await admin.request('PUT', `/api/assets/${assetId}/annotation`, { operation_id: crypto.randomUUID(), base_revision_id: head.body.annotation_revision_id, document, lease: null, suggestion_decisions: [] }); expect(saved.status).toBe(200); const revision = saved.body.revision;
  const task = await admin.request('POST', `/api/projects/${projectId}/tasks`, { asset_revision_id: assetId, ontology_version_id: ontologyId, assignee_id: admin.userId }); expect(task.status).toBe(200);
  expect((await admin.request('POST', `/api/tasks/${task.body.task_id}/lease`, { action: 'acquire' })).status).toBe(200);
  const submit = await admin.request('POST', `/api/tasks/${task.body.task_id}/submit`, { annotation_revision_ids: [revision.annotation_revision_id] }); expect(submit.status).toBe(200);
  expect((await admin.request('POST', `/api/reviews/${submit.body.review_id}/decision`, { decision: 'approve', reason: 'preserve original auditor', revision_ids: [revision.annotation_revision_id] })).status).toBe(200);
  const snapshot = await admin.request('POST', `/api/projects/${projectId}/dataset-versions`, { operation_id: crypto.randomUUID(), ontology_version_id: ontologyId, items: [{ asset_revision_id: assetId, annotation_revision_id: revision.annotation_revision_id, split: 'train' }], excluded: [], split_seed: null, split_ratios: null }); expect(snapshot.status).toBe(201);
  const sourceDb = new DatabaseSync(path.join(data, 'api.sqlite'));
  sourceDb.prepare("INSERT INTO model_profiles VALUES(?, 'openai_api', 'synthetic-not-live', 'api_key', '{}', 'needs_configuration', 'not_run', NULL, NULL, ?, ?, ?)").run('t33-profile', JSON.stringify({ api_key: 'T33-secret-config-value', endpoint: 'http://invalid.example' }), 'T33-secret-ref', new Date().toISOString());
  const originalPassword = sourceDb.prepare('SELECT password_hash FROM users WHERE user_id=?').get(admin.userId)!.password_hash as string;
  const originalSessions = sourceDb.prepare('SELECT session_id,csrf_hash FROM sessions').all().flatMap(row => [row.session_id as string, row.csrf_hash as string]);
  sourceDb.close();
  success(cli('backup.mjs', ['--data-dir', data, '--backup-dir', backupDir]));
  const bytes = fs.readFileSync(path.join(backupDir, 'api.sqlite'));
  for (const secret of [originalPassword, ...originalSessions, 'T33-secret-config-value', 'T33-secret-ref']) expect(bytes.includes(Buffer.from(secret))).toBe(false);
  expect((await admin.request('GET', '/api/session')).status).toBe(200);
  const backupDb = new DatabaseSync(path.join(backupDir, 'api.sqlite'), { readOnly: true });
  expect(backupDb.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n).toBe(0);
  expect(backupDb.prepare('SELECT created_by FROM annotation_revisions WHERE annotation_revision_id=?').get(revision.annotation_revision_id)!.created_by).toBe(admin.userId);
  expect(backupDb.prepare('SELECT manifest_sha256 FROM dataset_versions').get()!.manifest_sha256).toBe(snapshot.body.manifest_sha256); backupDb.close();
  const exists = path.join(scratch, 'existing'); fs.mkdirSync(exists); fs.writeFileSync(path.join(exists, 'preserve'), 'business');
  expect(cli('restore.mjs', ['--backup-dir', backupDir, '--data-dir', exists]).stderr).toMatch(/restore_directory_exists/); expect(fs.readFileSync(path.join(exists, 'preserve'), 'utf8')).toBe('business');
  const corrupt = path.join(scratch, 'corrupt'); fs.cpSync(backupDir, corrupt, { recursive: true }); fs.appendFileSync(path.join(corrupt, 'api.sqlite'), 'damage');
  expect(cli('restore.mjs', ['--backup-dir', corrupt, '--data-dir', path.join(scratch, 'no-corrupt')]).stderr).toMatch(/hash_mismatch/); expect(fs.existsSync(path.join(scratch, 'no-corrupt'))).toBe(false);
  const incompatible = path.join(scratch, 'incompatible'); fs.cpSync(backupDir, incompatible, { recursive: true }); const badManifest = JSON.parse(fs.readFileSync(path.join(incompatible, 'backup.json'), 'utf8')); badManifest.schema_hash = '0'.repeat(64); fs.writeFileSync(path.join(incompatible, 'backup.json'), JSON.stringify(badManifest));
  expect(cli('restore.mjs', ['--backup-dir', incompatible, '--data-dir', path.join(scratch, 'no-schema')]).stderr).toMatch(/schema_mismatch/);
  const forged = path.join(scratch, 'forged-schema'); fs.cpSync(backupDir, forged, { recursive: true });
  const forgedDb = new DatabaseSync(path.join(forged, 'api.sqlite'));
  forgedDb.exec('CREATE TABLE malicious_extra (secret TEXT)');
  const forgedManifest = JSON.parse(fs.readFileSync(path.join(forged, 'backup.json'), 'utf8'));
  forgedManifest.schema_hash = schemaHash(forgedDb); forgedDb.close();
  const forgedEntry = forgedManifest.files.find((entry: Value) => entry.path === 'api.sqlite');
  forgedEntry.sha256 = sha(path.join(forged, 'api.sqlite')); forgedEntry.size = fs.statSync(path.join(forged, 'api.sqlite')).size;
  fs.writeFileSync(path.join(forged, 'backup.json'), JSON.stringify(forgedManifest));
  expect(cli('restore.mjs', ['--backup-dir', forged, '--data-dir', path.join(scratch, 'no-forged-schema')]).stderr).toMatch(/schema_incompatible/);
  const forgedObject = path.join(scratch, 'forged-object'); fs.cpSync(backupDir, forgedObject, { recursive: true });
  const objectManifest = JSON.parse(fs.readFileSync(path.join(forgedObject, 'backup.json'), 'utf8'));
  const objectEntry = objectManifest.files.find((entry: Value) => entry.path.startsWith('objects/'));
  fs.appendFileSync(path.join(forgedObject, objectEntry.path), 'object corruption');
  objectEntry.sha256 = sha(path.join(forgedObject, objectEntry.path)); objectEntry.size = fs.statSync(path.join(forgedObject, objectEntry.path)).size;
  fs.writeFileSync(path.join(forgedObject, 'backup.json'), JSON.stringify(objectManifest));
  expect(cli('restore.mjs', ['--backup-dir', forgedObject, '--data-dir', path.join(scratch, 'no-forged-object')]).stderr).toMatch(/backup_object_missing_or_corrupt/);
  success(cli('restore.mjs', ['--backup-dir', backupDir, '--data-dir', restored]));
  const recovered = await launch(restored); const fresh = await authenticated(recovered.base, recovered.code); expect(fresh.userId).not.toBe(admin.userId);
  const oldSession = await fetch(recovered.base + '/api/session', { headers: { cookie: admin.cookie, origin: recovered.base } }); expect(oldSession.status).toBe(401);
  const oldLogin = await fetch(recovered.base + '/api/session/login', { method: 'POST', headers: { origin: recovered.base, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'local-admin', password: 'T33-synthetic-new-password' }) }); expect(oldLogin.status).toBe(401);
  const readRevision = await fresh.request('GET', `/api/annotation-revisions/${revision.annotation_revision_id}`); expect(readRevision.status).toBe(200); expect(readRevision.body).toEqual(revision);
  const image = await fetch(recovered.base + `/api/assets/${assetId}/image`, { headers: { cookie: fresh.cookie, origin: recovered.base } }); expect(image.status).toBe(200); expect(sha(path.join(restored, 'objects', asset!.canonical_sha256.slice(0, 2), asset!.canonical_sha256.slice(2, 4), asset!.canonical_sha256))).toBe(asset!.canonical_sha256);
  const exported = await fresh.request('POST', `/api/dataset-versions/${snapshot.body.dataset_version_id}/exports`, { operation_id: crypto.randomUUID(), format: 'native', loss_ack: false }); expect(exported.status).toBe(202);
  // Poll the real release export worker, not a synthetic/mocked job.
  let job: Value = {}; for (let i = 0; i < 100; i++) { job = (await fresh.request('GET', `/api/jobs/${exported.body.job_id}`)).body; if (job.state === 'succeeded' || job.state === 'failed') break; await delay(100); }
  expect(job.state, JSON.stringify(job)).toBe('succeeded');
  const download = await fetch(recovered.base + job.result.download_url, { headers: { cookie: fresh.cookie, origin: recovered.base } }); expect(download.status).toBe(200);
  const restoredDb = new DatabaseSync(path.join(restored, 'api.sqlite'), { readOnly: true }); expect(restoredDb.prepare('SELECT manifest_sha256 FROM dataset_versions').get()!.manifest_sha256).toBe(snapshot.body.manifest_sha256); expect(restoredDb.prepare('PRAGMA foreign_key_check').all()).toEqual([]); restoredDb.close();
  await stop(recovered.child);
  const restarted = await launch(restored, false);
  const loginAgain = await fetch(restarted.base + '/api/session/login', { method: 'POST', headers: { origin: restarted.base, 'content-type': 'application/json' }, body: JSON.stringify({ username: fresh.username, password: 'T33-synthetic-new-password' }) });
  expect(loginAgain.status).toBe(200);
  const reloginCookie = loginAgain.headers.get('set-cookie')!.split(';')[0]!;
  const durableRead = await fetch(restarted.base + `/api/annotation-revisions/${revision.annotation_revision_id}`, { headers: { origin: restarted.base, cookie: reloginCookie } });
  expect(durableRead.status).toBe(200); expect(await durableRead.json()).toEqual(revision);
  await stop(restarted.child); await stop(running.child);
}, 120000);
