import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import sharp from 'sharp';
import { expect, test, type SeededProject } from './fixtures';
import type { AnnotationDocument } from '../../packages/contracts/generated/AnnotationDocument';
import type { AnnotationRevision } from '../../packages/contracts/generated/AnnotationRevision';
import type { SaveRequest } from '../../packages/contracts/generated/SaveRequest';
import type { SaveResponse } from '../../packages/contracts/generated/SaveResponse';
import type { DraftRecord } from '../../apps/web/src/lib/persistence/types';
import { installBrowserFaults } from '../support/faults';

const origin = 'http://127.0.0.1:5173';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOFTWARE = /cpu|software|swiftshader|llvmpipe|lavapipe|mesa|basic render/i;
// Browser-owned fault gate installed by this test, not external JSON data.
type T15GateWindow = Window & { __t15GpuGate: { blocked: boolean; release: (() => void) | null } };

async function annotation(api: { request<T>(method: string, path: string): Promise<{ status: number; json: T }> }, assetId: string, ontologyId: string) {
  const response = await api.request<Record<string, unknown>>(
    'GET', `/api/assets/${assetId}/annotation?ontology_version_id=${encodeURIComponent(ontologyId)}`,
  );
  expect(response.status, JSON.stringify(response.json)).toBe(200);
  return response.json;
}

async function imageBox(page: Page) {
  const canvas = page.getByTestId('annotation-canvas');
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) throw new Error('annotation canvas has no visible layout');
  return { canvas, box };
}
function canvasPoint(rect: { x: number; y: number; width: number; height: number }, asset: SeededProject['assets'][number], x: number, y: number): [number, number] {
  const scale = Math.min(rect.width / asset.width, rect.height / asset.height);
  const left = rect.x + (rect.width - asset.width * scale) / 2;
  const top = rect.y + (rect.height - asset.height * scale) / 2;
  return [left + x * scale, top + y * scale];
}


