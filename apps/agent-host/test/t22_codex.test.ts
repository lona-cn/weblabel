//! T22 — official Codex subscription runtime adapter (`codex_local`).
//!
//! SYNTHETIC TRANSCRIPT NOTICE: the Codex CLI is NOT installed on this
//! workstation (`where codex` finds nothing). Every protocol transcript below
//! is hand-written against the project-pinned schema of
//! docs/providers/codex.md (derived from the T02-verified documentation
//! boundaries in docs/provider-compatibility.md). Synthetic transcripts only
//! exercise parsing, run-loop and error paths; they are NOT generated-schema
//! evidence and NOT live evidence. Real CLI schema generation, real
//! subscription login and real image results are T32 prerequisites and are
//! never claimed here.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import type { AnnotationDocument } from '../../../packages/contracts/generated/AnnotationDocument';
import type { BBox } from '../../../packages/contracts/generated/BBox';
import type { Id } from '../../../packages/contracts/generated/Id';
import type { OntologyVersion } from '../../../packages/contracts/generated/OntologyVersion';
import type { RunContext } from '../../../packages/contracts/generated/RunContext';
import type { RunEvent } from '../../../packages/contracts/generated/RunEvent';
import type { StartRunRequest } from '../../../packages/contracts/generated/StartRunRequest';
import type { SuggestionSet } from '../../../packages/contracts/generated/SuggestionSet';
import type { ProviderAdapter, RuntimeContext, RuntimeReadRegion } from '../src/registry';
import { TOOL_NAMES } from '../src/mcp/tools';
import {
  FORBIDDEN_METHODS,
  INITIALIZE_METHOD,
  INITIALIZED_METHOD,
  THREAD_START_METHOD,
  TURN_INTERRUPT_METHOD,
  TURN_START_METHOD,
  parseCodexLine,
  serializeCodexNotification,
  serializeCodexRequest,
  type CodexMessage,
} from '../src/providers/codex/protocol';
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
  sessionUnavailable,
  type CodexSessionState,
} from '../src/providers/codex/session';
import {
  CodexPermissionError,
  MCP_SERVER_NAME,
  buildLaunchPlan,
  isMethodPermitted,
  resolveRunCwd,
  type CodexLaunchPlan,
  type CodexPermissionsConfig,
} from '../src/providers/codex/permissions';
import {
  codexEvidenceStatus,
  createCodexLocalAdapter,
  createStdioCodexTransport,
  type CodexTransport,
} from '../src/providers/codex/adapter';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '..', '..', '..');

const goldenDocument = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'fixtures', 'golden', 'document.json'), 'utf8'),
) as AnnotationDocument;
const goldenOntology = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'fixtures', 'golden', 'ontology.json'), 'utf8'),
) as OntologyVersion;
// Public T20 fixture: a strict-schema-and-domain valid candidate draft for the
// golden document/ontology. Reused unchanged (task card: use shared fixtures).
const VALID_DRAFT = (
  JSON.parse(
    readFileSync(join(testDir, 'fixtures', 'http', 'candidate-valid.json'), 'utf8'),
  ) as { wire: unknown }
).wire;

const FULL_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);
const IDENTITY_TRANSFORM = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const RUN_CONTEXT: RunContext = {
  project_id: 'project_golden',
  asset_revision_id: 'asset_revision_golden',
  annotation_revision_id: 'annotation_rev_golden',
  ontology_version_id: 'ontology_v1',
  draft_generation: 8,
  canonical_sha256: 'c'.repeat(64),
  selected_object_ids: ['object_person_001'],
  object_hashes: { object_person_001: 'h1' },
  input_fingerprint: 'sha-t22-input-1',
};

const RUN_TOKEN = 'wlr-t22-run-token-0123456789';

function startRunRequest(overrides: Partial<StartRunRequest> = {}): StartRunRequest {
  return {
    operation_id: 'operation_t22_1',
    profile_id: 'profile_codex_t22',
    context: RUN_CONTEXT,
    intent: 'audit_attributes',
    prompt: 'Audit helmet_state for the selected person.',
    consent_id: 'consent_t22_1',
    ...overrides,
  };
}

interface FakeRuntimeContext extends RuntimeContext {
  approved_grant_ids: string[];
  reads: Array<{ grant_id: string; region: BBox | null }>;
  submitted: unknown[];
  reported_issues: unknown[];
}

function makeContext(runContext: RunContext = RUN_CONTEXT): FakeRuntimeContext {
  const reads: Array<{ grant_id: string; region: BBox | null }> = [];
  const submitted: unknown[] = [];
  const reported_issues: unknown[] = [];
  return {
    run_id: 'run_t22_001',
    approved_grant_ids: ['grant_t22_1'],
    reads,
    submitted,
    reported_issues,
    async read_region(grant_id: string, region: BBox | null): Promise<RuntimeReadRegion> {
      reads.push({ grant_id, region });
      return { bytes: FULL_BYTES, mime: 'image/png', transform_to_canonical: IDENTITY_TRANSFORM };
    },
    async get_document(): Promise<AnnotationDocument> {
      return goldenDocument;
    },
    async get_ontology(): Promise<OntologyVersion> {
      return goldenOntology;
    },
    async submit_candidates(candidate: unknown): Promise<SuggestionSet> {
      submitted.push(candidate);
      return {
        suggestion_set_id: 'suggestion_set_t22_1',
        model_run_id: 'model_run_t22_1',
        prediction_id: 'prediction_t22_1',
        // The server binds candidates to the run's original context (C4).
        context: runContext,
        changes: [],
        issues: [],
        score: null,
        state: 'pending',
      };
    },
    async report_issues(issues: unknown): Promise<void> {
      reported_issues.push(issues);
    },
  };
}

async function collectRun(
  adapter: ProviderAdapter,
  input: StartRunRequest,
  ctx: RuntimeContext,
  signal?: AbortSignal,
): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  const controller = signal === undefined ? new AbortController() : null;
  for await (const event of adapter.run(input, ctx, signal ?? controller!.signal)) {
    events.push(event);
  }
  return events;
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

interface ScriptedTransport extends CodexTransport {
  readonly sent: string[];
  push(line: string): void;
  finish(): void;
  /** Resolves once a line containing `match` has actually been sent. */
  awaitSend(match: string): Promise<void>;
}

