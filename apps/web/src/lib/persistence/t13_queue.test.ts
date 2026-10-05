// T13 · IndexedDB 恢复与单飞保存队列.
//
// Every test drives the REAL SaveQueue / DraftStore / recovery logic through the
// card-mandated injectable seams (storage, HTTP, clock). The doubles live at
// those seams only: a controllable transport records real request traffic and
// lets the test decide ACK order, the in-memory storage serializes records the
// way IndexedDB would, and the fake IDBFactory emulates the browser IndexedDB
// request/error surface for the production IndexedDbDraftStorage adapter.
// Fake timers (injected TestClock / vi.useFakeTimers) drive the 400ms debounce.
import * as matchers from '@testing-library/jest-dom/matchers';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import type { SaveResponse } from '../../../../../packages/contracts/generated/SaveResponse';
import type { SuggestionDecisionIntent } from '../../../../../packages/contracts/generated/SuggestionDecisionIntent';

import { SaveStatus } from '../../features/workbench/SaveStatus';
import {
  DraftStore,
  IndexedDbDraftStorage,
  InMemoryDraftStorage,
  exportNativeDraft,
  serializeNativeDraft,
} from './draft-store';
import {
  RECOVERY_CONFLICT_OPTIONS,
  compareWithServer,
  hasUnsyncedWork,
  keepLocalExport,
  runRecovery,
  viewServerVersion,
} from './recovery';
import { FetchSaveTransport, SaveQueue, reconcileAck } from './save-queue';
import { SAVE_DEBOUNCE_MS, StorageError, TransportError } from './types';
import type {
  Clock,
  DraftRecord,
  Id,
  NativeDraftExport,
  SaveStatusSnapshot,
  SaveTransport,
  SaveRequest,
} from './types';

expect.extend(matchers);

// ---------------------------------------------------------------------------
// Golden fixtures (docs/testing-contracts.md §2: 640×480, bbox 10,20,110,220,
// object_person_001 / label_person, helmet_state default unknown).
// ---------------------------------------------------------------------------

function makeDocument(overrides: Partial<AnnotationDocument> = {}): AnnotationDocument {
  return {
    schema_version: 1,
    asset_revision_id: 'asset_revision_golden',
    ontology_version_id: 'ontology_v1',
    coordinate_space: { type: 'canonical_image_pixels', width: 640, height: 480 },
    completion: 'in_progress',
    objects: [
      {
        object_id: 'object_person_001',
        label_id: 'label_person',
        geometry: { type: 'bbox_xyxy', x_min: 10, y_min: 20, x_max: 110, y_max: 220 },
        attributes: { helmet_state: 'unknown' },
        origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null },
      },
    ],
    ...overrides,
  };
}

function makeRevision(
  annotation_revision_id: Id,
  document: AnnotationDocument = makeDocument(),
  revision_no = 1,
): AnnotationRevision {
  return {
    annotation_revision_id,
    parent_revision_id: null,
    revision_no,
    document,
    created_at: '2026-09-26T00:00:00Z',
    created_by: 'user_fixture',
    content_hash: `hash_${annotation_revision_id}`,
  };
}

const ACCEPT: SuggestionDecisionIntent = {
  suggestion_set_id: 'suggestion_set_001',
  change_ids: ['change_001'],
  decision: 'accept',
};
const REVERT: SuggestionDecisionIntent = {
  suggestion_set_id: 'suggestion_set_001',
  change_ids: ['change_001'],
  decision: 'revert',
};

// ---------------------------------------------------------------------------
// Clock seam: deterministic fake timers owned by the test.
// ---------------------------------------------------------------------------

interface ScheduledTimer {
  id: number;
  at: number;
  handler: () => void;
}

class TestClock implements Clock {
  private current = 1_000_000;
  private nextId = 1;
  private timers: ScheduledTimer[] = [];

  now(): number {
    return this.current;
  }

  setTimeout(handler: () => void, delayMs: number): unknown {
    const timer: ScheduledTimer = { id: this.nextId, at: this.current + delayMs, handler };
    this.nextId += 1;
    this.timers.push(timer);
    return timer.id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }

  /** Runs every timer due inside the window, in due order, with fake time. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.current = due.at;
      due.handler();
    }
    this.current = target;
  }

  pendingTimers(): number {
    return this.timers.length;
  }
}

async function microtasks(times = 25): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// HTTP seam: controllable transport. Real request traffic is recorded; the test
// decides when (and whether) each request is acknowledged.
// ---------------------------------------------------------------------------

interface RecordedSave {
  request: SaveRequest;
  asset_revision_id: Id;
  settled: boolean;
  resolve: (response: SaveResponse) => void;
  reject: (error: unknown) => void;
}

class ControllableTransport implements SaveTransport {
  readonly saves: RecordedSave[] = [];
  readonly headCalls: Array<{ asset_revision_id: Id; ontology_version_id: Id }> = [];
  readonly revisionCalls: Id[] = [];
  head: AnnotationRevision | null = null;
  headError: unknown = null;
  revisions = new Map<Id, AnnotationRevision>();

  save(request: SaveRequest, asset_revision_id: Id): Promise<SaveResponse> {
    const record = {} as RecordedSave;
    const promise = new Promise<SaveResponse>((resolve, reject) => {
      record.request = request;
      record.asset_revision_id = asset_revision_id;
      record.settled = false;
      record.resolve = (response) => {
        record.settled = true;
        resolve(response);
      };
      record.reject = (error) => {
        record.settled = true;
        reject(error);
      };
    });
    this.saves.push(record);
    return promise;
  }

  async fetchHead(asset_revision_id: Id, ontology_version_id: Id): Promise<AnnotationRevision | null> {
    this.headCalls.push({ asset_revision_id, ontology_version_id });
    if (this.headError) throw this.headError;
    return this.head;
  }

  async fetchRevision(annotation_revision_id: Id): Promise<AnnotationRevision> {
    this.revisionCalls.push(annotation_revision_id);
    const revision = this.revisions.get(annotation_revision_id);
    if (!revision) throw new TransportError({ kind: 'http', status: 404, code: 'ANNOTATION_NOT_FOUND', message: 'missing' });
    return revision;
  }

  /** Server-side ACK: echoes operation_id and commits a new revision. */
  ackSave(index: number, revision_id: Id, options: { replay?: boolean; revision_no?: number } = {}): void {
    const save = this.saves[index];
    save.resolve({
      operation_id: save.request.operation_id,
      revision: makeRevision(revision_id, save.request.document, options.revision_no ?? 2),
      idempotent_replay: options.replay ?? false,
    });
  }

  failNetwork(index: number): void {
    this.saves[index].reject(
      new TransportError({ kind: 'network', message: 'network unreachable', code: 'NETWORK_UNREACHABLE' }),
    );
  }

  failHttp(index: number, status: number, code: string): void {
    this.saves[index].reject(
      new TransportError({
        kind: status === 409 ? 'conflict' : 'http',
        status,
        code,
        message: `http ${status}`,
      }),
    );
  }

  requestsFor(asset_revision_id: Id): RecordedSave[] {
    return this.saves.filter((save) => save.asset_revision_id === asset_revision_id);
  }
}

// ---------------------------------------------------------------------------
// Storage seam: production InMemoryDraftStorage (JSON round-trip + failure
// injection) and a fake IDBFactory boundary for the real IndexedDbDraftStorage.
// ---------------------------------------------------------------------------

class FakeIDBRequest<T> {
  onsuccess: ((event: { target: FakeIDBRequest<T> }) => void) | null = null;
  onerror: ((event: { target: FakeIDBRequest<T> }) => void) | null = null;
  onupgradeneeded: ((event: { target: FakeIDBRequest<T> }) => void) | null = null;
  result!: T;
  error: Error | null = null;

  succeed(value: T): void {
    this.result = value;
    void Promise.resolve().then(() => this.onsuccess?.({ target: this }));
  }

  fail(error: Error): void {
    this.error = error;
    void Promise.resolve().then(() => this.onerror?.({ target: this }));
  }

