//! Client-side Claude Code session state machine (docs/contracts.md C5,
//! docs/provider-compatibility.md).
//!
//! Folds the pinned stream-json event families (init metadata, streaming
//! assistant output, tool_use/tool_result boundaries, the terminal result)
//! without ever letting unexpected or foreign events corrupt state. Tool
//! boundaries are tracked exactly (a tool_result must match a live tool_use; a
//! successful result must not leave calls open), proposals are accumulated and
//! content-deduplicated across all events so a draft seen before the terminal
//! result is never dropped, and the result event's usage is folded at most once
//! so replayed/duplicated results can never double-bill. Unknown usage stays
//! unknown (never 0); cost only comes from explicit pricing.
//!
//! PINNED SCHEMA (project-side, T32 prerequisite): `session_id`, `usage`,
//! `structured_output`, `proposals`, `error.state`, `auth_mode`, `model`,
//! `tools`, `mcp_servers`, `mcp_server_errors` are project pins over the
//! T02-documented event families and must be re-derived from real pinned-runtime
//! fixtures in T32. Every unrecognized method, field or value is tolerated as
//! unknown and ignored — never guessed, never fatal to session state.

import type { ModelProfile } from '../../../../../packages/contracts/generated/ModelProfile';
import { normalizeUsage, type NormalizedUsage, type TokenPricing } from '../http/usage';
import { MCP_SERVER_NAME, PERMITTED_TOOLS } from './permissions';
import { INIT_SUBTYPE, type ClaudeEvent } from './protocol';

/** How the runtime authenticated: the subscription channel only accepts the user's official login. */
export type ClaudeAuthMode = 'subscription' | 'api_key' | 'unknown';

export interface ClaudeRuntimeState {
  auth_mode: ClaudeAuthMode;
  model: string | null;
  tools: string[];
  mcp_servers: string[];
  /** `null` means the field was absent: unknown, never "no server failed". */
  mcp_server_errors: Record<string, unknown> | null;
}

export type ClaudeUnavailableReason =
  | 'needs_login'
  | 'model_unavailable'
  | 'subscription_unavailable'
  | 'insufficient_quota'
  | 'api_auth_not_subscription';

export interface ClaudeToolCallState {
  tool_use_id: string;
  name: string;
  resolved: boolean;
  result_bytes: number;
}

export interface ClaudeResultState {
  status: 'success' | 'failed';
  reason: ClaudeUnavailableReason | null;
  error_message: string | null;
}

export interface ClaudeSessionState {
  phase: 'new' | 'running' | 'result_seen';
  /** This run's conversation id (from --session-id); foreign sessions never fold in. */
  run_session_id: string | null;
  requested_model: string | null;
  permitted_tools: readonly string[];
  init: ClaudeRuntimeState | null;
  tool_calls: Map<string, ClaudeToolCallState>;
  tool_calls_total: number;
  tool_result_bytes: number;
  output_blocks: number;
  tool_results_seen: number;
  proposals: Record<string, unknown>[];
  proposal_keys: Set<string>;
  usage_raw: Record<string, unknown> | null;
  usage_folded: boolean;
  result: ClaudeResultState | null;
  ignored_events: number;
  duplicate_billing_events: number;
  violations: string[];
  /** Set when a tool boundary cannot be trusted; the run must fail closed. */
  boundary_violation: string | null;
  /** Set when the tool/MCP policy was breached; the run must fail closed. */
  policy_violation: string | null;
}

export interface NewClaudeSessionOptions {
  run_session_id?: string | null;
  requested_model?: string | null;
  permitted_tools?: readonly string[];
}

/** Alias tokens are taken verbatim from the verified `--model` help text. */
export const MODEL_ALIASES: readonly string[] = ['fable', 'opus', 'sonnet'];

const UNAVAILABLE_REASONS: Record<string, ClaudeUnavailableReason> = {
  needs_login: 'needs_login',
  model_unavailable: 'model_unavailable',
  subscription_unavailable: 'subscription_unavailable',
  insufficient_quota: 'insufficient_quota',
  api_auth_not_subscription: 'api_auth_not_subscription',
};
const AUTH_MODES: Record<string, ClaudeAuthMode> = { subscription: 'subscription', api_key: 'api_key' };
const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 128;
const MAX_TURN_PROPOSALS = 1000;

function validRef(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function validName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_NAME_LENGTH;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>; // narrowed by the runtime check above
}

function withViolation(state: ClaudeSessionState, code: string): ClaudeSessionState {
  return { ...state, violations: [...state.violations, code] };
}

