//! Claude Code headless stream-json wire protocol (docs/provider-compatibility.md,
//! T02-verified documentation boundaries + `claude --help` of the installed
//! 2.1.183 runtime, captured in reports/T23/claude-help.txt).
//!
//! PINNED SCHEMA (project-side, T32 prerequisite): the event families below are
//! the documented facts (`-p` with `text`/`json`/`stream-json` output,
//! structured output via `--json-schema`, a `system` init event reporting model,
//! tools, MCP servers and load errors). The per-event payload field names
//! consumed by ../session.ts (`message.content` blocks, `session_id`, `usage`,
//! `structured_output`, `proposals`, `error.state`) are PROJECT PINS over those
//! documented families — the installed CLI exposes no schema generator (unlike
//! Codex `app-server generate-*`), so T32 MUST capture real stream-json fixtures
//! from the version-pinned runtime and validate this parser against them.
//! Everything unpinned is tolerated as unknown and can never corrupt state.

import { MAX_LINE_BYTES, ProtocolError } from '../../protocol';

export const SYSTEM_EVENT = 'system';
export const INIT_SUBTYPE = 'init';
export const ASSISTANT_EVENT = 'assistant';
export const USER_EVENT = 'user';
export const RESULT_EVENT = 'result';
export const KNOWN_EVENTS: readonly string[] = [SYSTEM_EVENT, ASSISTANT_EVENT, USER_EVENT, RESULT_EVENT];

export type ClaudeEventKind = 'system' | 'assistant' | 'user' | 'result' | 'unknown';

export interface ClaudeEvent {
  kind: ClaudeEventKind;
  /** The raw `type` discriminator; kept verbatim for unknown families. */
  type: string;
  payload: Record<string, unknown>;
}

const MAX_TYPE_LENGTH = 128;

function invalid(detail: string): ProtocolError {
  return new ProtocolError('invalid_envelope', detail);
}

/**
 * One stream-json line is one event. The stream is hostile input: oversize
 * lines and truncated JSON fail as controlled `ProtocolError`s BEFORE anything
 * downstream can see them, so a half-parsed result can never carry a candidate.
 */
export function parseClaudeLine(line: string): ClaudeEvent {
  if (typeof line !== 'string') {
    throw new ProtocolError('invalid_line', 'event must be a string line');
  }
  if (line.includes('\n') || line.includes('\r')) {
    throw new ProtocolError('multi_line_message', 'an event must occupy exactly one line');
  }
  const byteLength = Buffer.byteLength(line, 'utf8');
  if (byteLength > MAX_LINE_BYTES) {
    throw new ProtocolError('message_too_large', `${byteLength} bytes exceeds the ${MAX_LINE_BYTES} byte limit`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch (error) {
    throw new ProtocolError('invalid_json', error instanceof Error ? error.message : 'unparseable line');
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw invalid('event must be a JSON object');
  }
  const payload = decoded as Record<string, unknown>;
  const type = payload.type;
  if (typeof type !== 'string' || type.length === 0 || type.length > MAX_TYPE_LENGTH) {
    throw invalid('event.type must be a non-empty string');
  }
  return {
    kind: KNOWN_EVENTS.includes(type) ? (type as ClaudeEventKind) : 'unknown',
    type,
    payload,
  };
}
