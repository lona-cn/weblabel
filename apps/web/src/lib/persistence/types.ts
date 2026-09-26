// T13 · IndexedDB 恢复与单飞保存队列 — persistence layer contracts.
//
// Wire types are the frozen C1 generated contracts and are never re-declared
// here. This module owns only the persistence-layer vocabulary (draft records,
// queue status) and the three injectable seams the queue needs: storage, HTTP
// and clock. Production wiring supplies real implementations (IndexedDB,
// fetch, Date/setTimeout); unit tests inject controllable ones.
import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import type { ApiError } from '../../../../../packages/contracts/generated/ApiError';
import type { Id } from '../../../../../packages/contracts/generated/Id';
import type { SaveRequest } from '../../../../../packages/contracts/generated/SaveRequest';
import type { SaveResponse } from '../../../../../packages/contracts/generated/SaveResponse';
import type { SuggestionDecisionIntent } from '../../../../../packages/contracts/generated/SuggestionDecisionIntent';

export type {
  AnnotationDocument,
  AnnotationRevision,
  ApiError,
  Id,
  SaveRequest,
  SaveResponse,
  SuggestionDecisionIntent,
};

/** Current IndexedDB draft record schema. Bump on any breaking record change. */
export const DRAFT_SCHEMA_VERSION = 1;

/** Logical-operation debounce: one quiet window coalesces edits into one save. */
export const SAVE_DEBOUNCE_MS = 400;

/** One suggestion decision produced by one logical operation (EditorDelta). */
export interface IntentJournalEntry {
  /** Monotonic per record; the journal is ordered and never merged or deduped. */
  seq: number;
  /** Editor generation at which the intent was recorded. */
  generation: number;
  intent: SuggestionDecisionIntent;
  /** UTC RFC3339 (C1). */
  recorded_at: string;
}

/**
 * A prepared save request. Prepared at send time and then immutable: a retry
 * re-sends exactly this request, and any new local modification replaces the
 * pending operation with a brand-new operation_id instead of mutating it.
 */
export interface PendingOperation {
  operation_id: Id;
  /** Local document generation captured in request.document. */
  generation: number;
  /** Journal length at preparation; intents [0, journal_seq_end) ride in the request. */
  journal_seq_end: number;
  /** Local edit counter at preparation: a retry reuses the operation only when no new edit happened. */
  edit_seq: number;
  prepared_at: string;
  request: SaveRequest;
}

/**
 * The single IndexedDB record shape (architecture.md §9 + card T13 behavior 7):
 * schema_version / base_revision_id / generation / document / pending operation
 * / intent journal, plus the sync markers needed to restore dirty state.
 */
export interface DraftRecord {
  schema_version: typeof DRAFT_SCHEMA_VERSION;
  asset_revision_id: Id;
  ontology_version_id: Id;
  base_revision_id: Id;
  /** Local editor generation of `document`. */
  generation: number;
  document: AnnotationDocument;
  pending: PendingOperation | null;
  intent_journal: IntentJournalEntry[];
  /** Highest generation acknowledged by the server. */
  synced_generation: number;
  /** Journal entries [0, synced_intent_seq) were acknowledged with a save. */
  synced_intent_seq: number;
  updated_at: string;
}

/** Injectable clock: tests drive debounce timing deterministically. */
export interface Clock {
  now(): number;
  setTimeout(handler: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Timer handle created by `realClock.setTimeout` (browser number or NodeJS.Timeout). */
export type RealTimerHandle = NodeJS.Timeout | number;

/** Production clock over the platform timers (honours vitest fake timers). */
export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (handler, delayMs): RealTimerHandle => globalThis.setTimeout(handler, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as RealTimerHandle),
};

/** Injectable local persistence (IndexedDB in production). Failures throw. */
export interface DraftStorage {
  get(asset_revision_id: Id): Promise<DraftRecord | null>;
  put(record: DraftRecord): Promise<void>;
  delete(asset_revision_id: Id): Promise<void>;
}

/**
 * Structured storage failure. `QUOTA_EXCEEDED` is the browser quota rejection
 * and must surface as a visible storage failure, never as "saved locally".
 */
export class StorageError extends Error {
  readonly code: string;

