import { describe, expect, it } from 'vitest';
import { DraftStore, InMemoryDraftStorage, IndexedDbDraftStorage } from './draft-store';
import { SaveQueue } from './save-queue';
import type {
  AnnotationDocument, AnnotationRevision, Clock, DraftRecord, DraftStorage, DraftBranchEnvelope,
  SaveRequest, SaveResponse, SaveTransport, SuggestionDecisionIntent, SaveQueueOwner,
} from './types';
async function seedBranch(storage: DraftStorage, record: DraftRecord) {
  const envelope = { asset_revision_id: record.asset_revision_id, draft_id: crypto.randomUUID(), write_token: crypto.randomUUID(), record, sources: [] };
  await storage.put(envelope);
  return envelope;
}

const ASSET = 'asset-owner';
const AT = '2026-10-10T00:00:00.000Z';
const ACCEPT: SuggestionDecisionIntent = {
  suggestion_set_id: 'suggestion-owner', change_ids: ['change-person'], decision: 'accept',
};
const REVERT: SuggestionDecisionIntent = { ...ACCEPT, decision: 'revert' };

function document(generation: number): AnnotationDocument {
  return {
    schema_version: 1, asset_revision_id: ASSET, ontology_version_id: 'ontology-owner',
    coordinate_space: { type: 'canonical_image_pixels', width: 640, height: 480 },
    completion: 'in_progress',
    objects: [{
      object_id: 'person-owner', label_id: 'person',
      geometry: { type: 'bbox_xyxy', x_min: generation, y_min: 20, x_max: 110, y_max: 220 },
      attributes: { helmet_state: 'unknown' },
      origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null },
    }],
  };
}

function record(generation: number): DraftRecord {
  return {
    schema_version: 1, asset_revision_id: ASSET, ontology_version_id: 'ontology-owner',
    base_revision_id: 'base-owner', generation, document: document(generation), pending: null,
    intent_journal: [{ seq: 1, generation, intent: ACCEPT, recorded_at: AT }],
    synced_generation: 0, synced_intent_seq: 0, updated_at: AT,
  };
}
function payloadOf(value: DraftRecord | null) {
  if (!value) return value;
  const { updated_at: _clockTimestamp, ...payload } = value;
  return payload;
}


function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function drain() {
  for (let index = 0; index < 40; index += 1) await Promise.resolve();
}

class ManualClock implements Clock {
  private time = Date.parse(AT);
  private id = 0;
  private timers = new Map<number, { at: number; run: () => void }>();
  now() { return this.time; }
  setTimeout(run: () => void, delay: number) {
    const id = ++this.id;
    this.timers.set(id, { at: this.time + delay, run });
    return id;
  }
  clearTimeout(id: unknown) { this.timers.delete(id as number); }
  advance(ms: number) {
    this.time += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.time) { this.timers.delete(id); timer.run(); }
    }
  }
}

class HeldTransport implements SaveTransport {
  readonly requests: Array<{ asset: string; request: SaveRequest }> = [];
  readonly reply = deferred<SaveResponse>();
  save(request: SaveRequest, asset: string) {
    this.requests.push({ asset, request: JSON.parse(JSON.stringify(request)) as SaveRequest });
    return this.reply.promise;
  }
  async fetchHead(): Promise<AnnotationRevision | null> { return null; }
  async fetchRevision(): Promise<AnnotationRevision> { throw new Error('Unexpected revision read'); }
}

function fixture(storage: DraftStorage = new InMemoryDraftStorage()) {
  const clock = new ManualClock();
  const transport = new HeldTransport();
  let current = true;
  let writable = true;
  let leaseRead = () => {};
  const owner: SaveQueueOwner = {
    token: {}, actor_id: 'actor-old', project_id: 'project-old',
    isCurrent: () => current, isWritable: () => writable,
    canPrepareOperation: () => true, getLease: (_asset: string): SaveRequest['lease'] => {
      leaseRead();
      return { task_id: 'task-old', fencing_token: 41 };
    },
  };
  let operationSequence = 0;
  const options = {
    storage, transport, clock, owner,
    newOperationId: () => ++operationSequence === 1 ? 'operation-owner' : `operation-owner-${operationSequence}`,
  };
  const queue = new SaveQueue(options);
  return {
    queue, clock, transport, storage, owner,
    expire: () => { current = false; },
    revokeWrite: () => { writable = false; },
    expireOnLeaseRead: () => { leaseRead = () => { current = false; }; },
  };
}

function edit(queue: SaveQueue, generation = 1, intents = [ACCEPT, REVERT]) {
  queue.enqueue({
    asset_revision_id: ASSET, ontology_version_id: 'ontology-owner', base_revision_id: 'base-owner',
    generation, document: document(generation), suggestion_decisions: intents,
  });
}

function ack(): SaveResponse {
  return {
    operation_id: 'operation-owner', idempotent_replay: false,
    revision: {
      annotation_revision_id: 'revision-old-owner', parent_revision_id: 'base-owner',
      revision_no: 2, document: document(1), created_at: AT, created_by: 'actor-old',
      content_hash: 'hash-old-owner',
    },
  };
}
function retainedOwnerRecord(): DraftRecord {
  const result = record(1);
  result.draft_owner = { actor_id: 'actor-old', project_id: 'project-old' };
  result.pending_owner = { ...result.draft_owner };
  result.writes_paused = true;
  result.pending_outcome = 'rejected';
  result.save_error = { kind: 'http', code: 'PENDING_OWNER_MISMATCH', message: 'rescue retained', status: null, request_id: null };
  result.pending = { operation_id: 'operation-owner', generation: 1, journal_seq_end: 1, edit_seq: 1, prepared_at: AT,
    request: { operation_id: 'operation-owner', base_revision_id: 'base-owner', document: document(1), lease: null, suggestion_decisions: [ACCEPT] } };
  result.edit_seq = 1;
  return result;
}

describe('C07 read-only retained retry eligibility', () => {
  it.each(['unknown', 'rejected'] as const)('original no-held %s request ignores old owner diagnosis without permitting fresh work', async (outcome) => {
    const f = fixture();
    f.owner.canPrepareOperation = () => false;
    f.owner.getLease = () => { throw new Error('retained query must not read a fresh lease'); };
    const original = retainedOwnerRecord();
    original.pending_outcome = outcome;
    await f.queue.forkFromRecord(await seedBranch(f.storage, original));
    await f.queue.whenPersisted(ASSET);
    const status = f.queue.getStatus(ASSET);
    const before = f.queue.toRecord(ASSET);
    const durable = ((await f.storage.get(ASSET, f.queue.getDraftBranchSnapshot(ASSET)!.envelope.draft_id))?.record as DraftRecord | null);
    expect(f.queue.canRetryRetained(ASSET, () => true)).toBe(true);
    expect(f.queue.getStatus(ASSET)).toBe(status);
    expect(f.queue.toRecord(ASSET)).toEqual(before);
    expect(((await f.storage.get(ASSET, f.queue.getDraftBranchSnapshot(ASSET)!.envelope.draft_id))?.record as DraftRecord | null)).toEqual(durable);
    const replay = f.queue.retry(ASSET, () => true);
    await drain();
    expect(f.transport.requests).toEqual([{ asset: ASSET, request: original.pending!.request }]);
    f.transport.reply.resolve(ack());
    await replay;
    await f.queue.whenPersisted(ASSET);
    expect(f.queue.canRetryRetained(ASSET, () => true)).toBe(false);
    edit(f.queue, 2);
    f.clock.advance(5000);
    await drain();
    expect(f.transport.requests).toHaveLength(1);
  });

  it.each(['draft-author', 'pending-author', 'project', 'epoch', 'writable', 'new-ticket', 'absent'] as const)(
    'rejects a retained request with invalid %s without changing its diagnosis', async (mode) => {
      const f = fixture();
      const original = retainedOwnerRecord();
      if (mode === 'draft-author') original.draft_owner!.actor_id = 'foreign';
      if (mode === 'pending-author') original.pending_owner!.actor_id = 'foreign';
      if (mode === 'project') original.pending_owner!.project_id = 'foreign';
      if (mode === 'absent') original.pending = null;
      await f.queue.forkFromRecord(await seedBranch(f.storage, original));
      await f.queue.whenPersisted(ASSET);
      if (mode === 'epoch') f.expire();
      if (mode === 'writable') f.revokeWrite();
      const before = f.queue.toRecord(ASSET);
      expect(f.queue.canRetryRetained(ASSET, () => mode !== 'new-ticket')).toBe(false);
      expect(f.queue.toRecord(ASSET)).toEqual(before);
      expect(f.transport.requests).toEqual([]);
    });

  it('fork preserves prepared outcome and does not lend never-dispatched payload retained-retry permission', async () => {
    const f = fixture();
    f.owner.canPrepareOperation = () => false;
    f.owner.getLease = () => { throw new Error('No fresh send permission exists'); };
    const original = retainedOwnerRecord();
    original.pending_outcome = 'prepared';
    original.save_error = null;
    const source = await seedBranch(f.storage, original);
    expect(await f.queue.forkFromRecord(source)).toBe(true);
    const fork = f.queue.getDraftBranchSnapshot(ASSET)!;
    expect(fork.envelope.draft_id).not.toBe(source.draft_id);
    expect(f.queue.toRecord(ASSET)).toMatchObject({ pending_outcome: 'prepared', pending: original.pending, pending_owner: original.pending_owner, used_operation_ids: expect.arrayContaining([original.pending!.operation_id]) });
    expect(f.queue.canRetryRetained(ASSET, () => true)).toBe(false);
    await f.queue.retry(ASSET, () => true);
    expect(f.transport.requests).toEqual([]);
    expect((await f.storage.get(ASSET, source.draft_id))!.record).toEqual(original);
    expect((await f.storage.get(ASSET, fork.envelope.draft_id))!.record).toMatchObject({ pending_outcome: 'prepared', pending: original.pending });
  });
  it('does not offer a never-dispatched prepared body or paused future as retained retry', async () => {
    const f = fixture();
    edit(f.queue);
    expect(f.queue.canRetryRetained(ASSET, () => true)).toBe(false);
    const stop = f.queue.subscribe(ASSET, () => {
      if (f.queue.getStatus(ASSET).saving) f.owner.canPrepareOperation = () => false;
    });
    try {
      f.clock.advance(5000);
      await drain();
      await f.queue.whenPersisted(ASSET);
      expect(f.queue.toRecord(ASSET)).toMatchObject({ pending_outcome: 'prepared', pending: { operation_id: 'operation-owner' } });
      expect(f.queue.canRetryRetained(ASSET, () => true)).toBe(false);
      expect(f.transport.requests).toEqual([]);
    } finally { stop(); }
    const future = fixture();
    await future.queue.forkFromRecord(await seedBranch(future.storage, ownedFutureRecord()));
    await future.queue.whenPersisted(ASSET);
    expect(future.queue.canRetryRetained(ASSET, () => true)).toBe(false);
  });
});

