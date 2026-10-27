import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import type { DraftRecord, SaveQueueOwner } from '../../lib/persistence/types';
import { SaveQueue } from '../../lib/persistence/save-queue';
import { InMemoryDraftStorage } from '../../lib/persistence/draft-store';
const document: AnnotationDocument = { schema_version: 1, asset_revision_id: 'asset', ontology_version_id: 'ontology', coordinate_space: { type: 'canonical_image_pixels', width: 100, height: 100 }, objects: [], completion: 'in_progress' };
const receipt: AnnotationRevision = { annotation_revision_id: 'imported', parent_revision_id: 'base', revision_no: 2, document: { ...document, completion: 'complete' }, content_hash: 'a'.repeat(64), created_at: '2026-10-10T00:00:00Z', created_by: 'user' };
const fixtureOwners = new Set<object>();
function queue(storage = new InMemoryDraftStorage()) {
  const token = {};
  fixtureOwners.add(token);
  const owner: SaveQueueOwner = { token, actor_id: receipt.created_by, project_id: 'import-cutover-project', isCurrent: () => fixtureOwners.has(token), isWritable: () => fixtureOwners.has(token), canPrepareOperation: () => true, getLease: (asset) => asset === document.asset_revision_id ? { task_id: 'task', fencing_token: 4 } : null };
  return new SaveQueue({ owner, storage, transport: { save: async () => { throw new Error('unexpected save'); }, fetchHead: async () => null, fetchRevision: async () => { throw new Error('unexpected read'); } } });
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { fixtureOwners.clear(); vi.clearAllTimers(); vi.useRealTimers(); });
describe('actual import receipt clean cutover', () => {
  it('uses the receipt document and base for subsequent editing without a save from adoption', () => {
    const saves = queue();
    saves.initializeFromServerRevision({ asset_revision_id: 'asset', ontology_version_id: 'ontology', annotation_revision_id: 'base', generation: 7, document });
    expect(saves.adoptImportReceipt(receipt, 'base')).toBe(true);
    expect(saves.toRecord('asset')).toMatchObject({ base_revision_id: 'imported', generation: 0, synced_generation: 0, pending: null, document: receipt.document });
    expect(saves.getStatus('asset').dirty).toBe(false);
    saves.enqueue({ asset_revision_id: 'asset', ontology_version_id: 'ontology', base_revision_id: 'imported', generation: 1, document: { ...receipt.document, completion: 'in_progress' } });
    expect(saves.getStatus('asset').dirty).toBe(true);
    expect(saves.toRecord('asset')?.base_revision_id).toBe('imported');
  });
  it('refuses dirty, paused and unknown pending payloads rather than dropping journal or original operation', async () => {
    const intent = { suggestion_set_id: 'set', change_ids: ['change'], decision: 'accept' as const };
    const record: DraftRecord = { schema_version: 1, asset_revision_id: 'asset', ontology_version_id: 'ontology', base_revision_id: 'base', generation: 1, synced_generation: 0, synced_intent_seq: 0, document, updated_at: '2026-10-10T00:00:00Z', intent_journal: [{ seq: 1, generation: 1, intent, recorded_at: '2026-10-10T00:00:00Z' }], pending: { operation_id: 'original-op', generation: 1, journal_seq_end: 1, edit_seq: 1, prepared_at: '2026-10-10T00:00:00Z', request: { operation_id: 'original-op', base_revision_id: 'base', document, lease: { task_id: 'task', fencing_token: 4 }, suggestion_decisions: [intent] } } };
    const storage = new InMemoryDraftStorage(), saves = queue(storage); const source = { asset_revision_id: 'asset', draft_id: crypto.randomUUID(), write_token: crypto.randomUUID(), record, sources: [] }; await storage.put(source); await saves.forkFromRecord(source, { pauseForUserChoice: true });
    const before = saves.toRecord('asset');
    expect(saves.adoptImportReceipt(receipt, 'base')).toBe(false);
    expect(saves.toRecord('asset')).toEqual(before);
    expect(saves.getStatus('asset').writes_paused).toBe(true);
  });
  it('rejects receipts from another lineage or ontology and preserves the clean current head', () => {
    const saves = queue(); saves.initializeFromServerRevision({ asset_revision_id: 'asset', ontology_version_id: 'ontology', annotation_revision_id: 'base', generation: 0, document });
    const before = saves.toRecord('asset');
    expect(saves.adoptImportReceipt({ ...receipt, parent_revision_id: 'another-base' }, 'base')).toBe(false);
    expect(saves.adoptImportReceipt({ ...receipt, document: { ...receipt.document, ontology_version_id: 'another-ontology' } }, 'base')).toBe(false);
    expect(saves.toRecord('asset')).toEqual(before);
  });
});