  constructor(init: { code: string; message: string }) {
    super(init.message);
    this.name = 'StorageError';
    this.code = init.code;
  }
}

export type TransportFailureKind = 'network' | 'http' | 'conflict';

/**
 * Structured transport failure. `conflict` is HTTP 409 (REVISION_CONFLICT,
 * IDEMPOTENCY_KEY_REUSE, …) and stops automatic writes until the user resolves.
 */
export class TransportError extends Error {
  readonly kind: TransportFailureKind;
  readonly status: number | null;
  readonly code: string;
  readonly api_error: ApiError | null;

  constructor(init: {
    kind: TransportFailureKind;
    message: string;
    status?: number | null;
    code?: string;
    api_error?: ApiError | null;
  }) {
    super(init.message);
    this.name = 'TransportError';
    this.kind = init.kind;
    this.status = init.status ?? null;
    this.code = init.code ?? (init.kind === 'network' ? 'NETWORK_UNREACHABLE' : 'HTTP_ERROR');
    this.api_error = init.api_error ?? null;
  }
}

/** Injectable HTTP boundary against the T11 save API. */
export interface SaveTransport {
  /** PUT /api/assets/{asset_revision_id}/annotation — SaveRequest → SaveResponse. */
  save(request: SaveRequest, asset_revision_id: Id): Promise<SaveResponse>;
  /** GET /api/assets/{asset_revision_id}/annotation?ontology_version_id=… → head or null (404). */
  fetchHead(asset_revision_id: Id, ontology_version_id: Id): Promise<AnnotationRevision | null>;
  /** GET /api/annotation-revisions/{annotation_revision_id} → immutable revision. */
  fetchRevision(annotation_revision_id: Id): Promise<AnnotationRevision>;
}

/**
 * Save status shown by SaveStatus. Phase precedence:
 * conflict > storage_error > saving > save_failed > saved_local > unsaved >
 * synced > idle. A storage failure therefore can never claim "saved locally".
 */
export type SavePhase =
  | 'idle'
  | 'unsaved'
  | 'saved_local'
  | 'saving'
  | 'synced'
  | 'save_failed'
  | 'storage_error'
  | 'conflict';

export interface SaveStatusSnapshot {
  phase: SavePhase;
  /** Local generation ahead of (or journal ahead of) what the server acknowledged. */
  dirty: boolean;
  saving: boolean;
  writes_paused: boolean;
  local_generation: number;
  synced_generation: number;
  base_revision_id: Id | null;
  /** A draft exists in memory and can always be downloaded, even when storage failed. */
  draft_exportable: boolean;
  last_error: { kind: TransportFailureKind | 'storage'; code: string; message: string } | null;
}

export interface EnqueueInput {
  asset_revision_id: Id;
  ontology_version_id: Id;
  /** Base revision of the loaded head; required when the asset queue is created. */
  base_revision_id?: Id;
  /** Editor generation of this logical operation (C3: one command, one generation). */
  generation: number;
  document: AnnotationDocument;
  /** EditorDelta.suggestion_decisions produced by this logical operation. */
  suggestion_decisions?: SuggestionDecisionIntent[];
}

/** How the user resolved an HTTP 409 (or a recovery conflict). Never automatic. */
export type ConflictAction = 'keep_local_export' | 'view_server' | 'adopt_server';

/** Result of an explicit user conflict resolution. */
export type ConflictResolution =
  | {
      action: 'keep_local_export';
      /** The CAS base the next save uses (the observed server head). */
      base_revision_id: Id;
      export: NativeDraftExport;
      /** False when the server head could not be observed: writes stay paused. */
      resumed: boolean;
    }
  | { action: 'view_server'; server_head: AnnotationRevision | null }
  | { action: 'adopt_server'; base_revision_id: Id };

/** Construction seams of SaveQueue (storage / HTTP / clock are injectable). */
export interface SaveQueueOptions {
  transport: SaveTransport;
  storage: DraftStorage;
  clock?: Clock;
  debounceMs?: number;
  newOperationId?: () => Id;
}

/** Rescue download for an unsynced draft (testing-contracts §8: marked unsynced). */
export interface NativeDraftExport {
  format: 'weblabel-native-draft';
  schema_version: typeof DRAFT_SCHEMA_VERSION;
  /** Explicit: an unsynced rescue draft must never masquerade as review data. */
  unsynced: true;
  asset_revision_id: Id;
  ontology_version_id: Id;
  base_revision_id: Id;
  generation: number;
  document: AnnotationDocument;
  pending_operation_id: Id | null;
  intent_journal: IntentJournalEntry[];
  exported_at: string;
}