test('T15 real UI project/import/editor/save/reload/export flow on a hardware WebGPU device', async ({ adminPage: page, seededProject }) => {
  test.setTimeout(60_000);
  await page.goto(`${origin}/?project_id=${encodeURIComponent(seededProject.project_id)}`);
  await expect(page.getByTestId('project-name')).toHaveValue(/T15 vertical/);
  await expect(page.getByTestId('asset-grid')).toBeVisible();
  const diagnostics = page.getByTestId('gpu-status');
  await expect(diagnostics).toHaveAttribute('data-actual-backend', 'webgpu', { timeout: 30_000 });
  await expect(diagnostics).toHaveAttribute('data-device-state', 'ready', { timeout: 30_000 });
  const adapter = await diagnostics.getAttribute('data-adapter-kind');
  expect(adapter).toBe('hardware');
  expect(await diagnostics.innerText()).not.toMatch(SOFTWARE);

  // This is a genuine file-input import of deterministic, separately generated demo images.
  const importInput = page.getByTestId('media-import');
  await expect(importInput).toBeAttached();
  const uploadFiles = await Promise.all(seededProject.demoImagePaths.map(async (imagePath) => ({
    name: path.basename(imagePath),
    mimeType: 'image/png',
    buffer: await readFile(imagePath),
  })));
  const importQueued = page.waitForResponse((response) =>
    response.url().includes('/api/projects/') && response.url().endsWith('/assets')
    && response.request().method() === 'POST' && response.status() === 202,
  );
  await importInput.setInputFiles(uploadFiles);
  await importQueued;
  const importDrain = await seededProject.api.request<Record<string, unknown>>('POST', '/internal/test/jobs/drain', {});
  expect(importDrain.status, JSON.stringify(importDrain.json)).toBe(200);
  expect(importDrain.json.processed).toBe(1);
  await expect(page.getByTestId('asset-grid').locator('[data-testid^="asset-item-"]')).toHaveCount(42);

  const asset = seededProject.assets.find((item) => item.exif_orientation === 1 && item.width === 320);
  if (!asset) throw new Error('T15 procedural 320x240 asset is missing');
  await page.getByTestId(`asset-item-${asset.asset_revision_id}`).click();
  await expect(page.getByTestId('tool-box')).toBeVisible();
  await expect(page.getByTestId('gpu-status')).toHaveAttribute('data-device-state', 'ready');
  const nextAsset = seededProject.assets.find((item) => item.asset_revision_id !== asset.asset_revision_id);
  if (!nextAsset) throw new Error('T15 asset-switch regression needs two server assets');
  const delayedPath = `**/api/assets/${nextAsset.asset_revision_id}/annotation*`;
  await page.route(delayedPath, async (route) => {
    const delay = Promise.withResolvers<void>();
    setTimeout(delay.resolve, 500);
    await delay.promise;
    await route.fallback();
  });
  await page.getByTestId(`asset-item-${nextAsset.asset_revision_id}`).click();
  await expect(page.getByTestId('tool-box')).toBeDisabled();
  await expect(page.getByTestId('annotation-canvas')).toHaveCount(0);
  await expect(page.getByTestId('completion-state')).toBeDisabled();
  await expect(page.getByTestId('export-start')).toBeDisabled();
  await page.unroute(delayedPath);
  await expect(page.getByTestId('tool-box')).toBeVisible();
  await page.getByTestId(`asset-item-${asset.asset_revision_id}`).click();
  await expect(page.getByTestId('tool-box')).toBeVisible();
  await expect(page.getByTestId('gpu-status')).toHaveAttribute('data-device-state', 'ready');
  const { box } = await imageBox(page);
  await expect(page.getByTestId('tool-box')).toBeEnabled();
  await page.getByTestId('tool-box').click();
  await page.mouse.move(...canvasPoint(box, asset, asset.expected.x_min, asset.expected.y_min));
  await page.mouse.down();
  await page.mouse.move(...canvasPoint(box, asset, asset.expected.x_max, asset.expected.y_max), { steps: 5 });
  await page.mouse.up();
  const objectList = page.getByTestId('object-list');
  await expect(objectList.getByRole('option')).toHaveCount(1);
  await objectList.getByRole('option').click();
  await expect(objectList.getByRole('option')).toHaveAttribute('aria-selected', 'true');
  const attributeSave = page.waitForResponse((response) => {
    const request = response.request();
    if (request.method() !== 'PUT' || !response.url().endsWith('/annotation')) return false;
    const body = request.postDataJSON() as { document?: { objects?: Array<{ attributes?: Record<string, unknown> }> } } | null;
    return body?.document?.objects?.some((object) => object.attributes?.helmet_state === 'wearing') ?? false;
  });
  await page.getByTestId('attribute-helmet_state').selectOption('wearing');
  await expect(page.getByTestId('attribute-helmet_state')).toHaveValue('wearing');
  await attributeSave;

  const savedBeforeReload = await annotation(seededProject.api, asset.asset_revision_id, seededProject.ontology_version_id);
  const revisionBeforeReload = savedBeforeReload.annotation_revision_id;
  const documentBeforeReload = savedBeforeReload.document as { objects: Array<{ label_id: string; geometry: Record<string, unknown>; attributes: Record<string, unknown> }> };
  expect(documentBeforeReload.objects).toHaveLength(1);
  expect(documentBeforeReload.objects[0].label_id).toBe('label_person');
  expect(documentBeforeReload.objects[0].attributes.helmet_state).toBe('wearing');
  const geometry = documentBeforeReload.objects[0].geometry;
  expect(geometry.type).toBe('bbox_xyxy');
  expect(geometry.x_min).toBeCloseTo(asset.expected.x_min, 2);
  expect(geometry.y_min).toBeCloseTo(asset.expected.y_min, 2);
  expect(geometry.x_max).toBeCloseTo(asset.expected.x_max, 2);
  expect(geometry.y_max).toBeCloseTo(asset.expected.y_max, 2);
  await page.reload();
  await expect(page.getByTestId('object-list')).toBeVisible();
  const savedAfterReload = await annotation(seededProject.api, asset.asset_revision_id, seededProject.ontology_version_id);
  expect(savedAfterReload.annotation_revision_id).toBe(revisionBeforeReload);
  expect(savedAfterReload.document).toEqual(savedBeforeReload.document);

  await page.getByTestId('export-format').selectOption('coco');
  await page.getByTestId('export-start').click();
  const download = await page.waitForEvent('download');
  const downloadedPath = await download.path();
  if (!downloadedPath) throw new Error('export download did not materialize bytes');
  const exported = JSON.parse(await readFile(downloadedPath, 'utf8')) as {
    images: Array<{ width: number; height: number }>;
    categories: Array<{ label_id: string }>;
    annotations: Array<{ category_id: number; bbox: number[] }>;
  };
  expect(exported.images).toHaveLength(1);
  expect(exported.images[0]).toMatchObject({ width: asset.width, height: asset.height });
  const category = exported.categories.find((item) => item.label_id === 'label_person');
  expect(category).toBeDefined();
  expect(exported.annotations).toHaveLength(1);
  const [x, y, width, height] = exported.annotations[0].bbox;
  expect(exported.annotations[0].category_id).toBe(exported.categories.findIndex((item) => item.label_id === 'label_person') + 1);
  expect([x, y, x + width, y + height]).toEqual([
    documentBeforeReload.objects[0].geometry.x_min,
    documentBeforeReload.objects[0].geometry.y_min,
    documentBeforeReload.objects[0].geometry.x_max,
    documentBeforeReload.objects[0].geometry.y_max,
  ]);
});

