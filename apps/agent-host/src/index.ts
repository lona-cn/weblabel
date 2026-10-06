//! NDJSON Agent Host session (docs/contracts.md C5).
//!
//! The host speaks the private protocol with its Rust parent on stdio: stdout
//! carries protocol envelopes ONLY, every log line goes to stderr after
//! redaction, and the startup handshake requires a probe request with
//! protocol_version=1. Provider children are launched through the hardened
//! spawn policy; crash, timeout and cancel all reclaim the process tree and a
//! possibly billed run request is never resent automatically.

import { ProtocolError, NdjsonFramer, PROTOCOL_VERSION, RequestIdTracker, parseEnvelope, serializeEnvelope, type EnvelopeMethod, type RuntimeEnvelope } from './protocol';
import type { ProviderRegistry } from './registry';
import { redactText, redactValue } from './security/redaction';
import { SpawnPolicyError, spawnChild, superviseChild, type ChildSpec, type SpawnPolicy, type SpawnedChild, type SuperviseResult } from './security/spawn';
import type { RunEvent } from "../../../packages/contracts/generated/RunEvent";

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timeout';

export interface RunState {
  run_id: string;
  request_id: string;
  status: RunStatus;
  attempts: number;
  error_code: string | null;
}

export interface HostSink {
  write(chunk: string): unknown;
}

export interface HostSessionOptions {
  registry: ProviderRegistry;
  input: NodeJS.ReadableStream;
  output: HostSink;
  logs: HostSink;
  spawnPolicy: SpawnPolicy;
  /** Fixed launch recipe; the browser/parent can never supply it per run. */
  childSpec?: ChildSpec | ((run_id: string, payload: unknown) => ChildSpec);
  runTimeoutMs?: number | null;
  dispatch?: (payload: unknown, signal: AbortSignal) => AsyncIterable<RunEvent>;
}

interface ActiveRun {
  abort: AbortController;
  done: Promise<void>;
}

interface ChildReport {
  status: 'succeeded' | 'failed';
  error_code: string | null;
}

function mapChildReport(payload: unknown): ChildReport {
  let ok = false;
  let status: unknown = null;
  let errorCode: unknown = null;
  if (typeof payload === 'object' && payload !== null) {
    if ('ok' in payload) ok = payload.ok === true;
    if ('status' in payload) status = payload.status;
    if ('error' in payload && typeof payload.error === 'object' && payload.error !== null && 'code' in payload.error) {
      errorCode = payload.error.code;
    }
  }
  if (ok && status === 'succeeded') return { status: 'succeeded', error_code: null };
  return {
    status: 'failed',
    error_code: typeof errorCode === 'string' ? errorCode : 'provider_reported_failure',
  };
}

export class HostSession {
  readonly #registry: ProviderRegistry;
  readonly #input: NodeJS.ReadableStream;
  readonly #output: HostSink;
  readonly #logs: HostSink;
  readonly #spawnPolicy: SpawnPolicy;
  readonly #childSpec: HostSessionOptions["childSpec"];
  readonly #runTimeoutMs: number | null;
  readonly #dispatch: HostSessionOptions["dispatch"];
  readonly #requests = new RequestIdTracker();
  readonly #runs = new Map<string, RunState>();
  readonly #active = new Map<string, ActiveRun>();
  #handshaken = false;
  #closed = false;

  constructor(options: HostSessionOptions) {
    this.#registry = options.registry;
    this.#input = options.input;
    this.#output = options.output;
    this.#logs = options.logs;
    this.#spawnPolicy = options.spawnPolicy;
    this.#childSpec = options.childSpec;
    this.#runTimeoutMs = options.runTimeoutMs ?? null;
    this.#dispatch = options.dispatch;
  }

  log(message: string): void {
    this.#logs.write(`[host] ${redactText(message)}\n`);
  }

  getRunState(run_id: string): RunState | undefined {
    return this.#runs.get(run_id);
  }