describe('C07 retained replay installation boundaries', () => {
  it.each(['current', 'writable', 'scope'] as const)('raw %s expiry withdraws public certificate before layout revoke and cannot revive it', async (mode) => {
    let current = true;
    let writable = true;
    let scopeCurrent = true;
    const storage = new InMemoryDraftStorage();
    const transport = new HeldTransport();
    const queue = new SaveQueue({ storage, transport, clock: new ManualClock(),
      owner: { token: {}, actor_id: 'actor-old', project_id: 'project-old',
        isCurrent: () => current && scopeCurrent, isWritable: () => writable, canPrepareOperation: () => true, getLease: () => null } });
    await queue.forkFromRecord(await seedBranch(storage, retainedOwnerRecord()));
    await queue.whenPersisted(ASSET);
    expect(queue.getStatus(ASSET).local_commit).not.toBeNull();
    const rescue = queue.exportDraft(ASSET)!;
    const durable = ((await storage.get(ASSET, queue.getDraftBranchSnapshot(ASSET)!.envelope.draft_id))?.record as DraftRecord | null);
    if (mode === 'current') current = false;
    if (mode === 'writable') writable = false;
    if (mode === 'scope') scopeCurrent = false;
    const snapshot = queue.getStatus(ASSET);
    expect(snapshot.local_commit).toBeNull();
    expect(queue.getStatus(ASSET)).toBe(snapshot);
    current = writable = scopeCurrent = true;
    expect(queue.getStatus(ASSET).local_commit).toBeNull();
    expect(queue.exportDraft(ASSET)).toEqual(rescue);
    expect(((await storage.get(ASSET, queue.getDraftBranchSnapshot(ASSET)!.envelope.draft_id))?.record as DraftRecord | null)).toEqual(durable);
    expect(transport.requests).toEqual([]);
  });

  it('generic flush, switch and timer cannot dispatch known rejection', async () => {
    const f = fixture();
    await f.queue.forkFromRecord(await seedBranch(f.storage, retainedOwnerRecord()));
    f.queue.switchAsset(ASSET);
    f.queue.switchAsset('other');
    await f.queue.flush(ASSET);
    f.clock.advance(5000);
    await drain();
    expect(f.transport.requests).toEqual([]);
    expect(f.queue.exportDraft(ASSET)?.pending).toEqual(retainedOwnerRecord().pending);
  });

  it.each(['draft missing', 'pending missing', 'actor', 'project', 'readonly', 'scope'] as const)('%s cannot authorize replay or certify rescued state', async (mode) => {
    const f = fixture();
    const original = retainedOwnerRecord();
    if (mode === 'draft missing') original.draft_owner = null;
    if (mode === 'pending missing') original.pending_owner = null;
    if (mode === 'actor') original.pending_owner!.actor_id = 'actor-other';
    if (mode === 'project') original.draft_owner!.project_id = 'project-other';
    if (mode === 'readonly') f.revokeWrite();
    await f.queue.forkFromRecord(await seedBranch(f.storage, original));
    await f.queue.retry(ASSET, () => mode !== 'scope');
    expect(f.transport.requests).toEqual([]);
    expect(f.queue.exportDraft(ASSET)?.pending).toEqual(original.pending);
    if (mode !== 'scope') expect(f.queue.getStatus(ASSET).local_commit).toBeNull();
  });

  it.each(['owner', 'role', 'scope'] as const)('late %s expiry prevents ACK and durable certification under replacement authorization', async (mode) => {
    const f = fixture();
    await f.queue.forkFromRecord(await seedBranch(f.storage, retainedOwnerRecord()));
    await f.queue.whenPersisted(ASSET);
    let scopeCurrent = true;
    const replay = f.queue.retry(ASSET, () => scopeCurrent);
    await drain();
    expect(f.transport.requests).toHaveLength(1);
    expect(f.queue.getStatus(ASSET).writes_paused).toBe(true);
    if (mode === 'owner') f.queue.setWriteOwner({ ...f.owner, token: {} });
    if (mode === 'role') f.revokeWrite();
    if (mode === 'scope') scopeCurrent = false;
    const before = f.queue.exportDraft(ASSET)!;
    f.transport.reply.resolve(ack());
    await replay;
    expect(f.queue.toRecord(ASSET)).toMatchObject({ pending: before.pending, base_revision_id: before.base_revision_id, synced_generation: 0 });
    expect(f.queue.getStatus(ASSET).writes_paused).toBe(true);
    expect(f.queue.getStatus(ASSET).last_ack).toBeNull();
  });
});

// A storage boundary with a genuinely active old write. New writes can commit
// before it unless DraftStore serializes the shared storage + asset lane.
class ActiveWriteStorage extends InMemoryDraftStorage {
  readonly entered = deferred<void>();
  readonly release = deferred<void>();
  readonly events: string[] = [];
  override async put(value: DraftBranchEnvelope, guard: () => boolean = () => true) {
    const generation = (value.record as DraftRecord).generation;
    this.events.push('start:' + generation);
    if (generation === 1) { this.entered.resolve(); await this.release.promise; }
    const receipt = await super.put(value, guard);
    this.events.push('commit:' + generation);
    return receipt;
  }
  override async get(asset: string, draft: string, guard: () => boolean = () => true) {
    this.events.push('read'); return super.get(asset, draft, guard);
  }
}

// The open request is held at the IDB boundary; production put must recheck its
// guard after open succeeds and before starting a transaction.
class HeldOpenFactory {
  readonly opened = deferred<void>();
  readonly events: string[] = [];
  private request!: IDBOpenDBRequest;
  private stored: DraftBranchEnvelope | null = null;
  readonly factory = {
    open: () => {
      this.events.push('open');
      this.request = { onsuccess: null, onerror: null, onupgradeneeded: null } as unknown as IDBOpenDBRequest;
      this.opened.resolve();
      return this.request;
    },
  } as unknown as IDBFactory;
  finishOpen() {
    const database = {
      close: () => { this.events.push('close'); },
      transaction: (_name: string, mode: string) => {
        this.events.push(`transaction:${mode}`);
        const tx = {
          oncomplete: null as null | (() => void), onabort: null, onerror: null, error: null,
          objectStore: () => ({
            put: (value: DraftBranchEnvelope) => {
              this.events.push('put');
              this.stored = structuredClone(value);
              queueMicrotask(() => tx.oncomplete?.());
              return {} as IDBRequest;
            },
          }),
        };
        return tx;
      },
    } as unknown as IDBDatabase;
    Object.assign(this.request, { result: database });
    this.request.onsuccess?.call(this.request, new Event('success'));
  }
  durableRecord() { return this.stored; }
}

describe('owner lifetime at real save consumers', () => {
  it('expired owner blocks the automatic timer without losing the ordered draft journal', async () => {
    const f = fixture();
    edit(f.queue);
    await drain();
    const before = f.queue.toRecord(ASSET);
    expect(before).toMatchObject({ document: document(1), intent_journal: [
      { seq: 1, generation: 1, intent: ACCEPT, recorded_at: AT },
      { seq: 2, generation: 1, intent: REVERT, recorded_at: AT },
    ] });
    f.expire();
    f.clock.advance(400);
    await drain();
    expect.soft(f.transport.requests).toEqual([]);
    expect.soft(payloadOf(f.queue.toRecord(ASSET))).toEqual(payloadOf(before));
    expect.soft(((await new DraftStore(f.storage).load(ASSET, f.queue.getDraftBranchSnapshot(ASSET)!.envelope.draft_id))?.record as DraftRecord | null)).toEqual(before);
  });

  it('write authority revoked before explicit send preserves the complete unsent payload', async () => {
    const f = fixture();
    edit(f.queue);
    await drain();
    const before = f.queue.toRecord(ASSET);
    f.revokeWrite();
    // Do not await a possibly unsafe baseline HTTP request: its ACK is held.
    void f.queue.flush(ASSET);
    await drain();
    expect.soft(f.transport.requests).toEqual([]);
    expect.soft(f.queue.toRecord(ASSET)).toEqual(before);
    expect.soft(((await new DraftStore(f.storage).load(ASSET, f.queue.getDraftBranchSnapshot(ASSET)!.envelope.draft_id))?.record as DraftRecord | null)).toEqual(before);
  });

  it('owner revoked while obtaining a lease is checked again before HTTP dispatch', async () => {
    const f = fixture();
    edit(f.queue);
    await drain();
    const before = f.queue.toRecord(ASSET);
    f.expireOnLeaseRead();
    void f.queue.flush(ASSET);
    await drain();
    expect.soft(f.transport.requests).toEqual([]);
    // A prepared operation may remain, but its original journal/document/base
    // must remain recoverable and may not be marked acknowledged.
    expect.soft(f.queue.toRecord(ASSET)).toMatchObject({
      base_revision_id: before!.base_revision_id, document: before!.document,
      intent_journal: before!.intent_journal, synced_generation: 0, synced_intent_seq: 0,
    });
  });

  it('late ACK from an expired owner cannot move base or acknowledge any pending journal', async () => {
    const f = fixture();
    edit(f.queue);
    const sending = f.queue.flush(ASSET);
    await drain();
    const pending = f.queue.toRecord(ASSET);
    expect(pending?.pending).toMatchObject({
      operation_id: 'operation-owner', generation: 1, journal_seq_end: 2, edit_seq: 1,
      request: { base_revision_id: 'base-owner', document: document(1), suggestion_decisions: [ACCEPT, REVERT] },
    });
    expect(pending?.pending_outcome).toBe('unknown');
    edit(f.queue, 2, [REVERT]);
    await drain();
    const beforeAck = f.queue.toRecord(ASSET);
    f.expire();
    f.transport.reply.resolve(ack());
    await sending;
    await drain();
    expect.soft(f.queue.toRecord(ASSET)).toEqual(beforeAck);
    expect.soft(((await new DraftStore(f.storage).load(ASSET, f.queue.getDraftBranchSnapshot(ASSET)!.envelope.draft_id))?.record as DraftRecord | null)).toEqual(beforeAck);
    expect.soft(f.queue.getStatus(ASSET)).toMatchObject({
      dirty: true, base_revision_id: 'base-owner', synced_generation: 0, last_ack: null,
    });
    expect.soft(f.transport.requests.map(({ asset, request }) => ({ asset, operation: request.operation_id })))
      .toEqual([{ asset: ASSET, operation: 'operation-owner' }]);
  });

  it('two DraftStore consumers drain the old active transaction before new write and read', async () => {
    const storage = new ActiveWriteStorage();
    const oldStore = new DraftStore(storage);
    const newStore = new DraftStore(storage);
    const oldRecord = record(1);
    const newRecord = record(2);
    const oldWrite = oldStore.save({ asset_revision_id: oldRecord.asset_revision_id, draft_id: 'fixture', write_token: '', record: oldRecord, sources: [] });
    await storage.entered.promise;
    const newWrite = newStore.save({ asset_revision_id: newRecord.asset_revision_id, draft_id: 'fixture', write_token: '', record: newRecord, sources: [] });
    let readSettled = false;
    const read = newStore.load(ASSET, 'fixture').then(row => row?.record ?? null).then((value) => { readSettled = true; return value; });
    await drain();
    const settledBeforeDrain = readSettled;
    const eventsBeforeDrain = [...storage.events];
    storage.release.resolve();
    await Promise.all([oldWrite, newWrite]);
    const observed = await read;
    expect.soft(settledBeforeDrain).toBe(false);
    expect.soft(eventsBeforeDrain).toEqual(['start:1']);
    expect.soft(observed).toEqual(newRecord);
    expect.soft(storage.events).toEqual(['start:1', 'commit:1', 'start:2', 'commit:2', 'read']);
    expect.soft(await oldStore.load(ASSET, 'fixture').then(row => row?.record ?? null)).toEqual(newRecord);
  });

  it('owner invalidated after IDB open starts cannot put or certify local_commit', async () => {
    const idb = new HeldOpenFactory();
    const f = fixture(new IndexedDbDraftStorage(idb.factory));
    edit(f.queue);
    await idb.opened.promise;
    const memory = f.queue.toRecord(ASSET);
    f.expire();
    idb.finishOpen();
    await drain();
    expect.soft(idb.events).toEqual(['open', 'close']);
    expect.soft(idb.durableRecord()).toBeNull();
    expect.soft(f.queue.getStatus(ASSET).local_commit).toBeNull();
    expect.soft(f.queue.toRecord(ASSET)).toEqual(memory);
    expect.soft(f.transport.requests).toEqual([]);
  });
});

