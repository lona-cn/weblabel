import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { bootstrap_admin_for_test, start_test_app, type ApiClient } from '../support/app';

type RecordValue = Record<string, unknown>;
function record(value: unknown, label: string): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} was not an object`);
  return value as RecordValue;
}
function requiredString(value: unknown, key: string, label: string): string {
  const field = record(value, label)[key];
  if (typeof field !== 'string' || field.length === 0) throw new Error(`${label}.${key} was missing`);
  return field;
}

const ontology = {
  guidelines_markdown: 'T27 snapshot and export integration ontology.',
  labels: [
    { label_id: 'label_person', name: 'Person', color: '#0099ff', shortcut: null, allowed_geometry_types: ['bbox_xyxy'], attributes: [{ key: 'helmet_state', kind: 'enum', required: false, default_value: 'unknown', enum_values: ['wearing', 'not_wearing', 'unknown'], min: null, max: null }] },
    { label_id: 'label_aaa', name: 'Animal', color: '#33aa55', shortcut: null, allowed_geometry_types: ['bbox_xyxy'], attributes: [] },
  ],
};

async function setupApprovedRevision(admin: ApiClient): Promise<{ projectId: string; ontologyId: string; assetId: string; revision0: string; revisionId: string; nextTaskId: string; fencingToken: number; changedDocument: RecordValue }> {
  const projectResponse = await admin.request<RecordValue>('POST', '/api/projects', { name: `T27 ${crypto.randomUUID()}`, description: 'Immutable snapshot export integration', allow_self_review: true });
  expect(projectResponse.status, JSON.stringify(projectResponse.json)).toBe(201);
  const projectId = requiredString(projectResponse.json, 'project_id', 'project');
  const ontologyResponse = await admin.request<RecordValue>('POST', `/api/projects/${projectId}/ontologies`, ontology);
  expect(ontologyResponse.status).toBe(201);
  const ontologyId = requiredString(ontologyResponse.json, 'ontology_version_id', 'ontology');
  const image = new Uint8Array(await readFile(new URL('../fixtures/media/orientation-1.jpg', import.meta.url)));
  const upload = await admin.upload(`/api/projects/${projectId}/assets`, image, 'T27 source.jpg', crypto.randomUUID(), 'image/jpeg');
  expect(upload.status).toBe(202);
  const drained = await admin.request<RecordValue>('POST', '/internal/test/jobs/drain', {});
  expect(drained.status, JSON.stringify(drained.json)).toBe(200);
  const assetList = await admin.request<RecordValue>('GET', `/api/projects/${projectId}/assets?limit=100`);
  expect(assetList.status).toBe(200);
  const assetItems = record(assetList.json, 'asset list').items;
  if (!Array.isArray(assetItems) || assetItems.length !== 1) throw new Error('Expected one imported asset');
  const assetId = requiredString(assetItems[0], 'asset_revision_id', 'media revision');
  const head = await admin.request<RecordValue>('GET', `/api/assets/${assetId}/annotation?ontology_version_id=${ontologyId}`);
  expect(head.status).toBe(200);
  const revision0 = requiredString(head.json, 'annotation_revision_id', 'initial annotation');
  const original = head.json.document;
  const originalDocument = record(original, 'annotation document');
  const document = { ...originalDocument, completion: 'complete', objects: [{ object_id: 't27-person', label_id: 'label_person', geometry: { type: 'bbox_xyxy', x_min: 10, y_min: 5, x_max: 40, y_max: 30 }, attributes: { helmet_state: 'wearing' }, origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null } }] };
  const saved = await admin.request<RecordValue>('PUT', `/api/assets/${assetId}/annotation`, { operation_id: crypto.randomUUID(), base_revision_id: revision0, document, lease: null, suggestion_decisions: [] });
  expect(saved.status, JSON.stringify(saved.json)).toBe(200);
  const revisionId = requiredString(record(saved.json, 'save').revision, 'annotation_revision_id', 'saved annotation');
  const session = await admin.request<RecordValue>('GET', '/api/session');
  const adminId = requiredString(session.json, 'user_id', 'admin session');
  const task = await admin.request<RecordValue>('POST', `/api/projects/${projectId}/tasks`, { asset_revision_id: assetId, ontology_version_id: ontologyId, assignee_id: adminId });
  expect(task.status, JSON.stringify(task.json)).toBe(200);
  const taskId = requiredString(task.json, 'task_id', 'review task');
  const lease = await admin.request<RecordValue>('POST', `/api/tasks/${taskId}/lease`, { action: 'acquire' });
  expect(lease.status, JSON.stringify(lease.json)).toBe(200);
  const submitted = await admin.request<RecordValue>('POST', `/api/tasks/${taskId}/submit`, { annotation_revision_ids: [revisionId] });
  expect(submitted.status, JSON.stringify(submitted.json)).toBe(200);
  const reviewId = requiredString(submitted.json, 'review_id', 'review submission');
  const decision = await admin.request<RecordValue>('POST', `/api/reviews/${reviewId}/decision`, { decision: 'approve', reason: 'T27 fixed revision review', revision_ids: [revisionId] });
  expect(decision.status, JSON.stringify(decision.json)).toBe(200);
  const nextTask = await admin.request<RecordValue>('POST', `/api/projects/${projectId}/tasks`, { asset_revision_id: assetId, ontology_version_id: ontologyId, assignee_id: adminId });
  expect(nextTask.status).toBe(200);
  const nextTaskId = requiredString(nextTask.json, 'task_id', 'next revision task');
  const nextLease = await admin.request<RecordValue>('POST', `/api/tasks/${nextTaskId}/lease`, { action: 'acquire' });
  expect(nextLease.status).toBe(200);
  const fencingToken = record(nextLease.json, 'next task lease').fencing_token;
  if (typeof fencingToken !== 'number') throw new Error('Task lease fencing_token was missing');
  const changedDocument = { ...document, objects: [{ ...(document.objects[0]!), attributes: { helmet_state: 'not_wearing' } }] };
  return { projectId, ontologyId, assetId, revision0, revisionId, nextTaskId, fencingToken, changedDocument };
}
async function reviseAndApprove(admin: ApiClient, projectId: string, ontologyId: string, assetId: string, baseRevisionId: string, document: RecordValue): Promise<string> {
  const session = await admin.request<RecordValue>('GET', '/api/session');
  const userId = requiredString(session.json, 'user_id', 'review user');
  const task = await admin.request<RecordValue>('POST', `/api/projects/${projectId}/tasks`, { asset_revision_id: assetId, ontology_version_id: ontologyId, assignee_id: userId });
  expect(task.status).toBe(200);
  const taskId = requiredString(task.json, 'task_id', 'readiness task');
  const lease = await admin.request<RecordValue>('POST', `/api/tasks/${taskId}/lease`, { action: 'acquire' });
  expect(lease.status).toBe(200);
  const fencingToken = record(lease.json, 'readiness lease').fencing_token;
  if (typeof fencingToken !== 'number') throw new Error('Readiness lease fencing_token was missing');
  const saved = await admin.request<RecordValue>('PUT', `/api/assets/${assetId}/annotation`, {
    operation_id: crypto.randomUUID(), base_revision_id: baseRevisionId, document,
    lease: { task_id: taskId, fencing_token: fencingToken }, suggestion_decisions: [],
  });
  expect(saved.status, JSON.stringify(saved.json)).toBe(200);
  const revisionId = requiredString(record(saved.json, 'save').revision, 'annotation_revision_id', 'readiness revision');
  const submitted = await admin.request<RecordValue>('POST', `/api/tasks/${taskId}/submit`, { annotation_revision_ids: [revisionId] });
  expect(submitted.status).toBe(200);
  const reviewId = requiredString(submitted.json, 'review_id', 'readiness review');
  const decision = await admin.request<RecordValue>('POST', `/api/reviews/${reviewId}/decision`, { decision: 'approve', reason: 'T27 readiness behavior', revision_ids: [revisionId] });
  expect(decision.status).toBe(200);
  return revisionId;
}

async function setupSecondApprovedAsset(admin: ApiClient, projectId: string, ontologyId: string, existingAssetId: string): Promise<{ assetId: string; revisionId: string }> {
  const image = new Uint8Array(await readFile(new URL('../fixtures/media/orientation-1.jpg', import.meta.url)));
  const upload = await admin.upload(`/api/projects/${projectId}/assets`, image, 'T27 second source.jpg', crypto.randomUUID(), 'image/jpeg');
  expect(upload.status).toBe(202);
  const drained = await admin.request<RecordValue>('POST', '/internal/test/jobs/drain', {});
  expect(drained.status).toBe(200);
  const assets = await admin.request<RecordValue>('GET', `/api/projects/${projectId}/assets?limit=100`);
  expect(assets.status).toBe(200);
  const items = record(assets.json, 'second asset list').items;
  if (!Array.isArray(items)) throw new Error('Second asset list did not contain items');
  const second = items.find((item) => record(item, 'asset').asset_revision_id !== existingAssetId);
  if (!second) throw new Error('Second imported asset was missing');
  const assetId = requiredString(second, 'asset_revision_id', 'second media revision');
  const head = await admin.request<RecordValue>('GET', `/api/assets/${assetId}/annotation?ontology_version_id=${ontologyId}`);
  expect(head.status).toBe(200);
  const initial = record(head.json.document, 'second annotation document');
  const document = {
    ...initial,
    completion: 'complete',
    objects: [{
      object_id: 't27-second-person', label_id: 'label_person',
      geometry: { type: 'bbox_xyxy', x_min: 10, y_min: 5, x_max: 40, y_max: 30 },
      attributes: { helmet_state: 'wearing' },
      origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null },
    }],
  };
  const session = await admin.request<RecordValue>('GET', '/api/session');
  const userId = requiredString(session.json, 'user_id', 'second asset reviewer');
  const task = await admin.request<RecordValue>('POST', `/api/projects/${projectId}/tasks`, { asset_revision_id: assetId, ontology_version_id: ontologyId, assignee_id: userId });
  expect(task.status).toBe(200);
  const taskId = requiredString(task.json, 'task_id', 'second asset task');
  const lease = await admin.request<RecordValue>('POST', `/api/tasks/${taskId}/lease`, { action: 'acquire' });
  expect(lease.status).toBe(200);
  const fencingToken = record(lease.json, 'second asset lease').fencing_token;
  if (typeof fencingToken !== 'number') throw new Error('Second asset lease fencing_token was missing');
  const saved = await admin.request<RecordValue>('PUT', `/api/assets/${assetId}/annotation`, {
    operation_id: crypto.randomUUID(), base_revision_id: requiredString(head.json, 'annotation_revision_id', 'second initial revision'),
    document, lease: { task_id: taskId, fencing_token: fencingToken }, suggestion_decisions: [],
  });
  expect(saved.status).toBe(200);
  const revisionId = requiredString(record(saved.json, 'save').revision, 'annotation_revision_id', 'second saved revision');
  const submitted = await admin.request<RecordValue>('POST', `/api/tasks/${taskId}/submit`, { annotation_revision_ids: [revisionId] });
  expect(submitted.status).toBe(200);
  const decision = await admin.request<RecordValue>('POST', `/api/reviews/${requiredString(submitted.json, 'review_id', 'second review')}/decision`, { decision: 'approve', reason: 'T27 multi-image COCO coverage', revision_ids: [revisionId] });
  expect(decision.status).toBe(200);
  return { assetId, revisionId };
}

it('freezes approved r8, exports r8 after r9, retries hashes, reports loss and scopes downloads', async () => {
  const app = await start_test_app();
  const scratch = await mkdtemp(resolve(tmpdir(), 'weblabel-t27-export-'));
  try {
    const admin = await bootstrap_admin_for_test(app);
    const { projectId, ontologyId, assetId, revision0, revisionId, nextTaskId, fencingToken, changedDocument } = await setupApprovedRevision(admin);
    const unready = await admin.request<RecordValue>('POST', `/api/projects/${projectId}/dataset-versions`, { operation_id: crypto.randomUUID(), ontology_version_id: ontologyId, items: [{ asset_revision_id: assetId, annotation_revision_id: revision0, split: 'train' }], excluded: [] });
    expect(unready.status).toBe(422);
    expect(record(unready.json, 'unready snapshot').code).toBe('SNAPSHOT_NOT_READY');
    const snapshotRequest = { operation_id: crypto.randomUUID(), ontology_version_id: ontologyId, items: [{ asset_revision_id: assetId, annotation_revision_id: revisionId, split: 'train' }], excluded: [], split_seed: null, split_ratios: null };
    const snapshot = await admin.request<RecordValue>('POST', `/api/projects/${projectId}/dataset-versions`, snapshotRequest);
    expect(snapshot.status, JSON.stringify(snapshot.json)).toBe(201);
    const datasetId = requiredString(snapshot.json, 'dataset_version_id', 'snapshot');
    const later = await admin.request<RecordValue>('PUT', `/api/assets/${assetId}/annotation`, { operation_id: crypto.randomUUID(), base_revision_id: revisionId, document: changedDocument, lease: { task_id: nextTaskId, fencing_token: fencingToken }, suggestion_decisions: [] });
    expect(later.status, JSON.stringify(later.json)).toBe(200);
    const revision9 = requiredString(record(later.json, 'save').revision, 'annotation_revision_id', 'later annotation');
    expect(revision9).not.toBe(revisionId);
    const unapproved = await admin.request<RecordValue>('POST', `/api/projects/${projectId}/dataset-versions`, { ...snapshotRequest, operation_id: crypto.randomUUID(), items: [{ ...snapshotRequest.items[0]!, annotation_revision_id: revision9 }] });
    expect(unapproved.status).toBe(422);
    expect(record(unapproved.json, 'unapproved snapshot').code).toBe('SNAPSHOT_NOT_APPROVED');
    const snapshotRetry = await admin.request<RecordValue>('POST', `/api/projects/${projectId}/dataset-versions`, snapshotRequest);
    expect(snapshotRetry.status).toBe(200);
    expect(requiredString(snapshotRetry.json, 'dataset_version_id', 'snapshot retry')).toBe(datasetId);
    const otherProjectResponse = await admin.request<RecordValue>('POST', '/api/projects', { name: `T27 replay scope ${crypto.randomUUID()}`, description: 'Idempotency project-boundary regression', allow_self_review: true });
    expect(otherProjectResponse.status).toBe(201);
    const replayProjectId = requiredString(otherProjectResponse.json, 'project_id', 'other project');
    const crossProjectReplay = await admin.request<RecordValue>('POST', `/api/projects/${replayProjectId}/dataset-versions`, snapshotRequest);
    expect(crossProjectReplay.status).toBe(409);
    expect(record(crossProjectReplay.json, 'cross-project replay').code).toBe('IDEMPOTENCY_KEY_REUSE');
    const snapshotConflict = await admin.request<RecordValue>('POST', `/api/projects/${projectId}/dataset-versions`, { ...snapshotRequest, items: [{ ...snapshotRequest.items[0]!, split: 'val' }] });
    expect(snapshotConflict.status).toBe(409);
    expect(record(snapshot.json, 'snapshot').items).toEqual([{ asset_revision_id: assetId, annotation_revision_id: revisionId, split: 'train' }]);

    const nativeRequest = { format: 'native', loss_ack: false, operation_id: crypto.randomUUID() };
    const nativeQueued = await admin.request<RecordValue>('POST', `/api/dataset-versions/${datasetId}/exports`, nativeRequest);
    expect(nativeQueued.status, JSON.stringify(nativeQueued.json)).toBe(202);
    const nativeRetry = await admin.request<RecordValue>('POST', `/api/dataset-versions/${datasetId}/exports`, nativeRequest);
    expect(nativeRetry.status).toBe(200);
    expect(requiredString(nativeRetry.json, 'job_id', 'native retry')).toBe(requiredString(nativeQueued.json, 'job_id', 'native job'));
    const mismatch = await admin.request<RecordValue>('POST', `/api/dataset-versions/${datasetId}/exports`, { ...nativeRequest, format: 'yolo', loss_ack: true });
    expect(mismatch.status).toBe(409);
    const secondNative = await admin.request<RecordValue>('POST', `/api/dataset-versions/${datasetId}/exports`, { ...nativeRequest, operation_id: crypto.randomUUID() });
    expect(secondNative.status).toBe(202);
    const nativeDrain = await admin.request<RecordValue>('POST', '/internal/test/jobs/drain', {});
    expect(nativeDrain.status).toBe(200);
    const nativeStatus = await admin.request<RecordValue>('GET', `/api/jobs/${requiredString(nativeQueued.json, 'job_id', 'native job')}`);
    expect(nativeStatus.json.state).toBe('succeeded');
    const secondNativeStatus = await admin.request<RecordValue>('GET', `/api/jobs/${requiredString(secondNative.json, 'job_id', 'second native job')}`);
    expect(secondNativeStatus.json.state).toBe('succeeded');
    expect(record(record(secondNativeStatus.json, 'second native status').result, 'second native result').object_sha256).toBe(record(record(nativeStatus.json, 'native status').result, 'native result').object_sha256);
    const native = { json: record(nativeStatus.json, 'native status').result as RecordValue };
    const viewerName = `t27-download-${crypto.randomUUID()}`;
    const viewerPassword = `${crypto.randomUUID()}-T27-password`;
    const viewer = await admin.request<RecordValue>('POST', '/api/users', { username: viewerName, password: viewerPassword });
    expect(viewer.status).toBe(201);
    const viewerId = requiredString(viewer.json, 'user_id', 'download user');
    const member = await admin.request('POST', `/api/projects/${projectId}/members`, { user_id: viewerId, role: 'viewer' });
    expect(member.status).toBe(200);
    const login = await fetch(new URL('/api/session/login', app.base_url), { method: 'POST', headers: { origin: app.base_url, 'content-type': 'application/json' }, body: JSON.stringify({ username: viewerName, password: viewerPassword }) });
    expect(login.status).toBe(200);
    const viewerCookie = (login.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
    expect(viewerCookie).not.toBe('');
    const nativePath = requiredString(native.json, 'download_url', 'native export');
    const nativeDownload = await fetch(new URL(nativePath, app.base_url), { headers: { cookie: viewerCookie, origin: app.base_url } });

    const otherName = `t27-other-${crypto.randomUUID()}`;
    const otherPassword = `${crypto.randomUUID()}-T27-password`;
    const other = await admin.request<RecordValue>('POST', '/api/users', { username: otherName, password: otherPassword });
    expect(other.status).toBe(201);
    const otherProject = await admin.request<RecordValue>('POST', '/api/projects', { name: `T27 other ${crypto.randomUUID()}`, description: 'Cross project export denial', allow_self_review: true });
    expect(otherProject.status).toBe(201);
    const otherProjectId = requiredString(otherProject.json, 'project_id', 'other project');
    const foreignOntology = await admin.request('POST', `/api/projects/${otherProjectId}/ontologies`, ontology);
    expect(foreignOntology.status).toBe(201);
    const crossProjectSnapshot = await admin.request<RecordValue>('POST', `/api/projects/${otherProjectId}/dataset-versions`, { ...snapshotRequest, operation_id: crypto.randomUUID(), ontology_version_id: requiredString(foreignOntology.json, 'ontology_version_id', 'foreign ontology') });
    expect(crossProjectSnapshot.status).toBe(422);
    expect(record(crossProjectSnapshot.json, 'cross-project snapshot').code).toBe('SNAPSHOT_REVISION_INVALID');
    const otherMember = await admin.request('POST', `/api/projects/${otherProjectId}/members`, { user_id: requiredString(other.json, 'user_id', 'other user'), role: 'viewer' });
    expect(otherMember.status).toBe(200);
    const otherLogin = await fetch(new URL('/api/session/login', app.base_url), { method: 'POST', headers: { origin: app.base_url, 'content-type': 'application/json' }, body: JSON.stringify({ username: otherName, password: otherPassword }) });
    expect(otherLogin.status).toBe(200);
    const otherCookie = (otherLogin.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
    const deniedDownload = await fetch(new URL(nativePath, app.base_url), { headers: { cookie: otherCookie, origin: app.base_url } });
    expect(deniedDownload.status).toBe(404);
    expect(nativeDownload.status).toBe(200);
    const nativeFile = resolve(scratch, 'native.zip');
    await writeFile(nativeFile, new Uint8Array(await nativeDownload.arrayBuffer()));
    expect(createHash('sha256').update(await readFile(nativeFile)).digest('hex')).toBe(record(native.json, 'native export').object_sha256);
    const python = process.env.PYTHON ?? 'python';
    const pinnedRevision = await admin.request<RecordValue>('GET', `/api/annotation-revisions/${revisionId}`);
    expect(pinnedRevision.status).toBe(200);
    const nativeCheck = execFileSync(python, ['-c', 'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); m=json.loads(z.read(\"manifest.json\")); a=json.loads(z.read(\"annotations/\"+sys.argv[3]+\".json\")); expected=json.loads(sys.argv[4]); assert m[\"exporter_version\"]==\"t27-v1\" and m[\"params\"]=={\"format\":\"native\",\"split_seed\":None,\"split_ratios\":None}; assert m[\"items\"][0][\"annotation_revision_id\"]==sys.argv[2]; assert a==expected; assert m[\"ontology\"][\"ontology_version_id\"]==expected[\"document\"][\"ontology_version_id\"]; assert \"media/\"+sys.argv[3]+\".png\" in z.namelist(); s=z.read(\"manifest.json\").decode(); assert \"password\" not in s.lower() and \"\\\\\\\\\" not in s; print(json.dumps({\"revision\":a[\"annotation_revision_id\"],\"members\":len(z.namelist())}))', nativeFile, revisionId, assetId, JSON.stringify(pinnedRevision.json)], { encoding: 'utf8' });
    expect(JSON.parse(nativeCheck)).toMatchObject({ revision: revisionId });

    const yoloPreview = await admin.request<RecordValue>('POST', `/api/dataset-versions/${datasetId}/exports`, { format: 'yolo', loss_ack: false, operation_id: crypto.randomUUID() });
    expect(yoloPreview.status).toBe(422);
    expect(record(yoloPreview.json, 'loss acknowledgement').code).toBe('LOSS_ACK_REQUIRED');
    const lossReport = record(yoloPreview.json, 'loss acknowledgement').loss_report;
    if (!Array.isArray(record(lossReport, 'loss report').losses)) throw new Error('Expected explicit detection package loss list');
    const lossFields = (record(lossReport, 'loss report').losses as unknown[]).map((loss) => requiredString(loss, 'field', 'loss item'));
    const expectedLossReport = { losses: [
      { field: 'annotation.attributes', reason: 'yolo label members omit this information for 1 frozen object; completion and approval metadata remain in manifest.json' },
      { field: 'annotation.object_ids', reason: 'yolo label members omit this information for 1 frozen object; completion and approval metadata remain in manifest.json' },
    ] };
    expect(lossReport).toEqual(expectedLossReport);
    expect(lossFields).toEqual(['annotation.attributes', 'annotation.object_ids']);
    const yoloStart = await admin.request<RecordValue>('POST', `/api/dataset-versions/${datasetId}/exports`, { format: 'yolo', loss_ack: true, operation_id: crypto.randomUUID() });
    expect(yoloStart.status).toBe(202);
    const yoloDrain = await admin.request<RecordValue>('POST', '/internal/test/jobs/drain', {});
    expect(yoloDrain.status).toBe(200);
    const yoloStatus = await admin.request<RecordValue>('GET', `/api/jobs/${requiredString(yoloStart.json, 'job_id', 'YOLO job')}`);
    expect(yoloStatus.json.state).toBe('succeeded');
    const yolo = { json: record(yoloStatus.json.result, 'YOLO result') };
    expect(record(yolo.json, 'YOLO export').loss_report).toEqual(lossReport);
    const yoloPath = requiredString(yolo.json, 'download_url', 'YOLO export');
    const yoloDownload = await fetch(new URL(yoloPath, app.base_url), { headers: { cookie: viewerCookie, origin: app.base_url } });
    expect(yoloDownload.status).toBe(200);
    const yoloFile = resolve(scratch, 'yolo.zip');
    await writeFile(yoloFile, new Uint8Array(await yoloDownload.arrayBuffer()));
    expect(createHash('sha256').update(await readFile(yoloFile)).digest('hex')).toBe(record(yolo.json, 'YOLO export').object_sha256);
    const bboxCheck = execFileSync(python, ['-c', 'import json,struct,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); ids=json.loads(z.read(\"label_ids.json\")); p=sys.argv[2]; w,h=struct.unpack(\">II\",z.read(\"images/train/\"+p+\".png\")[16:24]); fields=z.read(\"labels/train/\"+p+\".txt\").decode().split(); cls=int(fields[0]); cx,cy,bw,bh=map(float,fields[1:]); box=[(cx-bw/2)*w,(cy-bh/2)*h,(cx+bw/2)*w,(cy+bh/2)*h]; print(json.dumps({\"label_id\":ids[cls],\"bbox\":box,\"width\":w,\"height\":h}))', yoloFile, assetId], { encoding: 'utf8' });
    const roundTrip = JSON.parse(bboxCheck) as { label_id: string; bbox: number[]; width: number; height: number };
    expect(roundTrip.label_id).toBe('label_person');
    for (const [actual, expected] of roundTrip.bbox.map((value, index) => [value, [10, 5, 40, 30][index]!] as const)) expect(actual).toBeCloseTo(expected, 6);

    const cocoPreview = await admin.request<RecordValue>('POST', `/api/dataset-versions/${datasetId}/exports`, { format: 'coco', loss_ack: false, operation_id: crypto.randomUUID() });
    expect(cocoPreview.status).toBe(422);
    const cocoLossReport = { losses: [
      { field: 'annotation.attributes', reason: 'coco label members omit this information for 1 frozen object; completion and approval metadata remain in manifest.json' },
      { field: 'annotation.object_ids', reason: 'coco label members omit this information for 1 frozen object; completion and approval metadata remain in manifest.json' },
    ] };
    expect(record(cocoPreview.json, 'COCO loss preview').loss_report).toEqual(cocoLossReport);
    const cocoStart = await admin.request<RecordValue>('POST', `/api/dataset-versions/${datasetId}/exports`, { format: 'coco', loss_ack: true, operation_id: crypto.randomUUID() });
    expect(cocoStart.status).toBe(202);
    const cocoDrain = await admin.request<RecordValue>('POST', '/internal/test/jobs/drain', {});
    expect(cocoDrain.status).toBe(200);
    const cocoStatus = await admin.request<RecordValue>('GET', `/api/jobs/${requiredString(cocoStart.json, 'job_id', 'COCO job')}`);
    expect(cocoStatus.json.state).toBe('succeeded');
    const coco = record(cocoStatus.json.result, 'COCO result');
    expect(coco.loss_report).toEqual(cocoLossReport);
    const cocoDownload = await fetch(new URL(requiredString(coco, 'download_url', 'COCO export'), app.base_url), { headers: { cookie: viewerCookie, origin: app.base_url } });
    expect(cocoDownload.status).toBe(200);
    const cocoFile = resolve(scratch, 'coco.zip');
    await writeFile(cocoFile, new Uint8Array(await cocoDownload.arrayBuffer()));
    const cocoCheck = execFileSync(python, ['-c', 'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); d=json.loads(z.read(\"coco/train.json\")); m=json.loads(z.read(\"manifest.json\")); assert m[\"category_mapping\"]==[c[\"label_id\"] for c in d[\"categories\"]]; assert m[\"exporter_version\"]==\"t27-v1\" and m[\"params\"][\"format\"]==\"coco\"; a=d[\"annotations\"][0]; c=next(c for c in d[\"categories\"] if c[\"id\"]==a[\"category_id\"]); print(json.dumps({\"label_id\":c[\"label_id\"],\"bbox\":a[\"bbox\"],\"image\":d[\"images\"][0]}))', cocoFile], { encoding: 'utf8' });
    const cocoRoundTrip = JSON.parse(cocoCheck) as { label_id: string; bbox: number[]; image: RecordValue };
    expect(cocoRoundTrip.label_id).toBe('label_person');
    expect(cocoRoundTrip.bbox).toEqual([10, 5, 30, 25]);
    expect(cocoRoundTrip.image.width).toBe(48);
    expect(cocoRoundTrip.image.height).toBe(32);
    const secondAsset = await setupSecondApprovedAsset(admin, projectId, ontologyId, assetId);
    expect(secondAsset.assetId).not.toBe(assetId);
    const multiSnapshot = await admin.request<RecordValue>('POST', `/api/projects/${projectId}/dataset-versions`, {
      operation_id: crypto.randomUUID(), ontology_version_id: ontologyId,
      items: [
        { asset_revision_id: assetId, annotation_revision_id: revisionId, split: 'train' },
        { asset_revision_id: secondAsset.assetId, annotation_revision_id: secondAsset.revisionId, split: 'train' },
      ],
      excluded: [], split_seed: null, split_ratios: null,
    });
    expect(multiSnapshot.status, JSON.stringify(multiSnapshot.json)).toBe(201);
    const multiDatasetId = requiredString(multiSnapshot.json, 'dataset_version_id', 'two-image dataset');
    const multiExport = await admin.request<RecordValue>('POST', `/api/dataset-versions/${multiDatasetId}/exports`, {
      format: 'coco', loss_ack: true, operation_id: crypto.randomUUID(),
    });
    expect(multiExport.status).toBe(202);
    const multiDrain = await admin.request<RecordValue>('POST', '/internal/test/jobs/drain', {});
    expect(multiDrain.status).toBe(200);
    const multiStatus = await admin.request<RecordValue>('GET', `/api/jobs/${requiredString(multiExport.json, 'job_id', 'two-image COCO job')}`);
    expect(multiStatus.json.state).toBe('succeeded');
    const multiResult = record(multiStatus.json.result, 'two-image COCO result');
    const multiDownload = await fetch(new URL(requiredString(multiResult, 'download_url', 'two-image COCO export'), app.base_url), { headers: { cookie: viewerCookie, origin: app.base_url } });
    expect(multiDownload.status).toBe(200);
    const multiFile = resolve(scratch, 'multi-coco.zip');
    await writeFile(multiFile, new Uint8Array(await multiDownload.arrayBuffer()));
    const multiRoundTrip = execFileSync(python, ['-c', 'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); d=json.loads(z.read(\"coco/train.json\")); images=d[\"images\"]; anns=d[\"annotations\"]; cats={c[\"id\"]:c[\"label_id\"] for c in d[\"categories\"]}; assert len(images)==2 and len(anns)==2; assert len({i[\"id\"] for i in images})==2; assert len({a[\"id\"] for a in anns})==2; assert len({i[\"asset_revision_id\"] for i in images})==2; by_id={i[\"id\"]:i for i in images}; assert {a[\"image_id\"] for a in anns}==set(by_id); assert all(by_id[a[\"image_id\"]][\"file_name\"] in z.namelist() for a in anns); assert all(cats[a[\"category_id\"]]==\"label_person\" for a in anns); assert all(a[\"bbox\"]==[10.0,5.0,30.0,25.0] for a in anns); print(json.dumps({\"images\":len(images),\"annotations\":len(anns),\"image_ids\":sorted(by_id),\"annotation_ids\":sorted(a[\"id\"] for a in anns),\"asset_ids\":sorted(i[\"asset_revision_id\"] for i in images)}))', multiFile], { encoding: 'utf8' });
    const parsedMulti = JSON.parse(multiRoundTrip) as { images: number; annotations: number; image_ids: number[]; annotation_ids: number[] };
    expect(parsedMulti.images).toBe(2);
    expect(parsedMulti.annotations).toBe(2);
    expect(new Set(parsedMulti.image_ids).size).toBe(2);
    expect(new Set(parsedMulti.annotation_ids).size).toBe(2);

    const unknownDataset = await admin.request<RecordValue>('POST', `/api/dataset-versions/${crypto.randomUUID()}/exports`, { format: 'native', loss_ack: false, operation_id: crypto.randomUUID() });
    expect(unknownDataset.status).toBe(404);
    const submitR9 = await admin.request<RecordValue>('POST', `/api/tasks/${nextTaskId}/submit`, { annotation_revision_ids: [revision9] });
    expect(submitR9.status).toBe(200);
    const approveR9 = await admin.request<RecordValue>('POST', `/api/reviews/${requiredString(submitR9.json, 'review_id', 'r9 submission')}/decision`, { decision: 'approve', reason: 'T27 readiness follow-up', revision_ids: [revision9] });
    expect(approveR9.status).toBe(200);
    const confirmedNegative = { ...changedDocument, completion: 'confirmed_negative', objects: [] };
    const negativeRevision = await reviseAndApprove(admin, projectId, ontologyId, assetId, revision9, confirmedNegative);
    const negativeSnapshot = await admin.request<RecordValue>('POST', `/api/projects/${projectId}/dataset-versions`, {
      operation_id: crypto.randomUUID(), ontology_version_id: ontologyId,
      items: [{ asset_revision_id: assetId, annotation_revision_id: negativeRevision, split: 'train' }], excluded: [],
      split_seed: null, split_ratios: null,
    });
    expect(negativeSnapshot.status).toBe(201);
    expect(record(negativeSnapshot.json, 'confirmed-negative snapshot').items).toEqual([
      { asset_revision_id: assetId, annotation_revision_id: negativeRevision, split: 'train' },
    ]);
    expect(requiredString(snapshot.json, 'manifest_sha256', 'snapshot manifest')).toMatch(/^[0-9a-f]{64}$/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await app.stop();
  }
});
