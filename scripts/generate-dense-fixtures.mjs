export function generateDenseWorkload(count, seed = 17, width = 4096, height = 4096) {
  if (![2000, 10000].includes(count) || !Number.isSafeInteger(seed) || seed < 0 || !Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64 || width > 4096 || height > 4096) throw new Error('invalid synthetic workload dimensions/count/seed');
  let state = (seed ^ count) >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x1_0000_0000; };
  const objects = Array.from({ length: count }, (_, index) => {
    const x = Math.floor(next() * (width - 32));
    const y = Math.floor(next() * (height - 32));
    const w = 4 + Math.floor(next() * 24);
    const h = 4 + Math.floor(next() * 24);
    return {
      object_id: `dense-${seed}-${index}`,
      label_id: 'label_person',
      geometry: { type: 'bbox_xyxy', x_min: x, y_min: y, x_max: x + w, y_max: y + h },
      attributes: { helmet_state: 'unknown' },
      origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null },
    };
  });
  return { fixture_kind: 'synthetic_dense_workload', seed, count, width, height, objects, operations: [
    { kind: 'pan', dx: 17, dy: -9 }, { kind: 'zoom', factor: 0.9 },
    { kind: 'edit', object_id: `dense-${seed}-37`, dx: 1 },
    { kind: 'idle_ms', duration: 10000 }, { kind: 'asset_cycle', count: 100 },
  ] };
}

// Importing this deterministic generator in the test-build browser does no I/O.
if (typeof process !== 'undefined' && process.argv[1]?.replaceAll('\\', '/').endsWith('/generate-dense-fixtures.mjs')) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const output = resolve(root, 'tests/fixtures/perf');
  const seed = Number(process.argv[2] ?? 17);
  await mkdir(output, { recursive: true });
  for (const count of [2000, 10000]) await writeFile(resolve(output, `dense-${count}-seed-${seed}.json`), `${JSON.stringify(generateDenseWorkload(count, seed))}\n`);
}
