//! Bounded HTTP client for provider API calls.
//!
//! Security posture: the destination base must be the provider's official base
//! or a base explicitly approved by a trusted local administrator; loopback and
//! private-network destinations need an explicit `allow_private_network` grant;
//! redirects are never followed (so an Authorization header can never reach a
//! second location); every request performs exactly one fetch — a timeout or
//! failure is never retried automatically because a POST may already be billed.

import { ProviderError, mapHttpStatus } from './errors';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface BaseApproval {
  approved: true;
  approved_by: string;
  approved_at: string;
  allow_private_network?: boolean;
  allow_insecure_http?: boolean;
}

export const OFFICIAL_API_BASES: Readonly<Record<'openai_api' | 'anthropic_api' | 'mimo_api', string>> = {
  openai_api: 'https://api.openai.com/v1',
  anthropic_api: 'https://api.anthropic.com',
  mimo_api: 'https://api.xiaomimimo.com/v1',
};

export interface ProviderHttpClientOptions {
  provider_id: 'openai_api' | 'anthropic_api' | 'mimo_api';
  api_base?: string;
  base_approval?: BaseApproval;
  local_admins?: readonly string[];
  fetch_impl?: FetchLike;
  timeout_ms?: number;
  max_response_bytes?: number;
  max_stream_bytes?: number;
}

export interface RequestBody {
  headers: Record<string, string>;
  body: string;
  timeout_ms?: number;
}

export interface TextResponse {
  status: number;
  body_text: string;
}

export interface SseFrame {
  event: string | null;
  data: string;
}

const REDIRECT_STATUSES: Record<number, true> = { 301: true, 302: true, 303: true, 307: true, 308: true };
const PRIVATE_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.corp'];

