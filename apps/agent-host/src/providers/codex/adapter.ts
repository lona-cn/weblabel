//! `codex_local` ProviderAdapter (docs/contracts.md C5): the end user's own
//! official Codex CLI subscription runtime over local stdio (JSONL JSON-RPC),
//! with run-scoped permissions, a project-MCP-only tool surface, an isolated
//! run cwd, consent-gated image egress and honest evidence status.
//!
//! Evidence policy (docs/provider-compatibility.md, ADR 0001):
//!   - probe() reports `needs_configuration` when the official CLI is absent
//!     and `blocked` when no CLI-generated schema artifact is pinned — the
//!     channel is never "ready" from documentation or synthetic transcripts;
//!   - `verification` is always `not_run` here: real subscription login, real
//!     image results and generated-schema validation are T32's gates;
//!   - usage is folded at most once per turn (exit/cancel/disconnect/out-of-order
//!     events can never double-bill), unknown usage stays unknown (never 0),
//!     cost is only computed from explicit pricing, cancellation reports that
//!     it may already have cost and never claims a refund;
//!   - candidates always carry the original run context (C4) and are only ever
//!     produced through `ctx.submit_candidates` after strict schema+domain
//!     validation — no state, no code, no shell is ever written by the agent.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import type { BBox } from '../../../../../packages/contracts/generated/BBox';
import type { Id } from '../../../../../packages/contracts/generated/Id';
import type { ModelProfile } from '../../../../../packages/contracts/generated/ModelProfile';
import type { RunEvent } from '../../../../../packages/contracts/generated/RunEvent';
import type { StartRunRequest } from '../../../../../packages/contracts/generated/StartRunRequest';
import { ProtocolError, NdjsonFramer } from '../../protocol';
import type { ProviderAdapter, RuntimeContext } from '../../registry';
import { redactText } from '../../security/redaction';
import { spawnChild, type SpawnedChild, type SpawnPolicy } from '../../security/spawn';
import { ProviderError, validateCandidateDraft, type CandidateDomainContext } from '../http/errors';
import { imageGrantIds } from '../http/images';
import { costDisplay, normalizeUsage, type TokenPricing } from '../http/usage';
import {
  INITIALIZE_METHOD,
  INITIALIZED_METHOD,
  THREAD_START_METHOD,
  TURN_INTERRUPT_METHOD,
  TURN_START_METHOD,
  isItemEvent,
  parseCodexLine,
  serializeCodexNotification,
  serializeCodexRequest,
  type CodexMessage,
} from './protocol';
import {
  buildLaunchPlan,
  isMethodPermitted,
  CodexPermissionError,
  type CodexLaunchPlan,
  type CodexPermissionsConfig,
} from './permissions';
import {
  beginInitialize,
  billingTotals,
  canSendRequest,
  classifyCodexState,
  classifyUnavailable,
  foldCodexMessage,
  markInitialized,
  newCodexSession,
  normalizeRuntimeState,
  noteRunTurn,
  sessionUnavailable,
  type CodexRuntimeState,
  type CodexSessionState,
} from './session';

export interface CodexImageSource {
  grant_id: Id;
  region: BBox | null;
}

export interface CodexTransport {
  send(line: string): void;
  messages(): AsyncIterable<string>;
  close(): Promise<void>;
}

export interface CodexLocalOptions {
  permissions: CodexPermissionsConfig;
  /** Injected transport; production uses createStdioCodexTransport. */
  transport: (plan: CodexLaunchPlan) => CodexTransport | Promise<CodexTransport>;
  /** Binds the run to its approved image grant (the consent layer supplies it). */
  imageSource: (input: StartRunRequest, run_id: Id) => CodexImageSource | Promise<CodexImageSource>;
  /** Supplies the run-scoped MCP token (delivered via child environment only). */
  runToken: (run_id: Id) => string | Promise<string>;
  /**
   * Path to the CLI-generated schema artifact (`codex app-server generate-ts`
   * / `generate-json-schema` output). Without it the channel is `blocked`
   * (ADR 0001); generating and hashing it is a T32 prerequisite.
   */
  schemaArtifactPath?: string | null;
  pricing?: TokenPricing | null;
  probeTimeoutMs?: number;
  runTimeoutMs?: number | null;
}

export interface CodexEvidenceStatus {
  docs_verified: boolean;
  protocol_fixture_tested: boolean;
  live_tested: boolean;
}

/** Independent evidence dimensions (docs/provider-compatibility.md). */
export function codexEvidenceStatus(): CodexEvidenceStatus {
  return { docs_verified: true, protocol_fixture_tested: false, live_tested: false };
}

