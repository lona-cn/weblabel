import { readFile } from 'node:fs/promises';

import { expect, it } from 'vitest';
import { bootstrap_admin_for_test, relogin_bootstrap_admin_for_test, replay_bootstrap_code_for_test, start_test_app, type ApiClient } from '../support/app';

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  expect(value).toEqual(expect.objectContaining({}));
  return value as JsonObject;
}
function stringField(value: unknown, key: string): string {
  const field = object(value)[key];
  expect(typeof field).toBe('string');
  return field as string;
}

const ontology = (labelId: string) => ({
  guidelines_markdown: `Revision for ${labelId}`,
  labels: [{
    label_id: labelId,
    name: 'Vehicle',
    color: '#224466',
    shortcut: null,
    allowed_geometry_types: ['bbox_xyxy'],
    attributes: [],
  }],
});

async function makeProject(client: ApiClient, name: string): Promise<string> {
  const response = await client.request<JsonObject>('POST', '/api/projects', {
    name, description: 'isolated auth test project', allow_self_review: false,
  });
  expect(response.status).toBe(201);
  return stringField(response.json, 'project_id');
}

it('rejects project access without a session and rejects untrusted browser origins', async () => {
  const app = await start_test_app();
  try {
    const noSession = await fetch(`${app.base_url}/api/projects`);
    expect(noSession.status).toBe(401);
    const wrongOrigin = await fetch(`${app.base_url}/api/session/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://attacker.invalid' },
      body: JSON.stringify({ username: 'nobody', password: 'not-a-password' }),
    });
    expect(wrongOrigin.status).toBe(403);
    await app.as_user('admin');
    expect(await replay_bootstrap_code_for_test(app)).toBe(409);
  } finally { await app.stop(); }
});

it('enforces viewer read-only policy, project isolation and immutable ontology publication', async () => {
  const app = await start_test_app();
  try {
    const viewer = await app.as_user('viewer');
    const admin = await app.as_user('admin');
    const viewerProjects = await viewer.request<JsonObject>('GET', '/api/projects');
    const viewerProject = object(viewerProjects.json).items as JsonObject[];
    expect(viewerProject).toHaveLength(1);
    const viewerProjectId = stringField(viewerProject[0], 'project_id');
    const deniedPublish = await viewer.request('POST', `/api/projects/${viewerProjectId}/ontologies`, ontology('label_viewer'));
    expect(deniedPublish.status).toBe(403);
    const deniedMembership = await viewer.request('POST', `/api/projects/${viewerProjectId}/members`, { user_id: 'missing-user', role: 'annotator' });
    expect(deniedMembership.status).toBe(403);
    const deniedUserList = await viewer.request('GET', '/api/users');
    expect(deniedUserList.status).toBe(403);
    const deniedUserCreate = await viewer.request('POST', '/api/users', { username: 'not-admin', password: 'long-enough-test-password' });
    expect(deniedUserCreate.status).toBe(403);

    const adminProjectId = await makeProject(admin, 'T10 ontology immutability');
    const first = await admin.request<JsonObject>('POST', `/api/projects/${adminProjectId}/ontologies`, ontology('label_vehicle'));
    const second = await admin.request<JsonObject>('POST', `/api/projects/${adminProjectId}/ontologies`, ontology('label_vehicle'));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(stringField(first.json, 'ontology_version_id')).not.toBe(stringField(second.json, 'ontology_version_id'));
    expect(object(first.json).version_no).toBe(1);
    expect(object(second.json).version_no).toBe(2);
    expect(object(first.json).labels).toEqual(ontology('label_vehicle').labels);

    const allVersions = await admin.request<JsonObject>('GET', `/api/projects/${adminProjectId}/ontologies`);
    expect((object(allVersions.json).items as JsonObject[]).map(item => item.ontology_version_id)).toEqual([
      stringField(second.json, 'ontology_version_id'), stringField(first.json, 'ontology_version_id'),
    ]);
    const foreignRead = await viewer.request('GET', `/api/projects/${adminProjectId}/ontologies`);
    expect(foreignRead.status).toBe(404);
    const invalidDefinition = await admin.request('POST', `/api/projects/${adminProjectId}/ontologies`, {
      guidelines_markdown: '', labels: [{ ...ontology('label_unknown').labels[0], label_id: '' }],
    });
    expect(invalidDefinition.status).toBe(422);
  } finally { await app.stop(); }
});

it('authorizes media routes and replays an import idempotently', async () => {
  const app = await start_test_app();
  try {
    const admin = await app.as_user('admin');
    const viewer = await app.as_user('viewer');
    const projectResponse = await admin.request<JsonObject>('GET', '/api/projects');
    const adminProject = object(projectResponse.json).items as JsonObject[];
    const projectId = stringField(adminProject[0], 'project_id');
    const published = await admin.request('POST', `/api/projects/${projectId}/ontologies`, ontology('label_media'));
    expect(published.status).toBe(201);
    const image = new Uint8Array(await readFile(new URL('../fixtures/media/orientation-6.jpg', import.meta.url)));
    const assetsPath = `/api/projects/${projectId}/assets`;
    const first = await admin.upload(assetsPath, image, 'orientation-6.jpg', 'same-upload-operation');
    const second = await admin.upload(assetsPath, image, 'orientation-6.jpg', 'same-upload-operation');
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(stringField(first.json, 'import_job_id')).toBe(stringField(second.json, 'import_job_id'));
    expect(object(second.json).duplicate).toBe(true);

    const listed = await admin.request<JsonObject>('GET', assetsPath);
    expect(listed.status).toBe(200);
    expect(object(listed.json).items).toEqual([]);
    const unauthenticated = await fetch(new URL(assetsPath, app.base_url));
    expect(unauthenticated.status).toBe(401);
    const hiddenList = await viewer.request('GET', assetsPath);
    expect(hiddenList.status).toBe(404);
    const viewerProjects = object((await viewer.request<JsonObject>('GET', '/api/projects')).json).items as JsonObject[];
    const viewerProjectId = stringField(viewerProjects[0], 'project_id');
    const deniedWrite = await viewer.upload(`/api/projects/${viewerProjectId}/assets`, image, 'orientation-6.jpg', 'viewer-write');
    expect(deniedWrite.status).toBe(403);
    const deniedCrossProjectUpload = await viewer.upload(assetsPath, image, 'orientation-6.jpg', 'viewer-cross-project');
    expect(deniedCrossProjectUpload.status).toBe(404);
  } finally { await app.stop(); }
});

it('returns no password hashes from administrator user listing and revokes logout sessions', async () => {
  const app = await start_test_app();
  try {
    const platformAdmin = await bootstrap_admin_for_test(app);
    const admin = await app.as_user('admin');
    const created = await platformAdmin.request<JsonObject>('POST', '/api/users', {
      username: `t10-${crypto.randomUUID()}`, password: crypto.randomUUID() + crypto.randomUUID(),
    });
    expect(created.status).toBe(201);
    const listing = await platformAdmin.request<JsonObject>('GET', '/api/users');
    expect(listing.status).toBe(200);
    const listed = object(listing.json).items as JsonObject[];
    expect(listed.some(user => user.user_id === object(created.json).user_id)).toBe(true);
    expect(listed.every(user => typeof user.created_at === 'string' && /^\d{4}-\d{2}-\d{2}T.+Z$/.test(user.created_at as string))).toBe(true);
    expect(listed.every(user => !Object.hasOwn(user, 'password_hash'))).toBe(true);
    const bootstrapSession = await platformAdmin.request<JsonObject>('GET', '/api/session');
    expect(object(bootstrapSession.json).username).toBe('local-admin');
    expect(stringField(bootstrapSession.json, 'user_id')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    const bootstrapLogout = await platformAdmin.request('POST', '/api/session/logout');
    expect(bootstrapLogout.status).toBe(204);
    const recoveredAdmin = await relogin_bootstrap_admin_for_test(app);
    expect((await recoveredAdmin.request('GET', '/api/users')).status).toBe(200);
    const session = await admin.request<JsonObject>('GET', '/api/session');
    const roles = object(session.json).project_roles as JsonObject[];
    expect(roles).toHaveLength(1);
    expect(roles[0].role).toBe('admin');
    const logout = await admin.request('POST', '/api/session/logout');
    expect(logout.status).toBe(204);
    const clearCookie = logout.headers.get('set-cookie') ?? '';
    expect(clearCookie).toContain('HttpOnly');
    expect(clearCookie).toContain('SameSite=Strict');
    expect(clearCookie).not.toContain('Secure');
    const afterLogout = await admin.request('GET', '/api/projects');
    expect(afterLogout.status).toBe(401);
 
  } finally { await app.stop(); }
});

it('sets Secure on session cookies when explicitly configured', async () => {
  const app = await start_test_app('true');
  try {
    const user = await app.as_user('viewer');
    const session = await user.request('GET', '/api/session');
    expect(session.status).toBe(200);
  } finally { await app.stop(); }
});

it('rate-limits repeated failed local login attempts without case-folding identities', async () => {
  const app = await start_test_app();
  try {
    const admin = await bootstrap_admin_for_test(app);
    const username = 'rate-limit-account';
    const created = await admin.request('POST', '/api/users', {
      username, password: `${crypto.randomUUID()}${crypto.randomUUID()}`,
    });
    expect(created.status).toBe(201);
    for (let attempt = 0; attempt < 8; attempt++) {
      const response = await fetch(`${app.base_url}/api/session/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: 'incorrect-password' }),
      });
      expect(response.status).toBe(401);
    }
    const limited = await fetch(`${app.base_url}/api/session/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'incorrect-password' }),
    });
    expect(limited.status).toBe(429);
    const differentCaseIdentity = await fetch(`${app.base_url}/api/session/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: username.toUpperCase(), password: 'incorrect-password' }),
    });
    expect(differentCaseIdentity.status).toBe(401);
  } finally { await app.stop(); }
}, 20_000);
