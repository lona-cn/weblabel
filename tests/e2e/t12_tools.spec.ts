// T12 rectangle editing, shortcuts and dense selection in a real browser:
// real Chromium pointer/keyboard/wheel input on the canvas, the real wasm
// bridge facade on a real WebGPU device, the real Keyboard / SelectionLink /
// NumericGeometry / ToolSettings components, and real HTTP save requests
// observed by a loopback server. Nothing here calls internal dispatch to
// pretend to be a drag; every gesture is produced by browser input.
//
// Save-trigger semantics under test: server requests start ONLY from
// committed EditorDeltas (`document_changed === true`) through the shipped
// SelectionStore.save trigger. The request transport is a plain fetch stand-in
// for the T13 save queue (the queue is not this task's code); what is proven
// here is exactly which user actions can and cannot reach the network.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

test.use({ channel: 'chromium', launchOptions: { args: ['--enable-unsafe-webgpu'] } });

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const wasmOut = path.join(repoRoot, 'target', 'weblabel-wasm-bridge');
const harnessOut = path.join(repoRoot, 'target', 'weblabel-t12-harness.js');

const HARNESS_ENTRY = `
import { EditorHost } from './src/lib/editor/EditorHost';
import { createEditorFacadeFactory, loadWasmBridge } from './src/lib/editor/loader';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Keyboard } from './src/features/workbench/Keyboard';
import { SelectionLink, SelectionStore } from './src/features/workbench/SelectionLink';
import { NumericGeometry } from './src/features/workbench/NumericGeometry';
import { ToolSettings, ToolState } from './src/features/workbench/ToolSettings';

function goldenRgba() {
  const rgba = new Uint8Array(640 * 480 * 4);
  for (let y = 0; y < 480; y += 1) {
    for (let x = 0; x < 640; x += 1) {
      const offset = (y * 640 + x) * 4;
      rgba[offset] = x < 320 ? 230 : 35;
      rgba[offset + 1] = y < 240 ? 45 : 190;
      rgba[offset + 2] = x < 320 ? 25 : 210;
      rgba[offset + 3] = 255;
    }
  }
  return rgba;
}

function objectAt(id, xMin, yMin, xMax, yMax) {
  return {
    object_id: id,
    label_id: 'label_person',
    geometry: { type: 'bbox_xyxy', x_min: xMin, y_min: yMin, x_max: xMax, y_max: yMax },
    attributes: { helmet_state: 'unknown' },
    origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null },
  };
}

const FRAME = goldenRgba();

function makeRequest(objects, assetRevisionId) {
  return {
    media: {
      asset_id: 'e2e-asset', asset_revision_id: assetRevisionId, project_id: 'sample-project',
      original_name: 'e2e.png', original_sha256: 'a'.repeat(64), canonical_sha256: 'b'.repeat(64),
      canonical_width: 640, canonical_height: 480, exif_orientation: 1,
      original_to_canonical: [1, 0, 0, 0, 1, 0, 0, 0, 1], source_group_id: 'e2e-source',
    },
    ontology: {
      ontology_version_id: 'fixture-ontology-v1', project_id: 'sample-project', version_no: 1,
      labels: [{
        label_id: 'label_person', name: 'person', color: '#2878d0', shortcut: null,
        allowed_geometry_types: ['bbox_xyxy'],
        attributes: [{ key: 'helmet_state', kind: 'enum', required: true, default_value: 'unknown', enum_values: ['wearing', 'not_wearing', 'unknown'], min: null, max: null }],
      }],
      guidelines_markdown: 'e2e fixture', allow_out_of_bounds: false,
    },
    document: {
      schema_version: 1, asset_revision_id: assetRevisionId, ontology_version_id: 'fixture-ontology-v1',
      coordinate_space: { type: 'canonical_image_pixels', width: 640, height: 480 },
      completion: 'unprocessed',
      objects: objects.map(([id, xMin, yMin, xMax, yMax]) => objectAt(id, xMin, yMin, xMax, yMax)),
    },
    frame: { width: 640, height: 480, rgba: Uint8Array.from(FRAME) },
    initial_generation: 0,
  };
}

const state = {
  host: null,
  store: null,
  tools: null,
  bridge: null,
  pendingSaves: 0,
  selectionTrace: [],
  lastSelectionKey: '',
  captureTrace: [],
  contextmenuPrevented: null,
  lastPointerId: null,
};

window.__t12 = {
  makeRequest,
  async deviceProbe() {
    return state.bridge.initialize_browser_device_probe();
  },
  async boot() {
    const bridge = await loadWasmBridge('/wasm/wasm_bridge.js');
    state.bridge = bridge;
    const factory = createEditorFacadeFactory(bridge);
    const canvas = document.getElementById('t12-canvas');
    const store = new SelectionStore();
    const host = new EditorHost({ facadeFactory: factory, onDelta: (delta) => store.publish(delta) });
    const tools = new ToolState(host);
    state.host = host;
    state.store = store;
    state.tools = tools;
    store.subscribeSelection((ids) => {
      const key = ids.join(' ');
      if (state.lastSelectionKey !== key) {
        state.lastSelectionKey = key;
        state.selectionTrace.push(key);
      }
    });
    // The save trigger: only committed document changes reach this callback.
    // The fetch body is a transport stand-in for the T13 save queue.
    store.subscribeSaveNeeded((delta) => {
      state.pendingSaves += 1;
      fetch('/api/annotation-saves', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ generation: delta.generation, document: host.getSnapshot() }),
      }).finally(() => {
        state.pendingSaves -= 1;
      });
    });
    host.mount(canvas);
    canvas.addEventListener('gotpointercapture', (event) => state.captureTrace.push('got:' + event.pointerId));
    canvas.addEventListener('lostpointercapture', (event) => state.captureTrace.push('lost:' + event.pointerId));
    canvas.addEventListener('pointerdown', (event) => { state.lastPointerId = event.pointerId; }, true);
    canvas.addEventListener('contextmenu', (event) => { state.contextmenuPrevented = event.defaultPrevented; });
    createRoot(document.getElementById('t12-ui')).render(
      createElement('div', null,
        createElement(Keyboard, { host, tools, store, acceptsTarget: (target) => target === document.body || target === canvas || document.getElementById('t12-ui').contains(target) }),
        createElement(ToolSettings, { tools, host, store }),
        createElement(NumericGeometry, { store, host }),
        createElement(SelectionLink, { store }),
      ),
    );
    return true;
  },
  async load(objects, assetRevisionId) {
    await state.host.loadAsset(makeRequest(objects, assetRevisionId));
    return { status: state.host.status };
  },
  loadDetached(objects, assetRevisionId) {
    return state.host.loadAsset(makeRequest(objects, assetRevisionId));
  },
  state() {
    const snapshot = state.host.getSnapshot();
    return {
      generation: state.host.getGeneration(),
      viewport: state.host.getViewport(),
      selection: [...state.store.getSelection()],
      objects: snapshot === null ? [] : snapshot.objects.map((object) => ({
        id: object.object_id,
        x_min: object.geometry.x_min,
        y_min: object.geometry.y_min,
        x_max: object.geometry.x_max,
        y_max: object.geometry.y_max,
      })),
      pendingSaves: state.pendingSaves,
    };
  },
  trace() {
    return {
      selection: [...state.selectionTrace],
      capture: [...state.captureTrace],
      contextmenuPrevented: state.contextmenuPrevented,
      lastPointerId: state.lastPointerId,
    };
  },
  captured(pointerId) {
    return document.getElementById('t12-canvas').hasPointerCapture(pointerId);
  },
  dispatchWindowBlur() {
    window.dispatchEvent(new FocusEvent('blur'));
    return true;
  },
  dispatchComposition(kind) {
    window.dispatchEvent(new CompositionEvent(kind, { bubbles: true }));
    return true;
  },
  dispatchImeKey() {
    document.getElementById('t12-canvas').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, isComposing: true }),
    );
    return true;
  },
  dispatchPointerCancel(pointerId) {
    document.getElementById('t12-canvas').dispatchEvent(
      new PointerEvent('pointercancel', { pointerId, bubbles: true }),
    );
    return true;
  },
  setFlags(ids, flags) {
    return state.host.setLocalFlags(ids, flags);
  },
  setActiveLabel(labelId) {
    return state.host.setActiveLabel(labelId);
  },
  resetTrace() {
    state.selectionTrace.length = 0;
    state.captureTrace.length = 0;
    state.contextmenuPrevented = null;
    state.lastSelectionKey = state.store.getSelection().join(' ');
    return true;
  },
};
`;