/**
 * Real stdio transport: spawns the official CLI through the T16 hardened
 * spawn policy (shell:false, allowlisted env, restricted cwd) and frames its
 * JSONL protocol with the shared NDJSON framer. The launch recipe comes from
 * the plan; this function never invents CLI flags.
 */
export function createStdioCodexTransport(plan: CodexLaunchPlan): CodexTransport {
  mkdirSync(plan.cwd, { recursive: true, mode: 0o700 });
  const policy: SpawnPolicy = {
    trusted_executable_roots: [dirname(resolve(plan.command.executable))],
    allowed_env: Object.keys(plan.env),
    cwd_root: plan.cwd,
    source_env: {},
  };
  const child: SpawnedChild = spawnChild(
    { executable: plan.command.executable, argv: [...plan.command.argv], cwd: plan.cwd, env: plan.env },
    policy,
  );
  const framer = new NdjsonFramer();
  async function* lines(): AsyncIterable<string> {
    for await (const chunk of child.stdout) {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
      for (const line of framer.push(text)) yield line;
    }
    framer.flush();
  }
  return {
    send(line: string): void {
      child.stdin.write(`${line}\n`);
    },
    messages(): AsyncIterable<string> {
      return lines();
    },
    async close(): Promise<void> {
      try {
        child.stdin.end();
      } catch {
        // the child may already be gone
      }
      await child.killTree('codex transport close').catch(() => undefined);
    },
  };
}

type PumpedMessage = { kind: 'line'; line: string } | { kind: 'end' } | { kind: 'timeout' } | { kind: 'aborted' };

/**
 * Sole consumer of the transport message stream, so abort/timeout races can
 * never drop or reorder protocol lines (a dropped line would corrupt billing
 * and lifecycle accounting).
 */
class MessagePump {
  readonly #pending: string[] = [];
  readonly #waiters: Array<() => void> = [];
  #ended = false;
  #failure: unknown = null;

  constructor(source: AsyncIterable<string>) {
    const drain = async (): Promise<void> => {
      try {
        for await (const line of source) {
          this.#pending.push(line);
          this.#wake();
        }
      } catch (error) {
        this.#failure = error;
      } finally {
        this.#ended = true;
        this.#wake();
      }
    };
    void drain();
  }

  #wake(): void {
    while (this.#waiters.length > 0) this.#waiters.shift()!();
  }

