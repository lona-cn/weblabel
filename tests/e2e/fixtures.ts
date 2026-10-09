import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { expect, test as base, type Page } from '@playwright/test';
import { bootstrap_admin_for_test, start_test_app, type ApiClient, type TestApp } from '../support/app';

export { expect };

export interface ExpectedBox {
  label_id: 'label_person';
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
}

export interface SeededAsset {
  asset_revision_id: string;
  annotation_revision_id: string;
  width: number;
  height: number;
  expected: ExpectedBox;
  exif_orientation: number;
  mirrored: boolean;
}

export interface SeededProject {
  project_id: string;
  ontology_version_id: string;
  assets: SeededAsset[];
  demoImagePaths: string[];
  api: ApiClient;
  apiBaseUrl: string;
  apiCookie: string;
  login: { username: string; password: string };
}

interface Fixtures {
  app: TestApp;
  adminPage: Page;
  seededProject: SeededProject;
}

const WIDTH = 320;
const HEIGHT = 240;
const BOXES: readonly ExpectedBox[] = Array.from({ length: 20 }, (_, index) => ({
  label_id: 'label_person',
  x_min: 24 + (index % 5) * 31,
  y_min: 20 + Math.floor(index / 5) * 39,
  x_max: 54 + (index % 5) * 31,
  y_max: 72 + Math.floor(index / 5) * 39,
}));

const ontology = {
  guidelines_markdown: 'Synthetic T15 person detection. Coordinates use canonical continuous image pixels.',
  labels: [{
    label_id: 'label_person',
    name: 'Person',
    color: '#0099ff',
    shortcut: null,
    allowed_geometry_types: ['bbox_xyxy'],
    attributes: [{
      key: 'helmet_state', kind: 'enum', required: false, default_value: 'unknown',
      enum_values: ['wearing', 'not_wearing', 'unknown'], min: null, max: null,
    }],
  }],
};

