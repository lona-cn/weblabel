import { expect, it } from 'vitest';
import { DraftStore, InMemoryDraftStorage, immutableDocument } from './draft-store';
import { classifyDraftBranches } from './recovery';
import { SaveQueue } from './save-queue';
import type { DraftRecord, DraftBranchEnvelope, DraftBranchSnapshot, SourceRef } from './types';

it('retains independent raw snapshots and certifies only the committed branch token', async () => {
  const storage = new InMemoryDraftStorage();
  const store = new DraftStore(storage);
  const raw = { schema_version: 77, unknown: new Map([['future', 4]]) };
  const a = await store.save({ asset_revision_id: 'asset', draft_id: 'A', write_token: '', record: raw, sources: [] });
  const b = await store.save({ asset_revision_id: 'asset', draft_id: 'B', write_token: '', record: { other: true }, sources: [] });
  raw.unknown.set('future', 99);
  expect(a?.write_token).toBeTruthy();
  expect(b?.write_token).not.toBe(a?.write_token);
  expect(await store.list('asset')).toEqual([a, b]);
  expect((await store.load('asset', 'A'))?.record).toEqual({ schema_version: 77, unknown: new Map([['future', 4]]) });
  expect(await store.remove('asset', 'B')).toBe(true);
  expect(await store.load('asset', 'A')).toEqual(a);
  expect(await store.load('asset', 'B')).toBeNull();
});

function record(synced = false): DraftRecord {
  return { schema_version: 1, asset_revision_id: 'asset', ontology_version_id: 'ontology', base_revision_id: 'base', generation: 2, synced_generation: synced ? 2 : 0, edit_seq: 1, synced_intent_seq: 0, intent_journal: [], pending: null, draft_owner: { actor_id: 'actor', project_id: 'project' }, document: { schema_version: 1, asset_revision_id: 'asset', ontology_version_id: 'ontology', coordinate_space: { type: 'canonical_image_pixels', width: 640, height: 480 }, completion: 'in_progress', objects: [] }, updated_at: '2026-10-11T00:00:00Z' };
}
function envelope(id: string, synced = false, sources: readonly SourceRef[] = []): DraftBranchEnvelope {
  return { asset_revision_id: 'asset', draft_id: id, write_token: id + '-token', record: record(synced), sources };
}
const ref = (id: string, action: SourceRef['action'] = 'recover'): SourceRef => ({ draft_id: id, write_token: id + '-token', action });
function queue(storage: InMemoryDraftStorage) {
  return new SaveQueue({ storage, debounceMs: 60_000, clock: { now: () => Date.parse('2026-10-11T00:00:00Z'), setTimeout: () => 0, clearTimeout: () => undefined }, owner: { token: {}, actor_id: 'actor', project_id: 'project', isCurrent: () => true, isWritable: () => true, canPrepareOperation: () => true, getLease: () => null }, transport: { save: async () => { throw new Error('Unexpected HTTP replay'); }, fetchHead: async () => null, fetchRevision: async () => { throw new Error('Unexpected immutable read'); } } });
}
it('persists the requested generation and opaque metadata when a later save waits behind another branch', async () => {
  const storage = new InMemoryDraftStorage(), store = new DraftStore(storage);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), put = storage.put.bind(storage);
  storage.put = async (row, guard) => {
    if (row.draft_id === 'held') { entered.resolve(); await release.promise; }
    return put(row, guard);
  };
  const first = store.save(envelope('held'));
  await entered.promise;
  const raw = { ...record(), document: immutableDocument(record().document), future: new Map([['opaque', { value: 4 }]]) };
  const source = ref('source'), next = store.save({ asset_revision_id: 'asset', draft_id: 'next', write_token: '', record: raw, sources: [source] });
  raw.generation = 9; raw.future.get('opaque')!.value = 99; source.write_token = 'changed-after-save';
  release.resolve(); await first; const receipt = await next;
  const durable = await store.load('asset', 'next');
  expect(durable).toMatchObject({ write_token: receipt!.write_token, record: { generation: 2, future: new Map([['opaque', { value: 4 }]]) }, sources: [ref('source')] });
  expect((durable!.record as DraftRecord).document).toEqual(record().document);
});

