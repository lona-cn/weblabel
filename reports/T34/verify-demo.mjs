import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import sharp from 'sharp';
const root = resolve(import.meta.dirname);
const directory = join(root, 'synthetic-demo');
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
const report = JSON.parse(await readFile(join(root, 'demo.json'), 'utf8'));
const zero = JSON.parse(await readFile(join(root, 'zero.json'), 'utf8'));
assert.equal(manifest.images.length, 20);
assert.equal((await readdir(directory)).filter((name) => name.endsWith('.png')).length, 20);
assert.equal(new Set(manifest.images.map((image) => image.image_sha256)).size, 20);
for (const image of manifest.images) {
  const png = await readFile(join(directory, image.path));
  assert.equal(createHash('sha256').update(png).digest('hex'), image.image_sha256);
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, image.width); assert.equal(info.height, image.height);
  const foreground = new Set();
  for (const object of image.ground_truth) {
    const [x0, y0, x1, y1] = object.bbox_xyxy;
    assert.ok(x0 >= 0 && y0 >= 0 && x0 < x1 && y0 < y1 && x1 <= info.width && y1 <= info.height, `GT bbox outside canonical image: ${object.object_id}`);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) foreground.add(y * info.width + x);
  }
  for (let pixel = 0; pixel < info.width * info.height; pixel++) {
    const background = data[pixel * 4] === 220 && data[pixel * 4 + 1] === 230 && data[pixel * 4 + 2] === 240;
    assert.equal(!background, foreground.has(pixel));
  }
  const rows = report.records.filter((row) => row.image_id === image.image_id);
  assert.equal(rows.length, 3);
  for (const row of rows) { assert.equal(row.image_sha256, image.image_sha256); assert.equal(row.seed, image.seed); assert.deepEqual(row.ground_truth_object_ids, image.ground_truth.map((object) => object.object_id)); }
}
assert.equal(zero.status, 'noData'); assert.equal(zero.roi, null); assert.equal(zero.conclusion, null);
assert.equal(report.evidence_kind, 'SYNTHETIC_FORMAT_DEMO'); assert.equal(report.records.length, 60); assert.equal(report.roi, null);
for (const [arm, metrics] of Object.entries(report.arms)) { assert.equal(metrics.samples, 20); assert.equal(metrics.image_count, 20); assert.equal(metrics.object_count, 70); assert.equal(metrics.missed_objects, 3); assert.equal(metrics.fees_usd, null); assert.equal(metrics.return_rate, 0.15); if (arm !== 'human_only') assert.equal(metrics.ai_never_proposed_gt, 20); }
const csv = await readFile(join(root, 'demo.csv'), 'utf8');
const rows = [];
let row = [], field = '', quoted = false;
for (let index = 0; index < csv.length; index++) {
  const char = csv[index];
  if (char === '"') {
    if (quoted && csv[index + 1] === '"') { field += '"'; index++; }
    else quoted = !quoted;
  } else if (!quoted && (char === ',' || char === '\n' || (char === '\r' && csv[index + 1] === '\n'))) {
    row.push(field); field = '';
    if (char !== ',') { rows.push(row); row = []; if (char === '\r') index++; }
  } else field += char;
}
assert.equal(quoted, false); assert.equal(rows.length, 4);
const headers = rows.shift();
for (const cells of rows) {
  assert.equal(cells.length, headers.length);
  const values = Object.fromEntries(headers.map((header, index) => [header, cells[index]]));
  const metrics = report.arms[values.arm];
  assert.equal(Number(values.samples), metrics.samples);
  assert.equal(Number(values.human_total_ms), metrics.human_total_ms);
  assert.equal(Number(values.missed_objects), metrics.missed_objects);
  assert.equal(Number(values.return_rate), metrics.return_rate);
  assert.equal(values.fees_usd, 'null'); assert.equal(values.roi, 'null');
  assert.deepEqual(JSON.parse(values.ai_configurations), metrics.ai_configurations);
}
const result = { verified_pngs: 20, distinct_sha256: 20, verified_analysis_records: 60, verified_csv_arms: rows.length, gt_objects_per_arm: 70, pixel_inventory: 'exact_foreground_matches_all_GT', zero_status: zero.status, evidence_kind: report.evidence_kind, human_trials: 0, roi: null };
await writeFile(join(root, 'demo-verification.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
