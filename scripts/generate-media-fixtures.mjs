import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'tests/fixtures/media');
const width = 48;
const height = 32;
const pixels = Buffer.alloc(width * height * 3);
const quadrants = [
  [235, 30, 30], [30, 210, 40],
  [25, 60, 235], [235, 210, 20],
];
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const quadrant = (y >= height / 2 ? 2 : 0) + (x >= width / 2 ? 1 : 0);
    const offset = (y * width + x) * 3;
    pixels.set(quadrants[quadrant], offset);
  }
}
await mkdir(output, { recursive: true });
for (let orientation = 1; orientation <= 8; orientation += 1) {
  const jpeg = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
    .withMetadata({ orientation })
    .toBuffer();
  await writeFile(resolve(output, `orientation-${orientation}.jpg`), jpeg);
}
