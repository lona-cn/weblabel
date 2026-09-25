import { readFile } from 'node:fs/promises';

import { expect, it } from 'vitest';

import { bootstrap_admin_for_test, start_test_app, type ApiClient } from '../support/app';

type JsonObject = Record<string, unknown>;
type ApiError = { code: string };

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} response was not an object`);
  }
  return value as JsonObject;
}
function stringField(value: unknown, key: string, label: string): string {
  const field = object(value, label)[key];
  expect(typeof field, `${label}.${key}`).toBe('string');
  return field as string;
}

const MOCK_PROFILE = 'profile_mock_local';

const ontologyBody = {
  guidelines_markdown: 'Label visible persons.',
  labels: [{
    label_id: 'label_person',
    name: 'Person',
    color: '#0099ff',
    shortcut: null,
    allowed_geometry_types: ['bbox_xyxy'],
    attributes: [{
      key: 'helmet_state',
      kind: 'enum',
      required: false,
      default_value: 'unknown',
      enum_values: ['wearing', 'not_wearing', 'unknown'],
      min: null,
      max: null,
    }],
  }],
};

interface Seeded {
  projectId: string;
  ontologyId: string;
  assetRevisionId: string;
  annotationRevisionId: string;
  canonicalSha256: string;
}

async function drainJobs(client: ApiClient): Promise<number> {
  const response = await client.request<JsonObject>('POST', '/internal/test/jobs/drain', {});
  expect(response.status, JSON.stringify(response.json)).toBe(200);
  return object(response.json, 'drain').processed as number;
}

// The shared harness upload helper sends untyped blobs (application/octet-stream)
// which the media decode-header policy rejects at processing time; a browser
// file input carries the real MIME type, so this test uploads with a typed File.
interface MediaUploader {
  cookie: string;
  csrf: string;
}
async function uploaderFor(admin: ApiClient, baseUrl: string, projectId: string): Promise<MediaUploader> {
  const username = `t17-uploader-${crypto.randomUUID()}`;
  const password = `${crypto.randomUUID()}long-enough-password`;
  const created = await admin.request<JsonObject>('POST', '/api/users', { username, password });
  expect(created.status).toBe(201);
  const userId = stringField(created.json, 'user_id', 'user creation');
  const membership = await admin.request('POST', `/api/projects/${projectId}/members`, { user_id: userId, role: 'admin' });
  expect(membership.status).toBe(200);
  const login = await fetch(new URL('/api/session/login', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl, host: new URL(baseUrl).host },
    body: JSON.stringify({ username, password }),
  });
  expect(login.status).toBe(200);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
  expect(cookie).not.toBe('');
  const body = await login.json() as JsonObject;
  return { cookie, csrf: body.csrf_token as string };
}

async function uploadImage(baseUrl: string, uploader: MediaUploader, projectId: string, bytes: Uint8Array, operationId: string) {
  const form = new FormData();
  form.append('images', new File([bytes], 'orientation-1.jpg', { type: 'image/jpeg' }), 'orientation-1.jpg');
  return fetch(new URL(`/api/projects/${projectId}/assets`, baseUrl), {
    method: 'POST',
    headers: {
      cookie: uploader.cookie,
      'x-csrf-token': uploader.csrf,
      origin: baseUrl,
      'idempotency-key': operationId,
    },
    body: form,
  });
}

async function seed(admin: ApiClient, baseUrl: string): Promise<Seeded> {
  const project = await admin.request<JsonObject>('POST', '/api/projects', {
    name: 'T17 model jobs', description: 'isolated t17 integration project', allow_self_review: false,
  });
  expect(project.status).toBe(201);
  const projectId = stringField(project.json, 'project_id', 'project');
  const ontology = await admin.request<JsonObject>('POST', `/api/projects/${projectId}/ontologies`, ontologyBody);
  expect(ontology.status).toBe(201);
  const ontologyId = stringField(ontology.json, 'ontology_version_id', 'ontology');

  const uploader = await uploaderFor(admin, baseUrl, projectId);
  const image = new Uint8Array(await readFile(new URL('../fixtures/media/orientation-1.jpg', import.meta.url)));
  const upload = await uploadImage(baseUrl, uploader, projectId, image, `t17-import-${crypto.randomUUID()}`);
  expect(upload.status).toBe(202);
  expect(await drainJobs(admin)).toBe(1);

  const listed = await admin.request<JsonObject>('GET', `/api/projects/${projectId}/assets`);
  expect(listed.status).toBe(200);
  const items = object(listed.json, 'assets').items as JsonObject[];
  expect(items).toHaveLength(1);
  const assetRevisionId = stringField(items[0], 'asset_revision_id', 'asset');
  const canonicalSha256 = stringField(items[0], 'canonical_sha256', 'asset');

  const annotation = await admin.request<JsonObject>('GET', `/api/assets/${assetRevisionId}/annotation?ontology_version_id=${ontologyId}`);
  expect(annotation.status).toBe(200);
  const annotationRevisionId = stringField(annotation.json, 'annotation_revision_id', 'annotation');
  return { projectId, ontologyId, assetRevisionId, annotationRevisionId, canonicalSha256 };
}

function startRunBody(seeded: Seeded, operationId: string, prompt: string, overrides: JsonObject = {}): JsonObject {
  return {
    operation_id: operationId,
    profile_id: MOCK_PROFILE,
    context: {
      project_id: seeded.projectId,
      asset_revision_id: seeded.assetRevisionId,
      annotation_revision_id: seeded.annotationRevisionId,
      ontology_version_id: seeded.ontologyId,
      draft_generation: 0,
      canonical_sha256: seeded.canonicalSha256,
      selected_object_ids: [],
      object_hashes: {},
      input_fingerprint: 't17-ts-fingerprint-0001',
    },
    intent: 'find_issues',
    prompt,
    consent_id: null,
    ...overrides,
  };
}

it('creates model runs idempotently and rejects operation_id payload reuse', async () => {
  const app = await start_test_app();
  try {
    const admin = await bootstrap_admin_for_test(app);
    const seeded = await seed(admin, app.base_url);
    const body = startRunBody(seeded, 't17-ts-op-1', 'review the helmet attribute');

    const created = await admin.request<JsonObject>('POST', '/api/ai/runs', body);
    expect(created.status, JSON.stringify(created.json)).toBe(202);
    const runId = stringField(created.json, 'run_id', 'create');
    const jobId = stringField(created.json, 'job_id', 'create');
    expect(object(created.json, 'create').idempotent_replay).toBe(false);
    expect(object(created.json, 'create').state).toBe('queued');
    expect(object(created.json, 'create').cost_display).toBe('none');

    const replay = await admin.request<JsonObject>('POST', '/api/ai/runs', body);
    expect(replay.status, JSON.stringify(replay.json)).toBe(202);
    expect(stringField(replay.json, 'run_id', 'replay')).toBe(runId);
    expect(stringField(replay.json, 'job_id', 'replay')).toBe(jobId);
    expect(object(replay.json, 'replay').idempotent_replay).toBe(true);

    const conflict = await admin.request<ApiError>('POST', '/api/ai/runs',
      startRunBody(seeded, 't17-ts-op-1', 'a completely different prompt'));
    expect(conflict.status).toBe(409);
    expect(conflict.json.code).toBe('IDEMPOTENCY_KEY_REUSE');

    // Replay never duplicates the queued billing run or its job.
    const job = await admin.request<JsonObject>('GET', `/api/jobs/${jobId}`);
    expect(job.status).toBe(200);
    expect(object(job.json, 'job').state).toBe('queued');
    expect(object(job.json, 'job').kind).toBe('model_run');
  } finally {
    await app.stop();
  }
});

it('streams monotonic run events and pages them by after', async () => {
  const app = await start_test_app();
  try {
    const admin = await bootstrap_admin_for_test(app);
    const seeded = await seed(admin, app.base_url);
    const created = await admin.request<JsonObject>('POST', '/api/ai/runs',
      startRunBody(seeded, 't17-ts-op-events', 'stream events'));
    expect(created.status).toBe(202);
    const runId = stringField(created.json, 'run_id', 'create');

    const queued = await admin.request<JsonObject>('GET', `/api/ai/runs/${runId}/events?after=0&limit=2`);
    expect(queued.status).toBe(200);
    const queuedRun = object(object(queued.json, 'events').run, 'events.run');
    expect(queuedRun.state).toBe('queued');
    expect(queuedRun.cost_display).toBe('none');
    expect(queuedRun.source).toBe('mock');
    expect(queuedRun.verification).toBe('mock_only');
    const firstPage = object(queued.json, 'events').items as JsonObject[];
    expect(firstPage.map(event => event.seq)).toEqual([1]);
    expect(firstPage[0].type).toBe('queued');
    expect(object(queued.json, 'events').next_cursor).toBeNull();

    expect(await drainJobs(admin)).toBe(1);
    const rest = await admin.request<JsonObject>('GET', `/api/ai/runs/${runId}/events?after=1`);
    expect(rest.status).toBe(200);
    const events = object(rest.json, 'events').items as JsonObject[];
    expect(events.length).toBeGreaterThanOrEqual(3);
    const seqs = events.map(event => event.seq as number);
    for (let index = 1; index < seqs.length; index += 1) {
      expect(seqs[index]!).toBeGreaterThan(seqs[index - 1]!);
    }
    expect(events[0].type).toBe('started');
    expect(events.map(event => event.type)).toContain('candidate');
    expect(events[events.length - 1].type).toBe('succeeded');
    expect(object(object(rest.json, 'events').run, 'events.run').state).toBe('succeeded');

    // Re-polling after the last sequence never re-submits the model request.
    const before = await admin.request<JsonObject>('GET', `/api/ai/runs/${runId}/events?after=${seqs[seqs.length - 1]}`);
    expect(before.status).toBe(200);
    expect(object(before.json, 'events').items).toEqual([]);
    expect(await drainJobs(admin)).toBe(0);
    const afterDrain = await admin.request<JsonObject>('GET', `/api/ai/runs/${runId}/events?after=1`);
    expect(object(afterDrain.json, 'events').items).toHaveLength(events.length);

    const bad = await admin.request<ApiError>('GET', `/api/ai/runs/${runId}/events?after=-1`);
    expect(bad.status).toBe(400);
  } finally {
    await app.stop();
  }
});

it('cancels runs idempotently and never resumes cancelled work', async () => {
  const app = await start_test_app();
  try {
    const admin = await bootstrap_admin_for_test(app);
    const seeded = await seed(admin, app.base_url);
    const created = await admin.request<JsonObject>('POST', '/api/ai/runs',
      startRunBody(seeded, 't17-ts-op-cancel', 'cancel me'));
    expect(created.status).toBe(202);
    const runId = stringField(created.json, 'run_id', 'create');

    const first = await admin.request<JsonObject>('POST', `/api/ai/runs/${runId}/cancel`, {});
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    const second = await admin.request<JsonObject>('POST', `/api/ai/runs/${runId}/cancel`, {});
    expect(second.status).toBe(200);
    expect(second.json).toEqual(first.json);
    expect(object(first.json, 'cancel').state).toBe('cancelled');
    expect(object(first.json, 'cancel').cancel_requested).toBe(true);

    // The cancelled run is never picked up by the worker.
    expect(await drainJobs(admin)).toBe(0);
    const events = await admin.request<JsonObject>('GET', `/api/ai/runs/${runId}/events?after=0`);
    expect(events.status).toBe(200);
    const items = object(events.json, 'events').items as JsonObject[];
    expect(items.map(event => event.type)).toEqual(['queued', 'cancelled']);
    const suggestions = await admin.request<JsonObject>('GET', `/api/ai/runs/${runId}/suggestions`);
    expect(suggestions.status).toBe(200);
    expect(object(suggestions.json, 'suggestions').items).toEqual([]);
    expect(object(object(suggestions.json, 'suggestions').run, 'run').state).toBe('cancelled');
  } finally {
    await app.stop();
  }
});

it('labels mock runs explicitly and keeps suggestion content stable', async () => {
  const app = await start_test_app();
  try {
    const admin = await bootstrap_admin_for_test(app);
    const seeded = await seed(admin, app.base_url);
    const created = await admin.request<JsonObject>('POST', '/api/ai/runs',
      startRunBody(seeded, 't17-ts-op-mock', 'mock labeling'));
    expect(created.status).toBe(202);
    const runId = stringField(created.json, 'run_id', 'create');
    expect(object(created.json, 'create').source).toBe('mock');
    expect(object(created.json, 'create').provider_id).toBe('mock');
    expect(object(created.json, 'create').verification).toBe('mock_only');
    expect(await drainJobs(admin)).toBe(1);

    const first = await admin.request<JsonObject>('GET', `/api/ai/runs/${runId}/suggestions`);
    expect(first.status).toBe(200);
    const firstEnvelope = object(first.json, 'suggestions');
    const firstSets = firstEnvelope.items as JsonObject[];
    expect(firstSets).toHaveLength(1);
    expect(object(firstSets[0]!, 'set').state).toBe('pending');
    const predictionId = stringField(firstSets[0], 'prediction_id', 'set');
    const runSummary = object(firstEnvelope.run, 'run');
    expect(runSummary.source).toBe('mock');
    expect(runSummary.verification).toBe('mock_only');
    expect(runSummary.input_fingerprint).toBe('t17-ts-fingerprint-0001');
    expect(stringField(runSummary, 'request_hash', 'run')).toHaveLength(64);

    // Prediction content is immutable: polling returns the same suggestion set.
    const second = await admin.request<JsonObject>('GET', `/api/ai/runs/${runId}/suggestions`);
    expect(second.json).toEqual(first.json);
    expect(stringField((object(second.json, 'suggestions').items as JsonObject[])[0]!, 'prediction_id', 'set')).toBe(predictionId);
  } finally {
    await app.stop();
  }
});

it('enforces project membership and write roles on every run route', async () => {
  const app = await start_test_app();
  try {
    const admin = await bootstrap_admin_for_test(app);
    const seeded = await seed(admin, app.base_url);
    const created = await admin.request<JsonObject>('POST', '/api/ai/runs',
      startRunBody(seeded, 't17-ts-op-authz', 'authorization'));
    expect(created.status).toBe(202);
    const runId = stringField(created.json, 'run_id', 'create');
    const jobId = stringField(created.json, 'job_id', 'create');

    // A user without membership cannot see or touch anything on these routes.
    const outsider = await app.as_user('annotator');
    for (const [method, path] of [
      ['GET', `/api/ai/runs/${runId}/events?after=0`],
      ['GET', `/api/ai/runs/${runId}/suggestions`],
      ['GET', `/api/jobs/${jobId}`],
      ['POST', `/api/ai/runs/${runId}/cancel`],
    ] as const) {
      const response = await outsider.request(method, path, method === 'POST' ? {} : undefined);
      expect(response.status, `${method} ${path}`).toBe(404);
    }

    // A project viewer may read but never start or cancel runs.
    const viewer = await app.as_user('viewer');
    const viewerSession = await viewer.request<JsonObject>('GET', '/api/session');
    expect(viewerSession.status).toBe(200);
    const viewerId = stringField(viewerSession.json, 'user_id', 'session');
    const membership = await admin.request('POST', `/api/projects/${seeded.projectId}/members`, { user_id: viewerId, role: 'viewer' });
    expect(membership.status).toBe(200);
    const read = await viewer.request<JsonObject>('GET', `/api/ai/runs/${runId}/events?after=0`);
    expect(read.status).toBe(200);
    const deniedStart = await viewer.request<ApiError>('POST', '/api/ai/runs', startRunBody(seeded, 't17-ts-op-viewer', 'viewer start'));
    expect(deniedStart.status).toBe(403);
    expect(deniedStart.json.code).toBe('PROJECT_WRITE_REQUIRED');
    const deniedCancel = await viewer.request<ApiError>('POST', `/api/ai/runs/${runId}/cancel`, {});
    expect(deniedCancel.status).toBe(403);

    // Unauthenticated and malformed requests fail closed.
    const anonymous = await fetch(new URL(`/api/ai/runs/${runId}/events?after=0`, app.base_url));
    expect(anonymous.status).toBe(401);
    const unknownProfile = await admin.request<ApiError>('POST', '/api/ai/runs',
      startRunBody(seeded, 't17-ts-op-unknown', 'x', { profile_id: 'profile-missing' }));
    expect(unknownProfile.status).toBe(404);
    expect(unknownProfile.json.code).toBe('PROFILE_NOT_FOUND');
    const longPrompt = await admin.request<ApiError>('POST', '/api/ai/runs',
      startRunBody(seeded, 't17-ts-op-long', 'x', { prompt: 'p'.repeat(9000) }));
    expect(longPrompt.status).toBe(413);
  } finally {
    await app.stop();
  }
});