function makeScriptedTransport(onSend?: (line: string, self: ScriptedTransport) => void): ScriptedTransport {
  const sent: string[] = [];
  const pending: string[] = [];
  const waiters: Array<() => void> = [];
  const sendWaiters: Array<{ match: string; settle: () => void }> = [];
  let ended = false;
  const wake = (): void => {
    while (waiters.length > 0) waiters.shift()!();
  };
  const self: ScriptedTransport = {
    sent,
    send(line: string): void {
      sent.push(line);
      onSend?.(line, self);
      for (const waiter of [...sendWaiters]) {
        if (line.includes(waiter.match)) {
          sendWaiters.splice(sendWaiters.indexOf(waiter), 1);
          waiter.settle();
        }
      }
    },
    push(line: string): void {
      pending.push(line);
      wake();
    },
    finish(): void {
      ended = true;
      wake();
    },
    awaitSend(match: string): Promise<void> {
      if (sent.some((line) => line.includes(match))) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      sendWaiters.push({ match, settle: resolve });
      return promise;
    },
    async *messages(): AsyncIterable<string> {
      for (;;) {
        while (pending.length > 0) yield pending.shift()!;
        if (ended) return;
        const { promise, resolve } = Promise.withResolvers<void>();
        waiters.push(resolve);
        await promise;
      }
    },
    async close(): Promise<void> {
      ended = true;
      wake();
    },
  };
  return self;
}

