// T09 canvas lifecycle in a real browser: real wasm-bridge facade, real WebGPU
// device, real Chromium image decode. The modules under test (EditorHost,
// loader, CanvasView) are bundled at test time from apps/web/src and served to
// the page; the WASM bundle is built from crates/wasm-bridge exactly as the
// wasm-bindgen glue ships it. Playwright's default headless shell has no WebGPU
// (reports/T05/gpu-adapter-recheck.md), so this file launches full Chromium —
// playwright.config.ts stays untouched (root-owned).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';
import type { EditorHost } from '../../apps/web/src/lib/editor/EditorHost';
import type { ApiError, BinaryTransfer, CanonicalFrame, EditorAssetRequest, EditorDelta, EditorHostStatus, Viewport } from '../../apps/web/src/lib/editor/types';

export interface HarnessLog {
  disposed: number;
  renders: number;
  pointer: number;
  snapshots: number;
  setViewports: number;
  argBytes: number;
  mounted: boolean;
}

export interface T09Harness {
  bootHarness(): Promise<boolean>;
  factory: { gated: boolean; logs: HarnessLog[]; release(index: number): void; releaseAll(): void };
  frameCounter: { active: number };
  canvasListenerCounts: Record<string, number>;
  readyHosts: EditorHost[];
  deltas: EditorDelta[];
  makeRequest(rgba: number[], width: number, height: number, id: string): EditorAssetRequest;
  frames(count: number): Promise<void>;
  sleep(ms: number): Promise<void>;
  decode(bytes: number[], width: number, height: number): Promise<CanonicalFrame & { byteLength: number }>;
  deviceProbe(): Promise<string>;
  newHost(canvasId: string): boolean;
  load(request: EditorAssetRequest): Promise<{ status: EditorHostStatus; transfers: readonly BinaryTransfer[] }>;
  hostState(): { status: EditorHostStatus; error: ApiError | null; transfers: readonly BinaryTransfer[] };
  facadeRead(index: number): { generation: number; viewport: Viewport };
  strictMount(containerId: string, request: EditorAssetRequest): boolean;
  unmountReact(): void;
  disposeHost(): void;
}

declare global {
  interface Window { __t09: T09Harness }
}

test.use({ channel: 'chromium', launchOptions: { args: ['--enable-unsafe-webgpu'] } });

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const wasmOut = path.join(repoRoot, 'target', 'weblabel-wasm-bridge');
const harnessOut = path.join(repoRoot, 'target', 'weblabel-t09-harness.js');
const origin = 'http://127.0.0.1:4174';

