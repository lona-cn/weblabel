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

async function drainJobs(client: ApiClient): Promise<number> {
  const response = await client.request<JsonObject>('POST', '/internal/test/jobs/drain', {});
  expect(response.status, JSON.stringify(response.json)).toBe(200);
  const processed = object(response.json, 'drain').processed;
  if (typeof processed !== 'number') throw new Error('drain.processed must be numeric');
  return processed;
}

// The shared harness upload helper sends untyped blobs (application/octet-stream)
// which the media decode-header policy rejects at processing time; a browser
// file input carries the real MIME type, so this test uploads with a typed File.
interface MediaUploader {
  cookie: string;
  csrf: string;
}
async function uploaderFor(admin: ApiClient, baseUrl: string, projectId: string): Promise<MediaUploader> {
  const username = `t25-uploader-${crypto.randomUUID()}`;
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
  const body: unknown = await login.json();
  return { cookie, csrf: stringField(body, 'csrf_token', 'login') };
}

async function uploadImage(baseUrl: string, uploader: MediaUploader, projectId: string, bytes: Uint8Array<ArrayBuffer>, operationId: string) {
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

export async function seed(admin: ApiClient, app: TestApp): Promise<Seeded> {
  const baseUrl=app.base_url;
  const database=new DatabaseSync(database_path_for_test(app));
  try {
    database.prepare("INSERT INTO model_profiles(profile_id,provider_id,model_id,auth_kind,capabilities_json,availability,verification,runtime_version,verified_at,config_json,secret_ref,created_at) VALUES(?,'mock','weblabel-mock-source-v1','none',?,'ready','mock_only','builtin-mock-1',NULL,'{}',NULL,'2026-10-06T00:00:00Z')").run(MOCK_PROFILE,JSON.stringify({image_input:true,tools:false,structured_output:true,bbox_output:true,attributes:true}));
  } finally { database.close(); }
  const project = await admin.request<JsonObject>('POST', '/api/projects', {
    name: 'T25 model jobs', description: 'isolated t25 integration project', allow_self_review: false,
  });
  expect(project.status).toBe(201);
  const projectId = stringField(project.json, 'project_id', 'project');
  const ontology = await admin.request<JsonObject>('POST', `/api/projects/${projectId}/ontologies`, ontologyBody);
  expect(ontology.status).toBe(201);
  const ontologyId = stringField(ontology.json, 'ontology_version_id', 'ontology');

  const uploader = await uploaderFor(admin, baseUrl, projectId);
  const image = new Uint8Array(await readFile(new URL('../fixtures/media/orientation-1.jpg', import.meta.url)));
  const upload = await uploadImage(baseUrl, uploader, projectId, image, `t25-import-${crypto.randomUUID()}`);
  expect(upload.status).toBe(202);
  expect(await drainJobs(admin)).toBe(1);

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