function nextOwner(owner: SaveQueueOwner, actor = owner.actor_id): SaveQueueOwner {
  return { ...owner, token: {}, actor_id: actor, isCurrent: () => true, isWritable: () => true,
    canPrepareOperation: () => true, getLease: () => ({ task_id: 'task-new', fencing_token: 99 }) };
}

describe('owner handoff preserves unconfirmed identity', () => {
  it('same actor new mount requires explicit replay with original operation and original lease', async () => {
    const f = fixture();
    edit(f.queue);
    f.queue.switchAsset(ASSET);
    const oldRun = f.queue.flush(ASSET);
    await drain();
    const original = f.transport.requests[0].request;
    f.queue.setWriteOwner(nextOwner(f.owner));
    f.queue.switchAsset('other-image');
    f.clock.advance(800);
    await drain();
    expect(f.transport.requests).toHaveLength(1);
    const replay = f.queue.retry(ASSET);
    expect(f.transport.requests[1].request).toEqual(original);
    expect(f.queue.exportDraft(ASSET)?.pending_owner).toEqual({ actor_id: 'actor-old', project_id: 'project-old' });
    f.transport.reply.resolve(ack());
    await Promise.all([oldRun, replay]);
    expect(f.queue.getStatus(ASSET)).toMatchObject({ synced_generation: 1, base_revision_id: 'revision-old-owner', dirty: false });
  });

  it('different actor cannot replay, replace or acknowledge the old unknown operation', async () => {
    const f = fixture();
    edit(f.queue);
    const oldRun = f.queue.flush(ASSET);
    await drain();
    const original = f.queue.toRecord(ASSET)!;
    f.queue.setWriteOwner(nextOwner(f.owner, 'actor-other'));
    await f.queue.retry(ASSET);
    expect(f.transport.requests).toHaveLength(1);
    expect(f.queue.getStatus(ASSET).last_error?.code).toBe('PENDING_OWNER_MISMATCH');
    expect(await f.queue.retryRejectedLease(ASSET)).toBe(false);
    f.transport.reply.resolve(ack());
    await oldRun;
    expect(f.queue.toRecord(ASSET)).toMatchObject({ pending: original.pending, pending_owner: original.pending_owner,
      intent_journal: original.intent_journal, base_revision_id: 'base-owner', synced_generation: 0 });
  });

  it('legacy unknown without author metadata is rescue-only rather than guessed from current login', async () => {
    const source = fixture();
    edit(source.queue);
    const sending = source.queue.flush(ASSET);
    await drain();
    const legacy = JSON.parse(JSON.stringify(source.queue.toRecord(ASSET))) as DraftRecord;
    delete legacy.pending_owner;
    const restored = fixture();
    await restored.queue.forkFromRecord(await seedBranch(restored.storage, legacy));
    await restored.queue.retry(ASSET);
    expect(restored.transport.requests).toEqual([]);
    expect(restored.queue.getStatus(ASSET)).toMatchObject({ writes_paused: true, last_error: { code: 'PENDING_OWNER_UNKNOWN' } });
    expect(restored.queue.exportDraft(ASSET)).toMatchObject({ pending: legacy.pending, pending_owner: null, unsynced: true });
    source.transport.reply.resolve(ack());
    await sending;
  });

  it('old cleanup token cannot revoke the new owner and same owner image switch remains writable', async () => {
    const f = fixture();
    const owner = nextOwner(f.owner);
    f.queue.setWriteOwner(owner);
    f.queue.revokeWriteOwner(f.owner.token);
    f.queue.switchAsset(ASSET);
    edit(f.queue);
    f.queue.switchAsset('next-image');
    await drain();
    expect(f.transport.requests[0].request.lease).toEqual({ task_id: 'task-new', fencing_token: 99 });
    f.transport.reply.resolve(ack());
    await drain();
    expect(f.queue.getStatus(ASSET)).toMatchObject({ dirty: false, synced_generation: 1 });
  });

  it('queue readDraft waits for old active persistence before returning recovery data', async () => {
    const storage = new ActiveWriteStorage();
    const old = new DraftStore(storage);
    const oldWrite = old.save({ asset_revision_id: record(1).asset_revision_id, draft_id: 'fixture', write_token: '', record: record(1), sources: [] });
    await storage.entered.promise;
    const f = fixture(storage);
    let settled = false;
    const reading = f.queue.readDraftBranch(ASSET, 'fixture').then(row => row?.record ?? null).then((value) => { settled = true; return value; });
    await drain();
    expect(settled).toBe(false);
    storage.release.resolve();
    await oldWrite;
    expect(await reading).toEqual(record(1));
    expect(storage.events).toEqual(['start:1', 'commit:1', 'read']);
  });

  it('queued delete and stale queued put share the active transaction lane and read barrier', async () => {
    const storage = new ActiveWriteStorage();
    const old = new DraftStore(storage);
    const fresh = new DraftStore(storage);
    const active = old.save({ asset_revision_id: record(1).asset_revision_id, draft_id: 'fixture', write_token: '', record: record(1), sources: [] });
    await storage.entered.promise;
    let current = true;
    const skipped = old.save({ asset_revision_id: record(9).asset_revision_id, draft_id: 'fixture', write_token: '', record: record(9), sources: [] }, () => current);
    const deletion = fresh.remove(ASSET, 'fixture');
    const read = fresh.load(ASSET, 'fixture');
    current = false;
    await drain();
    expect(storage.events).toEqual(['start:1']);
    storage.release.resolve();
    await active;
    expect(await skipped).toBeNull();
    await deletion;
    expect(await read).toBeNull();
    expect(storage.events).toEqual(['start:1', 'commit:1', 'read']);
  });
});


describe('P1 dirty draft provenance before operation preparation', () => {
  it.each(['switchAsset', 'flush', 'retry'] as const)('actor B cannot resume actor A unprepared dirty via %s', async (entry) => {
    const f = fixture();
    f.queue.switchAsset(ASSET);
    edit(f.queue);
    await drain();
    const original = f.queue.toRecord(ASSET)!;
    expect(original.pending).toBeNull();
    f.queue.setWriteOwner(nextOwner(f.owner, 'actor-other'));
    if (entry === 'switchAsset') f.queue.switchAsset('next-image');
    else void f.queue[entry](ASSET);
    f.clock.advance(800);
    await drain();
    expect.soft(f.transport.requests).toEqual([]);
    expect.soft(f.queue.toRecord(ASSET)).toMatchObject({
      base_revision_id: original.base_revision_id, document: original.document,
      intent_journal: original.intent_journal, pending: null, synced_generation: 0, synced_intent_seq: 0,
    });
    expect.soft(f.queue.exportDraft(ASSET)).toMatchObject({
      unsynced: true, document: original.document, intent_journal: original.intent_journal,
      pending: null, draft_owner: { actor_id: 'actor-old', project_id: 'project-old' },
    });
    expect.soft(f.queue.getStatus(ASSET).writes_paused).toBe(true);
    // Release an unsafe baseline dispatch without hiding its failed assertions.
    f.transport.reply.resolve(ack());
    await drain();
  });

  it('legacy dirty with no author and no pending operation stays rescue-only', async () => {
    const f = fixture();
    const legacy = record(1); // Deliberately never authored by the current fixture owner.
    await f.queue.forkFromRecord(await seedBranch(f.storage, legacy));
    f.queue.switchAsset(ASSET);
    f.queue.switchAsset('next-image');
    void f.queue.flush(ASSET);
    void f.queue.retry(ASSET);
    f.clock.advance(800);
    await drain();
    expect.soft(f.transport.requests).toEqual([]);
    expect.soft(f.queue.exportDraft(ASSET)).toMatchObject({
      unsynced: true, document: legacy.document, intent_journal: legacy.intent_journal,
      base_revision_id: legacy.base_revision_id, pending: null, draft_owner: null,
    });
    expect.soft(f.queue.getStatus(ASSET).writes_paused).toBe(true);
    f.transport.reply.resolve(ack());
    await drain();
  });
});