interface EsbuildLike {
  build(options: Record<string, unknown>): Promise<unknown>;
}

interface Harness {
  makeRequest(objects: [string, number, number, number, number][], assetRevisionId: string): unknown;
  deviceProbe(): Promise<string>;
  boot(): Promise<boolean>;
  load(objects: [string, number, number, number, number][], assetRevisionId: string): Promise<{ status: string }>;
  loadDetached(objects: [string, number, number, number, number][], assetRevisionId: string): Promise<unknown>;
  state(): {
    generation: number | null;
    viewport: { scale: number; tx: number; ty: number; css_width: number; css_height: number; dpr: number } | null;
    selection: string[];
    objects: { id: string; x_min: number; y_min: number; x_max: number; y_max: number }[];
    pendingSaves: number;
  };
  trace(): {
    selection: string[];
    capture: string[];
    contextmenuPrevented: boolean | null;
    lastPointerId: number | null;
  };
  captured(pointerId: number): boolean;
  dispatchWindowBlur(): boolean;
  dispatchComposition(kind: string): boolean;
  dispatchImeKey(): boolean;
  dispatchPointerCancel(pointerId: number): boolean;
  setFlags(ids: string[], flags: { hidden?: boolean; locked?: boolean }): unknown;
  setActiveLabel(labelId: string): unknown;
  resetTrace(): boolean;
}