const HARNESS_ENTRY = `
import { EditorHost } from './src/lib/editor/EditorHost';
import { createEditorFacadeFactory, decodeCanonicalFrame, loadWasmBridge } from './src/lib/editor/loader';
import { createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CanvasView } from './src/features/workbench/CanvasView';
import type { Root } from 'react-dom/client';
import type { EditorAssetRequest, EditorDelta, EditorFacade, EditorFacadeFactory, EditorWasmBridge } from './src/lib/editor/types';
import type { HarnessLog } from '../../tests/e2e/t09_canvas.spec';

function describeFailure(reason: unknown): string {
  if (reason instanceof Error) return reason.name + ': ' + reason.message + '\\n' + (reason.stack ?? '');
  return typeof reason === 'string' ? reason : JSON.stringify(reason);
}
function makeRequest(rgba: number[], width: number, height: number, assetRevisionId: string): EditorAssetRequest {
  return {
    media: {
      asset_id: 'e2e-asset', asset_revision_id: assetRevisionId, project_id: 'sample-project',
      original_name: 'e2e.png', original_sha256: 'a'.repeat(64), canonical_sha256: 'b'.repeat(64),
      canonical_width: width, canonical_height: height, exif_orientation: 1,
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
      coordinate_space: { type: 'canonical_image_pixels', width, height },
      completion: 'unprocessed', objects: [],
    },
    frame: { width, height, rgba: Uint8Array.from(rgba) },
    initial_generation: 0,
  };
}

class HarnessFactory implements EditorFacadeFactory {
  readonly logs: HarnessLog[] = [];
  readonly created: EditorFacade[] = [];
  gated = false;
  private readonly pending: { index: number; release(): void }[] = [];
  constructor(private readonly real: EditorFacadeFactory) {}
  async create(canvas: HTMLCanvasElement, request: EditorAssetRequest) {
    const log = { disposed: 0, renders: 0, pointer: 0, snapshots: 0, setViewports: 0, argBytes: 0, mounted: false };
    this.logs.push(log);
    const index = this.logs.length - 1;
    // Register the gate before the async device init so a test can deterministically
    // hold back delivery of an init that would otherwise resolve late.
    const gate = this.gated ? Promise.withResolvers<void>() : null;
    if (gate) this.pending.push({ index, release: () => gate.resolve() });
    const created = await this.real.create(canvas, request);
    const facade = instrument(created.facade, log);
    this.created.push(facade);
    if (gate) await gate.promise;
    return { facade, transfer: created.transfer };
  }
  release(index: number) {
    const at = this.pending.findIndex((entry) => entry.index === index);
    if (at >= 0) this.pending.splice(at, 1)[0].release();
  }
  releaseAll() {
    for (const entry of this.pending.splice(0)) entry.release();
  }
}

function instrument(facade: EditorFacade, log: HarnessLog): EditorFacade {
  return new Proxy(facade, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (prop === 'pointer') {
          log.pointer += 1;
          log.argBytes = Math.max(log.argBytes, JSON.stringify(args[0]).length);
        }
        if (prop === 'get_snapshot') log.snapshots += 1;
        if (prop === 'render') log.renders += 1;
        if (prop === 'set_viewport') {
          log.setViewports += 1;
          log.mounted = true;
        }
        if (prop === 'dispose') log.disposed += 1;
        return value.apply(target, args);
      };
    },
  });
}

const canvasListenerCounts: Record<string, number> = {};
let listenersInstrumented = false;
function instrumentCanvasListeners() {
  if (listenersInstrumented) return;
  listenersInstrumented = true;
  const proto = HTMLCanvasElement.prototype;
  const realAdd: EventTarget['addEventListener'] = proto.addEventListener;
  const realRemove: EventTarget['removeEventListener'] = proto.removeEventListener;
  proto.addEventListener = function (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    canvasListenerCounts[type] = (canvasListenerCounts[type] ?? 0) + 1;
    return realAdd.call(this, type, listener, options);
  };
  proto.removeEventListener = function (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
    canvasListenerCounts[type] = (canvasListenerCounts[type] ?? 0) - 1;
    return realRemove.call(this, type, listener, options);
  };
}

const frameCounter = { active: 0 };
let framesInstrumented = false;
function instrumentFrames() {
  if (framesInstrumented) return;
  framesInstrumented = true;
  const realRaf = window.requestAnimationFrame.bind(window);
  const realCancel = window.cancelAnimationFrame.bind(window);
  const pending = new Set<number>();
  window.requestAnimationFrame = (callback) => {
    const id = realRaf((timestamp) => {
      pending.delete(id);
      frameCounter.active = pending.size;
      callback(timestamp);
    });
    pending.add(id);
    frameCounter.active = pending.size;
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    pending.delete(id);
    frameCounter.active = pending.size;
    realCancel(id);
  };
}

async function bootHarness() {
  instrumentCanvasListeners();
  instrumentFrames();
  const bridge = await loadWasmBridge('/wasm/wasm_bridge.js') as EditorWasmBridge & { initialize_browser_device_probe(): Promise<string> };
  const factory = new HarnessFactory(createEditorFacadeFactory(bridge));
  const state: { factory: HarnessFactory; host: EditorHost | null; mountReact: Root | null } = { factory, host: null, mountReact: null };
  function host(): EditorHost {
    if (!state.host) throw new Error('T09 host has not been mounted');
    return state.host;
  }
  window.__t09 = {
    bootHarness,
    readyHosts: [],
    deltas: [],
    factory,
    frameCounter,
    canvasListenerCounts,
    makeRequest,
    async frames(count) {
      for (let i = 0; i < count; i += 1) {
        const gate = Promise.withResolvers<number>();
        requestAnimationFrame((ts) => gate.resolve(ts));
        await gate.promise;
      }
    },
    sleep(ms) {
      const gate = Promise.withResolvers<void>();
      setTimeout(() => gate.resolve(), ms);
      return gate.promise;
    },
    async decode(bytes, width, height) {
      try {
        const frame = await decodeCanonicalFrame(new Blob([Uint8Array.from(bytes)]), { width, height });
        return { width: frame.width, height: frame.height, byteLength: frame.rgba.byteLength, rgba: frame.rgba };
      } catch (reason) {
        throw new Error('decode rejected: ' + describeFailure(reason), { cause: reason });
      }
    },
    async deviceProbe() {
      return bridge.initialize_browser_device_probe();
    },
    newHost(canvasId) {
      const canvas = document.getElementById(canvasId);
      if (!(canvas instanceof HTMLCanvasElement)) throw new Error('T09 canvas missing: ' + canvasId);
      state.host = new EditorHost({ facadeFactory: factory });
      state.host.mount(canvas);
      return true;
    },
    async load(request) {
      try {
        await host().loadAsset(request);
      } catch (reason) {
        throw new Error('loadAsset rejected: ' + describeFailure(reason), { cause: reason });
      }
      return { status: host().status, transfers: host().transfers };
    },
    hostState() {
      return { status: host().status, error: host().error, transfers: host().transfers };
    },
    facadeRead(index) {
      const facade = state.factory.created[index];
      return { generation: facade.get_generation(), viewport: facade.get_viewport() };
    },
    strictMount(containerId, request) {
      const container = document.getElementById(containerId);
      if (!container) throw new Error('T09 React container missing: ' + containerId);
      state.mountReact = createRoot(container);
      state.mountReact.render(
        createElement(StrictMode, null, createElement(CanvasView, {
          request,
          hostOptions: { facadeFactory: factory },
          activeTool: 'select',
          onDelta: (_host: EditorHost, delta: EditorDelta) => window.__t09.deltas.push(delta),
          onHostReady: (host: EditorHost) => window.__t09.readyHosts.push(host),
        })),
      );
      return true;
    },
    unmountReact() {
      state.mountReact?.unmount();
      state.mountReact = null;
    },
    disposeHost() {
      state.host?.dispose();
    },
  };
  return true;
}

Object.assign(window, { __t09: { bootHarness } });
`;