describe('P1 owner installation lifetime and P2 local certification', () => {
  it('StrictMode revoke/reinstall of the same owner object cannot accept the prior installation ACK', async () => {
    const f = fixture();
    edit(f.queue);
    const sending = f.queue.flush(ASSET);
    await drain();
    const original = f.queue.toRecord(ASSET)!;
    f.queue.revokeWriteOwner(f.owner.token);
    f.queue.setWriteOwner(f.owner); // StrictMode effect setup reuses both object and token.
    f.transport.reply.resolve(ack());
    await sending;
    await drain();
    expect.soft(f.queue.toRecord(ASSET)).toMatchObject({
      base_revision_id: original.base_revision_id, pending: original.pending, pending_owner: original.pending_owner,
      pending_outcome: original.pending_outcome, used_operation_ids: original.used_operation_ids,
      document: original.document, intent_journal: original.intent_journal,
      synced_generation: original.synced_generation, synced_intent_seq: original.synced_intent_seq,
    });
    expect.soft(f.queue.getStatus(ASSET)).toMatchObject({
      dirty: true, base_revision_id: 'base-owner', synced_generation: 0,
      last_ack: null, local_commit: null, writes_paused: true,
    });
    expect.soft(f.queue.exportDraft(ASSET)).toMatchObject({
      pending: original.pending, pending_owner: original.pending_owner,
      document: original.document, intent_journal: original.intent_journal,
    });
    expect.soft(f.transport.requests).toHaveLength(1);
  });

  it('handoff revokes a completed local_commit certificate without deleting durable or rescue content', async () => {
    const f = fixture();
    edit(f.queue);
    await f.queue.whenPersisted(ASSET);
    expect(f.queue.getStatus(ASSET).local_commit).not.toBeNull();
    const original = f.queue.toRecord(ASSET)!;
    f.queue.setWriteOwner(nextOwner(f.owner, 'actor-other'));
    expect.soft(f.queue.getStatus(ASSET).local_commit).toBeNull();
    expect.soft(f.queue.getStatus(ASSET).writes_paused).toBe(true);
    expect.soft(f.queue.toRecord(ASSET)).toMatchObject({
      base_revision_id: original.base_revision_id, pending: original.pending,
      document: original.document, intent_journal: original.intent_journal,
      synced_generation: original.synced_generation, synced_intent_seq: original.synced_intent_seq,
    });
    expect.soft(((await new DraftStore(f.storage).load(ASSET, f.queue.getDraftBranchSnapshot(ASSET)!.envelope.draft_id))?.record as DraftRecord | null)).toEqual(original);
    expect.soft(f.queue.exportDraft(ASSET)).toMatchObject({
      document: original.document, intent_journal: original.intent_journal, pending: original.pending,
    });
    expect.soft(f.transport.requests).toEqual([]);
  });
});

// Holds the actual IDB API request and transaction callbacks independently.
// Request success is not a transaction commit: abort may still follow it.
class HeldReadonlyFactory {
  readonly entered = deferred<void>();
  readonly events: string[] = [];
  private request = { onsuccess: null, onerror: null, result: { asset_revision_id: ASSET, draft_id: 'fixture', write_token: 'fixture-token', record: record(1), sources: [] } } as unknown as IDBRequest<DraftBranchEnvelope>;
  private transaction = { oncomplete: null, onabort: null, onerror: null, error: null,
    objectStore: () => ({ get: () => { this.events.push('get'); this.entered.resolve(); return this.request; } }),
  } as unknown as IDBTransaction;
  readonly factory = {
    open: () => {
      this.events.push('open');
      const open = { onsuccess: null, onerror: null, onupgradeneeded: null,
        result: { close: () => this.events.push('close'), transaction: (_name: string, mode: string) => {
          this.events.push(mode); return this.transaction;
        } } as unknown as IDBDatabase,
      } as unknown as IDBOpenDBRequest;
      queueMicrotask(() => open.onsuccess?.call(open, new Event('success')));
      return open;
    },
  } as unknown as IDBFactory;
  requestSuccess() { this.request.onsuccess?.call(this.request, new Event('success')); }
  complete() { this.transaction.oncomplete?.call(this.transaction, new Event('complete')); }
  abort() {
    Object.assign(this.transaction, { error: new DOMException('held readonly transaction aborted', 'AbortError') });
    this.transaction.onabort?.call(this.transaction, new Event('abort'));
  }
}

describe('P2 readonly IDB transaction owns the shared recovery lane', () => {
  it.each(['complete', 'abort'] as const)('request success cannot release read or queued write before transaction %s', async (outcome) => {
    const idb = new HeldReadonlyFactory();
    const reader = new DraftStore(new IndexedDbDraftStorage(idb.factory));
    let readSettled = false;
    const reading = reader.load(ASSET, 'fixture').then(row => row?.record ?? null).then(
      (value) => { readSettled = true; return { value, error: null }; },
      (error: unknown) => { readSettled = true; return { value: null, error }; },
    );
    await idb.entered.promise;
    const storage = new InMemoryDraftStorage();
    let writeSettled = false;
    const writing = new DraftStore(storage).save({ asset_revision_id: record(2).asset_revision_id, draft_id: 'fixture', write_token: '', record: record(2), sources: [] }).then(() => { writeSettled = true; });
    idb.requestSuccess();
    await drain();
    const early = { readSettled, writeSettled, events: [...idb.events], writes: [...storage.log] };
    idb[outcome]();
    const result = await reading;
    await writing;
    expect.soft(early).toEqual({ readSettled: false, writeSettled: false, events: ['open', 'readonly', 'get'], writes: [] });
    if (outcome === 'abort') {
      expect.soft(result.value).toBeNull();
      expect.soft(result.error).toMatchObject({ code: 'STORAGE_FAILED' });
    } else {
      expect.soft(result.error).toBeNull();
      expect.soft(result.value).toEqual(record(1));
    }
    expect.soft(await new DraftStore(storage).load(ASSET, 'fixture').then(row => row?.record ?? null)).toEqual(record(2));
  });
});

describe('overlapping owner pump completion', () => {
  it('old pump settling cannot release the new owner single-flight gate', async () => {
    const f = fixture();
    const first = deferred<SaveResponse>();
    const second = deferred<SaveResponse>();
    f.transport.save = (request, asset) => {
      f.transport.requests.push({ request, asset });
      return f.transport.requests.length === 1 ? first.promise : second.promise;
    };
    edit(f.queue);
    const old = f.queue.flush(ASSET);
    await drain();
    f.queue.setWriteOwner(nextOwner(f.owner));
    const fresh = f.queue.retry(ASSET);
    first.resolve(ack());
    await old;
    const duplicate = f.queue.retry(ASSET);
    expect(f.transport.requests).toHaveLength(2);
    expect(f.queue.getStatus(ASSET)).toMatchObject({ saving: true, synced_generation: 0 });
    second.resolve(ack());
    await Promise.all([fresh, duplicate]);
    expect(f.queue.getStatus(ASSET)).toMatchObject({ dirty: false, saving: false, synced_generation: 1 });
  });
});



async function releaseHeldSave(f: ReturnType<typeof fixture>, pending: Promise<unknown>[]) {
  // Cleanup is not evidence: revoke authority before releasing any unexpected ACK.
  f.queue.revokeWriteOwner(f.owner.token);
  f.transport.reply.resolve(ack());
  await Promise.allSettled(pending);
  await f.queue.whenPersisted(ASSET);
}

