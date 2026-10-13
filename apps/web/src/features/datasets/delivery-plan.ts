export type DeliveryInput = { id: string; group: string; disposition: 'include' | 'exclude' };
export type PlannedItem = DeliveryInput & { split: 'train' | 'val' | 'test' };
export async function planDelivery(rows: DeliveryInput[], seed: string): Promise<{ batches: PlannedItem[][]; seed: string }> {
  const seen = new Set<string>();
  const ordered = [...rows].sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const batches: PlannedItem[][] = [];
  if (!seed.trim()) throw new Error('seed不能为空');
  const splits = new Map<string, PlannedItem['split']>();
  await Promise.all([...new Set(rows.map(row => row.group))].map(async group => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed + '\0' + group));
    const prefix = new DataView(digest).getBigUint64(0, false);
    const bucket = Number(prefix % 100n);
    splits.set(group, bucket < 80 ? 'train' : bucket < 90 ? 'val' : 'test');
  }));
  for (const row of ordered) {
    if (seen.has(row.id)) throw new Error('交付范围含重复资产');
    seen.add(row.id);
    const item: PlannedItem = { ...row, split: splits.get(row.group)! };
    if (!batches.length || batches[batches.length - 1].length === 1024) batches.push([]);
    batches[batches.length - 1].push(item);
  }
  const included = ordered.filter(row => row.disposition === 'include').length;
  if (included < batches.length) throw new Error('每个快照至少需一项纳入；当前排除项过多，无法在1024项预算内完整分批。请明确调整范围。');
  for (const batch of batches) {
    if (batch.some(row => row.disposition === 'include')) continue;
    const donor = batches.find(items => items.filter(row => row.disposition === 'include').length > 1)!;
    const index = donor.findIndex(row => row.disposition === 'include');
    [batch[0], donor[index]] = [donor[index], batch[0]];
  }
  return { batches, seed };
}
