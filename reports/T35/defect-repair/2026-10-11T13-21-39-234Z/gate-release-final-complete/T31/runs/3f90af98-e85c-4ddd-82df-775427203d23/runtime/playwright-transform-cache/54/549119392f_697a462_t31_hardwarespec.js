// 28f0efa7f6ad3d55d154a27b1b3a023739e6fa73
import { measureNativeControls } from '../../reports/T31/native-controls';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { test as fixtureTest, expect, waitForCanonicalAssets } from '../e2e/fixtures';
import { gate, hardwareKind } from '../../scripts/verify-gpu.mjs';
const run = process.env.WEBLABEL_T31_RUN_DIR;
const origin = process.env.WEBLABEL_T31_ORIGIN;
async function instrument(page) {
  await page.addInitScript(() => {
    const observation = {
      devices: [],
      device_creations: 0,
      resources: {
        buffers: {
          live: 0,
          created: 0,
          released: 0
        },
        textures: {
          live: 0,
          created: 0,
          released: 0
        }
      },
      adapters: [],
      raf_cpu_ms: 0,
      losses: [],
      submissions: 0,
      zero_size_submissions: 0,
      errors: []
    };
    window.__t31 = observation;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => raf(timestamp => {
      const start = performance.now();
      try {
        callback(timestamp);
      } finally {
        observation.raf_cpu_ms += performance.now() - start;
      }
    });
    const gpu = navigator.gpu;
    if (!gpu) return;
    const adapterRequest = gpu.requestAdapter.bind(gpu);
    gpu.requestAdapter = async (...args) => {
      const adapter = await adapterRequest(...args);
      if (!adapter) return adapter;
      observation.adapters.push({
        vendor: adapter.info.vendor || 'unknown',
        architecture: adapter.info.architecture || 'unknown',
        device: adapter.info.device || 'unknown',
        description: adapter.info.description || 'unknown',
        isFallbackAdapter: adapter.info.isFallbackAdapter,
        timestamp_query_supported: adapter.features.has('timestamp-query')
      });
      const requestDevice = adapter.requestDevice.bind(adapter);
      adapter.requestDevice = async (...deviceArgs) => {
        const device = await requestDevice(...deviceArgs);
        observation.devices.push(device);
        observation.device_creations++;
        const ownedReleases = new Set();
        function track(resource, kind) {
          const counts = observation.resources[kind];
          counts.created++;
          counts.live++;
          const destroy = resource.destroy.bind(resource);
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            counts.live--;
            counts.released++;
            ownedReleases.delete(release);
          };
          ownedReleases.add(release);
          resource.destroy = () => {
            destroy();
            release();
          };
          return resource;
        }
        const createBuffer = device.createBuffer.bind(device);
        device.createBuffer = (...args) => track(createBuffer(...args), 'buffers');
        const createTexture = device.createTexture.bind(device);
        device.createTexture = (...args) => track(createTexture(...args), 'textures');
        device.lost.then(info => {
          observation.losses.push({
            reason: info.reason,
            message: info.message
          });
          // Device loss/destruction invalidates its outstanding native resources.
          for (const release of ownedReleases) release();
          observation.devices.splice(observation.devices.indexOf(device), 1);
        });
        // Observe the actual native queue; never fake a device, adapter or submission.
        const native = device;
        const submit = native.queue.submit.bind(native.queue);
        native.queue.submit = (...submitArgs) => {
          observation.submissions++;
          const canvas = document.querySelector('[data-testid="annotation-canvas"]');
          if (canvas) {
            const size = canvas.getBoundingClientRect();
            if (size.width === 0 || size.height === 0) observation.zero_size_submissions++;
          }
          return submit(...submitArgs);
        };
        native.addEventListener('uncapturederror', event => {
          var _event$error$message, _event$error;
          return observation.errors.push((_event$error$message = (_event$error = event.error) === null || _event$error === void 0 ? void 0 : _event$error.message) !== null && _event$error$message !== void 0 ? _event$error$message : 'unknown GPU error');
        });
        return device;
      };
      return adapter;
    };
  });
}
const test = fixtureTest.extend({
  adminPage: async ({
    page,
    seededProject
  }, use) => {
    await instrument(page);
    await page.route('**/api/**', async route => {
      const target = new URL(route.request().url());
      const response = await route.fetch({
        url: seededProject.apiBaseUrl + target.pathname + target.search,
        headers: {
          ...route.request().headers(),
          origin: seededProject.apiBaseUrl,
          host: new URL(seededProject.apiBaseUrl).host
        }
      });
      await route.fulfill({
        response
      });
    });
    await page.goto(origin);
    await page.getByTestId('login-username').fill(seededProject.login.username);
    await page.getByTestId('login-password').fill(seededProject.login.password);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('login-submit')).toHaveCount(0);
    await use(page);
  }
});
for (const count of [2000, 10000]) test(`${count} fixed release WASM hardware: four warmed 1000-sample scenarios and lifecycle`, async ({
  adminPage: page,
  seededProject
}, info) => {
  const evidence = {
    count,
    seed: 17,
    canonical_dimensions: [2048, 2048],
    warmup_per_scenario: 40,
    sample_count_per_scenario: 1000,
    scenarios: {}
  };
  const save = () => writeFile(path.join(run, `samples-${count}.json`), JSON.stringify(evidence, null, 2));
  try {
    const loadedWasm = [];
    await page.route('**/wasm/wasm_bridge_bg.wasm', async route => {
      const response = await route.fetch();
      loadedWasm.push(createHash('sha256').update(await response.body()).digest('hex'));
      await route.fulfill({
        response
      });
    });
    const png = await sharp({
      create: {
        width: 2048,
        height: 2048,
        channels: 4,
        background: {
          r: 28,
          g: 37,
          b: 49,
          alpha: 1
        }
      }
    }).png().toBuffer();
    for (const name of ['a', 'b']) expect((await seededProject.api.upload(`/api/projects/${seededProject.project_id}/assets`, png, `t31-${name}.png`, crypto.randomUUID(), 'image/png')).status).toBe(202);
    const assets = await waitForCanonicalAssets(seededProject.api, seededProject.project_id, 24);
    const canonicalMedia = ['a', 'b'].map(name => {
      const asset = assets.find(item => item.original_name === `t31-${name}.png`);
      if (!asset) throw new Error(`T31 canonical image ${name} was not imported`);
      expect(asset).toMatchObject({
        original_name: `t31-${name}.png`,
        canonical_width: 2048,
        canonical_height: 2048
      });
      expect(typeof asset.asset_revision_id).toBe('string');
      return asset;
    });
    evidence.canonical_media = canonicalMedia;
    const media = canonicalMedia[0];
    await page.goto(`${origin}/test-harness/dense?count=${count}&seed=17&project_id=${seededProject.project_id}&asset_revision_id=${media.asset_revision_id}`);
    await page.waitForFunction(() => {
      var _window$__wl_test;
      return ((_window$__wl_test = window.__wl_test) === null || _window$__wl_test === void 0 ? void 0 : _window$__wl_test.ready) === true || document.querySelector('[role="alert"]') !== null;
    });
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
    const target = await page.getByTestId('annotation-canvas').evaluate(canvas => ({
      css: {
        width: canvas.getBoundingClientRect().width,
        height: canvas.getBoundingClientRect().height
      },
      backing: {
        width: canvas.width,
        height: canvas.height
      },
      viewport: {
        width: innerWidth,
        height: innerHeight
      },
      dpr: devicePixelRatio,
      browser_user_agent: navigator.userAgent
    }));
    Object.assign(environment, {
      browser: {
        version: page.context().browser().version(),
        user_agent: target.browser_user_agent
      },
      gpu: adapter,
      dpr: target.dpr,
      target_canvas: target
    });
    await writeFile(path.join(run, 'environment.json'), JSON.stringify(environment, null, 2));
    evidence.target = target;
    evidence.timestamp_query = await page.evaluate(() => {
      const enabled = window.__t31.devices.at(-1).features.has('timestamp-query');
      return {
        adapter_supported: window.__t31.adapters.at(-1).timestamp_query_supported,
        enabled_on_application_device: enabled,
        measured: false,
        reason: enabled ? 'Renderer exposes no timestamp results; no GPU duration claimed.' : 'Timestamp-query is not enabled on the actual application device; CPU time is not GPU time.'
      };
    });
    const original = await page.evaluate(() => window.__wl_test.snapshot());
    expect(original.objects).toHaveLength(count);
    expect(original.coordinate_space).toEqual({
      type: 'canonical_image_pixels',
      width: 2048,
      height: 2048
    });
    expect(await page.getByTestId('object-list').getByRole('option').count()).toBeLessThan(100);
    expect(await page.getByTestId('canvas-label').count()).toBeLessThanOrEqual(100);
    await page.screenshot({
      path: info.outputPath('loaded-hardware.png'),
      fullPage: true
    });
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
    const before = await page.evaluate(() => ({
      generation: window.__wl_test.generation(),
      saves: window.__wl_test.saveCount(),
      validation: window.__wl_test.validationInputObjects(),
      serialization: window.__wl_test.serializedInputObjects()
    }));
    const rect = await page.getByTestId('annotation-canvas').boundingBox();
    await page.evaluate(() => window.__wl_test.tool('box'));
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    for (const scenario of ['pointer_drag', 'pan', 'zoom', 'committed_edit']) {
      if (scenario === 'pan') {
        await page.getByTestId('annotation-canvas').dispatchEvent('pointercancel', {
          pointerId: 1
        });
        await page.mouse.up();
        expect(await page.evaluate(() => ({
          generation: window.__wl_test.generation(),
          saves: window.__wl_test.saveCount(),
          validation: window.__wl_test.validationInputObjects(),
          serialization: window.__wl_test.serializedInputObjects()
        }))).toEqual(before);
      }
      const rows = await page.evaluate(async ({
        scenario,
        x,
        y
      }) => {
        const hooks = window.__wl_test;
        const canvas = document.querySelector('[data-testid="annotation-canvas"]');
        const rows = [];
        for (let index = -40; index < 1000; index++) {
          const sequence = index + 40;
          const taskBefore = await window.__t31TaskDuration();
          const previous = hooks.stats();
          const nativeBefore = window.__t31.submissions;
          const rafCpu = window.__t31.raf_cpu_ms;
          const started = performance.now();
          let settled;
          if (scenario === 'pointer_drag') canvas.dispatchEvent(new PointerEvent('pointermove', {
            pointerId: 1,
            clientX: x + 2 + sequence % 80,
            clientY: y + 2 + sequence % 80 / 2,
            buttons: 1,
            button: 0,
            bubbles: true
          }));
          if (scenario === 'pan') settled = hooks.pan(sequence % 2 ? -1 : 1, 0);
          if (scenario === 'zoom') settled = hooks.zoom(sequence % 2 ? 1 / 1.005 : 1.005);
          if (scenario === 'committed_edit') settled = hooks.editObject(37, sequence % 2 ? -1 : 1);
          const synchronous = performance.now() - started;
          if (settled) await settled;else await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          const elapsed = performance.now() - started;
          const taskAfter = await window.__t31TaskDuration();
          const after = hooks.stats();
          if (index >= 0) rows.push({
            sequence: index,
            cpu_ms: Math.max(taskAfter - taskBefore, synchronous + window.__t31.raf_cpu_ms - rafCpu),
            task_cpu_ms: taskAfter - taskBefore,
            synchronous_cpu_ms: synchronous,
            raf_cpu_ms: window.__t31.raf_cpu_ms - rafCpu,
            bridge_cpu_ms: after.bridge_elapsed_ms - previous.bridge_elapsed_ms,
            double_raf_ms: elapsed,
            submissions: after.gpu_submissions - previous.gpu_submissions,
            native_submissions: window.__t31.submissions - nativeBefore,
            bbox_upload_bytes: after.bbox_upload_bytes - previous.bbox_upload_bytes,
            wasm_binary_bytes: after.js_wasm_binary_bytes - previous.js_wasm_binary_bytes
          });
        }
        return rows;
      }, {
        scenario,
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2
      });
      evidence.scenarios[scenario] = rows;
      await save(); // Preserve every sample before any threshold/invariant assertion.
      expect(rows).toHaveLength(1000);
      expect(rows.every(row => row.submissions === 1 && row.native_submissions === 1 && row.wasm_binary_bytes === 0)).toBe(true);
      if (scenario === 'pan' || scenario === 'zoom') expect(rows.every(row => row.bbox_upload_bytes === 0)).toBe(true);
    }
    const performanceResult = gate(count, evidence.scenarios);
    evidence.performance = performanceResult;
    await save();
    expect.soft(performanceResult.failures, 'Unchanged target; refer threshold failures to T28, preserve all raw samples').toEqual([]);
    await page.evaluate(() => window.__wl_test.flush());
    expect((await page.evaluate(() => window.__wl_test.snapshot())).objects).toEqual(original.objects);
    const idleBefore = await page.evaluate(() => ({
      stats: window.__wl_test.stats(),
      native_submissions: window.__t31.submissions
    }));
    await page.waitForTimeout(10000);
    const idleAfter = await page.evaluate(() => ({
      stats: window.__wl_test.stats(),
      native_submissions: window.__t31.submissions
    }));
    evidence.idle = {
      seconds: 10,
      before: idleBefore,
      after: idleAfter
    };
    await save();
    expect(idleAfter.native_submissions).toBe(idleBefore.native_submissions);
    expect(idleAfter.stats.gpu_submissions).toBe(idleBefore.stats.gpu_submissions);
    const otherIndex = [media, ...assets.filter(asset => asset !== media)].findIndex(asset => asset.original_name === 't31-b.png');
    // Alternate the two actual 2048 images; resources measured after every switch.
    const resources = [];
    const nativeResources = [];
    for (let index = 0; index < 100; index++) {
      await page.evaluate(index => window.__wl_test.changeAsset(index), index % 2 ? 0 : otherIndex);
      resources.push(await page.evaluate(() => window.__wl_test.stats()));
      nativeResources.push(await page.evaluate(() => ({
        resources: structuredClone(window.__t31.resources),
        live_devices: window.__t31.devices.length,
        created_devices: window.__t31.device_creations
      })));
    }
    evidence.resources = resources;
    await save();
    evidence.native_resources = nativeResources;
    await save();
    expect(nativeResources.every(row => row.live_devices === 1 && row.resources.buffers.live === nativeResources[0].resources.buffers.live && row.resources.textures.live === nativeResources[0].resources.textures.live)).toBe(true);
    expect(resources.every(row => row.live_textures === resources[0].live_textures && row.live_buffers === resources[0].live_buffers && row.logical_texture_bytes === resources[0].logical_texture_bytes && row.live_decoded_bitmaps === 0)).toBe(true);
    await cdp.send('HeapProfiler.collectGarbage');
    evidence.heap_after = (await cdp.send('Performance.getMetrics')).metrics.filter(metric => metric.name.startsWith('JSHeap'));
    const snapshot = await page.evaluate(() => window.__wl_test.snapshot());
    const canonical = snapshot.objects[37].geometry;
    await page.evaluate(async () => {
      const hooks = window.__wl_test,
        box = hooks.snapshot().objects[37].geometry;
      await hooks.zoom(64 / (Math.min(box.x_max - box.x_min, box.y_max - box.y_min) * hooks.viewport().scale));
      const view = hooks.viewport();
      await hooks.pan(view.css_width / 2 - (box.x_min + box.x_max) / 2 * view.scale - view.tx, view.css_height / 2 - (box.y_min + box.y_max) / 2 * view.scale - view.ty);
    });
    // Actual resize and DPR transitions; image coordinates must not absorb DPR.
    const projections = [];
    for (const [width, dpr] of [[1440, 1], [1320, 1.25], [1200, 2], [1440, 3]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 1000,
        deviceScaleFactor: dpr,
        mobile: false
      });
      await page.evaluate(async () => {
        window.dispatchEvent(new Event('resize'));
        await window.__wl_test.select('dense-17-37');
        await window.__wl_test.zoom(1.005);
      });
      const projection = await page.evaluate(() => {
        const hooks = window.__wl_test,
          box = hooks.snapshot().objects[37].geometry,
          view = hooks.viewport(),
          label = hooks.labels().find(label => label.object_id === 'dense-17-37');
        return {
          box,
          view,
          label,
          dpr: devicePixelRatio
        };
      });
      expect(projection.box).toEqual(canonical);
      expect(projection.dpr).toBe(dpr);
      expect(await page.evaluate(() => window.__wl_test.snapshot())).toEqual(snapshot);
      expect(Math.abs(projection.label.x_css - (canonical.x_min * projection.view.scale + projection.view.tx))).toBeLessThanOrEqual(0.5);
      expect(Math.abs(projection.label.y_css - (canonical.y_min * projection.view.scale + projection.view.ty))).toBeLessThanOrEqual(0.5);
      const native = await measureNativeControls(page, info, canonical, projection.view, dpr);
      projections.push({
        ...projection,
        ...native
      });
      evidence.projections = projections;
      await save();
      await page.screenshot({
        path: info.outputPath(`projection-dpr-${dpr}.png`),
        scale: 'css'
      });
    }
    evidence.projections = projections;
    const canvas = page.getByTestId('annotation-canvas');
    await canvas.evaluate(canvas => {
      canvas.style.width = '0px';
      canvas.style.height = '0px';
    });
    await page.waitForTimeout(300);
    const zeroBefore = await page.evaluate(() => window.__t31.submissions);
    await page.evaluate(async () => {
      await window.__wl_test.pan(1, 0);
      await window.__wl_test.zoom(1.005);
    });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__t31.submissions)).toBe(zeroBefore);
    expect(await page.evaluate(() => window.__t31.zero_size_submissions)).toBe(0);
    await canvas.evaluate(canvas => {
      canvas.style.width = '100%';
      canvas.style.height = '100%';
    });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__t31.submissions)).toBeGreaterThan(zeroBefore);
    const lossBefore = await page.evaluate(() => ({
      snapshot: window.__wl_test.snapshot(),
      generation: window.__wl_test.generation(),
      devices: window.__t31.device_creations,
      losses: window.__t31.losses.length
    }));
    await page.evaluate(() => window.__t31.devices.at(-1).destroy());
    await expect.poll(() => page.evaluate(() => window.__t31.losses.length)).toBe(lossBefore.losses + 1);
    await expect.poll(() => page.evaluate(() => window.__t31.device_creations)).toBe(lossBefore.devices + 1);
    await expect(page.getByTestId('gpu-status')).toHaveAttribute('data-device-state', 'ready');
    expect(await page.evaluate(() => window.__wl_test.snapshot())).toEqual(lossBefore.snapshot);
    expect(await page.evaluate(() => window.__wl_test.generation())).toBe(lossBefore.generation);
    const recoveryBefore = await page.evaluate(() => window.__t31.submissions);
    await page.evaluate(() => window.__wl_test.pan(-1, 0));
    expect(await page.evaluate(() => window.__t31.submissions)).toBe(recoveryBefore + 1);
    evidence.loss = await page.evaluate(() => ({
      losses: window.__t31.losses,
      errors: window.__t31.errors,
      native_submissions: window.__t31.submissions,
      zero_size_submissions: window.__t31.zero_size_submissions
    }));
    expect(await page.evaluate(() => window.__t31.errors)).toEqual([]);
    await page.screenshot({
      path: info.outputPath('recovered-hardware.png'),
      fullPage: true
    });
    const entries = [];
    for (let index = 0; index < 5; index++) {
      await page.goto(`${origin}/?project_id=${seededProject.project_id}`);
      await expect(page.getByTestId('asset-grid')).toBeVisible();
      await page.goto(`${origin}/test-harness/dense?count=${count}&seed=17&project_id=${seededProject.project_id}&asset_revision_id=${media.asset_revision_id}`);
      await page.waitForFunction(() => {
        var _window$__wl_test2;
        return ((_window$__wl_test2 = window.__wl_test) === null || _window$__wl_test2 === void 0 ? void 0 : _window$__wl_test2.ready) === true;
      });
      await expect(page.getByTestId('gpu-status')).toHaveAttribute('data-device-state', 'ready');
      entries.push(await page.evaluate(() => ({
        live_devices: window.__t31.devices.length,
        resources: structuredClone(window.__t31.resources),
        stats: window.__wl_test.stats()
      })));
    }
    evidence.repeated_workbench_entries = entries;
    await save();
    expect(entries.every(row => row.live_devices === 1 && row.resources.buffers.live === entries[0].resources.buffers.live && row.resources.textures.live === entries[0].resources.textures.live && row.stats.live_decoded_bitmaps === 0)).toBe(true);
  } finally {
    await save();
  }
});
test('software and unknown adapters cannot pass the hardware classifier (not hardware evidence)', async () => {
  expect(hardwareKind({
    vendor: 'google',
    architecture: 'swiftshader',
    isFallbackAdapter: false
  })).toBe('software');
  expect(hardwareKind({
    vendor: 'nvidia',
    isFallbackAdapter: true
  })).toBe('software');
  expect(hardwareKind({
    vendor: '',
    architecture: ''
  })).toBe('unknown');
});
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJtZWFzdXJlTmF0aXZlQ29udHJvbHMiLCJjcmVhdGVIYXNoIiwicmVhZEZpbGUiLCJ3cml0ZUZpbGUiLCJwYXRoIiwic2hhcnAiLCJ0ZXN0IiwiZml4dHVyZVRlc3QiLCJleHBlY3QiLCJ3YWl0Rm9yQ2Fub25pY2FsQXNzZXRzIiwiZ2F0ZSIsImhhcmR3YXJlS2luZCIsInJ1biIsInByb2Nlc3MiLCJlbnYiLCJXRUJMQUJFTF9UMzFfUlVOX0RJUiIsIm9yaWdpbiIsIldFQkxBQkVMX1QzMV9PUklHSU4iLCJpbnN0cnVtZW50IiwicGFnZSIsImFkZEluaXRTY3JpcHQiLCJvYnNlcnZhdGlvbiIsImRldmljZXMiLCJkZXZpY2VfY3JlYXRpb25zIiwicmVzb3VyY2VzIiwiYnVmZmVycyIsImxpdmUiLCJjcmVhdGVkIiwicmVsZWFzZWQiLCJ0ZXh0dXJlcyIsImFkYXB0ZXJzIiwicmFmX2NwdV9tcyIsImxvc3NlcyIsInN1Ym1pc3Npb25zIiwiemVyb19zaXplX3N1Ym1pc3Npb25zIiwiZXJyb3JzIiwid2luZG93IiwiX190MzEiLCJyYWYiLCJyZXF1ZXN0QW5pbWF0aW9uRnJhbWUiLCJiaW5kIiwiY2FsbGJhY2siLCJ0aW1lc3RhbXAiLCJzdGFydCIsInBlcmZvcm1hbmNlIiwibm93IiwiZ3B1IiwibmF2aWdhdG9yIiwiYWRhcHRlclJlcXVlc3QiLCJyZXF1ZXN0QWRhcHRlciIsImFyZ3MiLCJhZGFwdGVyIiwicHVzaCIsInZlbmRvciIsImluZm8iLCJhcmNoaXRlY3R1cmUiLCJkZXZpY2UiLCJkZXNjcmlwdGlvbiIsImlzRmFsbGJhY2tBZGFwdGVyIiwidGltZXN0YW1wX3F1ZXJ5X3N1cHBvcnRlZCIsImZlYXR1cmVzIiwiaGFzIiwicmVxdWVzdERldmljZSIsImRldmljZUFyZ3MiLCJvd25lZFJlbGVhc2VzIiwiU2V0IiwidHJhY2siLCJyZXNvdXJjZSIsImtpbmQiLCJjb3VudHMiLCJkZXN0cm95IiwicmVsZWFzZSIsImRlbGV0ZSIsImFkZCIsImNyZWF0ZUJ1ZmZlciIsImNyZWF0ZVRleHR1cmUiLCJsb3N0IiwidGhlbiIsInJlYXNvbiIsIm1lc3NhZ2UiLCJzcGxpY2UiLCJpbmRleE9mIiwibmF0aXZlIiwic3VibWl0IiwicXVldWUiLCJzdWJtaXRBcmdzIiwiY2FudmFzIiwiZG9jdW1lbnQiLCJxdWVyeVNlbGVjdG9yIiwic2l6ZSIsImdldEJvdW5kaW5nQ2xpZW50UmVjdCIsIndpZHRoIiwiaGVpZ2h0IiwiYWRkRXZlbnRMaXN0ZW5lciIsImV2ZW50IiwiX2V2ZW50JGVycm9yJG1lc3NhZ2UiLCJfZXZlbnQkZXJyb3IiLCJlcnJvciIsImV4dGVuZCIsImFkbWluUGFnZSIsInNlZWRlZFByb2plY3QiLCJ1c2UiLCJyb3V0ZSIsInRhcmdldCIsIlVSTCIsInJlcXVlc3QiLCJ1cmwiLCJyZXNwb25zZSIsImZldGNoIiwiYXBpQmFzZVVybCIsInBhdGhuYW1lIiwic2VhcmNoIiwiaGVhZGVycyIsImhvc3QiLCJmdWxmaWxsIiwiZ290byIsImdldEJ5VGVzdElkIiwiZmlsbCIsImxvZ2luIiwidXNlcm5hbWUiLCJwYXNzd29yZCIsImNsaWNrIiwidG9IYXZlQ291bnQiLCJjb3VudCIsImV2aWRlbmNlIiwic2VlZCIsImNhbm9uaWNhbF9kaW1lbnNpb25zIiwid2FybXVwX3Blcl9zY2VuYXJpbyIsInNhbXBsZV9jb3VudF9wZXJfc2NlbmFyaW8iLCJzY2VuYXJpb3MiLCJzYXZlIiwiam9pbiIsIkpTT04iLCJzdHJpbmdpZnkiLCJsb2FkZWRXYXNtIiwidXBkYXRlIiwiYm9keSIsImRpZ2VzdCIsInBuZyIsImNyZWF0ZSIsImNoYW5uZWxzIiwiYmFja2dyb3VuZCIsInIiLCJnIiwiYiIsImFscGhhIiwidG9CdWZmZXIiLCJuYW1lIiwiYXBpIiwidXBsb2FkIiwicHJvamVjdF9pZCIsImNyeXB0byIsInJhbmRvbVVVSUQiLCJzdGF0dXMiLCJ0b0JlIiwiYXNzZXRzIiwiY2Fub25pY2FsTWVkaWEiLCJtYXAiLCJhc3NldCIsImZpbmQiLCJpdGVtIiwib3JpZ2luYWxfbmFtZSIsIkVycm9yIiwidG9NYXRjaE9iamVjdCIsImNhbm9uaWNhbF93aWR0aCIsImNhbm9uaWNhbF9oZWlnaHQiLCJhc3NldF9yZXZpc2lvbl9pZCIsImNhbm9uaWNhbF9tZWRpYSIsIm1lZGlhIiwid2FpdEZvckZ1bmN0aW9uIiwiX3dpbmRvdyRfX3dsX3Rlc3QiLCJfX3dsX3Rlc3QiLCJyZWFkeSIsImdldEJ5Um9sZSIsInRvSGF2ZUF0dHJpYnV0ZSIsImV2YWx1YXRlIiwibGVuZ3RoIiwidG9CZUdyZWF0ZXJUaGFuIiwiYXQiLCJlbnZpcm9ubWVudCIsInBhcnNlIiwibG9hZGVkX3dhc21fc2hhMjU2IiwidG9FcXVhbCIsIndhc20iLCJzaGEyNTYiLCJjc3MiLCJiYWNraW5nIiwidmlld3BvcnQiLCJpbm5lcldpZHRoIiwiaW5uZXJIZWlnaHQiLCJkcHIiLCJkZXZpY2VQaXhlbFJhdGlvIiwiYnJvd3Nlcl91c2VyX2FnZW50IiwidXNlckFnZW50IiwiT2JqZWN0IiwiYXNzaWduIiwiYnJvd3NlciIsInZlcnNpb24iLCJjb250ZXh0IiwidXNlcl9hZ2VudCIsInRhcmdldF9jYW52YXMiLCJ0aW1lc3RhbXBfcXVlcnkiLCJlbmFibGVkIiwiYWRhcHRlcl9zdXBwb3J0ZWQiLCJlbmFibGVkX29uX2FwcGxpY2F0aW9uX2RldmljZSIsIm1lYXN1cmVkIiwib3JpZ2luYWwiLCJzbmFwc2hvdCIsIm9iamVjdHMiLCJ0b0hhdmVMZW5ndGgiLCJjb29yZGluYXRlX3NwYWNlIiwidHlwZSIsInRvQmVMZXNzVGhhbiIsInRvQmVMZXNzVGhhbk9yRXF1YWwiLCJzY3JlZW5zaG90Iiwib3V0cHV0UGF0aCIsImZ1bGxQYWdlIiwiY2RwIiwibmV3Q0RQU2Vzc2lvbiIsInNlbmQiLCJleHBvc2VCaW5kaW5nIiwibWV0cmljcyIsImR1cmF0aW9uIiwibWV0cmljIiwidmFsdWUiLCJoZWFwX2JlZm9yZSIsImZpbHRlciIsInN0YXJ0c1dpdGgiLCJiZWZvcmUiLCJnZW5lcmF0aW9uIiwic2F2ZXMiLCJzYXZlQ291bnQiLCJ2YWxpZGF0aW9uIiwidmFsaWRhdGlvbklucHV0T2JqZWN0cyIsInNlcmlhbGl6YXRpb24iLCJzZXJpYWxpemVkSW5wdXRPYmplY3RzIiwicmVjdCIsImJvdW5kaW5nQm94IiwidG9vbCIsIm1vdXNlIiwibW92ZSIsIngiLCJ5IiwiZG93biIsInNjZW5hcmlvIiwiZGlzcGF0Y2hFdmVudCIsInBvaW50ZXJJZCIsInVwIiwicm93cyIsImhvb2tzIiwiaW5kZXgiLCJzZXF1ZW5jZSIsInRhc2tCZWZvcmUiLCJfX3QzMVRhc2tEdXJhdGlvbiIsInByZXZpb3VzIiwic3RhdHMiLCJuYXRpdmVCZWZvcmUiLCJyYWZDcHUiLCJzdGFydGVkIiwic2V0dGxlZCIsIlBvaW50ZXJFdmVudCIsImNsaWVudFgiLCJjbGllbnRZIiwiYnV0dG9ucyIsImJ1dHRvbiIsImJ1YmJsZXMiLCJwYW4iLCJ6b29tIiwiZWRpdE9iamVjdCIsInN5bmNocm9ub3VzIiwiUHJvbWlzZSIsInJlc29sdmUiLCJlbGFwc2VkIiwidGFza0FmdGVyIiwiYWZ0ZXIiLCJjcHVfbXMiLCJNYXRoIiwibWF4IiwidGFza19jcHVfbXMiLCJzeW5jaHJvbm91c19jcHVfbXMiLCJicmlkZ2VfY3B1X21zIiwiYnJpZGdlX2VsYXBzZWRfbXMiLCJkb3VibGVfcmFmX21zIiwiZ3B1X3N1Ym1pc3Npb25zIiwibmF0aXZlX3N1Ym1pc3Npb25zIiwiYmJveF91cGxvYWRfYnl0ZXMiLCJ3YXNtX2JpbmFyeV9ieXRlcyIsImpzX3dhc21fYmluYXJ5X2J5dGVzIiwiZXZlcnkiLCJyb3ciLCJwZXJmb3JtYW5jZVJlc3VsdCIsInNvZnQiLCJmYWlsdXJlcyIsImZsdXNoIiwiaWRsZUJlZm9yZSIsIndhaXRGb3JUaW1lb3V0IiwiaWRsZUFmdGVyIiwiaWRsZSIsInNlY29uZHMiLCJvdGhlckluZGV4IiwiZmluZEluZGV4IiwibmF0aXZlUmVzb3VyY2VzIiwiY2hhbmdlQXNzZXQiLCJzdHJ1Y3R1cmVkQ2xvbmUiLCJsaXZlX2RldmljZXMiLCJjcmVhdGVkX2RldmljZXMiLCJuYXRpdmVfcmVzb3VyY2VzIiwibGl2ZV90ZXh0dXJlcyIsImxpdmVfYnVmZmVycyIsImxvZ2ljYWxfdGV4dHVyZV9ieXRlcyIsImxpdmVfZGVjb2RlZF9iaXRtYXBzIiwiaGVhcF9hZnRlciIsImNhbm9uaWNhbCIsImdlb21ldHJ5IiwiYm94IiwibWluIiwieF9tYXgiLCJ4X21pbiIsInlfbWF4IiwieV9taW4iLCJzY2FsZSIsInZpZXciLCJjc3Nfd2lkdGgiLCJ0eCIsImNzc19oZWlnaHQiLCJ0eSIsInByb2plY3Rpb25zIiwiZGV2aWNlU2NhbGVGYWN0b3IiLCJtb2JpbGUiLCJFdmVudCIsInNlbGVjdCIsInByb2plY3Rpb24iLCJsYWJlbCIsImxhYmVscyIsIm9iamVjdF9pZCIsImFicyIsInhfY3NzIiwieV9jc3MiLCJzdHlsZSIsInplcm9CZWZvcmUiLCJsb3NzQmVmb3JlIiwicG9sbCIsInJlY292ZXJ5QmVmb3JlIiwibG9zcyIsImVudHJpZXMiLCJ0b0JlVmlzaWJsZSIsIl93aW5kb3ckX193bF90ZXN0MiIsInJlcGVhdGVkX3dvcmtiZW5jaF9lbnRyaWVzIl0sInNvdXJjZXMiOlsidDMxX2hhcmR3YXJlLnNwZWMudHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgbWVhc3VyZU5hdGl2ZUNvbnRyb2xzIH0gZnJvbSAnLi4vLi4vcmVwb3J0cy9UMzEvbmF0aXZlLWNvbnRyb2xzJztcclxuaW1wb3J0IHsgY3JlYXRlSGFzaCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcclxuaW1wb3J0IHsgcmVhZEZpbGUsIHdyaXRlRmlsZSB9IGZyb20gJ25vZGU6ZnMvcHJvbWlzZXMnO1xyXG5pbXBvcnQgcGF0aCBmcm9tICdub2RlOnBhdGgnO1xyXG5pbXBvcnQgc2hhcnAgZnJvbSAnc2hhcnAnO1xyXG5pbXBvcnQgeyB0ZXN0IGFzIGZpeHR1cmVUZXN0LCBleHBlY3QsIHdhaXRGb3JDYW5vbmljYWxBc3NldHMgfSBmcm9tICcuLi9lMmUvZml4dHVyZXMnO1xyXG5pbXBvcnQgdHlwZSB7IFBhZ2UgfSBmcm9tICdAcGxheXdyaWdodC90ZXN0JztcclxuXHJcbmltcG9ydCB0eXBlIHsgVDI4U3RhdHMgfSBmcm9tICcuLi8uLi9hcHBzL3dlYi9zcmMvZmVhdHVyZXMvd29ya2JlbmNoL3BlcmYnO1xyXG5pbXBvcnQgeyBnYXRlLCBoYXJkd2FyZUtpbmQgfSBmcm9tICcuLi8uLi9zY3JpcHRzL3ZlcmlmeS1ncHUubWpzJztcclxuXHJcbmludGVyZmFjZSBOYXRpdmVSZXNvdXJjZUNvdW50cyB7IGJ1ZmZlcnM6IHsgbGl2ZTogbnVtYmVyOyBjcmVhdGVkOiBudW1iZXI7IHJlbGVhc2VkOiBudW1iZXIgfTsgdGV4dHVyZXM6IHsgbGl2ZTogbnVtYmVyOyBjcmVhdGVkOiBudW1iZXI7IHJlbGVhc2VkOiBudW1iZXIgfSB9XHJcbmludGVyZmFjZSBPYnNlcnZhdGlvbiB7IGRldmljZXM6IEdQVURldmljZVtdOyBkZXZpY2VfY3JlYXRpb25zOiBudW1iZXI7IHJlc291cmNlczogTmF0aXZlUmVzb3VyY2VDb3VudHM7IGFkYXB0ZXJzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPltdOyByYWZfY3B1X21zOiBudW1iZXI7IGxvc3NlczogeyByZWFzb246IHN0cmluZzsgbWVzc2FnZTogc3RyaW5nIH1bXTsgc3VibWlzc2lvbnM6IG51bWJlcjsgemVyb19zaXplX3N1Ym1pc3Npb25zOiBudW1iZXI7IGVycm9yczogc3RyaW5nW10gfVxyXG5kZWNsYXJlIGdsb2JhbCB7IGludGVyZmFjZSBXaW5kb3cgeyBfX3QzMTogT2JzZXJ2YXRpb247IF9fdDMxVGFza0R1cmF0aW9uKCk6IFByb21pc2U8bnVtYmVyPiB9IH1cclxuY29uc3QgcnVuID0gcHJvY2Vzcy5lbnYuV0VCTEFCRUxfVDMxX1JVTl9ESVIhO1xyXG5jb25zdCBvcmlnaW4gPSBwcm9jZXNzLmVudi5XRUJMQUJFTF9UMzFfT1JJR0lOITtcclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGluc3RydW1lbnQocGFnZTogUGFnZSkge1xyXG4gIGF3YWl0IHBhZ2UuYWRkSW5pdFNjcmlwdCgoKSA9PiB7XHJcbiAgICBjb25zdCBvYnNlcnZhdGlvbjogT2JzZXJ2YXRpb24gPSB7IGRldmljZXM6IFtdLCBkZXZpY2VfY3JlYXRpb25zOiAwLCByZXNvdXJjZXM6IHsgYnVmZmVyczogeyBsaXZlOiAwLCBjcmVhdGVkOiAwLCByZWxlYXNlZDogMCB9LCB0ZXh0dXJlczogeyBsaXZlOiAwLCBjcmVhdGVkOiAwLCByZWxlYXNlZDogMCB9IH0sIGFkYXB0ZXJzOiBbXSwgcmFmX2NwdV9tczogMCwgbG9zc2VzOiBbXSwgc3VibWlzc2lvbnM6IDAsIHplcm9fc2l6ZV9zdWJtaXNzaW9uczogMCwgZXJyb3JzOiBbXSB9O1xyXG4gICAgd2luZG93Ll9fdDMxID0gb2JzZXJ2YXRpb247XHJcbiAgICBjb25zdCByYWYgPSB3aW5kb3cucmVxdWVzdEFuaW1hdGlvbkZyYW1lLmJpbmQod2luZG93KTtcclxuICAgIHdpbmRvdy5yZXF1ZXN0QW5pbWF0aW9uRnJhbWUgPSBjYWxsYmFjayA9PiByYWYodGltZXN0YW1wID0+IHsgY29uc3Qgc3RhcnQgPSBwZXJmb3JtYW5jZS5ub3coKTsgdHJ5IHsgY2FsbGJhY2sodGltZXN0YW1wKTsgfSBmaW5hbGx5IHsgb2JzZXJ2YXRpb24ucmFmX2NwdV9tcyArPSBwZXJmb3JtYW5jZS5ub3coKSAtIHN0YXJ0OyB9IH0pO1xyXG4gICAgY29uc3QgZ3B1ID0gbmF2aWdhdG9yLmdwdTtcclxuICAgIGlmICghZ3B1KSByZXR1cm47XHJcbiAgICBjb25zdCBhZGFwdGVyUmVxdWVzdCA9IGdwdS5yZXF1ZXN0QWRhcHRlci5iaW5kKGdwdSk7XHJcbiAgICBncHUucmVxdWVzdEFkYXB0ZXIgPSBhc3luYyAoLi4uYXJncykgPT4ge1xyXG4gICAgICBjb25zdCBhZGFwdGVyID0gYXdhaXQgYWRhcHRlclJlcXVlc3QoLi4uYXJncyk7XHJcbiAgICAgIGlmICghYWRhcHRlcikgcmV0dXJuIGFkYXB0ZXI7XHJcbiAgICAgIG9ic2VydmF0aW9uLmFkYXB0ZXJzLnB1c2goeyB2ZW5kb3I6IGFkYXB0ZXIuaW5mby52ZW5kb3IgfHwgJ3Vua25vd24nLCBhcmNoaXRlY3R1cmU6IGFkYXB0ZXIuaW5mby5hcmNoaXRlY3R1cmUgfHwgJ3Vua25vd24nLCBkZXZpY2U6IGFkYXB0ZXIuaW5mby5kZXZpY2UgfHwgJ3Vua25vd24nLCBkZXNjcmlwdGlvbjogYWRhcHRlci5pbmZvLmRlc2NyaXB0aW9uIHx8ICd1bmtub3duJywgaXNGYWxsYmFja0FkYXB0ZXI6IGFkYXB0ZXIuaW5mby5pc0ZhbGxiYWNrQWRhcHRlciwgdGltZXN0YW1wX3F1ZXJ5X3N1cHBvcnRlZDogYWRhcHRlci5mZWF0dXJlcy5oYXMoJ3RpbWVzdGFtcC1xdWVyeScpIH0pO1xyXG4gICAgICBjb25zdCByZXF1ZXN0RGV2aWNlID0gYWRhcHRlci5yZXF1ZXN0RGV2aWNlLmJpbmQoYWRhcHRlcik7XHJcbiAgICAgIGFkYXB0ZXIucmVxdWVzdERldmljZSA9IGFzeW5jICguLi5kZXZpY2VBcmdzKSA9PiB7XHJcbiAgICAgICAgY29uc3QgZGV2aWNlID0gYXdhaXQgcmVxdWVzdERldmljZSguLi5kZXZpY2VBcmdzKTtcclxuICAgICAgICBvYnNlcnZhdGlvbi5kZXZpY2VzLnB1c2goZGV2aWNlKTtcclxuICAgICAgICBvYnNlcnZhdGlvbi5kZXZpY2VfY3JlYXRpb25zKys7XHJcbiAgICAgICAgY29uc3Qgb3duZWRSZWxlYXNlcyA9IG5ldyBTZXQ8KCkgPT4gdm9pZD4oKTtcclxuICAgICAgICBmdW5jdGlvbiB0cmFjazxUIGV4dGVuZHMgeyBkZXN0cm95KCk6IHZvaWQgfT4ocmVzb3VyY2U6IFQsIGtpbmQ6IGtleW9mIE5hdGl2ZVJlc291cmNlQ291bnRzKTogVCB7XHJcbiAgICAgICAgICBjb25zdCBjb3VudHMgPSBvYnNlcnZhdGlvbi5yZXNvdXJjZXNba2luZF07XHJcbiAgICAgICAgICBjb3VudHMuY3JlYXRlZCsrOyBjb3VudHMubGl2ZSsrO1xyXG4gICAgICAgICAgY29uc3QgZGVzdHJveSA9IHJlc291cmNlLmRlc3Ryb3kuYmluZChyZXNvdXJjZSk7XHJcbiAgICAgICAgICBsZXQgcmVsZWFzZWQgPSBmYWxzZTtcclxuICAgICAgICAgIGNvbnN0IHJlbGVhc2UgPSAoKSA9PiB7XHJcbiAgICAgICAgICAgIGlmIChyZWxlYXNlZCkgcmV0dXJuO1xyXG4gICAgICAgICAgICByZWxlYXNlZCA9IHRydWU7IGNvdW50cy5saXZlLS07IGNvdW50cy5yZWxlYXNlZCsrO1xyXG4gICAgICAgICAgICBvd25lZFJlbGVhc2VzLmRlbGV0ZShyZWxlYXNlKTtcclxuICAgICAgICAgIH07XHJcbiAgICAgICAgICBvd25lZFJlbGVhc2VzLmFkZChyZWxlYXNlKTtcclxuICAgICAgICAgIHJlc291cmNlLmRlc3Ryb3kgPSAoKSA9PiB7IGRlc3Ryb3koKTsgcmVsZWFzZSgpOyB9O1xyXG4gICAgICAgICAgcmV0dXJuIHJlc291cmNlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjcmVhdGVCdWZmZXIgPSBkZXZpY2UuY3JlYXRlQnVmZmVyLmJpbmQoZGV2aWNlKTtcclxuICAgICAgICBkZXZpY2UuY3JlYXRlQnVmZmVyID0gKC4uLmFyZ3MpID0+IHRyYWNrKGNyZWF0ZUJ1ZmZlciguLi5hcmdzKSwgJ2J1ZmZlcnMnKTtcclxuICAgICAgICBjb25zdCBjcmVhdGVUZXh0dXJlID0gZGV2aWNlLmNyZWF0ZVRleHR1cmUuYmluZChkZXZpY2UpO1xyXG4gICAgICAgIGRldmljZS5jcmVhdGVUZXh0dXJlID0gKC4uLmFyZ3MpID0+IHRyYWNrKGNyZWF0ZVRleHR1cmUoLi4uYXJncyksICd0ZXh0dXJlcycpO1xyXG4gICAgICAgIGRldmljZS5sb3N0LnRoZW4oaW5mbyA9PiB7XHJcbiAgICAgICAgICBvYnNlcnZhdGlvbi5sb3NzZXMucHVzaCh7IHJlYXNvbjogaW5mby5yZWFzb24sIG1lc3NhZ2U6IGluZm8ubWVzc2FnZSB9KTtcclxuICAgICAgICAgIC8vIERldmljZSBsb3NzL2Rlc3RydWN0aW9uIGludmFsaWRhdGVzIGl0cyBvdXRzdGFuZGluZyBuYXRpdmUgcmVzb3VyY2VzLlxyXG4gICAgICAgICAgZm9yIChjb25zdCByZWxlYXNlIG9mIG93bmVkUmVsZWFzZXMpIHJlbGVhc2UoKTtcclxuICAgICAgICAgIG9ic2VydmF0aW9uLmRldmljZXMuc3BsaWNlKG9ic2VydmF0aW9uLmRldmljZXMuaW5kZXhPZihkZXZpY2UpLCAxKTtcclxuICAgICAgICB9KTtcclxuICAgICAgICAvLyBPYnNlcnZlIHRoZSBhY3R1YWwgbmF0aXZlIHF1ZXVlOyBuZXZlciBmYWtlIGEgZGV2aWNlLCBhZGFwdGVyIG9yIHN1Ym1pc3Npb24uXHJcbiAgICAgICAgY29uc3QgbmF0aXZlID0gZGV2aWNlO1xyXG4gICAgICAgIGNvbnN0IHN1Ym1pdCA9IG5hdGl2ZS5xdWV1ZS5zdWJtaXQuYmluZChuYXRpdmUucXVldWUpO1xyXG4gICAgICAgIG5hdGl2ZS5xdWV1ZS5zdWJtaXQgPSAoLi4uc3VibWl0QXJncykgPT4ge1xyXG4gICAgICAgICAgb2JzZXJ2YXRpb24uc3VibWlzc2lvbnMrKztcclxuICAgICAgICAgIGNvbnN0IGNhbnZhcyA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3I8SFRNTENhbnZhc0VsZW1lbnQ+KCdbZGF0YS10ZXN0aWQ9XCJhbm5vdGF0aW9uLWNhbnZhc1wiXScpO1xyXG4gICAgICAgICAgaWYgKGNhbnZhcykgeyBjb25zdCBzaXplID0gY2FudmFzLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOyBpZiAoc2l6ZS53aWR0aCA9PT0gMCB8fCBzaXplLmhlaWdodCA9PT0gMCkgb2JzZXJ2YXRpb24uemVyb19zaXplX3N1Ym1pc3Npb25zKys7IH1cclxuICAgICAgICAgIHJldHVybiBzdWJtaXQoLi4uc3VibWl0QXJncyk7XHJcbiAgICAgICAgfTtcclxuICAgICAgICBuYXRpdmUuYWRkRXZlbnRMaXN0ZW5lcigndW5jYXB0dXJlZGVycm9yJywgZXZlbnQgPT4gb2JzZXJ2YXRpb24uZXJyb3JzLnB1c2goZXZlbnQuZXJyb3I/Lm1lc3NhZ2UgPz8gJ3Vua25vd24gR1BVIGVycm9yJykpO1xyXG4gICAgICAgIHJldHVybiBkZXZpY2U7XHJcbiAgICAgIH07XHJcbiAgICAgIHJldHVybiBhZGFwdGVyO1xyXG4gICAgfTtcclxuICB9KTtcclxufVxyXG5jb25zdCB0ZXN0ID0gZml4dHVyZVRlc3QuZXh0ZW5kKHtcclxuICBhZG1pblBhZ2U6IGFzeW5jICh7IHBhZ2UsIHNlZWRlZFByb2plY3QgfSwgdXNlKSA9PiB7XHJcbiAgICBhd2FpdCBpbnN0cnVtZW50KHBhZ2UpO1xyXG4gICAgYXdhaXQgcGFnZS5yb3V0ZSgnKiovYXBpLyoqJywgYXN5bmMgcm91dGUgPT4ge1xyXG4gICAgICBjb25zdCB0YXJnZXQgPSBuZXcgVVJMKHJvdXRlLnJlcXVlc3QoKS51cmwoKSk7XHJcbiAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgcm91dGUuZmV0Y2goeyB1cmw6IHNlZWRlZFByb2plY3QuYXBpQmFzZVVybCArIHRhcmdldC5wYXRobmFtZSArIHRhcmdldC5zZWFyY2gsIGhlYWRlcnM6IHsgLi4ucm91dGUucmVxdWVzdCgpLmhlYWRlcnMoKSwgb3JpZ2luOiBzZWVkZWRQcm9qZWN0LmFwaUJhc2VVcmwsIGhvc3Q6IG5ldyBVUkwoc2VlZGVkUHJvamVjdC5hcGlCYXNlVXJsKS5ob3N0IH0gfSk7XHJcbiAgICAgIGF3YWl0IHJvdXRlLmZ1bGZpbGwoeyByZXNwb25zZSB9KTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgcGFnZS5nb3RvKG9yaWdpbik7XHJcbiAgICBhd2FpdCBwYWdlLmdldEJ5VGVzdElkKCdsb2dpbi11c2VybmFtZScpLmZpbGwoc2VlZGVkUHJvamVjdC5sb2dpbi51c2VybmFtZSk7XHJcbiAgICBhd2FpdCBwYWdlLmdldEJ5VGVzdElkKCdsb2dpbi1wYXNzd29yZCcpLmZpbGwoc2VlZGVkUHJvamVjdC5sb2dpbi5wYXNzd29yZCk7XHJcbiAgICBhd2FpdCBwYWdlLmdldEJ5VGVzdElkKCdsb2dpbi1zdWJtaXQnKS5jbGljaygpO1xyXG4gICAgYXdhaXQgZXhwZWN0KHBhZ2UuZ2V0QnlUZXN0SWQoJ2xvZ2luLXN1Ym1pdCcpKS50b0hhdmVDb3VudCgwKTtcclxuICAgIGF3YWl0IHVzZShwYWdlKTtcclxuICB9LFxyXG59KTtcclxuXHJcbmZvciAoY29uc3QgY291bnQgb2YgWzIwMDAsIDEwMDAwXSBhcyBjb25zdCkgdGVzdChgJHtjb3VudH0gZml4ZWQgcmVsZWFzZSBXQVNNIGhhcmR3YXJlOiBmb3VyIHdhcm1lZCAxMDAwLXNhbXBsZSBzY2VuYXJpb3MgYW5kIGxpZmVjeWNsZWAsIGFzeW5jICh7IGFkbWluUGFnZTogcGFnZSwgc2VlZGVkUHJvamVjdCB9LCBpbmZvKSA9PiB7XHJcbiAgY29uc3QgZXZpZGVuY2U6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyBjb3VudCwgc2VlZDogMTcsIGNhbm9uaWNhbF9kaW1lbnNpb25zOiBbMjA0OCwgMjA0OF0sIHdhcm11cF9wZXJfc2NlbmFyaW86IDQwLCBzYW1wbGVfY291bnRfcGVyX3NjZW5hcmlvOiAxMDAwLCBzY2VuYXJpb3M6IHt9IH07XHJcbiAgY29uc3Qgc2F2ZSA9ICgpID0+IHdyaXRlRmlsZShwYXRoLmpvaW4ocnVuLCBgc2FtcGxlcy0ke2NvdW50fS5qc29uYCksIEpTT04uc3RyaW5naWZ5KGV2aWRlbmNlLCBudWxsLCAyKSk7XHJcbiAgdHJ5IHtcclxuICAgIGNvbnN0IGxvYWRlZFdhc206IHN0cmluZ1tdID0gW107XHJcbiAgICBhd2FpdCBwYWdlLnJvdXRlKCcqKi93YXNtL3dhc21fYnJpZGdlX2JnLndhc20nLCBhc3luYyByb3V0ZSA9PiB7XHJcbiAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgcm91dGUuZmV0Y2goKTtcclxuICAgICAgbG9hZGVkV2FzbS5wdXNoKGNyZWF0ZUhhc2goJ3NoYTI1NicpLnVwZGF0ZShhd2FpdCByZXNwb25zZS5ib2R5KCkpLmRpZ2VzdCgnaGV4JykpO1xyXG4gICAgICBhd2FpdCByb3V0ZS5mdWxmaWxsKHsgcmVzcG9uc2UgfSk7XHJcbiAgICB9KTtcclxuICAgIGNvbnN0IHBuZyA9IGF3YWl0IHNoYXJwKHsgY3JlYXRlOiB7IHdpZHRoOiAyMDQ4LCBoZWlnaHQ6IDIwNDgsIGNoYW5uZWxzOiA0LCBiYWNrZ3JvdW5kOiB7IHI6IDI4LCBnOiAzNywgYjogNDksIGFscGhhOiAxIH0gfSB9KS5wbmcoKS50b0J1ZmZlcigpO1xyXG4gICAgZm9yIChjb25zdCBuYW1lIG9mIFsnYScsICdiJ10pIGV4cGVjdCgoYXdhaXQgc2VlZGVkUHJvamVjdC5hcGkudXBsb2FkKGAvYXBpL3Byb2plY3RzLyR7c2VlZGVkUHJvamVjdC5wcm9qZWN0X2lkfS9hc3NldHNgLCBwbmcsIGB0MzEtJHtuYW1lfS5wbmdgLCBjcnlwdG8ucmFuZG9tVVVJRCgpLCAnaW1hZ2UvcG5nJykpLnN0YXR1cykudG9CZSgyMDIpO1xyXG4gICAgY29uc3QgYXNzZXRzID0gYXdhaXQgd2FpdEZvckNhbm9uaWNhbEFzc2V0cyhzZWVkZWRQcm9qZWN0LmFwaSwgc2VlZGVkUHJvamVjdC5wcm9qZWN0X2lkLCAyNCk7XHJcbiAgICBjb25zdCBjYW5vbmljYWxNZWRpYSA9IFsnYScsICdiJ10ubWFwKG5hbWUgPT4ge1xyXG4gICAgICBjb25zdCBhc3NldCA9IGFzc2V0cy5maW5kKGl0ZW0gPT4gaXRlbS5vcmlnaW5hbF9uYW1lID09PSBgdDMxLSR7bmFtZX0ucG5nYCk7XHJcbiAgICAgIGlmICghYXNzZXQpIHRocm93IG5ldyBFcnJvcihgVDMxIGNhbm9uaWNhbCBpbWFnZSAke25hbWV9IHdhcyBub3QgaW1wb3J0ZWRgKTtcclxuICAgICAgZXhwZWN0KGFzc2V0KS50b01hdGNoT2JqZWN0KHsgb3JpZ2luYWxfbmFtZTogYHQzMS0ke25hbWV9LnBuZ2AsIGNhbm9uaWNhbF93aWR0aDogMjA0OCwgY2Fub25pY2FsX2hlaWdodDogMjA0OCB9KTtcclxuICAgICAgZXhwZWN0KHR5cGVvZiBhc3NldC5hc3NldF9yZXZpc2lvbl9pZCkudG9CZSgnc3RyaW5nJyk7XHJcbiAgICAgIHJldHVybiBhc3NldDtcclxuICAgIH0pO1xyXG4gICAgZXZpZGVuY2UuY2Fub25pY2FsX21lZGlhID0gY2Fub25pY2FsTWVkaWE7XHJcbiAgICBjb25zdCBtZWRpYSA9IGNhbm9uaWNhbE1lZGlhWzBdO1xyXG4gICAgYXdhaXQgcGFnZS5nb3RvKGAke29yaWdpbn0vdGVzdC1oYXJuZXNzL2RlbnNlP2NvdW50PSR7Y291bnR9JnNlZWQ9MTcmcHJvamVjdF9pZD0ke3NlZWRlZFByb2plY3QucHJvamVjdF9pZH0mYXNzZXRfcmV2aXNpb25faWQ9JHttZWRpYS5hc3NldF9yZXZpc2lvbl9pZH1gKTtcclxuICAgIGF3YWl0IHBhZ2Uud2FpdEZvckZ1bmN0aW9uKCgpID0+IHdpbmRvdy5fX3dsX3Rlc3Q/LnJlYWR5ID09PSB0cnVlIHx8IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJ1tyb2xlPVwiYWxlcnRcIl0nKSAhPT0gbnVsbCk7XHJcbiAgICBhd2FpdCBleHBlY3QocGFnZS5nZXRCeVJvbGUoJ2FsZXJ0JykpLnRvSGF2ZUNvdW50KDApO1xyXG4gICAgYXdhaXQgZXhwZWN0KHBhZ2UuZ2V0QnlUZXN0SWQoJ2dwdS1zdGF0dXMnKSkudG9IYXZlQXR0cmlidXRlKCdkYXRhLWRldmljZS1zdGF0ZScsICdyZWFkeScpO1xyXG4gICAgYXdhaXQgZXhwZWN0KHBhZ2UuZ2V0QnlUZXN0SWQoJ2dwdS1zdGF0dXMnKSkudG9IYXZlQXR0cmlidXRlKCdkYXRhLWFjdHVhbC1iYWNrZW5kJywgJ3dlYmdwdScpO1xyXG4gICAgY29uc3QgYWRhcHRlciA9IGF3YWl0IHBhZ2UuZXZhbHVhdGUoKCkgPT4gd2luZG93Ll9fdDMxLmFkYXB0ZXJzKTtcclxuICAgIGV2aWRlbmNlLmFkYXB0ZXJzID0gYWRhcHRlcjtcclxuICAgIGF3YWl0IHNhdmUoKTtcclxuICAgIGV4cGVjdChhZGFwdGVyLmxlbmd0aCkudG9CZUdyZWF0ZXJUaGFuKDApO1xyXG4gICAgZXhwZWN0KGhhcmR3YXJlS2luZChhZGFwdGVyLmF0KC0xKSkpLnRvQmUoJ2hhcmR3YXJlJyk7XHJcbiAgICBhd2FpdCBleHBlY3QocGFnZS5nZXRCeVRlc3RJZCgnZ3B1LXN0YXR1cycpKS50b0hhdmVBdHRyaWJ1dGUoJ2RhdGEtYWRhcHRlci1raW5kJywgJ2hhcmR3YXJlJyk7XHJcbiAgICBjb25zdCBlbnZpcm9ubWVudCA9IEpTT04ucGFyc2UoYXdhaXQgcmVhZEZpbGUocGF0aC5qb2luKHJ1biwgJ2Vudmlyb25tZW50Lmpzb24nKSwgJ3V0ZjgnKSk7XHJcbiAgICBldmlkZW5jZS5sb2FkZWRfd2FzbV9zaGEyNTYgPSBsb2FkZWRXYXNtO1xyXG4gICAgZXhwZWN0KGxvYWRlZFdhc20pLnRvRXF1YWwoW2Vudmlyb25tZW50Lndhc20uc2hhMjU2XSk7XHJcbiAgICBjb25zdCB0YXJnZXQgPSBhd2FpdCBwYWdlLmdldEJ5VGVzdElkKCdhbm5vdGF0aW9uLWNhbnZhcycpLmV2YWx1YXRlKChjYW52YXM6IEhUTUxDYW52YXNFbGVtZW50KSA9PiAoeyBjc3M6IHsgd2lkdGg6IGNhbnZhcy5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKS53aWR0aCwgaGVpZ2h0OiBjYW52YXMuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCkuaGVpZ2h0IH0sIGJhY2tpbmc6IHsgd2lkdGg6IGNhbnZhcy53aWR0aCwgaGVpZ2h0OiBjYW52YXMuaGVpZ2h0IH0sIHZpZXdwb3J0OiB7IHdpZHRoOiBpbm5lcldpZHRoLCBoZWlnaHQ6IGlubmVySGVpZ2h0IH0sIGRwcjogZGV2aWNlUGl4ZWxSYXRpbywgYnJvd3Nlcl91c2VyX2FnZW50OiBuYXZpZ2F0b3IudXNlckFnZW50IH0pKTtcclxuICAgIE9iamVjdC5hc3NpZ24oZW52aXJvbm1lbnQsIHsgYnJvd3NlcjogeyB2ZXJzaW9uOiBwYWdlLmNvbnRleHQoKS5icm93c2VyKCkhLnZlcnNpb24oKSwgdXNlcl9hZ2VudDogdGFyZ2V0LmJyb3dzZXJfdXNlcl9hZ2VudCB9LCBncHU6IGFkYXB0ZXIsIGRwcjogdGFyZ2V0LmRwciwgdGFyZ2V0X2NhbnZhczogdGFyZ2V0IH0pO1xyXG4gICAgYXdhaXQgd3JpdGVGaWxlKHBhdGguam9pbihydW4sICdlbnZpcm9ubWVudC5qc29uJyksIEpTT04uc3RyaW5naWZ5KGVudmlyb25tZW50LCBudWxsLCAyKSk7XHJcbiAgICBldmlkZW5jZS50YXJnZXQgPSB0YXJnZXQ7XHJcbiAgICBldmlkZW5jZS50aW1lc3RhbXBfcXVlcnkgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKCgpID0+IHtcclxuICAgICAgY29uc3QgZW5hYmxlZCA9IHdpbmRvdy5fX3QzMS5kZXZpY2VzLmF0KC0xKSEuZmVhdHVyZXMuaGFzKCd0aW1lc3RhbXAtcXVlcnknKTtcclxuICAgICAgcmV0dXJuIHsgYWRhcHRlcl9zdXBwb3J0ZWQ6IHdpbmRvdy5fX3QzMS5hZGFwdGVycy5hdCgtMSkhLnRpbWVzdGFtcF9xdWVyeV9zdXBwb3J0ZWQsIGVuYWJsZWRfb25fYXBwbGljYXRpb25fZGV2aWNlOiBlbmFibGVkLCBtZWFzdXJlZDogZmFsc2UsIHJlYXNvbjogZW5hYmxlZCA/ICdSZW5kZXJlciBleHBvc2VzIG5vIHRpbWVzdGFtcCByZXN1bHRzOyBubyBHUFUgZHVyYXRpb24gY2xhaW1lZC4nIDogJ1RpbWVzdGFtcC1xdWVyeSBpcyBub3QgZW5hYmxlZCBvbiB0aGUgYWN0dWFsIGFwcGxpY2F0aW9uIGRldmljZTsgQ1BVIHRpbWUgaXMgbm90IEdQVSB0aW1lLicgfTtcclxuICAgIH0pO1xyXG4gICAgY29uc3Qgb3JpZ2luYWwgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKCgpID0+IHdpbmRvdy5fX3dsX3Rlc3QhLnNuYXBzaG90KCkpO1xyXG4gICAgZXhwZWN0KG9yaWdpbmFsLm9iamVjdHMpLnRvSGF2ZUxlbmd0aChjb3VudCk7XHJcbiAgICBleHBlY3Qob3JpZ2luYWwuY29vcmRpbmF0ZV9zcGFjZSkudG9FcXVhbCh7IHR5cGU6ICdjYW5vbmljYWxfaW1hZ2VfcGl4ZWxzJywgd2lkdGg6IDIwNDgsIGhlaWdodDogMjA0OCB9KTtcclxuICAgIGV4cGVjdChhd2FpdCBwYWdlLmdldEJ5VGVzdElkKCdvYmplY3QtbGlzdCcpLmdldEJ5Um9sZSgnb3B0aW9uJykuY291bnQoKSkudG9CZUxlc3NUaGFuKDEwMCk7XHJcbiAgICBleHBlY3QoYXdhaXQgcGFnZS5nZXRCeVRlc3RJZCgnY2FudmFzLWxhYmVsJykuY291bnQoKSkudG9CZUxlc3NUaGFuT3JFcXVhbCgxMDApO1xyXG4gICAgYXdhaXQgcGFnZS5zY3JlZW5zaG90KHsgcGF0aDogaW5mby5vdXRwdXRQYXRoKCdsb2FkZWQtaGFyZHdhcmUucG5nJyksIGZ1bGxQYWdlOiB0cnVlIH0pO1xyXG4gICAgY29uc3QgY2RwID0gYXdhaXQgcGFnZS5jb250ZXh0KCkubmV3Q0RQU2Vzc2lvbihwYWdlKTtcclxuICAgIGF3YWl0IGNkcC5zZW5kKCdQZXJmb3JtYW5jZS5lbmFibGUnKTtcclxuICAgIGF3YWl0IGNkcC5zZW5kKCdIZWFwUHJvZmlsZXIuY29sbGVjdEdhcmJhZ2UnKTtcclxuICAgIGF3YWl0IHBhZ2UuZXhwb3NlQmluZGluZygnX190MzFUYXNrRHVyYXRpb24nLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IG1ldHJpY3MgPSAoYXdhaXQgY2RwLnNlbmQoJ1BlcmZvcm1hbmNlLmdldE1ldHJpY3MnKSkubWV0cmljcztcclxuICAgICAgY29uc3QgZHVyYXRpb24gPSBtZXRyaWNzLmZpbmQobWV0cmljID0+IG1ldHJpYy5uYW1lID09PSAnVGFza0R1cmF0aW9uJyk7XHJcbiAgICAgIGlmICghZHVyYXRpb24pIHRocm93IG5ldyBFcnJvcignQ2hyb21pdW0gZG9lcyBub3QgZXhwb3NlIG1haW4tdGhyZWFkIFRhc2tEdXJhdGlvbicpO1xyXG4gICAgICByZXR1cm4gZHVyYXRpb24udmFsdWUgKiAxMDAwO1xyXG4gICAgfSk7XHJcbiAgICBldmlkZW5jZS5oZWFwX2JlZm9yZSA9IChhd2FpdCBjZHAuc2VuZCgnUGVyZm9ybWFuY2UuZ2V0TWV0cmljcycpKS5tZXRyaWNzLmZpbHRlcihtZXRyaWMgPT4gbWV0cmljLm5hbWUuc3RhcnRzV2l0aCgnSlNIZWFwJykpO1xyXG4gICAgY29uc3QgYmVmb3JlID0gYXdhaXQgcGFnZS5ldmFsdWF0ZSgoKSA9PiAoeyBnZW5lcmF0aW9uOiB3aW5kb3cuX193bF90ZXN0IS5nZW5lcmF0aW9uKCksIHNhdmVzOiB3aW5kb3cuX193bF90ZXN0IS5zYXZlQ291bnQoKSwgdmFsaWRhdGlvbjogd2luZG93Ll9fd2xfdGVzdCEudmFsaWRhdGlvbklucHV0T2JqZWN0cygpLCBzZXJpYWxpemF0aW9uOiB3aW5kb3cuX193bF90ZXN0IS5zZXJpYWxpemVkSW5wdXRPYmplY3RzKCkgfSkpO1xyXG4gICAgY29uc3QgcmVjdCA9IChhd2FpdCBwYWdlLmdldEJ5VGVzdElkKCdhbm5vdGF0aW9uLWNhbnZhcycpLmJvdW5kaW5nQm94KCkpITtcclxuICAgIGF3YWl0IHBhZ2UuZXZhbHVhdGUoKCkgPT4gd2luZG93Ll9fd2xfdGVzdCEudG9vbCgnYm94JykpO1xyXG4gICAgYXdhaXQgcGFnZS5tb3VzZS5tb3ZlKHJlY3QueCArIHJlY3Qud2lkdGggLyAyLCByZWN0LnkgKyByZWN0LmhlaWdodCAvIDIpO1xyXG4gICAgYXdhaXQgcGFnZS5tb3VzZS5kb3duKCk7XHJcbiAgICBmb3IgKGNvbnN0IHNjZW5hcmlvIG9mIFsncG9pbnRlcl9kcmFnJywgJ3BhbicsICd6b29tJywgJ2NvbW1pdHRlZF9lZGl0J10gYXMgY29uc3QpIHtcclxuICAgICAgaWYgKHNjZW5hcmlvID09PSAncGFuJykge1xyXG4gICAgICAgIGF3YWl0IHBhZ2UuZ2V0QnlUZXN0SWQoJ2Fubm90YXRpb24tY2FudmFzJykuZGlzcGF0Y2hFdmVudCgncG9pbnRlcmNhbmNlbCcsIHsgcG9pbnRlcklkOiAxIH0pO1xyXG4gICAgICAgIGF3YWl0IHBhZ2UubW91c2UudXAoKTtcclxuICAgICAgICBleHBlY3QoYXdhaXQgcGFnZS5ldmFsdWF0ZSgoKSA9PiAoeyBnZW5lcmF0aW9uOiB3aW5kb3cuX193bF90ZXN0IS5nZW5lcmF0aW9uKCksIHNhdmVzOiB3aW5kb3cuX193bF90ZXN0IS5zYXZlQ291bnQoKSwgdmFsaWRhdGlvbjogd2luZG93Ll9fd2xfdGVzdCEudmFsaWRhdGlvbklucHV0T2JqZWN0cygpLCBzZXJpYWxpemF0aW9uOiB3aW5kb3cuX193bF90ZXN0IS5zZXJpYWxpemVkSW5wdXRPYmplY3RzKCkgfSkpKS50b0VxdWFsKGJlZm9yZSk7XHJcbiAgICAgIH1cclxuICAgICAgY29uc3Qgcm93cyA9IGF3YWl0IHBhZ2UuZXZhbHVhdGUoYXN5bmMgKHsgc2NlbmFyaW8sIHgsIHkgfSkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGhvb2tzID0gd2luZG93Ll9fd2xfdGVzdCE7XHJcbiAgICAgICAgY29uc3QgY2FudmFzID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcjxIVE1MQ2FudmFzRWxlbWVudD4oJ1tkYXRhLXRlc3RpZD1cImFubm90YXRpb24tY2FudmFzXCJdJykhO1xyXG4gICAgICAgIGNvbnN0IHJvd3MgPSBbXTtcclxuICAgICAgICBmb3IgKGxldCBpbmRleCA9IC00MDsgaW5kZXggPCAxMDAwOyBpbmRleCsrKSB7XHJcbiAgICAgICAgICBjb25zdCBzZXF1ZW5jZSA9IGluZGV4ICsgNDA7XHJcbiAgICAgICAgICBjb25zdCB0YXNrQmVmb3JlID0gYXdhaXQgd2luZG93Ll9fdDMxVGFza0R1cmF0aW9uKCk7XHJcbiAgICAgICAgICBjb25zdCBwcmV2aW91cyA9IGhvb2tzLnN0YXRzKCk7XHJcbiAgICAgICAgICBjb25zdCBuYXRpdmVCZWZvcmUgPSB3aW5kb3cuX190MzEuc3VibWlzc2lvbnM7XHJcbiAgICAgICAgICBjb25zdCByYWZDcHUgPSB3aW5kb3cuX190MzEucmFmX2NwdV9tcztcclxuICAgICAgICAgIGNvbnN0IHN0YXJ0ZWQgPSBwZXJmb3JtYW5jZS5ub3coKTtcclxuICAgICAgICAgIGxldCBzZXR0bGVkOiBQcm9taXNlPHZvaWQ+IHwgdW5kZWZpbmVkO1xyXG4gICAgICAgICAgaWYgKHNjZW5hcmlvID09PSAncG9pbnRlcl9kcmFnJykgY2FudmFzLmRpc3BhdGNoRXZlbnQobmV3IFBvaW50ZXJFdmVudCgncG9pbnRlcm1vdmUnLCB7IHBvaW50ZXJJZDogMSwgY2xpZW50WDogeCArIDIgKyBzZXF1ZW5jZSAlIDgwLCBjbGllbnRZOiB5ICsgMiArIChzZXF1ZW5jZSAlIDgwKSAvIDIsIGJ1dHRvbnM6IDEsIGJ1dHRvbjogMCwgYnViYmxlczogdHJ1ZSB9KSk7XHJcbiAgICAgICAgICBpZiAoc2NlbmFyaW8gPT09ICdwYW4nKSBzZXR0bGVkID0gaG9va3MucGFuKHNlcXVlbmNlICUgMiA/IC0xIDogMSwgMCk7XHJcbiAgICAgICAgICBpZiAoc2NlbmFyaW8gPT09ICd6b29tJykgc2V0dGxlZCA9IGhvb2tzLnpvb20oc2VxdWVuY2UgJSAyID8gMSAvIDEuMDA1IDogMS4wMDUpO1xyXG4gICAgICAgICAgaWYgKHNjZW5hcmlvID09PSAnY29tbWl0dGVkX2VkaXQnKSBzZXR0bGVkID0gaG9va3MuZWRpdE9iamVjdCgzNywgc2VxdWVuY2UgJSAyID8gLTEgOiAxKTtcclxuICAgICAgICAgIGNvbnN0IHN5bmNocm9ub3VzID0gcGVyZm9ybWFuY2Uubm93KCkgLSBzdGFydGVkO1xyXG4gICAgICAgICAgaWYgKHNldHRsZWQpIGF3YWl0IHNldHRsZWQ7XHJcbiAgICAgICAgICBlbHNlIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KHJlc29sdmUgPT4gcmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiByZXNvbHZlKCkpKSk7XHJcbiAgICAgICAgICBjb25zdCBlbGFwc2VkID0gcGVyZm9ybWFuY2Uubm93KCkgLSBzdGFydGVkO1xyXG4gICAgICAgICAgY29uc3QgdGFza0FmdGVyID0gYXdhaXQgd2luZG93Ll9fdDMxVGFza0R1cmF0aW9uKCk7XHJcbiAgICAgICAgICBjb25zdCBhZnRlciA9IGhvb2tzLnN0YXRzKCk7XHJcbiAgICAgICAgICBpZiAoaW5kZXggPj0gMCkgcm93cy5wdXNoKHsgc2VxdWVuY2U6IGluZGV4LCBjcHVfbXM6IE1hdGgubWF4KHRhc2tBZnRlciAtIHRhc2tCZWZvcmUsIHN5bmNocm9ub3VzICsgd2luZG93Ll9fdDMxLnJhZl9jcHVfbXMgLSByYWZDcHUpLCB0YXNrX2NwdV9tczogdGFza0FmdGVyIC0gdGFza0JlZm9yZSwgc3luY2hyb25vdXNfY3B1X21zOiBzeW5jaHJvbm91cywgcmFmX2NwdV9tczogd2luZG93Ll9fdDMxLnJhZl9jcHVfbXMgLSByYWZDcHUsIGJyaWRnZV9jcHVfbXM6IGFmdGVyLmJyaWRnZV9lbGFwc2VkX21zIC0gcHJldmlvdXMuYnJpZGdlX2VsYXBzZWRfbXMsIGRvdWJsZV9yYWZfbXM6IGVsYXBzZWQsIHN1Ym1pc3Npb25zOiBhZnRlci5ncHVfc3VibWlzc2lvbnMgLSBwcmV2aW91cy5ncHVfc3VibWlzc2lvbnMsIG5hdGl2ZV9zdWJtaXNzaW9uczogd2luZG93Ll9fdDMxLnN1Ym1pc3Npb25zIC0gbmF0aXZlQmVmb3JlLCBiYm94X3VwbG9hZF9ieXRlczogYWZ0ZXIuYmJveF91cGxvYWRfYnl0ZXMgLSBwcmV2aW91cy5iYm94X3VwbG9hZF9ieXRlcywgd2FzbV9iaW5hcnlfYnl0ZXM6IGFmdGVyLmpzX3dhc21fYmluYXJ5X2J5dGVzIC0gcHJldmlvdXMuanNfd2FzbV9iaW5hcnlfYnl0ZXMgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiByb3dzO1xyXG4gICAgICB9LCB7IHNjZW5hcmlvLCB4OiByZWN0LnggKyByZWN0LndpZHRoIC8gMiwgeTogcmVjdC55ICsgcmVjdC5oZWlnaHQgLyAyIH0pO1xyXG4gICAgICAoZXZpZGVuY2Uuc2NlbmFyaW9zIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVtzY2VuYXJpb10gPSByb3dzO1xyXG4gICAgICBhd2FpdCBzYXZlKCk7IC8vIFByZXNlcnZlIGV2ZXJ5IHNhbXBsZSBiZWZvcmUgYW55IHRocmVzaG9sZC9pbnZhcmlhbnQgYXNzZXJ0aW9uLlxyXG4gICAgICBleHBlY3Qocm93cykudG9IYXZlTGVuZ3RoKDEwMDApO1xyXG4gICAgICBleHBlY3Qocm93cy5ldmVyeShyb3cgPT4gcm93LnN1Ym1pc3Npb25zID09PSAxICYmIHJvdy5uYXRpdmVfc3VibWlzc2lvbnMgPT09IDEgJiYgcm93Lndhc21fYmluYXJ5X2J5dGVzID09PSAwKSkudG9CZSh0cnVlKTtcclxuICAgICAgaWYgKHNjZW5hcmlvID09PSAncGFuJyB8fCBzY2VuYXJpbyA9PT0gJ3pvb20nKSBleHBlY3Qocm93cy5ldmVyeShyb3cgPT4gcm93LmJib3hfdXBsb2FkX2J5dGVzID09PSAwKSkudG9CZSh0cnVlKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHBlcmZvcm1hbmNlUmVzdWx0ID0gZ2F0ZShjb3VudCwgZXZpZGVuY2Uuc2NlbmFyaW9zKTtcclxuICAgIGV2aWRlbmNlLnBlcmZvcm1hbmNlID0gcGVyZm9ybWFuY2VSZXN1bHQ7IGF3YWl0IHNhdmUoKTtcclxuICAgIGV4cGVjdC5zb2Z0KHBlcmZvcm1hbmNlUmVzdWx0LmZhaWx1cmVzLCAnVW5jaGFuZ2VkIHRhcmdldDsgcmVmZXIgdGhyZXNob2xkIGZhaWx1cmVzIHRvIFQyOCwgcHJlc2VydmUgYWxsIHJhdyBzYW1wbGVzJykudG9FcXVhbChbXSk7XHJcbiAgICBhd2FpdCBwYWdlLmV2YWx1YXRlKCgpID0+IHdpbmRvdy5fX3dsX3Rlc3QhLmZsdXNoKCkpO1xyXG4gICAgZXhwZWN0KChhd2FpdCBwYWdlLmV2YWx1YXRlKCgpID0+IHdpbmRvdy5fX3dsX3Rlc3QhLnNuYXBzaG90KCkpKS5vYmplY3RzKS50b0VxdWFsKG9yaWdpbmFsLm9iamVjdHMpO1xyXG4gICAgY29uc3QgaWRsZUJlZm9yZSA9IGF3YWl0IHBhZ2UuZXZhbHVhdGUoKCkgPT4gKHsgc3RhdHM6IHdpbmRvdy5fX3dsX3Rlc3QhLnN0YXRzKCksIG5hdGl2ZV9zdWJtaXNzaW9uczogd2luZG93Ll9fdDMxLnN1Ym1pc3Npb25zIH0pKTtcclxuICAgIGF3YWl0IHBhZ2Uud2FpdEZvclRpbWVvdXQoMTBfMDAwKTtcclxuICAgIGNvbnN0IGlkbGVBZnRlciA9IGF3YWl0IHBhZ2UuZXZhbHVhdGUoKCkgPT4gKHsgc3RhdHM6IHdpbmRvdy5fX3dsX3Rlc3QhLnN0YXRzKCksIG5hdGl2ZV9zdWJtaXNzaW9uczogd2luZG93Ll9fdDMxLnN1Ym1pc3Npb25zIH0pKTtcclxuICAgIGV2aWRlbmNlLmlkbGUgPSB7IHNlY29uZHM6IDEwLCBiZWZvcmU6IGlkbGVCZWZvcmUsIGFmdGVyOiBpZGxlQWZ0ZXIgfTsgYXdhaXQgc2F2ZSgpO1xyXG4gICAgZXhwZWN0KGlkbGVBZnRlci5uYXRpdmVfc3VibWlzc2lvbnMpLnRvQmUoaWRsZUJlZm9yZS5uYXRpdmVfc3VibWlzc2lvbnMpO1xyXG4gICAgZXhwZWN0KGlkbGVBZnRlci5zdGF0cy5ncHVfc3VibWlzc2lvbnMpLnRvQmUoaWRsZUJlZm9yZS5zdGF0cy5ncHVfc3VibWlzc2lvbnMpO1xyXG4gICAgY29uc3Qgb3RoZXJJbmRleCA9IFttZWRpYSwgLi4uYXNzZXRzLmZpbHRlcihhc3NldCA9PiBhc3NldCAhPT0gbWVkaWEpXS5maW5kSW5kZXgoYXNzZXQgPT4gYXNzZXQub3JpZ2luYWxfbmFtZSA9PT0gJ3QzMS1iLnBuZycpO1xyXG4gICAgLy8gQWx0ZXJuYXRlIHRoZSB0d28gYWN0dWFsIDIwNDggaW1hZ2VzOyByZXNvdXJjZXMgbWVhc3VyZWQgYWZ0ZXIgZXZlcnkgc3dpdGNoLlxyXG4gICAgY29uc3QgcmVzb3VyY2VzOiBUMjhTdGF0c1tdID0gW107XHJcbiAgICBjb25zdCBuYXRpdmVSZXNvdXJjZXM6IHsgcmVzb3VyY2VzOiBOYXRpdmVSZXNvdXJjZUNvdW50czsgbGl2ZV9kZXZpY2VzOiBudW1iZXI7IGNyZWF0ZWRfZGV2aWNlczogbnVtYmVyIH1bXSA9IFtdO1xyXG4gICAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IDEwMDsgaW5kZXgrKykge1xyXG4gICAgICBhd2FpdCBwYWdlLmV2YWx1YXRlKGluZGV4ID0+IHdpbmRvdy5fX3dsX3Rlc3QhLmNoYW5nZUFzc2V0KGluZGV4KSwgaW5kZXggJSAyID8gMCA6IG90aGVySW5kZXgpO1xyXG4gICAgICByZXNvdXJjZXMucHVzaChhd2FpdCBwYWdlLmV2YWx1YXRlKCgpID0+IHdpbmRvdy5fX3dsX3Rlc3QhLnN0YXRzKCkpKTtcclxuICAgICAgbmF0aXZlUmVzb3VyY2VzLnB1c2goYXdhaXQgcGFnZS5ldmFsdWF0ZSgoKSA9PiAoeyByZXNvdXJjZXM6IHN0cnVjdHVyZWRDbG9uZSh3aW5kb3cuX190MzEucmVzb3VyY2VzKSwgbGl2ZV9kZXZpY2VzOiB3aW5kb3cuX190MzEuZGV2aWNlcy5sZW5ndGgsIGNyZWF0ZWRfZGV2aWNlczogd2luZG93Ll9fdDMxLmRldmljZV9jcmVhdGlvbnMgfSkpKTtcclxuICAgIH1cclxuICAgIGV2aWRlbmNlLnJlc291cmNlcyA9IHJlc291cmNlczsgYXdhaXQgc2F2ZSgpO1xyXG4gICAgZXZpZGVuY2UubmF0aXZlX3Jlc291cmNlcyA9IG5hdGl2ZVJlc291cmNlczsgYXdhaXQgc2F2ZSgpO1xyXG4gICAgZXhwZWN0KG5hdGl2ZVJlc291cmNlcy5ldmVyeShyb3cgPT4gcm93LmxpdmVfZGV2aWNlcyA9PT0gMSAmJiByb3cucmVzb3VyY2VzLmJ1ZmZlcnMubGl2ZSA9PT0gbmF0aXZlUmVzb3VyY2VzWzBdLnJlc291cmNlcy5idWZmZXJzLmxpdmUgJiYgcm93LnJlc291cmNlcy50ZXh0dXJlcy5saXZlID09PSBuYXRpdmVSZXNvdXJjZXNbMF0ucmVzb3VyY2VzLnRleHR1cmVzLmxpdmUpKS50b0JlKHRydWUpO1xyXG4gICAgZXhwZWN0KHJlc291cmNlcy5ldmVyeShyb3cgPT4gcm93LmxpdmVfdGV4dHVyZXMgPT09IHJlc291cmNlc1swXS5saXZlX3RleHR1cmVzICYmIHJvdy5saXZlX2J1ZmZlcnMgPT09IHJlc291cmNlc1swXS5saXZlX2J1ZmZlcnMgJiYgcm93LmxvZ2ljYWxfdGV4dHVyZV9ieXRlcyA9PT0gcmVzb3VyY2VzWzBdLmxvZ2ljYWxfdGV4dHVyZV9ieXRlcyAmJiByb3cubGl2ZV9kZWNvZGVkX2JpdG1hcHMgPT09IDApKS50b0JlKHRydWUpO1xyXG4gICAgYXdhaXQgY2RwLnNlbmQoJ0hlYXBQcm9maWxlci5jb2xsZWN0R2FyYmFnZScpO1xyXG4gICAgZXZpZGVuY2UuaGVhcF9hZnRlciA9IChhd2FpdCBjZHAuc2VuZCgnUGVyZm9ybWFuY2UuZ2V0TWV0cmljcycpKS5tZXRyaWNzLmZpbHRlcihtZXRyaWMgPT4gbWV0cmljLm5hbWUuc3RhcnRzV2l0aCgnSlNIZWFwJykpO1xyXG4gICAgY29uc3Qgc25hcHNob3QgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKCgpID0+IHdpbmRvdy5fX3dsX3Rlc3QhLnNuYXBzaG90KCkpO1xyXG4gICAgY29uc3QgY2Fub25pY2FsID0gc25hcHNob3Qub2JqZWN0c1szN10uZ2VvbWV0cnk7XHJcbiAgICBhd2FpdCBwYWdlLmV2YWx1YXRlKGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgaG9va3MgPSB3aW5kb3cuX193bF90ZXN0ISwgYm94ID0gaG9va3Muc25hcHNob3QoKS5vYmplY3RzWzM3XS5nZW9tZXRyeTtcclxuICAgICAgYXdhaXQgaG9va3Muem9vbSg2NCAvIChNYXRoLm1pbihib3gueF9tYXggLSBib3gueF9taW4sIGJveC55X21heCAtIGJveC55X21pbikgKiBob29rcy52aWV3cG9ydCgpLnNjYWxlKSk7XHJcbiAgICAgIGNvbnN0IHZpZXcgPSBob29rcy52aWV3cG9ydCgpO1xyXG4gICAgICBhd2FpdCBob29rcy5wYW4odmlldy5jc3Nfd2lkdGggLyAyIC0gKGJveC54X21pbiArIGJveC54X21heCkgLyAyICogdmlldy5zY2FsZSAtIHZpZXcudHgsIHZpZXcuY3NzX2hlaWdodCAvIDIgLSAoYm94LnlfbWluICsgYm94LnlfbWF4KSAvIDIgKiB2aWV3LnNjYWxlIC0gdmlldy50eSk7XHJcbiAgICB9KTtcclxuICAgIC8vIEFjdHVhbCByZXNpemUgYW5kIERQUiB0cmFuc2l0aW9uczsgaW1hZ2UgY29vcmRpbmF0ZXMgbXVzdCBub3QgYWJzb3JiIERQUi5cclxuICAgIGNvbnN0IHByb2plY3Rpb25zID0gW107XHJcbiAgICBmb3IgKGNvbnN0IFt3aWR0aCwgZHByXSBvZiBbWzE0NDAsIDFdLCBbMTMyMCwgMS4yNV0sIFsxMjAwLCAyXSwgWzE0NDAsIDNdXSBhcyBjb25zdCkge1xyXG4gICAgICBhd2FpdCBjZHAuc2VuZCgnRW11bGF0aW9uLnNldERldmljZU1ldHJpY3NPdmVycmlkZScsIHsgd2lkdGgsIGhlaWdodDogMTAwMCwgZGV2aWNlU2NhbGVGYWN0b3I6IGRwciwgbW9iaWxlOiBmYWxzZSB9KTtcclxuICAgICAgYXdhaXQgcGFnZS5ldmFsdWF0ZShhc3luYyAoKSA9PiB7IHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBFdmVudCgncmVzaXplJykpOyBhd2FpdCB3aW5kb3cuX193bF90ZXN0IS5zZWxlY3QoJ2RlbnNlLTE3LTM3Jyk7IGF3YWl0IHdpbmRvdy5fX3dsX3Rlc3QhLnpvb20oMS4wMDUpOyB9KTtcclxuICAgICAgY29uc3QgcHJvamVjdGlvbiA9IGF3YWl0IHBhZ2UuZXZhbHVhdGUoKCkgPT4geyBjb25zdCBob29rcyA9IHdpbmRvdy5fX3dsX3Rlc3QhLCBib3ggPSBob29rcy5zbmFwc2hvdCgpLm9iamVjdHNbMzddLmdlb21ldHJ5LCB2aWV3ID0gaG9va3Mudmlld3BvcnQoKSwgbGFiZWwgPSBob29rcy5sYWJlbHMoKS5maW5kKGxhYmVsID0+IGxhYmVsLm9iamVjdF9pZCA9PT0gJ2RlbnNlLTE3LTM3JykhOyByZXR1cm4geyBib3gsIHZpZXcsIGxhYmVsLCBkcHI6IGRldmljZVBpeGVsUmF0aW8gfTsgfSk7XHJcbiAgICAgIGV4cGVjdChwcm9qZWN0aW9uLmJveCkudG9FcXVhbChjYW5vbmljYWwpO1xyXG4gICAgICBleHBlY3QocHJvamVjdGlvbi5kcHIpLnRvQmUoZHByKTtcclxuICAgICAgZXhwZWN0KGF3YWl0IHBhZ2UuZXZhbHVhdGUoKCkgPT4gd2luZG93Ll9fd2xfdGVzdCEuc25hcHNob3QoKSkpLnRvRXF1YWwoc25hcHNob3QpO1xyXG4gICAgICBleHBlY3QoTWF0aC5hYnMocHJvamVjdGlvbi5sYWJlbC54X2NzcyAtIChjYW5vbmljYWwueF9taW4gKiBwcm9qZWN0aW9uLnZpZXcuc2NhbGUgKyBwcm9qZWN0aW9uLnZpZXcudHgpKSkudG9CZUxlc3NUaGFuT3JFcXVhbCgwLjUpO1xyXG4gICAgICBleHBlY3QoTWF0aC5hYnMocHJvamVjdGlvbi5sYWJlbC55X2NzcyAtIChjYW5vbmljYWwueV9taW4gKiBwcm9qZWN0aW9uLnZpZXcuc2NhbGUgKyBwcm9qZWN0aW9uLnZpZXcudHkpKSkudG9CZUxlc3NUaGFuT3JFcXVhbCgwLjUpO1xyXG4gICAgICBjb25zdCBuYXRpdmUgPSBhd2FpdCBtZWFzdXJlTmF0aXZlQ29udHJvbHMocGFnZSwgaW5mbywgY2Fub25pY2FsLCBwcm9qZWN0aW9uLnZpZXcsIGRwcik7XHJcbiAgICAgIHByb2plY3Rpb25zLnB1c2goeyAuLi5wcm9qZWN0aW9uLCAuLi5uYXRpdmUgfSk7XHJcbiAgICAgIGV2aWRlbmNlLnByb2plY3Rpb25zID0gcHJvamVjdGlvbnM7IGF3YWl0IHNhdmUoKTtcclxuICAgICAgYXdhaXQgcGFnZS5zY3JlZW5zaG90KHsgcGF0aDogaW5mby5vdXRwdXRQYXRoKGBwcm9qZWN0aW9uLWRwci0ke2Rwcn0ucG5nYCksIHNjYWxlOiAnY3NzJyB9KTtcclxuICAgIH1cclxuICAgIGV2aWRlbmNlLnByb2plY3Rpb25zID0gcHJvamVjdGlvbnM7XHJcbiAgICBjb25zdCBjYW52YXMgPSBwYWdlLmdldEJ5VGVzdElkKCdhbm5vdGF0aW9uLWNhbnZhcycpO1xyXG4gICAgYXdhaXQgY2FudmFzLmV2YWx1YXRlKGNhbnZhcyA9PiB7IGNhbnZhcy5zdHlsZS53aWR0aCA9ICcwcHgnOyBjYW52YXMuc3R5bGUuaGVpZ2h0ID0gJzBweCc7IH0pO1xyXG4gICAgYXdhaXQgcGFnZS53YWl0Rm9yVGltZW91dCgzMDApO1xyXG4gICAgY29uc3QgemVyb0JlZm9yZSA9IGF3YWl0IHBhZ2UuZXZhbHVhdGUoKCkgPT4gd2luZG93Ll9fdDMxLnN1Ym1pc3Npb25zKTtcclxuICAgIGF3YWl0IHBhZ2UuZXZhbHVhdGUoYXN5bmMgKCkgPT4geyBhd2FpdCB3aW5kb3cuX193bF90ZXN0IS5wYW4oMSwgMCk7IGF3YWl0IHdpbmRvdy5fX3dsX3Rlc3QhLnpvb20oMS4wMDUpOyB9KTtcclxuICAgIGF3YWl0IHBhZ2Uud2FpdEZvclRpbWVvdXQoMzAwKTtcclxuICAgIGV4cGVjdChhd2FpdCBwYWdlLmV2YWx1YXRlKCgpID0+IHdpbmRvdy5fX3QzMS5zdWJtaXNzaW9ucykpLnRvQmUoemVyb0JlZm9yZSk7XHJcbiAgICBleHBlY3QoYXdhaXQgcGFnZS5ldmFsdWF0ZSgoKSA9PiB3aW5kb3cuX190MzEuemVyb19zaXplX3N1Ym1pc3Npb25zKSkudG9CZSgwKTtcclxuICAgIGF3YWl0IGNhbnZhcy5ldmFsdWF0ZShjYW52YXMgPT4geyBjYW52YXMuc3R5bGUud2lkdGggPSAnMTAwJSc7IGNhbnZhcy5zdHlsZS5oZWlnaHQgPSAnMTAwJSc7IH0pO1xyXG4gICAgYXdhaXQgcGFnZS53YWl0Rm9yVGltZW91dCgzMDApO1xyXG4gICAgZXhwZWN0KGF3YWl0IHBhZ2UuZXZhbHVhdGUoKCkgPT4gd2luZG93Ll9fdDMxLnN1Ym1pc3Npb25zKSkudG9CZUdyZWF0ZXJUaGFuKHplcm9CZWZvcmUpO1xyXG4gICAgY29uc3QgbG9zc0JlZm9yZSA9IGF3YWl0IHBhZ2UuZXZhbHVhdGUoKCkgPT4gKHsgc25hcHNob3Q6IHdpbmRvdy5fX3dsX3Rlc3QhLnNuYXBzaG90KCksIGdlbmVyYXRpb246IHdpbmRvdy5fX3dsX3Rlc3QhLmdlbmVyYXRpb24oKSwgZGV2aWNlczogd2luZG93Ll9fdDMxLmRldmljZV9jcmVhdGlvbnMsIGxvc3Nlczogd2luZG93Ll9fdDMxLmxvc3Nlcy5sZW5ndGggfSkpO1xyXG4gICAgYXdhaXQgcGFnZS5ldmFsdWF0ZSgoKSA9PiB3aW5kb3cuX190MzEuZGV2aWNlcy5hdCgtMSkhLmRlc3Ryb3koKSk7XHJcbiAgICBhd2FpdCBleHBlY3QucG9sbCgoKSA9PiBwYWdlLmV2YWx1YXRlKCgpID0+IHdpbmRvdy5fX3QzMS5sb3NzZXMubGVuZ3RoKSkudG9CZShsb3NzQmVmb3JlLmxvc3NlcyArIDEpO1xyXG4gICAgYXdhaXQgZXhwZWN0LnBvbGwoKCkgPT4gcGFnZS5ldmFsdWF0ZSgoKSA9PiB3aW5kb3cuX190MzEuZGV2aWNlX2NyZWF0aW9ucykpLnRvQmUobG9zc0JlZm9yZS5kZXZpY2VzICsgMSk7XHJcbiAgICBhd2FpdCBleHBlY3QocGFnZS5nZXRCeVRlc3RJZCgnZ3B1LXN0YXR1cycpKS50b0hhdmVBdHRyaWJ1dGUoJ2RhdGEtZGV2aWNlLXN0YXRlJywgJ3JlYWR5Jyk7XHJcbiAgICBleHBlY3QoYXdhaXQgcGFnZS5ldmFsdWF0ZSgoKSA9PiB3aW5kb3cuX193bF90ZXN0IS5zbmFwc2hvdCgpKSkudG9FcXVhbChsb3NzQmVmb3JlLnNuYXBzaG90KTtcclxuICAgIGV4cGVjdChhd2FpdCBwYWdlLmV2YWx1YXRlKCgpID0+IHdpbmRvdy5fX3dsX3Rlc3QhLmdlbmVyYXRpb24oKSkpLnRvQmUobG9zc0JlZm9yZS5nZW5lcmF0aW9uKTtcclxuICAgIGNvbnN0IHJlY292ZXJ5QmVmb3JlID0gYXdhaXQgcGFnZS5ldmFsdWF0ZSgoKSA9PiB3aW5kb3cuX190MzEuc3VibWlzc2lvbnMpO1xyXG4gICAgYXdhaXQgcGFnZS5ldmFsdWF0ZSgoKSA9PiB3aW5kb3cuX193bF90ZXN0IS5wYW4oLTEsIDApKTtcclxuICAgIGV4cGVjdChhd2FpdCBwYWdlLmV2YWx1YXRlKCgpID0+IHdpbmRvdy5fX3QzMS5zdWJtaXNzaW9ucykpLnRvQmUocmVjb3ZlcnlCZWZvcmUgKyAxKTtcclxuICAgIGV2aWRlbmNlLmxvc3MgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKCgpID0+ICh7IGxvc3Nlczogd2luZG93Ll9fdDMxLmxvc3NlcywgZXJyb3JzOiB3aW5kb3cuX190MzEuZXJyb3JzLCBuYXRpdmVfc3VibWlzc2lvbnM6IHdpbmRvdy5fX3QzMS5zdWJtaXNzaW9ucywgemVyb19zaXplX3N1Ym1pc3Npb25zOiB3aW5kb3cuX190MzEuemVyb19zaXplX3N1Ym1pc3Npb25zIH0pKTtcclxuICAgIGV4cGVjdChhd2FpdCBwYWdlLmV2YWx1YXRlKCgpID0+IHdpbmRvdy5fX3QzMS5lcnJvcnMpKS50b0VxdWFsKFtdKTtcclxuICAgIGF3YWl0IHBhZ2Uuc2NyZWVuc2hvdCh7IHBhdGg6IGluZm8ub3V0cHV0UGF0aCgncmVjb3ZlcmVkLWhhcmR3YXJlLnBuZycpLCBmdWxsUGFnZTogdHJ1ZSB9KTtcclxuICAgIGNvbnN0IGVudHJpZXM6IHsgbGl2ZV9kZXZpY2VzOiBudW1iZXI7IHJlc291cmNlczogTmF0aXZlUmVzb3VyY2VDb3VudHM7IHN0YXRzOiBUMjhTdGF0cyB9W10gPSBbXTtcclxuICAgIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCA1OyBpbmRleCsrKSB7XHJcbiAgICAgIGF3YWl0IHBhZ2UuZ290byhgJHtvcmlnaW59Lz9wcm9qZWN0X2lkPSR7c2VlZGVkUHJvamVjdC5wcm9qZWN0X2lkfWApO1xyXG4gICAgICBhd2FpdCBleHBlY3QocGFnZS5nZXRCeVRlc3RJZCgnYXNzZXQtZ3JpZCcpKS50b0JlVmlzaWJsZSgpO1xyXG4gICAgICBhd2FpdCBwYWdlLmdvdG8oYCR7b3JpZ2lufS90ZXN0LWhhcm5lc3MvZGVuc2U/Y291bnQ9JHtjb3VudH0mc2VlZD0xNyZwcm9qZWN0X2lkPSR7c2VlZGVkUHJvamVjdC5wcm9qZWN0X2lkfSZhc3NldF9yZXZpc2lvbl9pZD0ke21lZGlhLmFzc2V0X3JldmlzaW9uX2lkfWApO1xyXG4gICAgICBhd2FpdCBwYWdlLndhaXRGb3JGdW5jdGlvbigoKSA9PiB3aW5kb3cuX193bF90ZXN0Py5yZWFkeSA9PT0gdHJ1ZSk7XHJcbiAgICAgIGF3YWl0IGV4cGVjdChwYWdlLmdldEJ5VGVzdElkKCdncHUtc3RhdHVzJykpLnRvSGF2ZUF0dHJpYnV0ZSgnZGF0YS1kZXZpY2Utc3RhdGUnLCAncmVhZHknKTtcclxuICAgICAgZW50cmllcy5wdXNoKGF3YWl0IHBhZ2UuZXZhbHVhdGUoKCkgPT4gKHsgbGl2ZV9kZXZpY2VzOiB3aW5kb3cuX190MzEuZGV2aWNlcy5sZW5ndGgsIHJlc291cmNlczogc3RydWN0dXJlZENsb25lKHdpbmRvdy5fX3QzMS5yZXNvdXJjZXMpLCBzdGF0czogd2luZG93Ll9fd2xfdGVzdCEuc3RhdHMoKSB9KSkpO1xyXG4gICAgfVxyXG4gICAgZXZpZGVuY2UucmVwZWF0ZWRfd29ya2JlbmNoX2VudHJpZXMgPSBlbnRyaWVzOyBhd2FpdCBzYXZlKCk7XHJcbiAgICBleHBlY3QoZW50cmllcy5ldmVyeShyb3cgPT4gcm93LmxpdmVfZGV2aWNlcyA9PT0gMSAmJiByb3cucmVzb3VyY2VzLmJ1ZmZlcnMubGl2ZSA9PT0gZW50cmllc1swXS5yZXNvdXJjZXMuYnVmZmVycy5saXZlICYmIHJvdy5yZXNvdXJjZXMudGV4dHVyZXMubGl2ZSA9PT0gZW50cmllc1swXS5yZXNvdXJjZXMudGV4dHVyZXMubGl2ZSAmJiByb3cuc3RhdHMubGl2ZV9kZWNvZGVkX2JpdG1hcHMgPT09IDApKS50b0JlKHRydWUpO1xyXG4gIH0gZmluYWxseSB7IGF3YWl0IHNhdmUoKTsgfVxyXG59KTtcclxuXHJcbnRlc3QoJ3NvZnR3YXJlIGFuZCB1bmtub3duIGFkYXB0ZXJzIGNhbm5vdCBwYXNzIHRoZSBoYXJkd2FyZSBjbGFzc2lmaWVyIChub3QgaGFyZHdhcmUgZXZpZGVuY2UpJywgYXN5bmMgKCkgPT4ge1xyXG4gIGV4cGVjdChoYXJkd2FyZUtpbmQoeyB2ZW5kb3I6ICdnb29nbGUnLCBhcmNoaXRlY3R1cmU6ICdzd2lmdHNoYWRlcicsIGlzRmFsbGJhY2tBZGFwdGVyOiBmYWxzZSB9KSkudG9CZSgnc29mdHdhcmUnKTtcclxuICBleHBlY3QoaGFyZHdhcmVLaW5kKHsgdmVuZG9yOiAnbnZpZGlhJywgaXNGYWxsYmFja0FkYXB0ZXI6IHRydWUgfSkpLnRvQmUoJ3NvZnR3YXJlJyk7XHJcbiAgZXhwZWN0KGhhcmR3YXJlS2luZCh7IHZlbmRvcjogJycsIGFyY2hpdGVjdHVyZTogJycgfSkpLnRvQmUoJ3Vua25vd24nKTtcclxufSk7XHJcbiJdLCJtYXBwaW5ncyI6IkFBQUEsU0FBU0EscUJBQXFCLFFBQVEsbUNBQW1DO0FBQ3pFLFNBQVNDLFVBQVUsUUFBUSxhQUFhO0FBQ3hDLFNBQVNDLFFBQVEsRUFBRUMsU0FBUyxRQUFRLGtCQUFrQjtBQUN0RCxPQUFPQyxJQUFJLE1BQU0sV0FBVztBQUM1QixPQUFPQyxLQUFLLE1BQU0sT0FBTztBQUN6QixTQUFTQyxJQUFJLElBQUlDLFdBQVcsRUFBRUMsTUFBTSxFQUFFQyxzQkFBc0IsUUFBUSxpQkFBaUI7QUFJckYsU0FBU0MsSUFBSSxFQUFFQyxZQUFZLFFBQVEsOEJBQThCO0FBS2pFLE1BQU1DLEdBQUcsR0FBR0MsT0FBTyxDQUFDQyxHQUFHLENBQUNDLG9CQUFxQjtBQUM3QyxNQUFNQyxNQUFNLEdBQUdILE9BQU8sQ0FBQ0MsR0FBRyxDQUFDRyxtQkFBb0I7QUFFL0MsZUFBZUMsVUFBVUEsQ0FBQ0MsSUFBVSxFQUFFO0VBQ3BDLE1BQU1BLElBQUksQ0FBQ0MsYUFBYSxDQUFDLE1BQU07SUFDN0IsTUFBTUMsV0FBd0IsR0FBRztNQUFFQyxPQUFPLEVBQUUsRUFBRTtNQUFFQyxnQkFBZ0IsRUFBRSxDQUFDO01BQUVDLFNBQVMsRUFBRTtRQUFFQyxPQUFPLEVBQUU7VUFBRUMsSUFBSSxFQUFFLENBQUM7VUFBRUMsT0FBTyxFQUFFLENBQUM7VUFBRUMsUUFBUSxFQUFFO1FBQUUsQ0FBQztRQUFFQyxRQUFRLEVBQUU7VUFBRUgsSUFBSSxFQUFFLENBQUM7VUFBRUMsT0FBTyxFQUFFLENBQUM7VUFBRUMsUUFBUSxFQUFFO1FBQUU7TUFBRSxDQUFDO01BQUVFLFFBQVEsRUFBRSxFQUFFO01BQUVDLFVBQVUsRUFBRSxDQUFDO01BQUVDLE1BQU0sRUFBRSxFQUFFO01BQUVDLFdBQVcsRUFBRSxDQUFDO01BQUVDLHFCQUFxQixFQUFFLENBQUM7TUFBRUMsTUFBTSxFQUFFO0lBQUcsQ0FB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