interface EsbuildLike {
  build(options: Record<string, unknown>): Promise<unknown>;
}

async function buildHarnessBundle(): Promise<void> {
  const requireFromWeb = createRequire(path.join(repoRoot, 'apps', 'web', 'package.json'));
  const esbuild = createRequire(requireFromWeb.resolve('vite'))('esbuild') as EsbuildLike;
  await esbuild.build({
    absWorkingDir: repoRoot,
    stdin: { contents: HARNESS_ENTRY, resolveDir: path.join(repoRoot, 'apps', 'web'), loader: 'ts' },
    bundle: true,
    nodePaths: (process.env.NODE_PATH ?? '').split(path.delimiter).filter(Boolean),
    format: 'esm',
    outfile: harnessOut,
    define: { 'process.env.NODE_ENV': '"development"' },
    logLevel: 'error',
  });
}

function buildWasmBundle(): void {
  const toolchain = fs.readFileSync(path.join(repoRoot, 'rust-toolchain.toml'), 'utf8');
  const channel = /channel\s*=\s*"([^"]+)"/.exec(toolchain)?.[1];
  if (!channel) throw new Error('rust-toolchain.toml has no pinned channel');
  // cwd outside the user profile: the user-global cargo config enables an
  // unstable codegen-backend that the pinned stable toolchain rejects as an
  // ancestor config (reports/T21 environment_note). RUSTUP_TOOLCHAIN restores
  // the repo pin that rustup would otherwise resolve from the cwd.
  const compiler = spawnSync('rustup', ['which', '--toolchain', channel, 'rustc'], { encoding: 'utf8', shell: false, windowsHide: true });
  if (compiler.status !== 0) throw new Error('cannot resolve pinned rustc: ' + compiler.stderr);
  const env = { ...process.env, RUSTUP_TOOLCHAIN: channel, RUSTC: compiler.stdout.trim() };
  // cwd at the drive root: cargo walks cwd ancestors for config files, so any
  // directory under the user profile picks up the user-global cargo config.
  const neutralCwd = path.parse(repoRoot).root;
  const build = spawnSync('cargo', ['build', '--target', 'wasm32-unknown-unknown', '--target-dir', path.join(repoRoot, 'target'), '-p', 'wasm-bridge', '--manifest-path', path.join(repoRoot, 'Cargo.toml'), '--locked'], {
    cwd: neutralCwd,
    env,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  if (build.status !== 0) throw new Error(`cargo build for wasm32 failed:\n${build.stdout}\n${build.stderr}`);
  const version = spawnSync(env.RUSTC, ['--version', '--verbose'], { encoding: 'utf8', shell: false, windowsHide: true });
  if (version.status !== 0) throw new Error('pinned rustc version failed: ' + version.stderr);
  console.info('T09_WASM_BUILD target=' + path.join(repoRoot, 'target') + '\\n' + version.stdout + build.stdout + build.stderr);
  const bindgen = spawnSync('wasm-bindgen', ['--target', 'web', '--out-dir', wasmOut, '--out-name', 'wasm_bridge', path.join(repoRoot, 'target', 'wasm32-unknown-unknown', 'debug', 'wasm_bridge.wasm')], {
    cwd: neutralCwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  if (bindgen.status !== 0) throw new Error(`wasm-bindgen failed:\n${bindgen.stdout}\n${bindgen.stderr}`);
}

async function bootPage(page: Page): Promise<void> {
  await page.route('**/t09-tokens.css', (route) =>
    route.fulfill({ path: path.join(repoRoot, 'apps/web/src/styles/tokens.css'), contentType: 'text/css; charset=utf-8' }));
  await page.route('**/t09-harness.js', (route) =>
    route.fulfill({ path: harnessOut, contentType: 'text/javascript; charset=utf-8' }));
  await page.route('**/wasm/wasm_bridge.js', (route) =>
    route.fulfill({ path: path.join(wasmOut, 'wasm_bridge.js'), contentType: 'text/javascript; charset=utf-8' }));
  await page.route('**/wasm/wasm_bridge_bg.wasm', (route) =>
    route.fulfill({ path: path.join(wasmOut, 'wasm_bridge_bg.wasm'), contentType: 'application/wasm' }));
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  await page.goto(`${origin}/`);
  await page.setContent(
    '<link rel="stylesheet" href="/t09-tokens.css"><canvas id="t09-canvas" style="width:640px;height:480px;display:block"></canvas>'
    + '<div id="t09-react" style="position:relative;width:640px;height:480px"></div><script type="module" src="/t09-harness.js"></script>',
  );
  try {
    await page.waitForFunction(() => Boolean(window.__t09?.bootHarness), undefined, { timeout: 15_000 });
    await page.evaluate(() => window.__t09.bootHarness());
  } catch (error) {
    throw new Error(`harness module failed to boot:\n${pageErrors.join('\n')}\n${String(error)}`);
  }
}

/** The asymmetric C8 golden quadrants (tests/render/t05.spec.ts layout). */
function goldenRgba(width = 640, height = 480): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      rgba[offset] = x < width / 2 ? 230 : 35;
      rgba[offset + 1] = y < height / 2 ? 45 : 190;
      rgba[offset + 2] = x < width / 2 ? 25 : 210;
      rgba[offset + 3] = 255;
    }
  }
  return rgba;
}

