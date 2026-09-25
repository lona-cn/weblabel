//! Optional local CPU detector provider adapter (RT-DETR v2, contracts C4/C5).
//!
//! The adapter drives the Python worker (`python -m weblabel_detector`) over
//! the private NDJSON protocol. Evidence policy (task card T18):
//!   - probe() reports `needs_configuration` when the Python runtime or the
//!     pinned weights are missing; `verification` is always `not_run` from T18
//!     because mock-tensor tests are not evidence and real weight execution is
//!     T32's gate;
//!   - runs produce candidates through `ctx.submit_candidates` only — the
//!     adapter never writes AnnotationRevision or document state;
//!   - image bytes never travel inside protocol lines: the run's approved image
//!     grant is staged to a private temp file for the worker and deleted after.
//!
//! Manual annotation is independent of this adapter: when the detector is not
//! configured, probe() still succeeds and reports the missing configuration.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BBox } from '../../../../packages/contracts/generated/BBox';
import type { Id } from '../../../../packages/contracts/generated/Id';
import type { ModelProfile } from '../../../../packages/contracts/generated/ModelProfile';
import type { RunEvent } from '../../../../packages/contracts/generated/RunEvent';
import type { RunEventType } from '../../../../packages/contracts/generated/RunEventType';
import type { StartRunRequest } from '../../../../packages/contracts/generated/StartRunRequest';
import { NdjsonFramer, PROTOCOL_VERSION, ProtocolError, parseEnvelope, serializeEnvelope, type RuntimeEnvelope } from '../protocol';
import type { ProviderAdapter, RuntimeContext } from '../registry';
import { SpawnPolicyError, spawnChild, superviseChild, type ChildSpec, type SpawnPolicy, type SpawnedChild } from '../security/spawn';

export interface DetectorImageSource {
  grant_id: Id;
  region: BBox | null;
}

export interface DetectorLocalOptions {
  spawnPolicy: SpawnPolicy;
  /** Fixed launch recipe for the worker; run input can never change it. */
  workerCommand: { executable: string; argv: string[] };
  /** Working directory for the worker (stays inside the spawn policy root). */
  workerCwd: string;
  /**
   * Display fallback for the model identity only. The authoritative identity
   * is whatever the worker's own probe reports from the lock it actually
   * verified; lock/weights locations are configured in the worker's
   * environment (WEBLABEL_DETECTOR_MODELS_LOCK / WEBLABEL_DETECTOR_WEIGHTS_DIR)
   * and passed through the explicit spawn-policy allowlist.
   */
  lockPath: string;
  /** Explicit `category -> label_id` JSON mapping. Mapping is never inferred. */
  labelMapPath: string;
  /**
   * Binds a run to its approved image grant. The consent layer (T25) issues
   * grants; without this binding the adapter refuses to run instead of
   * touching unapproved media.
   */
  imageSource: (input: StartRunRequest, run_id: Id) => DetectorImageSource | Promise<DetectorImageSource>;
  probeTimeoutMs?: number;
  runTimeoutMs?: number | null;
}

const RUN_EVENT_TYPES: Record<string, true> = {
  queued: true,
  started: true,
  progress: true,
  tool_call: true,
  candidate: true,
  succeeded: true,
  failed: true,
  cancelled: true,
};
const TERMINAL_EVENTS: Record<string, true> = { succeeded: true, failed: true, cancelled: true };
const MAX_ID_LENGTH = 128;

function composeProfile(modelId: string, availability: ModelProfile['availability'], runtimeVersion: string | null): ModelProfile {
  return {
    profile_id: 'detector_local',
    provider_id: 'detector_local',
    model_id: modelId,
    auth_kind: 'local_weights',
    capabilities: { image_input: true, tools: false, structured_output: true, bbox_output: true, attributes: false },
    availability,
    // Honest on the verification dimension too: T18 ships mock-tensor
    // post-processing evidence only; live execution evidence is T32's gate.
    verification: 'not_run',
    runtime_version: runtimeVersion,
    verified_at: null,
  };
}

function errorCode(error: unknown): string {
  if (error instanceof SpawnPolicyError) return error.code;
  if (error instanceof ProtocolError) return error.code;
  if (error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return 'detector_error';
}

/** Normalize untrusted error text before it reaches protocol events. */
function safeMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, ' ').trim().slice(0, 512);
}

