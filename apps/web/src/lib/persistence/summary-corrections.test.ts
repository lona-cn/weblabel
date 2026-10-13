import { expect, it } from 'vitest';
import { admitRawDraft, InMemoryDraftStorage } from './draft-store';
import { SaveQueue } from './save-queue';
import type { AnnotationDocument } from './types';
const document: AnnotationDocument = { schema_version: 1, asset_revision_id: 'asset', ontology_version_id: 'ontology', coordinate_space: { type: 'canonical_image_pixels', width: 640, height: 480 }, completion: 'in_progress', objects: [] };
it.each([false, true])('retains proven branch identity after ACK with local commit failure=%s', async failure => {
  const storage = new InMemoryDraftStorage();
  const put = storage.put.bind(storage);
  storage.put = async (row, guard) => {
    const raw = row.record;
    admitRawDraft(raw, 'asset');
    if (failure && raw.synced_generation === 1) throw new Error('quota');
    return put(row, guard);
  };
  const queue = new SaveQueue({ storage, debounceMs: 60000, owner: { token: {}, actor_id: 'actor', project_id: 'project', isCurrent: () => true, isWritable: () => true, canPrepareOperation: () => true, getLease: () => null }, transport: {
    async save(request) { return { operation_id: request.operation_id, idempotent_replay: false, revision: { annotation_revision_id: 'ack', parent_revision_id: 'base', revision_no: 2, document: request.document, created_at: '2026-10-13T00:00:00Z', created_by: 'actor', content_hash: 'hash' } }; },
    async fetchHead() { return null; }, async fetchRevision() { throw new Error('Unexpected read'); },
  } });
  queue.enqueue({ asset_revision_id: 'asset', ontology_version_id: 'ontology', base_revision_id: 'base', generation: 1, document });
  await queue.whenPersisted('asset');
  const id = queue.getOwnedSummary('asset', 'project', 'actor')!.draft_id;
  await queue.flush('asset');
  expect(queue.toRecord('asset')!.draft_owner).toBeNull();
  expect(queue.getOwnedSummary('asset', 'project', 'actor')).toEqual({ draft_id: id, pending: false, failed: failure });
  expect(queue.getOwnedSummary('asset', 'project', 'other')).toBeNull();
  const disk = (await storage.get('asset', id))!.record;
  admitRawDraft(disk, 'asset');
  expect(disk.pending === null).toBe(!failure);
  expect(!!queue.getStatus('asset').local_commit).toBe(!failure);
});
