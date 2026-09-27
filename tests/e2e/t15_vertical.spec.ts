import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import sharp from 'sharp';
import { expect, test } from './fixtures';

const origin = 'http://127.0.0.1:4174';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOFTWARE = /cpu|software|swiftshader|llvmpipe|lavapipe|mesa|basic render/i;

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
  await page.goto(`${origin}/?project_id=${encodeURIComponent(seededProject.project_id)}`);
  await expect(page.getByTestId('project-name')).toHaveValue(/T15 vertical/);
  await expect(page.getByTestId('asset-grid')).toBeVisible();
  const diagnostics = page.getByTestId('gpu-status');
  await expect(diagnostics).toHaveAttribute('data-actual-backend', 'webgpu');
  await expect(diagnostics).toHaveAttribute('data-device-state', 'ready');
  const adapter = await diagnostics.getAttribute('data-adapter-kind');
  expect(adapter).toBe('hardware');
  expect(await diagnostics.innerText()).not.toMatch(SOFTWARE);

  // This is a genuine file-input import of deterministic, separately generated demo images.
  const importInput = page.getByTestId('media-import');
  await expect(importInput).toBeAttached();
  const imagePaths = seededProject.demoImagePaths;
  for (const imagePath of imagePaths) await access(imagePath);
  await importInput.setInputFiles(imagePaths);
  const importDrain = await seededProject.api.request<Record<string, unknown>>('POST', '/internal/test/jobs/drain', {});
  expect(importDrain.status, JSON.stringify(importDrain.json)).toBe(200);
  expect(importDrain.json.processed).toBe(20);
  await expect(page.getByTestId('asset-grid').locator('[data-testid^="asset-item-"]')).toHaveCount(42);

  const asset = seededProject.assets.find((item) => item.exif_orientation === 1 && item.width === 320);
  if (!asset) throw new Error('T15 procedural 320x240 asset is missing');
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
  await page.getByTestId('attribute-helmet_state').selectOption('wearing');
  await expect(page.getByTestId('object-list')).toContainText('1');
  await expect(page.getByTestId('save-status')).toContainText('已同步');

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
  await expect(page.getByTestId('completion-state')).toHaveValue('unprocessed');
  await page.getByTestId('completion-state').selectOption('confirmed_negative');
  await expect(page.getByTestId('negative-confirmation')).toBeVisible();
  await expect(page.getByTestId('save-status')).not.toContainText('已同步');
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
    expect([geometry.x_min, geometry.y_min, geometry.x_max, geometry.y_max]).toEqual([expected.x_min, expected.y_min, expected.x_max, expected.y_max]);
    await page.getByTestId('export-format').selectOption('coco');
    await page.getByTestId('export-start').click();
    const download = await page.waitForEvent('download');
    const output = await download.path();
    if (!output) throw new Error('oriented-image export did not produce bytes');
    const exported = JSON.parse(await readFile(output, 'utf8')) as { annotations: Array<{ bbox: number[] }> };
    const [x, y, width, height] = exported.annotations[0].bbox;
    expect([x, y, x + width, y + height]).toEqual([expected.x_min, expected.y_min, expected.x_max, expected.y_max]);
  }
});