describe('C07 retained receipt without fresh-operation permission', () => {
  it.each([{ partialFuture: false, outcome: 'unknown' }, { partialFuture: true, outcome: 'unknown' },
    { partialFuture: false, outcome: 'rejected' }, { partialFuture: true, outcome: 'rejected' }] as const)('durably reconciles $outcome old success while partial future=$partialFuture cannot mint another operation', async ({ partialFuture, outcome }) => {
    const durable = new InMemoryDraftStorage();
    const entered = deferred<void>();
    const commit = deferred<void>();
    const storage: DraftStorage = {
      list: durable.list.bind(durable), get: durable.get.bind(durable), delete: durable.delete.bind(durable),
      put: async (envelope, guard) => { const value = envelope.record as DraftRecord;
        if (value.base_revision_id === 'revision-old-owner') { entered.resolve(); await commit.promise; }
        return durable.put(envelope, guard);
      },
    };
    const f = fixture(storage);
    const pending: Promise<unknown>[] = [];
    f.owner.canPrepareOperation = () => false;
    f.owner.getLease = () => null;
    const original = retainedOwnerRecord();
    original.pending_outcome = outcome;
    original.save_error = null;
    original.pending!.request.lease = { task_id: 'task-old', fencing_token: 41 };
    if (partialFuture) {
      original.generation = 2;
      original.edit_seq = 2;
      original.document = document(2);
      original.intent_journal.push({ seq: 2, generation: 2, intent: REVERT, recorded_at: AT });
    }
    try {
      await f.queue.forkFromRecord(await seedBranch(f.storage, original));
      await f.queue.whenPersisted(ASSET);
      const captured = f.queue.captureWriteGuard(ASSET, () => true);
      const replay = f.queue.retry(ASSET, captured);
      pending.push(replay);
      await drain();
      expect(f.transport.requests).toEqual([{ asset: ASSET, request: original.pending!.request }]);
      await f.queue.whenPersisted(ASSET);
      f.transport.reply.resolve({ ...ack(), idempotent_replay: true });
      await replay;
      await entered.promise;
      expect(captured()).toBe(true);
      expect(f.queue.getStatus(ASSET)).toMatchObject({ local_commit: null,
        dirty: partialFuture, writes_paused: true, synced_generation: 1,
        base_revision_id: 'revision-old-owner', last_ack: { generation: 1 } });
      commit.resolve();
      await f.queue.whenPersisted(ASSET);
      const latest = ((await durable.get(ASSET, f.queue.getDraftBranchSnapshot(ASSET)!.envelope.draft_id))?.record as DraftRecord | null);
      expect(latest).toMatchObject({ document: original.document, intent_journal: original.intent_journal,
        generation: original.generation, edit_seq: original.edit_seq,
        synced_generation: 1, synced_intent_seq: 1, base_revision_id: 'revision-old-owner',
        pending: null, pending_owner: null, writes_paused: partialFuture,
        draft_owner: partialFuture ? original.draft_owner : null });
      expect(f.queue.getStatus(ASSET).local_commit).toMatchObject({ generation: original.generation, edit_seq: original.edit_seq });
      for (const send of [() => f.queue.flush(ASSET), () => f.queue.retry(ASSET)]) {
        const operation = send();
        pending.push(operation);
        await drain();
        expect(f.transport.requests).toEqual([{ asset: ASSET, request: original.pending!.request }]);
        await operation;
      }
      f.queue.switchAsset(ASSET);
      f.queue.switchAsset('other');
      f.clock.advance(5000);
      await drain();
      expect(f.transport.requests).toEqual([{ asset: ASSET, request: original.pending!.request }]);
      expect(f.queue.toRecord(ASSET)?.used_operation_ids).toEqual(['operation-owner']);
    } finally {
      // Release the shared asset storage lane even when the paused-status assertion fails.
      commit.resolve();
      await releaseHeldSave(f, pending);
    }
  });

  it('generic send entry points cannot prepare fresh work without permission', async () => {
    const f = fixture();
    const pending: Promise<unknown>[] = [];
    f.owner.canPrepareOperation = () => false;
    f.owner.getLease = () => null;
    try {
      edit(f.queue);
      await f.queue.whenPersisted(ASSET);
      const before = f.queue.toRecord(ASSET)!;
      for (const send of [() => f.queue.flush(ASSET), () => f.queue.retry(ASSET)]) {
        const operation = send();
        pending.push(operation);
        await drain();
        expect(f.transport.requests).toEqual([]);
        await operation;
      }
      f.queue.switchAsset(ASSET);
      f.queue.switchAsset('other');
      f.clock.advance(5000);
      await drain();
      expect(f.transport.requests).toEqual([]);
      expect(payloadOf(f.queue.toRecord(ASSET))).toEqual(payloadOf(before));
      expect(f.queue.getStatus(ASSET).dirty).toBe(true);
    } finally {
      await releaseHeldSave(f, pending);
    }
  });

  it('a guard captured without original scope permission cannot borrow later authority', async () => {
    const f = fixture();
    const pending: Promise<unknown>[] = [];
    try {
      await f.queue.forkFromRecord(await seedBranch(f.storage, retainedOwnerRecord()));
      await f.queue.whenPersisted(ASSET);
      let scope = false;
      const captured = f.queue.captureWriteGuard(ASSET, () => scope);
      scope = true;
      const replay = f.queue.retry(ASSET, captured);
      pending.push(replay);
      await drain();
      expect(f.transport.requests).toEqual([]);
      await replay;
      expect(captured()).toBe(false);
      expect(f.queue.toRecord(ASSET)).toMatchObject({ pending: retainedOwnerRecord().pending, synced_generation: 0 });
    } finally {
      await releaseHeldSave(f, pending);
    }
  });
});


describe('C07 fresh permission and captured receipt revocation', () => {
  it('definitive rejected-lease replacement still needs permission at actual dispatch', async () => {
    const f = fixture();
    const pending: Promise<unknown>[] = [];
    let fresh = true;
    f.owner.canPrepareOperation = () => fresh;
    const rejected = retainedOwnerRecord();
    rejected.save_error = { kind: 'conflict', code: 'LEASE_EXPIRED', message: 'expired', status: 409, request_id: null };
    let stop: (() => void) | undefined;
    try {
      await f.queue.forkFromRecord(await seedBranch(f.storage, rejected));
      await f.queue.whenPersisted(ASSET);
      stop = f.queue.subscribe(ASSET, () => { if (f.queue.getStatus(ASSET).saving) fresh = false; });
      const retry = f.queue.retryRejectedLease(ASSET);
      pending.push(retry);
      await drain();
      expect(f.transport.requests).toEqual([]);
      await retry;
      stop();
      stop = undefined;
      await f.queue.whenPersisted(ASSET);
      expect(f.queue.toRecord(ASSET)).toMatchObject({ synced_generation: 0, writes_paused: true,
        pending_outcome: 'prepared', document: rejected.document, intent_journal: rejected.intent_journal });
    } finally {
      stop?.();
      await releaseHeldSave(f, pending);
    }
  });

  it('a replaced installation cannot lend authority to an already captured replay', async () => {
    const f = fixture();
    const pending: Promise<unknown>[] = [];
    try {
      await f.queue.forkFromRecord(await seedBranch(f.storage, retainedOwnerRecord()));
      await f.queue.whenPersisted(ASSET);
      const captured = f.queue.captureWriteGuard(ASSET, () => true);
      f.queue.revokeWriteOwner(f.owner.token);
      f.queue.setWriteOwner(f.owner);
      const replay = f.queue.retry(ASSET, captured);
      pending.push(replay);
      await drain();
      expect(f.transport.requests).toEqual([]);
      await replay;
      expect(captured()).toBe(false);
      expect(f.queue.getStatus(ASSET).last_ack).toBeNull();
      expect(f.queue.getStatus(ASSET).local_commit).toBeNull();
    } finally {
      await releaseHeldSave(f, pending);
    }
  });
});

describe('R1 latest document durability', () => {
  it('does not hide a superseded receipt failure until the latest full record physically commits', async () => {
    const durable = new InMemoryDraftStorage(), first = deferred<void>(), latest = deferred<void>();
    const entered = deferred<void>(), enteredLatest = deferred<void>();
    let receipts = 0;
    const f = fixture({ list: durable.list.bind(durable), get: durable.get.bind(durable), delete: durable.delete.bind(durable),
      put: async (envelope, guard) => {
        if ((envelope.record as DraftRecord).base_revision_id === 'revision-old-owner') {
          if (++receipts === 1) { entered.resolve(); await first.promise; throw new Error('old receipt aborted'); }
          enteredLatest.resolve(); await latest.promise;
        }
        return durable.put(envelope, guard);
      } });
    try {
      edit(f.queue); f.clock.advance(400); await drain();
      f.transport.reply.resolve(ack()); await entered.promise;
      edit(f.queue, 2, [REVERT]); edit(f.queue, 3, [ACCEPT]);
      first.resolve(); await enteredLatest.promise; await drain();
      expect(f.queue.getStatus(ASSET)).toMatchObject({ writes_paused: true, local_commit: null, last_error: { kind: 'storage' } });
      expect(f.queue.canAcceptEdits(ASSET, 'ontology-owner')).toBe(false);
      expect(f.transport.requests).toHaveLength(1);
      latest.resolve(); await f.queue.whenPersisted(ASSET);
      const snapshot = f.queue.getDraftBranchSnapshot(ASSET)!;
      expect(await durable.get(ASSET, snapshot.envelope.draft_id)).toEqual(snapshot.envelope);
      expect(snapshot.local_commit).toMatchObject({ write_token: snapshot.envelope.write_token, generation: 3, edit_seq: 3 });
      expect(f.queue.getStatus(ASSET)).toMatchObject({ writes_paused: false, last_error: null });
      expect(f.queue.canAcceptEdits(ASSET, 'ontology-owner')).toBe(true);
    } finally { first.resolve(); latest.resolve(); await releaseHeldSave(f, []); }
  });

  it.each(['success', 'failure', 'expired-scope'] as const)('awaits edits made after the durable ACK without widening its scope: %s', async (mode) => {
    const durable = new InMemoryDraftStorage();
    const held = deferred<void>(), entered = deferred<void>(), second = deferred<SaveResponse>();
    let fail = mode === 'failure', scope = true;
    const f = fixture({ list: durable.list.bind(durable), get: durable.get.bind(durable), delete: durable.delete.bind(durable),
      put: async (envelope, guard) => {
        const value = envelope.record as DraftRecord;
        if (value.base_revision_id === 'revision-old-owner' && value.generation === 3 && !value.pending) {
          entered.resolve(); await held.promise;
          if (fail) throw new Error('latest physical transaction aborted');
        }
        return durable.put(envelope, guard);
      } });
    f.transport.save = (request, asset) => {
      f.transport.requests.push({ asset, request: structuredClone(request) });
      return f.transport.requests.length === 1 ? f.transport.reply.promise : second.promise;
    };
    const pending: Promise<unknown>[] = [];
    try {
      edit(f.queue);
      const saving = f.queue.retry(ASSET, () => scope); pending.push(saving);
      await drain();
      edit(f.queue, 2, [REVERT]);
      await f.queue.whenPersisted(ASSET);
      f.transport.reply.resolve(ack());
      await saving; await f.queue.whenPersisted(ASSET);
      expect(f.queue.getStatus(ASSET)).toMatchObject({ writes_paused: false, local_commit: { generation: 2 } });
      edit(f.queue, 3, [ACCEPT]);
      await entered.promise;
      f.clock.advance(400); await drain();
      expect(f.transport.requests).toHaveLength(1);
      expect(f.queue.getStatus(ASSET).local_commit).toBeNull();
      if (mode === 'expired-scope') scope = false;
      held.resolve(); await f.queue.whenPersisted(ASSET); await drain();
      if (mode === 'success') {
        expect(f.transport.requests[1].request).toEqual({ operation_id: 'operation-owner-2', base_revision_id: 'revision-old-owner',
          document: document(3), lease: { task_id: 'task-old', fencing_token: 41 }, suggestion_decisions: [REVERT, ACCEPT] });
      } else {
        expect(f.transport.requests).toHaveLength(1);
        if (mode === 'failure') {
          expect(f.queue.getStatus(ASSET)).toMatchObject({ last_error: { kind: 'storage' }, local_commit: null });
          expect(f.queue.exportDraft(ASSET)).toMatchObject({ document: document(3) });
        }
        await f.queue.flush(ASSET); await drain();
        expect(f.transport.requests).toHaveLength(1);
      }
    } finally { held.resolve(); f.queue.revokeWriteOwner(f.owner.token); second.resolve(ack()); await releaseHeldSave(f, pending); }
  });

  it('keeps the latest failed receipt and retries its full body locally under the original owner', async () => {
    const durable = new InMemoryDraftStorage(), held = deferred<void>(), entered = deferred<void>();
    let fail = true;
    const f = fixture({ list: durable.list.bind(durable), get: durable.get.bind(durable), delete: durable.delete.bind(durable),
      put: async (envelope, guard) => {
        const value = envelope.record as DraftRecord;
        if (value.base_revision_id === 'revision-old-owner') {
          entered.resolve(); await held.promise;
          if (value.generation === 3 && fail) throw new Error('quota at latest receipt');
        }
        return durable.put(envelope, guard);
      } });
    try {
      edit(f.queue); f.clock.advance(400); await drain();
      f.transport.reply.resolve(ack()); await entered.promise;
      edit(f.queue, 2, [REVERT]); edit(f.queue, 3, [ACCEPT]);
      held.resolve(); await f.queue.whenPersisted(ASSET);
      expect(f.queue.getStatus(ASSET)).toMatchObject({ writes_paused: true, local_commit: null, last_error: { kind: 'storage' } });
      expect(f.queue.canAcceptEdits(ASSET, 'ontology-owner')).toBe(false);
      edit(f.queue, 4); expect(f.queue.exportDraft(ASSET)).toMatchObject({ document: document(3) });
      f.clock.advance(5000); await drain(); expect(f.transport.requests).toHaveLength(1);
      f.owner.getLease = () => { throw new Error('local retry must not borrow a fresh lease'); };
      fail = false; await f.queue.retry(ASSET); await f.queue.whenPersisted(ASSET);
      const snapshot = f.queue.getDraftBranchSnapshot(ASSET)!;
      expect(await durable.get(ASSET, snapshot.envelope.draft_id)).toEqual(snapshot.envelope);
      expect(snapshot.local_commit).toMatchObject({ write_token: snapshot.envelope.write_token, generation: 3, edit_seq: 3 });
      expect(snapshot.envelope.record).toMatchObject({ document: document(3), synced_generation: 1, synced_intent_seq: 2, pending: null });
      expect(f.transport.requests).toHaveLength(1);
    } finally { held.resolve(); await releaseHeldSave(f, []); }
  });
});

