import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import sharp from 'sharp';
import type { ApiClient, TestApp } from './app';
// Explicit runtime URL works with Node's native TS stripping; erased type imports
// retain the existing Bundler/noEmit TypeScript convention without changing config.
const { bootstrap_admin_for_test, download_for_test, login_at_origin_for_test } = await import(new URL('./app.ts', import.meta.url).href) as typeof import('./app');

type Json = Record<string, any>;
export type DatasetFormat = 'native' | 'yolo' | 'coco';
export type DatasetSplit = 'train' | 'val' | 'test';
export interface ExpectedAsset { media: Json; revision: Json; review: Json; split: DatasetSplit; originalBase64: string; canonicalBase64: string; pixelsSha256: string; width: number; height: number }
export interface DeliveryFixture { admin: ApiClient; annotator: ApiClient; reviewer: ApiClient; annotatorId: string; reviewerId: string; projectId: string; ontologyId: string; ontology: Json; assets: ExpectedAsset[] }
export interface FrozenDelivery { fixture: DeliveryFixture; datasetId: string; snapshotHash: string; request: Json; expected: ExpectedAsset[]; excluded: Json[] }
export interface DeliveryReceipt { format: DatasetFormat; datasetId: string; jobId: string; archiveSha256: string; memberCount: number; assetCount: number; objectCount: number; negativeCount: number; lossReport: Json; pixelChecks: number }
interface MediaImportAccepted { import_job_id: string; duplicate: boolean }
interface MediaImportResult { succeeded: number; failed: number; items: { item_index: number; state: string; asset_id: string; asset_revision_id: string; error: string | null; error_code: string | null }[] }
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function api(client: ApiClient, method: string, path: string, body?: unknown, status = 200): Promise<Json> {
  const response = await client.request<Json>(method, path, body);
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(response.json)}`);
  return response.json;
}
async function bounded<T>(count: number, concurrency: number, run: (index: number) => Promise<T>): Promise<T[]> {
  assert(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 8);
  const result: T[] = new Array(count); let next = 0;
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, async () => { while (next < count) { const index = next++; result[index] = await run(index); } }));
  return result;
}
export async function pollDeliveryJob<T extends object = Json>(client: ApiClient, jobId: string, timeoutMs = 180_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await api(client, 'GET', `/api/jobs/${jobId}`);
    if (job.state === 'succeeded') return job.result as T;
    assert(!['failed', 'cancelled'].includes(job.state), `Background job ${jobId}: ${JSON.stringify(job)}`);
    const pause = Promise.withResolvers<void>(); setTimeout(pause.resolve, 50); await pause.promise;
  }
  throw new Error(`Background job ${jobId} timed out`);
}
export async function listDeliveryMedia(client: ApiClient, projectId: string): Promise<Json[]> {
  const result: Json[] = []; const cursors = new Set<string>(); let cursor: string | null = null;
  do {
    const page = await api(client, 'GET', `/api/projects/${projectId}/assets?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    assert(Array.isArray(page.items)); result.push(...page.items); cursor = page.next_cursor;
    if (cursor) { assert(!cursors.has(cursor), 'Media cursor cycle'); cursors.add(cursor); }
  } while (cursor);
  assert.equal(new Set(result.map(item => item.asset_revision_id)).size, result.length);
  return result;
}
export async function createDeliveryFixture(app: TestApp | { base_url: string; admin: ApiClient }, count: number, concurrency = 4): Promise<DeliveryFixture> {
  assert(Number.isInteger(count) && count > 0);
  const admin = 'admin' in app ? app.admin : await bootstrap_admin_for_test(app);
  const users: ApiClient[] = [];
  for (let i = 0; i < 2; i++) {
    const username = 'delivery-' + randomUUID(); const password = randomUUID() + randomUUID();
    await api(admin, 'POST', '/api/users', { username, password }, 201);
    users.push(await login_at_origin_for_test(app.base_url, { username, password }));
  }
  const annotator = users[0]!; const reviewer = users[1]!;
  const annotatorId = (await api(annotator, 'GET', '/api/session')).user_id;
  const reviewerId = (await api(reviewer, 'GET', '/api/session')).user_id;
  assert.notEqual(annotatorId, reviewerId);
  const projectId = (await api(admin, 'POST', '/api/projects', { name: `Delivery ${randomUUID()}`, description: 'Independent immutable dataset fixture', allow_self_review: false }, 201)).project_id;
  for (const [user_id, role] of [[annotatorId, 'annotator'], [reviewerId, 'reviewer']]) await api(admin, 'POST', `/api/projects/${projectId}/members`, { user_id, role });
  const label = (label_id: string, name: string, color: string) => ({ label_id, name, color, shortcut: null, allowed_geometry_types: ['bbox_xyxy'], attributes: [{ key: 'state', kind: 'enum', required: false, default_value: 'unknown', enum_values: ['present', 'absent', 'unknown'], min: null, max: null }, { key: 'quality', kind: 'enum', required: false, default_value: 'clear', enum_values: ['clear', 'occluded'], min: null, max: null }] });
  const ontologyId = (await api(admin, 'POST', `/api/projects/${projectId}/ontologies`, { guidelines_markdown: 'Delivery fixture', labels: [label('z_person', 'Person', '#0099ff'), label('a_animal', 'Animal', '#33aa55'), label('m_vehicle', 'Vehicle', '#ff9933')] }, 201)).ontology_version_id;
  const ontology = (await api(admin, 'GET', `/api/projects/${projectId}/ontologies`)).items.find((item: Json) => item.ontology_version_id === ontologyId);
  assert(ontology);
  const originals = await bounded(count, concurrency, async index => {
    const width = 48 + index % 13; const height = 40 + index % 11;
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const p = (y * width + x) * 4; pixels[p] = (x * 7 + index * 17) % 256; pixels[p + 1] = (y * 11 + index * 29) % 256; pixels[p + 2] = (x + y * 3 + index * 43) % 256; pixels[p + 3] = 255; }
    const original = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const uploaded = await admin.upload<MediaImportAccepted>('/api/projects/' + projectId + '/assets', original, 'delivery-' + index + '.png', randomUUID(), 'image/png');
    assert.equal(uploaded.status, 202, JSON.stringify(uploaded.json));
    assert.equal(typeof uploaded.json.import_job_id, 'string'); assert(uploaded.json.import_job_id.length > 0); assert.equal(uploaded.json.duplicate, false);
    const result = await pollDeliveryJob<MediaImportResult>(admin, uploaded.json.import_job_id);
    assert.equal(result.failed, 0); assert.equal(result.succeeded, 1); assert.equal(result.items.length, 1);
    const acceptedItem = result.items[0]!;
    assert.equal(acceptedItem.item_index, 0); assert.equal(acceptedItem.state, 'succeeded'); assert.equal(acceptedItem.error, null); assert.equal(acceptedItem.error_code, null);
    assert.equal(typeof acceptedItem.asset_revision_id, 'string'); assert(acceptedItem.asset_revision_id.length > 0); assert.equal(typeof acceptedItem.asset_id, 'string'); assert(acceptedItem.asset_id.length > 0);
    return { assetId: acceptedItem.asset_revision_id, original, pixels, width, height, index };
  });
  const media = await listDeliveryMedia(admin, projectId); assert.equal(media.length, count);
  const fixture: DeliveryFixture = { admin, annotator, reviewer, annotatorId, reviewerId, projectId, ontologyId, ontology, assets: [] };
  fixture.assets = await bounded(count, concurrency, async index => {
    const source = originals[index]!; const assetId = source.assetId;
    const metadata = media.find(item => item.asset_revision_id === assetId); assert(metadata);
    const head = await api(annotator, 'GET', `/api/assets/${assetId}/annotation?ontology_version_id=${ontologyId}`);
    const objects = index % 5 === 0 ? [] : Array.from({ length: 1 + index % 2 }, (_, j) => ({ object_id: 'delivery-' + index + '-' + j, label_id: ontology.labels[(index + j) % 3].label_id, geometry: { type: 'bbox_xyxy', x_min: 1.25 + j + index % 7, y_min: 2.5 + j, x_max: 19.75 + index % 9 + j, y_max: 25.25 + index % 5 + j }, attributes: { state: index % 2 ? 'present' : 'absent', quality: j ? 'occluded' : 'clear' }, origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null } }));
    const document = { ...head.document, completion: objects.length ? 'complete' : 'confirmed_negative', objects };
    const { revisionId, taskId } = await saveDeliveryRevision(fixture, assetId, head.annotation_revision_id, document);
    const review = await approveDeliveryRevision(fixture, assetId, revisionId, taskId);
    // Every oracle value is captured before freeze, from exact immutable endpoints or original upload bytes.
    const revision = await api(admin, 'GET', `/api/annotation-revisions/${revisionId}`);
    assert.deepEqual(revision.document, document); assert.equal(revision.parent_revision_id, head.annotation_revision_id); assert.match(revision.content_hash, /^[a-f0-9]{64}$/);
    const canonical = await download_for_test(admin, `/api/assets/${assetId}/image`); assert.equal(canonical.status, 200);
    assert.equal(hash(source.original), metadata.original_sha256); assert.equal(hash(canonical.bytes), metadata.canonical_sha256);
    const decoded = await sharp(canonical.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(decoded.info.width, source.width); assert.equal(decoded.info.height, source.height); assert.deepEqual(decoded.data, source.pixels);
    return { media: metadata, revision, review, split: (['train', 'val', 'test'] as const)[index % 3]!, originalBase64: source.original.toString('base64'), canonicalBase64: Buffer.from(canonical.bytes).toString('base64'), pixelsSha256: hash(decoded.data), width: source.width, height: source.height };
  });
  return fixture;
}
async function taskLease(fixture: DeliveryFixture, assetId: string): Promise<Json> {
  const task = await api(fixture.admin, 'POST', `/api/projects/${fixture.projectId}/tasks`, { asset_revision_id: assetId, ontology_version_id: fixture.ontologyId, assignee_id: fixture.annotatorId });
  const lease = await api(fixture.annotator, 'POST', `/api/tasks/${task.task_id}/lease`, { action: 'acquire' });
  return { task_id: task.task_id, fencing_token: lease.fencing_token };
}
async function saveDeliveryRevision(fixture: DeliveryFixture, assetId: string, base: string, document: Json): Promise<{ revisionId: string; taskId: string }> {
  const lease = await taskLease(fixture, assetId);
  const saved = await api(fixture.annotator, 'PUT', `/api/assets/${assetId}/annotation`, { operation_id: randomUUID(), base_revision_id: base, document, lease, suggestion_decisions: [] });
  return { revisionId: saved.revision.annotation_revision_id, taskId: lease.task_id };
}
async function approveDeliveryRevision(fixture: DeliveryFixture, assetId: string, revisionId: string, taskId: string): Promise<Json> {
  const submitted = await api(fixture.annotator, 'POST', '/api/tasks/' + taskId + '/submit', { annotation_revision_ids: [revisionId] });
  return api(fixture.reviewer, 'POST', `/api/reviews/${submitted.review_id}/decision`, { decision: 'approve', reason: `Independent approval ${assetId}`, revision_ids: [revisionId] });
}
export async function freezeDelivery(fixture: DeliveryFixture, indices: number[], excludedIndices: number[] = []): Promise<FrozenDelivery> {
  const expected = indices.map(index => structuredClone(fixture.assets[index]!));
  const excluded = excludedIndices.map(index => ({ asset_revision_id: fixture.assets[index]!.media.asset_revision_id, reason: 'Explicitly excluded fixture asset' }));
  const request = { operation_id: randomUUID(), ontology_version_id: fixture.ontologyId, items: expected.map(item => ({ asset_revision_id: item.media.asset_revision_id, annotation_revision_id: item.revision.annotation_revision_id, split: item.split })), excluded, split_seed: null, split_ratios: null };
  const snapshot = await api(fixture.admin, 'POST', `/api/projects/${fixture.projectId}/dataset-versions`, request, 201);
  assert.deepEqual(snapshot.items, request.items); assert.deepEqual(snapshot.excluded, excluded);
  return { fixture, datasetId: snapshot.dataset_version_id, snapshotHash: snapshot.manifest_sha256, request, expected, excluded };
}
export async function mutateDeliveryHead(fixture: DeliveryFixture, index = 1): Promise<string> {
  const item = fixture.assets[index]!; const document = structuredClone(item.revision.document);
  document.objects = []; document.completion = 'confirmed_negative';
  if (item.revision.document.objects.length === 0) { document.completion = 'complete'; document.objects = [{ object_id: 'post-freeze', label_id: fixture.ontology.labels[0].label_id, geometry: { type: 'bbox_xyxy', x_min: 1, y_min: 1, x_max: 10, y_max: 10 }, attributes: { state: 'unknown' }, origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null } }]; }
  const { revisionId } = await saveDeliveryRevision(fixture, item.media.asset_revision_id, item.revision.annotation_revision_id, document);
  assert.notEqual(revisionId, item.revision.annotation_revision_id);
  return revisionId;
}