function transferBytes(bytes: Uint8Array): number[] {
  return Array.from(bytes);
}

const SOFTWARE_ADAPTER = /cpu|software|swiftshader|llvmpipe|lavapipe|mesa|basic render/i;

test.beforeAll(async () => {
  test.setTimeout(1_200_000);
  buildWasmBundle();
  await buildHarnessBundle();
});

test('T09-A canonical decode keeps EXIF orientation single, crosses RGBA via measured copyBytes and renders on a real GPU', async ({ page }, testInfo) => {
  await bootPage(page);
  const probe = await page.evaluate(async () => {
    const t = window.__t09;
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
  console.info(`T09_REAL_GPU adapter="${probe.adapter}" ${probe.wgpu}`);

  // The canonical pipeline (weblabel-api/src/media/canonical.rs) bakes the
  // EXIF orientation into the pixels and emits EXIF-free PNG, so a correct
  // decode must reproduce the stored 8x4 layout byte-exactly — no rotation.
  const raw8x4 = new Uint8Array(8 * 4 * 3);
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const offset = (y * 8 + x) * 3;
      raw8x4[offset] = x < 4 ? 220 : 30;
      raw8x4[offset + 1] = 60;
      raw8x4[offset + 2] = x < 4 ? 30 : 210;
    }
  }
  const canonicalPng = await sharp(Buffer.from(raw8x4), { raw: { width: 8, height: 4, channels: 3 } })
    .png()
    .toBuffer();
  const decoded = await page.evaluate(async ({ bytes }) => {
    const harness = window.__t09;
    const frame = await harness.decode(bytes, 8, 4);
    const rgba = Array.from(frame.rgba);
    return {
      width: frame.width,
      height: frame.height,
      byteLength: frame.byteLength,
      left: [rgba[0], rgba[1], rgba[2]],
      right: [rgba[4 * 4], rgba[4 * 4 + 1], rgba[4 * 4 + 2]],
    };
  }, { bytes: transferBytes(new Uint8Array(canonicalPng)) });
  expect(decoded.width).toBe(8);
  expect(decoded.height).toBe(4);
  expect(decoded.byteLength).toBe(8 * 4 * 4);
  expect(decoded.left[0], 'left half stays red').toBeGreaterThan(180);
  expect(decoded.left[2], 'left half stays blue-free').toBeLessThan(90);
  expect(decoded.right[2], 'right half stays blue').toBeGreaterThan(160);
  expect(decoded.right[0], 'right half stays red-free').toBeLessThan(90);

  // Double-rotation can never corrupt the canonical path silently: a source
  // that still carries an EXIF orientation (this Chromium applies JPEG EXIF at
  // decode even with imageOrientation 'none' — measured in reports/T09) would
  // decode to swapped dimensions, and the loader refuses it with a structured
  // CANONICAL_DECODE_MISMATCH instead of returning re-rotated pixels.
  const taggedJpeg = await sharp(Buffer.from(raw8x4), { raw: { width: 8, height: 4, channels: 3 } })
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const refusal = await page.evaluate(async ({ bytes }) => {
    const harness = window.__t09;
    try {
      await harness.decode(bytes, 8, 4);
      return 'decoded';
    } catch (reason) {
      return String((reason as Error).message);
    }
  }, { bytes: transferBytes(new Uint8Array(taggedJpeg)) });
  expect(refusal).toContain('CANONICAL_DECODE_MISMATCH');

  // Golden quadrants through the full path: real decode, real binary transfer,
  // real create_editor, real WebGPU submission.
  const golden = goldenRgba();
  const goldenPng = await sharp(Buffer.from(golden), { raw: { width: 640, height: 480, channels: 4 } }).png().toBuffer();
  const result = await page.evaluate(async (bytes) => {
    const t = window.__t09;
    t.newHost('t09-canvas');
    const frame = await t.decode(bytes, 640, 480);
    const request = t.makeRequest(Array.from(frame.rgba), 640, 480, 'asset-rev-golden');
    const loaded = await t.load(request);
    return { loaded, read: t.facadeRead(0) };
  }, transferBytes(new Uint8Array(goldenPng)));

  expect(result.loaded.status).toBe('ready');
  const [transfer] = result.loaded.transfers;
  expect(transfer.method).toBe('copyBytes');
  expect(transfer.byteLength).toBe(640 * 480 * 4);
  expect(Number.isFinite(transfer.durationMs)).toBe(true);
  // C3 keeps generation a plain number across the boundary.
  expect(typeof result.read.generation).toBe('number');
  expect(result.read.generation).toBe(0);
  expect(result.read.viewport).toMatchObject({ css_width: 640, css_height: 480 });

  const screenshot = await page.locator('#t09-canvas').screenshot({ path: testInfo.outputPath('canonical-render.png') });
  const { data, info } = await sharp(screenshot).raw().toBuffer({ resolveWithObject: true });
  expect(info.width).toBe(640);
  expect(info.height).toBe(480);
  const pixel = (x: number, y: number) =>
    [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
  const near = (actual: number[], expected: number[], label: string) => {
    for (let channel = 0; channel < 3; channel += 1) {
      expect(Math.abs(actual[channel] - expected[channel]), `${label} channel ${channel} of ${actual}`).toBeLessThanOrEqual(30);
    }
  };
  // fit_image maps the 640x480 canonical image onto the 640x480 CSS canvas,
  // so the rendered quadrants prove the RGBA bytes crossed the WASM boundary
  // intact and unrotated (top-left red / top-right blue / yellow / light blue).
  near(pixel(100, 100), [230, 45, 25], 'top-left');
  near(pixel(500, 100), [35, 45, 210], 'top-right');
  near(pixel(100, 400), [230, 190, 25], 'bottom-left');
  near(pixel(500, 400), [35, 190, 210], 'bottom-right');
});

test('T09-B a stale async init that resolves after a newer asset is destroyed and never mounted', async ({ page }) => {
  await bootPage(page);
  const outcome = await page.evaluate(async () => {
    const t = window.__t09;
    t.factory.gated = true;
    t.newHost('t09-canvas');
    const red = new Uint8Array(64 * 64 * 4);
    const green = new Uint8Array(64 * 64 * 4);
    for (let i = 0; i < 64 * 64; i += 1) {
      red.set([230, 45, 25, 255], i * 4);
      green.set([45, 230, 60, 255], i * 4);
    }
    const first = t.load(t.makeRequest(Array.from(red), 64, 64, 'asset-rev-old'));
    const second = t.load(t.makeRequest(Array.from(green), 64, 64, 'asset-rev-new'));
    // Force the card's ordering: the newer asset completes first.
    t.factory.release(1);
    await second;
    t.factory.release(0);
    await first;
    await t.frames(4);
    return t.factory.logs;
  });
  const [stale, current] = outcome;
  expect(stale.disposed).toBe(1);
  expect(stale.renders).toBe(0);
  expect(stale.mounted).toBe(false);
  expect(current.disposed).toBe(0);
  expect(current.renders).toBeGreaterThanOrEqual(1);
  const screenshot = await page.locator('#t09-canvas').screenshot();
  const { data, info } = await sharp(screenshot).raw().toBuffer({ resolveWithObject: true });
  const at = [...data.subarray((Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels, (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels + 3)];
  expect(at[1], 'the new asset owns the canvas').toBeGreaterThan(200);
  expect(at[0], 'the stale red asset never painted').toBeLessThan(120);
});

test.describe('T09-C sizing', () => {
  test.use({ deviceScaleFactor: 2 });

  test('DPR backing store, resize, 0x0 pause and unmount cleanup are exact', async ({ page }) => {
    await bootPage(page);
    const observed = await page.evaluate(async () => {
      const t = window.__t09;
      const canvas = document.getElementById('t09-canvas') as HTMLCanvasElement;
      canvas.style.width = '320px';
      canvas.style.height = '240px';
      t.newHost('t09-canvas');
      const rgba = new Uint8Array(16 * 16 * 4);
      for (let i = 0; i < 16 * 16; i += 1) rgba.set([230, 45, 25, 255], i * 4);
      await t.load(t.makeRequest(Array.from(rgba), 16, 16, 'asset-rev-size'));
      await t.frames(4);
      const log = t.factory.logs[0];
      const initial = { width: canvas.width, height: canvas.height, renders: log.renders };

      canvas.style.width = '400px';
      canvas.style.height = '300px';
      await t.frames(4);
      const resized = { width: canvas.width, height: canvas.height, renders: log.renders };

      canvas.style.width = '0px';
      canvas.style.height = '0px';
      await t.frames(4);
      const zeroBacking = [canvas.width, canvas.height];
      const zeroRenders = log.renders;
      canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 5, clientY: 5, pointerId: 1 }));
      await t.sleep(150);
      const quietAtZero = { renders: log.renders, zeroBacking, frozen: log.renders === zeroRenders };

      canvas.style.width = '320px';
      canvas.style.height = '240px';
      await t.frames(4);
      const resumed = { width: canvas.width, height: canvas.height, renders: log.renders };

      t.disposeHost();
      const afterDispose = {
        listeners: { ...t.canvasListenerCounts },
        pendingFrames: t.frameCounter.active,
        disposed: log.disposed,
        pointer: log.pointer,
      };
      canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 5, clientY: 5, pointerId: 1 }));
      return { initial, resized, zeroBacking, quietAtZero, resumed, afterDispose, pointerAfter: log.pointer };
    });

    // Real backing store: CSS size x DPR, and none at 0x0.
    expect(observed.initial).toEqual({ width: 640, height: 480, renders: 1 });
    expect(observed.resized).toEqual({ width: 800, height: 600, renders: 2 });
    expect(observed.zeroBacking).toEqual([0, 0]);
    expect(observed.quietAtZero.frozen).toBe(true);
    expect(observed.resumed).toEqual({ width: 640, height: 480, renders: 3 });
    // Unmount: every listener removed, no pending animation frame, device gone.
    for (const count of Object.values(observed.afterDispose.listeners)) expect(count).toBe(0);
    expect(observed.afterDispose.pendingFrames).toBe(0);
    expect(observed.afterDispose.disposed).toBe(1);
    expect(observed.pointerAfter).toBe(observed.afterDispose.pointer);
  });
});

