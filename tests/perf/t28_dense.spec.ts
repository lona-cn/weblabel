import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { test, expect } from '../e2e/fixtures';
import type {} from '../../apps/web/src/features/workbench/perf';
import type { MediaRevision } from '../../packages/contracts/generated/MediaRevision';


test.use({ trace: 'on', screenshot: 'on' });

for (const count of [2000, 10000] as const) test(`${count} real dense workload: incremental uploads, culling, consumer guards, 10s idle and 100 switches`, async ({ adminPage: page, seededProject }, testInfo) => {
  test.setTimeout(180_000);
  const png = await sharp({ create: { width: 2048, height: 2048, channels: 4, background: { r: 28, g: 37, b: 49, alpha: 1 } } }).png().toBuffer();
  const uploaded = await seededProject.api.upload(`/api/projects/${seededProject.project_id}/assets`, png, `dense-${count}-2048.png`, crypto.randomUUID(), 'image/png');
  expect(uploaded.status).toBe(202);
  const drained = await seededProject.api.request('POST', '/internal/test/jobs/drain', {});
  expect(drained.status).toBe(200);
  const assets = await seededProject.api.request<{ items: MediaRevision[] }>('GET', `/api/projects/${seededProject.project_id}/assets`);
  const denseMedia = assets.json.items.find((asset) => asset.original_name === `dense-${count}-2048.png`);
  expect(denseMedia).toBeDefined();
  await page.goto(`/test-harness/dense?count=${count}&seed=17&project_id=${seededProject.project_id}&asset_revision_id=${denseMedia!.asset_revision_id}`);
  await page.waitForFunction(() => window.__wl_test?.ready === true || document.querySelector('[role="alert"]') !== null);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => window.__wl_test?.ready)).toBe(true);
  await expect(page.getByTestId('gpu-status')).toHaveAttribute('data-actual-backend', 'webgpu');
  await expect(page.getByTestId('gpu-status')).toHaveAttribute('data-adapter-kind', 'hardware');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  const heapInitial = (await cdp.send('Performance.getMetrics')).metrics.filter(metric => metric.name === 'JSHeapUsedSize' || metric.name === 'JSHeapTotalSize');
  const initial = await page.evaluate(() => window.__wl_test!.stats());
  const original = await page.evaluate(() => window.__wl_test!.snapshot());
  expect(original.coordinate_space).toMatchObject({ width: 2048, height: 2048 });
  expect(original.objects).toHaveLength(count);
  expect(await page.evaluate(() => window.__wl_test!.generation())).toBe(7);
  expect(await page.getByTestId('object-list').getByRole('option').count()).toBeLessThan(100);
  await expect(page.getByTestId('object-list').getByRole('option').first()).toHaveAttribute('aria-setsize', String(count));
  expect(await page.getByTestId('canvas-label').count()).toBeLessThanOrEqual(100);
  await expect(page.locator('[data-testid="canvas-label"][data-object-id="dense-17-37"]')).toHaveCount(1);

  await page.screenshot({ path: `reports/T28/dense-${count}-loaded-${Date.now()}.png`, fullPage: true });
  const view = await page.evaluate(() => window.__wl_test!.viewport());
  const highScale = view.scale * 3;
  const halfWidth = view.css_width / (2 * highScale), halfHeight = view.css_height / (2 * highScale);
  const candidate = original.objects.filter(({ geometry: box }) =>
    box.x_min > 1024 - halfWidth && box.x_max < 1024 + halfWidth &&
    box.y_min > 1024 - halfHeight && box.y_max < 1024 + halfHeight).at(-1)!;
  await page.evaluate(async ({ id }) => {
    const hooks = window.__wl_test!;
    await hooks.select(id); await hooks.zoom(3);
    const current = hooks.viewport();
    await hooks.pan(current.css_width / 2 - (1024 * current.scale + current.tx), current.css_height / 2 - (1024 * current.scale + current.ty));
  }, { id: candidate.object_id });
  await expect(page.getByTestId('canvas-label')).toHaveCount(100);
  await expect(page.getByTestId('canvas-label').first()).toHaveAttribute('data-object-id', candidate.object_id);
  await expect(page.getByTestId('canvas-label').first()).toHaveAttribute('data-selected', 'true');
  await page.screenshot({ path: `reports/T28/dense-${count}-capped-labels-${Date.now()}.png`, fullPage: true });
  await page.evaluate(async ({ originalView, id }) => {
    const hooks = window.__wl_test!; await hooks.zoom(1 / 3);
    const current = hooks.viewport(); await hooks.pan(originalView.tx - current.tx, originalView.ty - current.ty);
    await hooks.select(id);
  }, { originalView: view, id: original.objects[37].object_id });
  const beforePan = await page.evaluate(() => window.__wl_test!.stats());
  await page.evaluate(async () => { await window.__wl_test!.pan(17, -9); await window.__wl_test!.zoom(2); });
  const panned = await page.evaluate(() => window.__wl_test!.stats());
  expect(panned.bbox_upload_bytes).toBe(beforePan.bbox_upload_bytes);
  expect(panned.gpu_texture_upload_bytes).toBe(beforePan.gpu_texture_upload_bytes);
  expect(panned.js_wasm_binary_bytes).toBe(beforePan.js_wasm_binary_bytes);
  expect(panned.visible_instances).toBeLessThan(count);
  expect(panned.uniform_upload_bytes).toBeGreaterThan(beforePan.uniform_upload_bytes);
  await page.evaluate(async () => { await window.__wl_test!.zoom(0.5); await window.__wl_test!.pan(-17, 9); });
  expect(await page.evaluate(() => window.__wl_test!.viewport().scale)).toBeCloseTo(view.scale);

  const beforeEdit = await page.evaluate(() => window.__wl_test!.stats());
  await page.evaluate(() => window.__wl_test!.editObject(37));
  const edited = await page.evaluate(() => window.__wl_test!.stats());
  expect(edited.bbox_upload_bytes - beforeEdit.bbox_upload_bytes).toBe(48);
  expect(edited.bbox_upload_calls - beforeEdit.bbox_upload_calls).toBe(1);
  const afterEdit = await page.evaluate(() => window.__wl_test!.snapshot());
  expect(afterEdit.objects[37].geometry.x_max).toBe(original.objects[37].geometry.x_max + 1);
  expect(afterEdit.objects.filter((object, index) => JSON.stringify(object) !== JSON.stringify(original.objects[index])).map((object) => object.object_id)).toEqual(['dense-17-37']);
  expect(await page.evaluate(() => window.__wl_test!.generation())).toBe(8);
  await page.evaluate(() => window.__wl_test!.flush());
  const remote = await seededProject.api.request<{ document: typeof original; annotation_revision_id: string }>('GET', `/api/assets/${denseMedia!.asset_revision_id}/annotation?ontology_version_id=${seededProject.ontology_version_id}`);
  expect(remote.status).toBe(200);
  expect(remote.json.document.objects[37].geometry).toEqual(afterEdit.objects[37].geometry);

  const flagGuards = await page.evaluate(() => ({ saves: window.__wl_test!.saveCount(), validation: window.__wl_test!.validationInputObjects(), serialized: window.__wl_test!.serializedInputObjects(), generation: window.__wl_test!.generation(), visible: window.__wl_test!.stats().visible_instances }));
  const firstRow = page.getByTestId('object-item-dense-17-0');
  await firstRow.click();
  await page.getByTestId('object-hide-selected').click({ timeout: 5000 });
  await expect(firstRow).toHaveAttribute('data-hidden', 'true');
  await expect.poll(() => page.evaluate(() => window.__wl_test!.stats().visible_instances)).toBe(flagGuards.visible - 1);
  await expect(page.locator('[data-testid="canvas-label"][data-object-id="dense-17-0"]')).toHaveCount(0);
  await page.getByTestId('object-show-all').click();
  await expect(firstRow).toHaveAttribute('data-hidden', 'false');
  await expect.poll(() => page.evaluate(() => window.__wl_test!.stats().visible_instances)).toBe(flagGuards.visible);
  await firstRow.click();
  const lockButton = page.getByTestId('object-lock-selected');
  await lockButton.focus();
  await page.keyboard.press('Space');
  await expect(lockButton).toHaveAttribute('aria-pressed', 'true');
  await expect(firstRow).toHaveAttribute('data-locked', 'true');
  expect(await page.evaluate(() => ({ saves: window.__wl_test!.saveCount(), validation: window.__wl_test!.validationInputObjects(), serialized: window.__wl_test!.serializedInputObjects(), generation: window.__wl_test!.generation() }))).toEqual({ saves: flagGuards.saves, validation: flagGuards.validation, serialized: flagGuards.serialized, generation: flagGuards.generation });
  // Native rejection must not publish optimistic transient state for a known target.
  await page.evaluate(() => window.__wl_test!.setFlags(['dense-17-0', 'missing-object'], { hidden: true, locked: false }));
  await page.evaluate(() => window.__wl_test!.setFlags(['dense-17-0'], { hidden: 'invalid' as unknown as boolean }));
  await expect(firstRow).toHaveAttribute('data-hidden', 'false');
  await expect(firstRow).toHaveAttribute('data-locked', 'true');
  expect(await page.evaluate(() => window.__wl_test!.stats().visible_instances)).toBe(flagGuards.visible);
  // A valid geometry command is rejected by the native lock, not just styled in React.
  await page.evaluate(() => window.__wl_test!.editObject(0));
  await expect(page.getByRole('alert')).toBeVisible();
  expect(await page.evaluate(() => window.__wl_test!.generation())).toBe(flagGuards.generation);
  expect((await page.evaluate(() => window.__wl_test!.snapshot())).objects[0].geometry).toEqual(afterEdit.objects[0].geometry);
  await page.waitForTimeout(500);
  const flagHead = await seededProject.api.request<{ annotation_revision_id: string }>('GET', `/api/assets/${denseMedia!.asset_revision_id}/annotation?ontology_version_id=${seededProject.ontology_version_id}`);
  expect(flagHead.json.annotation_revision_id).toBe(remote.json.annotation_revision_id);
  expect(await page.evaluate(() => window.__wl_test!.saveCount())).toBe(flagGuards.saves);
  await lockButton.focus();
  await page.keyboard.press('Space');
  await expect(lockButton).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('object-hide-selected').click();
  await lockButton.click();
  await page.evaluate(async () => { await window.__wl_test!.changeAsset(1); await window.__wl_test!.changeAsset(0); });
  await expect(firstRow).toHaveAttribute('data-hidden', 'false');
  await expect(firstRow).toHaveAttribute('data-locked', 'false');
  await firstRow.click();
  await expect(lockButton).toHaveAttribute('aria-pressed', 'false');
  await page.screenshot({ path: `reports/T28/dense-${count}-sidebar-flags-${Date.now()}.png` });
  const guards = await page.evaluate(() => ({ saves: window.__wl_test!.saveCount(), validation: window.__wl_test!.validationInputObjects(), serialized: window.__wl_test!.serializedInputObjects(), generation: window.__wl_test!.generation() }));
  await page.evaluate(async () => { await window.__wl_test!.select('dense-17-37'); await window.__wl_test!.zoom(0.1); });
  await expect(page.getByTestId('canvas-label')).toHaveCount(1);
  await expect(page.getByTestId('canvas-label')).toHaveAttribute('data-object-id', 'dense-17-37');
  await page.evaluate(() => window.__wl_test!.zoom(10));
  // A newly published ontology cannot silently rebind the current document.
  const ontology = await seededProject.api.request<{ items: { labels: unknown[]; guidelines_markdown: string }[] }>('GET', `/api/projects/${seededProject.project_id}/ontologies`);
  const published = await seededProject.api.request('POST', `/api/projects/${seededProject.project_id}/ontologies`, { labels: ontology.json.items[0].labels, guidelines_markdown: 'Synthetic logical ontology publication during dense interaction' });
  expect(published.status).toBe(201);
  const canvas = page.getByTestId('annotation-canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.evaluate(() => window.__wl_test!.tool('box'));
  const startX = box!.x + box!.width / 2;
  const startY = box!.y + box!.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let i = 0; i < 40; i++) await page.mouse.move(startX + i, startY + i);
  const pointerSamples = await page.evaluate(async ({ x, y }) => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="annotation-canvas"]')!;
    const rows = [];
    for (let i = 0; i < 1000; i++) {
      const started = performance.now(); const before = window.__wl_test!.stats();
      canvas.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: x + 2 + i % 80, clientY: y + 2 + (i % 80) / 2, button: 0, buttons: 1, bubbles: true }));
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const after = window.__wl_test!.stats();
      rows.push({ sequence: i, next_paint_boundary_ms: performance.now() - started, bridge_cpu_ms: after.bridge_elapsed_ms - before.bridge_elapsed_ms, submissions: after.gpu_submissions - before.gpu_submissions });
    }
    return rows;
  }, { x: startX, y: startY });
  expect(pointerSamples.every(sample => sample.submissions === 1)).toBe(true);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => ({ saves: window.__wl_test!.saveCount(), validation: window.__wl_test!.validationInputObjects(), serialized: window.__wl_test!.serializedInputObjects(), generation: window.__wl_test!.generation() }))).toEqual(guards);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.__wl_test!.generation())).toBe(guards.generation + 1);
  expect((await page.evaluate(() => window.__wl_test!.snapshot())).objects).toHaveLength(count + 1);
  await page.evaluate(() => window.__wl_test!.undo());
  expect((await page.evaluate(() => window.__wl_test!.snapshot())).objects).toHaveLength(count);
  await page.evaluate(() => window.__wl_test!.flush());
  const beforeBulk = await page.evaluate(() => ({ validation: window.__wl_test!.validationInputObjects(), generation: window.__wl_test!.generation() }));
  await page.evaluate(() => window.__wl_test!.commitBulkAttributes());
  expect(await page.evaluate(() => window.__wl_test!.validationInputObjects()) - beforeBulk.validation).toBe(count);
  expect(await page.evaluate(() => window.__wl_test!.generation())).toBe(beforeBulk.generation + 1);
  await page.evaluate(() => window.__wl_test!.flush());
  const committed = await page.evaluate(() => window.__wl_test!.snapshot());
  expect(committed.ontology_version_id).toBe(original.ontology_version_id);
  expect(committed.objects.every((object) => object.attributes.helmet_state === 'wearing')).toBe(true);

  await page.getByTestId('object-list').focus();
  await page.keyboard.press('End');
  await expect(page.getByTestId(`object-item-dense-17-${count - 1}`)).toBeVisible();
  await expect(page.getByTestId(`object-item-dense-17-${count - 1}`)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId(`object-item-dense-17-${count - 1}`)).toHaveAttribute('aria-posinset', String(count));
  await page.keyboard.press('Home');
  await expect(page.getByTestId('object-item-dense-17-0')).toBeVisible();
  expect(await page.getByTestId('object-list').getByRole('option').count()).toBeLessThan(100);

  const { pan: samples, zoom: zoomSamples, edit: editSamples } = await page.evaluate(async () => {
    const rows = [];
    for (let i = 0; i < 1000; i++) {
      const start = performance.now(); const before = window.__wl_test!.stats();
      await window.__wl_test!.pan(i % 2 ? -1 : 1, 0);
      const after = window.__wl_test!.stats();
      rows.push({ sequence: i, elapsed_ms: performance.now() - start, bridge_cpu_ms: after.bridge_elapsed_ms - before.bridge_elapsed_ms, bbox_bytes: after.bbox_upload_bytes - before.bbox_upload_bytes, submissions: after.gpu_submissions - before.gpu_submissions });
    }
    const zooms = [];
    for (let i = 0; i < 1000; i++) {
      const start = performance.now(); const before = window.__wl_test!.stats();
      await window.__wl_test!.zoom(i % 2 ? 1 / 1.005 : 1.005);
      const after = window.__wl_test!.stats();
      zooms.push({ sequence: i, elapsed_ms: performance.now() - start, bridge_cpu_ms: after.bridge_elapsed_ms - before.bridge_elapsed_ms, bbox_bytes: after.bbox_upload_bytes - before.bbox_upload_bytes, submissions: after.gpu_submissions - before.gpu_submissions });
    }
    const edits = [];
    for (let i = 0; i < 30; i++) {
      const start = performance.now(); const before = window.__wl_test!.stats();
      await window.__wl_test!.editObject(37, i % 2 ? -1 : 1);
      const after = window.__wl_test!.stats();
      edits.push({ sequence: i, elapsed_ms: performance.now() - start, bridge_cpu_ms: after.bridge_elapsed_ms - before.bridge_elapsed_ms, bbox_bytes: after.bbox_upload_bytes - before.bbox_upload_bytes, bbox_calls: after.bbox_upload_calls - before.bbox_upload_calls, submissions: after.gpu_submissions - before.gpu_submissions });
    }
    return { pan: rows, zoom: zooms, edit: edits };
  });
  expect(samples.every((sample) => sample.bbox_bytes === 0 && sample.submissions === 1)).toBe(true);
  expect(zoomSamples.every((sample) => sample.bbox_bytes === 0 && sample.submissions === 1)).toBe(true);
  expect(editSamples.every((sample) => sample.bbox_bytes === 48 && sample.bbox_calls === 1 && sample.submissions === 1)).toBe(true);
  await page.evaluate(() => window.__wl_test!.flush());
  if (count === 2000) {
    const sorted = samples.map((sample) => sample.bridge_cpu_ms).sort((a, b) => a - b);
    expect(sorted[Math.ceil(sorted.length * 0.95) - 1]).toBeLessThanOrEqual(8);
  }
  const idleBefore = await page.evaluate(() => window.__wl_test!.stats().gpu_submissions);
  await page.waitForTimeout(10_000);
  expect(await page.evaluate(() => window.__wl_test!.stats().gpu_submissions)).toBe(idleBefore);
  const budgetBefore = await page.evaluate(() => window.__wl_test!.stats());
  expect(await page.evaluate(() => window.__wl_test!.tryOverBudgetAsset())).toBe(false);
  const rejected = await page.evaluate(() => window.__wl_test!.stats());
  expect(rejected.rejected_resources).toBe(budgetBefore.rejected_resources + 1);
  expect(rejected.live_textures).toBe(budgetBefore.live_textures);
  expect(rejected.gpu_texture_upload_calls).toBe(budgetBefore.gpu_texture_upload_calls);
  const resourceSamples = [];
  for (let index = 0; index < 100; index++) {
    await page.evaluate((asset) => window.__wl_test!.changeAsset(asset), index);
    const stats = await page.evaluate(() => window.__wl_test!.stats());
    resourceSamples.push({ sequence: index, ...stats });
    expect(stats.live_textures).toBe(initial.live_textures);
    expect(stats.live_buffers).toBe(initial.live_buffers);
    expect(stats.buffer_creations - stats.buffer_releases).toBe(initial.live_buffers);
    expect(stats.live_decoded_bitmaps).toBe(0);
    expect(stats.decoded_bitmap_creations).toBe(stats.decoded_bitmap_releases);
    expect(stats.logical_texture_bytes).toBeLessThanOrEqual(2048 * 2048 * 4);
  }
  expect(resourceSamples.at(-1)!.decoded_bitmap_creations - rejected.decoded_bitmap_creations).toBe(100);
  expect(resourceSamples.at(-1)!.gpu_texture_upload_calls - rejected.gpu_texture_upload_calls).toBe(100);
  await cdp.send('HeapProfiler.collectGarbage');
  const heapFinal = (await cdp.send('Performance.getMetrics')).metrics.filter(metric => metric.name === 'JSHeapUsedSize' || metric.name === 'JSHeapTotalSize');
  await cdp.detach();
  const summarize = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) };
  };
  const evidence = {
    count, seed: 17, dimensions: [2048, 2048], initial, edited, rejected,
    samples, pointer_samples: pointerSamples, zoom_samples: zoomSamples, edit_samples: editSamples,
    resources: resourceSamples, quantiles: summarize(samples.map(sample => sample.bridge_cpu_ms)),
    pointer_quantiles: summarize(pointerSamples.map(sample => sample.bridge_cpu_ms)),
    next_paint_boundary_quantiles: summarize(pointerSamples.map(sample => sample.next_paint_boundary_ms)),
    zoom_quantiles: summarize(zoomSamples.map(sample => sample.bridge_cpu_ms)),
    edit_quantiles: summarize(editSamples.map(sample => sample.bridge_cpu_ms)),
    heap: { source: 'Chromium CDP Performance.getMetrics after explicit GC, outside timed actions; V8 JS heap only, excludes physical VRAM/WASM linear memory', initial: heapInitial, final: heapFinal },
    browser: await page.evaluate(() => ({
      user_agent: navigator.userAgent, dpr: devicePixelRatio, viewport: [innerWidth, innerHeight],
      adapter: document.querySelector('[data-testid="gpu-status"]')?.textContent,
    })),
  };
  await mkdir('reports/T28', { recursive: true });
  const filename = `reports/T28/dense-${count}-${Date.now()}.raw.json`;
  await writeFile(filename, JSON.stringify(evidence, null, 2));
  await testInfo.attach('dense-raw-samples', { path: filename, contentType: 'application/json' });
  await page.screenshot({ path: `reports/T28/dense-${count}-${Date.now()}.png`, fullPage: true });
});