// Python's stdlib ZIP parser is deliberately independent of the Rust ZIP and format readers.
// YOLO emits roundtrippable f64 decimals; 1e-12 normalized absolute tolerance permits
// floating point rounding without concealing a pixel-scale geometry error.
const independentParser = String.raw`
import base64,hashlib,json,math,pathlib,sys,zipfile
expected=json.loads(pathlib.Path(sys.argv[2]).read_text(encoding='utf-8'))
z=zipfile.ZipFile(sys.argv[1]); names=z.namelist(); assert len(names)==len(set(names)), 'duplicate ZIP members'
def digest(b): return hashlib.sha256(b).hexdigest()
def doc(n): return json.loads(z.read(n))
f=expected['format']; assets=expected['assets']; ontology=expected['ontology']; labels=ontology['labels']
ids=[x['label_id'] for x in labels]; mapping=sorted(ids) if f=='coco' else ids
members={'manifest.json'}
for a in assets:
 id=a['media']['asset_revision_id']; split=a['split']
 if f=='native': members.update(['media/'+id+'.png','original/'+id+'.bin','annotations/'+id+'.json'])
 else:
  members.add('images/'+split+'/'+id+'.png')
  if f=='yolo': members.add('labels/'+split+'/'+id+'.txt')
if f=='yolo': members.add('label_ids.json')
if f=='coco': members.update('coco/'+s+'.json' for s in ['train','val','test'])
assert set(names)==members, 'missing or extra members'
m=doc('manifest.json'); assert m['dataset_version_id']==expected['datasetId'] and m['project_id']==expected['projectId']
assert m['snapshot_manifest_sha256']==expected['snapshotHash']; assert m['ontology']==ontology and m['category_mapping']==mapping
assert m['excluded']==expected['excluded']; assert m['params']=={'format':f,'split_seed':None,'split_ratios':None}
assert m['schema_version']==1 and m['exporter_version']=='t27-v1'; assert m['loss_report']==expected['lossReport']
items=m['items']; assert len(items)==len(assets); by_id={i['asset_revision_id']:i for i in items}; assert len(by_id)==len(items)
assert set(by_id)=={a['media']['asset_revision_id'] for a in assets}; groups={}; pixel_paths=[]
for a in assets:
 media=a['media']; r=a['revision']; review=a['review']; id=media['asset_revision_id']; i=by_id[id]
 assert i['media_revision']==media
 for key,value in {'annotation_revision_id':r['annotation_revision_id'],'annotation_content_hash':r['content_hash'],'split':a['split'],'completion':r['document']['completion'],'review_id':review['review_id'],'reviewed_by':review['decided_by'],'review_reason':review['reason'],'reviewed_at':review['created_at'],'original_name':media['original_name'],'original_sha256':media['original_sha256'],'original_object_sha256':media['original_sha256'],'canonical_sha256':media['canonical_sha256']}.items(): assert i[key]==value,(id,key)
 assert i['review_status']=='approved' and review['decision']=='approve' and review['revision_ids']==[r['annotation_revision_id']]
 group=media['source_group_id']; assert groups.setdefault(group,a['split'])==a['split']
 path=('media/'+id+'.png') if f=='native' else ('images/'+a['split']+'/'+id+'.png')
 data=z.read(path); assert data==base64.b64decode(a['canonicalBase64']) and digest(data)==media['canonical_sha256']
 target=pathlib.Path(sys.argv[3])/('pixels-'+id+'.png'); target.write_bytes(data); pixel_paths.append({'path':str(target),'hash':a['pixelsSha256'],'width':a['width'],'height':a['height']})
 if f=='native':
  assert z.read('original/'+id+'.bin')==base64.b64decode(a['originalBase64']); assert digest(z.read('original/'+id+'.bin'))==media['original_sha256']; assert doc('annotations/'+id+'.json')==r
 if f=='yolo':
  assert doc('label_ids.json')==ids
  rows=z.read('labels/'+a['split']+'/'+id+'.txt').decode().splitlines(); objects=r['document']['objects']; assert len(rows)==len(objects)
  for row,o in zip(rows,objects):
   fields=row.split(); assert len(fields)==5 and fields[0].isdigit(); cls=int(fields[0]); assert 0<=cls<len(ids) and ids[cls]==o['label_id']
   actual=list(map(float,fields[1:])); assert all(math.isfinite(v) for v in actual)
   b=o['geometry']; w=a['width']; h=a['height']; wanted=[(b['x_min']+b['x_max'])/(2*w),(b['y_min']+b['y_max'])/(2*h),(b['x_max']-b['x_min'])/w,(b['y_max']-b['y_min'])/h]
   assert all(abs(x-y)<=1e-12 for x,y in zip(actual,wanted))
 if r['document']['completion']=='confirmed_negative': assert not r['document']['objects']
objects=sum(len(a['revision']['document']['objects']) for a in assets)
assert m['statistics']=={'asset_count':len(assets),'object_count':objects,'splits':{s:sum(a['split']==s for a in assets) for s in ['train','val','test']}}
if f=='coco':
 cats=[{'id':j+1,'name':next(l['name'] for l in labels if l['label_id']==id),'label_id':id} for j,id in enumerate(mapping)]
 image_ids=set(); annotation_ids=set(); observed_assets=set()
 for split in ['train','val','test']:
  d=doc('coco/'+split+'.json'); assert d['categories']==cats; local={}
  for image in d['images']:
   id=image['asset_revision_id']; a=next(a for a in assets if a['media']['asset_revision_id']==id); assert a['split']==split
   assert type(image['id']) is int and image['id']>0 and image['id'] not in image_ids and id not in observed_assets; image_ids.add(image['id']); observed_assets.add(id); local[image['id']]=a
   assert image['file_name']=='images/'+split+'/'+id+'.png' and image['split']==split and image['width']==a['width'] and image['height']==a['height']
  observed={key:[] for key in local}
  for ann in d['annotations']:
   assert type(ann['id']) is int and ann['id']>0 and ann['id'] not in annotation_ids and type(ann['image_id']) is int and ann['image_id'] in local; annotation_ids.add(ann['id']); assert type(ann['category_id']) is int and ann['category_id'] in range(1,len(cats)+1)
   assert set(ann)=={'id','image_id','category_id','bbox','area','iscrowd'} and ann['iscrowd']==0
   assert len(ann['bbox'])==4 and all(math.isfinite(v) for v in ann['bbox']) and math.isfinite(ann['area'])
   observed[ann['image_id']].append((mapping[ann['category_id']-1],ann['bbox'],ann['area']))
  for image_id,a in local.items():
   wanted=[]
   for o in a['revision']['document']['objects']:
    b=o['geometry']; box=[b['x_min'],b['y_min'],b['x_max']-b['x_min'],b['y_max']-b['y_min']]; wanted.append((o['label_id'],box,box[2]*box[3]))
   assert observed[image_id]==wanted
 assert observed_assets==set(by_id) and len(annotation_ids)==objects
print(json.dumps({'memberCount':len(names),'assetCount':len(assets),'objectCount':objects,'negativeCount':sum(a['revision']['document']['completion']=='confirmed_negative' for a in assets),'pixels':pixel_paths}))
`;
export async function verifyDeliveryArchive(frozen: FrozenDelivery, format: DatasetFormat, bytes: Uint8Array, result: Json, lossReport: Json): Promise<DeliveryReceipt> {
  const archiveSha256 = hash(bytes); assert.equal(archiveSha256, result.object_sha256); assert.equal(bytes.byteLength, result.byte_size); assert.deepEqual(result.loss_report, lossReport);
  const scratch = await mkdtemp(resolve(tmpdir(), 'weblabel-delivery-oracle-'));
  try {
    const archive = resolve(scratch, 'archive.zip'); const expectedFile = resolve(scratch, 'expected.json'); const parserFile = resolve(scratch, 'parse.py');
    await writeFile(archive, bytes);
    await writeFile(expectedFile, JSON.stringify({ format, datasetId: frozen.datasetId, projectId: frozen.fixture.projectId, snapshotHash: frozen.snapshotHash, ontology: frozen.fixture.ontology, assets: frozen.expected, excluded: frozen.excluded, lossReport }));
    await writeFile(parserFile, independentParser);
    const parsed = JSON.parse(execFileSync(process.env.PYTHON ?? 'python', [parserFile, archive, expectedFile, scratch], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })) as { memberCount: number; assetCount: number; objectCount: number; negativeCount: number; pixels: { path: string; hash: string; width: number; height: number }[] };
    for (const pixel of parsed.pixels) { const decoded = await sharp(await readFile(pixel.path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); assert.equal(decoded.info.width, pixel.width); assert.equal(decoded.info.height, pixel.height); assert.equal(hash(decoded.data), pixel.hash); }
    return { format, datasetId: frozen.datasetId, jobId: result.export_id, archiveSha256, memberCount: parsed.memberCount, assetCount: parsed.assetCount, objectCount: parsed.objectCount, negativeCount: parsed.negativeCount, lossReport, pixelChecks: parsed.pixels.length };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
export async function exportAndVerifyDelivery(frozen: FrozenDelivery, format: DatasetFormat): Promise<DeliveryReceipt> {
  const client = frozen.fixture.admin; const path = `/api/dataset-versions/${frozen.datasetId}/exports`;
  const preview = await client.request<Json>('POST', path, { format, loss_ack: false, operation_id: randomUUID() });
  let lossReport: Json; let started: Json;
  if (format === 'native') { assert.equal(preview.status, 202); started = preview.json; lossReport = started.loss_report; assert.deepEqual(lossReport, { losses: [] }); }
  else {
    assert.equal(preview.status, 422, JSON.stringify(preview.json)); assert.equal(preview.json.code, 'LOSS_ACK_REQUIRED'); assert.equal(typeof preview.json.request_id, 'string'); assert(!Object.hasOwn(preview.json, 'loss_report'));
    lossReport = preview.json.details.loss_report;
    assert.deepEqual(lossReport.losses.map((loss: Json) => loss.field), ['annotation.attributes', 'annotation.object_ids']);
    for (const loss of lossReport.losses) assert(typeof loss.reason === 'string' && loss.reason.trim().length > 0);
    started = await api(client, 'POST', path, { format, loss_ack: true, operation_id: randomUUID() }, 202); assert.deepEqual(started.loss_report, lossReport);
  }
  const result = await pollDeliveryJob(client, started.job_id);
  const download = await download_for_test(client, result.download_url); assert.equal(download.status, 200); assert.match(download.headers.get('content-type') ?? '', /application\/zip/);
  const receipt = await verifyDeliveryArchive(frozen, format, download.bytes, result, lossReport); receipt.jobId = started.job_id; return receipt;
}
