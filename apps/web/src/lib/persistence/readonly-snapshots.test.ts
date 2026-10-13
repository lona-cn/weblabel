import { describe, expect, it, vi } from 'vitest';
import { admitRawDraft, InMemoryDraftStorage } from './draft-store';
import { classifyDraftBranches, classifyReadonlySnapshot } from './recovery';
import { SaveQueue } from './save-queue';
import type { AnnotationDocument, DraftRecord } from './types';
const document: AnnotationDocument = { schema_version: 1, asset_revision_id: 'asset', ontology_version_id: 'ontology', coordinate_space: { type: 'canonical_image_pixels', width: 640, height: 480 }, completion: 'in_progress', objects: [] };
function queue(storage: InMemoryDraftStorage) {
  return new SaveQueue({ storage, debounceMs: 60000, owner: { token: {}, actor_id: 'actor', project_id: 'project', isCurrent: () => true, isWritable: () => true, canPrepareOperation: () => true, getLease: () => null }, transport: {
    async save(request) { return { operation_id: request.operation_id, idempotent_replay: false, revision: { annotation_revision_id: 'ack', parent_revision_id: 'base', revision_no: 2, document: request.document, created_at: '2026-10-13T00:00:00Z', created_by: 'actor', content_hash: 'hash' } }; },
    async fetchHead() { throw new Error('No remote evidence expected'); }, async fetchRevision() { throw new Error('No remote evidence expected'); },
  } });
}
function record(): DraftRecord { return { schema_version: 1, asset_revision_id: 'asset', ontology_version_id: 'ontology', base_revision_id: 'base', generation: 29, synced_generation: 29, document: structuredClone(document), pending: null, draft_owner: null, pending_owner: null, pending_outcome: 'prepared', intent_journal: [], synced_intent_seq: 0, writes_paused: false, save_error: null, updated_at: '2026-10-13T00:00:00Z' }; }
describe('display-only read-only snapshots', () => {
  it.each([0, 29])('retains normal server-open/reload snapshots at generation %s without granting authorship', async generation => {
    const storage = new InMemoryDraftStorage();
    for (let reload = 0; reload < 3; reload++) {
      const current = queue(storage);
      expect(current.initializeFromServerRevision({ asset_revision_id: 'asset', ontology_version_id: 'ontology', annotation_revision_id: 'base', generation, document })).toBe(true);
      await current.whenPersisted('asset');
    }
    const before = await storage.list('asset');
    expect(before).toHaveLength(3);
    expect(new Set(before.map(row => row.draft_id)).size).toBe(3);
    const put = vi.spyOn(storage, 'put');
    for (const row of before) {
      expect(classifyReadonlySnapshot(row.record, 'asset')).toBe('clean_snapshot');
      admitRawDraft(row.record, 'asset');
      expect(row.record.draft_owner).toBeNull();
      expect(row.record.pending_owner).toBeNull();
    }
    expect(put).not.toHaveBeenCalled();
    expect(await storage.list('asset')).toEqual(before);
  });
  it('classifies actual ACK output at positive generation, without replacing lineage proof', async () => {
    const storage = new InMemoryDraftStorage(), current = queue(storage);
    current.enqueue({ asset_revision_id: 'asset', ontology_version_id: 'ontology', base_revision_id: 'base', generation: 29, document });
    await current.flush('asset');
    const [row] = await storage.list('asset');
    expect(classifyReadonlySnapshot(row.record, 'asset')).toBe('clean_snapshot');
    const memory = current.getDraftBranchSnapshot('asset')!;
    const withoutProof = { ...memory, local_commit: null };
    expect(classifyDraftBranches([row], withoutProof).get(row.draft_id)).toBe('unresolved');
    expect(classifyReadonlySnapshot(row.record, 'asset')).toBe('clean_snapshot');
  });
  it('accepts a fully synchronized journal, not an unsynchronized entry', () => {
    const raw = record();
    raw.intent_journal = [{ seq: 1, generation: 29, recorded_at: raw.updated_at, intent: { suggestion_set_id: 'set', change_ids: ['change'], decision: 'accept' } }];
    expect(classifyReadonlySnapshot(raw, 'asset')).toBe('recovery_required');
    raw.synced_intent_seq = 1;
    expect(classifyReadonlySnapshot(raw, 'asset')).toBe('clean_snapshot');
  });
  it.each(['dirty', 'unknown', 'rejected', 'failed', 'paused', 'foreign', 'pending-owner', 'missing-owner'] as const)('never hides %s as clean history', kind => {
    const raw = record();
    if (kind === 'dirty') raw.synced_generation = 0;
    if (kind === 'unknown' || kind === 'rejected') raw.pending_outcome = kind;
    if (kind === 'failed') raw.save_error = { kind: 'network', code: 'OFFLINE', message: 'offline', status: null, request_id: null };
    if (kind === 'paused') raw.writes_paused = true;
    if (kind === 'foreign') raw.draft_owner = { actor_id: 'other', project_id: 'project' };
    if (kind === 'pending-owner') raw.pending_owner = { actor_id: 'other', project_id: 'project' };
    if (kind === 'missing-owner') delete raw.draft_owner;
    const before = JSON.stringify(raw);
    expect(classifyReadonlySnapshot(raw, 'asset')).toBe('recovery_required');
    expect(JSON.stringify(raw)).toBe(before);
  });
  it('never classifies a valid prepared request as history', () => {
    const raw = record();
    raw.pending = { operation_id: 'operation', generation: 29, edit_seq: raw.edit_seq ?? 0, journal_seq_end: 0, prepared_at: raw.updated_at, request: { operation_id: 'operation', base_revision_id: 'base', document, lease: null, suggestion_decisions: [] } };
    admitRawDraft(raw, 'asset');
    expect(classifyReadonlySnapshot(raw, 'asset')).toBe('recovery_required');
  });
  it.each(['schema', 'geometry', 'counter', 'asset', 'pending'] as const)('retains malformed %s as raw rescue', kind => {
    const raw: Record<string, unknown> = { ...record() };
    if (kind === 'schema') raw.schema_version = 99;
    if (kind === 'geometry') raw.document = { ...document, coordinate_space: { type: 'canonical_image_pixels', width: -1, height: 480 } };
    if (kind === 'counter') raw.synced_generation = 30;
    if (kind === 'asset') raw.document = { ...document, asset_revision_id: 'other' };
    if (kind === 'pending') raw.pending = { operation_id: 'unknown-request' };
    const before = JSON.stringify(raw);
    expect(classifyReadonlySnapshot(raw, 'asset')).toBe('rescue_only');
    expect(JSON.stringify(raw)).toBe(before);
  });
});