  async waitForRuns(): Promise<void> {
    while (this.#active.size > 0) {
      await Promise.all([...this.#active.values()].map((active) => active.done));
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const active of this.#active.values()) active.abort.abort('cancelled');
    await this.waitForRuns();
  }

  async handleParentLine(line: string): Promise<void> {
    const envelope = parseEnvelope(line);
    if (!this.#handshaken) {
      if (envelope.kind !== 'request' || envelope.method !== 'probe') {
        throw new ProtocolError('handshake_expected_probe', 'the first message must be a probe request with protocol_version=1');
      }
      this.#handshaken = true;
      this.log('startup handshake accepted (protocol_version=1)');
    }
    if (envelope.kind !== 'request') {
      throw new ProtocolError('unexpected_envelope', `the host only accepts requests from its parent, got kind ${envelope.kind}`);
    }
    try {
      this.#requests.track(envelope.id);
    } catch (error) {
      if (error instanceof ProtocolError && error.code === 'duplicate_request_id') {
        this.log(`rejected duplicate request id ${envelope.id}`);
        this.#writeResponse(envelope.id, envelope.method, {
          ok: false,
          error: { code: 'duplicate_request_id', message: redactText(error.message) },
        });
        return;
      }
      throw error;
    }
    switch (envelope.method) {
      case 'probe': {
        const profiles = await this.#registry.probeAll();
        this.log(`probe answered with ${profiles.length} profile(s)`);
        this.#writeResponse(envelope.id, 'probe', { ok: true, profiles });
        return;
      }
      case 'start_run':
        this.#launchRun(envelope);
        return;
      case 'cancel_run': {
        const payload = envelope.payload;
        let requested: unknown;
        if (typeof payload === 'object' && payload !== null && 'run_id' in payload) requested = payload.run_id;
        if (typeof requested !== 'string' || requested.length === 0) {
          throw new ProtocolError('invalid_payload', 'cancel_run requires a run_id');
        }
        const run_id = requested;
        const known = this.#runs.get(run_id);
        const active = this.#active.get(run_id);
        if (active) active.abort.abort('cancelled');
        if (!known && !active) {
          this.#writeResponse(envelope.id, 'cancel_run', { ok: false, run_id, error: { code: 'unknown_run' } });
          return;
        }
        this.#writeResponse(envelope.id, 'cancel_run', { ok: true, run_id, status: active ? 'cancelled' : known?.status });
        return;
      }
      case 'shutdown': {
        await this.close();
        this.#writeResponse(envelope.id, 'shutdown', { ok: true, status: 'shutdown' });
        return;
      }
      default:
        throw new ProtocolError('unknown_method', String(envelope.method));
    }
  }

  async run(): Promise<void> {
    const framer = new NdjsonFramer();
    try {
      for await (const chunk of this.#input) {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
        for (const line of framer.push(text)) {
          await this.handleParentLine(line);
          if (this.#closed) return;
        }
      }
      framer.flush();
    } catch (error) {
      this.log(`host protocol failure: ${error instanceof Error ? error.message : String(error)}`);
      await this.close();
      throw error;
    }
    await this.waitForRuns();
  }

  #writeEnvelope(envelope: RuntimeEnvelope): void {
    this.#output.write(`${serializeEnvelope(envelope)}\n`);
  }

  #writeResponse(id: string, method: EnvelopeMethod, payload: unknown): void {
    this.#writeEnvelope({ protocol_version: PROTOCOL_VERSION, id, kind: 'response', method, payload: redactValue(payload) });
  }