function wireOf(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

/** The scripted "runtime" answers requests like a minimal app-server peer. */
interface ScriptedServerOptions {
  initResult?: unknown;
  initError?: { code: number; message: string; data?: unknown };
  threadResult?: unknown;
  turnResult?: unknown;
  turnError?: { code: number; message: string; data?: unknown };
  /** Emitted right after the turn/start response. */
  turnEvents?: string[];
  interruptResult?: unknown;
}

function scriptedServer(options: ScriptedServerOptions = {}): (line: string, self: ScriptedTransport) => void {
  return (line, self) => {
    const message = wireOf(line);
    const id = message.id;
    const method = message.method;
    if (id === undefined) return; // notifications need no reply
    if (method === INITIALIZE_METHOD) {
      if (options.initError !== undefined) {
        self.push(JSON.stringify({ id, error: options.initError }));
      } else {
        self.push(
          JSON.stringify({
            id,
            result: options.initResult ?? {
              authenticated: true,
              models: ['synthetic-model'],
              runtime_version: '0.0.0-synthetic',
            },
          }),
        );
      }
      return;
    }
    if (method === THREAD_START_METHOD) {
      self.push(JSON.stringify({ id, result: options.threadResult ?? { thread_id: 'thread-synthetic-1' } }));
      return;
    }
    if (method === TURN_START_METHOD) {
      if (options.turnError !== undefined) {
        self.push(JSON.stringify({ id, error: options.turnError }));
        return;
      }
      self.push(JSON.stringify({ id, result: options.turnResult ?? { turn_id: 'turn-synthetic-1' } }));
      for (const event of options.turnEvents ?? []) self.push(event);
      return;
    }
    if (method === TURN_INTERRUPT_METHOD) {
      self.push(
        JSON.stringify({
          id,
          result: options.interruptResult ?? { turn_id: 'turn-synthetic-1', status: 'interrupted' },
        }),
      );
      return;
    }
    self.push(JSON.stringify({ id, error: { code: -32601, message: 'scripted peer: unknown method', data: null } }));
  };
}

function turnEvent(params: Record<string, unknown>, method = 'turn/updated'): string {
  return JSON.stringify({ method, params: { turn_id: 'turn-synthetic-1', thread_id: 'thread-synthetic-1', ...params } });
}

function permissionsConfig(overrides: Partial<CodexPermissionsConfig> = {}): CodexPermissionsConfig {
  return {
    command: { executable: process.execPath, argv: ['--version'] },
    mcpCommand: { executable: process.execPath, argv: [join(repoRoot, 'apps', 'agent-host', 'src', 'mcp', 'main.ts')] },
    runRoot: makeTempDir('t22-runroot-'),
    forbiddenCwdRoots: [],
    envAllowlist: ['PATH', 'SystemRoot', 'PATHEXT'],
    source_env: { PATH: 'C:\\synthetic-path', SystemRoot: 'C:\\Windows', PATHEXT: '.EXE', MY_SECRET_TOKEN_X: 'nope' },
    ...overrides,
  };
}

function adapterWith(
  transport: (plan: CodexLaunchPlan) => CodexTransport,
  options: Partial<Parameters<typeof createCodexLocalAdapter>[0]> = {},
): ProviderAdapter {
  return createCodexLocalAdapter({
    transport,
    imageSource: () => ({ grant_id: 'grant_t22_1' as Id, region: null }),
    runToken: () => RUN_TOKEN,
    ...options,
    permissions: options.permissions ?? permissionsConfig(),
  });
}

// ---------------------------------------------------------------------------
// classifyCodexState (task card snippet)
// ---------------------------------------------------------------------------

it('does not classify missing auth as an available model', () => {
  const state = classifyCodexState({ authenticated: false, models: [] });
  expect(state.availability).toBe('needs_login');
  expect(state.verification).not.toBe('live_passed');
});

it('maps authenticated runtime states without ever claiming live verification', () => {
  const ready = classifyCodexState({ authenticated: true, models: ['synthetic-model'] });
  expect(ready.availability).toBe('ready');
  expect(ready.verification).toBe('not_run');
  const noModel = classifyCodexState({ authenticated: true, models: [] });
  expect(noModel.availability).toBe('needs_configuration');
  expect(noModel.verification).toBe('not_run');
  // Unauthenticated always wins, even when a model list is present.
  const expired = classifyCodexState({ authenticated: false, models: ['synthetic-model'] });
  expect(expired.availability).toBe('needs_login');
});

// ---------------------------------------------------------------------------
// probe() honesty
// ---------------------------------------------------------------------------

it('reports needs_configuration and never starts a transport when the Codex CLI is absent', async () => {
  let transportStarted = 0;
  const config = permissionsConfig({
    command: { executable: join(makeTempDir('t22-nocli-'), 'codex.exe'), argv: ['app-server'] },
  });
  const adapter = createCodexLocalAdapter({
    permissions: config,
    transport: () => {
      transportStarted += 1;
      return makeScriptedTransport();
    },
    imageSource: () => ({ grant_id: 'grant_t22_1', region: null }),
    runToken: () => RUN_TOKEN,
    schemaArtifactPath: join(makeTempDir('t22-schema-'), 'schema.json'),
  });
  const profiles = await adapter.probe();
  expect(profiles.length).toBe(1);
  expect(profiles[0]).toMatchObject({
    profile_id: 'codex_local',
    provider_id: 'codex_local',
    auth_kind: 'official_user_login',
    availability: 'needs_configuration',
    verification: 'not_run',
    runtime_version: null,
  });
  expect(transportStarted).toBe(0);
});

it('is blocked without the CLI-generated schema artifact even when the CLI resolves', async () => {
  let transportStarted = 0;
  const adapter = createCodexLocalAdapter({
    permissions: permissionsConfig(),
    transport: () => {
      transportStarted += 1;
      return makeScriptedTransport();
    },
    imageSource: () => ({ grant_id: 'grant_t22_1', region: null }),
    runToken: () => RUN_TOKEN,
    schemaArtifactPath: null,
  });
  const profiles = await adapter.probe();
  expect(profiles[0].availability).toBe('blocked');
  expect(profiles[0].verification).toBe('not_run');
  expect(transportStarted).toBe(0);
});

it('reports needs_login from the runtime handshake and never claims live verification', async () => {
  // SYNTHETIC transcript over real stdio: the fake CLI below is hand-written
  // test scaffolding, not Codex CLI output (T32 must rerun against the real CLI).
  const harness = makeTempDir('t22-probecli-');
  const fakeCli = join(harness, 'fake-cli.mjs');
  writeFileSync(
    fakeCli,
    [
      "import { createInterface } from 'node:readline';",
      "const rl = createInterface({ input: process.stdin });",
      "rl.on('line', (line) => {",
      "  let message; try { message = JSON.parse(line); } catch { return; }",
      "  if (message.method === 'initialize') {",
      "    process.stdout.write(JSON.stringify({ id: message.id, result: { authenticated: false, models: [] } }) + '\\n');",
      '  }',
      '});',
    ].join('\n'),
  );
  const schemaPath = join(harness, 'schema.json');
  writeFileSync(schemaPath, '{}');
  const adapter = createCodexLocalAdapter({
    permissions: permissionsConfig({
      command: { executable: process.execPath, argv: [fakeCli] },
    }),
    transport: createStdioCodexTransport,
    imageSource: () => ({ grant_id: 'grant_t22_1', region: null }),
    runToken: () => RUN_TOKEN,
    schemaArtifactPath: schemaPath,
    probeTimeoutMs: 15_000,
  });
  const profiles = await adapter.probe();
  expect(profiles[0].availability).toBe('needs_login');
  expect(profiles[0].verification).toBe('not_run');
  expect(profiles[0].runtime_version).toBe(null);
  rmSync(harness, { recursive: true, force: true });
}, 30_000);

// ---------------------------------------------------------------------------
// protocol: the pinned initialize/threads/turns schema
// ---------------------------------------------------------------------------

it('parses the pinned initialize/threads/turns schema with the documented JSONL wire shape', () => {
  // The documented wire omits the `jsonrpc` header; it is accepted when present.
  const initialize = parseCodexLine(JSON.stringify({ id: 'codex-req-1', method: INITIALIZE_METHOD, params: {} }));
  expect(initialize).toMatchObject({ kind: 'request', method: INITIALIZE_METHOD });
  const initialized = parseCodexLine(JSON.stringify({ method: INITIALIZED_METHOD, params: {} }));
  expect(initialized).toMatchObject({ kind: 'notification', method: INITIALIZED_METHOD });
  const threadResponse = parseCodexLine(JSON.stringify({ id: 'codex-req-2', result: { thread_id: 'thread-synthetic-1' } }));
  expect(threadResponse).toMatchObject({ kind: 'response' });
  const turnEventMessage = parseCodexLine(turnEvent({ status: 'in_progress' })) as CodexMessage;
  expect(turnEventMessage).toMatchObject({ kind: 'notification' });
  const item = parseCodexLine(turnEvent({}, 'item/completed'));
  expect(item).toMatchObject({ kind: 'notification', method: 'item/completed' });
  const interruptResponse = parseCodexLine(
    JSON.stringify({ id: 'codex-req-3', result: { turn_id: 'turn-synthetic-1', status: 'interrupted' } }),
  );
  expect(interruptResponse).toMatchObject({ kind: 'response' });
  const withHeader = parseCodexLine(JSON.stringify({ jsonrpc: '2.0', id: 7, method: INITIALIZE_METHOD, params: {} }));
  expect(withHeader).toMatchObject({ kind: 'request' });
  // Errors are parsed as structured JSON-RPC error objects.
  const error = parseCodexLine(JSON.stringify({ id: 'codex-req-4', error: { code: -32000, message: 'synthetic failure', data: { state: 'insufficient_quota' } } }));
  expect(error).toMatchObject({ kind: 'response' });
  // Outgoing requests follow the same pinned shape (no jsonrpc header).
  const outgoing = wireOf(serializeCodexRequest('codex-req-5', TURN_START_METHOD, { thread_id: 't1', prompt: 'p', images: [] }));
  expect(outgoing).toEqual({ id: 'codex-req-5', method: TURN_START_METHOD, params: { thread_id: 't1', prompt: 'p', images: [] } });
  expect(wireOf(serializeCodexNotification(INITIALIZED_METHOD, {}))).toEqual({ method: INITIALIZED_METHOD, params: {} });
});

it('rejects malformed, oversized and semantically invalid messages with controlled protocol errors', () => {
  const bad = (line: string): string => {
    try {
      parseCodexLine(line);
    } catch (error) {
      return (error as { code: string }).code;
    }
    throw new Error(`expected a controlled protocol error for ${line.slice(0, 40)}`);
  };
  expect(bad('{not json')).toBe('invalid_json');
  expect(bad('[1,2,3]')).toBe('invalid_envelope');
  expect(bad(JSON.stringify({ id: 1, result: {}, error: { code: 1, message: 'x' } }))).toBe('invalid_envelope');
  expect(bad(JSON.stringify({ result: {} }))).toBe('invalid_envelope');
  expect(bad(JSON.stringify({ method: 'initialized', id: 3, params: {} }))).toBe('invalid_envelope');
  expect(bad(JSON.stringify({ id: 1, method: 'initialize', params: {}, extra_field: 1 }))).toBe('invalid_envelope');
  expect(bad(JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'initialize', params: {} }))).toBe('invalid_envelope');
  expect(bad(JSON.stringify({ id: 1, error: { message: 'no code' } }))).toBe('invalid_envelope');
  expect(bad('x'.repeat(5 * 1024 * 1024))).toBe('message_too_large');
});