type T12Window = { __t12: Harness };

async function bootPage(page: Page): Promise<void> {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  await page.goto(`${server.origin}/`);
  try {
    await page.waitForFunction(() => Boolean((window as unknown as { __t12?: unknown }).__t12?.boot), undefined, { timeout: 15_000 });
    await page.evaluate(() => (window as unknown as T12Window).__t12.boot());
  } catch (error) {
    throw new Error(`harness module failed to boot:\n${pageErrors.join('\n')}\n${String(error)}`);
  }
}

async function canvasBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.getByTestId('annotation-canvas').boundingBox();
  if (!box) throw new Error('canvas has no box');
  return box;
}

async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as unknown as T12Window).__t12.state().pendingSaves === 0);
}

/** Real browser drag on the canvas from CSS point to CSS point. */
async function drag(page: Page, from: [number, number], to: [number, number], steps = 4): Promise<void> {
  const box = await canvasBox(page);
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    await page.mouse.move(box.x + from[0] + (to[0] - from[0]) * t, box.y + from[1] + (to[1] - from[1]) * t);
  }
  await page.mouse.up();
}

async function click(page: Page, at: [number, number], modifiers: { ctrl?: boolean; shift?: boolean } = {}): Promise<void> {
  const box = await canvasBox(page);
  if (modifiers.ctrl === true) await page.keyboard.down('Control');
  if (modifiers.shift === true) await page.keyboard.down('Shift');
  await page.mouse.click(box.x + at[0], box.y + at[1]);
  if (modifiers.shift === true) await page.keyboard.up('Shift');
  if (modifiers.ctrl === true) await page.keyboard.up('Control');
}

const PERSON: [string, number, number, number, number] = ['object_person_001', 10, 20, 110, 220];
const SECOND: [string, number, number, number, number] = ['object_person_002', 200, 200, 300, 300];
const OVERLAP_100: [string, number, number, number, number][] = Array.from({ length: 100 }, (_, index) => [
  `object_overlap_${String(index).padStart(3, '0')}`,
  300,
  300,
  400,
  400,
]);

const SOFTWARE_ADAPTER = /cpu|software|swiftshader|llvmpipe|lavapipe|mesa|basic render/i;

const server: { origin: string; requests: { url: string; body: string }[]; close: () => Promise<void> } = {
  origin: '',
  requests: [],
  close: async () => {},
};

test.beforeAll(async () => {
  buildWasmBundle();
  await buildHarnessBundle();
  const httpServer: Server = createServer((request, response) => {
    const url = request.url ?? '/';
    if (request.method === 'POST' && url === '/api/annotation-saves') {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        server.requests.push({ url, body });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
      });
      return;
    }
    if (url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style></head><body>'
        + '<canvas id="t12-canvas" data-testid="annotation-canvas" style="width:640px;height:480px;display:block"></canvas>'
        + '<div id="t12-ui"></div><input data-testid="text-input" />'
        + '<script type="module" src="/harness.js"></script></body></html>',
      );
      return;
    }
    if (url === '/harness.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end(fs.readFileSync(harnessOut));
      return;
    }
    if (url === '/wasm/wasm_bridge.js' || url === '/wasm/wasm_bridge_bg.wasm') {
      response.writeHead(200, {
        'content-type': url.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8',
      });
      response.end(fs.readFileSync(path.join(wasmOut, path.basename(url))));
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('save server has no port');
  server.origin = `http://127.0.0.1:${address.port}`;
  server.close = () =>
    new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
}, 1_200_000);

test.afterAll(async () => {
  await server.close();
});

