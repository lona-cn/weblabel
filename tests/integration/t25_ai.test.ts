import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap_admin_for_test, database_path_for_test, start_test_app, type ApiClient, type TestApp } from '../support/app';
import { authorize, MOCK_PROFILE, object, seed, startRunBody, type JsonObject, type Seeded } from '../support/t25-ai';

describe('isolated public profile fixture', () => {
  let app: TestApp | undefined;
  let admin: ApiClient;

  beforeEach(async () => {
    const fresh = await start_test_app();
    try {
      admin = await bootstrap_admin_for_test(fresh);
      await seed(admin, fresh);
      app = fresh;
    } catch (error) {
      await fresh.stop();
      throw error;
    }
  });
  afterEach(async () => {
    const finished = app;
    app = undefined;
    await finished?.stop();
  });

  it('returns an actual configured public profile without private credential configuration', async () => {
    if (!app) throw new Error('Public profile fixture was not prepared');
    const db = new DatabaseSync(database_path_for_test(app));
    try { db.prepare('UPDATE model_profiles SET secret_ref=?, config_json=? WHERE profile_id=?').run('test-only-secret-reference', JSON.stringify({ api_key: 'test-only-not-a-key', endpoint: 'https://example.invalid' }), MOCK_PROFILE); } finally { db.close(); }
    const response = await admin.request<{ items: JsonObject[] }>('GET', '/api/model-profiles');
    expect(response.status).toBe(200);
    expect(response.json.items).toHaveLength(1);
    const profile = response.json.items[0];
    expect(profile).toMatchObject({ profile_id: MOCK_PROFILE, provider_id: 'mock', verification: 'mock_only' });
    for (const key of ['config_json', 'config', 'secret_ref', 'api_key', 'token']) expect(profile).not.toHaveProperty(key);
    expect(JSON.stringify(response.json)).not.toContain('test-only');
  });
});

describe('isolated preview approval fixture', () => {
  let app: TestApp | undefined;
  let admin: ApiClient;
  let pins: Seeded;

  beforeEach(async () => {
    const fresh = await start_test_app();
    try {
      admin = await bootstrap_admin_for_test(fresh);
      pins = await seed(admin, fresh);
      app = fresh;
    } catch (error) {
      await fresh.stop();
      throw error;
    }
  });
  afterEach(async () => {
    const finished = app;
    app = undefined;
    await finished?.stop();
  });

  it('binds actual HTTP preview approval to media, profile and crop and never runs before consent', async () => {
    if (!app) throw new Error('Preview approval fixture was not prepared');
    const body = startRunBody(pins, crypto.randomUUID(), 'Engineering Mock authorization', { intent: 'detect' });
    const beforeConsent = await admin.request('POST', '/api/ai/runs', body);
    expect(beforeConsent.status).toBe(403);
    const legacy = await admin.request('POST', '/api/ai/consents', { profile_id: MOCK_PROFILE, input_fingerprint: 'client-authored', approved_grants: { image: true } });
    expect(legacy.status).toBe(400);
    const authorized = await authorize(admin, body);
    const originalContext = object(authorized.context, 'authorized context');
    const configured = new DatabaseSync(database_path_for_test(app));
    try {
      configured.prepare("INSERT INTO model_profiles SELECT 'second-configured-mock',provider_id,model_id,auth_kind,capabilities_json,availability,verification,runtime_version,verified_at,config_json,secret_ref,created_at FROM model_profiles WHERE profile_id=?").run(MOCK_PROFILE);
    } finally { configured.close(); }
    for (const mutation of [
      { context: { ...originalContext, canonical_sha256: '0'.repeat(64) } },
      { profile_id: 'second-configured-mock' },
      { context: { ...originalContext, input_fingerprint: 'changed-crop-fingerprint' } },
    ]) {
      const rejected = await admin.request('POST', '/api/ai/runs', { ...authorized, ...mutation });
      expect(rejected.status, JSON.stringify(rejected.json)).toBeGreaterThanOrEqual(400);
    }
    const cropped = await admin.request<JsonObject>('POST', '/api/ai/previews', { request: body, grants: { allow_image: true, allow_object_context: true, preview_crop: { type: 'bbox_xyxy', x_min: 0, y_min: 0, x_max: 8, y_max: 8 } } });
    expect(cropped.status, JSON.stringify(cropped.json)).toBe(201);
    const croppedRequest = object(cropped.json.request, 'cropped request');
    const croppedContext = object(croppedRequest.context, 'cropped context');
    expect(croppedContext.input_fingerprint).not.toBe(originalContext.input_fingerprint);
    const deniedCrop = await admin.request('POST', '/api/ai/runs', { ...croppedRequest, consent_id: authorized.consent_id });
    expect(deniedCrop.status).toBe(403);
    const db = new DatabaseSync(database_path_for_test(app));
    try { expect(db.prepare('SELECT COUNT(*) AS n FROM model_runs').get()?.n).toBe(0); } finally { db.close(); }
    const queued = await admin.request<JsonObject>('POST', '/api/ai/runs', authorized);
    expect(queued.status, JSON.stringify(queued.json)).toBe(202);
    expect(queued.json).toMatchObject({ source: 'mock', verification: 'mock_only' });
  });
});