  upgrade(value: T): void {
    this.result = value;
    void Promise.resolve().then(() => {
      this.onupgradeneeded?.({ target: this });
      void Promise.resolve().then(() => this.onsuccess?.({ target: this }));
    });
  }
}

interface FakeIDBRecord {
  asset_revision_id: string;
}

/** Minimal IDBFactory stand-in: records real call traffic, emulates requests. */
class FakeIndexedDBFactory {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  private records = new Map<string, unknown>();
  quotaOnPut: Error | null = null;
  private db = {
    objectStoreNames: { contains: (name: string) => name === 'drafts' },
    createObjectStore: (_name: string, _options: unknown) => undefined,
    transaction: (_name: string, _mode: string) => ({
      objectStore: (_storeName: string) => ({
        get: (key: string) => {
          this.calls.push({ method: 'get', args: [key] });
          const request = new FakeIDBRequest<FakeIDBRecord | undefined>();
          request.succeed(this.records.get(key) as FakeIDBRecord | undefined);
          return request;
        },
        put: (value: FakeIDBRecord) => {
          this.calls.push({ method: 'put', args: [value] });
          const request = new FakeIDBRequest<FakeIDBRecord>();
          if (this.quotaOnPut) request.fail(this.quotaOnPut);
          else {
            this.records.set(value.asset_revision_id as string, value);
            request.succeed(value);
          }
          return request;
        },
        delete: (key: string) => {
          this.calls.push({ method: 'delete', args: [key] });
          const request = new FakeIDBRequest<undefined>();
          this.records.delete(key);
          request.succeed(undefined);
          return request;
        },
      }),
    }),
    close: () => {
      this.calls.push({ method: 'close', args: [] });
    },
  };

  open(name: string, version: number): FakeIDBRequest<unknown> {
    this.calls.push({ method: 'open', args: [name, version] });
    const request = new FakeIDBRequest<unknown>();
    request.upgrade(this.db);
    return request;
  }
}

// ---------------------------------------------------------------------------
// Queue fixture.
// ---------------------------------------------------------------------------

interface QueueFixture {
  queue: SaveQueue;
  clock: TestClock;
  transport: ControllableTransport;
  storage: InMemoryDraftStorage;
}

function makeQueue(getLease?: () => SaveRequest['lease']): QueueFixture {
  const clock = new TestClock();
  const transport = new ControllableTransport();
  const storage = new InMemoryDraftStorage();
  let counter = 0;
  const queue = new SaveQueue({
    transport,
    storage,
    clock,
    getLease,
    newOperationId: () => {
      counter += 1;
      return `op-${counter}`;
    },
  });
  return { queue, clock, transport, storage };
}

function enqueue(
  fixture: QueueFixture,
  options: {
    asset?: Id;
    generation: number;
    document: AnnotationDocument;
    base_revision_id?: Id;
    suggestion_decisions?: SuggestionDecisionIntent[];
  },
): void {
  fixture.queue.enqueue({
    asset_revision_id: options.asset ?? 'asset_a',
    ontology_version_id: 'ontology_v1',
    base_revision_id: options.base_revision_id,
    generation: options.generation,
    document: options.document,
    suggestion_decisions: options.suggestion_decisions,
  });
}

