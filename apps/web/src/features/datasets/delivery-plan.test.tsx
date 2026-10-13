import { expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { vi } from 'vitest';
vi.stubGlobal('crypto', webcrypto);
import { planDelivery } from './delivery-plan';
it('keeps groups in one deterministic split and partitions every selected item including exclusions', async () => {
  const rows = Array.from({ length: 2051 }, (_, i) => ({ id: String(i), group: String(i % 13), disposition: i % 5 ? 'include' as const : 'exclude' as const }));
  const first = await planDelivery(rows, '17');
  expect(first).toEqual(await planDelivery([...rows].reverse(), '17'));
  expect(first.batches.map(b => b.length)).toEqual([1024, 1024, 3]);
  expect(new Set(first.batches.flat().map(r => r.id)).size).toBe(2051);
  for (const group of new Set(rows.map(r => r.group))) expect(new Set(first.batches.flat().filter(r => r.group === group).map(r => r.split)).size).toBe(1);
});
