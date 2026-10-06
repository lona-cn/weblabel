import sharp from 'sharp';
import { expect, type Page, type TestInfo } from '@playwright/test';
import type { Viewport } from '../../apps/web/src/lib/editor/types';
import type { AnnotationObject } from '../../packages/contracts/generated/AnnotationObject';
import type {} from '../../apps/web/src/features/workbench/perf';

export async function measureNativeControls(page: Page, info: TestInfo, box: AnnotationObject['geometry'], view: Viewport, dpr: number) {
  const surface = (await page.getByTestId('annotation-canvas').boundingBox())!;
  const middleX = (box.x_min + box.x_max) / 2, middleY = (box.y_min + box.y_max) / 2;
  const centers = [
    ['top-left', box.x_min, box.y_min], ['top-middle', middleX, box.y_min], ['top-right', box.x_max, box.y_min],
    ['right-middle', box.x_max, middleY], ['bottom-right', box.x_max, box.y_max], ['bottom-middle', middleX, box.y_max],
    ['bottom-left', box.x_min, box.y_max], ['left-middle', box.x_min, middleY],
  ] as const;
  const labelVisibility = await page.getByTestId('annotation-canvas').evaluate(canvas => {
    const labels = canvas.nextElementSibling;
    if (!(labels instanceof HTMLElement) || labels.getAttribute('aria-hidden') !== 'true') throw new Error('Expected actual CanvasView label overlay');
    const previous = labels.style.visibility; labels.style.visibility = 'hidden'; return previous;
  });
  const observations = [];
  try {
    for (const [name, x, y] of centers) {
      await page.evaluate(() => window.__wl_test!.select('dense-17-37'));
      const center = { x: surface.x + x * view.scale + view.tx, y: surface.y + y * view.scale + view.ty };
      const clip = { x: Math.floor(center.x - 8), y: Math.floor(center.y - 8), width: 16, height: 16 };
      const selected = await page.screenshot({ path: info.outputPath(`native-${name}-selected-dpr-${dpr}.png`), clip, scale: 'css' });
      await page.evaluate(() => window.__wl_test!.select('dense-17-0'));
      const unselected = await page.screenshot({ path: info.outputPath(`native-${name}-unselected-dpr-${dpr}.png`), clip, scale: 'css' });
      const active = await sharp(selected).removeAlpha().raw().toBuffer();
      const inactive = await sharp(unselected).removeAlpha().raw().toBuffer();
      const changed: { x: number; y: number }[] = [];
      for (let py = 0; py < 16; py++) for (let px = 0; px < 16; px++) {
        const offset = (py * 16 + px) * 3;
        if ([0, 1, 2].some(channel => Math.abs(active[offset + channel] - inactive[offset + channel]) > 20)) changed.push({ x: px, y: py });
      }
      const footprint = changed.length ? { width_css: Math.max(...changed.map(pixel => pixel.x)) - Math.min(...changed.map(pixel => pixel.x)) + 1, height_css: Math.max(...changed.map(pixel => pixel.y)) - Math.min(...changed.map(pixel => pixel.y)) + 1 } : { width_css: 0, height_css: 0 };
      observations.push({ name, center, ...footprint });
      expect.soft(Math.abs(footprint.width_css - 8), `${name}: actual native control must be 8 CSS px`).toBeLessThanOrEqual(1);
      expect.soft(Math.abs(footprint.height_css - 8), `${name}: actual native control must be 8 CSS px`).toBeLessThanOrEqual(1);
    }
  } finally {
    await page.getByTestId('annotation-canvas').evaluate((canvas, visibility) => {
      const labels = canvas.nextElementSibling;
      if (!(labels instanceof HTMLElement)) throw new Error('Actual label overlay detached');
      labels.style.visibility = visibility;
    }, labelVisibility);
    await page.evaluate(() => window.__wl_test!.select('dense-17-37'));
  }
  return { controls: observations, expected_diameter_css: 8, raster_scale: 'css', dom_labels_excluded_from_gpu_crop: true };
}
