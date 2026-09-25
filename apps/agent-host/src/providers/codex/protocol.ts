//! Codex App Server wire protocol (docs/provider-compatibility.md, T02-verified
//! documentation boundaries): JSONL, JSON-RPC 2.0 with the `jsonrpc` header
//! omitted on the wire. Each connection requires exactly one `initialize`
//! request followed by the `initialized` notification; streaming notifications
//! carry turn/item events; `turn/interrupt` is the documented turn-cancel
//! request.
//!
//! PINNED SCHEMA (project-side, T32 prerequisite): the envelope rules below are
//! the documented facts above. The request/response method names `thread/start`,
//! `turn/start` and the payload field names consumed by ../session.ts are
//! project pins — the CLI-generated schema (`codex app-server generate-ts /
//! generate-json-schema`) was NOT produced on this workstation (CLI absent) and
//! MUST regenerate/validate them in T32. Everything unpinned is tolerated as
//! unknown and can never corrupt session state.

import { MAX_LINE_BYTES, ProtocolError } from '../../protocol';

export const INITIALIZE_METHOD = 'initialize';
export const INITIALIZED_METHOD = 'initialized';
export const THREAD_START_METHOD = 'thread/start';
/** UNVERIFIED PIN: T02 docs confirm `turn/interrupt` as the turn-cancel request; the start method name must be re-derived from the generated schema in T32. */
export const TURN_START_METHOD = 'turn/start';
export const TURN_INTERRUPT_METHOD = 'turn/interrupt';
/** Documented out-of-sandbox methods (`thread/shellCommand` runs with full access, `process/spawn` is experimental): never exposed to the adapter. */
export const FORBIDDEN_METHODS: readonly string[] = ['thread/shellCommand', 'process/spawn'];
export const THREAD_EVENT_PREFIX = 'thread/';
export const TURN_EVENT_PREFIX = 'turn/';
export const ITEM_EVENT_PREFIX = 'item/';
export const TURN_STATUSES: readonly string[] = ['in_progress', 'completed', 'failed', 'interrupted'];

const ENVELOPE_KEYS: Record<string, true> = { jsonrpc: true, id: true, method: true, params: true, result: true, error: true };
const MAX_ID_LENGTH = 128;
const MAX_METHOD_LENGTH = 128;
const MAX_ERROR_MESSAGE_LENGTH = 4096;

export interface CodexErrorObject {
  code: number;
  message: string;
  data: unknown;
}

export interface CodexRequest {
  kind: 'request';
  id: string | number;
  method: string;
  params: Record<string, unknown>;
}

export interface CodexNotification {
  kind: 'notification';
  method: string;
  params: Record<string, unknown>;
}

export interface CodexResponse {
  kind: 'response';
  id: string | number;
  result: Record<string, unknown> | null;
  error: CodexErrorObject | null;
}

export type CodexMessage = CodexRequest | CodexNotification | CodexResponse;

function invalid(detail: string): ProtocolError {
  return new ProtocolError('invalid_envelope', detail);
}

function validId(value: unknown): value is string | number {
  if (typeof value === 'string') return value.length > 0 && value.length <= MAX_ID_LENGTH;
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function requireParams(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid('params must be a JSON object');
  return value as Record<string, unknown>; // narrowed by the runtime check above
}

function requireErrorObject(value: unknown): CodexErrorObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid('error must be a JSON object');
  const record = value as Record<string, unknown>; // narrowed by the runtime check above
  for (const key of Object.keys(record)) {
    if (key !== 'code' && key !== 'message' && key !== 'data') throw invalid(`error has unknown field ${JSON.stringify(key)}`);
  }
  const { code, message } = record;
  if (typeof code !== 'number' || !Number.isSafeInteger(code)) throw invalid('error.code must be an integer');
  if (typeof message !== 'string' || message.length === 0 || message.length > MAX_ERROR_MESSAGE_LENGTH) {
    throw invalid('error.message must be a non-empty string');
  }
  return { code, message, data: record.data ?? null };
}

function assertValidOutgoing(method: string, params: Record<string, unknown>): void {
  if (typeof method !== 'string' || method.length === 0 || method.length > MAX_METHOD_LENGTH) {
    throw new ProtocolError('unknown_method', 'method must be a non-empty string');
  }
  requireParams(params);
}

export function parseCodexLine(line: string): CodexMessage {
  if (typeof line !== 'string') {
    throw new ProtocolError('invalid_line', 'a protocol message must be a string line');
  }
  if (line.includes('\n') || line.includes('\r')) {
    throw new ProtocolError('multi_line_message', 'a protocol message must occupy exactly one line');
  }
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
    throw new ProtocolError('message_too_large', `message exceeds the ${MAX_LINE_BYTES} byte limit`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch (error) {
    throw new ProtocolError('invalid_json', error instanceof Error ? error.message : 'unparseable line');
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw invalid('a protocol message must be a JSON object');
  }
  const record = decoded as Record<string, unknown>; // narrowed by the runtime check above
  for (const key of Object.keys(record)) {
    if (ENVELOPE_KEYS[key] !== true) throw invalid(`unknown envelope field ${JSON.stringify(key)}`);
  }
  // The documented wire omits the jsonrpc header; when present it must be 2.0.
  if (record.jsonrpc !== undefined && record.jsonrpc !== '2.0') {
    throw invalid('jsonrpc must be "2.0" when present');
  }
  const hasMethod = record.method !== undefined;
  const hasResult = record.result !== undefined;
  const hasError = record.error !== undefined;
  if (hasMethod) {
    if (hasResult || hasError) throw invalid('a request/notification cannot carry result or error');
    const method = record.method;
    if (typeof method !== 'string' || method.length === 0 || method.length > MAX_METHOD_LENGTH) {
      throw invalid('method must be a non-empty string');
    }
    const params = requireParams(record.params);
    if (record.id === undefined) {
      if (method === INITIALIZE_METHOD) throw invalid('initialize must be a request with an id');
      return { kind: 'notification', method, params };
    }
    if (!validId(record.id)) throw invalid('id must be a short string or a safe integer');
    if (method === INITIALIZED_METHOD) throw invalid('initialized is the handshake notification and carries no id');
    return { kind: 'request', id: record.id, method, params };
  }
  if (record.id === undefined) throw invalid('a response must carry the request id');
  if (!validId(record.id)) throw invalid('id must be a short string or a safe integer');
  if (hasResult === hasError) throw invalid('a response must carry exactly one of result or error');
  if (hasError) {
    return { kind: 'response', id: record.id, result: null, error: requireErrorObject(record.error) };
  }
  const result = record.result;
  if (result !== null && (typeof result !== 'object' || Array.isArray(result))) {
    throw invalid('result must be a JSON object or null');
  }
  return { kind: 'response', id: record.id, result: (result ?? null) as Record<string, unknown> | null, error: null };
}

export function serializeCodexRequest(id: string | number, method: string, params: Record<string, unknown>): string {
  if (!validId(id)) throw new ProtocolError('invalid_id', 'id must be a short string or a safe integer');
  assertValidOutgoing(method, params);
  return JSON.stringify({ id, method, params });
}

export function serializeCodexNotification(method: string, params: Record<string, unknown>): string {
  assertValidOutgoing(method, params);
  return JSON.stringify({ method, params });
}

export function isThreadEvent(method: string): boolean {
  return method.startsWith(THREAD_EVENT_PREFIX);
}

export function isTurnEvent(method: string): boolean {
  return method.startsWith(TURN_EVENT_PREFIX);
}

export function isItemEvent(method: string): boolean {
  return method.startsWith(ITEM_EVENT_PREFIX);
}