test('T15 confirmed-negative requires explicit confirmation and remains negative after reload', async ({ adminPage: page, seededProject }) => {
  const asset = seededProject.assets[1];
  await page.goto(`${origin}/?project_id=${encodeURIComponent(seededProject.project_id)}&asset_revision_id=${asset.asset_revision_id}`);
  await expect(page.getByTestId('tool-box')).toBeEnabled();
  await expect(page.getByTestId('gpu-status')).toHaveAttribute('data-device-state', 'ready');
  await expect(page.getByTestId('completion-state')).toHaveValue('unprocessed');
  await page.getByTestId('completion-state').selectOption('confirmed_negative');
  await expect(page.getByTestId('negative-confirmation')).toBeVisible();
  await expect(page.getByTestId('save-status')).toContainText('已同步');
  const beforeConfirmation = await annotation(seededProject.api, asset.asset_revision_id, seededProject.ontology_version_id);
  expect((beforeConfirmation.document as { completion: string }).completion).toBe('unprocessed');
  await page.getByTestId('negative-confirm-checkbox').check();
  await page.getByTestId('negative-confirm-submit').click();
  await expect(page.getByTestId('save-status')).toContainText('已同步');
  const first = await annotation(seededProject.api, asset.asset_revision_id, seededProject.ontology_version_id);
  expect((first.document as { completion: string; objects: unknown[] }).completion).toBe('confirmed_negative');
  expect((first.document as { objects: unknown[] }).objects).toEqual([]);
  await page.reload();
  await expect(page.getByTestId('completion-state')).toHaveValue('confirmed_negative');
  const second = await annotation(seededProject.api, asset.asset_revision_id, seededProject.ontology_version_id);
  expect(second.document).toEqual(first.document);
});

