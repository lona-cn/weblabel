import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { test as fixtureTest, expect } from '../e2e/fixtures';
import type { Page } from '@playwright/test';
import type { MediaRevision } from '../../packages/contracts/generated/MediaRevision';
import type { T28Stats } from '../../apps/web/src/features/workbench/perf';
import { gate, hardwareKind } from '../../scripts/verify-gpu.mjs';

interface NativeResourceCounts { buffers: { live: number; created: number; released: number }; textures: { live: number; created: number; released: number } }
interface Observation { devices: GPUDevice[]; device_creations: number; resources: NativeResourceCounts; adapters: Record<string, unknown>[]; raf_cpu_ms: number; losses: { reason: string; message: string }[]; submissions: number; zero_size_submissions: number; errors: string[] }
declare global { interface Window { __t31: Observation; __t31TaskDuration(): Promise<number> } }
const run = process.env.WEBLABEL_T31_RUN_DIR!;
const origin = process.env.WEBLABEL_T31_ORIGIN!;

async function instrument(page: Page) {
  await page.addInitScript(() => {
    const observation: Observation = { devices: [], device_creations: 0, resources: { buffers: { live: 0, created: 0, released: 0 }, textures: { live: 0, created: 0, released: 0 } }, adapters: [], raf_cpu_ms: 0, losses: [], submissions: 0, zero_size_submissions: 0, errors: [] };
    window.__t31 = observation;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => raf(timestamp => { const start = performance.now(); try { callback(timestamp); } finally { observation.raf_cpu_ms += performance.now() - start; } });
    const gpu = navigator.gpu;
    if (!gpu) return;
    const adapterRequest = gpu.requestAdapter.bind(gpu);
    gpu.requestAdapter = async (...args) => {
      const adapter = await adapterRequest(...args);
      if (!adapter) return adapter;
      observation.adapters.push({ vendor: adapter.info.vendor || 'unknown', architecture: adapter.info.architecture || 'unknown', device: adapter.info.device || 'unknown', description: adapter.info.description || 'unknown', isFallbackAdapter: adapter.info.isFallbackAdapter, timestamp_query_supported: adapter.features.has('timestamp-query') });
      const requestDevice = adapter.requestDevice.bind(adapter);
      adapter.requestDevice = async (...deviceArgs) => {
        const device = await requestDevice(...deviceArgs);
        observation.devices.push(device);
        observation.device_creations++;
        const ownedReleases = new Set<() => void>();
        function track<T extends { destroy(): void }>(resource: T, kind: keyof NativeResourceCounts): T {
          const counts = observation.resources[kind];
          counts.created++; counts.live++;
          const destroy = resource.destroy.bind(resource);
          let released = false;
          const release = () => {
            if (released) return;
            released = true; counts.live--; counts.released++;
            ownedReleases.delete(release);
          };
          ownedReleases.add(release);
          resource.destroy = () => { destroy(); release(); };
          return resource;
        }
        const createBuffer = device.createBuffer.bind(device);
        device.createBuffer = (...args) => track(createBuffer(...args), 'buffers');
        const createTexture = device.createTexture.bind(device);
        device.createTexture = (...args) => track(createTexture(...args), 'textures');
        device.lost.then(info => {
          observation.losses.push({ reason: info.reason, message: info.message });
          // Device loss/destruction invalidates its outstanding native resources.
          for (const release of ownedReleases) release();
          observation.devices.splice(observation.devices.indexOf(device), 1);
        });
        // Observe the actual native queue; never fake a device, adapter or submission.
        const native = device;
        const submit = native.queue.submit.bind(native.queue);
        native.queue.submit = (...submitArgs) => {
          observation.submissions++;
          const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="annotation-canvas"]');
          if (canvas) { const size = canvas.getBoundingClientRect(); if (size.width === 0 || size.height === 0) observation.zero_size_submissions++; }
          return submit(...submitArgs);
        };
        native.addEventListener('uncapturederror', event => observation.errors.push(event.error?.message ?? 'unknown GPU error'));
        return device;
      };
      return adapter;
    };
  });
}
const test = fixtureTest.extend({
  adminPage: async ({ page, seededProject }, use) => {
    await instrument(page);
    await page.route('**/api/**', async route => {
      const target = new URL(route.request().url());
      const response = await route.fetch({ url: seededProject.apiBaseUrl + target.pathname + target.search, headers: { ...route.request().headers(), origin: seededProject.apiBaseUrl, host: new URL(seededProject.apiBaseUrl).host } });
      await route.fulfill({ response });
    });
    await page.goto(origin);
    await page.getByTestId('login-username').fill(seededProject.login.username);
    await page.getByTestId('login-password').fill(seededProject.login.password);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('login-submit')).toHaveCount(0);
    await use(page);
  },
});