function makeRecord(overrides: Partial<DraftRecord> = {}): DraftRecord {
  return {
    schema_version: 1,
    asset_revision_id: 'asset_revision_golden',
    ontology_version_id: 'ontology_v1',
    base_revision_id: 'r7',
    generation: 9,
    document: makeDocument(),
    pending: null,
    intent_journal: [],
    synced_generation: 7,
    synced_intent_seq: 0,
    updated_at: '2026-09-26T00:00:00Z',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ===========================================================================
// Card entry case: pure reconcileAck.
// ===========================================================================

describe('T13 reconcileAck', () => {
  it('does not acknowledge a newer generation', () => {
    const state = {
      local_generation: 9,
      synced_generation: 7,
      base_revision_id: 'r7',
      in_flight: { generation: 8, operation_id: 'op8' },
    };
    const next = reconcileAck(state, { generation: 8, operation_id: 'op8', revision_id: 'r8' });
    expect(next.local_generation).toBe(9);
    expect(next.synced_generation).toBe(8);
    expect(next.base_revision_id).toBe('r8');
    expect(next.dirty).toBe(true);
  });

  it('ignores an acknowledgement for a different operation id', () => {
    const state = {
      local_generation: 8,
      synced_generation: 7,
      base_revision_id: 'r7',
      in_flight: { generation: 8, operation_id: 'op8' },
    };
    const next = reconcileAck(state, { generation: 8, operation_id: 'op-foreign', revision_id: 'rX' });
    expect(next.synced_generation).toBe(7);
    expect(next.base_revision_id).toBe('r7');
    expect(next.in_flight).toEqual({ generation: 8, operation_id: 'op8' });
    expect(next.dirty).toBe(true);
  });

  it('never regresses the synced base on a late older acknowledgement', () => {
    const state = {
      local_generation: 9,
      synced_generation: 8,
      base_revision_id: 'r8',
      in_flight: { generation: 7, operation_id: 'op7' },
    };
    const next = reconcileAck(state, { generation: 7, operation_id: 'op7', revision_id: 'r7' });
    expect(next.synced_generation).toBe(8);
    expect(next.base_revision_id).toBe('r8');
    expect(next.dirty).toBe(true);
  });
});

// ===========================================================================
// Behavior 1: generation-8 ACK while editing generation 9.
// ===========================================================================

describe('T13 behavior 1: stale ACK keeps a newer generation dirty', () => {
  it('keeps generation 9 dirty and saves it on top of the acknowledged r8', async () => {
    const fixture = makeQueue();
    const doc8 = makeDocument({ completion: 'in_progress' });
    const doc9 = makeDocument({ completion: 'complete' });

    enqueue(fixture, { generation: 8, document: doc8, base_revision_id: 'r7' });
    fixture.clock.advance(SAVE_DEBOUNCE_MS);
    expect(fixture.transport.saves).toHaveLength(1);
    expect(fixture.transport.saves[0].request.base_revision_id).toBe('r7');
    expect(fixture.transport.saves[0].request.operation_id).toBe('op-1');

    // The user keeps editing while the generation-8 request is still in flight.
    enqueue(fixture, { generation: 9, document: doc9 });
    fixture.transport.ackSave(0, 'r8');
    await microtasks();

    // The generation-8 ACK must not clear generation 9's dirty state.
    const afterAck: SaveStatusSnapshot = fixture.queue.getStatus('asset_a');
    expect(afterAck.local_generation).toBe(9);
    expect(afterAck.synced_generation).toBe(8);
    expect(afterAck.base_revision_id).toBe('r8');
    expect(afterAck.dirty).toBe(true);

    // The next request uses the acknowledged revision as base with the gen-9 payload.
    fixture.clock.advance(SAVE_DEBOUNCE_MS);
    expect(fixture.transport.saves).toHaveLength(2);
    const next = fixture.transport.saves[1].request;
    expect(next.base_revision_id).toBe('r8');
    expect(next.document).toEqual(doc9);
    expect(next.document).not.toEqual(doc8);
    expect(next.operation_id).toBe('op-2');
    // The acknowledged request still carries exactly its original payload.
    expect(fixture.transport.saves[0].request.document).toEqual(doc8);
  });
});

// ===========================================================================
// Behavior 2: immutable prepared payloads across retries.
// ===========================================================================

describe('T13 behavior 2: retry reuses the prepared operation', () => {
  it('re-sends the identical operation_id and payload on retry', async () => {
    const fixture = makeQueue();
    const doc8 = makeDocument();
    enqueue(fixture, { generation: 8, document: doc8, base_revision_id: 'r7' });
    fixture.clock.advance(SAVE_DEBOUNCE_MS);
    fixture.transport.failNetwork(0);
    await microtasks();
    expect(fixture.queue.getStatus('asset_a').phase).toBe('save_failed');

    void fixture.queue.retry('asset_a');
    expect(fixture.transport.saves).toHaveLength(2);
    const [first, second] = fixture.transport.saves.map((save) => save.request);
    expect(second.operation_id).toBe(first.operation_id);
    expect(second.operation_id).toBe('op-1');
    expect(second).toEqual(first);
  });

  it('creates a new operation_id for a new local modification and never swaps payloads', async () => {
    const fixture = makeQueue();
    const doc8 = makeDocument({ completion: 'in_progress' });
    const doc9 = makeDocument({ completion: 'complete' });
    enqueue(fixture, { generation: 8, document: doc8, base_revision_id: 'r7' });
    fixture.clock.advance(SAVE_DEBOUNCE_MS);
    fixture.transport.failNetwork(0);
    await microtasks();

    // New local modification: the prepared operation is replaced, not mutated.
    enqueue(fixture, { generation: 9, document: doc9 });
    void fixture.queue.retry('asset_a');
    expect(fixture.transport.saves).toHaveLength(2);
    const retried = fixture.transport.saves[1].request;
    expect(retried.operation_id).not.toBe('op-1');
    expect(retried.operation_id).toBe('op-2');
    expect(retried.document).toEqual(doc9);
    // The failed request keeps its original payload (immutable after preparation).
    expect(fixture.transport.saves[0].request.document).toEqual(doc8);

    // Invariant across everything sent so far: one operation_id, one payload.
    const payloads = new Map<string, SaveRequest>();
    for (const save of fixture.transport.saves) {
      const seen = payloads.get(save.request.operation_id);
      if (seen) expect(save.request).toEqual(seen);
      else payloads.set(save.request.operation_id, save.request);
    }
  });

  it('replays the same operation for a repeated acknowledgement-free retry after edits stopped', async () => {
    const fixture = makeQueue();
    enqueue(fixture, { generation: 8, document: makeDocument(), base_revision_id: 'r7' });
    fixture.clock.advance(SAVE_DEBOUNCE_MS);
    fixture.transport.failNetwork(0);
    await microtasks();
    void fixture.queue.retry('asset_a');
    fixture.transport.failNetwork(1);
    await microtasks();
    void fixture.queue.retry('asset_a');
    expect(fixture.transport.saves.map((save) => save.request.operation_id)).toEqual(['op-1', 'op-1', 'op-1']);
  });

  it('registers a fetched immutable head as an acknowledged baseline without replacing later local work', async () => {
    const fixture = makeQueue();
    const serverDocument = makeDocument({ asset_revision_id: 'asset_a' });
    expect(fixture.queue.initializeFromServerRevision({
      asset_revision_id: 'asset_a',
      ontology_version_id: 'ontology_v1',
      annotation_revision_id: 'server-r7',
      generation: 0,
      document: serverDocument,
    })).toBe(true);
    await fixture.queue.whenPersisted('asset_a');
    expect(fixture.queue.getStatus('asset_a')).toMatchObject({
      phase: 'synced', dirty: false, local_generation: 0, synced_generation: 0, base_revision_id: 'server-r7',
    });
    await fixture.queue.flush('asset_a');
    expect(fixture.transport.saves).toHaveLength(0);

    const localDocument = makeDocument({ asset_revision_id: 'asset_a', completion: 'complete' });
    enqueue(fixture, { asset: 'asset_a', generation: 1, document: localDocument });
    expect(fixture.queue.initializeFromServerRevision({
      asset_revision_id: 'asset_a',
      ontology_version_id: 'ontology_v1',
      annotation_revision_id: 'server-r8',
      generation: 0,
      document: serverDocument,
    })).toBe(false);
    expect(fixture.queue.toRecord('asset_a')?.document).toEqual(localDocument);
    expect(fixture.queue.getStatus('asset_a')).toMatchObject({ dirty: true, base_revision_id: 'server-r7' });
  });
  it('does not replace newer in-memory work with an older recovered record', () => {
    const fixture = makeQueue();
    const newerDocument = makeDocument({ asset_revision_id: 'asset_a', completion: 'complete' });
    enqueue(fixture, { asset: 'asset_a', generation: 9, document: newerDocument, base_revision_id: 'r7', suggestion_decisions: [ACCEPT] });
    const olderRecord = makeRecord({
      asset_revision_id: 'asset_a',
      ontology_version_id: 'ontology_v1',
      base_revision_id: 'r7',
      generation: 8,
      document: makeDocument({ asset_revision_id: 'asset_a' }),
      synced_generation: 7,
    });

    fixture.queue.restoreFromRecord(olderRecord);

    const live = fixture.queue.toRecord('asset_a');
    expect(live?.document).toEqual(newerDocument);
    expect(live?.generation).toBe(9);
    expect(live?.intent_journal.map((entry) => entry.intent)).toEqual([ACCEPT]);
    expect(fixture.queue.getStatus('asset_a')).toMatchObject({ dirty: true, base_revision_id: 'r7', local_generation: 9 });
  });


  it('a pending operation restored from a record stays frozen and keeps its identity across retry', async () => {
    // Produce a real prepared operation, then simulate a reload: JSON round-trip
    // (as IndexedDB structured-clone does) and restore into a fresh queue.
    const producing = makeQueue();
    enqueue(producing, { generation: 8, document: makeDocument(), base_revision_id: 'r7' });
    producing.clock.advance(SAVE_DEBOUNCE_MS);
    producing.transport.failNetwork(0);
    await microtasks();
    const record = producing.queue.toRecord('asset_a');
    expect(record?.pending).not.toBeNull();
    const reloaded = JSON.parse(JSON.stringify(record)) as DraftRecord;

    const fixture = makeQueue();
    fixture.queue.restoreFromRecord(reloaded);

    // The restored copy is frozen: mutation attempts throw.
    const live = fixture.queue.toRecord('asset_a');
    expect(() => {
      (live?.pending?.request as SaveRequest).base_revision_id = 'tampered';
    }).toThrow();
    // Mutating the caller's object after restore cannot reach the queue copy.
    (reloaded.pending?.request as SaveRequest).document = makeDocument({ completion: 'confirmed_negative' });

    void fixture.queue.retry('asset_a');
    expect(fixture.transport.saves).toHaveLength(1);
    const resent = fixture.transport.saves[0].request;
    expect(resent.operation_id).toBe(record?.pending?.operation_id);
    expect(resent).toEqual(record?.pending?.request);

    // The user keeps editing while the restored request is in flight; the ACK
    // lands and the new edit leaves through the normal debounced save path as a
    // brand-new operation on top of the acknowledged revision.
    enqueue(fixture, { generation: 9, document: makeDocument({ completion: 'complete' }) });
    fixture.transport.ackSave(0, 'r9');
    await microtasks();
    fixture.clock.advance(SAVE_DEBOUNCE_MS);
    expect(fixture.transport.saves).toHaveLength(2);
    const fresh = fixture.transport.saves[1].request;
    expect(fresh.operation_id).not.toBe(resent.operation_id);
    expect(fresh.operation_id).toBe('op-2');
    expect(fresh.base_revision_id).toBe('r9');
    expect(fresh.document).toEqual(makeDocument({ completion: 'complete' }));
  });
});

// ===========================================================================
// Behavior 3: storage failures vs network failures.
// ===========================================================================

describe('T13 behavior 3: storage and network failures stay distinct', () => {
  it('an IndexedDB quota failure never claims the draft is saved locally', async () => {
    const clock = new TestClock();
    const transport = new ControllableTransport();
    const factory = new FakeIndexedDBFactory();
    factory.quotaOnPut = Object.assign(new Error('quota exceeded'), { name: 'QuotaExceededError' });
    const storage = new IndexedDbDraftStorage(factory as unknown as IDBFactory);
    let counter = 0;
    const queue = new SaveQueue({
      transport,
      storage,
      clock,
      newOperationId: () => `op-${(counter += 1)}`,
    });

    queue.enqueue({
      asset_revision_id: 'asset_a',
      ontology_version_id: 'ontology_v1',
      base_revision_id: 'r7',
      generation: 8,
      document: makeDocument(),
    });
    await queue.whenPersisted('asset_a');

    const status = queue.getStatus('asset_a');
    expect(status.phase).toBe('storage_error');
    expect(status.phase).not.toBe('saved_local');
    expect(status.last_error).toMatchObject({ kind: 'storage', code: 'QUOTA_EXCEEDED' });
    // The real IndexedDB adapter really attempted the write and got the rejection.
    expect(factory.calls.some((call) => call.method === 'open')).toBe(true);
    expect(factory.calls.some((call) => call.method === 'put')).toBe(true);

    // The native draft is still downloadable from memory.
    const draft = queue.exportDraft('asset_a');
    expect(draft).not.toBeNull();
    expect(draft?.unsynced).toBe(true);
    expect(draft?.document).toEqual(makeDocument());
    expect(JSON.parse(serializeNativeDraft(draft as NativeDraftExport))).toEqual(draft);
  });

  it('a network failure keeps the draft record, pending operation and journal', async () => {
    const fixture = makeQueue();
    const doc8 = makeDocument();
    enqueue(fixture, {
      generation: 8,
      document: doc8,
      base_revision_id: 'r7',
      suggestion_decisions: [ACCEPT],
    });
    fixture.clock.advance(SAVE_DEBOUNCE_MS);
    fixture.transport.failNetwork(0);
    await microtasks();
    await fixture.queue.whenPersisted('asset_a');

    expect(fixture.queue.getStatus('asset_a').phase).toBe('save_failed');
    expect(fixture.queue.getStatus('asset_a').dirty).toBe(true);

    const stored = await fixture.storage.get('asset_a');
    expect(stored).not.toBeNull();
    expect(stored?.document).toEqual(doc8);
    expect(stored?.pending?.operation_id).toBe('op-1');
    expect(stored?.intent_journal.map((entry) => entry.intent)).toEqual([ACCEPT]);

    const draft = fixture.queue.exportDraft('asset_a');
    expect(draft?.unsynced).toBe(true);
    expect(draft?.pending_operation_id).toBe('op-1');
  });
});

// ===========================================================================
// Behavior 4: refresh recovery compares against the server head, no LWW.
// ===========================================================================

describe('T24 recovery pause preserves local work', () => {
  it.each([2, 0])('ignores recovery captured before a generation %s pending/journal ACK', async (generation) => {
    const fixture = makeQueue();
    const document = makeDocument({ asset_revision_id: 'asset_a', completion: 'complete' });
    enqueue(fixture, { generation, document, base_revision_id: 'r0', suggestion_decisions: [ACCEPT] });
    const saving = fixture.queue.flush('asset_a');
    await fixture.queue.whenPersisted('asset_a');
    const pending = await fixture.storage.get('asset_a');
    expect(pending).toMatchObject({ generation, synced_generation: 0, synced_intent_seq: 0, pending: { operation_id: 'op-1' } });
    let releaseHead!: (head: AnnotationRevision) => void;
    const fetchingHead = new Promise<AnnotationRevision>((resolve) => { releaseHead = resolve; });
    const fetchHead = vi.spyOn(fixture.transport, 'fetchHead').mockReturnValueOnce(fetchingHead);
    const recovery = runRecovery({ storage: fixture.storage, transport: fixture.transport }, 'asset_a');
    await microtasks();
    expect(fetchHead).toHaveBeenCalledOnce();
    // Recovery has read the pending record but is still awaiting the head.
    fixture.transport.ackSave(0, 'ack-r2');
    await saving;
    await fixture.queue.whenPersisted('asset_a');
    const acknowledged = fixture.queue.toRecord('asset_a');
    expect(acknowledged).toMatchObject({ document, generation, synced_generation: generation, synced_intent_seq: 1, base_revision_id: 'ack-r2', pending: null });
    releaseHead(makeRevision('ack-r2', document));
    const report = await recovery;
    expect(report.kind).toBe('conflict');
    if (report.kind !== 'conflict') throw new Error('expected stale conflict report');
    expect(report.record).toEqual(pending);
    fixture.queue.restoreFromRecord(report.record, true);
    expect(fixture.queue.getStatus('asset_a')).toMatchObject({ phase: 'synced', dirty: false, writes_paused: false, local_generation: generation, synced_generation: generation, base_revision_id: 'ack-r2' });
    expect(fixture.queue.toRecord('asset_a')).toEqual(acknowledged);
    await fixture.queue.flush('asset_a');
    await fixture.queue.retry('asset_a');
    fixture.clock.advance(SAVE_DEBOUNCE_MS * 2);
    await microtasks();
    expect(fixture.transport.saves).toHaveLength(1);
    expect(await fixture.storage.get('asset_a')).toEqual(acknowledged);
    const edited = makeDocument({ asset_revision_id: 'asset_a', objects: [] });
    enqueue(fixture, { generation: generation + 1, document: edited, suggestion_decisions: [REVERT] });
    const nextSave = fixture.queue.flush('asset_a');
    expect(fixture.transport.saves[1].request).toMatchObject({ operation_id: 'op-2', base_revision_id: 'ack-r2', document: edited, suggestion_decisions: [REVERT] });
    fixture.transport.ackSave(1, 'ack-next');
    await nextSave;
    await fixture.queue.whenPersisted('asset_a');
    expect(await fixture.storage.get('asset_a')).toMatchObject({ document: edited, synced_generation: generation + 1, synced_intent_seq: 2, base_revision_id: 'ack-next', pending: null });
  });

  it('restores a genuinely later draft over a clean generation-zero baseline', () => {
    const fixture = makeQueue();
    fixture.queue.initializeFromServerRevision({ asset_revision_id: 'asset_a', ontology_version_id: 'ontology_v1', annotation_revision_id: 'server-r0', generation: 0, document: makeDocument({ asset_revision_id: 'asset_a', objects: [] }) });
    const record = makeRecord({ asset_revision_id: 'asset_a', generation: 9, document: makeDocument({ asset_revision_id: 'asset_a' }) });
    fixture.queue.restoreFromRecord(record, true);
    expect(fixture.queue.toRecord('asset_a')).toMatchObject({ document: record.document, generation: 9, synced_generation: 7, base_revision_id: 'r7' });
    expect(fixture.queue.getStatus('asset_a')).toMatchObject({ dirty: true, writes_paused: true, local_generation: 9 });
  });
  it.each(['conflict', 'unreachable'] as const)('%s recovery waits for keep-local and sends every local object and intent', async (kind) => {
    const producing = makeQueue();
    const original = makeDocument({ asset_revision_id: 'asset_a' });
    enqueue(producing, { generation: 8, document: original, base_revision_id: 'r7', suggestion_decisions: [ACCEPT] });
    producing.clock.advance(SAVE_DEBOUNCE_MS);
    producing.transport.failNetwork(0);
    await microtasks();
    const record = JSON.parse(JSON.stringify(producing.queue.toRecord('asset_a'))) as DraftRecord;
    const fixture = makeQueue();
    fixture.transport.head = makeRevision('server-r9', makeDocument({ asset_revision_id: 'asset_a', objects: [] }));
    if (kind === 'unreachable') fixture.transport.headError = new Error('offline');
    await fixture.storage.put(record);
    expect((await runRecovery({ storage: fixture.storage, transport: fixture.transport }, 'asset_a')).kind).toBe(kind);
    fixture.queue.restoreFromRecord(record, true);
    expect(fixture.queue.toRecord('asset_a')).toMatchObject({ document: original, pending: record.pending, intent_journal: record.intent_journal });
    const edited = makeDocument({ asset_revision_id: 'asset_a', objects: [...original.objects, { ...original.objects[0], object_id: 'local_second' }] });
    enqueue(fixture, { generation: 9, document: edited, suggestion_decisions: [REVERT] });
    fixture.queue.switchAsset('asset_a');
    fixture.queue.switchAsset('asset_b');
    void fixture.queue.flush('asset_a');
    void fixture.queue.retry('asset_a');
    fixture.clock.advance(SAVE_DEBOUNCE_MS * 2);
    await microtasks();
    expect(fixture.transport.saves).toHaveLength(0);
    expect(fixture.queue.getStatus('asset_a')).toMatchObject({ writes_paused: true, dirty: true });
    await fixture.queue.whenPersisted('asset_a');
    expect(await fixture.storage.get('asset_a')).toMatchObject({ document: edited, pending: record.pending, intent_journal: [record.intent_journal[0], expect.objectContaining({ intent: REVERT })] });
    fixture.transport.headError = null;
    const resolution = await fixture.queue.resolveConflict('asset_a', 'keep_local_export');
    expect(resolution).toMatchObject({ resumed: true, base_revision_id: 'server-r9', export: { document: edited } });
    const sent = fixture.queue.flush('asset_a');
    expect(fixture.transport.saves).toHaveLength(1);
    expect(fixture.transport.saves[0].request).toMatchObject({ base_revision_id: 'server-r9', document: edited, suggestion_decisions: [ACCEPT, REVERT] });
    fixture.transport.ackSave(0, 'saved-local');
    await sent;
    await fixture.queue.whenPersisted('asset_a');
    expect(await fixture.storage.get('asset_a')).toMatchObject({ document: edited, generation: 9, synced_generation: 9, intent_journal: [record.intent_journal[0], expect.objectContaining({ intent: REVERT })] });
  });

  it.each([false, true])('pauses existing memory without replacing it (in flight: %s)', async (inFlight) => {
    const fixture = makeQueue();
    const document = makeDocument({ asset_revision_id: 'asset_a', completion: 'complete' });
    enqueue(fixture, { generation: 9, document, base_revision_id: 'memory-r8', suggestion_decisions: [ACCEPT] });
    if (inFlight) fixture.clock.advance(SAVE_DEBOUNCE_MS);
    const before = fixture.queue.toRecord('asset_a');
    const listener = vi.fn();
    fixture.queue.subscribe('asset_a', listener);
    fixture.queue.restoreFromRecord(makeRecord({ asset_revision_id: 'asset_a', generation: 1 }), true);
    expect(fixture.queue.toRecord('asset_a')).toEqual(before);
    expect(listener).toHaveBeenCalled();
    expect(fixture.queue.getStatus('asset_a').writes_paused).toBe(true);
    await fixture.queue.whenPersisted('asset_a');
    expect(await fixture.storage.get('asset_a')).toEqual(before);
    if (inFlight) {
      enqueue(fixture, { generation: 10, document, suggestion_decisions: [REVERT] });
      fixture.transport.ackSave(0, 'ack-r9');
      await microtasks();
      expect(fixture.queue.getStatus('asset_a')).toMatchObject({ writes_paused: true, dirty: true, synced_generation: 9, local_generation: 10 });
    }
    void fixture.queue.flush('asset_a');
    void fixture.queue.retry('asset_a');
    fixture.clock.advance(SAVE_DEBOUNCE_MS * 2);
    await microtasks();
    expect(fixture.transport.saves).toHaveLength(inFlight ? 1 : 0);
    expect(fixture.queue.toRecord('asset_a')?.document).toEqual(document);
  });
});

describe('T13 behavior 4: recovery compares against the server head', () => {
  it('auto-restores only when the record base is the server head', () => {
    const record = makeRecord({ base_revision_id: 'r7', generation: 9, synced_generation: 7 });
    const head = makeRevision('r7', makeDocument({ completion: 'complete' }));
    const report = compareWithServer(record, head);
    expect(report.kind).toBe('restored');
  });

  it('a diverged head is a conflict offering keep-local/export and view-server, never last-write-wins', async () => {
    const fixture = makeQueue();
    const record = makeRecord({ base_revision_id: 'r7', generation: 9, synced_generation: 7 });
    const serverDocument = makeDocument({ completion: 'complete' });
    const head = makeRevision('r8', serverDocument);
    const before = JSON.stringify(record);

    const report = compareWithServer(record, head);
    expect(report.kind).toBe('conflict');
    if (report.kind !== 'conflict') throw new Error('expected conflict');
    expect(report.options).toEqual(RECOVERY_CONFLICT_OPTIONS);
    expect(report.options).toEqual(['keep_local_export', 'view_server']);
    expect(report.server_head).toEqual(head);
    // Pure classification: the local record is untouched and nothing is written.
    expect(JSON.stringify(record)).toBe(before);

    await fixture.storage.put(record);
    fixture.transport.head = head;
    const runtimeReport = await runRecovery({ storage: fixture.storage, transport: fixture.transport }, record.asset_revision_id);
    expect(runtimeReport.kind).toBe('conflict');
    expect(fixture.transport.saves).toHaveLength(0);
    expect(fixture.transport.headCalls).toHaveLength(1);

    // Both offered paths are read-only or local-only.
    const exportPayload = keepLocalExport(record);
    expect(exportPayload.unsynced).toBe(true);
    expect(exportPayload.document).toEqual(record.document);
    const viewed = await viewServerVersion(fixture.transport, record);
    expect(viewed).toEqual(head);
    expect(fixture.transport.saves).toHaveLength(0);
  });

  it('keeps the draft and offers the export when the server is unreachable', async () => {
    const fixture = makeQueue();
    const record = makeRecord();
    await fixture.storage.put(record);
    fixture.transport.headError = new TransportError({
      kind: 'network',
      message: 'offline',
      code: 'NETWORK_UNREACHABLE',
    });
    const report = await runRecovery({ storage: fixture.storage, transport: fixture.transport }, record.asset_revision_id);
    expect(report.kind).toBe('unreachable');
    if (report.kind !== 'unreachable') throw new Error('expected unreachable');
    expect(report.record.document).toEqual(record.document);
    expect(keepLocalExport(report.record).unsynced).toBe(true);
    expect(hasUnsyncedWork(report.record)).toBe(true);
  });

  it('reports clean and missing records without touching the server', async () => {
    const fixture = makeQueue();
    const synced = makeRecord({ generation: 9, synced_generation: 9 });
    expect(hasUnsyncedWork(synced)).toBe(false);
    expect(compareWithServer(synced, makeRevision('rX')).kind).toBe('clean');

    const report = await runRecovery({ storage: fixture.storage, transport: fixture.transport }, 'asset_absent');
    expect(report.kind).toBe('no_local_record');
    expect(fixture.transport.headCalls).toHaveLength(0);
  });
});

// ===========================================================================
// Behavior 5: ordered decision journal across debounce flushes.
// ===========================================================================

describe('T13 behavior 5: decision journal survives debounce flushes', () => {
  it('keeps accept → undo → redo ordered and unmerged across two flushes', async () => {
    const fixture = makeQueue();
    enqueue(fixture, {
      generation: 8,
      document: makeDocument(),
      base_revision_id: 'r7',
      suggestion_decisions: [ACCEPT],
    });
    fixture.clock.advance(SAVE_DEBOUNCE_MS);
    fixture.transport.ackSave(0, 'r8');
    await microtasks();

    // undo produces a revert intent, redo a fresh accept intent.
    enqueue(fixture, { generation: 9, document: makeDocument(), suggestion_decisions: [REVERT] });
    enqueue(fixture, { generation: 10, document: makeDocument(), suggestion_decisions: [ACCEPT] });
    fixture.clock.advance(SAVE_DEBOUNCE_MS);

    expect(fixture.transport.saves).toHaveLength(2);
    expect(fixture.transport.saves[0].request.suggestion_decisions).toEqual([ACCEPT]);
    expect(fixture.transport.saves[1].request.suggestion_decisions).toEqual([REVERT, ACCEPT]);

    // The journal keeps the full ordered sequence (nothing merged or dropped).
    const record = fixture.queue.toRecord('asset_a');
    expect(record?.intent_journal.map((entry) => entry.intent.decision)).toEqual([
      'accept',
      'revert',
      'accept',
    ]);
    expect(record?.intent_journal.map((entry) => entry.seq)).toEqual([1, 2, 3]);
  });

  it('carries all three intents in order inside a single debounce window', () => {
    const fixture = makeQueue();
    enqueue(fixture, {
      generation: 8,
      document: makeDocument(),
      base_revision_id: 'r7',
      suggestion_decisions: [ACCEPT],
    });
    enqueue(fixture, { generation: 9, document: makeDocument(), suggestion_decisions: [REVERT] });
    enqueue(fixture, { generation: 10, document: makeDocument(), suggestion_decisions: [ACCEPT] });
    fixture.clock.advance(SAVE_DEBOUNCE_MS);

    expect(fixture.transport.saves).toHaveLength(1);
    expect(fixture.transport.saves[0].request.suggestion_decisions).toEqual([ACCEPT, REVERT, ACCEPT]);
    expect(fixture.transport.saves[0].request.document).toEqual(makeDocument());
  });
});

// ===========================================================================
// Behavior 6: debounce, per-asset single flight, asset switch, indicator.
// ===========================================================================

describe('T13 behavior 6: debounce, single flight and asset switching', () => {
  it('waits the full 400ms logical-operation debounce window', () => {
    const fixture = makeQueue();
    enqueue(fixture, { generation: 8, document: makeDocument(), base_revision_id: 'r7' });
    fixture.clock.advance(SAVE_DEBOUNCE_MS - 1);
    expect(fixture.transport.saves).toHaveLength(0);
    fixture.clock.advance(1);
    expect(fixture.transport.saves).toHaveLength(1);
    expect(fixture.transport.saves[0].request.document).toEqual(makeDocument());
  });

  it('coalesces rapid logical operations into one request with the latest payload', () => {
    const fixture = makeQueue();
    const doc1 = makeDocument({ completion: 'unprocessed' });
    const doc2 = makeDocument({ completion: 'complete' });
    enqueue(fixture, { generation: 8, document: doc1, base_revision_id: 'r7' });
    fixture.clock.advance(SAVE_DEBOUNCE_MS - 1);
    enqueue(fixture, { generation: 9, document: doc2 });
    fixture.clock.advance(SAVE_DEBOUNCE_MS - 1);
    expect(fixture.transport.saves).toHaveLength(0);
    fixture.clock.advance(1);
    expect(fixture.transport.saves).toHaveLength(1);
    expect(fixture.transport.saves[0].request.document).toEqual(doc2);
  });

  it('sends one request per asset at a time while other assets keep flowing', async () => {
    const fixture = makeQueue();
    enqueue(fixture, { asset: 'asset_a', generation: 8, document: makeDocument(), base_revision_id: 'r7' });
    enqueue(fixture, { asset: 'asset_b', generation: 8, document: makeDocument(), base_revision_id: 'r7b' });
    fixture.clock.advance(SAVE_DEBOUNCE_MS);
    expect(fixture.transport.saves).toHaveLength(2);
    expect(fixture.transport.requestsFor('asset_a')).toHaveLength(1);
    expect(fixture.transport.requestsFor('asset_b')).toHaveLength(1);

    // Local edits while both requests are in flight: still single flight per asset.
    enqueue(fixture, { asset: 'asset_a', generation: 9, document: makeDocument() });
    enqueue(fixture, { asset: 'asset_b', generation: 9, document: makeDocument() });
    fixture.clock.advance(SAVE_DEBOUNCE_MS * 2);
    expect(fixture.transport.saves).toHaveLength(2);

    // asset_b's ACK unblocks only asset_b's follow-up; asset_a stays in flight.
    fixture.transport.ackSave(1, 'r8b');
    await microtasks();
    fixture.clock.advance(SAVE_DEBOUNCE_MS);
    expect(fixture.transport.saves).toHaveLength(3);
    const bNext = fixture.transport.saves[2];
    expect(bNext.asset_revision_id).toBe('asset_b');
    expect(bNext.request.base_revision_id).toBe('r8b');
    expect(fixture.transport.requestsFor('asset_a')).toHaveLength(1);

    // Now asset_a's ACK releases its follow-up with its own new base.
    fixture.transport.ackSave(0, 'r8a');
    await microtasks();
    fixture.clock.advance(SAVE_DEBOUNCE_MS);
    expect(fixture.transport.saves).toHaveLength(4);
    const aNext = fixture.transport.saves[3];
    expect(aNext.asset_revision_id).toBe('asset_a');
    expect(aNext.request.base_revision_id).toBe('r8a');
  });

  it('flushes the previous asset on switch and keeps its background queue alive', async () => {
    const fixture = makeQueue();
    fixture.queue.switchAsset('asset_a');
    enqueue(fixture, { asset: 'asset_a', generation: 8, document: makeDocument(), base_revision_id: 'r7' });
    fixture.clock.advance(200);
    expect(fixture.transport.saves).toHaveLength(0);

    // Switching away flushes asset_a immediately, bypassing the debounce window.
    fixture.queue.switchAsset('asset_b');
    expect(fixture.transport.saves).toHaveLength(1);
    expect(fixture.transport.saves[0].asset_revision_id).toBe('asset_a');

    // The new asset keeps its own queue and debounce.
    enqueue(fixture, { asset: 'asset_b', generation: 8, document: makeDocument(), base_revision_id: 'r7b' });
    fixture.clock.advance(SAVE_DEBOUNCE_MS);
    expect(fixture.transport.saves).toHaveLength(2);

    // asset_a's background queue continues after its ACK although asset_b is active.
    enqueue(fixture, { asset: 'asset_a', generation: 9, document: makeDocument() });
    fixture.clock.advance(SAVE_DEBOUNCE_MS);
    expect(fixture.transport.requestsFor('asset_a')).toHaveLength(1);
    fixture.transport.ackSave(0, 'r8');
    await microtasks();
    fixture.clock.advance(SAVE_DEBOUNCE_MS);
    const aSaves = fixture.transport.requestsFor('asset_a');
    expect(aSaves).toHaveLength(2);
    expect(aSaves[1].request.base_revision_id).toBe('r8');
    expect(fixture.queue.getStatus('asset_b').dirty).toBe(true);
  });

  it('debounces through the production clock under vi fake timers', async () => {
    vi.useFakeTimers();
    const transport = new ControllableTransport();
    const storage = new InMemoryDraftStorage();
    let counter = 0;
    // No injected clock: this drives the production realClock seam itself.
    const queue = new SaveQueue({
      transport,
      storage,
      newOperationId: () => `op-${(counter += 1)}`,
    });
    queue.enqueue({
      asset_revision_id: 'asset_a',
      ontology_version_id: 'ontology_v1',
      base_revision_id: 'r7',
      generation: 8,
      document: makeDocument(),
    });
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 1);
    expect(transport.saves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.saves).toHaveLength(1);
    expect(transport.saves[0].request.operation_id).toBe('op-1');
  });

  it('the unsaved indicator reflects the real queue state', async () => {
    const fixture = makeQueue();
    render(
      createElement(SaveStatus, {
        queue: fixture.queue,
        asset_revision_id: 'asset_a',
      }),
    );
    const status = () => screen.getByTestId('save-status');
    expect(status()).toHaveAttribute('data-phase', 'idle');
    expect(status()).toHaveAttribute('data-dirty', 'false');

    await act(async () => {
      enqueue(fixture, { generation: 8, document: makeDocument(), base_revision_id: 'r7' });
      await fixture.queue.whenPersisted('asset_a');
    });
    expect(status()).toHaveAttribute('data-phase', 'saved_local');
    expect(status()).toHaveAttribute('data-dirty', 'true');

    await act(async () => {
      fixture.clock.advance(SAVE_DEBOUNCE_MS);
    });
    expect(status()).toHaveAttribute('data-phase', 'saving');

    await act(async () => {
      fixture.transport.ackSave(0, 'r8');
      await microtasks();
    });
    expect(status()).toHaveAttribute('data-phase', 'synced');
    expect(status()).toHaveAttribute('data-dirty', 'false');
  });

  it('the indicator keeps the dirty flag after a stale ACK and shows the failed save', async () => {
    const fixture = makeQueue();
    render(createElement(SaveStatus, { queue: fixture.queue, asset_revision_id: 'asset_a' }));
    const status = () => screen.getByTestId('save-status');

    await act(async () => {
      enqueue(fixture, { generation: 8, document: makeDocument(), base_revision_id: 'r7' });
      fixture.clock.advance(SAVE_DEBOUNCE_MS);
    });
    await act(async () => {
      enqueue(fixture, { generation: 9, document: makeDocument() });
      fixture.transport.ackSave(0, 'r8');
      await microtasks();
    });
    expect(status()).toHaveAttribute('data-dirty', 'true');
    expect(status()).toHaveAttribute('data-phase', 'saved_local');

    await act(async () => {
      fixture.clock.advance(SAVE_DEBOUNCE_MS);
      fixture.transport.failNetwork(1);
      await microtasks();
    });
    expect(status()).toHaveAttribute('data-phase', 'save_failed');
    expect(status()).toHaveTextContent(/草稿已保留/);
  });
});

// ===========================================================================
// Behavior 7: IndexedDB record schema + native draft rescue.
// ===========================================================================

describe('T13 behavior 7: draft record schema and rescue export', () => {
  it('persists schema_version, base_revision_id, generation, document, pending and the intent journal', async () => {
    const fixture = makeQueue();
    const doc9 = makeDocument({ completion: 'complete' });
    enqueue(fixture, {
      generation: 9,
      document: doc9,
      base_revision_id: 'r7',
      suggestion_decisions: [ACCEPT, REVERT],
    });
    fixture.clock.advance(SAVE_DEBOUNCE_MS);
    await fixture.queue.whenPersisted('asset_a');

    const record = await fixture.storage.get('asset_a');
    expect(record).not.toBeNull();
    expect(record?.schema_version).toBe(1);
    expect(record?.base_revision_id).toBe('r7');
    expect(record?.generation).toBe(9);
    expect(record?.document).toEqual(doc9);
    expect(record?.pending?.operation_id).toBe('op-1');
    expect(record?.pending?.request.operation_id).toBe('op-1');
    expect(record?.intent_journal.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(record?.intent_journal.map((entry) => entry.intent)).toEqual([ACCEPT, REVERT]);
    expect(record?.synced_generation).toBe(0);
    expect(record?.synced_intent_seq).toBe(0);

    // Round trip through the storage seam preserves the record exactly.
    const reread = await fixture.storage.get('asset_a');
    expect(reread).toEqual(record);

    // The prepared request is frozen in the live queue state: mutation attempts throw.
    const live = fixture.queue.toRecord('asset_a');
    expect(() => {
      (live?.pending?.request as SaveRequest).base_revision_id = 'tampered';
    }).toThrow();
  });

  it('stores real DraftStore writes and recovers them through load', async () => {
    const storage = new InMemoryDraftStorage();
    const store = new DraftStore(storage);
    const record = makeRecord();
    const saved = await store.save(record);
    expect(saved).toEqual(record);
    expect(await store.load(record.asset_revision_id)).toEqual(record);
    await store.remove(record.asset_revision_id);
    expect(await store.load(record.asset_revision_id)).toBeNull();
  });

  it('keeps the native draft downloadable when the storage write failed', async () => {
    const fixture = makeQueue();
    fixture.storage.failNextPut(
      new StorageError({ code: 'QUOTA_EXCEEDED', message: 'quota exceeded' }),
    );
    enqueue(fixture, { generation: 8, document: makeDocument(), base_revision_id: 'r7' });
    await fixture.queue.whenPersisted('asset_a');

    expect(fixture.queue.getStatus('asset_a').phase).toBe('storage_error');
    const draft = fixture.queue.exportDraft('asset_a');
    expect(draft?.format).toBe('weblabel-native-draft');
    expect(draft?.unsynced).toBe(true);
    expect(draft?.document).toEqual(makeDocument());
    const text = serializeNativeDraft(draft as NativeDraftExport);
    expect(text).toContain('"unsynced":true');
    expect(exportNativeDraft(fixture.queue.toRecord('asset_a') as DraftRecord, fixture.clock)).toEqual(draft);
  });
});

// ===========================================================================
// Behavior 8: HTTP 409 stops automatic writes until user resolution.
// ===========================================================================

describe('T13 behavior 8: HTTP 409 pauses automatic writes', () => {
  async function pauseOnConflict(): Promise<{
    fixture: QueueFixture;
    doc9: AnnotationDocument;
  }> {
    const fixture = makeQueue();
    const doc9 = makeDocument({ completion: 'complete' });
    enqueue(fixture, { generation: 8, document: makeDocument(), base_revision_id: 'r7' });
    fixture.clock.advance(SAVE_DEBOUNCE_MS);
    fixture.transport.failHttp(0, 409, 'REVISION_CONFLICT');
    await microtasks();
    expect(fixture.queue.getStatus('asset_a').phase).toBe('conflict');
    expect(fixture.queue.getStatus('asset_a').writes_paused).toBe(true);
    enqueue(fixture, { generation: 9, document: doc9 });
    return { fixture, doc9 };
  }

  it('stops automatic writes (and manual retry) until the user resolves', async () => {
    const { fixture, doc9 } = await pauseOnConflict();

    fixture.clock.advance(SAVE_DEBOUNCE_MS * 10);
    expect(fixture.transport.saves).toHaveLength(1);
    void fixture.queue.retry('asset_a');
    expect(fixture.transport.saves).toHaveLength(1);

    // "View server version" is read-only and does not resume writes.
    fixture.transport.head = makeRevision('r8s', makeDocument());
    const viewed = await fixture.queue.resolveConflict('asset_a', 'view_server');
    expect(viewed.action).toBe('view_server');
    expect(fixture.transport.saves).toHaveLength(1);
    fixture.clock.advance(SAVE_DEBOUNCE_MS * 10);
    expect(fixture.transport.saves).toHaveLength(1);

    // Explicit "keep local" resolution resumes writes on top of the observed head.
    const resolution = await fixture.queue.resolveConflict('asset_a', 'keep_local_export');
    expect(resolution.action).toBe('keep_local_export');
    if (resolution.action !== 'keep_local_export') throw new Error('expected keep_local_export');
    expect(resolution.base_revision_id).toBe('r8s');
    expect(resolution.export.unsynced).toBe(true);
    expect(resolution.export.document).toEqual(doc9);

    fixture.clock.advance(SAVE_DEBOUNCE_MS);
    expect(fixture.transport.saves).toHaveLength(2);
    const resumed = fixture.transport.saves[1].request;
    expect(resumed.base_revision_id).toBe('r8s');
    expect(resumed.document).toEqual(doc9);
    // A fresh operation: the 409'd request keeps its original payload.
    expect(resumed.operation_id).toBe('op-2');
    expect(fixture.transport.saves[0].request.base_revision_id).toBe('r7');
    expect(fixture.queue.getStatus('asset_a').writes_paused).toBe(false);
  });

  it('adopting the server version explicitly discards the local draft and resumes', async () => {
    const { fixture } = await pauseOnConflict();
    const serverDocument = makeDocument({ completion: 'unprocessed' });
    fixture.transport.head = makeRevision('r8s', serverDocument);

    const resolution = await fixture.queue.resolveConflict('asset_a', 'adopt_server');
    expect(resolution).toEqual({ action: 'adopt_server', base_revision_id: 'r8s' });
    expect(fixture.queue.getStatus('asset_a').dirty).toBe(false);
    expect(fixture.queue.getStatus('asset_a').phase).toBe('synced');
    expect(fixture.queue.toRecord('asset_a')?.document).toEqual(serverDocument);

    fixture.clock.advance(SAVE_DEBOUNCE_MS);
    expect(fixture.transport.saves).toHaveLength(1);
  });
});
describe('T26 save lease recovery', () => {
  it('rebuilds a definitively rejected save with the acquired lease and a fresh operation id', async () => {
    let lease: SaveRequest['lease'] = null;
    const fixture = makeQueue(() => lease);
    enqueue(fixture, { generation: 8, document: makeDocument(), base_revision_id: 'r7' });
    fixture.clock.advance(SAVE_DEBOUNCE_MS);
    fixture.transport.failHttp(0, 409, 'LEASE_REQUIRED');
    await microtasks();

    expect(fixture.queue.getStatus('asset_a').writes_paused).toBe(true);
    expect(fixture.transport.saves[0].request.lease).toBeNull();
    const rejectedOperationId = fixture.transport.saves[0].request.operation_id;

    lease = { task_id: 'task-a', fencing_token: 42 };
    const retry = fixture.queue.retryRejectedLease('asset_a');
    await microtasks();
    expect(fixture.transport.saves).toHaveLength(2);
    expect(fixture.transport.saves[1].request.lease).toEqual(lease);
    expect(fixture.transport.saves[1].request.operation_id).not.toBe(rejectedOperationId);
    fixture.transport.ackSave(1, 'r8');
    await retry;

    expect(fixture.queue.getStatus('asset_a').phase).toBe('synced');
    expect(fixture.queue.getStatus('asset_a').dirty).toBe(false);
  });
});

// ===========================================================================
// Production transport over fetch (T11 save API).
// ===========================================================================

describe('T13 fetch transport against the T11 API', () => {
  function makeFetchTransport(
    impl: (url: string, init: RequestInit) => Promise<Response>,
  ): { transport: FetchSaveTransport; calls: Array<{ url: string; init: RequestInit }> } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const transport = new FetchSaveTransport({
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return impl(String(url), init ?? {});
      }) as typeof fetch,
      csrfToken: () => 'csrf-token-001',
    });
    return { transport, calls };
  }

  const request: SaveRequest = {
    operation_id: 'op-1',
    base_revision_id: 'r7',
    document: makeDocument(),
    lease: null,
    suggestion_decisions: [ACCEPT],
  };

  it('PUTs the SaveRequest with the session CSRF header and returns the SaveResponse', async () => {
    const { transport, calls } = makeFetchTransport(async () =>
      new Response(
        JSON.stringify({
          operation_id: 'op-1',
          revision: makeRevision('r8', request.document, 2),
          idempotent_replay: false,
        }),
        { status: 200 },
      ),
    );
    const response = await transport.save(request, 'asset_revision_golden');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/assets/asset_revision_golden/annotation');
    expect(calls[0].init.method).toBe('PUT');
    expect((calls[0].init.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-token-001');
    expect(JSON.parse(String(calls[0].init.body))).toEqual(request);
    expect(response.revision.annotation_revision_id).toBe('r8');
  });

  it('maps 409, other HTTP failures and network failures to structured transport errors', async () => {
    const { transport } = makeFetchTransport(async () =>
      new Response(
        JSON.stringify({
          code: 'REVISION_CONFLICT',
          message: 'base_revision_id is not the current annotation head',
          request_id: 'req-1',
          details: null,
        }),
        { status: 409 },
      ),
    );
    await expect(transport.save(request, 'asset_a')).rejects.toMatchObject({
      kind: 'conflict',
      status: 409,
      code: 'REVISION_CONFLICT',
    });

    const serverError = makeFetchTransport(async () =>
      new Response(
        JSON.stringify({ code: 'ANNOTATION_READ_FAILED', message: 'boom', request_id: 'req-2', details: null }),
        { status: 500 },
      ),
    );
    await expect(serverError.transport.save(request, 'asset_a')).rejects.toMatchObject({
      kind: 'http',
      status: 500,
      code: 'ANNOTATION_READ_FAILED',
    });

    const offline = makeFetchTransport(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(offline.transport.save(request, 'asset_a')).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it('reads the head revision and reports a missing head as null', async () => {
    const { transport, calls } = makeFetchTransport(async () =>
      new Response(JSON.stringify(makeRevision('r7')), { status: 200 }),
    );
    const head = await transport.fetchHead('asset_a', 'ontology_v1');
    expect(head?.annotation_revision_id).toBe('r7');
    expect(calls[0].url).toBe('/api/assets/asset_a/annotation?ontology_version_id=ontology_v1');

    const missing = makeFetchTransport(async () =>
      new Response(
        JSON.stringify({ code: 'ANNOTATION_NOT_FOUND', message: 'gone', request_id: 'req-3', details: null }),
        { status: 404 },
      ),
    );
    expect(await missing.transport.fetchHead('asset_a', 'ontology_v1')).toBeNull();
  });
});

// ===========================================================================
// SaveStatus surface: failure and conflict banners (test ids per
// docs/testing-contracts.md §3).
// ===========================================================================

describe('T13 SaveStatus rescue and conflict surfaces', () => {
  it('shows a storage failure with the draft download and never claims local save', async () => {
    const fixture = makeQueue();
    const exported: NativeDraftExport[] = [];
    render(
      createElement(SaveStatus, {
        queue: fixture.queue,
        asset_revision_id: 'asset_a',
        onExportDraft: (draft) => exported.push(draft),
      }),
    );
    await act(async () => {
      fixture.storage.failNextPut(
        new StorageError({ code: 'QUOTA_EXCEEDED', message: 'quota exceeded' }),
      );
      enqueue(fixture, { generation: 8, document: makeDocument(), base_revision_id: 'r7' });
      await fixture.queue.whenPersisted('asset_a');
    });

    const status = screen.getByTestId('save-status');
    expect(status).toHaveAttribute('data-phase', 'storage_error');
    expect(status).not.toHaveTextContent(/已保存到本地/);

    fireEvent.click(screen.getByTestId('export-local-draft'));
    expect(exported).toHaveLength(1);
    expect(exported[0].unsynced).toBe(true);
    expect(exported[0].document).toEqual(makeDocument());
  });

  it('offers keep-local/export and view-server on a recovery conflict without auto-resolving', async () => {
    const fixture = makeQueue();
    const record = makeRecord({ base_revision_id: 'r7', generation: 9, synced_generation: 7 });
    const head = makeRevision('r8', makeDocument({ completion: 'complete' }));
    const report = compareWithServer(record, head);
    if (report.kind !== 'conflict') throw new Error('expected conflict');

    const exported: NativeDraftExport[] = [];
    const viewed: Array<AnnotationRevision | null> = [];
    fixture.transport.head = head;
    fixture.queue.restoreFromRecord(record);

    render(
      createElement(SaveStatus, {
        queue: fixture.queue,
        asset_revision_id: record.asset_revision_id,
        recovery: report,
        onExportDraft: (draft) => exported.push(draft),
        onViewServer: (revision) => viewed.push(revision),
      }),
    );
    expect(screen.getByTestId('recovery-banner')).toBeInTheDocument();
    expect(screen.getByTestId('conflict-banner')).toBeInTheDocument();
    // Recovery itself never wrote anything.
    expect(fixture.transport.saves).toHaveLength(0);

    fireEvent.click(screen.getByTestId('conflict-view-server'));
    await act(async () => {
      await microtasks();
    });
    expect(viewed).toEqual([head]);
    expect(fixture.transport.saves).toHaveLength(0);

    fireEvent.click(screen.getByTestId('conflict-keep-local'));
    await act(async () => {
      await microtasks();
    });
    expect(exported).toHaveLength(1);
    expect(exported[0].document).toEqual(record.document);
    // The explicit keep-local resolution resumes automatic writes on the new base.
    fixture.clock.advance(SAVE_DEBOUNCE_MS);
    expect(fixture.transport.saves).toHaveLength(1);
    expect(fixture.transport.saves[0].request.base_revision_id).toBe('r8');
    expect(fixture.transport.saves[0].request.document).toEqual(record.document);
  });
});
