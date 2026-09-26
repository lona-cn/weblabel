import sharp from 'sharp';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

type RendererHandle = {
  update_objects(projection: object): void;
  update_viewport(viewport: object): void;
  resize(width: number, height: number, dpr: number): void;
  render(): void;
  recover(): Promise<void>;
  simulate_device_loss(): void;
  device_state(): string;
  adapter_diagnostics(): string;
  dispose(): void;
};
type RendererModule = {
  default(): Promise<void>;
  Renderer: {
    new: (
      canvas: HTMLCanvasElement,
      width: number,
      height: number,
      rgba: Uint8Array,
    ) => Promise<RendererHandle>;
  };
};

declare global {
  interface Window {
    __t05?: RendererHandle;
  }
}

test('T05 Rust renderer submits the asymmetric scene to a real WebGPU canvas', async ({ page }) => {
  await page.goto('http://127.0.0.1:4174/');
  await page.setContent(
    '<canvas id="target" style="width:640px;height:480px"></canvas><output id="result"></output>',
  );
  const probe = await page.evaluate(async () => {
    try {
      // The wasm-bindgen module is generated under target/ and served locally; it is not a source module.
      const module = (await import('/renderer_wgpu_probe.js')) as unknown as RendererModule;
      await module.default();
      const canvas = document.querySelector<HTMLCanvasElement>('#target');
      if (!canvas) return { state: 'blocked', reason: 'canvas missing' };

      const width = 640;
      const height = 480;
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

      const renderer = await module.Renderer.new(canvas, width, height, rgba);
      const dpr = window.devicePixelRatio || 1;
      renderer.update_objects({
        objects: [{
          bounds: [10, 20, 110, 220],
          color: [0, 1, 0, 1],
          selected: true,
          locked: false,
        }],
        overlays: [],
      });
      renderer.update_viewport({
        scale: 2,
        tx: 0,
        ty: 0,
        css_width: 640,
        css_height: 480,
        dpr,
      });
      renderer.resize(0, 0, dpr);
      const zeroSizeBacking = [canvas.width, canvas.height];
      renderer.resize(640, 480, dpr);
      await renderer.recover();
      const result = {
        state: renderer.device_state(),
        adapter: renderer.adapter_diagnostics(),
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        zeroSizeBacking,
      };
      // Keep the renderer alive past the capture: dispose() destroys the
      // GPUDevice and aborts frames that have not been composited yet, so a
      // screenshot taken after it can never show renderer output.
      window.__t05 = renderer;
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      return result;
    } catch (error) {
      return {
        state: 'unsupported',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });
  await page.locator('#result').evaluate((node, value) => {
    node.textContent = JSON.stringify(value);
  }, probe);
  assertGateRequirements(probe as BootResult);
  if (probe.state === 'ready') {
    const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
    expect(probe.canvasWidth).toBe(Math.round(640 * dpr));
    expect(probe.canvasHeight).toBe(Math.round(480 * dpr));
    expect(probe.zeroSizeBacking).toEqual([Math.round(640 * dpr), Math.round(480 * dpr)]);
    console.info(`T05_RUST_RENDERER ${probe.adapter}`);
    const canvasScreenshot = await page.locator('#target').screenshot({
      path: 'reports/T05/renderer.png',
    });
    const { data, info } = await sharp(canvasScreenshot)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(640);
    expect(info.height).toBe(480);
    const pixel = (x: number, y: number) =>
      [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
    const imagePixel = pixel(500, 100);
    expect(imagePixel[0]).toBeGreaterThan(200);
    expect(imagePixel[1]).toBeGreaterThan(25);
    expect(imagePixel[2]).toBeLessThan(60);
    const bboxPixel = pixel(20, 200);
    expect(bboxPixel[0]).toBeLessThan(60);
    expect(bboxPixel[1]).toBeGreaterThan(200);
    expect(bboxPixel[2]).toBeLessThan(60);
  } else {
    expect(probe.reason).toBeTruthy();
    console.warn(`T05_RUST_RENDERER ${probe.state}: ${probe.reason}`);
  }
  await page.evaluate(() => window.__t05?.dispose());
});

const CANVAS_HTML =
  '<canvas id="target" style="width:640px;height:480px"></canvas><output id="result"></output>';

/** The asymmetric C8 golden image: quadrants (230,45,25)/(35,45,210)/(230,190,25)/(35,190,210). */
function goldenRgba(): Uint8Array {
  const width = 640;
  const height = 480;
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

type BootResult = { state: string; reason?: string; adapter?: string };

// A software rasterizer must never satisfy the real-hardware gate. Denylist the
// known software adapters by name (wgpu device_type on Chromium's WebGPU
// backend is "Other" even for real GPUs, so a positive device_type assert would
// reject genuine hardware on this platform).
const SOFTWARE_ADAPTER = /cpu|software|swiftshader|llvmpipe|lavapipe|mesa|basic render/i;

function assertGateRequirements(boot: BootResult): void {
  const requireDevice = process.env.REQUIRE_WGPU_DEVICE === '1';
  const requireHardware = process.env.REQUIRE_HARDWARE_GPU === '1';
  if (requireDevice || requireHardware) expect(boot.state).toBe('ready');
  if (requireHardware && boot.state === 'ready') {
    expect(boot.adapter ?? '').not.toMatch(SOFTWARE_ADAPTER);
  }
}

async function bootGoldenScene(
  page: Page,
  projection: { objects: object[]; overlays: object[] },
  viewport: { scale: number; tx: number; ty: number },
): Promise<BootResult> {
  await page.goto('http://127.0.0.1:4174/');
  await page.setContent(CANVAS_HTML);
  const boot = await page.evaluate(
    async (config): Promise<BootResult> => {
      try {
        // The wasm-bindgen module is generated under target/ and served
        // locally; it is not a source module, so it cannot be statically
        // imported here.
        const module = (await import('/renderer_wgpu_probe.js')) as unknown as RendererModule;
        await module.default();
        const canvas = document.querySelector<HTMLCanvasElement>('#target');
        if (!canvas) return { state: 'blocked', reason: 'canvas missing' };
        const renderer = await module.Renderer.new(canvas, 640, 480, config.rgba);
        renderer.update_objects(config.projection);
        renderer.update_viewport({
          ...config.viewport,
          css_width: 640,
          css_height: 480,
          dpr: window.devicePixelRatio || 1,
        });
        window.__t05 = renderer;
        return { state: renderer.device_state(), adapter: renderer.adapter_diagnostics() };
      } catch (error) {
        return {
          state: 'unsupported',
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
    { projection, viewport, rgba: goldenRgba() },
  );
  assertGateRequirements(boot);
  return boot;
}

type Scene = {
  width: number;
  height: number;
  pixel(x: number, y: number): [number, number, number];
  stroke(x: number, y: number): boolean;
  handle(x: number, y: number): boolean;
  runLength(x0: number, y: number, matches: (x: number, y: number) => boolean): number;
};

async function captureScene(page: Page, path: string): Promise<Scene> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  const buffer = await page.locator('#target').screenshot({ path });
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number): [number, number, number] => {
    const offset = (y * info.width + x) * info.channels;
    return [data[offset], data[offset + 1], data[offset + 2]];
  };
  const stroke = (x: number, y: number) => {
    const [r, g, b] = pixel(x, y);
    return r < 60 && g > 200 && b < 60;
  };
  const handle = (x: number, y: number) => {
    const [r, g, b] = pixel(x, y);
    return r < 60 && g < 60 && b > 200;
  };
  const runLength = (x0: number, y: number, matches: (x: number, y: number) => boolean) => {
    let length = 0;
    while (matches(x0 + length, y)) length += 1;
    return length;
  };
  return { width: info.width, height: info.height, pixel, stroke, handle, runLength };
}

// C8 golden viewports keep image(10,20) anchored at CSS(33,33) at both zooms:
// scale=2 with translation (13,-7), and scale=4 with translation (-7,-47).
const GOLDEN_PROJECTION = {
  objects: [{ bounds: [10, 20, 110, 220], color: [0, 1, 0, 1], selected: true, locked: false }],
  overlays: [{ bounds: [60, 120, 60, 120], color: [0, 0, 1, 1] }],
};

test('zoom keeps the bbox stroke and handle at fixed screen width at the C8 viewports', async ({
  page,
}) => {
  const boot = await bootGoldenScene(page, GOLDEN_PROJECTION, { scale: 2, tx: 13, ty: -7 });
  expect(boot.state).toBe('ready');
  console.info(`T05_RUST_RENDERER_ZOOM ${boot.adapter}`);
  const scale2 = await captureScene(page, 'reports/T05/zoom-scale2.png');
  expect(scale2.width).toBe(640);
  expect(scale2.height).toBe(480);
  // Screen (500,100) lands in the red-dominant quadrant at both zooms.
  const imagePixel = scale2.pixel(500, 100);
  expect(imagePixel[0]).toBeGreaterThan(200);
  expect(imagePixel[1]).toBeGreaterThan(25);
  expect(imagePixel[2]).toBeLessThan(60);
  // 1.5 CSS px stroke centered on the edge at CSS 33 covers columns 32..33.
  expect(scale2.runLength(32, 200, scale2.stroke)).toBe(2);
  expect(scale2.stroke(31, 200)).toBe(false);
  expect(scale2.stroke(34, 200)).toBe(false);
  // The top edge stays anchored on rows 32..33 (image y=20 at CSS 33).
  expect(scale2.stroke(100, 32)).toBe(true);
  expect(scale2.stroke(100, 33)).toBe(true);
  expect(scale2.stroke(100, 31)).toBe(false);
  expect(scale2.stroke(100, 34)).toBe(false);
  // 8 CSS px handle centered on image (60,120) at CSS (133,233).
  expect(scale2.runLength(129, 233, scale2.handle)).toBe(8);
  expect(scale2.handle(128, 233)).toBe(false);
  expect(scale2.handle(137, 233)).toBe(false);
  expect(scale2.handle(129, 229)).toBe(true);

  await page.evaluate(() => {
    const renderer = window.__t05;
    if (!renderer) throw new Error('renderer missing');
    renderer.update_viewport({
      scale: 4,
      tx: -7,
      ty: -47,
      css_width: 640,
      css_height: 480,
      dpr: window.devicePixelRatio || 1,
    });
  });
  const scale4 = await captureScene(page, 'reports/T05/zoom-scale4.png');
  expect(scale4.width).toBe(640);
  expect(scale4.height).toBe(480);
  const zoomedImagePixel = scale4.pixel(500, 100);
  expect(zoomedImagePixel[0]).toBeGreaterThan(200);
  expect(zoomedImagePixel[1]).toBeGreaterThan(25);
  expect(zoomedImagePixel[2]).toBeLessThan(60);
  // Same anchor: stroke and handle pixel runs must not thicken or thin.
  expect(scale4.runLength(32, 200, scale4.stroke)).toBe(2);
  expect(scale4.stroke(31, 200)).toBe(false);
  expect(scale4.stroke(34, 200)).toBe(false);
  expect(scale4.stroke(100, 32)).toBe(true);
  expect(scale4.stroke(100, 31)).toBe(false);
  // The handle moved to CSS (233,433) with the zoom but kept its size.
  expect(scale4.runLength(229, 433, scale4.handle)).toBe(8);
  expect(scale4.handle(228, 433)).toBe(false);
  expect(scale4.handle(237, 433)).toBe(false);
  expect(scale4.runLength(32, 200, scale4.stroke)).toBe(scale2.runLength(32, 200, scale2.stroke));
  expect(scale4.runLength(229, 433, scale4.handle)).toBe(scale2.runLength(129, 233, scale2.handle));
  await page.evaluate(() => window.__t05?.dispose());
});

test('simulated device loss keeps the scene and recover() restores rendering', async ({ page }) => {
  const boot = await bootGoldenScene(page, GOLDEN_PROJECTION, { scale: 2, tx: 13, ty: -7 });
  expect(boot.state).toBe('ready');
  console.info(`T05_RUST_RENDERER_LOSS ${boot.adapter}`);
  const signature = (scene: Scene) => ({
    image: scene.pixel(500, 100),
    stroke: scene.pixel(33, 200),
    handle: scene.pixel(133, 233),
    strokeRun: scene.runLength(32, 200, scene.stroke),
    handleRun: scene.runLength(129, 233, scene.handle),
  });
  const before = await captureScene(page, 'reports/T05/loss-before.png');
  const loss = await page.evaluate(() => {
    const renderer = window.__t05;
    if (!renderer) return { state: 'missing', renderError: 'renderer missing' };
    renderer.simulate_device_loss();
    const state = renderer.device_state();
    let renderError = '';
    try {
      renderer.render();
    } catch (error) {
      renderError = error instanceof Error ? error.message : String(error);
    }
    return { state, renderError };
  });
  expect(loss.state).toBe('lost');
  expect(loss.renderError).toMatch(/DeviceLost/);
  await page.evaluate(() => {
    const renderer = window.__t05;
    if (!renderer) throw new Error('renderer missing');
    return renderer.recover();
  });
  const recoveredState = await page.evaluate(() => window.__t05?.device_state());
  expect(recoveredState).toBe('ready');
  const after = await captureScene(page, 'reports/T05/loss-after-recover.png');
  // The loss and recovery path must not modify the saved scene.
  expect(signature(after)).toEqual(signature(before));
  await page.evaluate(() => window.__t05?.dispose());
});
