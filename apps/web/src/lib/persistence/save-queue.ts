// T13 · per-asset single-flight save queue with a logical-operation debounce
// and immutable prepared payloads (C1 save + decision journal, C3 generation).
import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { SaveQueueOwner } from './types';
import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import type { ApiError } from '../../../../../packages/contracts/generated/ApiError';
import type { SaveRequest } from '../../../../../packages/contracts/generated/SaveRequest';
import type { SaveResponse } from '../../../../../packages/contracts/generated/SaveResponse';

import { DraftStore, admitRawDraft, exportNativeDraft, freezeDeep, immutableDocument } from './draft-store';
import { validateContract } from '@weblabel/contracts/validate-browser';
import type {
  DraftBranchEnvelope, DraftBranchSnapshot, LocalCommitEvidence, SourceRef,
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
  SaveSyncGuard,
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
  draft_id: Id;
  write_token: Id;
  sources: readonly SourceRef[];
  raw_record: Partial<DraftRecord>;
  draft_owner: DraftRecord['draft_owner'];
  /** Branch identity survives ACK clearing outstanding-work authorship. */
  summary_owner: DraftRecord['draft_owner'];
  pending_owner: DraftRecord['pending_owner'];
  owner_paused: boolean;
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
  ack_local_barrier: { owner: SaveQueueOwner; guard: SaveSyncGuard; receipt: NonNullable<AssetState['last_ack']>; continueWork: boolean } | null;
  ack_continuation: AssetState['ack_local_barrier'];
  conflict: { code: string; message: string } | null;
  storage_error: { code: string; message: string } | null;
  save_error: { kind: 'network' | 'http' | 'conflict'; code: string; message: string; status: number | null; request_id: string | null } | null;
  last_ack: { revision_id: Id; generation: number; at: string } | null;
  pending_outcome: NonNullable<DraftRecord['pending_outcome']>;
  version: number;
  local_commit: SaveStatusSnapshot['local_commit'];
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

const LEASE_REJECTION_CODES = new Set([
  'LEASE_REQUIRED',
  'LEASE_NOT_REQUIRED',
  'LEASE_NOT_HELD',
  'LEASE_EXPIRED',
  'STALE_FENCING_TOKEN',
]);

/** Shared classification only; callers must separately verify author, outcome and target. */
export function isLeaseRejection(code: string): boolean {
  return LEASE_REJECTION_CODES.has(code);
}

/** JSON equality ignores object key order; immutable ACK content must match. */
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = Object.keys(left), b = Object.keys(right);
  return a.length === b.length && a.every((key) => Object.prototype.hasOwnProperty.call(right, key) &&
    sameJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

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

function isLocalCommitted(state: AssetState): boolean {
  return state.local_commit != null && state.local_commit.draft_id === state.draft_id && state.local_commit.write_token === state.write_token && state.local_commit.persist_seq === state.persist_seq &&
    state.local_commit.edit_seq === state.edit_seq && state.local_commit.generation === state.local_generation;
}

function phaseOf(state: AssetState): SavePhase {
  if (state.paused) return state.save_error?.kind === 'conflict' && state.save_error.code === 'REVISION_CONFLICT' ? 'conflict' : 'paused';
  if (state.storage_error !== null) return 'storage_error';
  if (state.ack_local_barrier) return 'paused';
  if (state.in_flight !== null) return 'saving';
  if (state.save_error !== null) return 'save_failed';
  if (state.dirty) return isLocalCommitted(state) ? 'saved_local' : 'unsaved';
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

/** Defensive JSON-safe copy for caller-owned intents and restored pending values. */
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
  private readonly newDraftId: () => Id;
  private owner: SaveQueueOwner | null;
  private ownerSource: SaveQueueOwner | null;
  private readonly states = new Map<Id, AssetState>();
  private readonly listeners = new Map<Id, Set<() => void>>();
  private activeAsset: Id | null = null;

  constructor(options: SaveQueueOptions) {
    this.transport = options.transport;
    this.store = new DraftStore(options.storage);
    this.clock = options.clock ?? realClock;
    this.debounceMs = options.debounceMs ?? SAVE_DEBOUNCE_MS;
    this.newOperationId = options.newOperationId ?? (() => crypto.randomUUID());
    this.newDraftId = options.newDraftId ?? (() => crypto.randomUUID());
    this.ownerSource = options.owner;
    this.owner = this.installOwner(options.owner);
  }

  private current(owner = this.owner): owner is SaveQueueOwner {
    return owner !== null && this.owner === owner && owner.isCurrent();
  }
  private writable(owner = this.owner): owner is SaveQueueOwner {
    return this.current(owner) && owner.isWritable();
  }
  /** Each installation has a distinct identity, even when source and token repeat. */
  private installOwner(source: SaveQueueOwner): SaveQueueOwner {
    return { token: source.token, actor_id: source.actor_id, project_id: source.project_id,
      isCurrent: () => source.isCurrent(), isWritable: () => source.isWritable(),
      canPrepareOperation: (asset, ontology) => source.canPrepareOperation(asset, ontology),
      getLease: (asset) => source.getLease(asset) };
  }
  setWriteOwner(owner: SaveQueueOwner): void {
    if (this.ownerSource === owner && this.owner !== null) return;
    this.pauseOwner();
    this.ownerSource = owner;
    this.owner = this.installOwner(owner);
  }
  revokeWriteOwner(token: object): void {
    if (this.owner?.token !== token) return;
    this.pauseOwner();
    this.owner = null;
    this.ownerSource = null;
  }
  private pauseOwner(): void {
    for (const state of this.states.values()) {
      this.clearTimer(state);
      state.local_commit = null;
      state.version += 1;
      if (isDirty(state)) { state.paused = true; state.owner_paused = true; }
      state.in_flight = null;
      state.pump_promise = null;
      this.recompute(state);
    }
  }
  async readDraftBranches(asset: Id): Promise<readonly DraftBranchEnvelope[]> {
    const owner = this.owner;
    return this.store.list(asset, () => this.current(owner));
  }
  async readDraftBranch(asset: Id, draft: Id): Promise<DraftBranchEnvelope | null> {
    const owner = this.owner;
    return this.store.load(asset, draft, () => this.current(owner));
  }
  getDraftBranchSnapshot(asset: Id): DraftBranchSnapshot | null {
    const state = this.states.get(asset), record = this.toRecord(asset);
    if (!state || !record) return null;
    return { envelope: { asset_revision_id: asset, draft_id: state.draft_id, write_token: state.write_token, record: structuredClone(record), sources: structuredClone(state.sources) }, local_commit: state.in_flight || state.pump_promise || state.storage_error ? null : this.getStatus(asset).local_commit ?? null, ack_local_barrier: state.ack_local_barrier !== null };
  }

  /** Read-only, document-free status for this queue's current project/author. */
  getOwnedSummary(asset: Id, project: Id, actor: Id): { draft_id: Id; pending: boolean; failed: boolean } | null {
    const state = this.states.get(asset), owner = this.owner;
    if (!this.current(owner) || owner.project_id !== project || owner.actor_id !== actor || state?.summary_owner?.project_id !== project || state.summary_owner.actor_id !== actor) return null;
    return { draft_id: state.draft_id, pending: state.dirty || state.in_flight !== null, failed: !!state.save_error || !!state.storage_error || !!state.conflict || state.pending_outcome === 'unknown' };
  }

  /** Local Native authority is independent of healthy receipt transport durability. */
  canAcceptEdits(asset_revision_id: Id, ontology_version_id: Id): boolean {
    const state = this.states.get(asset_revision_id);
    return !!state && state.ontology_version_id === ontology_version_id &&
      state.document?.asset_revision_id === asset_revision_id &&
      state.document.ontology_version_id === ontology_version_id && this.acceptsEdits(state);
  }

  private acceptsEdits(state: AssetState): boolean {
    const owner = this.owner, barrier = state.ack_local_barrier;
    return this.writable(owner) && !state.paused && !state.owner_paused &&
      this.authorizedWork(state, owner, false) && (!barrier ||
        (!state.storage_error && barrier.owner === owner && barrier.guard() && state.last_ack === barrier.receipt));
  }

  /** Records one logical operation (one C3 generation) for an asset. */
  enqueue(input: EnqueueInput): void {
    if (!this.writable()) return;
    const state = this.stateFor(input);
    // enqueue preserves an already committed authoritative Native body, including
    // existing non-barrier paused/rescue work. Future UI admission is stricter.
    if (state.owner_paused || !this.authorizedWork(state) ||
      (state.ack_local_barrier !== null && !this.acceptsEdits(state))) return;
    if (!isDirty(state)) state.draft_owner = freezeDeep({ actor_id: this.owner!.actor_id, project_id: this.owner!.project_id });
    state.summary_owner = state.draft_owner;
    state.ontology_version_id = input.ontology_version_id;
    state.document = immutableDocument(input.document);
    state.local_generation = Math.max(state.local_generation, input.generation);
    state.edit_seq += 1;
    state.version += 1;
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
    if (!state.ack_local_barrier && state.ack_continuation?.continueWork !== false) this.schedule(state, this.debounceMs);
    this.recompute(state);
    this.persist(state);
  }

  /** Drains permitted ordinary sends and latest local attempts; never retries a barrier. */
  async flush(asset_revision_id: Id, guard: SaveSyncGuard = () => true): Promise<void> {
    const state = this.states.get(asset_revision_id), owner = this.owner;
    if (!state || !this.writable(owner)) return;
    const current = () => this.writable(owner) && guard() && this.states.get(asset_revision_id) === state;
    for (;;) {
      if (!current()) return;
      const receipt = state.last_ack, barrier = state.ack_local_barrier;
      await this.runPump(state, true, current);
      if (!current() || !this.authorizedWork(state, owner, false)) return;
      await this.whenPersisted(asset_revision_id);
      if (!current() || !state.dirty || state.paused || state.ack_local_barrier ||
        state.save_error || state.storage_error ||
        state.last_ack === receipt && state.ack_local_barrier === barrier) return;
    }
  }

  /** Read-only eligibility for an original retained request or installed ACK PUT.
   * Scope is caller freshness, never permission to prepare a new operation. */
  canRetryRetained(asset_revision_id: Id, scopeGuard: SaveSyncGuard): boolean {
    const owner = this.owner;
    const state = this.states.get(asset_revision_id);
    if (!this.writable(owner) || !scopeGuard() || !state ||
      !this.authorizedWork(state, owner, false)) return false;
    const pending = state.pending;
    const barrier = state.ack_local_barrier;
    const eligible = pending !== null
      ? (state.pending_outcome === 'unknown' || state.pending_outcome === 'rejected') &&
        pending.operation_id === pending.request.operation_id &&
        state.asset_revision_id === asset_revision_id &&
        state.document?.asset_revision_id === asset_revision_id &&
        state.document.ontology_version_id === state.ontology_version_id &&
        pending.request.document.asset_revision_id === asset_revision_id &&
        pending.request.document.ontology_version_id === state.ontology_version_id
      : barrier !== null && barrier.owner === owner && barrier.guard() &&
        state.last_ack === barrier.receipt && state.ack_local_barrier === barrier;
    return eligible && this.writable(owner) && scopeGuard() &&
      this.states.get(asset_revision_id) === state && state.pending === pending &&
      this.authorizedWork(state, owner, false);
  }

  /** Manual retry of the prepared (immutable) operation after a failure. */
  retry(asset_revision_id: Id, guard: SaveSyncGuard = () => true): Promise<void> {
    const state = this.states.get(asset_revision_id);
    if (state === undefined) return Promise.resolve();
    if (state.ack_local_barrier && state.pending === null) {
      const barrier = state.ack_local_barrier;
      if (this.owner !== barrier.owner || !guard() || !barrier.guard()) return Promise.resolve();
      this.persist(state, () => guard() && barrier.guard());
      return state.persist_promise;
    }
    return this.runPump(state, true, guard, true);
  }

  /** Single-use preparation permission, never lent by a historical receipt. */
  async retryOwnedFuture(asset_revision_id: Id, initialProof: SaveSyncGuard, reconciliationGuard: SaveSyncGuard): Promise<boolean> {
    const owner = this.owner;
    const state = this.states.get(asset_revision_id);
    if (!this.writable(owner) || !initialProof() || !state || !isDirty(state) || !state.paused ||
      state.owner_paused || state.ack_local_barrier || state.pending !== null || state.in_flight !== null ||
      state.pump_promise !== null || state.save_error || state.conflict || state.storage_error ||
      !this.authorizedWork(state, owner, false) || !isLocalCommitted(state) ||
      !Number.isSafeInteger(state.synced_generation) || state.synced_generation < 0 ||
      !Number.isSafeInteger(state.local_generation) || state.local_generation < state.synced_generation ||
      !Number.isSafeInteger(state.synced_intent_seq) || state.synced_intent_seq < 0 || state.synced_intent_seq > state.journal.length ||
      !state.base_revision_id || !state.document) return false;
    const scoped = () => this.writable(owner) && reconciliationGuard() &&
      this.states.get(asset_revision_id) === state && this.authorizedWork(state, owner, false);
    const lease = owner.getLease(asset_revision_id);
    if (!lease || !scoped() || !owner.canPrepareOperation(asset_revision_id, state.ontology_version_id)) return false;
    const operation = this.prepareOperation(state, owner, scoped, lease);
    if (!operation) return false;
    this.recompute(state);
    await this.runPump(state, true, scoped, true, true);
    return true;
  }
  /**
   * Only a fresh lease-related 409 is definitive. A prior unknown send stays unknown.
   * Rebuild the operation with a fresh id after the user acquires a valid
   * lease; all other conflicts and ambiguous failures retain their payload.
   */
  async retryRejectedLease(asset_revision_id: Id, guard: SaveSyncGuard = () => true): Promise<boolean> {
    const owner = this.owner;
    if (!this.writable(owner) || !guard()) return false;
    const state = this.states.get(asset_revision_id);
    if (!state || state.in_flight !== null || state.pump_promise !== null || state.pending_outcome !== 'rejected' ||
      !state.paused || state.save_error?.kind !== 'conflict' || !isLeaseRejection(state.save_error.code) ||
      !this.authorizedWork(state, owner) || !state.pending) return false;
    const pending = state.pending;
    const pendingOwner = state.pending_owner;
    const scoped = () => this.writable(owner) && guard() && this.states.get(asset_revision_id) === state && this.authorizedWork(state, owner, false);
    const lease = owner.getLease(asset_revision_id);
    if (!lease || !scoped() || state.pending !== pending || !owner.canPrepareOperation(asset_revision_id, state.ontology_version_id)) return false;
    // This independent user action replaces only a definitive lease rejection.
    // Keep the editing barrier and original diagnosis until the new actual ACK.
    state.pending = null;
    state.pending_owner = null;
    state.pending_outcome = 'prepared';
    state.version += 1;
    const operation = this.prepareOperation(state, owner, scoped, lease);
    if (!operation) {
      state.pending = pending;
      state.pending_owner = pendingOwner;
      state.pending_outcome = 'rejected';
      return true;
    }
    state.next_eligible_at = this.clock.now();
    state.dirty = isDirty(state);
    this.recompute(state);
    await this.runPump(state, true, scoped, true);
    return true;
  }

  /** Capture the installed writer for UI awaits; a replacement cannot lend its authority. */
  captureWriteGuard(asset_revision_id: Id, guard: SaveSyncGuard): SaveSyncGuard {
    const owner = this.owner;
    const state = this.states.get(asset_revision_id);
    const authorized = !!state && this.writable(owner) && guard() && this.authorizedWork(state, owner, false);
    return () => authorized && !!state && this.writable(owner) && guard() && this.states.get(asset_revision_id) === state &&
      this.authorizedWork(state, owner, false);
  }

  /** Asset switch: flushes the previous asset now, keeps background queues. */
  switchAsset(next_asset_revision_id: Id): void {
    if (!this.current()) return;
    const previous = this.activeAsset;
    this.activeAsset = next_asset_revision_id;
    if (previous === null || previous === next_asset_revision_id) return;
    const state = this.states.get(previous);
    if (state === undefined || !state.dirty) return;
    void this.runPump(state, true);
  }

  getStatus(asset_revision_id: Id): SaveStatusSnapshot {
    const state = this.states.get(asset_revision_id);
    if (state === undefined) return IDLE_SNAPSHOT;
    // Authorization can expire before the page owner calls revoke.
    // Withdraw only the current certificate, without writes or notifications
    // during snapshot reads, and cache the projection for stability.
    if (state.snapshot.local_commit && (!this.writable() || !this.authorizedWork(state, this.owner, false))) {
      state.local_commit = null;
      state.snapshot = { ...state.snapshot, local_commit: null,
        phase: state.snapshot.phase === 'saved_local' ? 'unsaved' : state.snapshot.phase };
    }
    return state.snapshot;
  }
  /** Registers a server-fetched immutable head as the clean starting point for an editor session. */
  initializeFromServerRevision(input: {
    asset_revision_id: Id;
    ontology_version_id: Id;
    annotation_revision_id: Id;
    generation: number;
    document: AnnotationDocument;
  }): boolean {
    if (!this.current()) return false;
    if (input.document.asset_revision_id !== input.asset_revision_id ||
      input.document.ontology_version_id !== input.ontology_version_id ||
      !Number.isSafeInteger(input.generation) || input.generation < 0) {
      throw new Error('server revision baseline does not match its asset, ontology, or generation');
    }
    const existing = this.states.get(input.asset_revision_id);
    if (existing) {
      // Rebinding a page revokes its old certificate. Re-establish it with a
      // genuine local transaction only for the exact unchanged clean head.
      if (!this.writable() || existing.ontology_version_id !== input.ontology_version_id
        || existing.base_revision_id !== input.annotation_revision_id
        || existing.local_generation !== input.generation || existing.synced_generation !== input.generation
        || !sameJson(existing.document, input.document) || isDirty(existing)
        || existing.pending !== null || existing.in_flight !== null || existing.pump_promise !== null
        || existing.paused || existing.owner_paused || existing.ack_local_barrier !== null
        || existing.conflict !== null || existing.save_error !== null) return false;
      if (!isLocalCommitted(existing)) this.persist(existing);
      return true;
    }
    const state = this.stateTemplate(input.asset_revision_id, input.ontology_version_id);
    state.base_revision_id = input.annotation_revision_id;
    state.local_generation = input.generation;
    state.synced_generation = input.generation;
    state.document = immutableDocument(input.document);
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

  /** Adopt only an actual import receipt on the captured clean base. Keep the
   * acknowledged decision journal and used operation IDs; never discard an
   * unresolved save operation to make an import look successful. */
  adoptImportReceipt(revision: AnnotationRevision, expectedBase: Id | null): boolean {
    if (!this.writable()) return false;
    const document = revision.document;
    const state = this.states.get(document.asset_revision_id);
    if (!state || state.ontology_version_id !== document.ontology_version_id
      || revision.parent_revision_id !== expectedBase || isDirty(state) || state.in_flight !== null || state.pump_promise !== null
      || state.pending !== null || state.paused || state.ack_local_barrier !== null || state.conflict !== null) return false;
    if (state.base_revision_id === revision.annotation_revision_id) {
      if (!sameJson(state.document, document)) return false;
      // Reconcile this exact acknowledged receipt locally; never mint a save operation.
      if (!isLocalCommitted(state)) this.persist(state);
      return true;
    }
    if (state.base_revision_id !== expectedBase) return false;
    this.clearTimer(state);
    state.base_revision_id = revision.annotation_revision_id;
    state.document = immutableDocument(document);
    state.local_generation = 0;
    state.synced_generation = 0;
    state.edit_seq += 1;
    state.save_error = null;
    state.dirty = false;
    state.version += 1;
    state.last_ack = { revision_id: revision.annotation_revision_id, generation: 0, at: iso(this.clock.now()) };
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

  /** Resolves after the latest local attempt settles; settlement is not a certificate. */
  async whenPersisted(asset_revision_id: Id): Promise<void> {
    const state = this.states.get(asset_revision_id);
    if (!state) return;
    let attempt: Promise<void>;
    do {
      attempt = state.persist_promise;
      await attempt;
    } while (this.states.get(asset_revision_id) === state && state.persist_promise !== attempt);
  }

  /** Native draft rescue export from memory — works even when storage failed. */
  exportDraft(asset_revision_id: Id): NativeDraftExport | null {
    const state = this.states.get(asset_revision_id);
    if (state === undefined || state.document === null) return null;
    return exportNativeDraft(this.toRecord(asset_revision_id) as DraftRecord, this.clock);
  }

  /** Explicit user resolution of an HTTP 409 (or a recovery conflict). */
  async resolveConflict(asset_revision_id: Id, action: ConflictAction, guard: SaveSyncGuard): Promise<ConflictResolution> {
    const owner = this.owner;
    if (!this.current(owner)) throw new Error('Save owner is no longer current');
    const state = this.states.get(asset_revision_id);
    if (!state) throw new Error('No local draft is available');
    const version = state.version;
    const pending = state.pending;
    const current = () => this.current(owner) && guard() && this.states.get(asset_revision_id) === state &&
      state.version === version && state.pending === pending && state.in_flight === null;
    const rescue = exportNativeDraft(this.toRecord(asset_revision_id) as DraftRecord, this.clock);
    const sameAuthor = this.authorizedWork(state, owner, false);
    if (action === 'keep_local_export' && (!sameAuthor || state.pending_outcome === 'unknown' || !guard())) {
      return { action, base_revision_id: state.base_revision_id ?? '', export: rescue, resumed: false };
    }
    if (!guard()) throw new Error('Save scope is no longer current');
    const head = await this.fetchHead(state);
    if (!current()) throw new Error('Save scope or local draft changed while checking the server');
    if (action === 'view_server') return { action, server_head: head };
    if (!this.writable(owner)) throw new Error('Save owner is read-only');
    if (!sameAuthor) throw new Error('Original draft author cannot be authorized; download the local draft');
    if (state.pending && state.pending_outcome !== 'rejected') {
      throw new Error('The pending operation is unconfirmed; replay it or download the local draft');
    }
    if (!head) {
      return { action, base_revision_id: state.base_revision_id ?? '', export: rescue, resumed: false };
    }
    if (head.document.asset_revision_id !== state.asset_revision_id || head.document.ontology_version_id !== state.ontology_version_id) {
      throw new Error('Server head does not match the captured asset and ontology');
    }
    this.clearTimer(state);
    state.base_revision_id = head.annotation_revision_id;
    state.pending = null;
    state.pending_owner = null;
    state.pending_outcome = 'prepared';
    state.conflict = null;
    state.save_error = null;
    state.paused = false;
    state.owner_paused = false;
    state.version += 1;
    state.dirty = isDirty(state);
    this.persist(state);
    this.recompute(state);
    state.next_eligible_at = this.clock.now() + this.debounceMs;
    this.schedule(state, this.debounceMs, guard);
    return { action, base_revision_id: head.annotation_revision_id, export: rescue, resumed: true };
  }

  async forkFromRecord(source: DraftBranchEnvelope, options: { pauseForUserChoice?: boolean; expectedCurrent?: LocalCommitEvidence | null } = {}): Promise<boolean> {
    const record = source.record;
    admitRawDraft(record, source.asset_revision_id);
    const existing = this.states.get(source.asset_revision_id);
    const owner = this.owner;
    const stillCurrent = () => this.current(owner) && this.states.get(source.asset_revision_id) === existing && this.canInstallSwitch(source.asset_revision_id, options.expectedCurrent);
    if (existing?.draft_id === source.draft_id) return this.current(owner) && isLocalCommitted(existing) && existing.ack_local_barrier === null;
    if (!await this.canSwitch(source.asset_revision_id, options.expectedCurrent)) return false;
    const currentSource = await this.readDraftBranch(source.asset_revision_id, source.draft_id);
    if (!currentSource || currentSource.write_token !== source.write_token) return false;
    const sources: SourceRef[] = [];
    for (const ref of Array.isArray(source.sources) ? source.sources : []) {
      if (ref.action !== 'recover' && ref.action !== 'use_server') continue;
      const row = await this.readDraftBranch(source.asset_revision_id, ref.draft_id);
      if (row?.write_token === ref.write_token) sources.push(ref);
    }
    if (!stillCurrent()) return false;
    const state = this.stateTemplate(record.asset_revision_id, record.ontology_version_id);
    state.raw_record = structuredClone(record);
    state.sources = [...sources, { draft_id: source.draft_id, write_token: source.write_token, action: 'recover' as const }].filter((ref, index, refs) => refs.findIndex(other => other.draft_id === ref.draft_id && other.write_token === ref.write_token && other.action === ref.action) === index);
    state.base_revision_id = record.base_revision_id;
    state.local_generation = record.generation;
    state.synced_generation = record.synced_generation;
    state.document = immutableDocument(record.document);
    state.journal = record.intent_journal.map((entry) => frozenCopy(entry));
    state.synced_intent_seq = record.synced_intent_seq;
    state.next_seq = record.intent_journal.reduce((max, entry) => Math.max(max, entry.seq), 0);
    state.edit_seq = record.edit_seq ?? record.pending?.edit_seq ?? 0;
    state.used_operation_ids = new Set<Id>([...(record.used_operation_ids ?? []), ...(record.pending ? [record.pending.operation_id] : [])]);
    state.pending_outcome = record.pending_outcome ?? (record.pending ? 'unknown' : 'prepared');
    state.pending = record.pending === null ? null : frozenCopy(record.pending);
    state.draft_owner = record.draft_owner ? frozenCopy(record.draft_owner) : null;
    state.summary_owner = state.draft_owner;
    state.pending_owner = record.pending_owner ? frozenCopy(record.pending_owner) : null;
    state.paused = options.pauseForUserChoice || (record.writes_paused ?? false);
    if (state.pending) state.paused = true;
    state.save_error = record.save_error ? { ...record.save_error } : null;
    if (state.pending && (!state.pending_owner || state.pending_owner.actor_id !== this.owner?.actor_id || state.pending_owner.project_id !== this.owner?.project_id)) {
      state.save_error = { kind: 'http', status: null, request_id: null,
        code: state.pending_owner ? 'PENDING_OWNER_MISMATCH' : 'PENDING_OWNER_UNKNOWN',
        message: 'Original pending author cannot be authorized; export the local draft' };
    }
    if (state.save_error?.kind === 'conflict') state.conflict = { code: state.save_error.code, message: state.save_error.message };
    state.dirty = isDirty(state);
    if (state.dirty && !this.authorizedWork(state)) { state.owner_paused = true; state.paused = true; }
    if (existing) this.clearTimer(existing);
    this.states.set(record.asset_revision_id, state);
    this.recompute(state);
    this.persist(state);
    await this.whenPersisted(record.asset_revision_id);
    if (!this.current(owner) || this.states.get(record.asset_revision_id) !== state) return false;
    const checked = await this.readDraftBranch(source.asset_revision_id, source.draft_id);
    if (!checked || checked.write_token !== source.write_token) { state.paused = true; state.local_commit = null; this.recompute(state); return false; }
    return this.states.get(record.asset_revision_id) === state && isLocalCommitted(state);
  }
  private async canSwitch(asset: Id, expected?: LocalCommitEvidence | null): Promise<boolean> {
    await this.whenPersisted(asset);
    return this.canInstallSwitch(asset, expected);
  }
  private canInstallSwitch(asset: Id, expected?: LocalCommitEvidence | null): boolean {
    if (!this.current()) return false;
    const state = this.states.get(asset);
    if (!state?.document) return true;
    return !!expected && isLocalCommitted(state) && sameJson(expected, state.local_commit) && !state.in_flight && !state.pump_promise && !state.storage_error && !state.ack_local_barrier;
  }
  async forkFromServerRevision(input: Parameters<SaveQueue['initializeFromServerRevision']>[0], sources: readonly SourceRef[], options: { expectedCurrent?: LocalCommitEvidence | null } = {}): Promise<boolean> {
    const owner = this.owner, existing = this.states.get(input.asset_revision_id);
    const stillCurrent = () => this.current(owner) && this.states.get(input.asset_revision_id) === existing && this.canInstallSwitch(input.asset_revision_id, options.expectedCurrent);
    if (input.document.asset_revision_id !== input.asset_revision_id || input.document.ontology_version_id !== input.ontology_version_id || !Number.isSafeInteger(input.generation) || input.generation < 0) throw new Error('server revision baseline does not match its asset, ontology, or generation');
    if (!await this.canSwitch(input.asset_revision_id, options.expectedCurrent)) return false;
    for (const ref of sources) { const row = await this.readDraftBranch(input.asset_revision_id, ref.draft_id); if (!row || row.write_token !== ref.write_token || ref.action !== 'use_server') return false; }
    if (!stillCurrent()) return false;
    if (existing) this.clearTimer(existing);
    this.states.delete(input.asset_revision_id);
    if (!this.initializeFromServerRevision(input)) return false;
    const state = this.states.get(input.asset_revision_id)!;
    state.sources = structuredClone(sources);
    this.persist(state);
    await this.whenPersisted(input.asset_revision_id);
    if (!this.current(owner) || this.states.get(input.asset_revision_id) !== state) return false;
    for (const ref of sources) { const row = await this.readDraftBranch(input.asset_revision_id, ref.draft_id); if (!row || row.write_token !== ref.write_token) { state.paused = true; state.local_commit = null; this.recompute(state); return false; } }
    return this.states.get(input.asset_revision_id) === state && isLocalCommitted(state);
  }

  toRecord(asset_revision_id: Id): DraftRecord | null {
    const state = this.states.get(asset_revision_id);
    if (state === undefined) return null;
    return {
      ...state.raw_record,
      schema_version: 1,
      asset_revision_id: state.asset_revision_id,
      ontology_version_id: state.ontology_version_id,
      base_revision_id: state.base_revision_id ?? '',
      generation: state.local_generation,
      document: state.document as AnnotationDocument,
      pending: state.pending,
      pending_outcome: state.pending_outcome,
      draft_owner: state.draft_owner,
      pending_owner: state.pending_owner,
      used_operation_ids: [...state.used_operation_ids],
      edit_seq: state.edit_seq,
      writes_paused: state.paused || state.ack_local_barrier !== null,
      save_error: state.save_error ? { ...state.save_error } : null,
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
      draft_id: this.newDraftId(),
      write_token: '',
      sources: [],
      raw_record: {},
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
      draft_owner: null,
      summary_owner: null,
      pending_owner: null,
      owner_paused: false,
      in_flight: null,
      dirty: false,
      next_eligible_at: 0,
      timer: null,
      paused: false,
      ack_local_barrier: null,
      ack_continuation: null,
      conflict: null,
      storage_error: null,
      save_error: null,
      last_ack: null,
      pending_outcome: 'prepared',
      version: 0,
      local_commit: null,
      persist_seq: 0,
      persist_promise: Promise.resolve(),
      pump_promise: null,
      snapshot: IDLE_SNAPSHOT,
    };
  }

  private schedule(state: AssetState, delayMs: number, guard: SaveSyncGuard = () => true): void {
    const owner = this.owner;
    if (!this.writable(owner)) return;
    this.clearTimer(state);
    state.timer = this.clock.setTimeout(() => {
      state.timer = null;
      if (this.writable(owner) && guard()) void this.runPump(state, false, guard);
    }, delayMs);
  }

  private clearTimer(state: AssetState): void {
    if (state.timer !== null) {
      this.clock.clearTimeout(state.timer);
      state.timer = null;
    }
  }

  private runPump(state: AssetState, force: boolean, guard: SaveSyncGuard = () => true, manualReplay = false, singleOperation = false): Promise<void> {
    const owner = this.owner;
    if (!this.writable(owner) || !guard() || this.states.get(state.asset_revision_id) !== state) return Promise.resolve();
    if (state.pump_promise !== null) return state.pump_promise;
    if (!this.authorizedWork(state, owner)) return Promise.resolve();
    if (state.ack_local_barrier) return Promise.resolve();
    const retained = manualReplay ? state.pending : null;
    if ((state.owner_paused || state.paused) && retained === null) return Promise.resolve();
    // Only the explicit action owns this one retained identity. Generic flush,
    // asset switch and timers never gain permission to resend a rejection.
    if (state.pending && (!force || (!manualReplay && state.pending_outcome !== 'prepared'))) return Promise.resolve();
    const rejectedOnly = singleOperation || (retained !== null && state.pending_outcome === 'rejected');
    if (force) state.next_eligible_at = 0;
    const continuation = state.ack_continuation;
    if (continuation && !continuation.continueWork && !manualReplay) return Promise.resolve();
    const scoped = () => this.writable(owner) && guard() && this.states.get(state.asset_revision_id) === state &&
      (!continuation || (continuation.owner === owner && continuation.guard())) && this.authorizedWork(state, owner, false);
    const run = this.pumpLoop(state, force, scoped, owner, retained, rejectedOnly).finally(() => {
      if (state.pump_promise === run) state.pump_promise = null;
    });
    state.pump_promise = run;
    return run;
  }

  private async pumpLoop(state: AssetState, explicit: boolean, guard: SaveSyncGuard, owner: SaveQueueOwner,
    retained: PendingOperation | null, rejectedOnly: boolean): Promise<void> {
    let permission = retained;
    for (;;) {
      if (!guard()) return;
      const replay = permission !== null && state.pending === permission;
      const retainedReceipt = replay && state.pending_outcome !== 'prepared';
      if (state.ack_local_barrier || (state.paused && !replay) || (!explicit && state.save_error !== null) || !state.dirty || state.document === null) {
        this.clearTimer(state);
        return;
      }
      if (state.pending === null) {
        await this.whenPersisted(state.asset_revision_id);
        if (!guard() || state.paused || state.ack_local_barrier || state.storage_error || state.save_error || !isLocalCommitted(state)) return;
      }
      const waitMs = state.next_eligible_at - this.clock.now();
      if (waitMs > 0) {
        this.schedule(state, waitMs, guard);
        return;
      }
      this.clearTimer(state);
      if (!retainedReceipt && !owner.canPrepareOperation(state.asset_revision_id, state.ontology_version_id)) return;
      const operation = this.prepareOperation(state, owner, guard);
      if (!operation || !guard()) return;
      const valid = () => guard() && state.pending === operation;
      const historicalUnknown = state.pending_outcome === 'unknown';
      permission = null;
      // The send permit never releases the editing barrier or old diagnosis.
      if (replay) state.paused = true;
      state.pending_outcome = 'unknown';
      state.in_flight = operation;
      this.persist(state, guard);
      this.recompute(state);
      try {
        if (!valid()) return;
        if (!retainedReceipt && !owner.canPrepareOperation(state.asset_revision_id, state.ontology_version_id)) {
          state.in_flight = null;
          state.pending_outcome = 'prepared';
          state.paused = true;
          this.persist(state, guard);
          this.recompute(state);
          return;
        }
        if (!valid()) return;
        if (!retainedReceipt) {
          const lease = owner.getLease(state.asset_revision_id);
          if (!valid() || !sameJson(lease, operation.request.lease)) {
            state.in_flight = null;
            state.pending_outcome = 'prepared';
            state.paused = true;
            this.persist(state, guard);
            this.recompute(state);
            return;
          }
        }
        const response = await this.transport.save(operation.request, state.asset_revision_id);
        if (!valid()) return;
        state.in_flight = null;
        if (!this.applyAck(state, operation, response, guard, !rejectedOnly)) return;
        if (rejectedOnly) return;
      } catch (error) {
        if (!valid()) return;
        state.in_flight = null;
        const failure = toTransportError(error);
        if (!historicalUnknown && failure.kind !== 'network' && failure.status !== null && failure.status >= 400 && failure.status < 500) {
          state.pending_outcome = 'rejected';
        }
        this.applyFailure(state, operation, failure, guard);
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

  /** Both authors are independent: never infer pending provenance from draft provenance. */
  private authorizedWork(state: AssetState, owner = this.owner, report = true): boolean {
    if (!isDirty(state)) return true;
    const matches = (binding: DraftRecord['draft_owner']) => !!owner && !!binding &&
      binding.actor_id === owner.actor_id && binding.project_id === owner.project_id;
    const pendingInvalid = state.pending !== null && !matches(state.pending_owner);
    if (matches(state.draft_owner) && !pendingInvalid) return true;
    if (report) {
      const binding = pendingInvalid ? state.pending_owner : state.draft_owner;
      const prefix = pendingInvalid ? 'PENDING' : 'DRAFT';
      state.paused = true;
      state.save_error = { kind: 'http', status: null, request_id: null,
        code: prefix + (binding ? '_OWNER_MISMATCH' : '_OWNER_UNKNOWN'),
        message: 'Original draft author cannot be authorized; export the local draft' };
      this.recompute(state);
    }
    return false;
  }

  private prepareOperation(state: AssetState, owner: SaveQueueOwner, guard: SaveSyncGuard, capturedLease?: SaveRequest['lease']): PendingOperation | null {
    const reusable = state.pending;
    if (reusable !== null) {
      return reusable;
    }
    if (!this.writable(owner) || !guard() || !owner.canPrepareOperation(state.asset_revision_id, state.ontology_version_id)) return null;
    const suggestion_decisions = state.journal.slice(state.synced_intent_seq).map((entry) => entry.intent);
    const lease = capturedLease === undefined ? owner.getLease(state.asset_revision_id) : capturedLease;
    if (capturedLease !== undefined && !sameJson(owner.getLease(state.asset_revision_id), capturedLease)) return null;
    if (!this.writable(owner) || !guard() || !owner.canPrepareOperation(state.asset_revision_id, state.ontology_version_id)) return null;
    const operation_id = this.mintOperationId(state);
    if (!this.writable(owner) || !guard() || !owner.canPrepareOperation(state.asset_revision_id, state.ontology_version_id) ||
      (capturedLease !== undefined && !sameJson(owner.getLease(state.asset_revision_id), lease))) return null;
    const request: SaveRequest = {
      operation_id,
      base_revision_id: state.base_revision_id ?? '',
      document: state.document as AnnotationDocument,
      lease: lease === null ? null : { task_id: lease.task_id, fencing_token: lease.fencing_token },
      suggestion_decisions,
    };
    const operation: PendingOperation = {
      operation_id: request.operation_id,
      generation: state.local_generation,
      journal_seq_end: state.journal.length,
      edit_seq: state.edit_seq,
      prepared_at: iso(this.clock.now()),
      request,
    };
    freezeDeep(operation);
    state.ack_continuation = null;
    state.pending = operation;
    state.pending_owner = freezeDeep({ actor_id: owner.actor_id, project_id: owner.project_id });
    state.pending_outcome = 'prepared';
    state.version += 1;
    return operation;
  }

  private applyAck(state: AssetState, operation: PendingOperation, response: SaveResponse, guard: SaveSyncGuard, continueWork: boolean): boolean {
    if (!guard() || state.pending !== operation) return false;
    if (response.operation_id !== operation.request.operation_id ||
      typeof response.revision?.annotation_revision_id !== 'string' || !response.revision.annotation_revision_id ||
      !sameJson(response.revision.document, operation.request.document)) {
      this.applyFailure(
        state,
        operation,
        new TransportError({
          kind: 'http',
          status: null,
          code: 'PROTOCOL_MISMATCH',
          message: 'SaveResponse.operation_id does not match the request',
        }),
        guard,
      );
      return false;
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

    // The previous certificate describes pre-ACK state, never the new receipt.
    state.local_commit = null;
    state.local_generation = next.local_generation;
    state.synced_generation = next.synced_generation;
    state.base_revision_id = next.base_revision_id;
    state.synced_intent_seq = Math.max(state.synced_intent_seq, operation.journal_seq_end);
    state.pending = null;
    state.pending_owner = null;
    state.pending_outcome = 'prepared';
    state.version += 1;
    state.save_error = null;
    state.paused = false;
    state.owner_paused = false;
    state.conflict = null;
    state.last_ack = {
      revision_id: response.revision.annotation_revision_id,
      generation: operation.generation,
      at: iso(this.clock.now()),
    };
    state.dirty = isDirty(state);
    if (!state.dirty && state.edit_seq === operation.edit_seq) state.draft_owner = null;
    const owner = this.owner;
    state.paused = state.dirty && (!owner || !owner.canPrepareOperation(state.asset_revision_id, state.ontology_version_id));
    const receipt = state.last_ack;
    this.clearTimer(state);
    if (owner) state.ack_local_barrier = { owner, guard, receipt, continueWork };
    // Durable receipt work survives clearing pending, but not another receipt or owner.
    this.persist(state, () => guard() && this.writable(owner) && state.last_ack === receipt);
    this.recompute(state);
    return true;
  }

  private applyFailure(state: AssetState, operation: PendingOperation, failure: TransportError, guard: SaveSyncGuard): void {
    if (!guard() || state.pending !== operation) return;
    state.save_error = {
      kind: failure.kind,
      code: failure.code,
      message: failure.message,
      status: failure.status,
      request_id: failure.api_error?.request_id ?? null,
    };
    if (failure.kind === 'conflict') {
      state.paused = true;
      state.conflict = { code: failure.code, message: failure.message };
    }
    // Keep the immutable payload until its actual ACK, even if newer edits exist.
    state.version += 1;
    state.dirty = isDirty(state);
    this.persist(state, guard);
    this.recompute(state);
  }

  private fetchHead(state: AssetState): Promise<AnnotationRevision | null> {
    return this.transport.fetchHead(state.asset_revision_id, state.ontology_version_id);
  }

  private persist(state: AssetState, guard: SaveSyncGuard = () => true): void {
    const owner = this.owner;
    const barrier = state.ack_local_barrier;
    const current = () => this.writable(owner) && guard() && this.states.get(state.asset_revision_id) === state && this.authorizedWork(state, owner, false) &&
      (!barrier || (owner === barrier.owner && barrier.guard() && state.last_ack === barrier.receipt && state.ack_local_barrier === barrier));
    if (!current()) { state.local_commit = null; return; }
    const record = this.toRecord(state.asset_revision_id);
    if (record === null) return;
    if (barrier) record.writes_paused = state.paused;
    state.persist_seq += 1;
    this.recompute(state);
    const seq = state.persist_seq;
    const editSeq = state.edit_seq;
    const version = state.version;
    state.persist_promise = this.store.save({ asset_revision_id: state.asset_revision_id, draft_id: state.draft_id, write_token: state.write_token, sources: state.sources, record }, current)
      .then((committed) => {
        if (!committed || !current() || state.persist_seq !== seq || state.edit_seq !== editSeq || state.version !== version) return;
        state.storage_error = null;
        state.write_token = committed.write_token;
        state.local_commit = { draft_id: state.draft_id, write_token: committed.write_token, persist_seq: seq, edit_seq: editSeq, generation: record.generation };
        if (barrier) {
          state.ack_local_barrier = null;
          state.ack_continuation = state.dirty ? barrier : null;
        }
        // Resume only after the latest genuine receipt commit, with the original
        // scope through dispatch and debounce. One-shot actions never lend it.
        if (barrier?.continueWork && !state.paused && state.dirty) {
          this.schedule(state, Math.max(0, state.next_eligible_at - this.clock.now()), barrier.guard);
        }
        this.recompute(state);
      })
      .catch((error: unknown) => {
        // A failed active receipt stays diagnosed until a newer full physical
        // record commits; mere supersession is not evidence of durability.
        if (!current() || (!barrier && (state.persist_seq !== seq || state.edit_seq !== editSeq || state.version !== version))) return;
        state.storage_error = {
          code: error instanceof StorageError ? error.code : 'STORAGE_FAILED',
          message: error instanceof Error ? error.message : String(error),
        };
        state.local_commit = null;
        this.recompute(state);
      });
  }

  private recompute(state: AssetState): void {
    const lastError =
      state.storage_error !== null
        ? { kind: 'storage' as const, code: state.storage_error.code, message: state.storage_error.message }
        : state.save_error !== null
          ? { kind: state.save_error.kind, code: state.save_error.code, message: state.save_error.message, request_id: state.save_error.request_id }
          : null;
    state.snapshot = {
      phase: phaseOf(state),
      dirty: state.dirty,
      saving: state.in_flight !== null,
      writes_paused: state.paused || state.ack_local_barrier !== null,
      local_generation: state.local_generation,
      synced_generation: state.synced_generation,
      base_revision_id: state.base_revision_id,
      draft_exportable: state.document !== null,
      last_error: lastError,
      local_commit: isLocalCommitted(state) ? state.local_commit : null,
      last_ack: state.last_ack,
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
    return await this.readContract<SaveResponse>(response, 'save_response');
  }

  async fetchHead(asset_revision_id: Id, ontology_version_id: Id): Promise<AnnotationRevision | null> {
    const query = `?ontology_version_id=${encodeURIComponent(ontology_version_id)}`;
    const response = await this.send(`${this.baseUrl}/api/assets/${asset_revision_id}/annotation${query}`, {
      method: 'GET',
      csrf: false,
    });
    if (response.status === 404) return null;
    if (!response.ok) throw await this.failureOf(response);
    return await this.readContract<AnnotationRevision>(response, 'annotation_revision');
  }

  async fetchRevision(annotation_revision_id: Id): Promise<AnnotationRevision> {
    const response = await this.send(
      `${this.baseUrl}/api/annotation-revisions/${annotation_revision_id}`,
      { method: 'GET', csrf: false },
    );
    if (!response.ok) throw await this.failureOf(response);
    return await this.readContract<AnnotationRevision>(response, 'annotation_revision');
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

  private async readContract<T>(response: Response, name: 'save_response' | 'annotation_revision'): Promise<T> {
    let value: unknown;
    try { value = await response.json(); }
    catch { throw new TransportError({ kind: 'http', status: 502, code: 'INVALID_ANNOTATION_RESPONSE', message: 'The annotation response is not valid JSON' }); }
    if (!validateContract(name, value).valid) {
      throw new TransportError({ kind: 'http', status: 502, code: 'INVALID_ANNOTATION_RESPONSE', message: 'The annotation response does not match its contract' });
    }
    return value as T;
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