function assertRunEvent(raw: unknown, run_id: Id, lastSeq: number): RunEvent {
  if (typeof raw !== 'object' || raw === null) throw new ProtocolError('invalid_envelope', 'run_event payload must be an object');
  const candidate = raw as Record<string, unknown>;
  if (candidate.run_id !== run_id) throw new ProtocolError('invalid_envelope', 'run_event run_id does not match the run');
  const seq = candidate.seq;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= lastSeq) {
    throw new ProtocolError('invalid_envelope', 'run_event seq must be strictly increasing');
  }
  const type = candidate.type;
  if (typeof type !== 'string' || RUN_EVENT_TYPES[type] !== true) {
    throw new ProtocolError('invalid_envelope', 'run_event has an unknown type');
  }
  if (typeof candidate.message !== 'string') throw new ProtocolError('invalid_envelope', 'run_event message must be a string');
  const data = candidate.data;
  if (data !== null && (typeof data !== 'object' || Array.isArray(data))) {
    throw new ProtocolError('invalid_envelope', 'run_event data must be an object or null');
  }
  return {
    run_id,
    seq,
    type: type as RunEventType,
    message: candidate.message,
    data: (data ?? null) as Record<string, unknown> | null,
  };
}

export class DetectorLocalAdapter implements ProviderAdapter {
  readonly #options: DetectorLocalOptions;
  readonly #child: ChildSpec;