it('enforces the documented single-initialize handshake and forbids out-of-sandbox methods', () => {
  let state = newCodexSession();
  expect(canSendRequest(state, THREAD_START_METHOD)).toBe(false);
  state = beginInitialize(state);
  expect(canSendRequest(state, INITIALIZE_METHOD)).toBe(false); // repeated initialization is rejected
  state = beginInitialize(state);
  expect(state.violations).toContain('duplicate_initialize');
  state = foldCodexMessage(
    state,
    parseCodexLine(JSON.stringify({ id: 'codex-req-1', result: { authenticated: true, models: ['m'] } })),
  );
  // Other requests are rejected until the handshake completes with `initialized`.
  expect(canSendRequest(state, THREAD_START_METHOD)).toBe(false);
  state = markInitialized(state);
  expect(state.phase).toBe('ready');
  expect(canSendRequest(state, THREAD_START_METHOD)).toBe(true);
  // Documented out-of-sandbox methods are never sendable, in any phase.
  // Partial fixture: only the permit list is exercised here.
  const interruptOnlyPlan = {
    permittedMethods: [TURN_INTERRUPT_METHOD],
  } as unknown as CodexLaunchPlan;
  for (const method of FORBIDDEN_METHODS) {
    expect(canSendRequest(state, method)).toBe(false);
    expect(isMethodPermitted(interruptOnlyPlan, method)).toBe(false);
  }
  // A second initialize response is a protocol violation and changes nothing.
  const before = state.runtime;
  state = foldCodexMessage(
    state,
    parseCodexLine(JSON.stringify({ id: 'codex-req-9', result: { authenticated: true, models: ['other'] } })),
  );
  expect(state.violations).toContain('duplicate_initialize');
  expect(state.runtime).toBe(before);
});

// ---------------------------------------------------------------------------
// session robustness
// ---------------------------------------------------------------------------

it('unexpected notifications and out-of-order events never corrupt session state or billing', () => {
  let state = newCodexSession();
  state = foldCodexMessage(state, parseCodexLine(JSON.stringify({ id: 1, result: { authenticated: true, models: ['m'] } })));
  state = foldCodexMessage(state, parseCodexLine(turnEvent({ status: 'in_progress' })));
  state = foldCodexMessage(state, parseCodexLine(turnEvent({ usage: { input_tokens: 10, output_tokens: 5 }, status: 'completed', proposals: [VALID_DRAFT] })));
  const snapshot = JSON.stringify({
    threads: [...state.threads.values()],
    turns: [...state.turns.values()],
    runtime: state.runtime,
  });
  const beforeTotals = billingTotals(state);

  // Hostile noise: unknown methods, malformed params, out-of-order items,
  // duplicate usage-bearing events, oversized unknown fields, unknown ids.
  const noise = [
    JSON.stringify({ method: 'future/unknown', params: { anything: 1 } }),
    JSON.stringify({ method: 'turn/updated', params: { status: 'completed' } }), // no turn_id
    JSON.stringify({ method: 'turn/updated', params: { turn_id: 42, status: 'completed', usage: { input_tokens: 99 } } }),
    JSON.stringify({ method: 'item/completed', params: { turn_id: 'turn-unknown', junk: 'x'.repeat(1024) } }),
    JSON.stringify({ method: 'turn/updated', params: { turn_id: 'turn-synthetic-1', status: 'bogus', usage: { input_tokens: 777777 } } }),
    JSON.stringify({ method: 'thread/updated', params: {} }),
    JSON.stringify({ id: 999, result: { turn_id: 'turn-synthetic-1', status: 'completed', usage: { input_tokens: 888888 } } }),
    JSON.stringify({ method: 'process/spawn', params: { turn_id: 'turn-synthetic-1', cmd: 'rm -rf /' } }),
    JSON.stringify({ method: 'thread/shellCommand', params: { turn_id: 'turn-synthetic-1' } }),
  ];
  for (const line of noise) state = foldCodexMessage(state, parseCodexLine(line));

  expect(
    JSON.stringify({
      threads: [...state.threads.values()],
      turns: [...state.turns.values()],
      runtime: state.runtime,
    }),
  ).toBe(snapshot);
  expect(billingTotals(state)).toEqual(beforeTotals);
  expect(beforeTotals.input_tokens).toBe(10);
  expect(state.ignored_events).toBeGreaterThan(0);
  expect(state.violations).toEqual([]);
});

it('classifies the four unavailable states distinctly and never fabricates candidates', async () => {
  // SYNTHETIC transcripts: state markers come from the project-pinned
  // `error.data.state` contract (docs/providers/codex.md); the real CLI's
  // error schema must be re-derived in T32.
  const scenarios: Array<{ name: string; script: ScriptedServerOptions; expected: string }> = [
    {
      name: 'no-login',
      script: { initResult: { authenticated: false, models: [] } },
      expected: 'needs_login',
    },
    {
      name: 'model-unavailable',
      script: { initResult: { authenticated: true, models: [] } },
      expected: 'model_unavailable',
    },
    {
      name: 'insufficient-quota',
      script: { turnError: { code: -32000, message: 'quota exhausted', data: { state: 'insufficient_quota' } } },
      expected: 'insufficient_quota',
    },
    {
      name: 'approval-required',
      script: { turnError: { code: -32000, message: 'approval needed', data: { state: 'approval_required' } } },
      expected: 'approval_required',
    },
  ];
  const seen = new Set<string>();
  for (const scenario of scenarios) {
    const transport = makeScriptedTransport(scriptedServer(scenario.script));
    const adapter = adapterWith(() => transport);
    const ctx = makeContext();
    const events = await collectRun(adapter, startRunRequest(), ctx);
    const terminal = events.at(-1)!;
    expect(terminal.type, scenario.name).toBe('failed');
    expect(terminal.data?.reason, scenario.name).toBe(scenario.expected);
    expect(terminal.data?.error_code, scenario.name).toBe(scenario.expected);
    expect(ctx.submitted, scenario.name).toEqual([]);
    expect(events.filter((event) => event.type === 'candidate'), scenario.name).toEqual([]);
    seen.add(String(terminal.data?.reason));
  }
  expect(seen.size).toBe(4);
  // classifyUnavailable is the shared marker table used by the run loop.
  expect(classifyUnavailable({ code: -32000, message: 'x', data: { state: 'approval_required' } })).toBe('approval_required');
  expect(classifyUnavailable({ code: -32000, message: 'x', data: { state: 'unknown_future_state' } })).toBe(null);
  expect(classifyUnavailable({ code: -32603, message: 'boom', data: null })).toBe(null);
});

