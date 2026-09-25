//! Client-side Codex session state machine (docs/contracts.md C5,
//! docs/provider-compatibility.md).
//!
//! Enforces the documented handshake (exactly one `initialize` request followed
//! by `initialized`; other requests before the handshake and repeated
//! initialization are rejected), folds the documented thread/turn/item event
//! families without ever letting unexpected notifications corrupt state, maps
//! runtime auth/model state to honest availability, classifies the four
//! distinct unavailable reasons, and folds turn usage exactly once so exit,
//! cancel, disconnect and out-of-order events can never double-bill.
//!
//! PINNED SCHEMA (project-side, T32 prerequisite): `authenticate`/`models`
//! (fixed by the T22 card), `thread_id`, `turn_id`, `status`, `usage`,
//! `proposals` and `error.data.state` are project pins over the T02-documented
//! message families. They MUST be re-derived from `codex app-server
//! generate-ts`/`generate-json-schema` output in T32 (CLI absent here). Every
//! unrecognized method, field or value is tolerated as unknown and ignored —
//! never guessed, never fatal to the session state.

import type { ModelProfile } from '../../../../../packages/contracts/generated/ModelProfile';
import { mergeUsage, normalizeUsage, type NormalizedUsage, type TokenPricing } from '../http/usage';
import {
  FORBIDDEN_METHODS,
  INITIALIZE_METHOD,
  INITIALIZED_METHOD,
  TURN_STATUSES,
  isItemEvent,
  isThreadEvent,
  isTurnEvent,
  type CodexErrorObject,
  type CodexMessage,
} from './protocol';

export interface CodexRuntimeState {
  authenticated: boolean;
  models: string[];
  runtime_version?: string | null;
}

export type CodexUnavailableReason = 'needs_login' | 'model_unavailable' | 'insufficient_quota' | 'approval_required';

export type CodexTurnStatus = 'in_progress' | 'completed' | 'failed' | 'interrupted';

export interface CodexTurnState {
  turn_id: string;
  thread_id: string | null;
  status: CodexTurnStatus;
  items_seen: number;
  usage_raw: Record<string, unknown> | null;
  usage_folded: boolean;
  terminal: boolean;
  /**
   * Proposals observed for this turn across every event, deduplicated by their
   * serialized payload: candidates are emitted from turn state at terminal
   * time, so a terminal event without proposals never drops earlier ones.
   */
  proposals: Record<string, unknown>[];
  proposal_keys: Set<string>;
}

export interface CodexThreadState {
  thread_id: string;
  events_seen: number;
}

export interface CodexSessionState {
  phase: 'new' | 'initializing' | 'awaiting_initialized' | 'ready';
  runtime: CodexRuntimeState | null;
  threads: Map<string, CodexThreadState>;
  turns: Map<string, CodexTurnState>;
  /**
   * The turn started by THIS run (turn/start response). Foreign or unsolicited
   * turn ids never terminate the run and never fold usage into its billing.
   */
  run_turn_id: string | null;
  ignored_events: number;
  duplicate_billing_events: number;
  violations: string[];
}

const UNAVAILABLE_REASONS: Record<string, CodexUnavailableReason> = {
  needs_login: 'needs_login',
  model_unavailable: 'model_unavailable',
  insufficient_quota: 'insufficient_quota',
  approval_required: 'approval_required',
};
const TERMINAL_STATUSES: Record<string, true> = { completed: true, failed: true, interrupted: true };
const MAX_ID_LENGTH = 128;
const MAX_TURN_PROPOSALS = 1000;

function validRef(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>; // narrowed by the runtime check above
}

function withViolation(state: CodexSessionState, code: string): CodexSessionState {
  return { ...state, violations: [...state.violations, code] };
}

/**
 * The T22 card fixes this normalized shape. Auth absence wins over any model
 * list; an authenticated account without an entitled model is not "ready".
 * Verification is never claimed here: live evidence is T32's gate.
 */
export function classifyCodexState(state: CodexRuntimeState): {
  availability: ModelProfile['availability'];
  verification: ModelProfile['verification'];
} {
  if (state.authenticated !== true) return { availability: 'needs_login', verification: 'not_run' };
  if (state.models.length === 0) return { availability: 'needs_configuration', verification: 'not_run' };
  return { availability: 'ready', verification: 'not_run' };
}

/**
 * PINNED MARKER (T32 must regenerate): only an exact `error.data.state` match
 * to one of the four product states classifies an error as "unavailable";
 * anything else is a generic provider failure, never a guessed state.
 */
export function classifyUnavailable(error: CodexErrorObject): CodexUnavailableReason | null {
  const data = recordOf(error.data);
  if (data === null) return null;
  const state = data.state;
  if (typeof state !== 'string') return null;
  return UNAVAILABLE_REASONS[state] ?? null;
}