test('T09-D one pointermove round submits input only and idle submits no GPU work', async ({ page }) => {
  await bootPage(page);
  await page.evaluate(async () => {
    const t = window.__t09;
    t.newHost('t09-canvas');
    const rgba = new Uint8Array(640 * 480 * 4);
    for (let i = 0; i < 640 * 480; i += 1) rgba.set([230, 45, 25, 255], i * 4);
    await t.load(t.makeRequest(Array.from(rgba), 640, 480, 'asset-rev-pointer'));
    await t.frames(4);
  });
  const canvas = page.locator('#t09-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no box');
  for (let step = 0; step < 6; step += 1) {
    await page.mouse.move(box.x + 40 + step * 30, box.y + 50 + step * 10);
  }
  const afterMoves = await page.evaluate(async () => {
    const t = window.__t09;
    await t.frames(4);
    return t.factory.logs[0];
  });
  expect(afterMoves.pointer).toBe(6);
  expect(afterMoves.snapshots, 'pointer streaming must never snapshot').toBe(0);
  expect(afterMoves.argBytes, 'the move payload is the small C3 PointerInput').toBeLessThan(200);

  const idleBefore = afterMoves.renders;
  await page.waitForTimeout(600);
  const idleAfter = await page.evaluate(() => {
    const t = window.__t09;
    return t.factory.logs[0].renders;
  });
  expect(idleAfter, 'idle must not submit GPU work').toBe(idleBefore);

  await page.evaluate(() => {
    const canvas = document.getElementById('t09-canvas') as HTMLCanvasElement;
    canvas.style.width = '700px';
    canvas.style.height = '480px';
  });
  await page.waitForTimeout(100);
  const afterResize = await page.evaluate(() => {
    const t = window.__t09;
    return { ...t.factory.logs[0], pendingFrames: t.frameCounter.active };
  });
  expect(afterResize.renders).toBe(idleBefore + 1);
  expect(afterResize.setViewports).toBeGreaterThanOrEqual(2);
});