// ---------------------------------------------------------------------------
// permissions: MCP surface, cwd isolation, minimal env
// ---------------------------------------------------------------------------

it('attaches only this project MCP server and the five permitted tools', () => {
  const config = permissionsConfig();
  const plan = buildLaunchPlan(config, { run_id: 'run_t22_001', runToken: RUN_TOKEN, apiBase: 'http://127.0.0.1:48100' });
  expect(plan.mcpServers.length).toBe(1);
  expect(plan.mcpServers[0]).toMatchObject({
    name: MCP_SERVER_NAME,
    command: config.mcpCommand.executable,
  });
  expect(plan.mcpServers[0].argv).toEqual(config.mcpCommand.argv);
  expect(Object.keys(plan.mcpServers[0].env).sort()).toEqual(['WEBLABEL_API_BASE', 'WEBLABEL_RUN_TOKEN']);
  expect(plan.permittedTools).toEqual([...TOOL_NAMES]);
  for (const tool of plan.permittedTools) {
    expect(tool).not.toMatch(/shell|exec|edit|write|delete|patch/i);
  }
  expect(plan.experimentalApi).toBe(false);
  expect(plan.permittedMethods).not.toContain('thread/shellCommand');
  expect(plan.permittedMethods).not.toContain('process/spawn');
  expect(isMethodPermitted(plan, TURN_INTERRUPT_METHOD)).toBe(true);
  expect(isMethodPermitted(plan, TURN_START_METHOD)).toBe(true);
  expect(isMethodPermitted(plan, 'process/spawn')).toBe(false);
  expect(isMethodPermitted(plan, 'thread/shellCommand')).toBe(false);
  expect(isMethodPermitted(plan, 'thread/anything-else')).toBe(false);
});

it('keeps the run cwd out of the user repository and fails closed on forbidden roots', () => {
  const userRepo = makeTempDir('t22-userrepo-');
  const runRoot = makeTempDir('t22-isolated-');
  const config = permissionsConfig({ runRoot, forbiddenCwdRoots: [userRepo] });
  const cwd = resolveRunCwd(config, 'run_t22_001');
  expect(cwd.startsWith(resolve(runRoot))).toBe(true);
  expect(cwd.startsWith(resolve(userRepo))).toBe(false);
  const plan = buildLaunchPlan(config, { run_id: 'run_t22_001', runToken: RUN_TOKEN, apiBase: 'http://127.0.0.1:48100' });
  expect(plan.cwd).toBe(cwd);

  expect(() =>
    buildLaunchPlan(permissionsConfig({ runRoot: userRepo, forbiddenCwdRoots: [userRepo] }), {
      run_id: 'run_t22_001',
      runToken: RUN_TOKEN,
      apiBase: 'http://127.0.0.1:48100',
    }),
  ).toThrow(CodexPermissionError);
  try {
    buildLaunchPlan(permissionsConfig({ runRoot: userRepo, forbiddenCwdRoots: [userRepo] }), {
      run_id: 'run_t22_001',
      runToken: RUN_TOKEN,
      apiBase: 'http://127.0.0.1:48100',
    });
  } catch (error) {
    expect((error as CodexPermissionError).code).toBe('cwd_forbidden');
  }
  expect(() =>
    buildLaunchPlan(config, { run_id: '..\\escape', runToken: RUN_TOKEN, apiBase: 'http://127.0.0.1:48100' }),
  ).toThrow(/run_id_invalid/);
});

it('injects only the minimal allowlisted environment and keeps the run token out of argv', () => {
  const config = permissionsConfig();
  const plan = buildLaunchPlan(config, { run_id: 'run_t22_001', runToken: RUN_TOKEN, apiBase: 'http://127.0.0.1:48100' });
  expect(plan.env.MY_SECRET_TOKEN_X).toBeUndefined();
  expect(plan.env.WEBLABEL_RUN_TOKEN).toBeUndefined();
  expect(() => buildLaunchPlan({...config, envAllowlist: ['weblabel_run_token']}, {run_id: 'run_t22_001', runToken: RUN_TOKEN, apiBase: 'http://127.0.0.1:48100'})).toThrow(/env_denied/);
  expect(JSON.stringify([plan.command.argv, plan.mcpServers[0].argv])).not.toContain(RUN_TOKEN);
  expect(plan.mcpServers[0].env.WEBLABEL_RUN_TOKEN).toBe(RUN_TOKEN);

  // A token smuggled into argv is refused, and plugin-loading vectors (e.g.
  // NODE_OPTIONS) can never be allowlisted.
  expect(() =>
    buildLaunchPlan(permissionsConfig({ command: { executable: 'x', argv: [RUN_TOKEN] } }), {
      run_id: 'run_t22_001',
      runToken: RUN_TOKEN,
      apiBase: 'http://127.0.0.1:48100',
    }),
  ).toThrow(/token_in_argv/);
  expect(() =>
    buildLaunchPlan(permissionsConfig({ envAllowlist: ['PATH', 'NODE_OPTIONS'] }), {
      run_id: 'run_t22_001',
      runToken: RUN_TOKEN,
      apiBase: 'http://127.0.0.1:48100',
    }),
  ).toThrow(/env_denied/);
});

// ---------------------------------------------------------------------------
// consent and image egress
// ---------------------------------------------------------------------------

it('refuses to start or read any image without a consent record', async () => {
  let transportStarted = 0;
  let grantsRead = 0;
  const adapter = createCodexLocalAdapter({
    permissions: permissionsConfig(),
    transport: () => {
      transportStarted += 1;
      return makeScriptedTransport();
    },
    imageSource: () => {
      grantsRead += 1;
      return { grant_id: 'grant_t22_1', region: null };
    },
    runToken: () => RUN_TOKEN,
    schemaArtifactPath: null,
  });
  const ctx = makeContext();
  const events = await collectRun(adapter, startRunRequest({ consent_id: null }), ctx);
  const terminal = events.at(-1)!;
  expect(terminal.type).toBe('failed');
  expect(terminal.data?.error_code).toBe('consent_required');
  expect(ctx.reads).toEqual([]);
  expect(ctx.submitted).toEqual([]);
  expect(transportStarted).toBe(0);
  expect(grantsRead).toBe(0);
});

