//! Private NDJSON runtime protocol from docs/contracts.md C5.
//!
//! Every line is one message; the stream is hostile input. Oversize lines are
//! rejected BEFORE JSON decode, multi-line payloads are rejected, and every
//! failure is a controlled `ProtocolError` with a stable `code`.

export const PROTOCOL_VERSION = 1;
export const MAX_LINE_BYTES = 4 * 1024 * 1024;

export type EnvelopeKind = 'request' | 'response' | 'event';
export type EnvelopeMethod = 'probe' | 'start_run' | 'cancel_run' | 'shutdown' | 'run_event';

export interface RuntimeEnvelope {
  protocol_version: typeof PROTOCOL_VERSION;
  id: string;
  kind: EnvelopeKind;
  method: EnvelopeMethod;
  payload: unknown;
}

const ENVELOPE_KINDS: Record<string, true> = { request: true, response: true, event: true };
const ENVELOPE_METHODS: Record<string, true> = { probe: true, start_run: true, cancel_run: true, shutdown: true, run_event: true };
const REQUEST_METHODS: Record<string, true> = { probe: true, start_run: true, cancel_run: true, shutdown: true };
const MAX_ID_LENGTH = 128;

export class ProtocolError extends Error {
  readonly code: string;

  constructor(code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

function utf8ByteLength(text: string): number {
  if (!/[^\x00-\x7f]/.test(text)) return text.length;
  return new TextEncoder().encode(text).length;
}

function assertValidEnvelope(input: Record<string, unknown>): RuntimeEnvelope {
  if (input.protocol_version !== PROTOCOL_VERSION) {
    throw new ProtocolError('protocol_version', `expected ${PROTOCOL_VERSION}, got ${JSON.stringify(input.protocol_version)}`);
  }
  const { id } = input;
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH) {
    throw new ProtocolError('invalid_id', `id must be a non-empty string of at most ${MAX_ID_LENGTH} characters`);
  }
  const { kind } = input;
  if (typeof kind !== 'string' || ENVELOPE_KINDS[kind] !== true) {
    throw new ProtocolError('invalid_kind', JSON.stringify(kind));
  }
  const { method } = input;
  if (typeof method !== 'string' || ENVELOPE_METHODS[method] !== true) {
    throw new ProtocolError('unknown_method', JSON.stringify(method));
  }
  if (kind === 'request' && REQUEST_METHODS[method] !== true) {
    throw new ProtocolError('invalid_kind_method_pair', `${method} cannot be a request`);
  }
  if (kind === 'event' && method !== 'run_event') {
    throw new ProtocolError('invalid_kind_method_pair', `${method} cannot be an event`);
  }
  if (!('payload' in input)) {
    throw new ProtocolError('invalid_envelope', 'payload field is required');
  }
  return {
    protocol_version: PROTOCOL_VERSION,
    id,
    kind: kind as EnvelopeKind,
    method: method as EnvelopeMethod,
    payload: input.payload,
  };
}

export function parseEnvelope(line: string): RuntimeEnvelope {
  if (typeof line !== 'string') {
    throw new ProtocolError('invalid_line', 'envelope must be a string line');
  }
  if (line.includes('\n') || line.includes('\r')) {
    throw new ProtocolError('multi_line_message', 'an envelope must occupy exactly one line');
  }
  const byteLength = utf8ByteLength(line);
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
    throw new ProtocolError('invalid_envelope', 'envelope must be a JSON object');
  }
  return assertValidEnvelope(decoded as Record<string, unknown>);
}

export function serializeEnvelope(envelope: RuntimeEnvelope): string {
  const validated = assertValidEnvelope({ ...envelope });
  const line = JSON.stringify(validated);
  const byteLength = utf8ByteLength(line);
  if (byteLength > MAX_LINE_BYTES) {
    throw new ProtocolError('message_too_large', `${byteLength} bytes exceeds the ${MAX_LINE_BYTES} byte limit`);
  }
  return line;
}

export class NdjsonFramer {
  #pending = '';

  push(chunk: string): string[] {
    this.#pending += chunk;
    const lines: string[] = [];
    for (;;) {
      const index = this.#pending.indexOf('\n');
      if (index < 0) break;
      const raw = this.#pending.slice(0, index);
      this.#pending = this.#pending.slice(index + 1);
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      // The 4 MiB contract limit is per message, so complete lines are checked
      // individually after splitting, in bytes.
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        this.#pending = '';
        throw new ProtocolError('message_too_large', `streamed line exceeds the ${MAX_LINE_BYTES} byte limit`);
      }
      lines.push(line);
    }
    // A newline-free flood must not grow the partial buffer without bound.
    if (Buffer.byteLength(this.#pending, 'utf8') > MAX_LINE_BYTES) {
      this.#pending = '';
      throw new ProtocolError('message_too_large', `streamed line exceeds the ${MAX_LINE_BYTES} byte limit`);
    }
    return lines;
  }

  flush(): void {
    if (this.#pending.length > 0) {
      this.#pending = '';
      throw new ProtocolError('truncated_message', 'stream ended in the middle of a message');
    }
  }
}

export class RequestIdTracker {
  readonly #seen = new Set<string>();

  track(id: string): void {
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH) {
      throw new ProtocolError('invalid_id', `id must be a non-empty string of at most ${MAX_ID_LENGTH} characters`);
    }
    if (this.#seen.has(id)) {
      throw new ProtocolError('duplicate_request_id', `request id ${id} was already used`);
    }
    this.#seen.add(id);
  }
}