  constructor(options: DetectorLocalOptions) {
    if (typeof options?.imageSource !== 'function') {
      throw new TypeError('DetectorLocalAdapter requires an imageSource binding runs to approved image grants');
    }
    this.#options = options;
    // Fixed launch recipe: run input can never change the worker command.
    this.#child = {
      executable: options.workerCommand.executable,
      argv: [...options.workerCommand.argv],
      cwd: options.workerCwd,
    };
  }

  #modelId(): string {
    try {
      const lock = JSON.parse(readFileSync(this.#options.lockPath, 'utf8')) as { model_id?: unknown };
      if (typeof lock.model_id === 'string' && lock.model_id.length > 0 && lock.model_id.length <= MAX_ID_LENGTH * 2) {
        return lock.model_id;
      }
    } catch {
      // Unreadable lock -> unknown identity; availability stays needs_configuration.
    }
    return 'unknown';
  }

  /**
   * Both dimensions are probed honestly. The Python worker probe verifies the
   * pinned weights and the real inference runtime; if the worker cannot even
   * start (Python missing/broken) the channel is `needs_configuration`.
   */
  async probe(): Promise<ModelProfile[]> {
    const modelId = this.#modelId();
    let child: SpawnedChild | null = null;
    try {
      child = spawnChild(this.#child, this.#options.spawnPolicy);
      child.stdin.write(
        `${serializeEnvelope({ protocol_version: PROTOCOL_VERSION, id: 'detector-probe', kind: 'request', method: 'probe', payload: {} })}\n`,
      );
      child.stdin.end();
      const framer = new NdjsonFramer();
      let profile: Record<string, unknown> | null = null;
      for await (const chunk of child.stdout) {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
        for (const line of framer.push(text)) {
          const envelope = parseEnvelope(line);
          if (envelope.kind === 'response' && envelope.method === 'probe') {
            const payload = envelope.payload as { ok?: unknown; profile?: unknown } | null;
            if (payload?.ok === true && typeof payload.profile === 'object' && payload.profile !== null) {
              profile = payload.profile as Record<string, unknown>;
            }
          }
        }
        if (profile !== null) break;
      }
      await superviseChild(child, { timeoutMs: this.#options.probeTimeoutMs ?? 30000 });
      if (profile === null) return [composeProfile(modelId, 'needs_configuration', null)];
      const availability = profile.availability === 'ready' ? 'ready' : 'needs_configuration';
      const runtimeVersion = typeof profile.runtime_version === 'string' ? profile.runtime_version : null;
      // Identity comes from what the worker actually verified, never from a
      // separately configured path that may diverge from the worker's own.
      const verifiedModelId =
        typeof profile.model_id === 'string' &&
        profile.model_id.length > 0 &&
        profile.model_id.length <= MAX_ID_LENGTH * 2
          ? profile.model_id
          : modelId;
      return [composeProfile(verifiedModelId, availability, runtimeVersion)];
    } catch {
      // Python missing, spawn policy refusal or a broken worker: report the
      // unconfigured state instead of throwing. The workbench keeps working.
      return [composeProfile(modelId, 'needs_configuration', null)];
    } finally {
      if (child !== null) {
        await child.killTree('probe cleanup').catch(() => undefined);
      }
    }
  }

  async *run(input: StartRunRequest, ctx: RuntimeContext, signal: AbortSignal): AsyncIterable<RunEvent> {
    const runId = ctx.run_id;
    let lastSeq = 0;
    const terminal = (type: RunEventType, message: string, data: Record<string, unknown> | null = null): RunEvent => {
      lastSeq += 1;
      return { run_id: runId, seq: lastSeq, type, message, data };
    };
    if (signal.aborted) {
      yield terminal('cancelled', 'run cancelled before start');
      return;
    }
    let stageDir: string | null = null;
    let child: SpawnedChild | null = null;
    const abortHandler = (): void => {
      if (child !== null) void child.killTree('run aborted').catch(() => undefined);
    };
    signal.addEventListener('abort', abortHandler, { once: true });
    try {
      if (input.intent !== 'detect') {
        yield terminal('failed', 'the detector only supports detect runs', { code: 'unsupported_intent' });
        return;
      }
      const source = await this.#options.imageSource(input, runId);
      const region = await ctx.read_region(source.grant_id, source.region);
      const ontology = await ctx.get_ontology();
      const document = await ctx.get_document();
      const labelMapping = readLabelMapping(this.#options.labelMapPath);
      stageDir = mkdtempSync(join(tmpdir(), 'weblabel-detector-'));
      const imagePath = join(stageDir, 'input.png');
      writeFileSync(imagePath, region.bytes, { mode: 0o600 });
      const payload = {
        run_id: runId,
        request: input,
        image: { path: imagePath, transform_to_canonical: region.transform_to_canonical },
        label_mapping: labelMapping,
        ontology_label_ids: ontology.labels.map((label) => label.label_id),
        canonical_size: { width: document.coordinate_space.width, height: document.coordinate_space.height },
      };
      child = spawnChild(this.#child, this.#options.spawnPolicy);
      child.stdin.write(
        `${serializeEnvelope({ protocol_version: PROTOCOL_VERSION, id: runId, kind: 'request', method: 'start_run', payload })}\n`,
      );
      // stdin stays open until the run reaches a terminal event: EOF is the
      // worker's shutdown signal and must never cancel an uncancelled run.
      const framer = new NdjsonFramer();
      let sawTerminal = false;
      for await (const chunk of child.stdout) {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
        for (const line of framer.push(text)) {
          const envelope: RuntimeEnvelope = parseEnvelope(line);
          if (envelope.kind !== 'event' || envelope.method !== 'run_event') continue;
          const event = assertRunEvent(envelope.payload, runId, lastSeq);
          lastSeq = event.seq;
          if (event.type === 'candidate') {
            // Candidates only ever enter through the candidate layer (C4).
            await ctx.submit_candidates((event.data as { raw?: unknown } | null)?.raw);
          }
          if (TERMINAL_EVENTS[event.type] === true) {
            sawTerminal = true;
            try {
              child.stdin.end();
            } catch {
              // the child may already be gone
            }
          }
          yield event;
        }
      }
      try {
        child.stdin.end();
      } catch {
        // the child may already be gone
      }
      const supervised = await superviseChild(child, {
        timeoutMs: this.#options.runTimeoutMs ?? null,
        signal,
      });
      if (!sawTerminal) {
        if (supervised.outcome === 'cancelled' || signal.aborted) {
          yield terminal('cancelled', 'detector run cancelled');
        } else if (supervised.outcome === 'timeout') {
          yield terminal('failed', 'detector run timed out', { code: 'run_timeout' });
        } else {
          yield terminal('failed', 'detector worker ended without a terminal event', {
            code: supervised.outcome === 'crashed' ? 'child_crashed' : 'missing_terminal_response',
          });
        }
      }
    } catch (error) {
      yield terminal(signal.aborted ? 'cancelled' : 'failed', safeMessage(error), signal.aborted ? null : { code: errorCode(error) });
    } finally {
      signal.removeEventListener('abort', abortHandler);
      if (child !== null) {
        await child.killTree('run cleanup').catch(() => undefined);
      }
      if (stageDir !== null) {
        rmSync(stageDir, { recursive: true, force: true });
      }
    }
  }
}

function readLabelMapping(path: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new SpawnPolicyError('needs_configuration', `explicit label mapping is not readable: ${safeMessage(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SpawnPolicyError('invalid_label_mapping', 'label mapping must be a JSON object of category -> label_id');
  }
  const mapping: Record<string, string> = {};
  for (const [category, labelId] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof labelId !== 'string' || labelId.length === 0 || category.length === 0) {
      throw new SpawnPolicyError('invalid_label_mapping', 'label mapping must map non-empty categories to non-empty label ids');
    }
    mapping[category] = labelId;
  }
  return mapping;
}
