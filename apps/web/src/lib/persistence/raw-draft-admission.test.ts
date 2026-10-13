import { describe, expect, it, vi } from 'vitest';
import { locateOntology } from '../../features/workbench/fixed-ontology';
import { DraftStore, InMemoryDraftStorage } from './draft-store';
import { SaveQueue } from './save-queue';
import type { AnnotationDocument, DraftRecord, SaveTransport } from './types';

const ASSET = 'asset-raw-admission';
const ONTOLOGY = 'ontology-raw-admission';
const AT = '2026-10-10T00:00:00.000Z';
const AUTHOR = { actor_id: 'actor-raw', project_id: 'project-raw' };

function document(): AnnotationDocument {
  return {
    schema_version: 1, asset_revision_id: ASSET, ontology_version_id: ONTOLOGY,
    coordinate_space: { type: 'canonical_image_pixels', width: 640, height: 480 },
    completion: 'in_progress',
    objects: [{
      object_id: 'person-raw', label_id: 'person',
      geometry: { type: 'bbox_xyxy', x_min: 10, y_min: 20, x_max: 110, y_max: 220 },
      attributes: { helmet_state: 'unknown' },
      origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null },
    }],
  };
}

function record(): DraftRecord {
  return {
    schema_version: 1, asset_revision_id: ASSET, ontology_version_id: ONTOLOGY,
    base_revision_id: 'base-raw', generation: 4, synced_generation: 4,
    document: document(), pending: null, intent_journal: [], synced_intent_seq: 0,
    draft_owner: { ...AUTHOR }, pending_owner: null, edit_seq: 4,
    used_operation_ids: [], updated_at: AT,
  };
}

function pendingRecord(): DraftRecord {
  const raw = record();
  raw.generation = 5;
  raw.edit_seq = 5;
  raw.pending_owner = { ...AUTHOR };
  raw.pending = {
    operation_id: 'operation-raw', generation: 5, edit_seq: 5, journal_seq_end: 0,
    prepared_at: AT,
    request: {
      operation_id: 'operation-raw', base_revision_id: 'base-raw', document: document(),
      lease: { task_id: 'task-raw', fencing_token: 1 }, suggestion_decisions: [],
    },
  };
  raw.used_operation_ids = ['operation-raw'];
  return raw;
}

function journalRecord(): DraftRecord {
  const raw = record();
  raw.generation = 5;
  raw.intent_journal = [{
    seq: 1, generation: 5, recorded_at: AT,
    intent: { suggestion_set_id: 'suggestion-raw', change_ids: ['change-raw'], decision: 'accept' },
  }];
  return raw;
}

function fixture(storage = new InMemoryDraftStorage()) {
  const save = vi.fn<SaveTransport['save']>().mockRejectedValue(new Error('Unexpected remote write'));
  const transport: SaveTransport = {
    save,
    fetchHead: async () => { throw new Error('Unexpected remote head read'); },
    fetchRevision: async () => { throw new Error('Unexpected remote revision read'); },
  };
  const owner = {
    token: {}, ...AUTHOR, isCurrent: () => true, isWritable: () => true,
    canPrepareOperation: () => true,
    getLease: () => ({ task_id: 'task-raw', fencing_token: 1 }),
  };
  return { queue: new SaveQueue({ storage, transport, owner }), storage, save };
}

function branch(record: DraftRecord) { return { asset_revision_id: record.asset_revision_id, draft_id: 'source', write_token: 'source-token', record, sources: [] }; }
async function seedBranch(storage: InMemoryDraftStorage, record: DraftRecord) { const envelope = branch(record); await storage.put(envelope); return envelope; }

// Deliberately cross the same JSON serialization boundary as browser storage.
// The cast represents untrusted disk input, not a valid DraftRecord producer.
function unsupported(schema: unknown): DraftRecord {
  return { ...record(), schema_version: schema } as unknown as DraftRecord;
}

type InvalidCase = { name: string; make: () => DraftRecord };
function changed(name: string, mutate: (raw: DraftRecord) => void, make = record): InvalidCase {
  return { name, make: () => { const raw = make(); mutate(raw); return raw; } };
}