/** Strict normalization of the pinned initialize result; unknown fields are ignored. */
export function normalizeRuntimeState(result: unknown): CodexRuntimeState | null {
  const record = recordOf(result);
  if (record === null) return null;
  if (typeof record.authenticated !== 'boolean') return null;
  const { models } = record;
  if (!Array.isArray(models) || models.some((model) => !validRef(model))) return null;
  const version = record.runtime_version;
  if (version !== undefined && version !== null && typeof version !== 'string') return null;
  return {
    authenticated: record.authenticated,
    models: [...(models as string[])],
    runtime_version: typeof version === 'string' ? version : null,
  };
}

export function newCodexSession(): CodexSessionState {
  return {
    phase: 'new',
    runtime: null,
    threads: new Map(),
    turns: new Map(),
    run_turn_id: null,
    ignored_events: 0,
    duplicate_billing_events: 0,
    violations: [],
  };
}

/**
 * Binds the session to the turn this run started. Any turn entry recorded
 * before the binding (unsolicited/rogue events) is dropped and counted as
 * ignored, so foreign usage can never reach this run's billing.
 */
export function noteRunTurn(state: CodexSessionState, turn_id: string): CodexSessionState {
  if (state.run_turn_id === turn_id) return state;
  let ignored_events = state.ignored_events;
  const turns = new Map<string, CodexTurnState>();
  for (const [id, turn] of state.turns) {
    if (id === turn_id) turns.set(id, turn);
    else ignored_events += 1;
  }
  return { ...state, run_turn_id: turn_id, turns, ignored_events };
}

/** Records the outgoing single `initialize` request; repeated initialization is rejected. */
export function beginInitialize(state: CodexSessionState): CodexSessionState {
  if (state.phase !== 'new') return withViolation(state, 'duplicate_initialize');
  return { ...state, phase: 'initializing' };
}

/** Records the outgoing `initialized` notification that completes the handshake. */
export function markInitialized(state: CodexSessionState): CodexSessionState {
  if (state.phase === 'awaiting_initialized') return { ...state, phase: 'ready' };
  if (state.phase === 'ready') return state;
  return withViolation(state, 'initialized_out_of_order');
}

/** Other requests before the handshake are rejected; out-of-sandbox methods never pass. */
export function canSendRequest(state: CodexSessionState, method: string): boolean {
  if (FORBIDDEN_METHODS.includes(method)) return false;
  if (method === INITIALIZE_METHOD) return state.phase === 'new';
  return state.phase === 'ready';
}

function foldProposals(
  entry: CodexTurnState,
  raw: unknown,
): { added: number; duplicates: number } {
  if (!Array.isArray(raw)) return { added: 0, duplicates: 0 };
  let added = 0;
  let duplicates = 0;
  for (const proposal of raw) {
    const record = recordOf(proposal);
    if (record === null) continue;
    // Bounded, content-deduplicated accumulation: replayed events must never
    // duplicate a candidate, but a proposal seen in any event is preserved.
    if (entry.proposals.length >= MAX_TURN_PROPOSALS && !entry.proposal_keys.has(JSON.stringify(record))) {
      continue;
    }
    const key = JSON.stringify(record);
    if (entry.proposal_keys.has(key)) {
      duplicates += 1;
      continue;
    }
    entry.proposal_keys.add(key);
    entry.proposals.push(record);
    added += 1;
  }
  return { added, duplicates };
}

function foldTurn(state: CodexSessionState, params: Record<string, unknown>): CodexSessionState {
  const turn_id = params.turn_id;
  if (!validRef(turn_id)) return { ...state, ignored_events: state.ignored_events + 1 };
  // Once the run's own turn is known, every other turn id is foreign: it is
  // never registered, never billed, and can never terminate the run.
  if (state.run_turn_id !== null && turn_id !== state.run_turn_id) {
    return { ...state, ignored_events: state.ignored_events + 1 };
  }
  const previous = state.turns.get(turn_id);
  const entry: CodexTurnState = {
    turn_id,
    thread_id: previous?.thread_id ?? null,
    status: previous?.status ?? 'in_progress',
    items_seen: previous?.items_seen ?? 0,
    usage_raw: previous?.usage_raw ?? null,
    usage_folded: previous?.usage_folded ?? false,
    terminal: previous?.terminal ?? false,
    proposals: previous?.proposals ?? [],
    proposal_keys: previous?.proposal_keys ?? new Set<string>(),
  };
  if (validRef(params.thread_id)) entry.thread_id = params.thread_id;
  const status = params.status;
  if (typeof status === 'string' && TURN_STATUSES.includes(status)) {
    entry.status = status as CodexTurnStatus;
    entry.terminal = TERMINAL_STATUSES[status] === true;
  }
  foldProposals(entry, params.proposals);
  let duplicate_billing_events = state.duplicate_billing_events;
  const usage = params.usage;
  if (usage !== undefined && usage !== null) {
    // First reported usage for a turn wins; replays and late duplicates are
    // counted as duplicates and never added again (no double-billing).
    if (entry.usage_folded) duplicate_billing_events += 1;
    else {
      entry.usage_raw = recordOf(usage) ?? {};
      entry.usage_folded = true;
    }
  }
  const turns = new Map(state.turns);
  turns.set(turn_id, entry);
  return { ...state, turns, duplicate_billing_events };
}

