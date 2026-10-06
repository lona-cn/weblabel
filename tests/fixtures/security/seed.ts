import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect } from 'vitest';
import type { ApiClient } from '../../support/app';
import { startRunBody, type Seeded, type JsonObject } from '../../support/t25-ai';
import { object, root, text, type SecurityApp } from './harness';

export const syntheticProfileId = 'profile_t29_synthetic';
export function startSecurityRun(seeded: Seeded, operationId: string, prompt: string, overrides: JsonObject = {}): JsonObject {
  return { ...startRunBody(seeded, operationId, prompt, overrides), profile_id: syntheticProfileId };
}

/** Same T25 fixture protocol; this router's own synthetic database is explicit,
 * rather than claiming the unrelated TestApp WeakMap contains this process. */
export async function seedSecurity(admin: ApiClient, app: SecurityApp): Promise<Seeded> {
  const db = new DatabaseSync(join(app.directory, 'api.sqlite'));
  try {
    db.prepare("INSERT INTO model_profiles(profile_id,provider_id,model_id,auth_kind,capabilities_json,availability,verification,runtime_version,verified_at,config_json,secret_ref,created_at) VALUES(?,'mock','T29-synthetic-model','none',?,'ready','mock_only','T29-synthetic-1',NULL,'{}',NULL,'2026-10-06T00:00:00Z')").run(syntheticProfileId, JSON.stringify({ image_input: true, tools: false, structured_output: true, bbox_output: true, attributes: true }));
  } finally { db.close(); }
  const project = await admin.request('POST', '/api/projects', { name: `T29 ${crypto.randomUUID()}`, description: 'Isolated synthetic security scene', allow_self_review: false });
  expect(project.status).toBe(201); const projectId = text(project.json, 'project_id');
  const golden = object(JSON.parse(await readFile(join(root, 'tests/fixtures/golden/ontology.json'), 'utf8')));
  const ontology = await admin.request('POST', `/api/projects/${projectId}/ontologies`, { guidelines_markdown: golden.guidelines_markdown, labels: golden.labels });
  expect(ontology.status).toBe(201); const ontologyId = text(ontology.json, 'ontology_version_id');
  const image = await readFile(join(root, 'tests/fixtures/media/orientation-1.jpg'));
  expect((await admin.upload(`/api/projects/${projectId}/assets`, image, 'synthetic-scene.jpg', crypto.randomUUID(), 'image/jpeg')).status).toBe(202);
  expect((await admin.request('POST', '/internal/test/jobs/drain', {})).status).toBe(200);
  const assets = await admin.request('GET', `/api/projects/${projectId}/assets`);
  expect(assets.status).toBe(200); const items = object(assets.json).items;
  if (!Array.isArray(items) || items.length !== 1) throw new Error('Expected one synthetic imported media revision');
  const assetRevisionId = text(items[0], 'asset_revision_id'); const canonicalSha256 = text(items[0], 'canonical_sha256');
  const head = await admin.request('GET', `/api/assets/${assetRevisionId}/annotation?ontology_version_id=${ontologyId}`);
  expect(head.status).toBe(200);
  return { projectId, ontologyId, assetRevisionId, canonicalSha256, annotationRevisionId: text(head.json, 'annotation_revision_id') };
}