it('stages approved-grant bytes in the private run cwd and references the documented localImage form', async () => {
  const config = permissionsConfig();
  const transport = makeScriptedTransport(
    scriptedServer({
      turnEvents: [turnEvent({ status: 'completed', usage: { input_tokens: 1, output_tokens: 1 }, proposals: [VALID_DRAFT] })],
    }),
  );
  const adapter = adapterWith(() => transport, { permissions: config });
  const ctx = makeContext();
  const events = await collectRun(adapter, startRunRequest(), ctx);
  expect(events.at(-1)!.type).toBe('succeeded');
  expect(ctx.reads).toEqual([{ grant_id: 'grant_t22_1', region: null }]);
  const turnMessage = wireOf(transport.sent.find((line) => line.includes(`"${TURN_START_METHOD}"`))!);
  const params = turnMessage.params as { images: Array<{ type: string; path: string }> };
  expect(params.images.length).toBe(1);
  expect(params.images[0].type).toBe('localImage');
  expect(params.images[0].path.startsWith(resolveRunCwd(config, ctx.run_id))).toBe(true);
  expect(Array.from(readFileSync(params.images[0].path))).toEqual(Array.from(FULL_BYTES));
});

// ---------------------------------------------------------------------------
// run loop, candidates and lifecycle
// ---------------------------------------------------------------------------

it('runs a synthetic turn end to end and submits candidates carrying the original run context', async () => {
  const transport = makeScriptedTransport(
    scriptedServer({
      turnEvents: [
        turnEvent({ status: 'in_progress' }),
        turnEvent({}, 'item/completed'),
        turnEvent({ status: 'completed', usage: { input_tokens: 1200, output_tokens: 300 }, proposals: [VALID_DRAFT] }),
      ],
    }),
  );
  const adapter = adapterWith(() => transport);
  const ctx = makeContext();
  const events = await collectRun(adapter, startRunRequest(), ctx);
  expect(events.map((event) => event.type)).toEqual(['started', 'progress', 'candidate', 'succeeded']);
  expect(ctx.submitted.length).toBe(1);
  const candidateEvent = events.find((event) => event.type === 'candidate')!;
  expect(candidateEvent.data?.context).toEqual(RUN_CONTEXT);
  const succeeded = events.at(-1)!;
  expect(succeeded.data?.usage).toEqual({ input_tokens: 1200, output_tokens: 300, cost_usd: null });
  expect(succeeded.data?.cost_display).toBe('unknown');
});

it('keeps empty usage unknown and computes cost only from explicit pricing', async () => {
  const withoutUsage = makeScriptedTransport(
    scriptedServer({ turnEvents: [turnEvent({ status: 'completed', proposals: [VALID_DRAFT] })] }),
  );
  const events = await collectRun(adapterWith(() => withoutUsage), startRunRequest(), makeContext());
  const succeeded = events.at(-1)!;
  expect(succeeded.data?.usage).toEqual({ input_tokens: null, output_tokens: null, cost_usd: null });
  expect(succeeded.data?.cost_display).toBe('unknown');
  expect(JSON.stringify(succeeded.data)).not.toMatch(/"cost_usd":0|"input_tokens":0|"output_tokens":0/);

  const priced = makeScriptedTransport(
    scriptedServer({
      turnEvents: [turnEvent({ status: 'completed', usage: { input_tokens: 1200, output_tokens: 300 }, proposals: [VALID_DRAFT] })],
    }),
  );
  const pricedEvents = await collectRun(
    adapterWith(() => priced, { pricing: { input_per_million_usd: 2, output_per_million_usd: 8 } }),
    startRunRequest(),
    makeContext(),
  );
  const pricedSuccess = pricedEvents.at(-1)!;
  expect(pricedSuccess.data?.cost_display).toBe('known');
  expect(pricedSuccess.data?.usage).toMatchObject({ input_tokens: 1200, output_tokens: 300, cost_usd: 0.0048 });
});

it('never double-bills duplicated, out-of-order or replayed terminal events', async () => {
  const transport = makeScriptedTransport(
    scriptedServer({
      // Out-of-order: a terminal-ish update arrives before the started event,
      // the terminal payload is replayed, and a late usage event follows.
      turnEvents: [
        turnEvent({ status: 'completed', usage: { input_tokens: 1200, output_tokens: 300 }, proposals: [VALID_DRAFT] }),
        turnEvent({ status: 'in_progress' }),
        turnEvent({ status: 'completed', usage: { input_tokens: 1200, output_tokens: 300 }, proposals: [VALID_DRAFT] }),
        turnEvent({ status: 'completed', usage: { input_tokens: 1200, output_tokens: 300 } }),
      ],
    }),
  );
  const adapter = adapterWith(() => transport);
  const ctx = makeContext();
  const events = await collectRun(adapter, startRunRequest(), ctx);
  const terminals = events.filter((event) => ['succeeded', 'failed', 'cancelled'].includes(event.type));
  expect(terminals.length).toBe(1);
  expect(terminals[0].type).toBe('succeeded');
  expect(terminals[0].data?.usage).toEqual({ input_tokens: 1200, output_tokens: 300, cost_usd: null });
  expect(ctx.submitted.length).toBe(1);
});

it('replayed responses never re-run the handshake or start a second turn', async () => {
  const transport = makeScriptedTransport(scriptedServer());
  const adapter = adapterWith(() => transport);
  const ctx = makeContext();
  const run = collectRun(adapter, startRunRequest(), ctx);
  await transport.awaitSend(`"${TURN_START_METHOD}"`);
  const initLine = transport.sent.find((line) => line.includes(`"${INITIALIZE_METHOD}"`))!;
  const threadLine = transport.sent.find((line) => line.includes(`"${THREAD_START_METHOD}"`))!;
  const turnLine = transport.sent.find((line) => line.includes(`"${TURN_START_METHOD}"`))!;
  // Replay every already-answered response with its original id: none of these
  // may re-send initialized/thread/start/turn/start (that would bill again).
  transport.push(
    JSON.stringify({
      id: wireOf(initLine).id,
      result: { authenticated: true, models: ['synthetic-model'], runtime_version: '0.0.0-synthetic' },
    }),
  );
  transport.push(JSON.stringify({ id: wireOf(threadLine).id, result: { thread_id: 'thread-synthetic-1' } }));
  transport.push(JSON.stringify({ id: wireOf(turnLine).id, result: { turn_id: 'turn-synthetic-1' } }));
  transport.push(turnEvent({ status: 'completed', usage: { input_tokens: 5, output_tokens: 7 } }));
  transport.finish();
  const events = await run;
  expect(events.filter((event) => event.type === 'succeeded').length).toBe(1);
  const sentCount = (method: string): number =>
    transport.sent.filter((line) => line.includes(`"${method}"`)).length;
  expect(sentCount(INITIALIZE_METHOD)).toBe(1);
  expect(sentCount(THREAD_START_METHOD)).toBe(1);
  expect(sentCount(TURN_START_METHOD)).toBe(1);
  expect(events.at(-1)!.data?.usage).toEqual({ input_tokens: 5, output_tokens: 7, cost_usd: null });
});

