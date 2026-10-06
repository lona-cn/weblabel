import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gate, summarize, hardwareKind } from '../../scripts/verify-gpu.mjs';

// Pure policy/aggregation tests, never classified as hardware evidence.
test('2k unchanged CPU and double-rAF targets accept inclusive boundaries', () => {
  const rows = Array.from({ length: 1000 }, (_, sequence) => ({ sequence, cpu_ms: 8, double_raf_ms: 33, submissions: 1 }));
  const result = gate(2000, { pointer_drag: rows, pan: rows, zoom: rows, committed_edit: rows });
  assert.deepEqual(result.failures, []);
  assert.equal(result.summaries.committed_edit.valid_samples, 1000);
});
test('committed edits cannot hide behind fast pan; raw rows remain unchanged', () => {
  const fast = Array.from({ length: 1000 }, () => ({ cpu_ms: 1, double_raf_ms: 10, submissions: 1 }));
  const slow = Array.from({ length: 1000 }, () => ({ cpu_ms: 28.3, double_raf_ms: 40, submissions: 1 }));
  const before = structuredClone(slow);
  const result = gate(2000, { pointer_drag: fast, pan: fast, zoom: fast, committed_edit: slow });
  assert.deepEqual(result.failures, ['committed_edit: CPU P95 28.3 > 8ms', 'committed_edit: double-rAF proxy P95 40 > 33ms']);
  assert.deepEqual(slow, before);
});
test('10k reports full stress metrics without manufacturing a universal FPS target', () => {
  const rows = Array.from({ length: 1000 }, () => ({ cpu_ms: 110.8, double_raf_ms: 150, submissions: 1 }));
  const result = gate(10000, { pointer_drag: rows, pan: rows, zoom: rows, committed_edit: rows });
  assert.equal(result.summaries.committed_edit.cpu_p95_ms, 110.8);
  assert.deepEqual(result.failures, []);
});
test('short/invalid/no-submit rows fail rather than being filtered or replaced', () => {
  const rows = Array.from({ length: 1000 }, () => ({ cpu_ms: 1, double_raf_ms: 10, submissions: 1 }));
  assert.throws(() => summarize(rows.slice(1)), /require >=1000/);
  for (const invalid of [{ cpu_ms: NaN }, { double_raf_ms: Infinity }, { cpu_ms: -1 }, { submissions: 0 }, { submissions: 2 }]) {
    assert.throws(() => summarize([{ ...rows[0], ...invalid }, ...rows.slice(1)]), /Invalid workload/);
  }
});
test('software/fallback wins over vendor marketing; unreadable is not hardware', () => {
  assert.equal(hardwareKind({ vendor: 'NVIDIA', architecture: 'swiftshader' }), 'software');
  assert.equal(hardwareKind({ vendor: 'NVIDIA', isFallbackAdapter: true }), 'software');
  assert.equal(hardwareKind({ vendor: 'unknown', architecture: 'unknown' }), 'unknown');
  assert.equal(hardwareKind({ vendor: 'NVIDIA', architecture: 'blackwell', isFallbackAdapter: false }), 'hardware');
});
