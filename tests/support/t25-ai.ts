import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { expect } from 'vitest';
import { database_path_for_test, type ApiClient, type TestApp } from './app';
export type JsonObject = Record<string, unknown>;
export function object(value: unknown, label: string): JsonObject {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label);
 // The object/array check above narrows this JSON value to a string-keyed record.
 return value as JsonObject;
}
function stringField(value: unknown, key: string, label: string): string {
 const result=object(value,label)[key]; if(typeof result !== 'string') throw new Error(label+'.'+key); return result;
}

export const MOCK_PROFILE = 'profile_mock_local';

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

export interface Seeded {
  projectId: string;
  ontologyId: string;
  assetRevisionId: string;
  annotationRevisionId: string;
  canonicalSha256: string;
}

export async function seed(admin: ApiClient, app: TestApp): Promise<Seeded> {
  const database=new DatabaseSync(database_path_for_test(app));
  try {
    // The background API worker also acquires the SQLite writer. Wait once at
    // the transaction boundary, before taking a read snapshot or inserting.
    database.exec('PRAGMA busy_timeout=1000; BEGIN IMMEDIATE');
    database.prepare("INSERT INTO model_profiles(profile_id,provider_id,model_id,auth_kind,capabilities_json,availability,verification,runtime_version,verified_at,config_json,secret_ref,created_at) VALUES(?,'mock','weblabel-mock-source-v1','none',?,'ready','mock_only','builtin-mock-1',NULL,'{}',NULL,'2026-10-06T00:00:00Z')").run(MOCK_PROFILE,JSON.stringify({image_input:true,tools:false,structured_output:true,bbox_output:true,attributes:true}));
    database.exec('COMMIT');
  } finally { database.close(); }
  const project = await admin.request<JsonObject>('POST', '/api/projects', {
    name: 'T25 model jobs', description: 'isolated t25 integration project', allow_self_review: false,
  });
  expect(project.status).toBe(201);
  const projectId = stringField(project.json, 'project_id', 'project');
  const ontology = await admin.request<JsonObject>('POST', `/api/projects/${projectId}/ontologies`, ontologyBody);
  expect(ontology.status).toBe(201);
  const ontologyId = stringField(ontology.json, 'ontology_version_id', 'ontology');

  // Media setup is not an uploader-identity test; reuse the authenticated
  // bootstrap client and the shared typed-upload implementation.
  const image = new Uint8Array(await readFile(new URL('../fixtures/media/orientation-1.jpg', import.meta.url)));
  const upload = await admin.upload<JsonObject>(`/api/projects/${projectId}/assets`, image, 'orientation-1.jpg', `t25-import-${crypto.randomUUID()}`, 'image/jpeg');
  expect(upload.status).toBe(202);
  const importJobId = stringField(upload.json, 'import_job_id', 'upload');
  // A background fixture can already own this job. Read its completion rather
  // than requiring this fixture to win the worker lease.
  let importJob: JsonObject = {};
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await admin.request<JsonObject>('GET', `/api/jobs/${importJobId}`);
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    importJob = response.json;
    if (['failed', 'cancelled', 'interrupted'].includes(String(importJob.state))) {
      throw new Error(`Fixture image import failed: ${JSON.stringify(importJob)}`);
    }
    if (importJob.state === 'succeeded') break;
    const delay = Promise.withResolvers<void>();
    setTimeout(delay.resolve, 50);
    await delay.promise;
  }
  expect(importJob.state, JSON.stringify(importJob)).toBe('succeeded');
  expect(importJob).toMatchObject({ job_id: importJobId, kind: 'media_import', progress_completed: 1, progress_total: 1 });

  const listed = await admin.request<JsonObject>('GET', `/api/projects/${projectId}/assets`);
  expect(listed.status).toBe(200);
  const items = object(listed.json, 'assets').items;
  if (!Array.isArray(items)) throw new Error('asset items must be an array');
  expect(items).toHaveLength(1);
  const assetRevisionId = stringField(items[0], 'asset_revision_id', 'asset');
  const canonicalSha256 = stringField(items[0], 'canonical_sha256', 'asset');

  const annotation = await admin.request<JsonObject>('GET', `/api/assets/${assetRevisionId}/annotation?ontology_version_id=${ontologyId}`);
  expect(annotation.status).toBe(200);
  const annotationRevisionId = stringField(annotation.json, 'annotation_revision_id', 'annotation');
  return { projectId, ontologyId, assetRevisionId, annotationRevisionId, canonicalSha256 };
}

export async function authorize(admin:ApiClient,body:JsonObject):Promise<JsonObject> {
  const preview=await admin.request<JsonObject>('POST','/api/ai/previews',{request:body,grants:{allow_image:true,allow_object_context:true,preview_crop:null}});
  expect(preview.status,JSON.stringify(preview.json)).toBe(201);
  const consent=await admin.request<JsonObject>('POST','/api/ai/consents',{preview_id:preview.json.preview_id});
  expect(consent.status,JSON.stringify(consent.json)).toBe(201);
  return {...object(preview.json.request,'preview.request'),consent_id:consent.json.consent_id};
}

export function startRunBody(seeded: Seeded, operationId: string, prompt: string, overrides: JsonObject = {}): JsonObject {
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
      input_fingerprint: 't25-ts-fingerprint-0001',
    },
    intent: 'find_issues',
    prompt,
    consent_id: null,
    ...overrides,
  };
}