it('foreign turn events never end the run and never leak usage into its billing', async () => {
  const transport = makeScriptedTransport(
    scriptedServer({
      turnEvents: [
        turnEvent({
          turn_id: 'foreign-turn-9',
          status: 'completed',
          usage: { input_tokens: 999, output_tokens: 999 },
        }),
        turnEvent({ status: 'completed', usage: { input_tokens: 5, output_tokens: 7 } }),
      ],
    }),
  );
  const events = await collectRun(adapterWith(() => transport), startRunRequest(), makeContext());
  const terminals = events.filter((event) => ['succeeded', 'failed', 'cancelled'].includes(event.type));
  expect(terminals.length).toBe(1);
  expect(terminals[0].type).toBe('succeeded');
  // The foreign turn's usage is ignored, not folded into this run's totals.
  expect(terminals[0].data?.usage).toEqual({ input_tokens: 5, output_tokens: 7, cost_usd: null });
});

it('proposals seen before the terminal event are still submitted exactly once', async () => {
  const transport = makeScriptedTransport(
    scriptedServer({
      turnEvents: [
        turnEvent({ proposals: [VALID_DRAFT] }, 'item/completed'),
        turnEvent({ status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } }),
      ],
    }),
  );
  const ctx = makeContext();
  const events = await collectRun(adapterWith(() => transport), startRunRequest(), ctx);
  expect(events.at(-1)!.type).toBe('succeeded');
  expect(ctx.submitted.length).toBe(1);
  expect(events.filter((event) => event.type === 'candidate').length).toBe(1);
});

it('surfaces a mid-turn disconnect as a controlled failure without fabricating candidates', async () => {
  const transport = makeScriptedTransport(scriptedServer({ turnEvents: [turnEvent({ status: 'in_progress' })] }));
  const adapter = adapterWith(() => transport);
  const ctx = makeContext();
  const run = collectRun(adapter, startRunRequest(), ctx);
  await transport.awaitSend(`"${TURN_START_METHOD}"`);
  transport.finish(); // the runtime dies / the pipe drops
  const events = await run;
  const terminal = events.at(-1)!;
  expect(terminal.type).toBe('failed');
  expect(terminal.data?.error_code).toBe('codex_disconnected');
  expect(terminal.data?.usage).toEqual({ input_tokens: null, output_tokens: null, cost_usd: null });
  expect(ctx.submitted).toEqual([]);
  expect(events.filter((event) => event.type === 'candidate')).toEqual([]);
});

it('cancels via turn/interrupt and never claims a refund for possibly incurred cost', async () => {
  const transport = makeScriptedTransport(scriptedServer({ turnEvents: [turnEvent({ status: 'in_progress' })] }));
  const adapter = adapterWith(() => transport);
  const ctx = makeContext();
  const controller = new AbortController();
  const run = collectRun(adapter, startRunRequest(), ctx, controller.signal);
  await transport.awaitSend(`"${TURN_START_METHOD}"`);
  controller.abort();
  await transport.awaitSend(`"${TURN_INTERRUPT_METHOD}"`);
  const events = await run;
  const terminals = events.filter((event) => ['succeeded', 'failed', 'cancelled'].includes(event.type));
  expect(terminals.length).toBe(1);
  expect(terminals[0].type).toBe('cancelled');
  expect(terminals[0].data?.billing).toBe('may_have_cost');
  expect(terminals[0].data?.cost_display).toBe('unknown');
  expect(JSON.stringify(events)).not.toMatch(/refund/i);
  expect(JSON.stringify(terminals[0].data)).not.toMatch(/"cost_usd":0|"input_tokens":0/);
});

it('submits late candidates after cancellation with the original run context', async () => {
  const transport = makeScriptedTransport(
    scriptedServer({
      turnEvents: [turnEvent({ status: 'in_progress' })],
      interruptResult: {
        turn_id: 'turn-synthetic-1',
        status: 'interrupted',
        proposals: [VALID_DRAFT],
      },
    }),
  );
  const adapter = adapterWith(() => transport);
  const ctx = makeContext();
  const controller = new AbortController();
  const run = collectRun(adapter, startRunRequest(), ctx, controller.signal);
  await transport.awaitSend(`"${TURN_START_METHOD}"`);
  controller.abort();
  const events = await run;
  expect(events.at(-1)!.type).toBe('cancelled');
  expect(ctx.submitted.length).toBe(1);
  const candidateEvent = events.find((event) => event.type === 'candidate')!;
  expect(candidateEvent.data?.context).toEqual(RUN_CONTEXT);
});

// ---------------------------------------------------------------------------
// real stdio loop (synthetic fake CLI; not Codex CLI evidence)
// ---------------------------------------------------------------------------