describe('C07 ordinary automatic ACK durable barrier', () => {
  it('retains native edits while blocking fresh sends until the latest full receipt PUT completes', async () => {
    const durable = new InMemoryDraftStorage();
    const first = deferred<void>();
    const latest = deferred<void>();
    const entered = deferred<void>();
    const enteredLatest = deferred<void>();
    let receipts = 0;
    const f = fixture({ list: durable.list.bind(durable), get: durable.get.bind(durable), delete: durable.delete.bind(durable),
      put: async (envelope, guard) => { const value = envelope.record as DraftRecord;
        if (value.base_revision_id === 'revision-old-owner') {
          if (++receipts === 1) { entered.resolve(); await first.promise; }
          else { enteredLatest.resolve(); await latest.promise; }
        }
        return durable.put(envelope, guard);
      } });
    const pending: Promise<unknown>[] = [];
    try {
      edit(f.queue);
      await f.queue.whenPersisted(ASSET);
      f.clock.advance(400);
      await drain();
      expect(f.transport.requests).toEqual([{ asset: ASSET, request: {
        operation_id: 'operation-owner', base_revision_id: 'base-owner', document: document(1),
        lease: { task_id: 'task-old', fencing_token: 41 }, suggestion_decisions: [ACCEPT, REVERT],
      } }]);
      await f.queue.whenPersisted(ASSET);
      f.transport.reply.resolve(ack());
      await entered.promise;
      expect(f.queue.getStatus(ASSET)).toMatchObject({ writes_paused: true, local_commit: null,
        last_ack: { revision_id: 'revision-old-owner', generation: 1 }, synced_generation: 1 });
      expect(f.queue.canAcceptEdits(ASSET, 'ontology-owner')).toBe(true);
      expect(f.queue.canAcceptEdits(ASSET, 'different-ontology')).toBe(false);
      edit(f.queue, 2, [REVERT]);
      let settledFlushes = 0;
      let persistedSettled = false;
      pending.push(f.queue.whenPersisted(ASSET).then(() => { settledFlushes += 1; }));
      pending.push(f.queue.whenPersisted(ASSET).then(() => { persistedSettled = true; }));
      f.clock.advance(5000);
      await drain();
      expect(f.queue.toRecord(ASSET)).toMatchObject({ document: document(2), generation: 2 });
      expect(f.transport.requests).toHaveLength(1);
      expect(settledFlushes).toBe(0);
      expect(persistedSettled).toBe(false);
      pending.push(f.queue.retry(ASSET));
      first.resolve();
      await enteredLatest.promise;
      await drain();
      expect(f.queue.getStatus(ASSET)).toMatchObject({ writes_paused: true, local_commit: null });
      expect(settledFlushes).toBe(0);
      expect(persistedSettled).toBe(false);
      edit(f.queue, 3);
      pending.push(f.queue.whenPersisted(ASSET).then(() => { settledFlushes += 1; }));
      await drain();
      expect(f.queue.toRecord(ASSET)).toMatchObject({ document: document(3), generation: 3, edit_seq: 3 });
      latest.resolve();
      await Promise.all(pending);
      await f.queue.whenPersisted(ASSET);
      expect(settledFlushes).toBe(2);
      expect(persistedSettled).toBe(true);
      expect(f.queue.getStatus(ASSET)).toMatchObject({ writes_paused: false, dirty: true,
        local_commit: { generation: 3, edit_seq: 3 } });
      const snapshot = f.queue.getDraftBranchSnapshot(ASSET)!;
      const stored = await durable.get(ASSET, snapshot.envelope.draft_id);
      expect(stored).toEqual(snapshot.envelope);
      expect(stored!.write_token).toBe(f.queue.getStatus(ASSET).local_commit!.write_token);
      expect(stored!.record).toMatchObject({ document: document(3), pending: null, synced_generation: 1, synced_intent_seq: 2, writes_paused: false,
        intent_journal: [
          { seq: 1, generation: 1, intent: ACCEPT, recorded_at: AT },
          { seq: 2, generation: 1, intent: REVERT, recorded_at: AT },
          { seq: 3, generation: 2, intent: REVERT, recorded_at: new Date(Date.parse(AT) + 400).toISOString() },
          { seq: 4, generation: 3, intent: ACCEPT, recorded_at: new Date(f.clock.now()).toISOString() },
          { seq: 5, generation: 3, intent: REVERT, recorded_at: new Date(f.clock.now()).toISOString() },
        ], used_operation_ids: ['operation-owner'] });
      expect(f.transport.requests).toHaveLength(1);
    } finally { first.resolve(); latest.resolve(); await releaseHeldSave(f, pending); }
  });

  it.each(['clean', 'future-authorized', 'future-no-permission'] as const)(
    'failed ordinary receipt retries only its local PUT after fresh lease loss: %s', async (mode) => {
      const durable = new InMemoryDraftStorage();
      let fail = true;
      let receipts = 0;
      const f = fixture({ list: durable.list.bind(durable), get: durable.get.bind(durable), delete: durable.delete.bind(durable),
        put: async (envelope, guard) => { const value = envelope.record as DraftRecord;
          if (value.base_revision_id === 'revision-old-owner') {
            receipts += 1;
            if (fail) throw new Error('ordinary receipt transaction aborted');
          }
          return durable.put(envelope, guard);
        } });
      try {
        edit(f.queue);
        await f.queue.whenPersisted(ASSET);
        f.clock.advance(400);
        await drain();
        expect(f.transport.requests).toHaveLength(1);
        if (mode !== 'clean') edit(f.queue, 2, [REVERT]);
        await f.queue.whenPersisted(ASSET);
        if (mode === 'future-no-permission') f.owner.canPrepareOperation = () => false;
        f.transport.reply.resolve(ack());
        await drain();
        await f.queue.whenPersisted(ASSET);
        expect(f.queue.getStatus(ASSET)).toMatchObject({ writes_paused: true, local_commit: null,
          last_error: { kind: 'storage' }, last_ack: { generation: 1 } });
        const accepted = f.queue.toRecord(ASSET)!;
        f.owner.getLease = () => { throw new Error('local receipt retry must not obtain a fresh lease'); };
        expect(f.queue.canRetryRetained(ASSET, () => true)).toBe(true);
        expect(f.queue.canRetryRetained(ASSET, () => false)).toBe(false);
        edit(f.queue, 3);
        await f.queue.flush(ASSET);
        expect(payloadOf(f.queue.toRecord(ASSET))).toEqual(payloadOf(accepted));
        fail = false;
        const before = receipts;
        await f.queue.retry(ASSET);
        await f.queue.whenPersisted(ASSET);
        expect(receipts).toBe(before + 1);
        expect(f.transport.requests).toHaveLength(1);
        expect(f.queue.toRecord(ASSET)?.used_operation_ids).toEqual(['operation-owner']);
        expect(f.queue.getStatus(ASSET)).toMatchObject({ writes_paused: mode === 'future-no-permission',
          dirty: mode !== 'clean', last_error: null,
          local_commit: { generation: mode === 'clean' ? 1 : 2 } });
        expect(((await durable.get(ASSET, f.queue.getDraftBranchSnapshot(ASSET)!.envelope.draft_id))?.record as DraftRecord | null)).toMatchObject({ pending: null, document: accepted.document,
          intent_journal: accepted.intent_journal, synced_generation: 1, synced_intent_seq: 2,
          writes_paused: mode === 'future-no-permission' });
        // No pending HTTP identity remains: a second local retry is not a resend.
        if (mode === 'clean') {
          await f.queue.retry(ASSET);
          expect(f.transport.requests).toHaveLength(1);
          expect(receipts).toBe(before + 1);
        }
      } finally { await releaseHeldSave(f, []); }
    });

  it.each(['current', 'scope-expired', 'foreign', 'new-installation', 'scope-after-commit'] as const)(
    'ordinary future continues only under its captured installation after durable commit: %s', async (mode) => {
      const durable = new InMemoryDraftStorage();
      const entered = deferred<void>();
      const commit = deferred<void>();
      const secondReply = deferred<SaveResponse>();
      const f = fixture({ list: durable.list.bind(durable), get: durable.get.bind(durable), delete: durable.delete.bind(durable),
        put: async (envelope, guard) => { const value = envelope.record as DraftRecord;
          if (value.base_revision_id === 'revision-old-owner' && value.pending === null) {
            entered.resolve(); await commit.promise;
          }
          return durable.put(envelope, guard);
        } });
      f.transport.save = (request, asset) => {
        f.transport.requests.push({ asset, request: JSON.parse(JSON.stringify(request)) as SaveRequest });
        return f.transport.requests.length === 1 ? f.transport.reply.promise : secondReply.promise;
      };
      try {
        edit(f.queue);
        await f.queue.whenPersisted(ASSET);
        f.clock.advance(400);
        await drain();
        expect(f.transport.requests).toHaveLength(1);
        edit(f.queue, 2, [REVERT, ACCEPT]);
        await f.queue.whenPersisted(ASSET);
        const future = f.queue.toRecord(ASSET)!;
        f.transport.reply.resolve(ack());
        await entered.promise;
        f.clock.advance(100);
        await drain();
        expect(f.queue.getStatus(ASSET)).toMatchObject({ writes_paused: true, local_commit: null, dirty: true });
        expect(f.transport.requests).toHaveLength(1);
        if (mode === 'scope-expired') f.expire();
        if (mode === 'foreign') f.queue.setWriteOwner(nextOwner(f.owner, 'foreign-actor'));
        if (mode === 'new-installation') f.queue.setWriteOwner(nextOwner(f.owner));
        commit.resolve();
        await f.queue.whenPersisted(ASSET);
        if (mode === 'scope-after-commit') f.expire();
        if (mode === 'current' || mode === 'scope-after-commit') {
          expect(((await durable.get(ASSET, f.queue.getDraftBranchSnapshot(ASSET)!.envelope.draft_id))?.record as DraftRecord | null)).toMatchObject({ document: document(2),
            intent_journal: future.intent_journal, synced_generation: 1, synced_intent_seq: 2,
            pending: null, base_revision_id: 'revision-old-owner' });
        } else {
          expect(f.queue.getStatus(ASSET).local_commit).toBeNull();
          expect(f.queue.canRetryRetained(ASSET, () => true)).toBe(false);
          await f.queue.retry(ASSET);
        }
        f.clock.advance(299);
        await drain();
        expect(f.transport.requests).toHaveLength(1);
        f.clock.advance(1);
        await drain();
        if (mode === 'current') {
          expect(f.transport.requests[1]).toEqual({ asset: ASSET, request: {
            operation_id: 'operation-owner-2', base_revision_id: 'revision-old-owner',
            document: document(2), lease: { task_id: 'task-old', fencing_token: 41 },
            suggestion_decisions: [REVERT, ACCEPT],
          } });
          expect(f.queue.toRecord(ASSET)).toMatchObject({ intent_journal: future.intent_journal,
            synced_intent_seq: 2, pending: { generation: 2, journal_seq_end: 4 },
            used_operation_ids: ['operation-owner', 'operation-owner-2'] });
        } else {
          expect(f.transport.requests).toHaveLength(1);
          expect(f.queue.toRecord(ASSET)?.used_operation_ids).toEqual(['operation-owner']);
        }
      } finally {
        commit.resolve();
        f.queue.revokeWriteOwner(f.owner.token);
        secondReply.resolve(ack());
        await releaseHeldSave(f, []);
      }
    });
});
function ownedFutureRecord(): DraftRecord {
  const value = retainedOwnerRecord();
  value.pending = null;
  value.pending_owner = null;
  value.pending_outcome = 'prepared';
  value.save_error = null;
  value.base_revision_id = 'revision-old-owner';
  value.generation = 2;
  value.synced_generation = 1;
  value.synced_intent_seq = 1;
  value.edit_seq = 2;
  value.document = document(2);
  value.used_operation_ids = ['operation-owner'];
  value.intent_journal.push({ seq: 2, generation: 2, intent: REVERT, recorded_at: AT });
  return value;
}