function buildWasmBundle(): void {
  const toolchain = fs.readFileSync(path.join(repoRoot, 'rust-toolchain.toml'), 'utf8');
  const channel = /channel\s*=\s*"([^"]+)"/.exec(toolchain)?.[1];
  if (!channel) throw new Error('rust-toolchain.toml has no pinned channel');
  // cwd outside the user profile: the user-global cargo config enables an
  // unstable codegen-backend that the pinned stable toolchain rejects as an
  // ancestor config (reports/T21 environment_note). RUSTUP_TOOLCHAIN restores
  // the repo pin that rustup would otherwise resolve from the cwd.
  const env = { ...process.env, RUSTUP_TOOLCHAIN: channel };
  // cwd at the drive root: cargo walks cwd ancestors for config files, so any
  // directory under the user profile picks up the user-global cargo config.
  const neutralCwd = path.parse(repoRoot).root;
  const build = spawnSync('cargo', ['build', '--target', 'wasm32-unknown-unknown', '-p', 'wasm-bridge', '--manifest-path', path.join(repoRoot, 'Cargo.toml'), '--locked'], {
    cwd: neutralCwd,
    env,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  if (build.status !== 0) throw new Error(`cargo build for wasm32 failed:\n${build.stdout}\n${build.stderr}`);
  const bindgen = spawnSync('wasm-bindgen', ['--target', 'web', '--out-dir', wasmOut, '--out-name', 'wasm_bridge', path.join(repoRoot, 'target', 'wasm32-unknown-unknown', 'debug', 'wasm_bridge.wasm')], {
    cwd: neutralCwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  if (bindgen.status !== 0) throw new Error(`wasm-bindgen failed:\n${bindgen.stdout}\n${bindgen.stderr}`);
}

async function buildHarnessBundle(): Promise<void> {
  const requireFromWeb = createRequire(path.join(repoRoot, 'apps', 'web', 'package.json'));
  const esbuild = createRequire(requireFromWeb.resolve('vite'))('esbuild') as EsbuildLike;
  await esbuild.build({
    absWorkingDir: repoRoot,
    stdin: { contents: HARNESS_ENTRY, resolveDir: path.join(repoRoot, 'apps', 'web'), loader: 'ts' },
    bundle: true,
    format: 'esm',
    outfile: harnessOut,
    define: { 'process.env.NODE_ENV': '"development"' },
    logLevel: 'error',
  });
}

test('T12-A a drag from any direction commits one bbox, one save request and one undo entry', async ({ page }) => {
  await bootPage(page);
  const probe = await page.evaluate(async () => {
    const t = (window as unknown as T12Window).__t12;
    const gpu = (navigator as unknown as {
      gpu?: { requestAdapter(): Promise<{ info?: { vendor?: string; architecture?: string; device?: string; description?: string } } | null> };
    }).gpu;
    const adapter = gpu ? await gpu.requestAdapter() : null;
    const info = adapter?.info;
    return {
      adapter: info ? [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ') : 'no adapter',
      wgpu: await t.deviceProbe(),
    };
  });
  // Real-device gate conventions from tests/render/t05.spec.ts: a software
  // rasterizer must never satisfy the hardware gate. This machine's adapter is
  // the RTX 5060 Ti recorded in reports/T05/gpu-adapter-recheck.md.
  if (process.env.REQUIRE_WGPU_DEVICE === '1' || process.env.REQUIRE_HARDWARE_GPU === '1') {
    expect(probe.wgpu, probe.adapter).toContain('backend=BrowserWebGpu');
  }
  if (process.env.REQUIRE_HARDWARE_GPU === '1') {
    expect(`${probe.adapter} ${probe.wgpu}`, 'software adapters are not hardware').not.toMatch(SOFTWARE_ADAPTER);
  }
  console.info(`T12_REAL_GPU adapter="${probe.adapter}" ${probe.wgpu}`);
  await page.evaluate(async () => {
    const h = (window as unknown as T12Window).__t12;
    await h.load([], 'asset-draw');
    h.setActiveLabel('label_person');
  });
  await page.getByTestId('tool-box').click();
  await expect(page.getByTestId('tool-box')).toHaveAttribute('aria-pressed', 'true');

  // Bottom-right to top-left: any direction normalizes to the same bbox.
  const box = await canvasBox(page);
  await page.mouse.move(box.x + 110, box.y + 220);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 120);
  await settled(page);
  // pointermove previews must never reach the network.
  expect(server.requests.length, 'preview moves never save').toBe(0);
  expect((await page.evaluate(() => (window as unknown as T12Window).__t12.state())).objects.length).toBe(0);
  await page.mouse.move(box.x + 10, box.y + 20);
  await page.mouse.up();
  await settled(page);
  expect(server.requests.length, 'exactly one save per pointerup').toBe(1);

  const afterDraw = await page.evaluate(() => (window as unknown as T12Window).__t12.state());
  expect(afterDraw.objects).toEqual([{ id: expect.any(String), x_min: 10, y_min: 20, x_max: 110, y_max: 220 }]);
  expect(afterDraw.generation).toBe(1);

  // One keyboard undo restores the document and is itself one save request.
  await page.keyboard.press('Control+z');
  await settled(page);
  expect(server.requests.length, 'undo is a committed change').toBe(2);
  const afterUndo = await page.evaluate(() => (window as unknown as T12Window).__t12.state());
  expect(afterUndo.objects).toEqual([]);
  expect(afterUndo.generation, 'generation strictly increases').toBe(2);
  await expect(page.getByTestId('undo')).toBeDisabled();

  // Forward drag (top-left to bottom-right) produces the identical bbox.
  await drag(page, [10, 20], [110, 220]);
  await settled(page);
  expect(server.requests.length).toBe(3);
  const forward = await page.evaluate(() => (window as unknown as T12Window).__t12.state());
  expect(forward.objects).toEqual([{ id: expect.any(String), x_min: 10, y_min: 20, x_max: 110, y_max: 220 }]);
  await page.keyboard.press('Control+z');
  await settled(page);
  const finalState = await page.evaluate(() => (window as unknown as T12Window).__t12.state());
  expect(finalState.objects).toEqual([]);
  await expect(page.getByTestId('undo')).toBeDisabled();
});

test('T12-B Esc, window blur, pointercancel, tool switch and asset switch cancel the gesture and release capture', async ({ page }) => {
  await bootPage(page);
  await page.evaluate(async (objects) => {
    await (window as unknown as T12Window).__t12.load(objects, 'asset-cancel');
    (window as unknown as T12Window).__t12.setActiveLabel('label_person');
    (window as unknown as T12Window).__t12.resetTrace();
  }, [PERSON]);
  await page.getByTestId('tool-box').click();
  const box = await canvasBox(page);
  const savesBefore = server.requests.length;

  const startGesture = async () => {
    await page.mouse.move(box.x + 200, box.y + 300);
    await page.mouse.down();
    await page.mouse.move(box.x + 260, box.y + 360);
    const pointerId = (await page.evaluate(() => (window as unknown as T12Window).__t12.trace())).lastPointerId;
    if (pointerId === null) throw new Error('no pointer id recorded');
    expect(
      await page.evaluate((id) => (window as unknown as T12Window).__t12.captured(id), pointerId),
      'pointer capture is taken with the gesture',
    ).toBe(true);
    return pointerId;
  };
  const expectCancelled = async (pointerId: number) => {
    await settled(page);
    expect(server.requests.length, 'a cancelled gesture never saves').toBe(savesBefore);
    const current = await page.evaluate(() => (window as unknown as T12Window).__t12.state());
    expect(current.objects.map((object) => object.id)).toEqual(['object_person_001']);
    expect(current.generation).toBe(0);
    expect(
      await page.evaluate((id) => (window as unknown as T12Window).__t12.captured(id), pointerId),
      'capture released with the cancel',
    ).toBe(false);
  };

  // 1) Esc cancels the in-progress draw.
  let pointerId = await startGesture();
  await page.keyboard.press('Escape');
  await expectCancelled(pointerId);
  await page.mouse.up();

  // 2) Window blur cancels.
  pointerId = await startGesture();
  await page.evaluate(() => (window as unknown as T12Window).__t12.dispatchWindowBlur());
  await expectCancelled(pointerId);
  await page.mouse.up();

  // 3) A real pointercancel event cancels.
  pointerId = await startGesture();
  await page.evaluate((id) => (window as unknown as T12Window).__t12.dispatchPointerCancel(id), pointerId);
  await expectCancelled(pointerId);
  await page.mouse.up();

  // 4) A tool switch mid-gesture cancels (real shortcut key while dragging).
  pointerId = await startGesture();
  await page.keyboard.press('v');
  await expectCancelled(pointerId);
  await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.up();

  // 5) An asset switch mid-gesture cancels (the old facade is destroyed).
  await page.getByTestId('tool-box').click();
  pointerId = await startGesture();
  await page.evaluate(async () => {
    const h = (window as unknown as T12Window).__t12;
    await h.loadDetached([['object_person_001', 10, 20, 110, 220]], 'asset-cancel-next');
  });
  await expectCancelled(pointerId);
  await page.mouse.up();
  await settled(page);
  expect(server.requests.length).toBe(savesBefore);
});

test('T12-C text input and IME composition suppress Delete and letter shortcuts', async ({ page }) => {
  await bootPage(page);
  await page.evaluate(async (objects) => {
    await (window as unknown as T12Window).__t12.load(objects, 'asset-keys');
    (window as unknown as T12Window).__t12.setActiveLabel('label_person');
    (window as unknown as T12Window).__t12.resetTrace();
  }, [PERSON]);
  await click(page, [60, 100]);
  await expect(page.getByTestId('selection-count')).toHaveText('1');
  const savesBefore = server.requests.length;

  // Real focus on a real text input: keys belong to the input, not the editor.
  await page.getByTestId('text-input').click();
  await page.keyboard.press('Delete');
  await page.keyboard.type('b');
  await settled(page);
  expect(server.requests.length, 'text input keys never edit the document').toBe(savesBefore);
  const withInput = await page.evaluate(() => (window as unknown as T12Window).__t12.state());
  expect(withInput.objects.map((object) => object.id)).toEqual(['object_person_001']);
  await expect(page.getByTestId('text-input')).toHaveValue('b');
  await expect(page.getByTestId('tool-select'), 'letter shortcut stayed inert').toHaveAttribute('aria-pressed', 'true');

  // IME composition state suppresses editor keys even outside a text field.
  await page.getByTestId('text-input').evaluate((element) => (element as HTMLInputElement).blur());
  await page.evaluate(() => (window as unknown as T12Window).__t12.dispatchComposition('compositionstart'));
  await page.keyboard.press('Delete');
  await settled(page);
  expect(server.requests.length, 'composition start suppresses Delete').toBe(savesBefore);
  await page.evaluate(() => (window as unknown as T12Window).__t12.dispatchComposition('compositionend'));

  // An isComposing keydown is also inert (the real IME key shape).
  await page.evaluate(() => (window as unknown as T12Window).__t12.dispatchImeKey());
  await settled(page);
  expect(server.requests.length, 'isComposing keydowns never edit').toBe(savesBefore);
  const stillThere = await page.evaluate(() => (window as unknown as T12Window).__t12.state());
  expect(stillThere.objects.map((object) => object.id)).toEqual(['object_person_001']);

  // Positive control: the same Delete key deletes once the text layer is done.
  await page.keyboard.press('Delete');
  await settled(page);
  expect(server.requests.length, 'the plain Delete finally commits').toBe(savesBefore + 1);
  const afterDelete = await page.evaluate(() => (window as unknown as T12Window).__t12.state());
  expect(afterDelete.objects).toEqual([]);
});

test('T12-D space-pan, scroll-zoom and contextmenu follow the precise interaction policy', async ({ page }) => {
  await bootPage(page);
  await page.evaluate(async (objects) => {
    await (window as unknown as T12Window).__t12.load(objects, 'asset-pan');
    (window as unknown as T12Window).__t12.resetTrace();
  }, [PERSON, SECOND]);
  const savesBefore = server.requests.length;

  // Native button Space activates its tool on keyup, not temporary pan.
  await page.getByTestId('tool-box').focus();
  await page.keyboard.down('Space');
  await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.up('Space');
  await expect(page.getByTestId('tool-box')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('tool-select').click();

  // Contextmenu: suppressed on the canvas, never selects, never edits.
  // (Runs before pan/zoom so the canvas transform is still the identity.)
  await page.mouse.click((await canvasBox(page)).x + 60, (await canvasBox(page)).y + 100, { button: 'right' });
  await settled(page);
  const contextTrace = await page.evaluate(() => (window as unknown as T12Window).__t12.trace());
  expect(contextTrace.contextmenuPrevented, 'native menu is suppressed').toBe(true);
  const afterMenu = await page.evaluate(() => (window as unknown as T12Window).__t12.state());
  expect(afterMenu.selection, 'right click never selects').toEqual([]);
  expect(server.requests.length).toBe(savesBefore);

  // Windows defaults are intact: ctrl+click extends the selection.
  await click(page, [60, 100]);
  await expect(page.getByTestId('selection-count')).toHaveText('1');
  await click(page, [250, 250], { ctrl: true });
  await expect(page.getByTestId('selection-count'), 'ctrl+click adds to the selection').toHaveText('2');
  await settled(page);
  expect(server.requests.length, 'selection never saves').toBe(savesBefore);

  // Space-pan: holding space pans the viewport and never touches the document.
  await page.keyboard.down(' ');
  await expect(page.getByTestId('tool-pan')).toHaveAttribute('aria-pressed', 'true');
  await drag(page, [100, 100], [200, 180]);
  await settled(page);
  const panned = await page.evaluate(() => (window as unknown as T12Window).__t12.state());
  expect(panned.viewport?.tx).toBeCloseTo(100, 5);
  expect(panned.viewport?.ty).toBeCloseTo(80, 5);
  expect(panned.generation).toBe(0);
  expect(server.requests.length, 'pan never saves').toBe(savesBefore);
  await page.keyboard.up(' ');
  await expect(page.getByTestId('tool-select'), 'space keyup restores the tool').toHaveAttribute('aria-pressed', 'true');

  // Scroll-zoom at the cursor: the image point under the cursor stays fixed.
  const before = await page.evaluate(() => (window as unknown as T12Window).__t12.state());
  const cssPoint: [number, number] = [320, 240];
  const imageBefore = (cssPoint[0] - (before.viewport?.tx ?? 0)) / (before.viewport?.scale ?? 1);
  const imageYBefore = (cssPoint[1] - (before.viewport?.ty ?? 0)) / (before.viewport?.scale ?? 1);
  const box = await canvasBox(page);
  await page.mouse.move(box.x + cssPoint[0], box.y + cssPoint[1]);
  await page.mouse.wheel(0, -240);
  await settled(page);
  const zoomed = await page.evaluate(() => (window as unknown as T12Window).__t12.state());
  expect(zoomed.viewport?.scale, 'wheel zooms in').toBeGreaterThan(before.viewport?.scale ?? 1);
  const imageAfter = (cssPoint[0] - (zoomed.viewport?.tx ?? 0)) / (zoomed.viewport?.scale ?? 1);
  const imageYAfter = (cssPoint[1] - (zoomed.viewport?.ty ?? 0)) / (zoomed.viewport?.scale ?? 1);
  expect(Math.abs(imageAfter - imageBefore), 'anchor x is preserved').toBeLessThan(0.01);
  expect(Math.abs(imageYAfter - imageYBefore), 'anchor y is preserved').toBeLessThan(0.01);
  expect(zoomed.generation).toBe(0);
  expect(server.requests.length, 'zoom never saves').toBe(savesBefore);
});

test('T12-E one hundred overlapping boxes cycle selection predictably with zero saves', async ({ page }) => {
  await bootPage(page);
  await page.evaluate(async (objects) => {
    const h = (window as unknown as T12Window).__t12;
    await h.load(objects, 'asset-dense');
    h.resetTrace();
  }, OVERLAP_100);
  const savesBefore = server.requests.length;
  const generationBefore = (await page.evaluate(() => (window as unknown as T12Window).__t12.state())).generation;

  for (let clickIndex = 0; clickIndex < 101; clickIndex += 1) {
    await click(page, [350, 350]);
    const count = await page.getByTestId('selection-count').textContent();
    expect(count, `click ${clickIndex} selects exactly one box`).toBe('1');
  }

  const trace = await page.evaluate(() => (window as unknown as T12Window).__t12.trace());
  const expected = Array.from({ length: 100 }, (_, step) => `object_overlap_${String(99 - step).padStart(3, '0')}`);
  expected.push('object_overlap_099');
  expect(trace.selection, 'the cycle order is the explicit draw order and wraps').toEqual(expected);
  expect(server.requests.length, 'cycling selection never saves').toBe(savesBefore);
  const generationAfter = (await page.evaluate(() => (window as unknown as T12Window).__t12.state())).generation;
  expect(generationAfter).toBe(generationBefore);
});

test('T12-F move and corner/edge resize commit exact canonical coordinates as one undo entry each', async ({ page }) => {
  await bootPage(page);
  await page.evaluate(async (objects) => {
    await (window as unknown as T12Window).__t12.load(objects, 'asset-transform');
    (window as unknown as T12Window).__t12.resetTrace();
  }, [PERSON]);
  await click(page, [60, 100]);
  await expect(page.getByTestId('selection-count')).toHaveText('1');
  let saves = server.requests.length;

  // Move by dragging the interior.
  await drag(page, [60, 100], [160, 200]);
  await settled(page);
  expect(server.requests.length).toBe(saves + 1);
  let geometry = (await page.evaluate(() => (window as unknown as T12Window).__t12.state())).objects[0];
  expect([geometry.x_min, geometry.y_min, geometry.x_max, geometry.y_max]).toEqual([110, 120, 210, 320]);
  await page.keyboard.press('Control+z');
  await settled(page);
  geometry = (await page.evaluate(() => (window as unknown as T12Window).__t12.state())).objects[0];
  expect([geometry.x_min, geometry.y_min, geometry.x_max, geometry.y_max]).toEqual([10, 20, 110, 220]);
  await expect(page.getByTestId('undo'), 'one drag is one undo entry').toBeDisabled();
  saves = server.requests.length;

  // Resize from the top-left corner.
  await drag(page, [10, 20], [30, 40]);
  await settled(page);
  expect(server.requests.length).toBe(saves + 1);
  geometry = (await page.evaluate(() => (window as unknown as T12Window).__t12.state())).objects[0];
  expect([geometry.x_min, geometry.y_min, geometry.x_max, geometry.y_max]).toEqual([30, 40, 110, 220]);
  await page.keyboard.press('Control+z');
  await settled(page);
  saves = server.requests.length;

  // Resize from the left edge (only x_min moves).
  await drag(page, [10, 120], [30, 130]);
  await settled(page);
  expect(server.requests.length).toBe(saves + 1);
  geometry = (await page.evaluate(() => (window as unknown as T12Window).__t12.state())).objects[0];
  expect([geometry.x_min, geometry.y_min, geometry.x_max, geometry.y_max]).toEqual([30, 20, 110, 220]);
  await page.keyboard.press('Control+z');
  await settled(page);

  // Resize from the bottom-right corner.
  saves = server.requests.length;
  await drag(page, [110, 220], [130, 240]);
  await settled(page);
  expect(server.requests.length).toBe(saves + 1);
  geometry = (await page.evaluate(() => (window as unknown as T12Window).__t12.state())).objects[0];
  expect([geometry.x_min, geometry.y_min, geometry.x_max, geometry.y_max]).toEqual([10, 20, 130, 240]);
});

test('T12-G numeric geometry edits canonical px and keeps invalid values out of the document', async ({ page }) => {
  await bootPage(page);
  await page.evaluate(async (objects) => {
    await (window as unknown as T12Window).__t12.load(objects, 'asset-numeric');
    (window as unknown as T12Window).__t12.resetTrace();
  }, [PERSON]);
  await click(page, [60, 100]);
  await expect(page.getByTestId('selection-count')).toHaveText('1');

  // Canonical units are visible in the inputs.
  await expect(page.getByTestId('geometry-x')).toHaveValue('10px');
  await expect(page.getByTestId('geometry-y')).toHaveValue('20px');
  await expect(page.getByTestId('geometry-w')).toHaveValue('100px');
  await expect(page.getByTestId('geometry-h')).toHaveValue('200px');
  let saves = server.requests.length;

  // A valid numeric edit commits once.
  await page.getByTestId('geometry-x').fill('50px');
  await page.keyboard.press('Enter');
  await settled(page);
  expect(server.requests.length).toBe(saves + 1);
  let geometry = (await page.evaluate(() => (window as unknown as T12Window).__t12.state())).objects[0];
  expect([geometry.x_min, geometry.y_min, geometry.x_max, geometry.y_max]).toEqual([50, 20, 150, 220]);
  saves = server.requests.length;

  // An invalid value keeps its error visible and never modifies the document.
  await page.getByTestId('geometry-w').fill('abc');
  await expect(page.getByTestId('geometry-error')).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await settled(page);
  await expect(page.getByTestId('geometry-error'), 'the error survives blur').toBeVisible();
  expect(server.requests.length, 'invalid values never save').toBe(saves);
  geometry = (await page.evaluate(() => (window as unknown as T12Window).__t12.state())).objects[0];
  expect([geometry.x_min, geometry.y_min, geometry.x_max, geometry.y_max]).toEqual([50, 20, 150, 220]);

  // Escape reverts the fields to the committed canonical values.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('geometry-w')).toHaveValue('100px');
  await expect(page.getByTestId('geometry-error')).toHaveCount(0);
  expect(server.requests.length).toBe(saves);
});

test('T12-H locked objects are not draggable or deletable and hidden objects are not hit-testable', async ({ page }) => {
  await bootPage(page);
  await page.evaluate(async (objects) => {
    const h = (window as unknown as T12Window).__t12;
    await h.load(objects, 'asset-flags');
    h.setFlags(['object_person_001'], { locked: true });
    h.resetTrace();
  }, [PERSON]);
  const savesBefore = server.requests.length;

  // Dragging a locked object never moves it.
  await drag(page, [60, 100], [160, 200]);
  await settled(page);
  let geometry = (await page.evaluate(() => (window as unknown as T12Window).__t12.state())).objects[0];
  expect([geometry.x_min, geometry.y_min, geometry.x_max, geometry.y_max]).toEqual([10, 20, 110, 220]);
  expect(server.requests.length, 'locked objects are never dragged').toBe(savesBefore);

  // A locked object is still selectable, but Delete is refused by document semantics.
  await click(page, [60, 100]);
  await expect(page.getByTestId('selection-count')).toHaveText('1');
  await page.keyboard.press('Delete');
  await settled(page);
  const afterDelete = await page.evaluate(() => (window as unknown as T12Window).__t12.state());
  expect(afterDelete.objects.map((object) => object.id), 'locked objects survive Delete').toEqual(['object_person_001']);
  expect(server.requests.length, 'a refused delete never saves').toBe(savesBefore);

  // Hidden objects are not hit-testable: the click passes through to nothing.
  await page.evaluate(() => {
    (window as unknown as T12Window).__t12.setFlags(['object_person_001'], { hidden: true, locked: false });
  });
  await click(page, [60, 100]);
  await expect(page.getByTestId('selection-count'), 'hidden objects cannot be clicked').toHaveText('0');
  await settled(page);
  expect(server.requests.length).toBe(savesBefore);
  const generation = (await page.evaluate(() => (window as unknown as T12Window).__t12.state())).generation;
  expect(generation, 'flags and gestures never changed the document').toBe(0);
});