test('T15 EXIF 6 and mirrored media keep canonical display and exported xyxy aligned', async ({ adminPage: page, seededProject }) => {
  for (const [file, expectedOrientation] of [['orientation-6.jpg', 6], ['orientation-2.jpg', 2]] as const) {
    const sourcePath = path.join(repoRoot, 'tests', 'fixtures', 'media', file);
    const sourceBytes = await readFile(sourcePath);
    const asset = seededProject.assets.find((item) => item.exif_orientation === expectedOrientation);
    expect(asset, `fixture must include orientation ${expectedOrientation}`).toBeDefined();
    const image = await sharp(sourceBytes).metadata();
    const expectedWidth = expectedOrientation === 6 ? image.height : image.width;
    const expectedHeight = expectedOrientation === 6 ? image.width : image.height;
    expect(asset).toMatchObject({ width: expectedWidth, height: expectedHeight, exif_orientation: expectedOrientation, mirrored: expectedOrientation === 2 });
    await page.goto(`${origin}/?project_id=${seededProject.project_id}&asset_revision_id=${asset!.asset_revision_id}`);
    const mediaResponse = await fetch(new URL(`/api/assets/${asset!.asset_revision_id}/image`, seededProject.apiBaseUrl), {
      headers: { cookie: seededProject.apiCookie, origin: seededProject.apiBaseUrl },
    });
    expect(mediaResponse.status).toBe(200);
    const canonical = Buffer.from(await mediaResponse.arrayBuffer());
    expect(createHash('sha256').update(canonical).digest('hex')).not.toBe(createHash('sha256').update(sourceBytes).digest('hex'));
    const canonicalMeta = await sharp(canonical).metadata();
    expect({ width: canonicalMeta.width, height: canonicalMeta.height }).toEqual({ width: expectedWidth, height: expectedHeight });
    const { canvas, box } = await imageBox(page);
    await expect(canvas).toBeVisible();
    await expect(page.getByTestId('gpu-status')).toHaveAttribute('data-actual-backend', 'webgpu');
    const expected = asset!.expected;
    await page.getByTestId('tool-box').click();
    await page.mouse.move(...canvasPoint(box, asset!, expected.x_min, expected.y_min));
    await page.mouse.down();
    await page.mouse.move(...canvasPoint(box, asset!, expected.x_max, expected.y_max), { steps: 4 });
    await page.mouse.up();
    await expect(page.getByTestId('save-status')).toContainText('已同步');
    const saved = await annotation(seededProject.api, asset!.asset_revision_id, seededProject.ontology_version_id);
    const geometry = (saved.document as { objects: Array<{ geometry: { x_min: number; y_min: number; x_max: number; y_max: number } }> }).objects[0].geometry;
    expect(geometry.x_min).toBeCloseTo(expected.x_min, 4);
    expect(geometry.y_min).toBeCloseTo(expected.y_min, 4);
    expect(geometry.x_max).toBeCloseTo(expected.x_max, 4);
    expect(geometry.y_max).toBeCloseTo(expected.y_max, 4);
    await page.getByTestId('export-format').selectOption('coco');
    await page.getByTestId('export-start').click();
    const download = await page.waitForEvent('download');
    const output = await download.path();
    if (!output) throw new Error('oriented-image export did not produce bytes');
    const exported = JSON.parse(await readFile(output, 'utf8')) as { annotations: Array<{ bbox: number[] }> };
    const [x, y, width, height] = exported.annotations[0].bbox;
    expect(x).toBeCloseTo(geometry.x_min, 4);
    expect(y).toBeCloseTo(geometry.y_min, 4);
    expect(x + width).toBeCloseTo(geometry.x_max, 4);
    expect(y + height).toBeCloseTo(geometry.y_max, 4);
  }
});