function hostIsPrivate(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  for (const suffix of PRIVATE_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) return true;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4 !== null) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if ([a, b, Number(ipv4[3]), Number(ipv4[4])].some((part) => part > 255)) return true;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(':')) {
    if (host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return true;
    // IPv4-mapped / IPv4-compatible IPv6 (::ffff:127.0.0.1, ::ffff:7f00:1,
    // ::7f00:1, ::ffff:0:127.0.0.1) is classified by its embedded IPv4, so a
    // mapped literal can never smuggle loopback/link-local past this check.
    const mapped = host.match(/^(?:::ffff:|::)(.+)$/);
    if (mapped !== null) {
      const rest = mapped[1];
      const dottedTail = rest.match(/(?:^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
      if (dottedTail !== null) return hostIsPrivate(dottedTail[1]);
      const groups = rest.split(':');
      if (
        (groups.length === 2 || groups.length === 3) &&
        groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))
      ) {
        const hi = Number.parseInt(groups[groups.length - 2], 16);
        const lo = Number.parseInt(groups[groups.length - 1], 16);
        return hostIsPrivate(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
      }
    }
    return false;
  }
  return false;
}

function normalizeBase(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError('base_not_approved', 'api base must be an absolute URL');
  }
  if (url.username !== '' || url.password !== '') throw new ProviderError('base_not_approved', 'api base must not carry credentials');
  if (url.search !== '' || url.hash !== '') throw new ProviderError('base_not_approved', 'api base must not carry a query or fragment');
  return url;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function approvalIsValid(approval: BaseApproval | undefined, local_admins: readonly string[]): approval is BaseApproval {
  return (
    approval !== undefined &&
    approval.approved === true &&
    typeof approval.approved_by === 'string' &&
    local_admins.includes(approval.approved_by) &&
    typeof approval.approved_at === 'string' &&
    Number.isFinite(Date.parse(approval.approved_at))
  );
}

function resolveBase(
  raw: string,
  provider_id: 'openai_api' | 'anthropic_api' | 'mimo_api',
  approval: BaseApproval | undefined,
  local_admins: readonly string[],
): string {
  const url = normalizeBase(raw);
  const base = stripTrailingSlash(url.toString().replace(/\/$/, ''));
  const official = OFFICIAL_API_BASES[provider_id];
  const isOfficial = stripTrailingSlash(raw) === official;
  if (!isOfficial && !approvalIsValid(approval, local_admins)) {
    throw new ProviderError('base_not_approved', 'a non-official api base requires explicit approval by a trusted local admin');
  }
  const approved = approvalIsValid(approval, local_admins);
  if (url.protocol !== 'https:' && !(approved && approval.allow_insecure_http === true)) {
    throw new ProviderError('ssrf_blocked', 'api base must use https');
  }
  if (hostIsPrivate(url.hostname) && !(approved && approval.allow_private_network === true)) {
    throw new ProviderError('ssrf_blocked', 'loopback and private-network destinations are refused');
  }
  return base;
}

class SseDecoder {
  #lineBuffer = '';
  #event: string | null = null;
  #data: string[] = [];

  push(text: string): SseFrame[] {
    this.#lineBuffer += text;
    const frames: SseFrame[] = [];
    for (;;) {
      const index = this.#lineBuffer.indexOf('\n');
      if (index < 0) break;
      const raw = this.#lineBuffer.slice(0, index);
      this.#lineBuffer = this.#lineBuffer.slice(index + 1);
      const frame = this.#pushLine(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
      if (frame !== null) frames.push(frame);
    }
    return frames;
  }

  end(): void {
    if (this.#lineBuffer.length > 0 || this.#data.length > 0 || this.#event !== null) {
      throw new ProviderError('interrupted_stream', 'stream ended before the current event was terminated');
    }
  }

  #pushLine(line: string): SseFrame | null {
    if (line === '') {
      if (this.#data.length === 0) {
        this.#event = null;
        return null;
      }
      const frame: SseFrame = { event: this.#event, data: this.#data.join('\n') };
      this.#event = null;
      this.#data = [];
      return frame;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') this.#event = value;
    else if (field === 'data') this.#data.push(value);
    return null;
  }
}

export class BoundedHttpClient {
  readonly #fetch: FetchLike;
  readonly #timeout_ms: number;
  readonly #max_response_bytes: number;
  readonly #max_stream_bytes: number;
  readonly #base_url: string;
  readonly #base_error: ProviderError | null;

  constructor(options: ProviderHttpClientOptions) {
    this.#fetch = options.fetch_impl ?? ((url, init) => globalThis.fetch(url, init));
    this.#timeout_ms = options.timeout_ms ?? 60_000;
    this.#max_response_bytes = options.max_response_bytes ?? 4 * 1024 * 1024;
    this.#max_stream_bytes = options.max_stream_bytes ?? 4 * 1024 * 1024;
    const local_admins = options.local_admins ?? [];
    const raw = options.api_base ?? OFFICIAL_API_BASES[options.provider_id];
    try {
      this.#base_url = resolveBase(raw, options.provider_id, options.base_approval, local_admins);
      this.#base_error = null;
    } catch (error) {
      this.#base_url = stripTrailingSlash(raw);
      this.#base_error = error instanceof ProviderError ? error : new ProviderError('base_not_approved', 'unresolvable api base');
    }
  }

  get base_url(): string {
    return this.#base_url;
  }

  get base_error(): ProviderError | null {
    return this.#base_error;
  }

  resolveRequestUrl(path: string): string {
    if (this.#base_error !== null) throw this.#base_error;
    if (typeof path !== 'string' || !path.startsWith('/') || path.includes('//') || path.includes('\\') || path.split('/').includes('..')) {
      throw new ProviderError('base_not_approved', 'request path escapes the approved api base');
    }
    return `${this.#base_url}${path}`;
  }

  async send(path: string, request: RequestBody, signal?: AbortSignal): Promise<TextResponse> {
    const url = this.resolveRequestUrl(path);
    const { controller, timer, detach } = this.#deadline(request.timeout_ms, signal);
    try {
      const res = await this.#post(url, request, controller.signal);
      if (REDIRECT_STATUSES[res.status] === true) {
        throw new ProviderError('redirect_rejected', `refusing to follow a ${res.status} redirect`, res.status);
      }
      const body_text = await readBodyCapped(res, this.#max_response_bytes);
      if (res.status < 200 || res.status >= 300) throw mapHttpStatus(res.status, body_text.slice(0, 200));
      return { status: res.status, body_text };
    } finally {
      clearTimeout(timer);
      detach();
    }
  }

  async *sendStream(path: string, request: RequestBody, signal?: AbortSignal): AsyncGenerator<SseFrame> {
    const url = this.resolveRequestUrl(path);
    const { controller, timer, detach } = this.#deadline(request.timeout_ms, signal);
    try {
      const res = await this.#post(url, request, controller.signal);
      if (REDIRECT_STATUSES[res.status] === true) {
        throw new ProviderError('redirect_rejected', `refusing to follow a ${res.status} redirect`, res.status);
      }
      if (res.status < 200 || res.status >= 300) {
        const body_text = await readBodyCapped(res, this.#max_response_bytes);
        throw mapHttpStatus(res.status, body_text.slice(0, 200));
      }
      if (res.body === null) throw new ProviderError('interrupted_stream', 'streaming response has no body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseDecoder();
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value === undefined) continue;
          total += value.byteLength;
          if (total > this.#max_stream_bytes) {
            await reader.cancel();
            throw new ProviderError('oversized_response', `stream exceeded ${this.#max_stream_bytes} bytes`);
          }
          for (const frame of parser.push(decoder.decode(value, { stream: true }))) yield frame;
        }
        for (const frame of parser.push(decoder.decode())) yield frame;
        parser.end();
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (controller.signal.aborted) throw new ProviderError('timeout', 'stream aborted by timeout or cancellation');
        throw new ProviderError('interrupted_stream', error instanceof Error ? error.message : 'stream failure');
      }
    } finally {
      clearTimeout(timer);
      detach();
    }
  }

  #deadline(timeout_ms: number | undefined, signal: AbortSignal | undefined): {
    controller: AbortController;
    timer: NodeJS.Timeout;
    detach: () => void;
  } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout_ms ?? this.#timeout_ms);
    const onAbort = () => controller.abort();
    if (signal !== undefined) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    return {
      controller,
      timer,
      detach: () => signal?.removeEventListener('abort', onAbort),
    };
  }

  async #post(url: string, request: RequestBody, signal: AbortSignal): Promise<Response> {
    try {
      return await this.#fetch(url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal,
        redirect: 'manual',
      });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (signal.aborted) throw new ProviderError('timeout', 'request aborted by timeout or cancellation');
      throw new ProviderError('network_error', error instanceof Error ? error.message : 'network failure');
    }
  }
}