for (const count of [2000, 10000] as const) test(`${count} fixed release WASM hardware: four warmed 1000-sample scenarios and lifecycle`, async ({ adminPage: page, seededProject }, info) => {
  const evidence: Record<string, unknown> = { count, seed: 17, canonical_dimensions: [2048, 2048], warmup_per_scenario: 40, sample_count_per_scenario: 1000, scenarios: {} };
  const save = () => writeFile(path.join(run, `samples-${count}.json`), JSON.stringify(evidence, null, 2));
  try {
    const loadedWasm: string[] = [];
    await page.route('**/wasm/wasm_bridge_bg.wasm', async route => {
      const response = await route.fetch();
      loadedWasm.push(createHash('sha256').update(await response.body()).digest('hex'));
      await route.fulfill({ response });
    });
    const png = await sharp({ create: { width: 2048, height: 2048, channels: 4, background: { r: 28, g: 37, b: 49, alpha: 1 } } }).png().toBuffer();
    for (const name of ['a', 'b']) expect((await seededProject.api.upload(`/api/projects/${seededProject.project_id}/assets`, png, `t31-${name}.png`, crypto.randomUUID(), 'image/png')).status).toBe(202);
    expect((await seededProject.api.request('POST', '/internal/test/jobs/drain', {})).status).toBe(200);
    const assets = (await seededProject.api.request<{ items: MediaRevision[] }>('GET', `/api/projects/${seededProject.project_id}/assets`)).json.items;
    const media = assets.find(asset => asset.original_name === 't31-a.png')!;
    await page.goto(`${origin}/test-harness/dense?count=${count}&seed=17&project_id=${seededProject.project_id}&asset_revision_id=${media.asset_revision_id}`);
    await page.waitForFunction(() => window.__wl_test?.ready === true || document.querySelector('[role="alert"]') !== null);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByTestId('gpu-status')).toHaveAttribute('data-device-state', 'ready');
    await expect(page.getByTestId('gpu-status')).toHaveAttribute('data-actual-backend', 'webgpu');
    const adapter = await page.evaluate(() => window.__t31.adapters);
    evidence.adapters = adapter;
    await save();
    expect(adapter.length).toBeGreaterThan(0);
    expect(hardwareKind(adapter.at(-1))).toBe('hardware');
    await expect(page.getByTestId('gpu-status')).toHaveAttribute('data-adapter-kind', 'hardware');
    const environment = JSON.parse(await readFile(path.join(run, 'environment.json'), 'utf8'));
    evidence.loaded_wasm_sha256 = loadedWasm;
    expect(loadedWasm).toEqual([environment.wasm.sha256]);
    const target = await page.getByTestId('annotation-canvas').evaluate((canvas: HTMLCanvasElement) => ({ css: { width: canvas.getBoundingClientRect().width, height: canvas.getBoundingClientRect().height }, backing: { width: canvas.width, height: canvas.height }, viewport: { width: innerWidth, height: innerHeight }, dpr: devicePixelRatio, browser_user_agent: navigator.userAgent }));
    Object.assign(environment, { browser: { version: page.context().browser()!.version(), user_agent: target.browser_user_agent }, gpu: adapter, dpr: target.dpr, target_canvas: target });
    await writeFile(path.join(run, 'environment.json'), JSON.stringify(environment, null, 2));
    evidence.target = target;
    evidence.timestamp_query = await page.evaluate(() => {
      const enabled = window.__t31.devices.at(-1)!.features.has('timestamp-query');
      return { adapter_supported: window.__t31.adapters.at(-1)!.timestamp_query_supported, enabled_on_application_device: enabled, measured: false, reason: enabled ? 'Renderer exposes no timestamp results; no GPU duration claimed.' : 'Timestamp-query is not enabled on the actual application device; CPU time is not GPU time.' };
    });
    const original = await page.evaluate(() => window.__wl_test!.snapshot());
    expect(original.objects).toHaveLength(count);
    expect(original.coordinate_space).toEqual({ type: 'canonical_image_pixels', width: 2048, height: 2048 });
    expect(await page.getByTestId('object-list').getByRole('option').count()).toBeLessThan(100);
    expect(await page.getByTestId('canvas-label').count()).toBeLessThanOrEqual(100);
    await page.screenshot({ path: info.outputPath('loaded-hardware.png'), fullPage: true });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    await page.exposeBinding('__t31TaskDuration', async () => {
      const metrics = (await cdp.send('Performance.getMetrics')).metrics;
      const duration = metrics.find(metric => metric.name === 'TaskDuration');
      if (!duration) throw new Error('Chromium does not expose main-thread TaskDuration');
      return duration.value * 1000;
    });
    evidence.heap_before = (await cdp.send('Performance.getMetrics')).metrics.filter(metric => metric.name.startsWith('JSHeap'));
    const before = await page.evaluate(() => ({ generation: window.__wl_test!.generation(), saves: window.__wl_test!.saveCount(), validation: window.__wl_test!.validationInputObjects(), serialization: window.__wl_test!.serializedInputObjects() }));
    const rect = (await page.getByTestId('annotation-canvas').boundingBox())!;
    await page.evaluate(() => window.__wl_test!.tool('box'));
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    for (const scenario of ['pointer_drag', 'pan', 'zoom', 'committed_edit'] as const) {
      if (scenario === 'pan') {
        await page.getByTestId('annotation-canvas').dispatchEvent('pointercancel', { pointerId: 1 });
        await page.mouse.up();
        expect(await page.evaluate(() => ({ generation: window.__wl_test!.generation(), saves: window.__wl_test!.saveCount(), validation: window.__wl_test!.validationInputObjects(), serialization: window.__wl_test!.serializedInputObjects() }))).toEqual(before);
      }
      const rows = await page.evaluate(async ({ scenario, x, y }) => {
        const hooks = window.__wl_test!;
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="annotation-canvas"]')!;
        const rows = [];
        for (let index = -40; index < 1000; index++) {
          const sequence = index + 40;
          const taskBefore = await window.__t31TaskDuration();
          const previous = hooks.stats();
          const nativeBefore = window.__t31.submissions;
          const rafCpu = window.__t31.raf_cpu_ms;
          const started = performance.now();
          let settled: Promise<void> | undefined;
          if (scenario === 'pointer_drag') canvas.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: x + 2 + sequence % 80, clientY: y + 2 + (sequence % 80) / 2, buttons: 1, button: 0, bubbles: true }));
          if (scenario === 'pan') settled = hooks.pan(sequence % 2 ? -1 : 1, 0);
          if (scenario === 'zoom') settled = hooks.zoom(sequence % 2 ? 1 / 1.005 : 1.005);
          if (scenario === 'committed_edit') settled = hooks.editObject(37, sequence % 2 ? -1 : 1);
          const synchronous = performance.now() - started;
          if (settled) await settled;
          else await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          const elapsed = performance.now() - started;
          const taskAfter = await window.__t31TaskDuration();
          const after = hooks.stats();
          if (index >= 0) rows.push({ sequence: index, cpu_ms: Math.max(taskAfter - taskBefore, synchronous + window.__t31.raf_cpu_ms - rafCpu), task_cpu_ms: taskAfter - taskBefore, synchronous_cpu_ms: synchronous, raf_cpu_ms: window.__t31.raf_cpu_ms - rafCpu, bridge_cpu_ms: after.bridge_elapsed_ms - previous.bridge_elapsed_ms, double_raf_ms: elapsed, submissions: after.gpu_submissions - previous.gpu_submissions, native_submissions: window.__t31.submissions - nativeBefore, bbox_upload_bytes: after.bbox_upload_bytes - previous.bbox_upload_bytes, wasm_binary_bytes: after.js_wasm_binary_bytes - previous.js_wasm_binary_bytes });
        }
        return rows;
      }, { scenario, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
      (evidence.scenarios as Record<string, unknown>)[scenario] = rows;
      await save(); // Preserve every sample before any threshold/invariant assertion.
      expect(rows).toHaveLength(1000);
      expect(rows.every(row => row.submissions === 1 && row.native_submissions === 1 && row.wasm_binary_bytes === 0)).toBe(true);
      if (scenario === 'pan' || scenario === 'zoom') expect(rows.every(row => row.bbox_upload_bytes === 0)).toBe(true);
    }
    const performanceResult = gate(count, evidence.scenarios);
    evidence.performance = performanceResult; await save();
    expect.soft(performanceResult.failures, 'Unchanged target; refer threshold failures to T28, preserve all raw samples').toEqual([]);
    await page.evaluate(() => window.__wl_test!.flush());
    expect((await page.evaluate(() => window.__wl_test!.snapshot())).objects).toEqual(original.objects);
    const idleBefore = await page.evaluate(() => ({ stats: window.__wl_test!.stats(), native_submissions: window.__t31.submissions }));
    await page.waitForTimeout(10_000);
    const idleAfter = await page.evaluate(() => ({ stats: window.__wl_test!.stats(), native_submissions: window.__t31.submissions }));
    evidence.idle = { seconds: 10, before: idleBefore, after: idleAfter }; await save();
    expect(idleAfter.native_submissions).toBe(idleBefore.native_submissions);
    expect(idleAfter.stats.gpu_submissions).toBe(idleBefore.stats.gpu_submissions);
    const otherIndex = [media, ...assets.filter(asset => asset !== media)].findIndex(asset => asset.original_name === 't31-b.png');
    // Alternate the two actual 2048 images; resources measured after every switch.
    const resources: T28Stats[] = [];
    const nativeResources: { resources: NativeResourceCounts; live_devices: number; created_devices: number }[] = [];
    for (let index = 0; index < 100; index++) {
      await page.evaluate(index => window.__wl_test!.changeAsset(index), index % 2 ? 0 : otherIndex);
      resources.push(await page.evaluate(() => window.__wl_test!.stats()));
      nativeResources.push(await page.evaluate(() => ({ resources: structuredClone(window.__t31.resources), live_devices: window.__t31.devices.length, created_devices: window.__t31.device_creations })));
    }
    evidence.resources = resources; await save();
    evidence.native_resources = nativeResources; await save();
    expect(nativeResources.every(row => row.live_devices === 1 && row.resources.buffers.live === nativeResources[0].resources.buffers.live && row.resources.textures.live === nativeResources[0].resources.textures.live)).toBe(true);
    expect(resources.every(row => row.live_textures === resources[0].live_textures && row.live_buffers === resources[0].live_buffers && row.logical_texture_bytes === resources[0].logical_texture_bytes && row.live_decoded_bitmaps === 0)).toBe(true);
    await cdp.send('HeapProfiler.collectGarbage');
    evidence.heap_after = (await cdp.send('Performance.getMetrics')).metrics.filter(metric => metric.name.startsWith('JSHeap'));
    const snapshot = await page.evaluate(() => window.__wl_test!.snapshot());
    const canonical = snapshot.objects[37].geometry;
    await page.evaluate(async () => {
      const hooks = window.__wl_test!, box = hooks.snapshot().objects[37].geometry;
      await hooks.zoom(10);
      const view = hooks.viewport();
      await hooks.pan(view.css_width / 2 - (box.x_min + box.x_max) / 2 * view.scale - view.tx, view.css_height / 2 - (box.y_min + box.y_max) / 2 * view.scale - view.ty);
    });
    // Actual resize and DPR transitions; image coordinates must not absorb DPR.
    const projections = [];
    for (const [width, dpr] of [[1440, 1], [1320, 1.25], [1200, 2], [1440, 3]] as const) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: dpr, mobile: false });
      await page.evaluate(async () => { window.dispatchEvent(new Event('resize')); await window.__wl_test!.select('dense-17-37'); await window.__wl_test!.zoom(1.005); });
      const projection = await page.evaluate(() => { const hooks = window.__wl_test!, box = hooks.snapshot().objects[37].geometry, view = hooks.viewport(), label = hooks.labels().find(label => label.object_id === 'dense-17-37')!; return { box, view, label, dpr: devicePixelRatio }; });
      expect(projection.box).toEqual(canonical);
      expect(projection.dpr).toBe(dpr);
      expect(await page.evaluate(() => window.__wl_test!.snapshot())).toEqual(snapshot);
      expect(Math.abs(projection.label.x_css - (canonical.x_min * projection.view.scale + projection.view.tx))).toBeLessThanOrEqual(0.5);
      expect(Math.abs(projection.label.y_css - (canonical.y_min * projection.view.scale + projection.view.ty))).toBeLessThanOrEqual(0.5);
      const surface = (await page.getByTestId('annotation-canvas').boundingBox())!;
      const center = { x: surface.x + (canonical.x_min + canonical.x_max) / 2 * projection.view.scale + projection.view.tx, y: surface.y + canonical.y_max * projection.view.scale + projection.view.ty };
      const clip = { x: Math.floor(center.x - 8), y: Math.floor(center.y - 8), width: 16, height: 16 };
      // Isolate GPU pixels: a small box's DOM text otherwise covers the control.
      const labelVisibility = await page.getByTestId('annotation-canvas').evaluate(canvas => {
        const labels = canvas.nextElementSibling;
        if (!(labels instanceof HTMLElement) || labels.getAttribute('aria-hidden') !== 'true') throw new Error('Expected actual CanvasView label overlay');
        const previous = labels.style.visibility;
        labels.style.visibility = 'hidden';
        return previous;
      });
      const selected = await page.screenshot({ path: info.outputPath(`handle-selected-dpr-${dpr}.png`), clip, scale: 'css' });
      await page.evaluate(() => window.__wl_test!.select('dense-17-0'));
      const unselected = await page.screenshot({ path: info.outputPath(`handle-unselected-dpr-${dpr}.png`), clip, scale: 'css' });
      await page.getByTestId('annotation-canvas').evaluate((canvas, visibility) => {
        const labels = canvas.nextElementSibling;
        if (!(labels instanceof HTMLElement)) throw new Error('Label overlay detached during capture');
        labels.style.visibility = visibility;
      }, labelVisibility);
      const activePixels = await sharp(selected).removeAlpha().raw().toBuffer();
      const inactivePixels = await sharp(unselected).removeAlpha().raw().toBuffer();
      const changed: { x: number; y: number }[] = [];
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const offset = (y * 16 + x) * 3;
        if ([0, 1, 2].some(channel => Math.abs(activePixels[offset + channel] - inactivePixels[offset + channel]) > 20)) changed.push({ x, y });
      }
      const handle = changed.length ? { width_css: Math.max(...changed.map(pixel => pixel.x)) - Math.min(...changed.map(pixel => pixel.x)) + 1, height_css: Math.max(...changed.map(pixel => pixel.y)) - Math.min(...changed.map(pixel => pixel.y)) + 1 } : { width_css: 0, height_css: 0 };
      projections.push({ ...projection, handle, measured_control: 'bottom-middle', dom_labels_excluded_from_gpu_crop: true });
      evidence.projections = projections; await save();
      expect.soft(Math.abs(handle.width_css - 8), 'Actual selected control must be 8 CSS px at every DPR/zoom').toBeLessThanOrEqual(1);
      expect.soft(Math.abs(handle.height_css - 8), 'Actual selected control must be 8 CSS px at every DPR/zoom').toBeLessThanOrEqual(1);
      await page.evaluate(() => window.__wl_test!.select('dense-17-37'));
      await page.screenshot({ path: info.outputPath(`projection-dpr-${dpr}.png`), scale: 'css' });
    }
    evidence.projections = projections;
    const canvas = page.getByTestId('annotation-canvas');
    await canvas.evaluate(canvas => { canvas.style.width = '0px'; canvas.style.height = '0px'; });
    await page.waitForTimeout(300);
    const zeroBefore = await page.evaluate(() => window.__t31.submissions);
    await page.evaluate(async () => { await window.__wl_test!.pan(1, 0); await window.__wl_test!.zoom(1.005); });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__t31.submissions)).toBe(zeroBefore);
    expect(await page.evaluate(() => window.__t31.zero_size_submissions)).toBe(0);
    await canvas.evaluate(canvas => { canvas.style.width = '100%'; canvas.style.height = '100%'; });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__t31.submissions)).toBeGreaterThan(zeroBefore);
    const lossBefore = await page.evaluate(() => ({ snapshot: window.__wl_test!.snapshot(), generation: window.__wl_test!.generation(), devices: window.__t31.device_creations, losses: window.__t31.losses.length }));
    await page.evaluate(() => window.__t31.devices.at(-1)!.destroy());
    await expect.poll(() => page.evaluate(() => window.__t31.losses.length)).toBe(lossBefore.losses + 1);
    await expect.poll(() => page.evaluate(() => window.__t31.device_creations)).toBe(lossBefore.devices + 1);
    await expect(page.getByTestId('gpu-status')).toHaveAttribute('data-device-state', 'ready');
    expect(await page.evaluate(() => window.__wl_test!.snapshot())).toEqual(lossBefore.snapshot);
    expect(await page.evaluate(() => window.__wl_test!.generation())).toBe(lossBefore.generation);
    const recoveryBefore = await page.evaluate(() => window.__t31.submissions);
    await page.evaluate(() => window.__wl_test!.pan(-1, 0));
    expect(await page.evaluate(() => window.__t31.submissions)).toBe(recoveryBefore + 1);
    evidence.loss = await page.evaluate(() => ({ losses: window.__t31.losses, errors: window.__t31.errors, native_submissions: window.__t31.submissions, zero_size_submissions: window.__t31.zero_size_submissions }));
    expect(await page.evaluate(() => window.__t31.errors)).toEqual([]);
    await page.screenshot({ path: info.outputPath('recovered-hardware.png'), fullPage: true });
    const entries: { live_devices: number; resources: NativeResourceCounts; stats: T28Stats }[] = [];
    for (let index = 0; index < 5; index++) {
      await page.goto(`${origin}/?project_id=${seededProject.project_id}`);
      await expect(page.getByTestId('asset-grid')).toBeVisible();
      await page.goto(`${origin}/test-harness/dense?count=${count}&seed=17&project_id=${seededProject.project_id}&asset_revision_id=${media.asset_revision_id}`);
      await page.waitForFunction(() => window.__wl_test?.ready === true);
      await expect(page.getByTestId('gpu-status')).toHaveAttribute('data-device-state', 'ready');
      entries.push(await page.evaluate(() => ({ live_devices: window.__t31.devices.length, resources: structuredClone(window.__t31.resources), stats: window.__wl_test!.stats() })));
    }
    evidence.repeated_workbench_entries = entries; await save();
    expect(entries.every(row => row.live_devices === 1 && row.resources.buffers.live === entries[0].resources.buffers.live && row.resources.textures.live === entries[0].resources.textures.live && row.stats.live_decoded_bitmaps === 0)).toBe(true);
  } finally { await save(); }
});

test('software and unknown adapters cannot pass the hardware classifier (not hardware evidence)', async () => {
  expect(hardwareKind({ vendor: 'google', architecture: 'swiftshader', isFallbackAdapter: false })).toBe('software');
  expect(hardwareKind({ vendor: 'nvidia', isFallbackAdapter: true })).toBe('software');
  expect(hardwareKind({ vendor: '', architecture: '' })).toBe('unknown');
});
