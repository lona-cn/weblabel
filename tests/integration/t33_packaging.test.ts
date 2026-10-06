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
async function approvedReview(data: string, originalName = '测试 image.jpg', projectText = { name: 'T33 business', description: 'keep audit identity' }) {
  const running = await launch(data); const admin = await authenticated(running.base, running.code);
  const project = await admin.request('POST', '/api/projects', { ...projectText, allow_self_review: true }); expect(project.status).toBe(201);
  const projectId = project.body.project_id;
  const ontology = await admin.request('POST', `/api/projects/${projectId}/ontologies`, { guidelines_markdown: 'T33', labels: [{ label_id: 'person', name: 'Person', color: '#0099ff', shortcut: null, allowed_geometry_types: ['bbox_xyxy'], attributes: [] }] }); expect(ontology.status).toBe(201);
  const ontologyId = ontology.body.ontology_version_id;
  const form = new FormData(); form.append('images', new Blob([fs.readFileSync(path.join(root, 'tests/fixtures/media/orientation-1.jpg'))], { type: 'image/jpeg' }), originalName);
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
  return { running, admin, projectId, ontologyId, asset: asset!, assetId, revision, reviewId: submit.body.review_id };
}
it('refuses public project name and description credentials, preserving exact project/task history through a fresh portable restore once configuration no longer collides', async () => {
  const data = path.join(scratch, 'public project text');
  const nameSecret = 'owned-project-name-key', descriptionSecret = 'owned-project-description-key';
  const { running, admin, projectId, ontologyId, assetId, revision } = await approvedReview(data, 'ordinary project image.jpg', { name: `  项目 ${nameSecret}  `, description: `description "${descriptionSecret}"\noriginal whitespace  ` });
  const db = new DatabaseSync(path.join(data, 'api.sqlite'));
  try {
    const tables = ['projects', 'review_tasks', 'review_submissions', 'review_decisions', 'annotation_revisions'];
    const before = tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const identities = db.prepare('SELECT user_id,username,created_at,platform_admin FROM users ORDER BY user_id').all();
    db.prepare("INSERT INTO model_profiles VALUES('project-text-profile','openai_api','synthetic-not-live','api_key','{}','needs_configuration','not_run',NULL,NULL,'{}',NULL,?)").run(new Date().toISOString());
    for (const [field, secret] of [['name', nameSecret], ['description', descriptionSecret]]) {
      db.prepare("UPDATE model_profiles SET config_json=? WHERE profile_id='project-text-profile'").run(JSON.stringify({ api_key: secret }));
      const sourceFiles = ['api.sqlite', 'api.sqlite-wal'].filter(file => fs.existsSync(path.join(data, file)));
      const hashes = sourceFiles.map(file => sha(path.join(data, file))), mode = db.prepare('PRAGMA journal_mode').get()!.journal_mode;
      const destination = path.join(scratch, `project-${field}-refused`);
      const result = cli('backup.mjs', ['--data-dir', data, '--backup-dir', destination]);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain('credential_in_immutable_business_data');
      expect(result.stdout + result.stderr).not.toContain(secret);
      expect(fs.existsSync(destination)).toBe(false);
      expect(sourceFiles.map(file => sha(path.join(data, file)))).toEqual(hashes);
      expect(db.prepare('PRAGMA journal_mode').get()!.journal_mode).toBe(mode);
      expect(tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(before);
    }
    db.prepare("UPDATE model_profiles SET config_json=? WHERE profile_id='project-text-profile'").run(JSON.stringify({ api_key: 'unrelated-config-only-key' }));
    const backupDir = path.join(scratch, 'project exact backup'), restored = path.join(scratch, 'project exact restored');
    success(cli('backup.mjs', ['--data-dir', data, '--backup-dir', backupDir]));
    const copy = new DatabaseSync(path.join(backupDir, 'api.sqlite'), { readOnly: true });
    try {
      expect(tables.map(table => copy.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(before);
      expect(copy.prepare('SELECT user_id,username,created_at,platform_admin FROM users ORDER BY user_id').all()).toEqual(identities);
    } finally { copy.close(); }
    for (const suffix of ['-wal', '-shm', '-journal']) expect(fs.existsSync(path.join(backupDir, `api.sqlite${suffix}`))).toBe(false);
    success(cli('restore.mjs', ['--backup-dir', backupDir, '--data-dir', restored]));
    const recovered = await launch(restored), fresh = await authenticated(recovered.base, recovered.code);
    try {
      expect(fresh.userId).not.toBe(admin.userId);
      const restoredDb = new DatabaseSync(path.join(restored, 'api.sqlite'), { readOnly: true });
      try {
        expect(tables.map(table => restoredDb.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(before);
        expect(restoredDb.prepare('SELECT user_id,username,created_at,platform_admin FROM users WHERE user_id=?').get(admin.userId)).toEqual(identities.find(row => row.user_id === admin.userId));
      } finally { restoredDb.close(); }
      expect((await fresh.request('GET', '/api/projects')).body.items).toEqual((await admin.request('GET', '/api/projects')).body.items);
      expect((await fresh.request('GET', `/api/projects/${projectId}/tasks`)).body).toEqual((await admin.request('GET', `/api/projects/${projectId}/tasks`)).body);
      expect((await fresh.request('GET', `/api/annotation-revisions/${revision.annotation_revision_id}`)).body).toEqual(revision);
      expect((await fresh.request('POST', `/api/projects/${projectId}/dataset-versions`, { operation_id: crypto.randomUUID(), ontology_version_id: ontologyId, items: [{ asset_revision_id: assetId, annotation_revision_id: revision.annotation_revision_id, split: 'train' }], excluded: [], split_seed: null, split_ratios: null })).status).toBe(201);
    } finally { await stop(recovered.child); }
  } finally { db.close(); await stop(running.child); }
}, 60000);
it('refuses a public user username credential without rewriting identity and restores its original historical identity after removing only the colliding configuration', async () => {
  const data = path.join(scratch, 'public username scalar'), running = await launch(data), admin = await authenticated(running.base, running.code);
  const secret = 'owned-username-key', username = `historical-${secret}`;
  const created = await admin.request('POST', '/api/users', { username, password: 'T33-user-synthetic-password' });
  expect(created.status).toBe(201);
  const db = new DatabaseSync(path.join(data, 'api.sqlite'));
  try {
    const before = db.prepare('SELECT user_id,username,created_at,platform_admin FROM users ORDER BY user_id').all();
    expect(before.find(row => row.username === username)?.user_id).toBe(created.body.user_id);
    db.prepare("INSERT INTO model_profiles VALUES('username-profile','openai_api','synthetic-not-live','api_key','{}','needs_configuration','not_run',NULL,NULL,?,NULL,?)").run(JSON.stringify({ api_key: secret }), new Date().toISOString());
    const sourceFiles = ['api.sqlite', 'api.sqlite-wal'].filter(file => fs.existsSync(path.join(data, file)));
    const hashes = sourceFiles.map(file => sha(path.join(data, file)));
    const destination = path.join(scratch, 'username refused');
    const result = cli('backup.mjs', ['--data-dir', data, '--backup-dir', destination]);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('credential_in_immutable_business_data');
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(fs.existsSync(destination)).toBe(false);
    expect(sourceFiles.map(file => sha(path.join(data, file)))).toEqual(hashes);
    expect(db.prepare('SELECT user_id,username,created_at,platform_admin FROM users ORDER BY user_id').all()).toEqual(before);
    db.prepare("UPDATE model_profiles SET config_json=? WHERE profile_id='username-profile'").run(JSON.stringify({ api_key: 'unrelated-username-config-key' }));
    const backupDir = path.join(scratch, 'username backup'), restored = path.join(scratch, 'username restored');
    success(cli('backup.mjs', ['--data-dir', data, '--backup-dir', backupDir]));
    const copy = new DatabaseSync(path.join(backupDir, 'api.sqlite'), { readOnly: true });
    try { expect(copy.prepare('SELECT user_id,username,created_at,platform_admin FROM users ORDER BY user_id').all()).toEqual(before); } finally { copy.close(); }
    success(cli('restore.mjs', ['--backup-dir', backupDir, '--data-dir', restored]));
    const recovered = await launch(restored), fresh = await authenticated(recovered.base, recovered.code);
    try {
      expect(fresh.userId).not.toBe(admin.userId);
      expect((await fresh.request('GET', '/api/users')).body.items).toContainEqual(expect.objectContaining({ user_id: created.body.user_id, username }));
      const restoredDb = new DatabaseSync(path.join(restored, 'api.sqlite'), { readOnly: true });
      try { expect(restoredDb.prepare('SELECT user_id,username,created_at,platform_admin FROM users WHERE user_id=?').get(created.body.user_id)).toEqual(before.find(row => row.user_id === created.body.user_id)); } finally { restoredDb.close(); }
    } finally { await stop(recovered.child); }
  } finally { db.close(); await stop(running.child); }
}, 60000);
it('fails closed on immutable approval bindings and audit reasons before any snapshot exists, leaving source approval usable', async () => {
  const data = path.join(scratch, 'approved without snapshot');
  const { running, admin, projectId, ontologyId, assetId, revision } = await approvedReview(data);
  const db = new DatabaseSync(path.join(data, 'api.sqlite'));
  const before = {
    submissions: db.prepare('SELECT * FROM review_submissions ORDER BY review_id').all(),
    decisions: db.prepare('SELECT * FROM review_decisions ORDER BY review_id').all(),
    revisions: db.prepare('SELECT * FROM annotation_revisions ORDER BY annotation_revision_id').all(),
  };
  expect(db.prepare('SELECT COUNT(*) AS n FROM dataset_versions').get()!.n).toBe(0);
  db.prepare("INSERT INTO model_profiles VALUES(?, 'openai_api', 'synthetic-not-live', 'api_key', '{}', 'needs_configuration', 'not_run', NULL, NULL, '{}', NULL, ?)").run('review-collision', new Date().toISOString());
  try {
    for (const [label, secret] of [['revision-binding', revision.annotation_revision_id], ['audit-reason', 'original auditor']]) {
      db.prepare('UPDATE model_profiles SET config_json=? WHERE profile_id=?').run(JSON.stringify({ api_key: secret }), 'review-collision');
      const destination = path.join(scratch, label);
      const result = cli('backup.mjs', ['--data-dir', data, '--backup-dir', destination]);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain('credential_in_immutable_business_data');
      expect(result.stdout + result.stderr).not.toContain(secret);
      expect(fs.existsSync(destination)).toBe(false);
      expect({
        submissions: db.prepare('SELECT * FROM review_submissions ORDER BY review_id').all(),
        decisions: db.prepare('SELECT * FROM review_decisions ORDER BY review_id').all(),
        revisions: db.prepare('SELECT * FROM annotation_revisions ORDER BY annotation_revision_id').all(),
      }).toEqual(before);
      expect((await admin.request('GET', `/api/annotation-revisions/${revision.annotation_revision_id}`)).body).toEqual(revision);
    }
    db.prepare('UPDATE model_profiles SET config_json=? WHERE profile_id=?').run(JSON.stringify({ api_key: 'unrelated-configuration-secret' }), 'review-collision');
    const backupDir = path.join(scratch, 'preserved approval'), restored = path.join(scratch, 'restored approval');
    success(cli('backup.mjs', ['--data-dir', data, '--backup-dir', backupDir]));
    const copy = new DatabaseSync(path.join(backupDir, 'api.sqlite'), { readOnly: true });
    try {
      expect(copy.prepare('SELECT * FROM review_submissions ORDER BY review_id').all()).toEqual(before.submissions);
      expect(copy.prepare('SELECT * FROM review_decisions ORDER BY review_id').all()).toEqual(before.decisions);
      expect(copy.prepare('SELECT * FROM annotation_revisions ORDER BY annotation_revision_id').all()).toEqual(before.revisions);
    } finally { copy.close(); }
    const snapshot = await admin.request('POST', `/api/projects/${projectId}/dataset-versions`, { operation_id: crypto.randomUUID(), ontology_version_id: ontologyId, items: [{ asset_revision_id: assetId, annotation_revision_id: revision.annotation_revision_id, split: 'train' }], excluded: [], split_seed: null, split_ratios: null });
    expect(snapshot.status, JSON.stringify(snapshot.body)).toBe(201);
    success(cli('restore.mjs', ['--backup-dir', backupDir, '--data-dir', restored]));
    const recovered = await launch(restored); const fresh = await authenticated(recovered.base, recovered.code);
    try {
      expect((await fresh.request('GET', `/api/annotation-revisions/${revision.annotation_revision_id}`)).body).toEqual(revision);
      const recoveredSnapshot = await fresh.request('POST', `/api/projects/${projectId}/dataset-versions`, { operation_id: crypto.randomUUID(), ontology_version_id: ontologyId, items: [{ asset_revision_id: assetId, annotation_revision_id: revision.annotation_revision_id, split: 'train' }], excluded: [], split_seed: null, split_ratios: null });
      expect(recoveredSnapshot.status, JSON.stringify(recoveredSnapshot.body)).toBe(201);
    } finally { await stop(recovered.child); }
  } finally { db.close(); await stop(running.child); }
}, 60000);
it('refuses an authenticated scalar issue-code credential collision before snapshots and restores unchanged history after removing only the credential configuration', async () => {
  const data = path.join(scratch, 'API issue scalar collision');
  const { running, admin, projectId, ontologyId, assetId, revision, reviewId } = await approvedReview(data);
  const secret = 'owned-synthetic-api-key-scalar';
  const issue = await admin.request('POST', `/api/reviews/${reviewId}/issues`, { annotation_revision_id: revision.annotation_revision_id, object_id: null, code: secret, message: 'ordinary review observation', region: null });
  expect(issue.status).toBe(200);
  const db = new DatabaseSync(path.join(data, 'api.sqlite'));
  const tables = ['review_issues', 'review_submissions', 'review_decisions', 'annotation_revisions', 'media_revisions', 'media_metadata'];
  try {
    expect(db.prepare('SELECT COUNT(*) AS n FROM dataset_versions').get()!.n).toBe(0);
    db.prepare("INSERT INTO model_profiles VALUES('scalar-profile','openai_api','synthetic-not-live','api_key','{}','needs_configuration','not_run',NULL,NULL,?,NULL,?)").run(JSON.stringify({ api_key: secret }), new Date().toISOString());
    const before = tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const sourceFiles = ['api.sqlite', 'api.sqlite-wal'].filter(file => fs.existsSync(path.join(data, file)));
    const sourceHashes = sourceFiles.map(file => sha(path.join(data, file)));
    const destination = path.join(scratch, 'refused issue-code backup');
    const result = cli('backup.mjs', ['--data-dir', data, '--backup-dir', destination]);
    // On RED, a successful backup actually contains the credential in the API-created issue.
    const leaked = result.status === 0 ? new DatabaseSync(path.join(destination, 'api.sqlite'), { readOnly: true }) : undefined;
    const leakDiagnostic = leaked?.prepare('SELECT code FROM review_issues WHERE issue_id=?').get(issue.body.issue_id)?.code === secret;
    leaked?.close();
    expect(result.status, `API issue accepted; backup credential leak=${leakDiagnostic}; ${result.stdout}${result.stderr}`).toBe(1);
    expect(result.stderr).toContain('credential_in_immutable_business_data');
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(fs.existsSync(destination)).toBe(false);
    expect(tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(before);
    expect(sourceFiles.map(file => sha(path.join(data, file)))).toEqual(sourceHashes);
    expect((await admin.request('GET', `/api/reviews/${reviewId}/issues`)).body.items).toEqual([issue.body]);
    expect((await admin.request('GET', `/api/annotation-revisions/${revision.annotation_revision_id}`)).body).toEqual(revision);
    db.prepare("UPDATE model_profiles SET config_json=? WHERE profile_id='scalar-profile'").run(JSON.stringify({ api_key: 'unrelated-config-credential' }));
    const backupDir = path.join(scratch, 'issue-history backup'), restored = path.join(scratch, 'issue-history restored');
    success(cli('backup.mjs', ['--data-dir', data, '--backup-dir', backupDir]));
    const snapshotPayload = { operation_id: crypto.randomUUID(), ontology_version_id: ontologyId, items: [{ asset_revision_id: assetId, annotation_revision_id: revision.annotation_revision_id, split: 'train' }], excluded: [], split_seed: null, split_ratios: null };
    expect((await admin.request('POST', `/api/projects/${projectId}/dataset-versions`, snapshotPayload)).status).toBe(201);
    success(cli('restore.mjs', ['--backup-dir', backupDir, '--data-dir', restored]));
    const recovered = await launch(restored); const fresh = await authenticated(recovered.base, recovered.code);
    try {
      expect(fresh.userId).not.toBe(admin.userId);
      const recoveredDb = new DatabaseSync(path.join(restored, 'api.sqlite'), { readOnly: true });
      try { expect(tables.map(table => recoveredDb.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(before); } finally { recoveredDb.close(); }
      expect((await fresh.request('GET', `/api/reviews/${reviewId}/issues`)).body.items).toEqual([issue.body]);
      expect((await fresh.request('GET', `/api/annotation-revisions/${revision.annotation_revision_id}`)).body).toEqual(revision);
      expect((await fresh.request('POST', `/api/projects/${projectId}/dataset-versions`, { ...snapshotPayload, operation_id: crypto.randomUUID() })).status).toBe(201);
    } finally { await stop(recovered.child); }
  } finally { db.close(); await stop(running.child); }
}, 60000);
it('refuses a credential in immutable media original_name even when mutable ingest diagnostics can be scrubbed', async () => {
  const data = path.join(scratch, 'media scalar boundary');
  const secret = 'owned-synthetic-media-name';
  const { running, admin, projectId, ontologyId, assetId, revision } = await approvedReview(data, `${secret}.jpg`);
  const db = new DatabaseSync(path.join(data, 'api.sqlite'));
  try {
    expect(db.prepare('SELECT COUNT(*) AS n FROM dataset_versions').get()!.n).toBe(0);
    db.prepare("INSERT INTO model_profiles VALUES('media-profile','openai_api','synthetic-not-live','api_key','{}','needs_configuration','not_run',NULL,NULL,?,NULL,?)").run(JSON.stringify({ api_key: secret }), new Date().toISOString());
    const tables = ['media_revisions', 'media_metadata', 'media_object_refs', 'annotation_revisions', 'review_decisions'];
    const before = tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const sourceFiles = ['api.sqlite', 'api.sqlite-wal'].filter(file => fs.existsSync(path.join(data, file)));
    const sourceHashes = sourceFiles.map(file => sha(path.join(data, file)));
    const destination = path.join(scratch, 'refused media-name backup');
    const result = cli('backup.mjs', ['--data-dir', data, '--backup-dir', destination]);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('credential_in_immutable_business_data');
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(fs.existsSync(destination)).toBe(false);
    expect(tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(before);
    expect(sourceFiles.map(file => sha(path.join(data, file)))).toEqual(sourceHashes);
    expect((await admin.request('GET', `/api/annotation-revisions/${revision.annotation_revision_id}`)).body).toEqual(revision);
    const snapshot = await admin.request('POST', `/api/projects/${projectId}/dataset-versions`, { operation_id: crypto.randomUUID(), ontology_version_id: ontologyId, items: [{ asset_revision_id: assetId, annotation_revision_id: revision.annotation_revision_id, split: 'train' }], excluded: [], split_seed: null, split_ratios: null });
    expect(snapshot.status).toBe(201);
  } finally { db.close(); await stop(running.child); }
}, 60000);
it('refuses credential collisions in immutable review, prediction, event and export audit fields without rewriting source history', async () => {
  const data = path.join(scratch, 'immutable audit matrix');
  const { running, admin, projectId, ontologyId, asset, assetId, revision, reviewId } = await approvedReview(data);
  const snapshot = await admin.request('POST', `/api/projects/${projectId}/dataset-versions`, { operation_id: crypto.randomUUID(), ontology_version_id: ontologyId, items: [{ asset_revision_id: assetId, annotation_revision_id: revision.annotation_revision_id, split: 'train' }], excluded: [], split_seed: null, split_ratios: null });
  expect(snapshot.status).toBe(201);
  const db = new DatabaseSync(path.join(data, 'api.sqlite')), now = new Date().toISOString();
  try {
    db.prepare("INSERT INTO model_profiles VALUES('audit-profile','openai_api','synthetic-not-live','api_key','{}','needs_configuration','not_run',NULL,NULL,'{}',NULL,?)").run(now);
    db.prepare("INSERT INTO jobs(job_id,project_id,kind,state,payload_json,created_at,updated_at) VALUES('audit-job',?,'model','succeeded','{}',?,?)").run(projectId, now, now);
    db.prepare("INSERT INTO model_runs(run_id,operation_id,project_id,asset_revision_id,annotation_revision_id,ontology_version_id,actor_id,job_id,profile_id,profile_snapshot_json,provider_id,source,intent,prompt,context_json,input_fingerprint,request_hash,state,cost_display,created_at) VALUES('audit-run','audit-operation',?,?,?,?,?,'audit-job','audit-profile','{}','openai_api','manual','find_issues','pinned-prompt-collision',?,'audit-fingerprint',?,'succeeded','none',?)").run(projectId, assetId, revision.annotation_revision_id, ontologyId, admin.userId, JSON.stringify({ actor_id: 'pinned-context-actor-collision' }), '1'.repeat(64), now);
    db.prepare("INSERT INTO review_issues(issue_id,review_id,project_id,annotation_revision_id,ontology_version_id,code,message,created_by,created_at) VALUES('audit-issue',?,?,?,?,'review','review-issue-message-collision',?,?)").run(reviewId, projectId, revision.annotation_revision_id, ontologyId, admin.userId, now);
    // Schema-valid historical JSON with distinct IDs isolates both guards; one cannot mask the other.
    const taskId = db.prepare('SELECT task_id FROM review_submissions WHERE review_id=?').get(reviewId)!.task_id;
    db.prepare("INSERT INTO review_submissions VALUES('audit-review',?,?,?,?,'approved',?)").run(taskId, projectId, admin.userId, JSON.stringify([revision.annotation_revision_id, 'submission-only-revision-collision']), now);
    db.prepare("INSERT INTO review_decisions VALUES('audit-review',?,'approve','independent JSON guard',?,?)").run(admin.userId, JSON.stringify([revision.annotation_revision_id, 'decision-only-revision-collision']), now);
    const raw = JSON.stringify({ actor_id: admin.userId });
    db.prepare("INSERT INTO predictions(prediction_id,run_id,project_id,asset_revision_id,source,raw_output_json,raw_output_bytes,created_at) VALUES('audit-prediction','audit-run',?,?,'manual',?,?,?)").run(projectId, assetId, raw, Buffer.byteLength(raw), now);
    const escapedKeySecret = 'owned-audit-key-雪"', escapedValueSecret = 'owned-audit-value-雪"';
    const quarantined = JSON.stringify({ revision_id: 'quarantined-revision-collision', [escapedKeySecret]: { observation: escapedValueSecret } }, null, 2).replaceAll('雪', '\\u96ea');
    db.prepare("INSERT INTO prediction_audit(audit_id,run_id,project_id,asset_revision_id,source,raw_output_json,raw_output_bytes,reason,created_at) VALUES('audit-quarantine','audit-run',?,?,'manual',?,?,'quarantine-reason-collision',?)").run(projectId, assetId, quarantined, Buffer.byteLength(quarantined), now);
    db.prepare("INSERT INTO suggestion_sets(suggestion_set_id,run_id,prediction_id,project_id,asset_revision_id,changes_json,issues_json,created_at) VALUES('audit-suggestions','audit-run','audit-prediction',?,?,?,'[]',?)").run(projectId, assetId, JSON.stringify([{ change_id: 'suggestion-change-collision' }]), now);
    db.prepare("INSERT INTO run_events(run_id,seq,event_type,message,data_json,created_at) VALUES('audit-run',0,'succeeded','event-message-collision',?,?)").run(JSON.stringify({ actor_id: 'event-actor-collision' }), now);
    db.prepare("INSERT INTO annotation_exports VALUES('audit-annotation-export',?,?,?,'native',?,0,?,?)").run(projectId, revision.annotation_revision_id, admin.userId, asset.canonical_sha256, JSON.stringify({ reason: 'annotation-loss-report-collision' }), now);
    db.prepare("INSERT INTO dataset_exports VALUES('audit-job',?,?,?,?, 'native',?,0,?,?)").run(projectId, snapshot.body.dataset_version_id, snapshot.body.manifest_sha256, admin.userId, asset.canonical_sha256, JSON.stringify({ reason: 'dataset-loss-report-collision' }), now);
    const tables = ['model_runs', 'review_submissions', 'review_decisions', 'review_issues', 'predictions', 'prediction_audit', 'suggestion_sets', 'run_events', 'annotation_exports', 'dataset_exports'];
    const before = tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    for (const [field, secret] of [
      ['review_submissions.revision_ids_json', 'submission-only-revision-collision'],
      ['review_decisions.revision_ids_json', 'decision-only-revision-collision'],
      ['review_issues.message', 'review-issue-message-collision'],
      ['predictions.raw_output_json.actor_id', admin.userId],
      ['prediction_audit.raw_output_json.revision_id', 'quarantined-revision-collision'],
      ['prediction_audit.raw_output_json.decoded-key', escapedKeySecret],
      ['prediction_audit.raw_output_json.decoded-value', escapedValueSecret],
      ['prediction_audit.reason', 'quarantine-reason-collision'],
      ['suggestion_sets.changes_json.change_id', 'suggestion-change-collision'],
      ['run_events.data_json.actor_id', 'event-actor-collision'],
      ['run_events.message', 'event-message-collision'],
      ['annotation_exports.loss_report_json', 'annotation-loss-report-collision'],
      ['dataset_exports.loss_report_json', 'dataset-loss-report-collision'],
      ['model_runs.context_json.actor_id', 'pinned-context-actor-collision'],
      ['model_runs.prompt', 'pinned-prompt-collision'],
      ['model_runs.input_fingerprint', 'audit-fingerprint'],
    ]) {
      db.prepare("UPDATE model_profiles SET config_json=? WHERE profile_id='audit-profile'").run(JSON.stringify({ api_key: secret }));
      const destination = path.join(scratch, field);
      const result = cli('backup.mjs', ['--data-dir', data, '--backup-dir', destination]);
      expect(result.status, field + ': ' + result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain('credential_in_immutable_business_data');
      expect(result.stdout + result.stderr).not.toContain(secret);
      expect(fs.existsSync(destination)).toBe(false);
      expect(tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(before);
    }
    db.prepare("UPDATE model_profiles SET config_json=? WHERE profile_id='audit-profile'").run(JSON.stringify({ api_key: 'unrelated-audit-configuration-key' }));
    const preserved = path.join(scratch, 'audit exact bytes');
    success(cli('backup.mjs', ['--data-dir', data, '--backup-dir', preserved]));
    const copy = new DatabaseSync(path.join(preserved, 'api.sqlite'), { readOnly: true });
    try { expect(tables.map(table => copy.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(before); } finally { copy.close(); }
  } finally { db.close(); await stop(running.child); }
}, 60000);
it('fails closed on decoded keys and raw-only credential encodings in mutable progress JSON but scrubs diagnostic values consumed by the real job API without changing source bytes', async () => {
  const data = path.join(scratch, 'mutable progress JSON'), running = await launch(data), admin = await authenticated(running.base, running.code);
  const project = await admin.request('POST', '/api/projects', { name: 'progress diagnostics', description: 'ordinary', allow_self_review: false }); expect(project.status).toBe(201);
  const db = new DatabaseSync(path.join(data, 'api.sqlite')), now = new Date().toISOString();
  const keySecret = 'owned-progress-key-雪"', valueSecret = 'owned-progress-value-雪"';
  try {
    // JobQueue accepts arbitrary JSON progress. This private persisted fixture
    // exercises its real public status consumer, not a fake Tool/provider run.
    db.prepare("INSERT INTO jobs(job_id,project_id,kind,state,payload_json,progress_json,created_at,updated_at) VALUES('progress-fixture',?,'media_import','succeeded','{}',?,?,?)").run(project.body.project_id, JSON.stringify({ succeeded: 1, failed: 0, detail: { [keySecret]: valueSecret } }, null, 2).replaceAll('雪', '\\u96ea'), now, now);
    db.prepare("INSERT INTO model_profiles VALUES('progress-profile','openai_api','synthetic-not-live','api_key','{}','needs_configuration','not_run',NULL,NULL,?,NULL,?)").run(JSON.stringify({ api_key: keySecret }), now);
    const original = db.prepare("SELECT * FROM jobs WHERE job_id='progress-fixture'").get();
    const publicBefore = await admin.request('GET', '/api/jobs/progress-fixture');
    expect(publicBefore.status).toBe(200); expect(publicBefore.body.progress.detail).toEqual({ [keySecret]: valueSecret });
    const sourceFiles = ['api.sqlite', 'api.sqlite-wal'].filter(file => fs.existsSync(path.join(data, file))), hashes = sourceFiles.map(file => sha(path.join(data, file)));
    const refused = path.join(scratch, 'mutable key refused');
    const result = cli('backup.mjs', ['--data-dir', data, '--backup-dir', refused]);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('credential_in_immutable_business_data');
    expect(result.stdout + result.stderr).not.toContain(keySecret);
    expect(fs.existsSync(refused)).toBe(false);
    expect(db.prepare("SELECT * FROM jobs WHERE job_id='progress-fixture'").get()).toEqual(original);
    expect(sourceFiles.map(file => sha(path.join(data, file)))).toEqual(hashes);
    // The known key may be the literal six-character JSON escape, not its
    // decoded Unicode character. Canonical JSON equality must not hide raw bytes.
    const rawSecret = '\\u96ea';
    db.prepare("UPDATE model_profiles SET config_json=? WHERE profile_id='progress-profile'").run(JSON.stringify({ api_key: rawSecret }));
    const rawRefused = path.join(scratch, 'mutable raw encoding refused');
    const rawResult = cli('backup.mjs', ['--data-dir', data, '--backup-dir', rawRefused]);
    expect(rawResult.status, rawResult.stdout + rawResult.stderr).toBe(1);
    expect(rawResult.stderr).toContain('credential_in_immutable_business_data');
    expect(rawResult.stdout + rawResult.stderr).not.toContain(rawSecret);
    expect(fs.existsSync(rawRefused)).toBe(false);
    expect(db.prepare("SELECT * FROM jobs WHERE job_id='progress-fixture'").get()).toEqual(original);
    db.prepare("UPDATE model_profiles SET config_json=? WHERE profile_id='progress-profile'").run(JSON.stringify({ api_key: valueSecret }));
    const backupDir = path.join(scratch, 'mutable value backup'), restored = path.join(scratch, 'mutable value restored');
    success(cli('backup.mjs', ['--data-dir', data, '--backup-dir', backupDir]));
    expect(fs.readFileSync(path.join(backupDir, 'api.sqlite')).includes(Buffer.from(valueSecret))).toBe(false);
    expect(db.prepare("SELECT * FROM jobs WHERE job_id='progress-fixture'").get()).toEqual(original);
    success(cli('restore.mjs', ['--backup-dir', backupDir, '--data-dir', restored]));
    const recovered = await launch(restored), fresh = await authenticated(recovered.base, recovered.code);
    try {
      const status = await fresh.request('GET', '/api/jobs/progress-fixture');
      expect(status.status).toBe(200);
      expect(status.body.progress).toEqual({ succeeded: 1, failed: 0, detail: { [keySecret]: '[REDACTED]' } });
      expect((await admin.request('GET', '/api/jobs/progress-fixture')).body).toEqual(publicBefore.body);
    } finally { await stop(recovered.child); }
  } finally { db.close(); await stop(running.child); }
}, 60000);
it('backs up live WAL consistently, scrubs authentication/configuration, refuses corrupt/schema/existing targets and restores revision, media and snapshot through fresh local auth', async () => {
  const data = path.join(scratch, '业务 data'), backupDir = path.join(scratch, '备份 & snapshot'), restored = path.join(scratch, '恢复 fresh');
  const { running, admin, projectId, ontologyId, asset, assetId, revision } = await approvedReview(data);
  const snapshot = await admin.request('POST', `/api/projects/${projectId}/dataset-versions`, { operation_id: crypto.randomUUID(), ontology_version_id: ontologyId, items: [{ asset_revision_id: assetId, annotation_revision_id: revision.annotation_revision_id, split: 'train' }], excluded: [], split_seed: null, split_ratios: null }); expect(snapshot.status).toBe(201);
  const sourceDb = new DatabaseSync(path.join(data, 'api.sqlite'));
  sourceDb.prepare("INSERT INTO model_profiles VALUES(?, 'openai_api', 'synthetic-not-live', 'api_key', ?, 'needs_configuration', 'not_run', NULL, NULL, ?, ?, ?)").run('t33-profile', JSON.stringify({ image_input: true, tools: true, structured_output: true, bbox_output: false, attributes: true }), JSON.stringify({ api_key: 'T33-secret-config-value', endpoint: 'http://invalid.example' }), 'T33-secret-ref', new Date().toISOString());
  const originalPassword = sourceDb.prepare('SELECT password_hash FROM users WHERE user_id=?').get(admin.userId)!.password_hash as string;
  const originalSessions = sourceDb.prepare('SELECT session_id,csrf_hash FROM sessions').all().flatMap(row => [row.session_id as string, row.csrf_hash as string]);
  const originalJournalMode = sourceDb.prepare('PRAGMA journal_mode').get()!.journal_mode;
  sourceDb.close();
  success(cli('backup.mjs', ['--data-dir', data, '--backup-dir', backupDir]));
  const bytes = fs.readFileSync(path.join(backupDir, 'api.sqlite'));
  for (const secret of [originalPassword, ...originalSessions, 'T33-secret-config-value', 'T33-secret-ref']) expect(bytes.includes(Buffer.from(secret))).toBe(false);
  expect((await admin.request('GET', '/api/session')).status).toBe(200);
  const backupDb = new DatabaseSync(path.join(backupDir, 'api.sqlite'), { readOnly: true });
  expect(backupDb.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n).toBe(0);
  expect(backupDb.prepare('SELECT created_by FROM annotation_revisions WHERE annotation_revision_id=?').get(revision.annotation_revision_id)!.created_by).toBe(admin.userId);
  expect(backupDb.prepare('SELECT manifest_sha256 FROM dataset_versions').get()!.manifest_sha256).toBe(snapshot.body.manifest_sha256); backupDb.close();
  expect(sha(path.join(backupDir, 'api.sqlite'))).toBe(JSON.parse(fs.readFileSync(path.join(backupDir, 'backup.json'), 'utf8')).files.find((entry: Value) => entry.path === 'api.sqlite').sha256);
  for (const suffix of ['-wal', '-shm', '-journal']) expect(fs.existsSync(path.join(backupDir, `api.sqlite${suffix}`))).toBe(false);
  const collisionDb = new DatabaseSync(path.join(data, 'api.sqlite'));
  expect(collisionDb.prepare('PRAGMA journal_mode').get()!.journal_mode).toBe(originalJournalMode);
  collisionDb.prepare('UPDATE model_profiles SET config_json=? WHERE profile_id=?').run(JSON.stringify({ api_key: 't33-object' }), 't33-profile'); collisionDb.close();
  const collisionTarget = path.join(scratch, 'no-immutable-corruption');
  expect(cli('backup.mjs', ['--data-dir', data, '--backup-dir', collisionTarget]).stderr).toMatch(/credential_in_immutable_business_data/);
  expect(fs.existsSync(collisionTarget)).toBe(false);
  expect((await admin.request('GET', `/api/annotation-revisions/${revision.annotation_revision_id}`)).body).toEqual(revision);
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
  const profiles = await fresh.request('GET', '/api/model-profiles');
  expect(profiles.status).toBe(200);
  expect(profiles.body.items).toEqual([expect.objectContaining({ profile_id: 't33-profile', availability: 'needs_configuration', verification: 'not_run' })]);
  expect(JSON.stringify(profiles.body)).not.toMatch(/T33-secret-config-value|T33-secret-ref/);
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