describe('C07 authorized unknown continuation after receipt commit', () => {
  it.each(['current', 'scope-before', 'scope-after', 'permission-after', 'installation-before', 'rejected'] as const)(
    'resumes only current authorized unknown work at the durable boundary: %s', async (mode) => {
      const durable = new InMemoryDraftStorage();
      const entered = deferred<void>();
      const commit = deferred<void>();
      const f = fixture({ list: durable.list.bind(durable), get: durable.get.bind(durable), delete: durable.delete.bind(durable),
        put: async (envelope, guard) => { const value = envelope.record as DraftRecord;
          if (value.base_revision_id === 'revision-old-owner' && value.pending === null) {
            entered.resolve();
            await commit.promise;
          }
          return durable.put(envelope, guard);
        } });
      const pending: Promise<unknown>[] = [];
      let scope = true;
      try {
        const original = retainedOwnerRecord();
        original.pending_outcome = mode === 'rejected' ? 'rejected' : 'unknown';
        original.save_error = null;
        original.generation = 2;
        original.edit_seq = 2;
        original.document = document(2);
        original.intent_journal.push({ seq: 2, generation: 2, intent: REVERT, recorded_at: AT });
        await f.queue.forkFromRecord(await seedBranch(f.storage, original));
        await f.queue.whenPersisted(ASSET);
        const replay = f.queue.retry(ASSET, f.queue.captureWriteGuard(ASSET, () => scope));
        pending.push(replay);
        await drain();
        expect(f.transport.requests).toEqual([{ asset: ASSET, request: original.pending!.request }]);
        f.transport.reply.resolve({ ...ack(), idempotent_replay: true });
        // The replay promise observes the real ACK without waiting for held IDB.
        await replay;
        await entered.promise;
        f.clock.advance(5000);
        await drain();
        expect(f.transport.requests).toHaveLength(1);
        expect(f.queue.getStatus(ASSET)).toMatchObject({ writes_paused: true, local_commit: null, synced_generation: 1 });
        if (mode === 'scope-before') scope = false;
        if (mode === 'installation-before') f.queue.setWriteOwner({ ...f.owner, actor_id: 'other' });
        commit.resolve();
        await f.queue.whenPersisted(ASSET);
        // The timer must retain the captured scope even after a successful commit.
        if (mode === 'scope-after') scope = false;
        if (mode === 'permission-after') f.owner.canPrepareOperation = () => false;
        expect(f.transport.requests).toHaveLength(1);
        f.clock.advance(5000);
        await drain();
        if (mode === 'current') {
          expect(f.transport.requests).toHaveLength(2);
          expect(f.transport.requests[1].request).toEqual({ operation_id: 'operation-owner-2',
            base_revision_id: 'revision-old-owner', document: document(2),
            lease: { task_id: 'task-old', fencing_token: 41 }, suggestion_decisions: [REVERT] });
          expect(((await durable.get(ASSET, f.queue.getDraftBranchSnapshot(ASSET)!.envelope.draft_id))?.record as DraftRecord | null)).toMatchObject({ synced_generation: 1, synced_intent_seq: 1,
            base_revision_id: 'revision-old-owner', document: document(2) });
        } else {
          expect(f.transport.requests).toEqual([{ asset: ASSET, request: original.pending!.request }]);
          expect(f.queue.toRecord(ASSET)?.used_operation_ids).toEqual(['operation-owner']);
          if (mode === 'scope-before' || mode === 'installation-before') {
            expect(f.queue.getStatus(ASSET)).toMatchObject({ writes_paused: true, local_commit: null });
          }
        }
      } finally { commit.resolve(); await releaseHeldSave(f, pending); }
    });
});

