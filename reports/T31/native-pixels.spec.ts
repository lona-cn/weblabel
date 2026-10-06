import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { test as fixtureTest, expect } from '../../tests/e2e/fixtures';
import type { MediaRevision } from '../../packages/contracts/generated/MediaRevision';
import type {} from '../../apps/web/src/features/workbench/perf';
import { measureNativeControls } from './native-controls';

const origin = process.env.WEBLABEL_T31_PIXELS_ORIGIN!;
const run = process.env.WEBLABEL_T31_PIXELS_RUN!;
declare global { interface Window { __t31PixelAdapters: Record<string, unknown>[] } }
const test = fixtureTest.extend({
  adminPage: async ({ page, seededProject }, use) => {
    await page.addInitScript(() => {
      window.__t31PixelAdapters = [];
      const gpu = navigator.gpu;
      if (!gpu) return;
      const request = gpu.requestAdapter.bind(gpu);
      gpu.requestAdapter = async (...args) => {
        const adapter = await request(...args);
        if (adapter) window.__t31PixelAdapters.push({ vendor: adapter.info.vendor, architecture: adapter.info.architecture, isFallbackAdapter: adapter.info.isFallbackAdapter });
        return adapter;
      };
    });
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      const response = await route.fetch({ url: seededProject.apiBaseUrl + url.pathname + url.search, headers: { ...route.request().headers(), origin: seededProject.apiBaseUrl, host: new URL(seededProject.apiBaseUrl).host } });
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
for (const count of [2000, 10000]) test(`${count} native eight controls at four DPRs (visual smoke, not a performance remeasurement)`, async ({ adminPage: page, seededProject }, info) => {
  const observations: unknown[] = [];
  const wasm = await readFile(path.resolve('crates/wasm-bridge/target/weblabel-web-public/wasm/wasm_bridge_bg.wasm'));
  const expectedWasm = createHash('sha256').update(wasm).digest('hex');
  const loaded: string[] = [];
  await page.route('**/wasm/wasm_bridge_bg.wasm', async route => {
    const response = await route.fetch(); loaded.push(createHash('sha256').update(await response.body()).digest('hex')); await route.fulfill({ response });
  });
  const png = await sharp({ create: { width: 2048, height: 2048, channels: 4, background: { r: 28, g: 37, b: 49, alpha: 1 } } }).png().toBuffer();
  expect((await seededProject.api.upload(`/api/projects/${seededProject.project_id}/assets`, png, 'native-controls-2048.png', crypto.randomUUID(), 'image/png')).status).toBe(202);
  expect((await seededProject.api.request('POST', '/internal/test/jobs/drain', {})).status).toBe(200);
  const media = (await seededProject.api.request<{ items: MediaRevision[] }>('GET', `/api/projects/${seededProject.project_id}/assets`)).json.items.find(asset => asset.original_name === 'native-controls-2048.png')!;
  await page.goto(`${origin}/test-harness/dense?count=${count}&seed=17&project_id=${seededProject.project_id}&asset_revision_id=${media.asset_revision_id}`);
  await page.waitForFunction(() => window.__wl_test?.ready === true);
  await expect(page.getByTestId('gpu-status')).toHaveAttribute('data-actual-backend', 'webgpu');
  await expect(page.getByTestId('gpu-status')).toHaveAttribute('data-adapter-kind', 'hardware');
  expect(loaded).toEqual([expectedWasm]);
  const original = await page.evaluate(() => window.__wl_test!.snapshot());
  expect(original.objects).toHaveLength(count);
  await page.evaluate(async () => {
    const hooks = window.__wl_test!, box = hooks.snapshot().objects[37].geometry;
    await hooks.zoom(64 / (Math.min(box.x_max - box.x_min, box.y_max - box.y_min) * hooks.viewport().scale));
    const view = hooks.viewport();
    await hooks.pan(view.css_width / 2 - (box.x_min + box.x_max) / 2 * view.scale - view.tx, view.css_height / 2 - (box.y_min + box.y_max) / 2 * view.scale - view.ty);
  });
  const cdp = await page.context().newCDPSession(page);
  try {
    for (const [width, dpr] of [[1440, 1], [1320, 1.25], [1200, 2], [1440, 3]] as const) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: dpr, mobile: false });
      await page.evaluate(async () => { window.dispatchEvent(new Event('resize')); await window.__wl_test!.zoom(1.005); });
      const view = await page.evaluate(() => window.__wl_test!.viewport());
      expect(await page.evaluate(() => window.__wl_test!.snapshot())).toEqual(original);
      observations.push({ dpr, view, ...await measureNativeControls(page, info, original.objects[37].geometry, view, dpr) });
      await writeFile(path.join(run, `native-controls-${count}.json`), JSON.stringify({ count, seed: 17, canonical: [2048, 2048], expected_wasm_sha256: expectedWasm, loaded_wasm_sha256: loaded, adapters: await page.evaluate(() => window.__t31PixelAdapters), observations }, null, 2));
    }
  } finally { await cdp.detach(); }
});