test('T09-E React StrictMode remount keeps one listener set and one submit per round', async ({ page }, testInfo) => {
  await bootPage(page);
  await page.evaluate(() => {
    const t = window.__t09;
    t.factory.gated = true;
    const rgba = new Uint8Array(32 * 32 * 4);
    for (let i = 0; i < 32 * 32; i += 1) rgba.set([230, 45, 25, 255], i * 4);
    const request = t.makeRequest(Array.from(rgba), 32, 32, 'asset-rev-strict');
    t.strictMount('t09-react', request);
    return true;
  });
  await page.waitForFunction(() => window.__t09.factory.logs.length >= 1);
  // Exercise two actual committed mounts while the first real init is held.
  // StrictMode may correctly cancel its abandoned effect before creating a device.
  await page.evaluate(() => {
    const t = window.__t09;
    t.unmountReact();
    const rgba = new Uint8Array(32 * 32 * 4);
    for (let i = 0; i < 32 * 32; i += 1) rgba.set([230, 45, 25, 255], i * 4);
    t.strictMount('t09-react', t.makeRequest(Array.from(rgba), 32, 32, 'asset-rev-strict-remount'));
  });
  await page.waitForFunction(() => window.__t09.factory.logs.length >= 2);
  await page.evaluate(() => {
    const t = window.__t09;
    t.factory.releaseAll();
    return true;
  });
  await expect(page.getByTestId('gpu-status')).toHaveAttribute('data-device-state', 'ready');
  await expect(page.getByTestId('gpu-status')).toHaveAttribute('data-adapter-kind', 'hardware');
  await page.waitForFunction(() => window.__t09.factory.logs.filter(log => log.disposed === 0).length === 1);

  const before = await page.evaluate(() => {
    const t = window.__t09;
    return { logs: t.factory.logs, listeners: { ...t.canvasListenerCounts }, ready: t.readyHosts.length };
  });
  expect(before.logs.length).toBeGreaterThanOrEqual(2);
  const live = before.logs.filter((log) => log.disposed === 0);
  expect(live, 'exactly one facade stays live under StrictMode').toHaveLength(1);
  for (const log of before.logs) {
    if (log !== live[0]) expect(log.disposed).toBeGreaterThanOrEqual(1);
  }
  expect(before.listeners.pointermove ?? 0, 'no duplicated pointermove listeners').toBe(1);
  expect(before.ready, 'only the current mounted caller receives onHostReady').toBe(1);
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'contextmenu', 'wheel']) {
    expect(before.listeners[type], type + ' has one host listener').toBe(1);
  }

  const canvas = page.getByTestId('annotation-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('react canvas has no box');
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const hit = await page.evaluate(({ point, box }) => {
    const canvas = document.querySelector('[data-testid="annotation-canvas"]');
    const target = document.elementFromPoint(point.x, point.y);
    const oldTarget = document.elementFromPoint(box.x + 20, box.y + 25);
    return {
      point, box, isCanvas: target === canvas,
      target: target?.getAttribute('data-testid') ?? target?.tagName,
      previousFixtureTarget: oldTarget?.getAttribute('data-testid') ?? oldTarget?.tagName,
    };
  }, { point, box });
  await testInfo.attach('strict-pointer-hit-test', { body: JSON.stringify(hit), contentType: 'application/json' });
  expect(hit.isCanvas, 'actual pointer round targets the uncovered canvas, not GPU diagnostics').toBe(true);
  await page.mouse.move(point.x, point.y);
  const { submits, deltas } = await page.evaluate(() => {
    const t = window.__t09;
    return { submits: t.factory.logs.reduce((sum, log) => sum + log.pointer, 0), deltas: t.deltas };
  });
  expect(submits, 'one pointermove round submits exactly once').toBe(1);
  expect(deltas).toHaveLength(1);
  expect(deltas[0]).toMatchObject({ generation: 0, document_changed: false, error: null });
  const cleanup = await page.evaluate(() => {
    const t = window.__t09;
    const canvas = document.querySelector('[data-testid="annotation-canvas"]');
    t.unmountReact();
    canvas?.dispatchEvent(new PointerEvent('pointermove', { clientX: 20, clientY: 25, pointerId: 1 }));
    return {
      listeners: { ...t.canvasListenerCounts },
      pendingFrames: t.frameCounter.active,
      submits: t.factory.logs.reduce((sum, log) => sum + log.pointer, 0),
      live: t.factory.logs.filter(log => log.disposed === 0).length,
    };
  });
  expect(cleanup.submits, 'detached canvas does not retain its host input listener').toBe(submits);
  expect(cleanup.live).toBe(0);
  expect(cleanup.pendingFrames).toBe(0);
  for (const count of Object.values(cleanup.listeners)) expect(count).toBe(0);
});