const invalidCases: InvalidCase[] = [
  { name: 'future record schema', make: () => unsupported(2) },
  { name: 'missing record schema', make: () => unsupported(undefined) },
  { name: 'string record schema', make: () => unsupported('1') },
  changed('negative generation', (raw) => { raw.generation = -1; }),
  changed('fractional generation', (raw) => { raw.generation = 4.5; }),
  changed('unsafe generation', (raw) => { raw.generation = Number.MAX_SAFE_INTEGER + 1; }),
  changed('negative synced generation', (raw) => { raw.synced_generation = -1; }),
  changed('synced generation ahead of local', (raw) => { raw.synced_generation = 5; }),
  changed('negative edit sequence', (raw) => { raw.edit_seq = -1; }),
  changed('synced intent boundary beyond journal', (raw) => { raw.synced_intent_seq = 1; }),
  changed('fractional synced intent boundary', (raw) => { raw.synced_intent_seq = 0.5; }),
  changed('missing journal', (raw) => { delete (raw as Partial<DraftRecord>).intent_journal; }),
  changed('journal entry generation ahead of local', (raw) => { raw.intent_journal[0].generation = 6; }, journalRecord),
  changed('negative journal sequence', (raw) => { raw.intent_journal[0].seq = -1; }, journalRecord),
  changed('duplicate journal sequence', (raw) => { raw.intent_journal.push({ ...raw.intent_journal[0] }); }, journalRecord),
  changed('invalid journal decision', (raw) => { Object.assign(raw.intent_journal[0].intent, { decision: 'publish' }); }, journalRecord),
  changed('non-array operation history', (raw) => { Object.assign(raw, { used_operation_ids: 7 }); }),
  changed('future document schema', (raw) => { Object.assign(raw.document, { schema_version: 2 }); }),
  changed('document asset mismatch', (raw) => { raw.document.asset_revision_id = 'another-asset'; }),
  changed('document ontology mismatch', (raw) => { raw.document.ontology_version_id = 'another-ontology'; }),
  changed('zero canonical width', (raw) => { raw.document.coordinate_space.width = 0; }),
  changed('unknown geometry discriminant', (raw) => { Object.assign(raw.document.objects[0].geometry, { type: 'polygon' }); }),
  changed('non-scalar attribute', (raw) => { Object.assign(raw.document.objects[0].attributes, { helmet_state: { nested: true } }); }),
  changed('confirmed negative with objects', (raw) => { raw.document.completion = 'confirmed_negative'; }),
  changed('missing origin field', (raw) => { delete (raw.document.objects[0].origin as Partial<AnnotationDocument['objects'][number]['origin']>).prediction_id; }),
  changed('pending generation ahead of local', (raw) => { raw.pending!.generation = 6; }, pendingRecord),
  changed('pending edit sequence ahead of local', (raw) => { raw.pending!.edit_seq = 6; }, pendingRecord),
  changed('pending journal boundary beyond journal', (raw) => { raw.pending!.journal_seq_end = 1; }, pendingRecord),
  changed('pending operation identity mismatch', (raw) => { raw.pending!.request.operation_id = 'another-operation'; }, pendingRecord),
  changed('pending base identity mismatch', (raw) => { raw.pending!.request.base_revision_id = 'another-base'; }, pendingRecord),
  changed('pending document identity mismatch', (raw) => { raw.pending!.request.document.asset_revision_id = 'another-asset'; }, pendingRecord),
  changed('pending malformed payload', (raw) => { Object.assign(raw.pending!.request, { suggestion_decisions: null }); }, pendingRecord),
];

