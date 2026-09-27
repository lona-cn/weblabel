// T13 · per-asset single-flight save queue with a logical-operation debounce
// and immutable prepared payloads (C1 save + decision journal, C3 generation).
import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import type { ApiError } from '../../../../../packages/contracts/generated/ApiError';
import type { SaveRequest } from '../../../../../packages/contracts/generated/SaveRequest';
import type { SaveResponse } from '../../../../../packages/contracts/generated/SaveResponse';

import { DraftStore, exportNativeDraft, freezeDeep } from './draft-store';
import type {
  Clock,
  ConflictAction,
  ConflictResolution,
  DraftRecord,
  EnqueueInput,
  Id,
  IntentJournalEntry,
  NativeDraftExport,
  PendingOperation,
  SavePhase,
  SaveQueueOptions,
  SaveStatusSnapshot,
  SaveTransport,
} from './types';
import { SAVE_DEBOUNCE_MS, StorageError, TransportError, realClock } from './types';

// ---------------------------------------------------------------------------
// Pure ACK reconciliation (card T13 "测试输入与断言起点").
// ---------------------------------------------------------------------------

export interface ReconcileState {
  local_generation: number;
  synced_generation: number;
  base_revision_id: Id;
  in_flight: { generation: number; operation_id: Id } | null;
}

export interface AckEvent {
  generation: number;
  operation_id: Id;
  revision_id: Id;
}

export interface ReconcileResult extends ReconcileState {
  dirty: boolean;
}

/**
 * Applies one save acknowledgement. An ACK only acknowledges the operation it
 * belongs to: a stale or foreign ACK changes nothing, a late older ACK never
 * regresses the synced base, and an ACK for generation 8 while generation 9 is
 * already local keeps generation 9 dirty.
 */
export function reconcileAck(state: ReconcileState, ack: AckEvent): ReconcileResult {
  const dirty = (local: number, synced: number) => local > synced;
  const unchanged: ReconcileResult = {
    local_generation: state.local_generation,
    synced_generation: state.synced_generation,
    base_revision_id: state.base_revision_id,
    in_flight: state.in_flight,
    dirty: dirty(state.local_generation, state.synced_generation),
  };
  if (state.in_flight === null || state.in_flight.operation_id !== ack.operation_id) {
    return unchanged;
  }
  if (ack.generation < state.synced_generation) {
    return unchanged;
  }
  const synced_generation = Math.max(state.synced_generation, ack.generation);
  return {
    local_generation: state.local_generation,
    synced_generation,
    base_revision_id: ack.revision_id,
    in_flight: null,
    dirty: dirty(state.local_generation, synced_generation),
  };
}

// ---------------------------------------------------------------------------
// Queue internals.
// ---------------------------------------------------------------------------

interface AssetState {
  asset_revision_id: Id;
  ontology_version_id: Id;
  base_revision_id: Id | null;
  local_generation: number;
  synced_generation: number;
  document: AnnotationDocument | null;
  journal: IntentJournalEntry[];
  synced_intent_seq: number;
  next_seq: number;
  edit_seq: number;
  /** Operation ids ever prepared for this asset (incl. a restored pending's id):
   *  a new modification must never mint an id that could be confused with one. */
  used_operation_ids: Set<Id>;
  pending: PendingOperation | null;
  in_flight: PendingOperation | null;
  dirty: boolean;
  next_eligible_at: number;
  timer: unknown;
  paused: boolean;
  conflict: { code: string; message: string } | null;
  storage_error: { code: string; message: string } | null;
  save_error: { kind: 'network' | 'http' | 'conflict'; code: string; message: string; status: number | null } | null;
  last_ack: { revision_id: Id; generation: number; at: string } | null;
  local_persisted: boolean;
  persist_seq: number;
  persist_promise: Promise<void>;
  pump_promise: Promise<void> | null;
  snapshot: SaveStatusSnapshot;
}

const IDLE_SNAPSHOT: SaveStatusSnapshot = Object.freeze({
  phase: 'idle',
  dirty: false,
  saving: false,
  writes_paused: false,
  local_generation: 0,
  synced_generation: 0,
  base_revision_id: null,
  draft_exportable: false,
  last_error: null,
});