  #launchRun(envelope: RuntimeEnvelope): void {
    const payload = envelope.payload;
    let requestedId: unknown;
    let request: unknown;
    if (typeof payload === 'object' && payload !== null) {
      if ('run_id' in payload) requestedId = payload.run_id;
      if ('request' in payload) request = payload.request;
    }
    const run_id = requestedId;
    if (typeof run_id !== 'string' || run_id.length === 0 || run_id.length > 128) {
      throw new ProtocolError('invalid_payload', 'start_run requires a run_id');
    }
    if (this.#runs.has(run_id)) {
      throw new ProtocolError('duplicate_run', `run ${run_id} already exists`);
    }
    // attempts is fixed at 1: a possibly billed request is never resent automatically.
    const state: RunState = { run_id, request_id: envelope.id, status: 'running', attempts: 1, error_code: null };
    this.#runs.set(run_id, state);
    if (this.#dispatch) {
      const abort = new AbortController();
      const done = this.#driveAdapter(state, abort, payload).finally(() => this.#active.delete(run_id));
      this.#active.set(run_id, { abort, done });
      return;
    }
    const spec = typeof this.#childSpec === 'function' ? this.#childSpec(run_id, payload) : this.#childSpec;
    let child: SpawnedChild;
    try {
      if (!spec) throw new SpawnPolicyError("needs_configuration", "no provider dispatch configured");
      child = spawnChild(spec, this.#spawnPolicy);
    } catch (error) {
      state.status = 'failed';
      state.error_code = error instanceof SpawnPolicyError ? error.code : 'spawn_failed';
      this.#writeResponse(envelope.id, 'start_run', {
        ok: false,
        run_id,
        status: state.status,
        error: { code: state.error_code, message: redactText(String(error)) },
      });
      return;
    }
    this.log(`run ${run_id} spawned provider child pid=${child.pid}`);
    const abort = new AbortController();
    const done = this.#driveRun(state, child, abort, request).finally(() => this.#active.delete(run_id));
    this.#active.set(run_id, { abort, done: done.catch((error: unknown) => this.log(`run ${run_id} driver error: ${String(error)}`)) });
  }


  async #driveAdapter(state: RunState, abort: AbortController, payload: unknown): Promise<void> {
    const timer = this.#runTimeoutMs === null ? null : setTimeout(() => abort.abort('timeout'), this.#runTimeoutMs);
    try {
      for await (const event of this.#dispatch!(payload, abort.signal)) {
        if (abort.signal.aborted) break;
        if (event.run_id !== state.run_id) throw new ProtocolError('invalid_payload', 'adapter event run mismatch');
        this.#writeEnvelope({ protocol_version: PROTOCOL_VERSION, id: state.run_id + ':' + event.seq, kind: 'event', method: 'run_event', payload: event });
        if (event.type === 'succeeded') state.status = 'succeeded';
        if (event.type === "failed") { state.status = "failed"; state.error_code = typeof event.data?.error_code === "string" ? event.data.error_code : "provider_reported_failure"; }
        if (event.type === 'cancelled') state.status = 'cancelled';
      }
      if (abort.signal.aborted) { state.status = abort.signal.reason === 'timeout' ? 'timeout' : 'cancelled'; state.error_code = state.status === 'timeout' ? 'run_timeout' : null; }
      if (state.status === 'running') { state.status = 'failed'; state.error_code = 'missing_terminal_response'; }
    } catch (error) {
      state.status = abort.signal.aborted ? (abort.signal.reason === 'timeout' ? 'timeout' : 'cancelled') : 'failed';
      state.error_code = error instanceof Error && 'code' in error ? String(error.code) : 'adapter_error';
    } finally {
      if (timer !== null) clearTimeout(timer);
      this.#writeResponse(state.request_id, 'start_run', { ok: state.status === 'succeeded', run_id: state.run_id, status: state.status, ...(state.error_code ? { error: { code: state.error_code } } : {}) });
    }
  }

  async #driveRun(state: RunState, child: SpawnedChild, abort: AbortController, request: unknown): Promise<void> {
    const holder: { report: ChildReport | null; failure: ProtocolError | null } = { report: null, failure: null };
    const reader = (async () => {
      const framer = new NdjsonFramer();
      for await (const chunk of child.stdout) {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
        for (const line of framer.push(text)) {
          const envelope = parseEnvelope(line);
          if (envelope.kind === 'event') {
            this.#writeEnvelope({ protocol_version: PROTOCOL_VERSION, id: envelope.id, kind: 'event', method: 'run_event', payload: redactValue(envelope.payload) });
          } else if (envelope.kind === 'response') {
            holder.report = mapChildReport(envelope.payload);
            child.stdin.end();
          } else {
            this.log(`dropped unexpected ${envelope.kind} envelope from provider child`);
          }
        }
      }
      framer.flush();
    })();
    const settled = reader.catch((error: unknown) => {
      if (error instanceof ProtocolError) holder.failure = error;
      else this.log(`provider child stream error: ${String(error)}`);
      abort.abort('protocol_error');
    });
    let stderrRest = '';
    const stderrLog = (async () => {
      for await (const chunk of child.stderr) {
        stderrRest += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
        const lines = stderrRest.split('\n');
        stderrRest = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim() !== '') this.log(`provider[pid ${child.pid}]: ${line}`);
        }
      }
      if (stderrRest.trim() !== '') this.log(`provider[pid ${child.pid}]: ${stderrRest}`);
    })();
    const childRequest: RuntimeEnvelope = {
      protocol_version: PROTOCOL_VERSION,
      id: state.run_id,
      kind: 'request',
      method: 'start_run',
      // The provider child must receive the run request verbatim: it is billed
      // input. Redaction is for logs and host->parent output only; provider
      // credentials reach the child through env allowlists and secret refs.
      payload: { run_id: state.run_id, request },
    };
    child.stdin.on('error', (error: unknown) => {
      this.log(`provider child stdin error: ${String(error)}`);
    });
    try {
      child.stdin.write(`${serializeEnvelope(childRequest)}\n`);
    } catch (error) {
      this.log(`provider child stdin write failed: ${String(error)}`);
    }
    let supervised: SuperviseResult | null = null;
    let supervision_code: string | null = null;
    try {
      supervised = await superviseChild(child, { timeoutMs: this.#runTimeoutMs, signal: abort.signal });
      await settled;
      await stderrLog;
    } catch (error) {
      supervision_code = error instanceof SpawnPolicyError ? error.code : 'supervision_failed';
      this.log(`run ${state.run_id} supervision failure: ${String(error)}`);
    }

    let status: RunStatus;
    let error_code: string | null = null;
    if (supervision_code !== null) {
      status = 'failed';
      error_code = supervision_code;
    } else if (holder.failure !== null) {
      status = 'failed';
      error_code = holder.failure.code;
    } else if (supervised?.outcome === 'timeout') {
      status = 'timeout';
      error_code = 'run_timeout';
    } else if (supervised?.outcome === 'cancelled') {
      status = 'cancelled';
    } else if (supervised?.outcome === 'crashed') {
      status = 'failed';
      error_code = 'child_crashed';
    } else if (holder.report !== null) {
      status = holder.report.status;
      error_code = holder.report.error_code;
    } else {
      status = 'failed';
      error_code = 'missing_terminal_response';
    }
    state.status = status;
    state.error_code = error_code;
    // Every start_run gets exactly one terminal response, even when supervision
    // or teardown failed: the run must never stay 'running' without a reply.
    this.#writeResponse(state.request_id, 'start_run', {
      ok: status === 'succeeded',
      run_id: state.run_id,
      status,
      ...(error_code === null ? {} : { error: { code: error_code, message: `run finished with status ${status}` } }),
    });
    this.log(
      `run ${state.run_id} finished status=${status} outcome=${supervised?.outcome ?? 'supervision_error'} reclaim_mechanism=${supervised?.reclaimed.mechanism ?? 'none'}`,
    );
  }
}