  async next(options: { signal: AbortSignal; deadlineMs: number | null }): Promise<PumpedMessage> {
    for (;;) {
      if (this.#pending.length > 0) return { kind: 'line', line: this.#pending.shift()! };
      if (this.#failure !== null) throw this.#failure;
      if (this.#ended) return { kind: 'end' };
      if (options.signal.aborted) return { kind: 'aborted' };
      if (options.deadlineMs !== null && Date.now() >= options.deadlineMs) return { kind: 'timeout' };
      await this.#pause(options);
    }
  }

  async #pause(options: { signal: AbortSignal; deadlineMs: number | null }): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#waiters.push(resolve);
    const onAbort = (): void => resolve();
    options.signal.addEventListener('abort', onAbort, { once: true });
    const timer =
      options.deadlineMs === null ? null : setTimeout(resolve, Math.max(1, options.deadlineMs - Date.now()));
    try {
      await promise;
    } finally {
      options.signal.removeEventListener('abort', onAbort);
      if (timer !== null) clearTimeout(timer);
    }
  }
}

const CANCEL_DRAIN_MS = 5000;
const MAX_ID_LENGTH = 128;

/** Stable error codes across the provider/permission/spawn error classes. */
function errorCodeOf(error: unknown): string {
  if (error instanceof ProviderError || error instanceof CodexPermissionError || error instanceof ProtocolError) {
    return error.code;
  }
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return 'adapter_error';
}

function validRef(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function locateExecutable(executable: string, env: Record<string, string | undefined>): string | null {
  if (typeof executable !== 'string' || executable.length === 0) return null;
  if (isAbsolute(executable) || executable.includes('/') || executable.includes('\\')) {
    return existsSync(resolve(executable)) ? resolve(executable) : null;
  }
  const pathValue = env.PATH ?? env.Path ?? env.path;
  if (typeof pathValue !== 'string') return null;
  const extensions = (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter((entry) => entry.length > 0);
  for (const dir of pathValue.split(';')) {
    if (dir.length === 0) continue;
    const candidates =
      process.platform === 'win32'
        ? extensions.map((extension) => join(dir, `${executable}${extension}`))
        : [join(dir, executable)];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return resolve(candidate);
    }
  }
  return null;
}

export function createCodexLocalAdapter(options: CodexLocalOptions): ProviderAdapter {
  const config = options.permissions;
  const pricing = options.pricing ?? null;

  function composeProfile(
    availability: ModelProfile['availability'],
    runtimeVersion: string | null,
    modelId: string,
  ): ModelProfile {
    return {
      profile_id: 'codex_local',
      provider_id: 'codex_local',
      model_id: modelId,
      auth_kind: 'official_user_login',
      capabilities: { image_input: true, tools: true, structured_output: false, bbox_output: false, attributes: true },
      availability,
      // Honest on the verification dimension: nothing here is live evidence;
      // real login/image/schema evidence belongs to T32.
      verification: 'not_run',
      runtime_version: runtimeVersion,
      verified_at: null,
    };
  }

  async function launchPlan(run_id: Id): Promise<CodexLaunchPlan> {
    const runToken = await options.runToken(run_id);
    return buildLaunchPlan(config, { run_id, runToken, apiBase: config.apiBase ?? 'http://127.0.0.1:48100' });
  }

  return {
    async probe(): Promise<ModelProfile[]> {
      const sourceEnv = config.source_env ?? process.env;
      if (locateExecutable(config.command.executable, sourceEnv) === null) {
        return [composeProfile('needs_configuration', null, 'unknown')];
      }
      const schemaPath = options.schemaArtifactPath ?? null;
      if (schemaPath === null || !existsSync(schemaPath)) {
        // ADR 0001: the Codex channel stays blocked until a CLI-generated
        // schema artifact is PRESENT. This gate is existence-only; pinning the
        // artifact to an exact CLI version and verifying its hash is a T32
        // prerequisite (a placeholder file would pass this gate).
        return [composeProfile('blocked', null, 'unknown')];
      }
      let transport: CodexTransport | null = null;
      try {
        const plan = await launchPlan('codex-probe');
        transport = await options.transport(plan);
        let session = beginInitialize(newCodexSession());
        transport.send(serializeCodexRequest('codex-req-1', INITIALIZE_METHOD, {}));
        const pump = new MessagePump(transport.messages());
        const probeSignal = new AbortController().signal;
        const deadlineMs = Date.now() + (options.probeTimeoutMs ?? 5000);
        let runtime: CodexRuntimeState | null = null;
        for (;;) {
          const next = await pump.next({ signal: probeSignal, deadlineMs });
          if (next.kind !== 'line') break;
          const message = parseCodexLine(next.line);
          session = foldCodexMessage(session, message);
          if (message.kind === 'response' && message.error === null) {
            const normalized = normalizeRuntimeState(message.result);
            if (normalized !== null) {
              runtime = normalized;
              break;
            }
          }
        }
        if (runtime === null) return [composeProfile('needs_configuration', null, 'unknown')];
        session = markInitialized(session);
        transport.send(serializeCodexNotification(INITIALIZED_METHOD, {}));
        const classification = classifyCodexState(runtime);
        return [composeProfile(classification.availability, runtime.runtime_version ?? null, runtime.models[0] ?? 'unknown')];
      } catch {
        // A broken/unavailable runtime is a configuration gap, not a crash.
        return [composeProfile('needs_configuration', null, 'unknown')];
      } finally {
        await transport?.close().catch(() => undefined);
      }
    },

    async *run(input: StartRunRequest, ctx: RuntimeContext, signal: AbortSignal): AsyncIterable<RunEvent> {
      const runId = ctx.run_id;
      let seq = 0;
      const emit = (type: RunEvent['type'], message: string, data: Record<string, unknown> | null): RunEvent => ({
        run_id: runId,
        seq: seq++,
        type,
        message,
        data,
      });
      let terminalSent = false;
      const terminal = (type: RunEvent['type'], message: string, data: Record<string, unknown> | null): RunEvent => {
        terminalSent = true;
        return emit(type, message, data);
      };
      const failureData = (
        code: string,
        detail: string,
        reason: string | null,
        session: CodexSessionState,
      ): Record<string, unknown> => {
        const usage = billingTotals(session, pricing);
        return {
          error_code: code,
          error_message: redactText(detail),
          reason,
          usage,
          cost_display: costDisplay(usage),
        };
      };
      const cancelData = (session: CodexSessionState): Record<string, unknown> => {
        const usage = billingTotals(session, pricing);
        return {
          usage,
          cost_display: costDisplay(usage),
          // A cancelled subscription run may already have been charged; the
          // product never promises a refund or a zero cost here.
          billing: 'may_have_cost',
        };
      };
      if (signal.aborted) {
        yield terminal('cancelled', 'run cancelled before start', {
          usage: normalizeUsage(null, pricing),
          cost_display: 'unknown',
          billing: 'not_started',
        });
        return;
      }

      let session = newCodexSession();
      let transport: CodexTransport | null = null;
      try {
        // Egress gate: without an explicit consent record the run refuses to
        // start, reads no image and talks to no runtime.
        if (input.consent_id === null) {
          yield terminal('failed', 'run failed: consent_required', {
            error_code: 'consent_required',
            error_message: 'no consent record authorizes this run',
            reason: null,
            usage: normalizeUsage(null, pricing),
            cost_display: 'unknown',
          });
          return;
        }
        const plan = await launchPlan(runId);
        let imagePath: string | null = null;
        if (!("allow_image" in ctx && ctx.allow_image === false)) {
          const grants = imageGrantIds(ctx);
          const source = await options.imageSource(input, runId);
          if (source.grant_id !== grants[0]) throw new ProviderError("image_grant_missing", "image source is not the approved grant");
          const region = await ctx.read_region(source.grant_id, source.region);
          mkdirSync(plan.cwd, { recursive: true, mode: 0o700 });
          imagePath = join(plan.cwd, "input-0.png");
          writeFileSync(imagePath, region.bytes, { mode: 0o600 });
        }

        const document = await ctx.get_document();
        const ontology = await ctx.get_ontology();
        const domain: CandidateDomainContext = {
          intent: input.intent,
          // The codex_local profile never enables bbox_output (C4): no create
          // or geometry changes can come back from this channel.
          bbox_output: false,
          document,
          ontology,
        };

        transport = await options.transport(plan);
        const pump = new MessagePump(transport.messages());
        yield emit('started', 'run started', null);

        const pending: Array<{ id: string; method: string }> = [];
        let requestSeq = 0;
        const sendRequest = (method: string, params: Record<string, unknown>): void => {
          if (!canSendRequest(session, method) || !isMethodPermitted(plan, method)) {
            throw new ProviderError('method_not_permitted', `${method} is not permitted for this run`);
          }
          requestSeq += 1;
          const id = `codex-req-${requestSeq}`;
          pending.push({ id, method });
          transport!.send(serializeCodexRequest(id, method, params));
        };
        const sendNotification = (method: string, params: Record<string, unknown>): void => {
          if (!isMethodPermitted(plan, method)) {
            throw new ProviderError('method_not_permitted', `${method} is not permitted for this run`);
          }
          transport!.send(serializeCodexNotification(method, params));
        };

        sendRequest(INITIALIZE_METHOD, {});
        session = beginInitialize(session);

        const abortless = new AbortController();
        let turnId: string | null = null;
        let interruptPending = false;
        let cancelling = false;
        let cancelDeadline: number | null = null;
        const handledTurns = new Set<string>();
        const runDeadline =
          options.runTimeoutMs != null && options.runTimeoutMs > 0 ? Date.now() + options.runTimeoutMs : null;

        for (;;) {
          const next = await pump.next({
            signal: cancelling ? abortless.signal : signal,
            deadlineMs: cancelling ? cancelDeadline : runDeadline,
          });
          if (next.kind === 'aborted') {
            cancelling = true;
            cancelDeadline = Date.now() + CANCEL_DRAIN_MS;
            if (turnId !== null && !interruptPending) {
              sendRequest(TURN_INTERRUPT_METHOD, { turn_id: turnId });
              interruptPending = true;
            }
            continue;
          }
          if (next.kind === 'timeout') {
            if (cancelling) {
              yield terminal('cancelled', 'run cancelled; cancellation may already have cost', cancelData(session));
            } else {
              yield terminal(
                'failed',
                'run failed: run_timeout',
                failureData('run_timeout', 'the codex run exceeded its time budget', null, session),
              );
            }
            return;
          }
          if (next.kind === 'end') {
            if (cancelling) {
              yield terminal('cancelled', 'run cancelled; cancellation may already have cost', cancelData(session));
            } else {
              yield terminal(
                'failed',
                'run failed: codex_disconnected',
                failureData('codex_disconnected', 'the codex runtime exited before a terminal turn status', null, session),
              );
            }
            return;
          }

          const message: CodexMessage = parseCodexLine(next.line);
          const itemsBefore = turnId === null ? 0 : (session.turns.get(turnId)?.items_seen ?? 0);
          session = foldCodexMessage(session, message);

          if (message.kind === 'notification' && isItemEvent(message.method) && validRef(message.params.turn_id)) {
            const itemsAfter = session.turns.get(message.params.turn_id)?.items_seen ?? 0;
            if (itemsAfter > itemsBefore) yield emit('progress', 'turn item', { turn_id: message.params.turn_id });
          }

          if (message.kind === 'response') {
            // Consume the expectation exactly once: a duplicated or replayed
            // response with an answered id must never re-run handshake or run
            // side effects (that would bill a second turn for one run).
            const index = pending.findIndex((entry) => entry.id === message.id);
            if (index < 0) continue;
            const expectation = pending[index];
            pending.splice(index, 1);
            if (message.error !== null) {
              const reason = classifyUnavailable(message.error);
              const code = reason ?? 'provider_reported_failure';
              yield terminal('failed', `run failed: ${code}`, failureData(code, message.error.message, reason, session));
              return;
            }
            const result = message.result ?? {};
            if (expectation?.method === INITIALIZE_METHOD) {
              const unavailable = sessionUnavailable(session);
              if (unavailable !== null) {
                yield terminal(
                  'failed',
                  `run failed: ${unavailable}`,
                  failureData(unavailable, `the codex runtime is not usable: ${unavailable}`, unavailable, session),
                );
                return;
              }
              session = markInitialized(session);
              sendNotification(INITIALIZED_METHOD, {});
              sendRequest(THREAD_START_METHOD, { model: null });
            } else if (expectation?.method === THREAD_START_METHOD) {
              if (!validRef(result.thread_id)) {
                yield terminal(
                  'failed',
                  'run failed: codex_protocol_violation',
                  failureData('codex_protocol_violation', 'thread/start response has no thread_id', null, session),
                );
                return;
              }
              sendRequest(TURN_START_METHOD, {
                thread_id: result.thread_id,
                prompt: input.prompt,
                images: imagePath === null ? [] : [{ type: "localImage", path: imagePath }],
              });
            } else if (expectation?.method === TURN_START_METHOD) {
              if (!validRef(result.turn_id)) {
                yield terminal(
                  'failed',
                  'run failed: codex_protocol_violation',
                  failureData('codex_protocol_violation', 'turn/start response has no turn_id', null, session),
                );
                return;
              }
              turnId = result.turn_id;
              session = noteRunTurn(session, turnId);
            }
            if (cancelling && turnId !== null && !interruptPending) {
              // The abort raced the turn/start response: cancel the turn now.
              sendRequest(TURN_INTERRUPT_METHOD, { turn_id: turnId });
              interruptPending = true;
            }
          }

          // Terminal handling is bound to THIS run's turn id: a foreign or
          // unsolicited turn event can never end the run, and candidates come
          // from the accumulated turn state (any event order) exactly once.
          if (turnId !== null && !handledTurns.has(turnId)) {
            const turn = session.turns.get(turnId);
            if (turn?.terminal) {
              handledTurns.add(turnId);
              // Validate everything before storing anything; every candidate
              // keeps the ORIGINAL run context (C4), even after cancel/exit.
              const drafts = turn.proposals.map((proposal) =>
                validateCandidateDraft(proposal, domain),
              );
              for (const draft of drafts) {
                await ctx.submit_candidates(draft);
                yield emit('candidate', 'candidate submitted', {
                  change_ids: draft.changes.map((change) => change.change_id),
                  issue_ids: draft.issues.map((issue) => issue.issue_id),
                  score: draft.score,
                  context: input.context,
                });
              }
              const usage = billingTotals(session, pricing);
              if (turn.status === 'completed') {
                yield terminal('succeeded', 'run succeeded', {
                  usage,
                  cost_display: costDisplay(usage),
                  turns: 1,
                });
              } else if (turn.status === 'interrupted') {
                yield terminal('cancelled', 'run cancelled; cancellation may already have cost', cancelData(session));
              } else {
                yield terminal(
                  'failed',
                  'run failed: provider_reported_failure',
                  failureData('provider_reported_failure', 'the codex runtime reported a failed turn', null, session),
                );
              }
              return;
            }
          }
        }
      } catch (error) {
        if (terminalSent) return;
        const code = errorCodeOf(error);
        const message = error instanceof Error ? redactText(error.message) : 'unexpected adapter failure';
        if (signal.aborted) {
          yield terminal('cancelled', 'run cancelled; cancellation may already have cost', cancelData(session));
        } else {
          yield terminal('failed', `run failed: ${code}`, failureData(code, message, null, session));
        }
      } finally {
        await transport?.close().catch(() => undefined);
      }
    },
  };
}