describe('C-RAW-01 raw draft admission', () => {
  it.each(invalidCases)('rejects $name without installing, certifying or rewriting the serialized rescue record', async ({ make }) => {
    const raw = Object.assign(make(), { future_metadata: { original_format: 'future-owned', opaque: ['retain', { version: 2 }] } });
    const { queue, storage, save } = fixture();
    await storage.put(branch(raw));
    const original = JSON.stringify(await storage.get(ASSET, 'source'));
    const loaded = await new DraftStore(storage).load(ASSET, 'source');
    expect(loaded).not.toBeNull();
    storage.log.length = 0;
    let rejection: unknown;
    try { await queue.forkFromRecord(loaded!); } catch (error) { rejection = error; }
    await queue.whenPersisted(ASSET);
    await queue.flush(ASSET);
    await queue.retry(ASSET);
    expect.soft(rejection).toBeInstanceOf(Error);
    expect.soft(queue.toRecord(ASSET)).toBeNull();
    expect.soft(queue.getStatus(ASSET).local_commit ?? null).toBeNull();
    expect.soft(queue.canRetryRetained(ASSET, () => true)).toBe(false);
    expect.soft(save.mock.calls).toEqual([]);
    expect.soft(storage.log.filter((entry) => entry.method !== 'get')).toEqual([]);
    // This is also the full-raw rescue payload, including unknown future fields.
    expect(JSON.stringify(await new DraftStore(storage).load(ASSET, 'source'))).toBe(original);
    expect(JSON.stringify(loaded)).toBe(original);
    expect(Object.isFrozen((loaded!.record as DraftRecord).document)).toBe(false);
  });

  it.each(invalidCases)('rejects $name before selecting an ontology', ({ make }) => {
    const raw = make();
    const before = JSON.stringify(raw);
    expect(() => locateOntology(ASSET, ONTOLOGY, null, raw)).toThrow();
    expect(JSON.stringify(raw)).toBe(before);
    expect(Object.isFrozen(raw.document)).toBe(false);
  });

  it('does not pause or rewrite existing clean authority when an invalid restore requests a pause', async () => {
    const { queue, storage } = fixture();
    await queue.forkFromRecord(await seedBranch(storage, record()));
    await queue.whenPersisted(ASSET);
    const commit = queue.getStatus(ASSET).local_commit;
    storage.log.length = 0;
    await expect(queue.forkFromRecord(branch(unsupported(2)), { pauseForUserChoice: true })).rejects.toThrow();
    await queue.whenPersisted(ASSET);
    expect(queue.getStatus(ASSET).local_commit).toEqual(commit);
    expect(queue.getStatus(ASSET).writes_paused).toBe(false);
    expect(storage.log).toEqual([]);
  });

  it.each([0, Number.MAX_SAFE_INTEGER])('accepts a clean schema-1 record at safe counter boundary %s', async (generation) => {
    const raw = record();
    raw.generation = generation;
    raw.synced_generation = generation;
    raw.edit_seq = generation;
    const { queue, storage } = fixture();
    expect(locateOntology(ASSET, null, null, raw)).toEqual({ ontologyId: ONTOLOGY, conflict: false });
    await queue.forkFromRecord(await seedBranch(storage, raw));
    await queue.whenPersisted(ASSET);
    expect(queue.toRecord(ASSET)?.document).toEqual(raw.document);
    expect(queue.getStatus(ASSET).dirty).toBe(false);
    expect(queue.getStatus(ASSET).local_commit).toMatchObject({ generation, edit_seq: generation });
  });

  it('retains readable legacy schema-1 dirty work without inventing an author or remote authority', async () => {
    const raw = journalRecord();
    delete raw.draft_owner;
    delete raw.pending_owner;
    delete raw.edit_seq;
    delete raw.used_operation_ids;
    const { queue, storage, save } = fixture();
    await queue.forkFromRecord(await seedBranch(storage, raw));
    await queue.whenPersisted(ASSET);
    await queue.flush(ASSET);
    await queue.retry(ASSET);
    expect(queue.toRecord(ASSET)?.document).toEqual(raw.document);
    expect(queue.toRecord(ASSET)?.intent_journal).toEqual(raw.intent_journal);
    expect(queue.toRecord(ASSET)?.draft_owner ?? null).toBeNull();
    expect(queue.getStatus(ASSET)).toMatchObject({ dirty: true, writes_paused: true });
    expect(queue.canRetryRetained(ASSET, () => true)).toBe(false);
    expect(save.mock.calls).toEqual([]);
  });

  it('retains legacy pending payload lacking additive outcome, edit and operation history fields without replaying it', async () => {
    const raw = pendingRecord();
    delete raw.draft_owner;
    delete raw.pending_owner;
    delete raw.edit_seq;
    delete raw.used_operation_ids;
    delete (raw.pending as Partial<NonNullable<DraftRecord['pending']>>).edit_seq;
    const { queue, storage, save } = fixture();
    await queue.forkFromRecord(await seedBranch(storage, raw));
    await queue.whenPersisted(ASSET);
    await queue.retry(ASSET);
    expect(queue.toRecord(ASSET)?.pending?.request).toEqual(raw.pending?.request);
    expect(queue.toRecord(ASSET)?.pending_outcome).toBe('unknown');
    expect(queue.getStatus(ASSET)).toMatchObject({ dirty: true, writes_paused: true });
    expect(queue.canRetryRetained(ASSET, () => true)).toBe(false);
    expect(save.mock.calls).toEqual([]);
  });
});
