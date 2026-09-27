import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';
import { bootstrap_admin_for_test, start_test_app, type ApiClient } from '../support/app';

type JsonObject = Record<string, unknown>;
function object(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} was not an object`);
  return value as JsonObject;
}
function stringField(value: unknown, key: string, label: string): string {
  const field = object(value, label)[key];
  if (typeof field !== 'string' || field.length === 0) throw new Error(`${label}.${key} was missing`);
  return field;
}

const ontology = {
  guidelines_markdown: 'T15 independent export parser fixture.',
  labels: [{
    label_id: 'label_person', name: 'Person', color: '#0099ff', shortcut: null,
    allowed_geometry_types: ['bbox_xyxy'],
    attributes: [{ key: 'helmet_state', kind: 'enum', required: false, default_value: 'unknown', enum_values: ['wearing', 'not_wearing', 'unknown'], min: null, max: null }],
  }],
};

async function uploadAsImage(appUrl: string, credentials: { cookie: string; csrf: string }, projectId: string, bytes: Uint8Array): Promise<void> {
  const form = new FormData();
  form.append('images', new Blob([bytes], { type: 'image/jpeg' }), 't15-export-fixture.jpg');
  const response = await fetch(new URL(`/api/projects/${projectId}/assets`, appUrl), {
    method: 'POST',
    headers: { cookie: credentials.cookie, 'x-csrf-token': credentials.csrf, origin: appUrl, 'idempotency-key': crypto.randomUUID() },
    body: form,
  });
  if (response.status !== 202) throw new Error(`Real T15 media upload failed (${response.status}): ${await response.text()}`);
}

async function loginUploader(admin: ApiClient, appUrl: string, projectId: string): Promise<{ cookie: string; csrf: string }> {
  const username = `t15-export-${crypto.randomUUID()}`;
  const password = `${crypto.randomUUID()}-T15-password`;
  const created = await admin.request<JsonObject>('POST', '/api/users', { username, password });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const membership = await admin.request('POST', `/api/projects/${projectId}/members`, { user_id: stringField(created.json, 'user_id', 'user'), role: 'admin' });
  expect(membership.status).toBe(200);
  const response = await fetch(new URL('/api/session/login', appUrl), {
    method: 'POST', headers: { 'content-type': 'application/json', origin: appUrl, host: new URL(appUrl).host },
    body: JSON.stringify({ username, password }),
  });
  expect(response.status).toBe(200);
  const cookie = (response.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
  expect(cookie).not.toBe('');
  return { cookie, csrf: stringField(await response.json(), 'csrf_token', 'login') };
}

it('saves canonical xyxy and attributes, then reads real COCO download bytes independently', async () => {
  const app = await start_test_app();
  const scratch = await mkdtemp(resolve(tmpdir(), 'weblabel-t15-export-'));
  try {
    const admin = await bootstrap_admin_for_test(app);
    const project = await admin.request<JsonObject>('POST', '/api/projects', {
      name: `T15 export ${crypto.randomUUID()}`, description: 'Real API export parser integration', allow_self_review: true,
    });
    expect(project.status, JSON.stringify(project.json)).toBe(201);
    const projectId = stringField(project.json, 'project_id', 'project');
    const published = await admin.request<JsonObject>('POST', `/api/projects/${projectId}/ontologies`, ontology);
    expect(published.status, JSON.stringify(published.json)).toBe(201);
    const ontologyId = stringField(published.json, 'ontology_version_id', 'ontology');

    const credentials = await loginUploader(admin, app.base_url, projectId);
    const image = new Uint8Array(await readFile(new URL('../fixtures/media/orientation-1.jpg', import.meta.url)));
    await uploadAsImage(app.base_url, credentials, projectId, image);
    const drained = await admin.request<JsonObject>('POST', '/internal/test/jobs/drain', {});
    expect(drained.status, JSON.stringify(drained.json)).toBe(200);
    expect(object(drained.json, 'drain').processed).toBe(1);

    const assets = await admin.request<JsonObject>('GET', `/api/projects/${projectId}/assets`);
    expect(assets.status).toBe(200);
    const assetItems = object(assets.json, 'assets').items;
    if (!Array.isArray(assetItems) || assetItems.length !== 1) throw new Error('Expected exactly one imported API media asset');
    const assetId = stringField(assetItems[0], 'asset_revision_id', 'asset');
    const head = await admin.request<JsonObject>('GET', `/api/assets/${assetId}/annotation?ontology_version_id=${ontologyId}`);
    expect(head.status).toBe(200);
    const headRevision = stringField(head.json, 'annotation_revision_id', 'annotation');
    const initialDocument = object(head.json, 'annotation').document;
    const initial = object(initialDocument, 'document');
    const coordinateSpace = object(initial.coordinate_space, 'coordinate space');
    const width = coordinateSpace.width;
    const height = coordinateSpace.height;
    expect(typeof width).toBe('number');
    expect(typeof height).toBe('number');
    const box = { x_min: 8, y_min: 6, x_max: 24, y_max: 18 };
    const document = {
      ...initial,
      completion: 'complete',
      objects: [{
        object_id: 't15-object-person-1', label_id: 'label_person',
        geometry: { type: 'bbox_xyxy', ...box }, attributes: { helmet_state: 'wearing' },
        origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null },
      }],
    };
    const save = await admin.request<JsonObject>('PUT', `/api/assets/${assetId}/annotation`, {
      operation_id: crypto.randomUUID(), base_revision_id: headRevision, document, lease: null, suggestion_decisions: [],
    });
    expect(save.status, JSON.stringify(save.json)).toBe(200);
    const savedRevisionId = stringField(object(save.json, 'save').revision, 'annotation_revision_id', 'saved revision');
    const savedDocument = object(object(save.json, 'save').revision, 'revision').document;
    expect(savedDocument).toEqual(document);

    const exported = await admin.request<JsonObject>('POST', `/api/annotation-revisions/${savedRevisionId}/exports`, {
      format: 'coco', loss_ack: true, operation_id: crypto.randomUUID(),
    });
    expect(exported.status, JSON.stringify(exported.json)).toBe(200);
    const downloadPath = stringField(exported.json, 'download_url', 'export');
    const response = await fetch(new URL(downloadPath, app.base_url), { headers: { cookie: credentials.cookie, origin: app.base_url } });
    expect(response.status).toBe(200);
    const content = new Uint8Array(await response.arrayBuffer());
    expect(content.byteLength).toBeGreaterThan(0);
    const exportFile = resolve(scratch, 'downloaded-coco.json');
    await writeFile(exportFile, content);
    const parser = fileURLToPath(new URL('../../scripts/check-dataset-loader.py', import.meta.url));
    const parsed = execFileSync(process.env.PYTHON ?? 'python', [parser, exportFile, '--label', 'label_person', '--xyxy', String(box.x_min), String(box.y_min), String(box.x_max), String(box.y_max)], { encoding: 'utf8' });
    const independentlyRead = JSON.parse(parsed) as JsonObject;
    expect(independentlyRead.width).toBe(width);
    expect(independentlyRead.height).toBe(height);
    expect(independentlyRead.objects).toEqual([{ label_id: 'label_person', ...box }]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await app.stop();
  }
});