it('distinguishes true transitive synchronization from archive decisions and stale or circular refs', () => {
  const a = envelope('A'), b = envelope('B', false, [ref('A')]), c = envelope('C', true, [ref('B')]);
  expect([...classifyDraftBranches([a, b, c], null)]).toEqual([['A', 'recovered'], ['B', 'recovered'], ['C', 'synced']]);
  c.sources = [ref('B', 'use_server')];
  expect(classifyDraftBranches([a, b, c], null).get('A')).toBe('archived');
  expect(classifyDraftBranches([a, b, c], null).get('B')).toBe('archived');
  c.sources = [ref('B', 'use_server'), ref('A')];
  expect(classifyDraftBranches([a, b, c], null).get('A')).toBe('recovered');
  a.write_token = 'new-source-snapshot';
  expect(classifyDraftBranches([a, b, c], null).get('A')).toBe('unresolved');
  const circularA = envelope('A', false, [ref('B')]), circularB = envelope('B', true, [ref('A')]);
  expect(classifyDraftBranches([circularA, circularB], null).get('A')).toBe('unresolved');
});
it('never covers uncommitted memory, an ACK barrier, missing disk proof, or raw recovery with a metadata ref', () => {
  const a = envelope('A'), b = envelope('B', true, [ref('A')]);
  const memory: DraftBranchSnapshot = { envelope: b, local_commit: { draft_id: 'B', write_token: 'B-token', persist_seq: 1, edit_seq: 1, generation: 2 }, ack_local_barrier: false };
  expect(classifyDraftBranches([a, b], memory).get('A')).toBe('recovered');
  for (const invalid of [ { ...memory, local_commit: null }, { ...memory, ack_local_barrier: true }, { ...memory, local_commit: { ...memory.local_commit!, generation: 1 } }, { ...memory, envelope: { ...b, write_token: 'not-on-disk' } } ]) expect(classifyDraftBranches([a, b], invalid).get('A')).toBe('unresolved');
  a.record = { schema_version: 99, preserved: { unknown: true } };
  expect(classifyDraftBranches([a, b], null).get('A')).toBe('rescue_only');
  b.sources = [ref('A', 'use_server')];
  expect(classifyDraftBranches([a, b], null).get('A')).toBe('archived');
});
it('forks without overwriting raw sources and lets a certified dirty writer switch explicitly', async () => {
  const storage = new InMemoryDraftStorage(), saves = queue(storage), a = envelope('A'), b = envelope('B');
  a.record = { ...record(), future_fields: new Map([['retain', 9]]) };
  await storage.put(a); await storage.put(b);
  expect(await saves.forkFromRecord(a)).toBe(true);
  const first = saves.getDraftBranchSnapshot('asset')!;
  expect(first.envelope.draft_id).not.toBe('A'); expect(first.local_commit?.write_token).toBe(first.envelope.write_token);
  expect(await storage.get('asset', 'A')).toEqual(a);
  expect(await saves.forkFromRecord(b, { expectedCurrent: first.local_commit })).toBe(true);
  const second = saves.getDraftBranchSnapshot('asset')!;
  expect(second.envelope.draft_id).not.toBe(first.envelope.draft_id);
  expect(await storage.get('asset', first.envelope.draft_id)).toEqual(first.envelope);
  expect(await storage.get('asset', 'B')).toEqual(b);
});
it('cannot install an old source over an edit arriving while its read is held', async () => {
  const storage = new InMemoryDraftStorage(), saves = queue(storage), a = envelope('A'), b = envelope('B');
  await storage.put(a); await storage.put(b); await saves.forkFromRecord(a);
  const before = saves.getDraftBranchSnapshot('asset')!;
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(done => { release = done; }), started = new Promise<void>(done => { entered = done; });
  const get = storage.get.bind(storage);
  storage.get = async (asset, draft, guard) => { if (draft === 'B') { entered(); await held; } return get(asset, draft, guard); };
  const switching = saves.forkFromRecord(b, { expectedCurrent: before.local_commit });
  await started;
  saves.enqueue({ asset_revision_id: 'asset', ontology_version_id: 'ontology', generation: 3, document: { ...record().document, completion: 'complete' } });
  release(); await saves.whenPersisted('asset');
  expect(await switching).toBe(false);
  expect(saves.getDraftBranchSnapshot('asset')!.envelope.draft_id).toBe(before.envelope.draft_id);
  expect(saves.toRecord('asset')!.document.completion).toBe('complete');
});
it('cannot claim a failed fork as committed or install a source rewritten during the fork transaction', async () => {
  for (const mode of ['quota', 'rewritten']) {
    const storage = new InMemoryDraftStorage(), saves = queue(storage), a = envelope('A'); await storage.put(a);
    if (mode === 'quota') storage.failNextPut(new Error('synthetic quota failure'));
    else { const put = storage.put.bind(storage); storage.put = async (row, guard) => { const receipt = await put(row, guard); if (row.draft_id !== 'A') await put({ ...a, write_token: 'new-token', record: { ...record(), generation: 3 } }); return receipt; }; }
    expect(await saves.forkFromRecord(a)).toBe(false);
    expect(saves.getStatus('asset').local_commit ?? null).toBeNull();
    expect(saves.toRecord('asset')!.document).toEqual(record().document);
    expect((await storage.get('asset', 'A'))!.write_token).toBe(mode === 'quota' ? 'A-token' : 'new-token');
  }
});