function withPolicyViolation(state: ClaudeSessionState, code: string): ClaudeSessionState {
  return state.policy_violation === null ? { ...state, policy_violation: code } : state;
}

function withBoundaryViolation(state: ClaudeSessionState, code: string): ClaudeSessionState {
  return state.boundary_violation === null ? { ...state, boundary_violation: code } : state;
}

export function newClaudeSession(options: NewClaudeSessionOptions = {}): ClaudeSessionState {
  return {
    phase: 'new',
    run_session_id: options.run_session_id ?? null,
    requested_model: options.requested_model ?? null,
    permitted_tools: options.permitted_tools ?? PERMITTED_TOOLS,
    init: null,
    tool_calls: new Map(),
    tool_calls_total: 0,
    tool_result_bytes: 0,
    output_blocks: 0,
    tool_results_seen: 0,
    proposals: [],
    proposal_keys: new Set<string>(),
    usage_raw: null,
    usage_folded: false,
    result: null,
    ignored_events: 0,
    duplicate_billing_events: 0,
    violations: [],
    boundary_violation: null,
    policy_violation: null,
  };
}

/**
 * Strict normalization of the pinned init payload; unknown fields are ignored
 * and malformed consumed fields reject the whole event (never guessed).
 */
export function normalizeClaudeInit(payload: unknown): ClaudeRuntimeState | null {
  const record = recordOf(payload);
  if (record === null) return null;
  const rawAuth = record.auth_mode;
  if (rawAuth !== undefined && rawAuth !== null && typeof rawAuth !== 'string') return null;
  const auth_mode: ClaudeAuthMode =
    typeof rawAuth === 'string' && AUTH_MODES[rawAuth] !== undefined ? AUTH_MODES[rawAuth] : 'unknown';
  const rawModel = record.model;
  let model: string | null = null;
  if (rawModel !== undefined && rawModel !== null) {
    if (!validName(rawModel)) return null;
    model = rawModel;
  }
  const rawTools = record.tools;
  let tools: string[] = [];
  if (rawTools !== undefined && rawTools !== null) {
    if (!Array.isArray(rawTools) || rawTools.some((entry) => !validName(entry))) return null;
    tools = [...(rawTools as string[])];
  }
  const rawServers = record.mcp_servers;
  let mcp_servers: string[] = [];
  if (rawServers !== undefined && rawServers !== null) {
    if (!Array.isArray(rawServers)) return null;
    for (const entry of rawServers) {
      if (validName(entry)) {
        mcp_servers.push(entry);
        continue;
      }
      const server = recordOf(entry);
      if (server === null || !validName(server.name)) return null;
      mcp_servers.push(server.name);
    }
  }
  const rawErrors = record.mcp_server_errors;
  let mcp_server_errors: Record<string, unknown> | null = null;
  if (rawErrors !== undefined && rawErrors !== null) {
    const errors = recordOf(rawErrors);
    // Absent/unknown is tolerated as unknown; a present-but-malformed value is
    // a protocol violation and rejects the event.
    if (errors === null) return null;
    mcp_server_errors = errors;
  }
  return { auth_mode, model, tools, mcp_servers, mcp_server_errors };
}

/**
 * The task card's normalized shape. Absent auth is never an available model;
 * API-key auth on this channel is `blocked` (it is the separate T20 API
 * profile's billing mode and must never be presented as subscription); a model
 * id that differs from the requested full id is a mismatch (`blocked`), while
 * documented alias tokens resolve to whatever the runtime reports. Verification
 * is never claimed here: live evidence is T32's gate.
 */
export function classifyClaudeState(
  state: ClaudeRuntimeState,
  requestedModel: string | null = null,
): { availability: ModelProfile['availability']; verification: ModelProfile['verification'] } {
  if (state.auth_mode === 'api_key') return { availability: 'blocked', verification: 'not_run' };
  if (state.auth_mode !== 'subscription') return { availability: 'needs_login', verification: 'not_run' };
  if (state.model === null) return { availability: 'needs_configuration', verification: 'not_run' };
  if (requestedModel !== null && !MODEL_ALIASES.includes(requestedModel) && state.model !== requestedModel) {
    return { availability: 'blocked', verification: 'not_run' };
  }
  return { availability: 'ready', verification: 'not_run' };
}

/**
 * PINNED MARKER (T32 must regenerate): only an exact `error.state` match to one
 * of the five product states classifies an error as unavailable; anything else
 * is a generic provider failure, never a guessed state.
 */