test('T15 production listbox keyboard delete preserves native atomicity, persisted canonical order and focus policy', async ({ page, seededProject }, info) => {
  test.setTimeout(120_000);
  const privateOrigin = String(info.project.use.baseURL ?? origin);
  const asset = seededProject.assets.find(item => item.width === 320 && item.exif_orientation === 1)!;
  const other = seededProject.assets.find(item => item.asset_revision_id !== asset.asset_revision_id)!;
  const annotationPath = `/api/assets/${asset.asset_revision_id}/annotation`;
  const readHead = async () => {
    const response = await seededProject.api.request<AnnotationRevision>('GET', `${annotationPath}?ontology_version_id=${seededProject.ontology_version_id}`);
    expect(response.status).toBe(200);
    return response.json;
  };
  const initial = await readHead();
  const document: AnnotationDocument = { ...initial.document, completion: 'complete',
    objects: [0, 1, 2].map(index => ({
      object_id: `t15-keyboard-${index}`, label_id: 'label_person',
      geometry: { type: 'bbox_xyxy', x_min: 20 + index * 90, y_min: 30, x_max: 70 + index * 90, y_max: 100 },
      attributes: { helmet_state: 'unknown' },
      origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null },
    })),
  };
  const seeded = await seededProject.api.request<SaveResponse>('PUT', annotationPath, {
    operation_id: crypto.randomUUID(), base_revision_id: initial.annotation_revision_id,
    document, lease: null, suggestion_decisions: [],
  } satisfies SaveRequest);
  expect(seeded.status).toBe(200);
  const baseline = await readHead();
  expect(baseline.document).toEqual(document);
  await page.route(`${privateOrigin}/api/**`, async route => {
    const request = route.request(), incoming = new URL(request.url());
    const headers = { ...request.headers(), origin: seededProject.apiBaseUrl };
    delete headers.host;
    delete headers['content-length'];
    await route.fulfill({ response: await route.fetch({
      url: new URL(incoming.pathname + incoming.search, seededProject.apiBaseUrl).href,
      headers, method: request.method(), postData: request.postDataBuffer() ?? undefined,
    }) });
  });
  await installBrowserFaults(page);
  // Delay only the actual adapter request after a real GPUDevice.destroy.
  // This is a fault gate, not a replacement device or successful fake response.
  await page.addInitScript(() => {
    const state = { blocked: false, release: null as (() => void) | null };
    Object.assign(window, { __t15GpuGate: state });
    const gpuNavigator = navigator as unknown as { gpu: { requestAdapter(...args: unknown[]): Promise<unknown> } };
    const gpu = gpuNavigator.gpu;
    const request = gpu.requestAdapter.bind(gpu);
    gpu.requestAdapter = async (...args) => {
      if (state.blocked) await new Promise<void>(resolve => { state.release = resolve; });
      return request(...args);
    };
  });
  const puts: SaveRequest[] = [], errors: string[] = [];
  const loadedWasm: Promise<string>[] = [];
  page.on('response', response => {
    if (new URL(response.url()).pathname === '/wasm/wasm_bridge_bg.wasm') {
      loadedWasm.push(response.body().then(bytes => createHash('sha256').update(bytes).digest('hex')));
    }
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === annotationPath) puts.push(request.postDataJSON() as SaveRequest);
  });
  await page.goto(privateOrigin);
  await page.getByTestId('login-username').fill(seededProject.login.username);
  await page.getByTestId('login-password').fill(seededProject.login.password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-submit')).toHaveCount(0);
  await page.goto(`${privateOrigin}/?project_id=${seededProject.project_id}&asset_revision_id=${asset.asset_revision_id}`);
  const gpu = page.getByTestId('gpu-status'), list = page.getByTestId('object-list');
  const first = page.getByTestId('object-item-t15-keyboard-0'), middle = page.getByTestId('object-item-t15-keyboard-1');
  const ready = async () => {
    await expect(gpu).toHaveAttribute('data-device-state', 'ready', { timeout: 30_000 });
    await expect(gpu).toHaveAttribute('data-actual-backend', 'webgpu');
    await expect(gpu).toHaveAttribute('data-adapter-kind', 'hardware');
  };
  const unchanged = async () => {
    await page.waitForTimeout(650); // Includes the unchanged real SaveQueue debounce.
    expect(puts).toEqual([]);
    expect(await readHead()).toEqual(baseline);
    await expect(page.getByTestId('undo')).toBeDisabled();
  };
  const readDraft = () => page.evaluate(async assetId => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('weblabel-drafts', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<DraftRecord>((resolve, reject) => {
        const transaction = db.transaction('drafts', 'readonly'), request = transaction.objectStore('drafts').get(assetId);
        let record: DraftRecord;
        request.onsuccess = () => { record = request.result as DraftRecord; };
        transaction.oncomplete = () => resolve(record);
        transaction.onerror = () => reject(transaction.error);
      });
    } finally { db.close(); }
  }, asset.asset_revision_id);
  await ready();
  await list.focus();
  await page.keyboard.press('Delete'); // Empty native selection is a no-op.
  await unchanged();
  await middle.click();
  await expect(middle).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('attribute-helmet_state').focus();
  await page.keyboard.press('Delete');
  await page.keyboard.press('b');
  await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true');
  await list.focus();
  await list.dispatchEvent('compositionstart');
  await page.keyboard.press('Delete');
  await page.keyboard.press('b');
  await list.dispatchEvent('compositionend');
  await list.dispatchEvent('keydown', { key: 'Delete', code: 'Delete', isComposing: true });
  await expect(middle).toHaveAttribute('aria-selected', 'true');
  await unchanged();

  // Header/navigation and AI/review controls are not an editor surface.
  for (const control of [
    page.getByRole('button', { name: '工作台', exact: true }),
    page.getByRole('heading', { name: '任务与审核', exact: true }),
    page.getByTestId('ai-run'),
  ]) {
    await control.dispatchEvent('keydown', { key: 'Delete', code: 'Delete', bubbles: true });
    await control.dispatchEvent('keydown', { key: 'b', code: 'KeyB', bubbles: true });
  }
  await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true');
  await unchanged();
  // Space on the actual native button activates on keyup, never temporary pan.
  await page.getByTestId('tool-box').focus();
  await page.keyboard.down('Space');
  await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.up('Space');
  await expect(page.getByTestId('tool-box')).toHaveAttribute('aria-pressed', 'true');
  await list.focus();
  await page.keyboard.down('Space');
  await expect(page.getByTestId('tool-pan')).toHaveAttribute('aria-pressed', 'true');

  // Rejected changes during renderer rebuild must not fabricate a tool ACK.
  await page.evaluate(() => {
    const testWindow = window as T15GateWindow;
    testWindow.__t15GpuGate.blocked = true;
  });
  expect((await page.evaluate(() => window.__t30Faults.destroyDevice())).reason).toBe('destroyed');
  await expect(gpu).toHaveAttribute('data-device-state', 'recovering');
  await page.keyboard.up('Space'); // Records release intent; native is blocked.
  await list.dispatchEvent('keydown', { key: 'v', code: 'KeyV', bubbles: true });
  await list.dispatchEvent('keydown', { key: 'Delete', code: 'Delete', bubbles: true });
  await list.dispatchEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true });
  await expect(page.getByTestId('tool-pan')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => {
    const testWindow = window as T15GateWindow;
    const gate = testWindow.__t15GpuGate;
    gate.blocked = false;
    if (!gate.release) throw new Error('Actual recovery adapter request did not reach the fault gate');
    gate.release();
  });
  await ready();
  await expect(page.getByTestId('tool-box')).toHaveAttribute('aria-pressed', 'true');
  await expect(middle).toHaveAttribute('aria-selected', 'true');
  await unchanged();

  // Renderer-only recovery with no recorded release must preserve an in-flight
  // native preview. Canvas clicks focus the existing grid without a new tab stop.
  const previewCanvas = page.getByTestId('annotation-canvas');
  const previewBox = (await imageBox(page)).box;
  await page.mouse.move(...canvasPoint(previewBox, asset, 270, 150));
  await page.mouse.down();
  await page.mouse.move(...canvasPoint(previewBox, asset, 300, 200), { steps: 3 });
  await expect(page.locator('.workbench-grid')).toBeFocused();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const previewBefore = await previewCanvas.screenshot();
  expect((await page.evaluate(() => window.__t30Faults.destroyDevice())).reason).toBe('destroyed');
  await ready();
  await expect(page.getByTestId('tool-box')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const previewAfter = await previewCanvas.screenshot();
  expect(createHash('sha256').update(previewAfter).digest('hex')).toBe(createHash('sha256').update(previewBefore).digest('hex'));
  await info.attach('retained-native-preview-before', { body: previewBefore, contentType: 'image/png' });
  await info.attach('retained-native-preview-after', { body: previewAfter, contentType: 'image/png' });
  await page.keyboard.press('Escape'); // Routed from the focused canvas surface.
  await page.mouse.up();
  await unchanged();

  // Blur carries the same bounded release intent even while the real adapter
  // request is blocked; it cannot lie about the last acknowledged pan tool.
  await list.focus();
  await page.keyboard.down('Space');
  await expect(page.getByTestId('tool-pan')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => {
    const testWindow = window as T15GateWindow;
    testWindow.__t15GpuGate.blocked = true;
    testWindow.__t15GpuGate.release = null;
  });
  expect((await page.evaluate(() => window.__t30Faults.destroyDevice())).reason).toBe('destroyed');
  await expect(gpu).toHaveAttribute('data-device-state', 'recovering');
  await page.evaluate(() => window.dispatchEvent(new FocusEvent('blur')));
  await expect(page.getByTestId('tool-pan')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.up('Space');
  await page.evaluate(() => {
    const testWindow = window as T15GateWindow;
    const gate = testWindow.__t15GpuGate;
    gate.blocked = false;
    if (!gate.release) throw new Error('Actual blur recovery did not reach the adapter gate');
    gate.release();
  });
  await ready();
  await expect(page.getByTestId('tool-box')).toHaveAttribute('aria-pressed', 'true');
  await unchanged();

  // Native must refuse the whole mixed locked/unlocked selection, not delete a
  // JS-filtered subset. Both rows retain the last accepted selection afterward.
  await page.getByTestId('tool-select').click();
  await first.click();
  await page.getByTestId('object-lock-selected').click();
  const { box } = await imageBox(page);
  await page.keyboard.down('Control');
  await page.mouse.click(...canvasPoint(box, asset, 135, 65));
  await page.keyboard.up('Control');
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await expect(middle).toHaveAttribute('aria-selected', 'true');
  await list.focus();
  await page.keyboard.press('Delete');
  await expect(page.getByRole('alert').filter({ hasText: 'OBJECT_LOCKED' })).toBeVisible();
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await expect(middle).toHaveAttribute('aria-selected', 'true');
  await unchanged();
  await first.click();
  await page.getByTestId('object-lock-selected').click();
  await middle.click();
  await list.focus();
  await expect(list).toBeFocused();
  await page.keyboard.press('Delete'); // The ordinary public consumer path.
  const deleted = { ...document, objects: [document.objects[0], document.objects[2]] };
  const assertPersisted = async (expected: AnnotationDocument, generation: number, parent: AnnotationRevision) => {
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-phase', 'synced');
    const head = await readHead();
    expect(head.document).toEqual(expected);
    expect(head.parent_revision_id).toBe(parent.annotation_revision_id);
    expect(head.revision_no).toBe(parent.revision_no + 1);
    const draft = await readDraft();
    expect(draft.document).toEqual(expected);
    expect(draft.generation).toBe(generation);
    expect(draft.synced_generation).toBe(generation);
    expect(draft.base_revision_id).toBe(head.annotation_revision_id);
    expect(draft.pending).toBeNull();
    expect(draft.intent_journal).toEqual([]);
    return head;
  };
  await expect(middle).toHaveCount(0);
  await expect(list.getByRole('option')).toHaveCount(2);
  await expect(list.getByRole('option', { selected: true })).toHaveCount(0);
  const deleteHead = await assertPersisted(deleted, 1, baseline);
  await page.getByTestId('undo').click();
  await expect(list.getByRole('option')).toHaveCount(3);
  const undoHead = await assertPersisted(document, 2, deleteHead);
  await expect(page.getByTestId('undo')).toBeDisabled();
  await page.getByTestId('redo').click();
  await expect(list.getByRole('option')).toHaveCount(2);
  const redoHead = await assertPersisted(deleted, 3, undoHead);
  expect(puts.map(put => put.document)).toEqual([deleted, document, deleted]);
  expect(puts.map(put => put.base_revision_id)).toEqual([baseline.annotation_revision_id, deleteHead.annotation_revision_id, undoHead.annotation_revision_id]);
  expect(new Set(puts.map(put => put.operation_id)).size).toBe(3);

  await first.click();
  await page.getByTestId(`asset-item-${other.asset_revision_id}`).click();
  await ready();
  await list.focus();
  await page.keyboard.press('Delete'); // No stale selection crosses assets.
  await page.getByTestId(`asset-item-${asset.asset_revision_id}`).click();
  await ready();
  await expect(list.getByRole('option', { selected: true })).toHaveCount(0);
  await list.focus();
  await page.keyboard.press('Delete');
  await page.waitForTimeout(650);
  expect(await readHead()).toEqual(redoHead);
  expect(puts).toHaveLength(3);

  // A real CAS conflict exposes the server-preview/new-draft boundaries.
  const remoteDocument = { ...deleted, completion: 'in_progress' as const };
  const concurrent = await seededProject.api.request<SaveResponse>('PUT', annotationPath, {
    operation_id: crypto.randomUUID(), base_revision_id: redoHead.annotation_revision_id,
    document: remoteDocument, lease: null, suggestion_decisions: [],
  } satisfies SaveRequest);
  expect(concurrent.status).toBe(200);
  const concurrentHead = await readHead();
  await first.click();
  await page.getByTestId('attribute-helmet_state').selectOption('wearing');
  const localDocument = { ...deleted, objects: [
    { ...deleted.objects[0], attributes: { helmet_state: 'wearing' } }, deleted.objects[1],
  ] };
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-phase', 'conflict');
  expect((await readDraft()).document).toEqual(localDocument);
  await page.getByTestId('conflict-view-server').click();
  await ready();
  await expect(page.getByTestId('completion-state')).toHaveValue('in_progress');
  await expect(page.getByTestId('tool-box')).toBeDisabled();
  await expect(list.getByRole('option', { selected: true })).toHaveCount(0);
  const previewDraft = await readDraft(), previewPuts = puts.length;
  for (const event of [
    { key: 'Home', code: 'Home' }, { key: 'Delete', code: 'Delete' },
    { key: 'b', code: 'KeyB' }, { key: 'Escape', code: 'Escape' },
    { key: 'd', code: 'KeyD', ctrlKey: true },
  ]) await list.dispatchEvent('keydown', { ...event, bubbles: true });
  await page.waitForTimeout(650);
  expect(puts).toHaveLength(previewPuts);
  expect(await readDraft()).toEqual(previewDraft);
  expect(await readHead()).toEqual(concurrentHead);
  await expect(list.getByRole('option', { selected: true })).toHaveCount(0);
  const exported = page.waitForEvent('download');
  await page.getByTestId('conflict-keep-local').click();
  await exported;
  await ready();
  await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true');
  await expect(list.getByRole('option', { selected: true })).toHaveCount(0);
  await list.focus();
  await page.keyboard.press('Delete'); // A resumed draft has no stale selection.
  const resumedHead = await assertPersisted(localDocument, 4, concurrentHead);
  await expect(page.getByTestId('undo')).toBeDisabled();
  expect(puts.slice(3).map(put => put.document)).toEqual([localDocument, localDocument]);

  // Exercise the actual synchronous review ref fence while its head read is
  // held. Synthetic events deliberately bypass inert to test the native port.
  const session = await page.evaluate(async () => await (await fetch('/api/session')).json() as { user_id: string });
  const task = await seededProject.api.request<{ task_id: string }>('POST', `/api/projects/${seededProject.project_id}/tasks`, {
    asset_revision_id: asset.asset_revision_id, ontology_version_id: seededProject.ontology_version_id, assignee_id: session.user_id,
  });
  expect(task.status).toBe(200);
  await page.reload();
  await ready();
  const taskRow = page.getByTestId(`review-task-${task.json.task_id}`);
  await taskRow.getByRole('button', { name: '领取 60 秒任务' }).click();
  await expect(page.getByTestId('active-task-lease')).toBeVisible();
  await first.click();
  await list.focus();
  await page.keyboard.down('Space');
  await expect(page.getByTestId('tool-pan')).toHaveAttribute('aria-pressed', 'true');
  const readStarted = Promise.withResolvers<void>(), releaseRead = Promise.withResolvers<void>();
  await page.route(`**${annotationPath}?*`, async route => {
    readStarted.resolve();
    await releaseRead.promise;
    await route.fallback();
  });
  await taskRow.getByTestId('task-submit').click();
  await readStarted.promise;
  await expect(page.locator('.workbench-grid')).toHaveAttribute('inert', '');
  for (const event of [
    { key: 'Delete', code: 'Delete' }, { key: 'b', code: 'KeyB' }, { key: 'Escape', code: 'Escape' },
  ]) await list.dispatchEvent('keydown', { ...event, bubbles: true });
  await list.dispatchEvent('keyup', { key: ' ', code: 'Space', bubbles: true });
  await expect(page.getByTestId('tool-pan')).toHaveAttribute('aria-pressed', 'true');
  expect(await readHead()).toEqual(resumedHead);
  expect((await readDraft()).document).toEqual(localDocument);
  const submitted = page.waitForResponse(response => response.url().includes(`/tasks/${task.json.task_id}/submit`) && response.request().method() === 'POST');
  releaseRead.resolve();
  expect((await submitted).status()).toBe(200);
  await expect(page.locator('.workbench-grid')).not.toHaveAttribute('inert');
  await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.up('Space');
  await list.focus();
  await page.keyboard.press('Control+z'); // Reloaded native history is empty.
  await page.waitForTimeout(650);
  expect(puts).toHaveLength(5); // No hidden native deletion/history escaped inert.
  expect(await readHead()).toEqual(resumedHead);
  expect((await readDraft()).document).toEqual(localDocument);
  expect(errors).toEqual([]);
  const wasmHashes = await Promise.all(loadedWasm);
  await info.attach('production-keyboard-persistence', { body: JSON.stringify({ baseline, deleteHead, undoHead, redoHead, concurrentHead, resumedHead, puts, draft: await readDraft(), browser: page.context().browser()?.version(), wasmHashes, errors }), contentType: 'application/json' });
});