async function readBodyCapped(res: Response, max_bytes: number): Promise<string> {
  const declared = res.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > max_bytes) {
      await res.body?.cancel();
      throw new ProviderError('oversized_response', `response declares ${length} bytes over the ${max_bytes} byte limit`);
    }
  }
  if (res.body === null) {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > max_bytes) {
      throw new ProviderError('oversized_response', `response exceeds the ${max_bytes} byte limit`);
    }
    return text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > max_bytes) {
      await reader.cancel();
      throw new ProviderError('oversized_response', `response exceeds the ${max_bytes} byte limit`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export interface ToolLoopBudgetOptions {
  max_tool_turns: number;
  max_total_bytes: number;
  max_run_ms: number;
}

export class ToolLoopBudget {
  readonly #options: ToolLoopBudgetOptions;
  readonly #clock: () => number;
  readonly #started: number;
  #turns = 0;
  #total_bytes = 0;

  constructor(options: ToolLoopBudgetOptions, clock: () => number = Date.now) {
    this.#options = { ...options };
    this.#clock = clock;
    this.#started = clock();
  }

  get turns(): number {
    return this.#turns;
  }

  /**
   * Budgets are enforced per turn boundary. A single in-flight request is
   * bounded by the per-request timeout and the response byte caps, so total
   * wall time can exceed max_run_ms by at most one request timeout plus tool
   * execution; the next beginTurn() then refuses to continue.
   */
  beginTurn(): void {
    if (this.#turns >= this.#options.max_tool_turns) {
      throw new ProviderError('tool_turn_budget_exceeded', `tool loop exceeded ${this.#options.max_tool_turns} turns`);
    }
    if (this.#clock() - this.#started > this.#options.max_run_ms) {
      throw new ProviderError('tool_time_budget_exceeded', `tool loop exceeded ${this.#options.max_run_ms} ms`);
    }
    this.#turns += 1;
  }

  chargeBytes(count: number): void {
    this.#total_bytes += count;
    if (this.#total_bytes > this.#options.max_total_bytes) {
      throw new ProviderError('tool_byte_budget_exceeded', `tool loop exceeded ${this.#options.max_total_bytes} response bytes`);
    }
  }
}

export interface ToolBudgets {
  max_tool_turns: number;
  max_total_bytes: number;
  max_run_ms: number;
  max_output_tokens: number;
  max_image_bytes: number;
  max_pixels: number;
  max_crops: number;
}

export const DEFAULT_TOOL_BUDGETS: ToolBudgets = {
  max_tool_turns: 8,
  max_total_bytes: 1_048_576,
  max_run_ms: 120_000,
  max_output_tokens: 2048,
  max_image_bytes: 20_971_520,
  max_pixels: 4_000_000,
  max_crops: 4,
};

const SECRET_REF = /^env:[A-Za-z_][A-Za-z0-9_]*$/;

export function validateSecretRef(ref: string): void {
  if (typeof ref !== 'string' || !SECRET_REF.test(ref)) {
    throw new ProviderError('secret_ref_invalid', 'credentials must be given as an env:NAME secret reference, never inline');
  }
}

export function resolveSecretRef(ref: string, env: Record<string, string | undefined> = process.env): string {
  validateSecretRef(ref);
  const value = env[ref.slice('env:'.length)];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProviderError('secret_ref_invalid', `secret reference ${ref} did not resolve to a value`);
  }
  return value;
}