describe('C07 explicit owned future and ACK local barrier', () => {
  it('prepares one latest body on the real base with a fresh lease/id and only the unsynced journal', async () => {
    const durable = new InMemoryDraftStorage();
    const commit = deferred<void>();
    const entered = deferred<void>();
    const f = fixture({ list: durable.list.bind(durable), get: durable.get.bind(durable), delete: durable.delete.bind(durable),
      put: async (envelope, guard) => { const value = envelope.record as DraftRecord; if (value.base_revision_id === 'revision-future') { entered.resolve(); await commit.promise; } return durable.put(envelope, guard); } });
    const pending: Promise<unknown>[] = [];
    try {
      await f.queue.forkFromRecord(await seedBranch(f.storage, ownedFutureRecord()));
      await f.queue.whenPersisted(ASSET);
      await f.queue.flush(ASSET);
      await f.queue.retry(ASSET);
      expect(f.transport.requests).toEqual([]);
      let proofCalls = 0;
      const retry = f.queue.retryOwnedFuture(ASSET, () => ++proofCalls === 1, f.queue.captureWriteGuard(ASSET, () => true));
      pending.push(retry);
      await drain();
      const request = f.transport.requests[0].request;
      expect(request).toEqual({ operation_id: 'operation-owner-2', base_revision_id: 'revision-old-owner',
        document: document(2), lease: { task_id: 'task-old', fencing_token: 41 }, suggestion_decisions: [REVERT] });
      expect(await f.queue.retryOwnedFuture(ASSET, () => true, () => true)).toBe(false);
      f.transport.reply.resolve({ ...ack(), operation_id: request.operation_id,
        revision: { ...ack().revision, annotation_revision_id: 'revision-future', parent_revision_id: request.base_revision_id, document: request.document } });
      await retry;
      await entered.promise;
      expect(f.queue.getStatus(ASSET)).toMatchObject({ writes_paused: true, local_commit: null, synced_generation: 2 });
      edit(f.queue, 3);
      expect(f.queue.getStatus(ASSET).local_generation).toBe(3);
      expect(f.queue.toRecord(ASSET)?.writes_paused).toBe(true);
      commit.resolve();
      await f.queue.whenPersisted(ASSET);
      expect(f.queue.getStatus(ASSET)).toMatchObject({ writes_paused: false, dirty: true, local_commit: { generation: 3 } });
      f.clock.advance(5000);
      await f.queue.flush(ASSET);
      await drain();
      expect(f.transport.requests).toHaveLength(1);
      expect(f.queue.toRecord(ASSET)?.used_operation_ids).toEqual(['operation-owner', 'operation-owner-2']);
      expect(proofCalls).toBe(1);
      expect(f.transport.requests).toHaveLength(1);
    } finally { commit.resolve(); await releaseHeldSave(f, pending); }
  });

  it.each(['initial', 'lease', 'permission', 'certificate', 'foreign'] as const)('denies future preparation without %s evidence', async (mode) => {
    const f = fixture();
    const pending: Promise<unknown>[] = [];
    try {
      const value = ownedFutureRecord();
      if (mode === 'foreign') value.draft_owner = { actor_id: 'other', project_id: 'project-old' };
      const source = await seedBranch(f.storage, value);
      if (mode === 'certificate') (f.storage as InMemoryDraftStorage).failNextPut(new Error('fork commit aborted'));
      await f.queue.forkFromRecord(source);
      if (mode !== 'certificate') await f.queue.whenPersisted(ASSET);
      if (mode === 'lease') f.owner.getLease = () => null;
      if (mode === 'permission') f.owner.canPrepareOperation = () => false;
      expect(await f.queue.retryOwnedFuture(ASSET, () => mode !== 'initial', () => true)).toBe(false);
      expect(f.transport.requests).toEqual([]);
      expect(f.queue.toRecord(ASSET)?.used_operation_ids).toEqual(['operation-owner']);
    } finally { await releaseHeldSave(f, pending); }
  });

  it.each(['retry', 'scope', 'installation', 'same-installation'] as const)('failed receipt storage retains pause and cannot borrow %s authority', async (mode) => {
    const durable = new InMemoryDraftStorage();
    let fail = true;
    let puts = 0;
    const f = fixture({ list: durable.list.bind(durable), get: durable.get.bind(durable), delete: durable.delete.bind(durable),
      put: async (envelope, guard) => { const value = envelope.record as DraftRecord; puts += 1; if (value.base_revision_id === 'revision-future' && fail) throw new Error('local transaction aborted'); return durable.put(envelope, guard); } });
    const pending: Promise<unknown>[] = [];
    let scope = true;
    try {
      await f.queue.forkFromRecord(await seedBranch(f.storage, ownedFutureRecord()));
      await f.queue.whenPersisted(ASSET);
      const retry = f.queue.retryOwnedFuture(ASSET, () => true, f.queue.captureWriteGuard(ASSET, () => scope));
      pending.push(retry);
      await drain();
      const request = f.transport.requests[0].request;
      f.transport.reply.resolve({ ...ack(), operation_id: request.operation_id,
        revision: { ...ack().revision, annotation_revision_id: 'revision-future', document: request.document } });
      await retry;
      await f.queue.whenPersisted(ASSET);
      expect(f.queue.getStatus(ASSET)).toMatchObject({ writes_paused: true, local_commit: null, last_error: { kind: 'storage' } });
      expect(f.queue.exportDraft(ASSET)).not.toBeNull();
      expect(f.queue.canRetryRetained(ASSET, () => true)).toBe(true);
      const before = puts;
      fail = false;
      if (mode === 'scope') scope = false;
      if (mode === 'installation') f.queue.setWriteOwner({ ...f.owner, actor_id: 'other' });
      if (mode === 'same-installation') f.queue.setWriteOwner({ ...f.owner });
      f.owner.canPrepareOperation = () => false;
      f.owner.getLease = () => { throw new Error('local ACK retry must not read a lease'); };
      expect(f.queue.canRetryRetained(ASSET, () => true)).toBe(mode === 'retry');
      expect(f.queue.canRetryRetained(ASSET, () => false)).toBe(false);
      await f.queue.retry(ASSET, () => true);
      await f.queue.whenPersisted(ASSET);
      expect(f.transport.requests).toHaveLength(1);
      if (mode === 'retry') {
        expect(puts).toBe(before + 1);
        expect(f.queue.getStatus(ASSET)).toMatchObject({ writes_paused: false, dirty: false, local_commit: { generation: 2 } });
      } else {
        expect(puts).toBe(before);
        expect(f.queue.getStatus(ASSET)).toMatchObject({ writes_paused: true, local_commit: null });
      }
    } finally { await releaseHeldSave(f, pending); }
  });

  it.each(['scope', 'latest'] as const)('only a current latest local transaction may release the barrier: %s', async (mode) => {
    const durable = new InMemoryDraftStorage();
    const first = deferred<void>();
    const second = deferred<void>();
    const entered = deferred<void>();
    const enteredSecond = deferred<void>();
    let receipts = 0;
    const f = fixture({ list: durable.list.bind(durable), get: durable.get.bind(durable), delete: durable.delete.bind(durable),
      put: async (envelope, guard) => { const value = envelope.record as DraftRecord;
        if (value.base_revision_id === 'revision-future') {
          receipts += 1;
          if (receipts === 1) { entered.resolve(); await first.promise; }
          else { enteredSecond.resolve(); await second.promise; }
        }
        return durable.put(envelope, guard);
      } });
    const pending: Promise<unknown>[] = [];
    let scope = true;
    try {
      await f.queue.forkFromRecord(await seedBranch(f.storage, ownedFutureRecord()));
      await f.queue.whenPersisted(ASSET);
      const future = f.queue.retryOwnedFuture(ASSET, () => true, f.queue.captureWriteGuard(ASSET, () => scope));
      pending.push(future);
      await drain();
      const request = f.transport.requests[0].request;
      f.transport.reply.resolve({ ...ack(), operation_id: request.operation_id,
        revision: { ...ack().revision, annotation_revision_id: 'revision-future', document: request.document } });
      await future;
      await entered.promise;
      f.owner.canPrepareOperation = () => false;
      f.owner.getLease = () => { throw new Error('local ACK retry must not read a lease'); };
      expect(f.queue.canRetryRetained(ASSET, () => true)).toBe(true);
      if (mode === 'scope') scope = false;
      expect(f.queue.canRetryRetained(ASSET, () => true)).toBe(mode !== 'scope');
      if (mode === 'latest') pending.push(f.queue.retry(ASSET));
      first.resolve();
      if (mode === 'latest') await enteredSecond.promise;
      await drain();
      expect(f.queue.getStatus(ASSET)).toMatchObject({ writes_paused: true, local_commit: null });
      second.resolve();
      await f.queue.whenPersisted(ASSET);
      expect(f.queue.getStatus(ASSET).writes_paused).toBe(mode === 'scope');
      expect(f.transport.requests).toHaveLength(1);
    } finally { first.resolve(); second.resolve(); await releaseHeldSave(f, pending); }
  });


  it.each(['permission', 'lease'] as const)('rechecks fresh %s at dispatch without treating preparation as authority', async (mode) => {
    const f = fixture();
    const pending: Promise<unknown>[] = [];
    let stop: (() => void) | undefined;
    try {
      await f.queue.forkFromRecord(await seedBranch(f.storage, ownedFutureRecord()));
      await f.queue.whenPersisted(ASSET);
      stop = f.queue.subscribe(ASSET, () => {
        if (!f.queue.getStatus(ASSET).saving) return;
        if (mode === 'permission') f.owner.canPrepareOperation = () => false;
        else f.owner.getLease = () => ({ task_id: 'task-new', fencing_token: 42 });
      });
      const future = f.queue.retryOwnedFuture(ASSET, () => true, () => true);
      pending.push(future);
      await future;
      expect(f.transport.requests).toEqual([]);
      expect(f.queue.getStatus(ASSET)).toMatchObject({ writes_paused: true, dirty: true, synced_generation: 1 });
      expect(f.queue.toRecord(ASSET)?.pending?.request).toMatchObject({ operation_id: 'operation-owner-2', lease: { task_id: 'task-old', fencing_token: 41 } });
    } finally { stop?.(); await releaseHeldSave(f, pending); }
  });

});

describe('C07 explicit conflict resolution scope', () => {
  it('denies scoped flush before dispatch without changing the retained document', async () => {
    const f = fixture(), pending: Promise<unknown>[] = [];
    try {
      edit(f.queue);
      await f.queue.whenPersisted(ASSET);
      const before = payloadOf(f.queue.toRecord(ASSET));
      const flushing = f.queue.flush(ASSET, () => false); pending.push(flushing);
      await flushing;
      expect(f.transport.requests).toEqual([]);
      expect(payloadOf(f.queue.toRecord(ASSET))).toEqual(before);
      expect(f.queue.getStatus(ASSET).last_ack).toBeNull();
    } finally { await releaseHeldSave(f, pending); }
  });

  it('a scoped flush cannot adopt a late reply after its original view expires', async () => {
    const f = fixture(), pending: Promise<unknown>[] = []; let current = true;
    try {
      edit(f.queue);
      const flushing = f.queue.flush(ASSET, () => current); pending.push(flushing);
      await drain();
      const original = f.queue.toRecord(ASSET)!;
      expect(f.transport.requests).toEqual([{ asset: ASSET, request: original.pending!.request }]);
      current = false; f.transport.reply.resolve(ack());
      await flushing; await f.queue.whenPersisted(ASSET);
      expect(f.queue.toRecord(ASSET)).toMatchObject({ pending: original.pending, base_revision_id: original.base_revision_id, synced_generation: 0 });
      expect(f.queue.getStatus(ASSET).last_ack).toBeNull();
      expect((((await f.storage.get(ASSET, f.queue.getDraftBranchSnapshot(ASSET)!.envelope.draft_id))?.record as DraftRecord | null))?.pending).toEqual(original.pending);
    } finally { await releaseHeldSave(f, pending); }
  });

  it('resolved conflict debounce cannot borrow a later view after the original resolution scope expires', async () => {
    const f = fixture(), pending: Promise<unknown>[] = []; let current = true;
    try {
      const retained = retainedOwnerRecord();
      retained.save_error = { kind: 'conflict', code: 'STALE_REVISION', message: 'head advanced', status: 409, request_id: null };
      await f.queue.forkFromRecord(await seedBranch(f.storage, retained)); await f.queue.whenPersisted(ASSET);
      f.transport.fetchHead = async () => ack().revision;
      const resolution = await f.queue.resolveConflict(ASSET, 'keep_local_export', () => current);
      expect(resolution).toMatchObject({ resumed: true, base_revision_id: 'revision-old-owner' });
      const before = payloadOf(f.queue.toRecord(ASSET));
      current = false; f.clock.advance(5000); await drain();
      expect(f.transport.requests).toEqual([]);
      expect(payloadOf(f.queue.toRecord(ASSET))).toEqual(before);
      expect(f.queue.toRecord(ASSET)?.document).toEqual(retained.document);
    } finally { await releaseHeldSave(f, pending); }
  });
});