type JsonRecord = Record<string, unknown>;
function record(value: unknown, name: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${name} was not a JSON object`);
  return value as JsonRecord;
}
function stringField(value: unknown, name: string): string {
  const field = record(value, name)[name];
  if (typeof field !== 'string' || field.length === 0) throw new Error(`${name} was missing`);
  return field;
}

async function generatedImage(index: number): Promise<Buffer> {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = (y * WIDTH + x) * 3;
      const inside = x >= BOXES[index].x_min && x < BOXES[index].x_max && y >= BOXES[index].y_min && y < BOXES[index].y_max;
      const checker = ((x >> 4) + (y >> 4) + index) % 2 === 0;
      pixels[offset] = inside ? 240 : checker ? 224 : 36;
      pixels[offset + 1] = inside ? 48 + (index * 7) % 160 : checker ? 232 : 44;
      pixels[offset + 2] = inside ? 28 : checker ? 236 : 52;
    }
  }
  return sharp(pixels, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } }).png().toBuffer();
}

async function authorizedUploader(admin: ApiClient, app: TestApp, projectId: string): Promise<{ cookie: string; csrf: string; username: string; password: string }> {
  const username = `t15-${randomUUID()}`;
  const password = `${randomUUID()}-T15-password`;
  const created = await admin.request<JsonRecord>('POST', '/api/users', { username, password });
  if (created.status !== 201) throw new Error(`T15 uploader creation failed: ${created.status} ${JSON.stringify(created.json)}`);
  const userId = stringField(created.json, 'user_id');
  const membership = await admin.request('POST', `/api/projects/${projectId}/members`, { user_id: userId, role: 'admin' });
  if (membership.status !== 200) throw new Error(`T15 uploader membership failed: ${membership.status}`);
  const response = await fetch(new URL('/api/session/login', app.base_url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: app.base_url, host: new URL(app.base_url).host },
    body: JSON.stringify({ username, password }),
  });
  if (response.status !== 200) throw new Error(`T15 uploader login failed: ${response.status} ${await response.text()}`);
  const cookie = (response.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
  const login = record(await response.json(), 'login');
  const csrf = stringField(login, 'csrf_token');
  if (!cookie) throw new Error('T15 login did not issue a session cookie');
  return { cookie, csrf, username, password };
}

async function uploadTypedImage(app: TestApp, projectId: string, credentials: { cookie: string; csrf: string }, image: Buffer, index: number, filename: string, mime: string): Promise<void> {
  const form = new FormData();
  const bytes = image.buffer instanceof ArrayBuffer
    ? new Uint8Array(image.buffer, image.byteOffset, image.byteLength)
    : Uint8Array.from(image);
  form.append('images', new Blob([bytes], { type: mime }), filename);
  const response = await fetch(new URL(`/api/projects/${projectId}/assets`, app.base_url), {
    method: 'POST',
    headers: {
      cookie: credentials.cookie,
      'x-csrf-token': credentials.csrf,
      origin: app.base_url,
      'idempotency-key': `t15-${randomUUID()}`,
    },
    body: form,
  });
  if (response.status !== 202) throw new Error(`T15 image ${index + 1} upload failed: ${response.status} ${await response.text()}`);
}

async function seed(app: TestApp, api: ApiClient, demoDir: string): Promise<SeededProject> {
  const project = await api.request<JsonRecord>('POST', '/api/projects', {
    name: `T15 vertical ${randomUUID()}`, description: 'Deterministic procedural annotation acceptance data', allow_self_review: true,
  });
  if (project.status !== 201) throw new Error(`T15 project creation failed: ${JSON.stringify(project.json)}`);
  const projectId = stringField(project.json, 'project_id');
  const published = await api.request<JsonRecord>('POST', `/api/projects/${projectId}/ontologies`, ontology);
  if (published.status !== 201) throw new Error(`T15 ontology publish failed: ${JSON.stringify(published.json)}`);
  const ontologyId = stringField(published.json, 'ontology_version_id');
  const uploader = await authorizedUploader(api, app, projectId);
  const demoImagePaths: string[] = [];

  for (let index = 0; index < BOXES.length; index += 1) {
    const bytes = await generatedImage(index);
    const imagePath = path.join(demoDir, `t15-demo-${String(index + 1).padStart(2, '0')}.png`);
    await writeFile(imagePath, bytes);
    demoImagePaths.push(imagePath);
    await uploadTypedImage(app, projectId, uploader, bytes, index, `t15-demo-${String(index + 1).padStart(2, '0')}.png`, 'image/png');
  }
  for (const [index, orientation] of [6, 2].entries()) {
    const filename = `orientation-${orientation}.jpg`;
    const bytes = await readFile(path.resolve('tests/fixtures/media', filename));
    await uploadTypedImage(app, projectId, uploader, bytes, BOXES.length + index, filename, 'image/jpeg');
  }
  const totalAssets = BOXES.length + 2;
  const drained = await api.request<JsonRecord>('POST', '/internal/test/jobs/drain', {});
  if (drained.status !== 200 || record(drained.json, 'drain').processed !== totalAssets) {
    throw new Error(`T15 media processing did not finish all ${totalAssets} uploads: ${JSON.stringify(drained.json)}`);
  }
  const assetsResponse = await api.request<JsonRecord>('GET', `/api/projects/${projectId}/assets`);
  if (assetsResponse.status !== 200) throw new Error(`T15 assets query failed: ${JSON.stringify(assetsResponse.json)}`);
  const assets = record(assetsResponse.json, 'assets').items;
  if (!Array.isArray(assets) || assets.length !== totalAssets) throw new Error(`T15 expected ${totalAssets} imported images, received ${Array.isArray(assets) ? assets.length : 'invalid list'}`);
  const seededAssets: SeededAsset[] = [];
  for (const rawAsset of assets) {
    const asset = record(rawAsset, 'asset');
    const assetRevisionId = stringField(asset, 'asset_revision_id');
    const originalName = stringField(asset, 'original_name');
    const orientationMatch = /orientation-(\d)\.jpg$/.exec(originalName);
    const orientation = orientationMatch ? Number(orientationMatch[1]) : 1;
    const expected = orientation === 6 ? { label_id: 'label_person' as const, x_min: 4, y_min: 5, x_max: 20, y_max: 30 }
      : orientation === 2 ? { label_id: 'label_person' as const, x_min: 6, y_min: 4, x_max: 30, y_max: 25 }
        : BOXES[Number(/t15-demo-(\d+)\.png$/.exec(originalName)?.[1] ?? '1') - 1];
    const width = Number(asset.canonical_width);
    const height = Number(asset.canonical_height);
    const head = await api.request<JsonRecord>('GET', `/api/assets/${assetRevisionId}/annotation?ontology_version_id=${encodeURIComponent(ontologyId)}`);
    if (head.status !== 200) throw new Error(`T15 initial annotation query failed: ${JSON.stringify(head.json)}`);
    seededAssets.push({
      asset_revision_id: assetRevisionId,
      annotation_revision_id: stringField(head.json, 'annotation_revision_id'),
      width,
      height,
      expected,
      exif_orientation: orientation,
      mirrored: orientation === 2,
    });
  }
  return {
    project_id: projectId,
    ontology_version_id: ontologyId,
    assets: seededAssets,
    demoImagePaths,
    api,
    apiBaseUrl: app.base_url,
    apiCookie: uploader.cookie,
    login: { username: uploader.username, password: uploader.password },
  };
}

export async function forward_api_for_test(page: Page, baseUrl: string): Promise<void> {
  await page.route('http://127.0.0.1:5173/api/**', async (route) => {
    const request = route.request();
    const incoming = new URL(request.url());
    const target = new URL(`${incoming.pathname}${incoming.search}`, baseUrl);
    const headers: Record<string, string> = { ...request.headers(), origin: baseUrl };
    delete headers.host;
    delete headers['content-length'];
    const postData = request.postDataBuffer();
    await route.fulfill({
      response: await route.fetch({ url: target.href, headers, method: request.method(), postData: postData ?? undefined }),
    });
  });
}

export const test = base.extend<Fixtures>({
  app: async ({}, use) => {
    const app = await start_test_app();
    try { await use(app); } finally { await app.stop(); }
  },
  adminPage: async ({ page, seededProject }, use) => {
    await forward_api_for_test(page, seededProject.apiBaseUrl);
    await page.goto('http://127.0.0.1:5173/');
    await page.getByTestId('login-username').fill(seededProject.login.username);
    await page.getByTestId('login-password').fill(seededProject.login.password);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('login-submit')).toHaveCount(0);
    await page.goto(`http://127.0.0.1:5173/?project_id=${encodeURIComponent(seededProject.project_id)}`);
    await expect(page.getByTestId('asset-grid')).toBeVisible();
    await use(page);
  },
  seededProject: async ({ app }, use) => {
    const api = await bootstrap_admin_for_test(app);
    const demoDir = await mkdtemp(path.join(tmpdir(), 'weblabel-t15-demo-'));
    try {
      await use(await seed(app, api, demoDir));
    } finally {
      await rm(demoDir, { recursive: true, force: true });
    }
  },
});