function iso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function isDirty(state: AssetState): boolean {
  return (
    state.local_generation > state.synced_generation ||
    state.journal.length > state.synced_intent_seq ||
    state.pending !== null
  );
}

function phaseOf(state: AssetState): SavePhase {
  if (state.paused) return 'conflict';
  if (state.storage_error !== null) return 'storage_error';
  if (state.in_flight !== null) return 'saving';
  if (state.save_error !== null) return 'save_failed';
  if (state.dirty) return state.local_persisted ? 'saved_local' : 'unsaved';
  return state.last_ack !== null ? 'synced' : 'idle';
}

function toTransportError(error: unknown): TransportError {
  if (error instanceof TransportError) return error;
  return new TransportError({
    kind: 'network',
    message: error instanceof Error ? error.message : String(error),
    code: 'TRANSPORT_FAILURE',
  });
}

/** One JSON-safe, deep-frozen copy per logical operation: payloads are immutable. */
function frozenCopy<T>(value: T): T {
  return freezeDeep(JSON.parse(JSON.stringify(value)) as T);
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export class SaveQueue {
  private readonly transport: SaveTransport;
  private readonly store: DraftStore;
  private readonly clock: Clock;
  private readonly debounceMs: number;
  private readonly newOperationId: () => Id;
  private readonly states = new Map<Id, AssetState>();
  private readonly listeners = new Map<Id, Set<() => void>>();
  private activeAsset: Id | null = null;

  constructor(options: SaveQueueOptions) {
    this.transport = options.transport;
    this.store = new DraftStore(options.storage);
    this.clock = options.clock ?? realClock;
    this.debounceMs = options.debounceMs ?? SAVE_DEBOUNCE_MS;
    this.newOperationId = options.newOperationId ?? (() => crypto.randomUUID());
  }

  /** Records one logical operation (one C3 generation) for an asset. */
  enqueue(input: EnqueueInput): void {
    const state = this.stateFor(input);
    state.ontology_version_id = input.ontology_version_id;
    state.document = frozenCopy(input.document);
    state.local_generation = Math.max(state.local_generation, input.generation);
    state.edit_seq += 1;
    for (const intent of input.suggestion_decisions ?? []) {
      state.next_seq += 1;
      const entry: IntentJournalEntry = {
        seq: state.next_seq,
        generation: input.generation,
        intent: frozenCopy(intent),
        recorded_at: iso(this.clock.now()),
      };
      state.journal.push(entry);
    }
    state.dirty = isDirty(state);
    state.next_eligible_at = this.clock.now() + this.debounceMs;
    this.schedule(state, this.debounceMs);
    this.recompute(state);
    this.persist(state);
  }

  /** Bypasses the debounce window and attempts a send immediately. */
  flush(asset_revision_id: Id): Promise<void> {
    const state = this.states.get(asset_revision_id);
    if (state === undefined) return Promise.resolve();
    return this.runPump(state, true);
  }

  /** Manual retry of the prepared (immutable) operation after a failure. */
  retry(asset_revision_id: Id): Promise<void> {
    const state = this.states.get(asset_revision_id);
    if (state === undefined) return Promise.resolve();
    return this.runPump(state, true);
  }

  /** Asset switch: flushes the previous asset now, keeps background queues. */
  switchAsset(next_asset_revision_id: Id): void {
    const previous = this.activeAsset;
    this.activeAsset = next_asset_revision_id;
    if (previous === null || previous === next_asset_revision_id) return;
    const state = this.states.get(previous);
    if (state === undefined || !state.dirty) return;
    void this.runPump(state, true);
  }

  getStatus(asset_revision_id: Id): SaveStatusSnapshot {
    const state = this.states.get(asset_revision_id);
    return state === undefined ? IDLE_SNAPSHOT : state.snapshot;
  }
  /** Registers a server-fetched immutable head as the clean starting point for an editor session. */
  initializeFromServerRevision(input: {
    asset_revision_id: Id;
    ontology_version_id: Id;
    annotation_revision_id: Id;
    generation: number;
    document: AnnotationDocument;
  }): boolean {
    if (input.document.asset_revision_id !== input.asset_revision_id ||
      input.document.ontology_version_id !== input.ontology_version_id ||
      !Number.isSafeInteger(input.generation) || input.generation < 0) {
      throw new Error('server revision baseline does not match its asset, ontology, or generation');
    }
    if (this.states.has(input.asset_revision_id)) return false;
    const state = this.stateTemplate(input.asset_revision_id, input.ontology_version_id);
    state.base_revision_id = input.annotation_revision_id;
    state.local_generation = input.generation;
    state.synced_generation = input.generation;
    state.document = frozenCopy(input.document);
    state.last_ack = {
      revision_id: input.annotation_revision_id,
      generation: input.generation,
      at: iso(this.clock.now()),
    };
    this.states.set(input.asset_revision_id, state);
    this.recompute(state);
    this.persist(state);
    return true;
  }

  subscribe(asset_revision_id: Id, listener: () => void): () => void {
    let set = this.listeners.get(asset_revision_id);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(asset_revision_id, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  /** Resolves when the latest local persistence attempt for the asset settled. */
  whenPersisted(asset_revision_id: Id): Promise<void> {
    const state = this.states.get(asset_revision_id);
    return state === undefined ? Promise.resolve() : state.persist_promise;
  }

  /** Native draft rescue export from memory — works even when storage failed. */
  exportDraft(asset_revision_id: Id): NativeDraftExport | null {
    const state = this.states.get(asset_revision_id);
    if (state === undefined || state.document === null) return null;
    return exportNativeDraft(this.toRecord(asset_revision_id) as DraftRecord, this.clock);
  }

  /** Explicit user resolution of an HTTP 409 (or a recovery conflict). */
  async resolveConflict(asset_revision_id: Id, action: ConflictAction): Promise<ConflictResolution> {
    const state = this.states.get(asset_revision_id);
    if (state === undefined) {
      throw new Error(`no save queue state for asset ${asset_revision_id}`);
    }
    if (action === 'adopt_server') {
      const head = await this.fetchHead(state);
      if (head === null) {
        throw new Error('cannot adopt the server version: no annotation head is available');
      }
      state.document = frozenCopy(head.document);
      state.base_revision_id = head.annotation_revision_id;
      state.synced_generation = state.local_generation;
      state.synced_intent_seq = state.journal.length;
      state.pending = null;
      state.conflict = null;
      state.save_error = null;
      state.paused = false;
      state.last_ack = {
        revision_id: head.annotation_revision_id,
        generation: state.local_generation,
        at: iso(this.clock.now()),
      };
      state.dirty = isDirty(state);
      this.recompute(state);
      this.persist(state);
      return { action: 'adopt_server', base_revision_id: head.annotation_revision_id };
    }
    if (action === 'view_server') {
      const head = await this.fetchHead(state);
      return { action: 'view_server', server_head: head };
    }
    // keep_local_export: the local draft stays the working content and gets its
    // rescue export. Writes only resume on top of the *observed* server head —
    // the user chose this explicitly, and no revision is ever deleted.
    const exportPayload = exportNativeDraft(this.toRecord(asset_revision_id) as DraftRecord, this.clock);
    const head = await this.fetchHead(state);
    if (head === null) {
      return {
        action: 'keep_local_export',
        base_revision_id: state.base_revision_id ?? '',
        export: exportPayload,
        resumed: false,
      };
    }
    state.base_revision_id = head.annotation_revision_id;
    state.pending = null;
    state.conflict = null;
    state.save_error = null;
    state.paused = false;
    state.dirty = isDirty(state);
    state.next_eligible_at = this.clock.now() + this.debounceMs;
    this.schedule(state, this.debounceMs);
    this.recompute(state);
    this.persist(state);
    return {
      action: 'keep_local_export',
      base_revision_id: head.annotation_revision_id,
      export: exportPayload,
      resumed: true,
    };
  }

  /** Adopts a draft record (recovery "restored" / "keep local") as live state. */
  restoreFromRecord(record: DraftRecord): void {
    const existing = this.states.get(record.asset_revision_id);
    if (existing && (
      existing.dirty ||
      existing.in_flight !== null ||
      existing.paused ||
      existing.conflict !== null ||
      existing.storage_error !== null ||
      existing.save_error !== null
    )) return;
    const state = this.stateTemplate(record.asset_revision_id, record.ontology_version_id);
    state.base_revision_id = record.base_revision_id;
    state.local_generation = record.generation;
    state.synced_generation = record.synced_generation;
    state.document = frozenCopy(record.document);
    state.journal = record.intent_journal.map((entry) => frozenCopy(entry));
    state.synced_intent_seq = record.synced_intent_seq;
    state.next_seq = record.intent_journal.reduce((max, entry) => Math.max(max, entry.seq), 0);
    state.edit_seq = record.pending?.edit_seq ?? 0;
    state.used_operation_ids = new Set<Id>(record.pending === null ? [] : [record.pending.operation_id]);
    state.pending = record.pending === null ? null : frozenCopy(record.pending);
    state.dirty = isDirty(state);
    state.persist_promise = existing?.persist_promise ?? state.persist_promise;
    this.states.set(record.asset_revision_id, state);
    this.recompute(state);
    this.persist(state);
  }

  toRecord(asset_revision_id: Id): DraftRecord | null {
    const state = this.states.get(asset_revision_id);
    if (state === undefined) return null;
    return {
      schema_version: 1,
      asset_revision_id: state.asset_revision_id,
      ontology_version_id: state.ontology_version_id,
      base_revision_id: state.base_revision_id ?? '',
      generation: state.local_generation,
      document: state.document as AnnotationDocument,
      pending: state.pending,
      intent_journal: [...state.journal],
      synced_generation: state.synced_generation,
      synced_intent_seq: state.synced_intent_seq,
      updated_at: iso(this.clock.now()),
    };
  }

  // -- internals ------------------------------------------------------------

  private stateFor(input: EnqueueInput): AssetState {
    const existing = this.states.get(input.asset_revision_id);
    if (existing !== undefined) return existing;
    if (input.base_revision_id === undefined) {
      throw new Error(`base_revision_id is required for asset ${input.asset_revision_id}`);
    }
    const state = this.stateTemplate(input.asset_revision_id, input.ontology_version_id);
    state.base_revision_id = input.base_revision_id;
    this.states.set(input.asset_revision_id, state);
    return state;
  }

  private stateTemplate(asset_revision_id: Id, ontology_version_id: Id): AssetState {
    return {
      asset_revision_id,
      ontology_version_id,
      base_revision_id: null,
      local_generation: 0,
      synced_generation: 0,
      document: null,
      journal: [],
      synced_intent_seq: 0,
      next_seq: 0,
      edit_seq: 0,
      used_operation_ids: new Set<Id>(),
      pending: null,
      in_flight: null,
      dirty: false,
      next_eligible_at: 0,
      timer: null,
      paused: false,
      conflict: null,
      storage_error: null,
      save_error: null,
      last_ack: null,
      local_persisted: false,
      persist_seq: 0,
      persist_promise: Promise.resolve(),
      pump_promise: null,
      snapshot: IDLE_SNAPSHOT,
    };
  }

  private schedule(state: AssetState, delayMs: number): void {
    this.clearTimer(state);
    state.timer = this.clock.setTimeout(() => {
      state.timer = null;
      void this.runPump(state, false);
    }, delayMs);
  }

  private clearTimer(state: AssetState): void {
    if (state.timer !== null) {
      this.clock.clearTimeout(state.timer);
      state.timer = null;
    }
  }

  private runPump(state: AssetState, force: boolean): Promise<void> {
    if (force) state.next_eligible_at = 0;
    if (state.pump_promise !== null) return state.pump_promise;
    const run = this.pumpLoop(state).finally(() => {
      state.pump_promise = null;
    });
    state.pump_promise = run;
    return run;
  }

  private async pumpLoop(state: AssetState): Promise<void> {
    for (;;) {
      if (state.paused || !state.dirty || state.document === null) {
        this.clearTimer(state);
        return;
      }
      const waitMs = state.next_eligible_at - this.clock.now();
      if (waitMs > 0) {
        this.schedule(state, waitMs);
        return;
      }
      this.clearTimer(state);
      const operation = this.prepareOperation(state);
      state.in_flight = operation;
      this.persist(state);
      this.recompute(state);
      try {
        const response = await this.transport.save(operation.request, state.asset_revision_id);
        state.in_flight = null;
        this.applyAck(state, operation, response);
      } catch (error) {
        state.in_flight = null;
        this.applyFailure(state, operation, toTransportError(error));
        return;
      }
    }
  }

  /**
   * Mints an operation id never used for this asset. The production mint is
   * randomUUID, but injected mints (tests, alternative stores) can restart:
   * a new modification must never mint an id equal to a restored or previously
   * prepared operation's, or an acknowledgement could be matched to the wrong
   * operation.
   */
  private mintOperationId(state: AssetState): Id {
    let id = this.newOperationId();
    while (state.used_operation_ids.has(id)) id = this.newOperationId();
    state.used_operation_ids.add(id);
    return id;
  }

  private prepareOperation(state: AssetState): PendingOperation {
    const reusable = state.pending;
    if (reusable !== null && reusable.edit_seq === state.edit_seq) {
      return reusable;
    }
    const suggestion_decisions = state.journal.slice(state.synced_intent_seq).map((entry) => entry.intent);
    Object.freeze(suggestion_decisions);
    const request: SaveRequest = {
      operation_id: this.mintOperationId(state),
      base_revision_id: state.base_revision_id ?? '',
      document: state.document as AnnotationDocument,
      lease: null,
      suggestion_decisions,
    };
    Object.freeze(request);
    const operation: PendingOperation = {
      operation_id: request.operation_id,
      generation: state.local_generation,
      journal_seq_end: state.journal.length,
      edit_seq: state.edit_seq,
      prepared_at: iso(this.clock.now()),
      request,
    };
    Object.freeze(operation);
    state.pending = operation;
    return operation;
  }

  private applyAck(state: AssetState, operation: PendingOperation, response: SaveResponse): void {
    if (response.operation_id !== operation.request.operation_id) {
      this.applyFailure(
        state,
        operation,
        new TransportError({
          kind: 'http',
          status: null,
          code: 'PROTOCOL_MISMATCH',
          message: 'SaveResponse.operation_id does not match the request',
        }),
      );
      return;
    }
    const next = reconcileAck(
      {
        local_generation: state.local_generation,
        synced_generation: state.synced_generation,
        base_revision_id: state.base_revision_id ?? operation.request.base_revision_id,
        in_flight: { generation: operation.generation, operation_id: operation.operation_id },
      },
      {
        generation: operation.generation,
        operation_id: response.operation_id,
        revision_id: response.revision.annotation_revision_id,
      },
    );
    state.local_generation = next.local_generation;
    state.synced_generation = next.synced_generation;
    state.base_revision_id = next.base_revision_id;
    state.synced_intent_seq = Math.max(state.synced_intent_seq, operation.journal_seq_end);
    state.pending = null;
    state.save_error = null;
    state.last_ack = {
      revision_id: response.revision.annotation_revision_id,
      generation: operation.generation,
      at: iso(this.clock.now()),
    };
    state.dirty = isDirty(state);
    this.persist(state);
    this.recompute(state);
  }

  private applyFailure(state: AssetState, operation: PendingOperation, failure: TransportError): void {
    state.save_error = {
      kind: failure.kind,
      code: failure.code,
      message: failure.message,
      status: failure.status,
    };
    if (failure.kind === 'conflict') {
      state.paused = true;
      state.conflict = { code: failure.code, message: failure.message };
    }
    // The prepared operation is kept verbatim for the retry; a new local
    // modification replaces it with a brand-new operation_id instead.
    state.dirty = isDirty(state);
    this.persist(state);
    this.recompute(state);
  }

  private async fetchHead(state: AssetState): Promise<AnnotationRevision | null> {
    try {
      return await this.transport.fetchHead(state.asset_revision_id, state.ontology_version_id);
    } catch {
      return null;
    }
  }

  private persist(state: AssetState): void {
    const record = this.toRecord(state.asset_revision_id);
    if (record === null) return;
    state.persist_seq += 1;
    const seq = state.persist_seq;
    state.persist_promise = this.store
      .save(record)
      .then(() => {
        if (state.persist_seq !== seq) return;
        state.storage_error = null;
        state.local_persisted = true;
        this.recompute(state);
      })
      .catch((error: unknown) => {
        if (state.persist_seq !== seq) return;
        state.storage_error = {
          code: error instanceof StorageError ? error.code : 'STORAGE_FAILED',
          message: error instanceof Error ? error.message : String(error),
        };
        state.local_persisted = false;
        this.recompute(state);
      });
  }

  private recompute(state: AssetState): void {
    const lastError =
      state.storage_error !== null
        ? { kind: 'storage' as const, code: state.storage_error.code, message: state.storage_error.message }
        : state.save_error !== null
          ? { kind: state.save_error.kind, code: state.save_error.code, message: state.save_error.message }
          : null;
    state.snapshot = {
      phase: phaseOf(state),
      dirty: state.dirty,
      saving: state.in_flight !== null,
      writes_paused: state.paused,
      local_generation: state.local_generation,
      synced_generation: state.synced_generation,
      base_revision_id: state.base_revision_id,
      draft_exportable: state.document !== null,
      last_error: lastError,
    };
    const listeners = this.listeners.get(state.asset_revision_id);
    if (listeners !== undefined) {
      for (const listener of listeners) listener();
    }
  }
}

// ---------------------------------------------------------------------------
// Production transport over fetch (T11 save API).
// ---------------------------------------------------------------------------

interface FetchTransportOptions {
  fetchImpl?: typeof fetch;
  /** Session CSRF token (x-csrf-token, required for unsafe methods). */
  csrfToken?: () => string | null;
  baseUrl?: string;
}

function apiErrorOf(error: unknown): ApiError | null {
  if (error !== null && typeof error === 'object' && typeof (error as ApiError).code === 'string') {
    return error as ApiError;
  }
  return null;
}

function transportFailure(response: Response, apiError: ApiError | null): TransportError {
  return new TransportError({
    kind: response.status === 409 ? 'conflict' : 'http',
    status: response.status,
    code: apiError?.code ?? `HTTP_${response.status}`,
    message: apiError?.message ?? `unexpected HTTP ${response.status}`,
    api_error: apiError,
  });
}

export class FetchSaveTransport implements SaveTransport {
  private readonly fetchImpl: typeof fetch;
  private readonly csrfToken: () => string | null;
  private readonly baseUrl: string;

  constructor(options: FetchTransportOptions = {}) {
    this.fetchImpl =
      options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.csrfToken = options.csrfToken ?? (() => null);
    this.baseUrl = options.baseUrl ?? '';
  }

  async save(request: SaveRequest, asset_revision_id: Id): Promise<SaveResponse> {
    const response = await this.send(`${this.baseUrl}/api/assets/${asset_revision_id}/annotation`, {
      method: 'PUT',
      body: JSON.stringify(request),
      csrf: true,
    });
    if (!response.ok) throw await this.failureOf(response);
    return (await response.json()) as SaveResponse;
  }

  async fetchHead(asset_revision_id: Id, ontology_version_id: Id): Promise<AnnotationRevision | null> {
    const query = `?ontology_version_id=${encodeURIComponent(ontology_version_id)}`;
    const response = await this.send(`${this.baseUrl}/api/assets/${asset_revision_id}/annotation${query}`, {
      method: 'GET',
      csrf: false,
    });
    if (response.status === 404) return null;
    if (!response.ok) throw await this.failureOf(response);
    return (await response.json()) as AnnotationRevision;
  }

  async fetchRevision(annotation_revision_id: Id): Promise<AnnotationRevision> {
    const response = await this.send(
      `${this.baseUrl}/api/annotation-revisions/${annotation_revision_id}`,
      { method: 'GET', csrf: false },
    );
    if (!response.ok) throw await this.failureOf(response);
    return (await response.json()) as AnnotationRevision;
  }

  private async send(url: string, init: { method: string; body?: string; csrf: boolean }): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.csrf) {
      const token = this.csrfToken();
      if (token !== null) headers['x-csrf-token'] = token;
    }
    try {
      return await this.fetchImpl(url, {
        method: init.method,
        headers,
        body: init.body,
        credentials: 'same-origin',
      });
    } catch (error) {
      throw new TransportError({
        kind: 'network',
        code: 'NETWORK_UNREACHABLE',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async failureOf(response: Response): Promise<TransportError> {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return transportFailure(response, apiErrorOf(body));
  }
}
