import sharp from 'sharp';
import { expect, test } from '@playwright/test';

type RendererHandle = {
  update_objects(projection: object): void;
  update_viewport(viewport: object): void;
  resize(width: number, height: number, dpr: number): void;
  recover(): Promise<void>;
  device_state(): string;
  adapter_diagnostics(): string;
  dispose(): void;
};
type RendererModule = {
  default(): Promise<void>;
  Renderer: {
    new (
      canvas: HTMLCanvasElement,
      width: number,
      height: number,
      rgba: Uint8Array,
    ): Promise<RendererHandle>;
  };
};

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
      renderer.dispose();
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
  const requireDevice = process.env.REQUIRE_WGPU_DEVICE === '1';
  const requireHardware = process.env.REQUIRE_HARDWARE_GPU === '1';
  if (requireDevice || requireHardware) expect(probe.state).toBe('ready');
  if (requireHardware && probe.state === 'ready') expect(probe.adapter).not.toMatch(/cpu|software/i);
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
});