const FAKE_CLI_SOURCE = `
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const scenario = process.argv[2] ?? 'happy';
writeFileSync('capture.json', JSON.stringify({
  scenario,
  argv: process.argv.slice(2),
  env_keys: Object.keys(process.env).sort(),
  cwd: process.cwd(),
}));

const proposal = {
  changes: [{
    kind: 'set_attributes',
    change_id: 'change_t22_001',
    object_id: 'object_person_001',
    values: { helmet_state: 'not_wearing' },
    before_hash: 'h1',
    reason: 'synthetic transcript proposal',
  }],
  issues: [],
  score: null,
};

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const id = message.id;
  const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  if (message.method === 'initialize') {
    if (scenario === 'probe-needs-login') out({ id, result: { authenticated: false, models: [] } });
    else out({ id, result: { authenticated: true, models: ['synthetic-model'], runtime_version: '0.0.0-synthetic' } });
    return;
  }
  if (id === undefined) return;
  if (message.method === 'thread/start') {
    out({ id, result: { thread_id: 'thread-synthetic-1' } });
    return;
  }
  if (message.method === 'turn/start') {
    out({ id, result: { turn_id: 'turn-synthetic-1' } });
    if (scenario === 'happy') {
      out({ method: 'turn/updated', params: { turn_id: 'turn-synthetic-1', thread_id: 'thread-synthetic-1', status: 'in_progress' } });
      out({ method: 'turn/updated', params: {
        turn_id: 'turn-synthetic-1', status: 'completed',
        usage: { input_tokens: 1200, output_tokens: 300 },
        proposals: [proposal],
      } });
    } else if (scenario === 'disconnect') {
      out({ method: 'turn/updated', params: { turn_id: 'turn-synthetic-1', status: 'in_progress' } });
      process.exitCode = 3;
      process.exit(3);
    }
    return;
  }
  if (message.method === 'turn/interrupt') {
    out({ id, result: { turn_id: 'turn-synthetic-1', status: 'interrupted' } });
    return;
  }
  out({ id, error: { code: -32601, message: 'synthetic fake cli: unknown method' } });
});
`;

function writeFakeCli(): { harness: string; fakeCli: string } {
  const harness = makeTempDir('t22-stdio-');
  const fakeCli = join(harness, 'fake-cli.mjs');
  writeFileSync(fakeCli, FAKE_CLI_SOURCE);
  return { harness, fakeCli };
}

function stdioHarness(scenario: string): {
  adapter: ProviderAdapter;
  config: CodexPermissionsConfig;
  harness: string;
} {
  const { harness, fakeCli } = writeFakeCli();
  const config = permissionsConfig({ command: { executable: process.execPath, argv: [fakeCli, scenario] } });
  const schemaPath = join(harness, 'schema.json');
  writeFileSync(schemaPath, '{}');
  const adapter = createCodexLocalAdapter({
    permissions: config,
    transport: createStdioCodexTransport,
    imageSource: () => ({ grant_id: 'grant_t22_1', region: null }),
    runToken: () => RUN_TOKEN,
    schemaArtifactPath: schemaPath,
    probeTimeoutMs: 15_000,
    runTimeoutMs: 20_000,
  });
  return { adapter, config, harness };
}

it('spawns a real child over stdio with minimal env, token in env only and an isolated run cwd', async () => {
  const { adapter, config, harness } = stdioHarness('happy');
  const ctx = makeContext();
  const events = await collectRun(adapter, startRunRequest(), ctx);
  expect(events.at(-1)!.type).toBe('succeeded');
  expect(ctx.submitted.length).toBe(1);
  const candidateEvent = events.find((event) => event.type === 'candidate')!;
  expect(candidateEvent.data?.context).toEqual(RUN_CONTEXT);
  // The child proves what it actually received: the run cwd is the private
  // per-run directory, the token arrived via env only, and no parent secret
  // crossed the boundary.
  const capturePath = join(resolveRunCwd(config, ctx.run_id), 'capture.json');
  const capture = JSON.parse(readFileSync(capturePath, 'utf8')) as {
    argv: string[];
    env_keys: string[];
    cwd: string;
  };
  expect(resolve(capture.cwd)).toBe(resolveRunCwd(config, ctx.run_id));
  expect(capture.argv.join(' ')).not.toContain(RUN_TOKEN);
  expect(capture.env_keys).not.toContain('WEBLABEL_RUN_TOKEN');
  expect(capture.env_keys).toContain('WEBLABEL_API_BASE');
  expect(capture.env_keys).not.toContain('MY_SECRET_TOKEN_X');
  // Windows itself injects a small mandatory baseline (SystemRoot/PATH/...)
  // even into a minimal environment block (same rule as t16_host.test.ts);
  // anything beyond the allowlist or that baseline would be a leak.
  const platformBaseline = [
    'HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT',
    'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR',
  ];
  const allowedKeys = ['PATH', 'PATHEXT', 'SystemRoot', 'WEBLABEL_API_BASE'];
  expect(capture.env_keys.every((key) => allowedKeys.includes(key) || platformBaseline.includes(key))).toBe(true);
  expect(JSON.stringify(events)).not.toContain(RUN_TOKEN);
  rmSync(harness, { recursive: true, force: true });
}, 30_000);

it('surfaces a child that dies mid-turn as a controlled disconnect failure', async () => {
  const { adapter, harness } = stdioHarness('disconnect');
  const ctx = makeContext();
  const events = await collectRun(adapter, startRunRequest(), ctx);
  const terminal = events.at(-1)!;
  expect(terminal.type).toBe('failed');
  expect(terminal.data?.error_code).toBe('codex_disconnected');
  expect(ctx.submitted).toEqual([]);
  expect(JSON.stringify(events)).not.toContain(RUN_TOKEN);
  rmSync(harness, { recursive: true, force: true });
}, 30_000);

// ---------------------------------------------------------------------------
// evidence honesty
// ---------------------------------------------------------------------------

it('keeps protocol-fixture and live evidence flags false (T32 gates)', () => {
  const evidence = codexEvidenceStatus();
  expect(evidence.docs_verified).toBe(true);
  expect(evidence.protocol_fixture_tested).toBe(false);
  expect(evidence.live_tested).toBe(false);
  // The synthetic suite above is parsing/loop evidence only.
  const state = classifyCodexState({ authenticated: true, models: ['synthetic-model'] });
  expect(state.verification).toBe('not_run');
  expect(normalizeRuntimeState({ authenticated: true, models: ['m'], runtime_version: 'x', unknown_field: 1 })).toEqual({
    authenticated: true,
    models: ['m'],
    runtime_version: 'x',
  });
  expect(normalizeRuntimeState({ authenticated: 'yes', models: [] })).toBe(null);
  // Partial fixtures: only the runtime block is consumed by sessionUnavailable.
  const needsLogin = {
    runtime: { authenticated: false, models: [] },
  } as unknown as CodexSessionState;
  const noModels = {
    runtime: { authenticated: true, models: [] },
  } as unknown as CodexSessionState;
  const ready = {
    runtime: { authenticated: true, models: ['m'] },
  } as unknown as CodexSessionState;
  expect(sessionUnavailable(needsLogin)).toBe('needs_login');
  expect(sessionUnavailable(noModels)).toBe('model_unavailable');
  expect(sessionUnavailable(ready)).toBe(null);
});
