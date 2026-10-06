import { randomUUID, createHash } from 'node:crypto';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inflateRawSync } from 'node:zlib';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { authorize, type Seeded } from '../support/t25-ai';
import { startSecurityApp, raw, session, text, object, type SecurityApp, type Login } from '../fixtures/security/harness';
import { hostileZip, highRatioZip, imageBomb } from '../fixtures/security/attacks';
import { seedSecurity, startSecurityRun as startRunBody, syntheticProfileId } from '../fixtures/security/seed';

let app: SecurityApp;
let admin: Login;
let seeded: Seeded;
let runId: string;
let validToken: string;
beforeAll(async () => {
  app = await startSecurityApp(); admin = app.admin;
  seeded = await seedSecurity(admin.client, app);
  const request = await authorize(admin.client, startRunBody(seeded, randomUUID(), 'T29 isolated scope'));
  const started = await admin.client.request('POST', '/api/ai/runs', request);
  expect(started.status).toBe(202); runId = text(started.json, 'run_id');
  validToken = await app.issue(runId, seeded.projectId);
}, 120_000);
afterAll(async () => { if (app) await app.stop(); });

it.each([
  ['Origin', { origin: 'https://evil.invalid' }, 'ORIGIN_NOT_ALLOWED'],
  ['Host', { host: 'evil.invalid' }, 'HOST_NOT_ALLOWED'],
] as const)('actualRouter rejects evil %s on authenticated API requests', async (_name, headers, code) => {
  const denied = await raw(app.base_url, 'GET', '/api/session', undefined, { cookie: admin.cookie, ...headers });
  expect(denied.status).toBe(403); expect(denied.json.code).toBe(code);
});
it.each([
  ['Origin', { origin: 'https://evil.invalid' }, 'ORIGIN_NOT_ALLOWED'],
  ['Host', { host: 'evil.invalid' }, 'HOST_NOT_ALLOWED'],
] as const)('actualRouter rejects evil %s on run-token tools', async (_name, headers, code) => {
  const accepted = await raw(app.base_url, 'POST', '/internal/agent-tools/get_context', {}, { authorization: `Bearer ${validToken}` });
  expect(accepted.status).toBe(200); expect(accepted.json.project_id).toBe(seeded.projectId);
  const denied = await raw(app.base_url, 'POST', '/internal/agent-tools/get_context', {}, { authorization: `Bearer ${validToken}`, ...headers });
  expect(denied.status).toBe(403); expect(denied.json.code).toBe(code);
});
it('bearer tools ignore browser session cookies and CSRF, but a cookie cannot replace a capability', async () => {
  const request = { method: 'POST', body: '{}', headers: { cookie: admin.cookie, 'content-type': 'application/json' } };
  // Backend tool calls may have no Origin; an incidental browser cookie must
  // neither force session-CSRF authorization nor become tool authority.
  const accepted = await fetch(new URL('/internal/agent-tools/get_context', app.base_url), { ...request, headers: { ...request.headers, authorization: `Bearer ${validToken}` } });
  expect(accepted.status).toBe(200); expect((await accepted.json()).project_id).toBe(seeded.projectId);
  const denied = await fetch(new URL('/internal/agent-tools/get_context', app.base_url), request);
  expect(denied.status).toBe(401); expect((await denied.json()).code).toBe('RUN_TOKEN_REQUIRED');
});
it('actualRouter preserves active-session CSRF and Origin on login and writes', async () => {
  const credentials = { username: 'local-admin', password: 'T29-synthetic-admin-password' };
  for (const path of ['/api/session/login', '/api/projects']) {
    const denied = await raw(app.base_url, 'POST', path, path.endsWith('login') ? credentials : { name: 'unauthorized write' }, { cookie: admin.cookie });
    expect(denied.status).toBe(403); expect(denied.json.code).toBe('CSRF_REQUIRED');
  }
  const wrongCsrf = await raw(app.base_url, 'POST', '/api/session/login', credentials, { cookie: admin.cookie, 'x-csrf-token': 'wrong' });
  expect(wrongCsrf.status).toBe(403); expect(wrongCsrf.json.code).toBe('CSRF_INVALID');
  const missingOrigin = await fetch(new URL('/api/session/login', app.base_url), { method: 'POST', headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': 'application/json' }, body: JSON.stringify(credentials) });
  expect(missingOrigin.status).toBe(403); expect((await missingOrigin.json()).code).toBe('ORIGIN_REQUIRED');
  const allowed = await raw(app.base_url, 'POST', '/api/session/login', credentials, { cookie: admin.cookie, 'x-csrf-token': admin.csrf });
  expect(allowed.status).toBe(200);
});

// Before-state is user-observed ground truth, not rerun: invalid cookie GET=401
// without deletion; login with that cookie and no CSRF=403 CSRF_REQUIRED.
it('stale or expired cookies recover through GET expiry and fresh authenticated login', async () => {
  const username = `t29-recovery-${randomUUID()}`; const password = 'T29-recovery-password';
  const created = await admin.client.request('POST', '/api/users', { username, password });
  expect(created.status).toBe(201);
  const initial = await raw(app.base_url, 'POST', '/api/session/login', { username, password });
  expect(initial.status).toBe(200);
  const expired = session(app.base_url, initial);
  const token = expired.cookie.slice('weblabel_session='.length);
  const database = new DatabaseSync(join(app.directory, 'api.sqlite'));
  try { expect(database.prepare('UPDATE sessions SET expires_at=? WHERE session_id=?').run('1', createHash('sha256').update(token).digest('hex')).changes).toBe(1); }
  finally { database.close(); }
  for (const cookie of ['weblabel_session=T29-nonexistent-credential', expired.cookie]) {
    const current = await raw(app.base_url, 'GET', '/api/session', undefined, { cookie });
    expect(current.status).toBe(401); expect(current.json.code).toBe('UNAUTHENTICATED');
    expect(current.headers.get('set-cookie')).toMatch(/^weblabel_session=;.*Max-Age=0/);
    expect(current.headers.get('set-cookie')).toContain('HttpOnly');
    expect(current.headers.get('set-cookie')).toContain('SameSite=Strict');
    const wrongPassword = await raw(app.base_url, 'POST', '/api/session/login', { username, password: 'T29-deliberately-wrong-password' }, { cookie });
    expect(wrongPassword.status).toBe(401); expect(wrongPassword.json.code).toBe('INVALID_CREDENTIALS');
    for (const headers of [{ origin: 'https://evil.invalid' }, { host: 'evil.invalid' }] as Record<string, string>[]) {
      const denied = await raw(app.base_url, 'POST', '/api/session/login', { username, password }, { cookie, ...headers });
      expect(denied.status).toBe(403);
    }
    const recovered = await raw(app.base_url, 'POST', '/api/session/login', { username, password }, { cookie });
    expect(recovered.status).toBe(200);
    const fresh = session(app.base_url, recovered);
    const principal = await fresh.client.request('GET', '/api/session');
    expect(principal.status).toBe(200); expect(text(principal.json, 'user_id')).toBe(text(created.json, 'user_id'));
    const noCsrf = await raw(app.base_url, 'POST', '/api/projects', { name: 'not permitted' }, { cookie: fresh.cookie });
    expect(noCsrf.status).toBe(403); expect(noCsrf.json.code).toBe('CSRF_REQUIRED');
  }
});
it('login database failure is not treated as an absent or expired session', async () => {
  const isolated = await startSecurityApp();
  const db = new DatabaseSync(join(isolated.directory, 'api.sqlite'));
  try {
    db.exec('ALTER TABLE sessions RENAME TO t29_sessions_unavailable');
    const failed = await raw(isolated.base_url, 'POST', '/api/session/login', { username: 'local-admin', password: 'T29-synthetic-admin-password' }, { cookie: isolated.admin.cookie });
    expect(failed.status).toBe(500); expect(failed.json.code).toBe('AUTHENTICATION_FAILED');
    expect(failed.headers.get('set-cookie')).toBeNull();
  } finally { db.exec('ALTER TABLE t29_sessions_unavailable RENAME TO sessions'); db.close(); await isolated.stop(); }
});
it('run tokens cannot replace sessions, override project, expire, or survive cancellation', async () => {
  const sessionOnly = await admin.client.request('POST', '/internal/agent-tools/get_context', {});
  expect(sessionOnly.status).toBe(401); expect(object(sessionOnly.json).code).toBe('RUN_TOKEN_REQUIRED');
  const override = await raw(app.base_url, 'POST', '/internal/agent-tools/get_context', { project_id: 'other-project' }, { authorization: `Bearer ${validToken}` });
  expect(override.status).toBe(400); expect(override.json.code).toBe('IDENTITY_OVERRIDE');
  const wrongBinding = await app.issue(runId, 'other-project');
  const wrongProject = await raw(app.base_url, 'POST', '/internal/agent-tools/read_region', { region: null }, { authorization: `Bearer ${wrongBinding}` });
  expect(wrongProject.status).toBe(403); expect(wrongProject.json.code).toBe('RUN_TOKEN_PROJECT_MISMATCH');
  const expired = await app.issue(runId, seeded.projectId, 0);
  for (const tool of ['get_context', 'read_region']) {
    const denied = await raw(app.base_url, 'POST', `/internal/agent-tools/${tool}`, tool === 'read_region' ? { region: null } : {}, { authorization: `Bearer ${expired}` });
    expect(denied.status).toBe(401); expect(denied.json.code).toBe('RUN_TOKEN_EXPIRED');
  }
  const otherUser = await app.as_user('viewer');
  for (const path of [`/api/ai/runs/${runId}/events`, `/api/assets/${seeded.assetRevisionId}/annotation?ontology_version_id=${seeded.ontologyId}`]) {
    const denied = await otherUser.request('GET', path); expect(denied.status).toBe(404);
  }
  const cancelled = await admin.client.request('POST', `/api/ai/runs/${runId}/cancel`, {});
  expect(cancelled.status).toBe(200);
  const revoked = await raw(app.base_url, 'POST', '/internal/agent-tools/get_context', {}, { authorization: `Bearer ${validToken}` });
  expect(revoked.status).toBe(401); expect(revoked.json.code).toBe('RUN_TOKEN_REVOKED');
});

it.each(['content', 'provider'] as const)('F22 approval becomes invalid when approved %s changes and fresh approval is required', async mutation => {
  const isolated = await startSecurityApp();
  try {
    const pins = await seedSecurity(isolated.admin.client, isolated);
    const fixed = await authorize(isolated.admin.client, startRunBody(pins, randomUUID(), 'T29 F22 approval'));
    if (mutation === 'content') {
      const head = await isolated.admin.client.request('GET', `/api/assets/${pins.assetRevisionId}/annotation?ontology_version_id=${pins.ontologyId}`);
      const saved = await isolated.admin.client.request('PUT', `/api/assets/${pins.assetRevisionId}/annotation`, {
        operation_id: randomUUID(), base_revision_id: pins.annotationRevisionId,
        document: { ...object(object(head.json).document), completion: 'in_progress' }, lease: null, suggestion_decisions: [],
      });
      expect(saved.status).toBe(200); pins.annotationRevisionId = text(object(saved.json).revision, 'annotation_revision_id');
    } else {
      const db = new DatabaseSync(join(isolated.directory, 'api.sqlite'));
      try { expect(db.prepare("UPDATE model_profiles SET model_id='T29-synthetic-changed-provider-model' WHERE profile_id=?").run(syntheticProfileId).changes).toBe(1); }
      finally { db.close(); }
    }
    const denied = await isolated.admin.client.request('POST', '/api/ai/runs', fixed);
    expect(denied.status).toBe(403); expect(object(denied.json).code).toBe('PREVIEW_INPUT_CHANGED');
    const db = new DatabaseSync(join(isolated.directory, 'api.sqlite'));
    try { expect(db.prepare('SELECT COUNT(*) AS count FROM model_runs').get()).toEqual({ count: 0 }); }
    finally { db.close(); }
    const fresh = await authorize(isolated.admin.client, startRunBody(pins, randomUUID(), 'T29 F22 fresh approval'));
    const queued = await isolated.admin.client.request('POST', '/api/ai/runs', fresh);
    expect(queued.status).toBe(202);
    expect((await isolated.admin.client.request('POST', `/api/ai/runs/${text(queued.json, 'run_id')}/cancel`, {})).status).toBe(200);
  } finally { await isolated.stop(); }
});

const archiveAttacks = [
  ['traversal', [{ name: '../outside.secret' }]],
  ['drive-absolute', [{ name: 'C:/outside.secret' }]],
  ['drive-relative', [{ name: 'C:outside.secret' }]],
  ['UNC', [{ name: '\\\\synthetic-server\\share\\outside.secret' }]],
  ['symlink', [{ name: 'annotations/escape', contents: '../../outside.secret', symlink: true }]],
  ['casefold-collision', [{ name: 'annotations/Case.json' }, { name: 'annotations/case.json' }]],
  ['archive-bomb', null],
] as const;
it.each(archiveAttacks)('native import rejects synthetic %s atomically', async (_name, entries) => {
  const good = await app.extractArchive(hostileZip([{ name: 'safe.json', contents: '{"synthetic":true}' }]));
  expect(good).toEqual({ accepted: true, files: { 'safe.json': Array.from(Buffer.from('{"synthetic":true}')) } });
  const malicious = entries === null ? await highRatioZip() : hostileZip(entries);
  if (entries === null) {
    // Same genuine 97 MiB member succeeds with an explicit larger budget,
    // proving failure is the resource boundary, not a broken ZIP or CRC.
    expect(await app.extractArchive(malicious, 100 * 1024 * 1024)).toEqual({ accepted: true, file_sizes: { 'bomb.bin': 97 * 1024 * 1024 } });
  }
  expect(await app.extractArchive(malicious)).toEqual({ accepted: false });
  const before = await admin.client.request('GET', `/api/assets/${seeded.assetRevisionId}/annotation?ontology_version_id=${seeded.ontologyId}`);
  const form = new FormData(); form.set('format', 'native'); form.set('ontology_version_id', seeded.ontologyId);
  form.set('data', new Blob([Uint8Array.from(malicious).buffer], { type: 'application/zip' }), 'synthetic-malicious.zip');
  const response = await fetch(new URL(`/api/assets/${seeded.assetRevisionId}/annotation-import-previews`, app.base_url), { method: 'POST', headers: { origin: app.base_url, cookie: admin.cookie, 'x-csrf-token': admin.csrf }, body: form });
  expect(response.status).toBe(422); expect((await response.json()).code).toBe('IMPORT_INVALID');
  const after = await admin.client.request('GET', `/api/assets/${seeded.assetRevisionId}/annotation?ontology_version_id=${seeded.ontologyId}`);
  expect(after.status).toBe(200); expect(after.json).toEqual(before.json);
  const db = new DatabaseSync(join(app.directory, 'api.sqlite'));
  try { expect(db.prepare('SELECT COUNT(*) AS count FROM annotation_import_batches WHERE asset_revision_id=?').get(seeded.assetRevisionId)).toEqual({ count: 0 }); }
  finally { db.close(); }
  expect(await readdir(app.directory)).not.toContain('outside.secret');
});
it('actual image intake rejects a dimension bomb without creating media or revisions', async () => {
  const before = await admin.client.request('GET', `/api/projects/${seeded.projectId}/assets`);
  const queued = await admin.client.upload(`/api/projects/${seeded.projectId}/assets`, imageBomb(), 'synthetic-bomb.png', randomUUID(), 'image/png');
  expect(queued.status).toBe(202);
  const drain = await admin.client.request('POST', '/internal/test/jobs/drain', {}); expect(drain.status).toBe(200);
  const job = await admin.client.request('GET', `/api/jobs/${text(queued.json, 'import_job_id')}`);
  expect(object(job.json).state).toBe('failed');
  expect(object(object(job.json).result)).toMatchObject({ failed: 1, succeeded: 0, items: [{ state: 'failed' }] });
  const after = await admin.client.request('GET', `/api/projects/${seeded.projectId}/assets`);
  expect(after.json).toEqual(before.json);
});

/** Independent ZIP member decoder inspects actual export payload, not source text. */
function zipMembers(bytes: Buffer): Map<string, Buffer> {
  const members = new Map<string, Buffer>(); let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const flags = bytes.readUInt16LE(offset + 6); if (flags & 8) throw new Error('Unbounded descriptor not supported by test decoder');
    const compression = bytes.readUInt16LE(offset + 8); const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26); const extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString();
    const start = offset + 30 + nameLength + extraLength; const data = bytes.subarray(start, start + size);
    if (data.length !== size) throw new Error('Truncated member');
    members.set(name, compression === 0 ? data : compression === 8 ? inflateRawSync(data) : (() => { throw new Error('Unsupported compression'); })());
    offset = start + size;
  }
  if (!members.has('manifest.json')) throw new Error('Export missing manifest');
  return members;
}
it('actual approved native export excludes configured synthetic credentials and foreign files', async () => {
  const secret = `T29-synthetic-sentinel-${randomUUID()}`;
  await writeFile(join(app.directory, '.secret'), secret);
  const db = new DatabaseSync(join(app.directory, 'api.sqlite'));
  try {
    db.prepare("UPDATE model_profiles SET config_json=?,secret_ref=? WHERE profile_id=?").run(JSON.stringify({ credential: { secret_ref: 'env:T29_EXPORT_SECRET' }, private_test_secret: secret }), secret, syntheticProfileId);
    db.prepare('UPDATE projects SET allow_self_review=1 WHERE project_id=?').run(seeded.projectId);
  } finally { db.close(); }
  const head = await admin.client.request('GET', `/api/assets/${seeded.assetRevisionId}/annotation?ontology_version_id=${seeded.ontologyId}`);
  const document = { ...object(object(head.json).document), completion: 'confirmed_negative' };
  const saved = await admin.client.request('PUT', `/api/assets/${seeded.assetRevisionId}/annotation`, { operation_id: randomUUID(), base_revision_id: seeded.annotationRevisionId, document, lease: null, suggestion_decisions: [] });
  expect(saved.status).toBe(200); const revisionId = text(object(saved.json).revision, 'annotation_revision_id');
  const me = await admin.client.request('GET', '/api/session');
  const task = await admin.client.request('POST', `/api/projects/${seeded.projectId}/tasks`, { asset_revision_id: seeded.assetRevisionId, ontology_version_id: seeded.ontologyId, assignee_id: text(me.json, 'user_id') });
  expect(task.status).toBe(200); const taskId = text(task.json, 'task_id');
  expect((await admin.client.request('POST', `/api/tasks/${taskId}/lease`, { action: 'acquire' })).status).toBe(200);
  const submitted = await admin.client.request('POST', `/api/tasks/${taskId}/submit`, { annotation_revision_ids: [revisionId] }); expect(submitted.status).toBe(200);
  expect((await admin.client.request('POST', `/api/reviews/${text(submitted.json, 'review_id')}/decision`, { decision: 'approve', reason: 'T29 synthetic negative scene', revision_ids: [revisionId] })).status).toBe(200);
  const snapshot = await admin.client.request('POST', `/api/projects/${seeded.projectId}/dataset-versions`, { operation_id: randomUUID(), ontology_version_id: seeded.ontologyId, items: [{ asset_revision_id: seeded.assetRevisionId, annotation_revision_id: revisionId, split: 'train' }], excluded: [] }); expect(snapshot.status).toBe(201);
  const queued = await admin.client.request('POST', `/api/dataset-versions/${text(snapshot.json, 'dataset_version_id')}/exports`, { format: 'native', loss_ack: false, operation_id: randomUUID() }); expect(queued.status).toBe(202);
  expect((await admin.client.request('POST', '/internal/test/jobs/drain', {})).status).toBe(200);
  const job = await admin.client.request('GET', `/api/jobs/${text(queued.json, 'job_id')}`); expect(object(job.json).state).toBe('succeeded');
  const response = await fetch(new URL(text(object(job.json).result, 'download_url'), app.base_url), { headers: { origin: app.base_url, cookie: admin.cookie } }); expect(response.status).toBe(200);
  const bytes = Buffer.from(await response.arrayBuffer()); const members = zipMembers(bytes);
  expect(JSON.parse(members.get(`annotations/${seeded.assetRevisionId}.json`)!.toString())).toMatchObject({ annotation_revision_id: revisionId, document });
  expect(members.has(`media/${seeded.assetRevisionId}.png`)).toBe(true);
  for (const [name, data] of members) { expect(name).not.toContain('.secret'); expect(data.includes(Buffer.from(secret)), name).toBe(false); }
  const profiles = await admin.client.request('GET', '/api/model-profiles'); expect(JSON.stringify(profiles.json)).not.toContain(secret);
  expect(app.logs()).not.toContain(secret); expect(JSON.stringify(job.json)).not.toContain(secret);
});
