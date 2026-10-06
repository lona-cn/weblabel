//! `claude_local` ProviderAdapter (docs/contracts.md C5): the end user's own
//! official Claude Code subscription runtime in non-interactive `-p` headless
//! mode over stdio, with run-scoped permissions, a project-MCP-only tool
//! surface, an isolated run cwd, consent-gated image egress and honest evidence
//! status.
//!
//! Evidence policy (docs/provider-compatibility.md, ADR 0001):
//!   - probe() reports `needs_configuration` when the official CLI is absent
//!     and `blocked` whenever the channel's protocol/safety boundary is not yet
//!     runtime-verified — the channel is never "ready" from documentation or
//!     synthetic transcripts, and probe() never starts a model session (the
//!     only probe invocation is the verified session-free `--version`);
//!   - `verification` is always `not_run` here: real subscription login, real
//!     image results and pinned-runtime schema validation are T32's gates;
//!   - usage comes from the terminal result only and is folded at most once
//!     (replayed/duplicated results can never double-bill), unknown usage stays
//!     unknown (never 0), cost is only computed from explicit pricing, and
//!     cancellation reports that it may already have cost — never a refund;
//!   - the tool loop is bounded by turns, bytes and time;
//!   - candidates always carry the original run context (C4) and are only ever
//!     produced through `ctx.submit_candidates` after strict schema+domain
//!     validation — truncated, failed or confused streams never write
//!     annotations.
//!
//! Authentication posture (ADR 0001, task card behavior 2): the run uses the
//! user's official Claude Code login as-is. The adapter never logs in, never
//! reads, collects or relays credentials, never passes `--bare` (which switches
//! to API-key billing), and credential environment names can never be
//! allowlisted into the child. An API-key-authenticated runtime is a distinct
//! `api_auth_not_subscription` failure, and a runtime that does not positively
//! report `auth_mode: 'subscription'` is refused as `needs_login` — absent or
//! unknown auth is never treated as subscription success. A result without a
//! parsed init is a protocol violation. An API call is never disguised as a
//! successful subscription run.

import { existsSync, mkdirSync } from 'node:fs';
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
  MCP_SERVER_NAME,
  buildClaudeLaunchPlan,
  buildVersionProbePlan,
  ClaudePermissionError,
  type ClaudeLaunchPlan,
  type ClaudePermissionsConfig,
} from './permissions';
import { parseClaudeLine } from './protocol';
import {
  MODEL_ALIASES,
  billingTotals,
  classifyClaudeState,
  foldClaudeMessage,
  newClaudeSession,
  type ClaudeSessionState,
} from './session';

export interface ClaudeImageSource {
  grant_id: Id;
  region: BBox | null;
}

export interface ClaudeTransport {
  /** The run prompt travels via stdin only, never argv (verified pipe usage). */
  sendPrompt(text: string): void;
  messages(): AsyncIterable<string>;
  close(): Promise<void>;
}

export interface ClaudeToolBudgets {
  max_tool_turns: number;
  max_tool_result_bytes: number;
}

export interface ClaudeLocalOptions {
  permissions: ClaudePermissionsConfig;
  /** Injected transport; production uses createStdioClaudeTransport. */
  transport: (plan: ClaudeLaunchPlan) => ClaudeTransport | Promise<ClaudeTransport>;
  /** Binds the run to its approved image grant (the consent layer supplies it). */
  imageSource: (input: StartRunRequest, run_id: Id) => ClaudeImageSource | Promise<ClaudeImageSource>;
  /** Supplies the run-scoped MCP token (delivered via child environment only). */
  runToken: (run_id: Id) => string | Promise<string>;
  /**
   * Path to the pinned protocol fixture (real stream-json capture from the
   * version-pinned runtime; T32 delivers it). This gate is existence-only;
   * validating the parser against the fixture is a T32 prerequisite (a
   * placeholder file would pass this gate).
   */
  schemaArtifactPath?: string | null;
  pricing?: TokenPricing | null;
  probeTimeoutMs?: number;
  runTimeoutMs?: number | null;
  budgets?: Partial<ClaudeToolBudgets>;
}

export interface ClaudeEvidenceStatus {
  docs_verified: boolean;
  protocol_fixture_tested: boolean;
  live_tested: boolean;
}

const DEFAULT_BUDGETS: ClaudeToolBudgets = { max_tool_turns: 32, max_tool_result_bytes: 1_048_576 };
const CANCEL_DRAIN_MS = 5000;

/** Independent evidence dimensions (docs/provider-compatibility.md). */
export function claudeEvidenceStatus(): ClaudeEvidenceStatus {
  return { docs_verified: true, protocol_fixture_tested: false, live_tested: false };
}