function foldThread(state: CodexSessionState, params: Record<string, unknown>): CodexSessionState {
  const thread_id = params.thread_id;
  if (!validRef(thread_id)) return { ...state, ignored_events: state.ignored_events + 1 };
  const previous = state.threads.get(thread_id);
  const threads = new Map(state.threads);
  threads.set(thread_id, { thread_id, events_seen: (previous?.events_seen ?? 0) + 1 });
  return { ...state, threads };
}

function foldItem(state: CodexSessionState, params: Record<string, unknown>): CodexSessionState {
  const turn_id = params.turn_id;
  const previous = validRef(turn_id) ? state.turns.get(turn_id) : undefined;
  // Out-of-order items for unknown turns are ignored; known turns only count.
  if (previous === undefined) return { ...state, ignored_events: state.ignored_events + 1 };
  const entry = { ...previous, items_seen: previous.items_seen + 1 };
  // Proposals may ride item events as well as turn events; both are folded
  // into turn state so terminal handling never depends on message order.
  foldProposals(entry, params.proposals);
  const turns = new Map(state.turns);
  turns.set(entry.turn_id, entry);
  return { ...state, turns };
}

function foldInitializeResult(state: CodexSessionState, runtime: CodexRuntimeState): CodexSessionState {
  // Repeated initialization (a second initialize result) is rejected and must
  // not overwrite the established runtime state.
  if (state.runtime !== null) return withViolation(state, 'duplicate_initialize');
  return {
    ...state,
    runtime,
    phase: state.phase === 'ready' ? 'ready' : 'awaiting_initialized',
  };
}

/**
 * Folds one peer message into the session. This function never throws and
 * never trusts payloads: unexpected methods, unknown fields, malformed
 * references and out-of-order events are recorded as ignored and leave the
 * established threads, turns, runtime state and billing untouched.
 */
export function foldCodexMessage(state: CodexSessionState, message: CodexMessage): CodexSessionState {
  if (message.kind === 'notification') {
    if (message.method === INITIALIZED_METHOD) {
      return state.phase === 'awaiting_initialized' ? { ...state, phase: 'ready' } : state;
    }
    if (isThreadEvent(message.method)) return foldThread(state, message.params);
    if (isTurnEvent(message.method)) return foldTurn(state, message.params);
    if (isItemEvent(message.method)) return foldItem(state, message.params);
    return { ...state, ignored_events: state.ignored_events + 1 };
  }
  if (message.kind === 'request') {
    if (message.method === INITIALIZE_METHOD) return withViolation(state, 'duplicate_initialize');
    return { ...state, ignored_events: state.ignored_events + 1 };
  }
  if (message.result !== null) {
    const runtime = normalizeRuntimeState(message.result);
    if (runtime !== null) return foldInitializeResult(state, runtime);
    const params = message.result;
    if (validRef(params.turn_id)) return foldTurn(state, params);
    return { ...state, ignored_events: state.ignored_events + 1 };
  }
  // Error responses are classified by the caller (classifyUnavailable); the
  // session itself only records that the message carried no state.
  return { ...state, ignored_events: state.ignored_events + 1 };
}

export function sessionUnavailable(state: CodexSessionState): CodexUnavailableReason | null {
  if (state.runtime === null) return null;
  if (state.runtime.authenticated !== true) return 'needs_login';
  if (state.runtime.models.length === 0) return 'model_unavailable';
  return null;
}

/**
 * Usage totals folded at most once per turn. Turns that reported no usage
 * contribute nothing and a run with no reported usage stays fully unknown —
 * never zero. Cost is only computed from explicit pricing.
 */
export function billingTotals(state: CodexSessionState, pricing: TokenPricing | null = null): NormalizedUsage {
  let totals: NormalizedUsage | null = null;
  for (const turn of state.turns.values()) {
    // Only the run's own turn is billable to the run; foreign turns never fold.
    if (state.run_turn_id !== null && turn.turn_id !== state.run_turn_id) continue;
    if (!turn.usage_folded || turn.usage_raw === null) continue;
    const turnUsage = normalizeUsage(turn.usage_raw, pricing);
    totals = totals === null ? turnUsage : mergeUsage(totals, turnUsage, pricing);
  }
  return totals ?? normalizeUsage(null, pricing);
}