export function classifyUnavailable(error: Record<string, unknown> | null): ClaudeUnavailableReason | null {
  const record = recordOf(error);
  if (record === null) return null;
  const state = record.state;
  if (typeof state !== 'string') return null;
  return UNAVAILABLE_REASONS[state] ?? null;
}

/**
 * Bounded, content-deduplicated proposal accumulation: a draft seen on any
 * event survives to terminal handling exactly once (replayed events can never
 * duplicate a candidate), and later events never drop earlier ones. Keys are
 * canonical (sorted-key) JSON so key-order differences never split one draft.
 */
function canonicalKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalKey).join(',')}]`;
  const record = recordOf(value);
  if (record !== null) {
    const parts = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalKey(record[key])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function foldProposalRecords(state: ClaudeSessionState, raw: unknown[]): ClaudeSessionState {
  const proposals = [...state.proposals];
  const proposal_keys = new Set(state.proposal_keys);
  for (const proposal of raw) {
    const record = recordOf(proposal);
    if (record === null) continue;
    const key = canonicalKey(record);
    if (proposal_keys.has(key)) continue;
    if (proposals.length >= MAX_TURN_PROPOSALS) continue;
    proposal_keys.add(key);
    proposals.push(record);
  }
  return { ...state, proposals, proposal_keys };
}

function foldProposals(state: ClaudeSessionState, raw: unknown): ClaudeSessionState {
  return Array.isArray(raw) ? foldProposalRecords(state, raw) : state;
}

function foldSystem(state: ClaudeSessionState, payload: Record<string, unknown>): ClaudeSessionState {
  if (payload.subtype !== INIT_SUBTYPE) return { ...state, ignored_events: state.ignored_events + 1 };
  const runtime = normalizeClaudeInit(payload);
  if (runtime === null) return { ...state, ignored_events: state.ignored_events + 1 };
  // A second init never overwrites established runtime state.
  if (state.init !== null) return withViolation(state, 'duplicate_init');
  let next: ClaudeSessionState = {
    ...state,
    init: runtime,
    phase: state.phase === 'result_seen' ? 'result_seen' : 'running',
  };
  // Runtime metadata is checked against the launch policy (ADR 0001: verify
  // the exposed tool set and MCP surface, fail closed on surprises).
  for (const name of runtime.tools) {
    if (!next.permitted_tools.includes(name)) {
      next = withPolicyViolation(next, `tool_not_permitted:${name}`);
    }
  }
  for (const name of runtime.mcp_servers) {
    if (name !== MCP_SERVER_NAME) {
      next = withPolicyViolation(next, `mcp_server_not_permitted:${name}`);
    }
  }
  return next;
}

function foldAssistant(state: ClaudeSessionState, payload: Record<string, unknown>): ClaudeSessionState {
  const message = recordOf(payload.message);
  const blocks = message !== null && Array.isArray(message.content) ? message.content : null;
  if (blocks === null) return { ...state, ignored_events: state.ignored_events + 1 };
  let next = state;
  let recognized = 0;
  for (const raw of blocks) {
    const block = recordOf(raw);
    if (block === null) continue;
    if (block.type === 'text') {
      next = { ...next, output_blocks: next.output_blocks + 1 };
      recognized += 1;
      continue;
    }
    if (block.type !== 'tool_use') continue;
    const id = block.id;
    const name = block.name;
    if (!validRef(id) || !validName(name)) continue;
    // A replayed tool_use with a known id is consumed once: re-registering it
    // would double-count the tool-loop budget for one real call.
    if (next.tool_calls.has(id)) continue;
    const tool_calls = new Map(next.tool_calls);
    tool_calls.set(id, { tool_use_id: id, name, resolved: false, result_bytes: 0 });
    next = { ...next, tool_calls, tool_calls_total: next.tool_calls_total + 1 };
    recognized += 1;
    if (!next.permitted_tools.includes(name)) {
      next = withPolicyViolation(next, `tool_not_permitted:${name}`);
    }
  }
  return recognized === 0 ? { ...next, ignored_events: next.ignored_events + 1 } : next;
}

function foldUser(state: ClaudeSessionState, payload: Record<string, unknown>): ClaudeSessionState {
  const message = recordOf(payload.message);
  const blocks = message !== null && Array.isArray(message.content) ? message.content : null;
  if (blocks === null) return { ...state, ignored_events: state.ignored_events + 1 };
  let next = state;
  let recognized = 0;
  for (const raw of blocks) {
    const block = recordOf(raw);
    if (block === null || block.type !== 'tool_result') continue;
    const id = block.tool_use_id;
    if (!validRef(id)) continue;
    const call = next.tool_calls.get(id);
    if (call === undefined) {
      // A result nobody asked for means the stream boundaries cannot be
      // trusted: fail closed instead of guessing what it belongs to.
      next = withBoundaryViolation(next, `unmatched_tool_result:${id}`);
      continue;
    }
    if (call.resolved) {
      // A replayed result is consumed once and never re-counted.
      next = { ...next, ignored_events: next.ignored_events + 1 };
      continue;
    }
    const result_bytes = JSON.stringify(block).length;
    const tool_calls = new Map(next.tool_calls);
    tool_calls.set(id, { ...call, resolved: true, result_bytes });
    next = {
      ...next,
      tool_calls,
      tool_result_bytes: next.tool_result_bytes + result_bytes,
      tool_results_seen: next.tool_results_seen + 1,
    };
    recognized += 1;
  }
  return recognized === 0 ? { ...next, ignored_events: next.ignored_events + 1 } : next;
}

function foldResult(state: ClaudeSessionState, payload: Record<string, unknown>): ClaudeSessionState {
  // Consume the terminal result exactly once: a replayed result can never
  // re-fold usage, re-emit a terminal or re-submit candidates.
  if (state.result !== null) {
    const billed = payload.usage !== undefined && payload.usage !== null;
    return {
      ...state,
      ignored_events: state.ignored_events + 1,
      duplicate_billing_events: state.duplicate_billing_events + (billed ? 1 : 0),
    };
  }
  const error = recordOf(payload.error);
  // Success requires the pinned success marker; anything else (including an
  // unknown marker) is a failure and never a fabricated success.
  const status: ClaudeResultState['status'] =
    payload.is_error === true || payload.subtype !== 'success' ? 'failed' : 'success';
  const result: ClaudeResultState = {
    status,
    reason: classifyUnavailable(error),
    error_message: error !== null && typeof error.message === 'string' ? error.message : null,
  };
  let next: ClaudeSessionState = { ...state, phase: 'result_seen', result };
  if (payload.usage !== undefined && payload.usage !== null) {
    next = { ...next, usage_raw: recordOf(payload.usage) ?? {}, usage_folded: true };
  }
  const structured = recordOf(payload.structured_output);
  next = foldProposals(next, structured === null ? undefined : [structured]);
  if (status === 'success') {
    for (const call of next.tool_calls.values()) {
      if (!call.resolved) {
        next = withBoundaryViolation(next, `open_tool_calls_at_result:${call.tool_use_id}`);
        break;
      }
    }
  }
  return next;
}

/**
 * Folds one peer message into the session. Never throws, never trusts payloads:
 * foreign sessions, unexpected families, malformed references and out-of-order
 * events are recorded as ignored and leave state, boundaries and billing
 * untouched. Policy and boundary breaches are recorded so the run loop can fail
 * closed without writing annotations.
 */
export function foldClaudeMessage(state: ClaudeSessionState, event: ClaudeEvent): ClaudeSessionState {
  // Foreign-session gate first: another conversation can never reach this
  // run's state, billing, boundaries or candidates. Once this run's session id
  // is known, an OUTCOME (result) that does not name it — including a
  // session-less one — is a boundary violation: it can terminate or bill the
  // run, so it is recorded and never folded.
  const sessionRef = event.payload.session_id;
  if (state.run_session_id !== null && sessionRef !== state.run_session_id) {
    if (validRef(sessionRef)) {
      return { ...state, ignored_events: state.ignored_events + 1 };
    }
    if (event.kind === 'result') {
      // An OUTCOME that names no session can terminate or bill the run: it is
      // a boundary violation, recorded and never folded. Assistant/user frames
      // may omit session_id under the pinned schema and fold normally.
      return {
        ...state,
        violations: [...state.violations, 'foreign_result_without_session'],
      };
    }
  }
  const withProposals = foldProposals(state, event.payload.proposals);
  if (event.kind === 'system') return foldSystem(withProposals, event.payload);
  if (event.kind === 'assistant') return foldAssistant(withProposals, event.payload);
  if (event.kind === 'user') return foldUser(withProposals, event.payload);
  if (event.kind === 'result') return foldResult(withProposals, event.payload);
  return { ...withProposals, ignored_events: withProposals.ignored_events + 1 };
}

/**
 * Usage totals folded at most once. A run with no reported usage stays fully
 * unknown — never zero. Cost is only computed from explicit pricing.
 */
export function billingTotals(state: ClaudeSessionState, pricing: TokenPricing | null = null): NormalizedUsage {
  if (!state.usage_folded || state.usage_raw === null) return normalizeUsage(null, pricing);
  return normalizeUsage(state.usage_raw, pricing);
}