/**
 * Real stdio transport: spawns the official CLI through the T16 hardened spawn
 * policy (shell:false, trusted executable root, allowlisted env, restricted
 * cwd) and frames its stream-json stdout with the shared NDJSON framer. The
 * prompt is written to stdin; stderr is drained and never forwarded.
 */
export function createStdioClaudeTransport(plan: ClaudeLaunchPlan): ClaudeTransport {
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
  // stderr is diagnostics only: drained and discarded so it can never block the
  // child or leak through run events (C5: logs are redacted, never raw).
  child.stderr.resume();
  const framer = new NdjsonFramer();
  async function* lines(): AsyncIterable<string> {
    for await (const chunk of child.stdout) {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
      for (const line of framer.push(text)) yield line;
    }
    framer.flush();
  }
  return {
    sendPrompt(text: string): void {
      child.stdin.write(text);
      child.stdin.end();
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
      await child.killTree('claude transport close').catch(() => undefined);
    },
  };
}

type PumpedMessage = { kind: 'line'; line: string } | { kind: 'end' } | { kind: 'timeout' } | { kind: 'aborted' };

/**
 * Sole consumer of the transport message stream, so abort/timeout races can
 * never drop or reorder protocol lines (a dropped line would corrupt billing
 * and boundary accounting).
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
    // Close the check→listen race: an abort between the caller's check and the
    // listener registration must still wake the pump immediately.
    if (options.signal.aborted) resolve();
    const timer =
      options.deadlineMs === null ? undefined : setTimeout(resolve, Math.max(1, options.deadlineMs - Date.now()));
    try {
      await promise;
    } finally {
      options.signal.removeEventListener('abort', onAbort);
      clearTimeout(timer);
    }
  }
}

/** Stable error codes across the provider/permission/spawn error classes. */
function errorCodeOf(error: unknown): string {
  if (error instanceof ProviderError || error instanceof ClaudePermissionError || error instanceof ProtocolError) {
    return error.code;
  }
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return 'adapter_error';
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

export function createClaudeLocalAdapter(options: ClaudeLocalOptions): ProviderAdapter {
  const config = options.permissions;
  const pricing = options.pricing ?? null;
  const budgets: ClaudeToolBudgets = { ...DEFAULT_BUDGETS, ...(options.budgets ?? {}) };

  function composeProfile(availability: ModelProfile['availability'], runtimeVersion: string | null): ModelProfile {
    return {
      profile_id: 'claude_local',
      provider_id: 'claude_local',
      // Honest on model identity: the effective model of an installed runtime
      // and account is only observable from an authorized run (T32), never
      // inferred from an alias or an API catalog (ADR 0001).
      model_id: 'unknown',
      auth_kind: 'official_user_login',
      // image_input is grounded on this project's T21 MCP read_region surface,
      // which returns authorized crops as MCP image content blocks with budget
      // enforcement; no unverified CLI image transport is assumed (T32 gates
      // real image runs).
      capabilities: { image_input: true, tools: true, structured_output: true, bbox_output: false, attributes: true },
      availability,
      verification: 'not_run',
      runtime_version: runtimeVersion,
      verified_at: null,
    };
  }

  async function launchPlan(run_id: Id): Promise<ClaudeLaunchPlan> {
    const runToken = await options.runToken(run_id);
    return buildClaudeLaunchPlan(config, {
      run_id,
      runToken,
      apiBase: config.apiBase ?? 'http://127.0.0.1:48100',
    });
  }

  return {
    async probe(): Promise<ModelProfile[]> {
      const sourceEnv = config.source_env ?? process.env;
      if (locateExecutable(config.command.executable, sourceEnv) === null) {
        return [composeProfile('needs_configuration', null)];
      }
      const schemaPath = options.schemaArtifactPath ?? null;
      if (schemaPath === null || !existsSync(schemaPath)) {
        // ADR 0001: the channel stays blocked until a pinned runtime protocol
        // fixture is PRESENT. This gate is existence-only; validating the
        // parser against a real pinned-runtime capture is a T32 prerequisite
        // (a placeholder file would pass this gate).
        return [composeProfile('blocked', null)];
      }
      let transport: ClaudeTransport | null = null;
      try {
        // The only probe surface is the verified session-free `--version`:
        // no `-p`, no prompt, no MCP config, no session — probing can never
        // start a model session, read credentials or touch the network.
        const plan = buildVersionProbePlan(config, { run_id: 'claude-probe' });
        transport = await options.transport(plan);
        const pump = new MessagePump(transport.messages());
        const probeSignal = new AbortController().signal;
        const deadlineMs = Date.now() + (options.probeTimeoutMs ?? 5000);
        let version: string | null = null;
        for (;;) {
          const next = await pump.next({ signal: probeSignal, deadlineMs });
          if (next.kind !== 'line') break;
          const text = next.line.trim();
          if (version === null && text.length > 0 && text.length <= 64) version = text;
        }
        // Protocol fixture and safety boundary remain unverified here: the
        // channel stays `blocked` regardless of the version string (T32 gates).
        return [composeProfile('blocked', version)];
      } catch {
        // A broken/unavailable runtime is a configuration gap, not a crash.
        return [composeProfile('needs_configuration', null)];
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
        session: ClaudeSessionState,
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
      const cancelData = (session: ClaudeSessionState): Record<string, unknown> => {
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

      let session = newClaudeSession();
      let transport: ClaudeTransport | null = null;
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
        // The run is bound to its own conversation id up front (verified
        // --session-id flag): foreign sessions can never terminate or bill it.
        session = newClaudeSession({
          run_session_id: plan.sessionId,
          requested_model: plan.model,
          permitted_tools: plan.toolPolicy.allowed_tools,
        });
        if (!("allow_image" in ctx && ctx.allow_image === false)) {
          const grants = imageGrantIds(ctx);
          const source = await options.imageSource(input, runId);
          if (source.grant_id !== grants[0]) throw new ProviderError("image_grant_missing", "image source is not the approved grant");
        }
        // No pixel byte is read or staged by this adapter: image bytes reach
        // the model only through the T21 MCP read_region surface, where the
        // consent scope and crop/pixel budgets are enforced server-side.

        const document = await ctx.get_document();
        const ontology = await ctx.get_ontology();
        const domain: CandidateDomainContext = {
          intent: input.intent,
          // The claude_local profile never enables bbox_output (C4): no create
          // or geometry changes can come back from this channel.
          bbox_output: false,
          document,
          ontology,
        };

        transport = await options.transport(plan);
        const pump = new MessagePump(transport.messages());
        yield emit('started', 'run started', null);
        // The prompt travels via stdin only (verified `-p` pipe usage): it can
        // never inject flags or leak through argv/process listings.
        transport.sendPrompt(input.prompt);

        const abortless = new AbortController();
        let cancelling = false;
        let cancelDeadline: number | null = null;
        const emittedCalls = new Set<string>();
        const runDeadline =
          options.runTimeoutMs != null && options.runTimeoutMs > 0 ? Date.now() + options.runTimeoutMs : null;

        for (;;) {
          const next = await pump.next({
            signal: cancelling ? abortless.signal : signal,
            deadlineMs: cancelling ? cancelDeadline : runDeadline,
          });
          if (next.kind === 'aborted') {
            // The CLI documents no turn-interrupt request: cancelling stops
            // consuming, kills the runtime tree and drains whatever already
            // arrived. The run may already have cost; that is reported as-is.
            cancelling = true;
            cancelDeadline = Date.now() + CANCEL_DRAIN_MS;
            await transport!.close().catch(() => undefined);
            continue;
          }
          if (next.kind === 'timeout' || next.kind === 'end') {
            if (cancelling) {
              // Late but fully parsed candidates survive cancellation (the
              // stream was intact): validate strictly, then submit once.
              const drafts = session.proposals.map((proposal) => validateCandidateDraft(proposal, domain));
              for (const draft of drafts) {
                await ctx.submit_candidates(draft);
                yield emit('candidate', 'candidate submitted', {
                  change_ids: draft.changes.map((change) => change.change_id),
                  issue_ids: draft.issues.map((issue) => issue.issue_id),
                  score: draft.score,
                  context: input.context,
                });
              }
              yield terminal('cancelled', 'run cancelled; cancellation may already have cost', cancelData(session));
            } else if (next.kind === 'timeout') {
              yield terminal(
                'failed',
                'run failed: tool_time_budget_exceeded',
                failureData('tool_time_budget_exceeded', 'the claude tool loop exceeded its time budget', null, session),
              );
            } else {
              yield terminal(
                'failed',
                'run failed: claude_disconnected',
                failureData('claude_disconnected', 'the claude runtime exited before a terminal result', null, session),
              );
            }
            return;
          }

          const message = parseClaudeLine(next.line);
          const outputBefore = session.output_blocks;
          const resultsBefore = session.tool_results_seen;
          session = foldClaudeMessage(session, message);

          // Fail closed on every breach before anything can be written.
          if (session.policy_violation !== null) {
            yield terminal(
              'failed',
              'run failed: method_not_permitted',
              failureData('method_not_permitted', session.policy_violation, null, session),
            );
            return;
          }
          if (session.boundary_violation !== null) {
            yield terminal(
              'failed',
              'run failed: claude_protocol_violation',
              failureData('claude_protocol_violation', session.boundary_violation, null, session),
            );
            return;
          }
          if (session.init !== null) {
            const verdict = classifyClaudeState(session.init, plan.model ?? null);
            if (session.init.auth_mode === 'api_key') {
              yield terminal(
                'failed',
                'run failed: api_auth_not_subscription',
                failureData(
                  'api_auth_not_subscription',
                  'the runtime authenticated with an API key; this profile is the official subscription channel and an API call is never presented as a subscription run',
                  'api_auth_not_subscription',
                  session,
                ),
              );
              return;
            }
            if (verdict.availability === 'needs_login') {
              // Absent or unknown auth is never a subscription success.
              yield terminal(
                'failed',
                'run failed: needs_login',
                failureData(
                  'needs_login',
                  'the runtime did not positively report subscription auth; unknown or absent auth is never presented as a subscription run',
                  'needs_login',
                  session,
                ),
              );
              return;
            }
            const loadErrors = session.init.mcp_server_errors;
            // The project MCP surface must be PRESENT, not merely unblemished:
            // an empty surface (failed-to-load server) is a load error too.
            const surfaceMissing = !session.init.mcp_servers.includes(MCP_SERVER_NAME);
            if ((loadErrors !== null && Object.keys(loadErrors).length > 0) || surfaceMissing) {
              yield terminal(
                'failed',
                'run failed: mcp_load_error',
                failureData('mcp_load_error', 'the project MCP surface did not load cleanly', null, session),
              );
              return;
            }
            const reportedModel = session.init.model;
            if (
              plan.model !== null &&
              !MODEL_ALIASES.includes(plan.model) &&
              reportedModel !== null &&
              reportedModel !== plan.model
            ) {
              yield terminal(
                'failed',
                'run failed: model_unavailable',
                failureData(
                  'model_unavailable',
                  `the runtime reported model ${reportedModel}, not the requested ${plan.model}`,
                  'model_unavailable',
                  session,
                ),
              );
              return;
            }
          }
          if (session.tool_calls_total > budgets.max_tool_turns) {
            yield terminal(
              'failed',
              'run failed: tool_turn_budget_exceeded',
              failureData('tool_turn_budget_exceeded', 'the claude tool loop exceeded its turn budget', null, session),
            );
            return;
          }
          if (session.tool_result_bytes > budgets.max_tool_result_bytes) {
            yield terminal(
              'failed',
              'run failed: tool_byte_budget_exceeded',
              failureData('tool_byte_budget_exceeded', 'the claude tool loop exceeded its byte budget', null, session),
            );
            return;
          }

          // Surface the stream boundaries: tool calls, streaming output and
          // tool results are distinct event kinds for the run timeline.
          for (const [id, call] of session.tool_calls) {
            if (emittedCalls.has(id)) continue;
            emittedCalls.add(id);
            yield emit('tool_call', 'tool call', { tool: call.name, tool_use_id: id });
          }
          if (session.output_blocks > outputBefore) yield emit('progress', 'assistant output', null);
          if (session.tool_results_seen > resultsBefore) yield emit('progress', 'tool result', null);

          if (message.kind === 'result' && session.result !== null) {
            if (session.init === null) {
              // A result without a parsed init is a protocol violation: auth,
              // model and MCP facts would be unknown at terminal time.
              yield terminal(
                'failed',
                'run failed: claude_protocol_violation',
                failureData('claude_protocol_violation', 'result arrived without a parsed init event', null, session),
              );
              return;
            }
            if (session.result.status === 'success') {
              // Validate everything before storing anything; every candidate
              // keeps the ORIGINAL run context (C4).
              const drafts = session.proposals.map((proposal) => validateCandidateDraft(proposal, domain));
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
              if (cancelling) {
                // The user cancelled while the result was in flight: the run is
                // cancelled, with whatever usage the result carried.
                yield terminal('cancelled', 'run cancelled; cancellation may already have cost', cancelData(session));
                return;
              }
              yield terminal('succeeded', 'run succeeded', {
                usage,
                cost_display: costDisplay(usage),
                model: session.init.model,
                tool_calls: session.tool_calls_total,
              });
            } else {
              const reason = session.result.reason;
              const code = reason ?? 'provider_reported_failure';
              yield terminal(
                'failed',
                `run failed: ${code}`,
                failureData(code, session.result.error_message ?? 'the claude runtime reported a failed result', reason, session),
              );
            }
            return;
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