it('root background worker produces isolated predictions without a debug model drain', async () => {
  const app = await start_test_app('false', 'background');
  try {
    const admin = await bootstrap_admin_for_test(app);
    const pins = await seed(admin, app);
    const original = await admin.request<JsonObject>('GET', `/api/assets/${pins.assetRevisionId}/annotation?ontology_version_id=${pins.ontologyId}`);
    const authorized = await authorize(admin, startRunBody(pins, crypto.randomUUID(), 'Engineering Mock background smoke', { intent: 'detect' }));
    const queued = await admin.request<JsonObject>('POST', '/api/ai/runs', authorized);
    expect(queued.status).toBe(202);
    let suggestions: JsonObject = {};
    await expect.poll(async () => {
      const response = await admin.request<JsonObject>('GET', `/api/ai/runs/${queued.json.run_id}/suggestions`);
      expect(response.status).toBe(200);
      suggestions = response.json;
      const summary = object(suggestions.run, 'run summary');
      if (summary.state === 'failed') {
        const events = await admin.request('GET', `/api/ai/runs/${queued.json.run_id}/events`);
        throw new Error(JSON.stringify({ suggestions, events: events.json }));
      }
      if (!Array.isArray(suggestions.items)) throw new Error('suggestion items must be an array');
      return suggestions.items.map(item => object(item, 'suggestion item').state);
    }, { timeout: 15_000 }).toEqual(['pending']);
    if (!Array.isArray(suggestions.items)) throw new Error('suggestion items must be an array');
    const candidate = object(suggestions.items[0], 'pending suggestion');
    expect(candidate.context).toEqual(authorized.context);
    expect(candidate.changes).toMatchObject([{ kind: 'create', object: { label_id: 'label_person', geometry: { type: 'bbox_xyxy', x_min: 0, y_min: 0, x_max: 8, y_max: 8 } } }]);
    const after = await admin.request<JsonObject>('GET', `/api/assets/${pins.assetRevisionId}/annotation?ontology_version_id=${pins.ontologyId}`);
    expect(after.json).toEqual(original.json);
    const db = new DatabaseSync(database_path_for_test(app));
    try { expect(db.prepare('SELECT COUNT(*) AS n FROM suggestion_decisions').get()?.n).toBe(0); } finally { db.close(); }
  } finally { await app.stop(); }
}, 25_000);

it('manual model control does not stop public canonical media processing', async () => {
  const app = await start_test_app();
  try {
    const admin = await bootstrap_admin_for_test(app);
    const pins = await seed(admin, app);
    const importPublicImage = async (name: string, background: string) => {
      const png = await sharp({ create: { width: 32, height: 24, channels: 3, background } }).png().toBuffer();
      const uploaded = await admin.upload(`/api/projects/${pins.projectId}/assets`, png, name, crypto.randomUUID(), 'image/png');
      expect(uploaded.status, JSON.stringify(uploaded.json)).toBe(202);
      let imported: JsonObject | null = null;
      await expect.poll(async () => {
        const listed = await admin.request<{ items: JsonObject[] }>('GET', `/api/projects/${pins.projectId}/assets`);
        expect(listed.status).toBe(200);
        imported = listed.json.items.find(asset => asset.original_name === name) ?? null;
        return imported !== null;
      }, { timeout: 10_000, message: 'Production media worker must canonicalize without a debug drain' }).toBe(true);
      expect(imported).toMatchObject({ original_name: name, canonical_width: 32, canonical_height: 24, exif_orientation: 1, original_sha256: createHash('sha256').update(png).digest('hex') });
    };
    await importPublicImage('manual-model-before.png', '#c04420');
    const authorized = await authorize(admin, startRunBody(pins, crypto.randomUUID(), 'Engineering Mock stays manually queued', { intent: 'detect' }));
    const queued = await admin.request<JsonObject>('POST', '/api/ai/runs', authorized);
    expect(queued.status, JSON.stringify(queued.json)).toBe(202);
    await importPublicImage('manual-model-after.png', '#2044c0');
    const suggestions = await admin.request<JsonObject>('GET', `/api/ai/runs/${queued.json.run_id}/suggestions`);
    expect(suggestions.status).toBe(200);
    expect(object(suggestions.json.run, 'manually controlled run').state).toBe('queued');
    expect(suggestions.json.items).toEqual([]);
    const db = new DatabaseSync(database_path_for_test(app));
    try { expect(db.prepare('SELECT state FROM model_runs WHERE run_id=?').get(String(queued.json.run_id))?.state).toBe('queued'); } finally { db.close(); }
  } finally { await app.stop(); }
}, 30_000);
