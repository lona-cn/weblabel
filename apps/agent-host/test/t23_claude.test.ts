//! T23 — official Claude subscription runtime adapter (`claude_local`).
//!
//! SYNTHETIC TRANSCRIPT NOTICE: every protocol transcript below is hand-written
//! against the project-pinned schema of docs/providers/claude.md (derived from
//! the T02-verified documentation boundaries in docs/provider-compatibility.md
//! and the captured `claude --help` / `claude --version` output of the installed
//! 2.1.183 runtime, saved verbatim in reports/T23/). Synthetic transcripts only
//! exercise parsing, run-loop, boundary and error paths; they are NOT live
//! evidence and NOT runtime-schema evidence. Real subscription login and real
//! image runs are T32 prerequisites and are never claimed here. This suite
//! performs zero external calls: no `claude -p` invocation, no login, no
//! network. The only real subprocesses are `node <fake-cli>` scripts.

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
  parseClaudeLine,
  type ClaudeEvent,
} from '../src/providers/claude/protocol';
import {
  billingTotals,
  classifyClaudeState,
  classifyUnavailable,
  foldClaudeMessage,
  newClaudeSession,
  normalizeClaudeInit,
  type ClaudeSessionState,
} from '../src/providers/claude/session';
import {
  ClaudePermissionError,
  MCP_SERVER_NAME,
  PERMITTED_TOOLS,
  buildClaudeLaunchPlan,
  buildVersionProbePlan,
  resolveRunCwd,
  validateClaudeToolPolicy,
  type ClaudeLaunchPlan,
  type ClaudePermissionsConfig,
} from '../src/providers/claude/permissions';
import {
  claudeEvidenceStatus,
  createClaudeLocalAdapter,
  createStdioClaudeTransport,
  type ClaudeTransport,
} from '../src/providers/claude/adapter';

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
  input_fingerprint: 'sha-t23-input-1',
};

const RUN_TOKEN = 'wlr-t23-run-token-0123456789';
const RUN_SESSION = '00000000-0000-4000-8000-000000000001';

function startRunRequest(overrides: Partial<StartRunRequest> = {}): StartRunRequest {
  return {
    operation_id: 'operation_t23_1',
    profile_id: 'profile_claude_t23',
    context: RUN_CONTEXT,
    intent: 'audit_attributes',
    prompt: 'Audit helmet_state for the selected person.',
    consent_id: 'consent_t23_1',
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
    run_id: 'run_t23_001',
    approved_grant_ids: ['grant_t23_1'],
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
        suggestion_set_id: 'suggestion_set_t23_1',
        model_run_id: 'model_run_t23_1',
        prediction_id: 'prediction_t23_1',
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

function wireOf(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// tool policy (task card snippet)
// ---------------------------------------------------------------------------

it('rejects broad execution permissions', () => {
  expect(() => validateClaudeToolPolicy({ allowed_tools: ['*'] })).toThrow();
  expect(() => validateClaudeToolPolicy({ allowed_tools: ['Bash', 'Write'] })).toThrow();
});

it('accepts only the frozen project MCP surface as auto-approved tools', () => {
  const policy = validateClaudeToolPolicy({ allowed_tools: [...PERMITTED_TOOLS] });
  expect(policy.allowed_tools).toEqual([...PERMITTED_TOOLS]);
  expect(policy.allowed_tools).toEqual(TOOL_NAMES.map((tool) => `mcp__${MCP_SERVER_NAME}__${tool}`));
  expect(() => validateClaudeToolPolicy({ allowed_tools: ['read_region'] })).toThrow(ClaudePermissionError);
  expect(() =>
    validateClaudeToolPolicy({ allowed_tools: ['mcp__somebody-else__read_region'] }),
  ).toThrow(ClaudePermissionError);
  expect(() =>
    validateClaudeToolPolicy({ allowed_tools: ['mcp__weblabel-agent-tools__*'] }),
  ).toThrow(ClaudePermissionError);
  expect(() => validateClaudeToolPolicy({ allowed_tools: ['Edit'] })).toThrow(ClaudePermissionError);
  expect(() => validateClaudeToolPolicy({ allowed_tools: 'Bash' })).toThrow(ClaudePermissionError);
  // Denying this project's own frozen tools would silently break the T21 surface.
  expect(() =>
    validateClaudeToolPolicy({ allowed_tools: [...PERMITTED_TOOLS], denied_tools: [PERMITTED_TOOLS[0]] }),
  ).toThrow(ClaudePermissionError);
});

// ---------------------------------------------------------------------------
// runtime state classification (account / model / subscription mismatch)
// ---------------------------------------------------------------------------

it('classifies login, API-key and model states distinctly and never claims live verification', () => {
  const unknownAuth = classifyClaudeState({ auth_mode: 'unknown', model: 'm', tools: [], mcp_servers: [], mcp_server_errors: null });
  expect(unknownAuth.availability).toBe('needs_login');
  expect(unknownAuth.verification).toBe('not_run');
  const apiKey = classifyClaudeState({ auth_mode: 'api_key', model: 'm', tools: [], mcp_servers: [], mcp_server_errors: null });
  expect(apiKey.availability).toBe('blocked');
  const noModel = classifyClaudeState({ auth_mode: 'subscription', model: null, tools: [], mcp_servers: [], mcp_server_errors: null });
  expect(noModel.availability).toBe('needs_configuration');
  const ready = classifyClaudeState(
    { auth_mode: 'subscription', model: 'claude-sonnet-5', tools: [], mcp_servers: [], mcp_server_errors: null },
    'claude-sonnet-5',
  );
  expect(ready.availability).toBe('ready');
  expect(ready.verification).toBe('not_run');
  // A full model id that is not the requested one is a model mismatch → blocked.
  const mismatch = classifyClaudeState(
    { auth_mode: 'subscription', model: 'claude-other-9', tools: [], mcp_servers: [], mcp_server_errors: null },
    'claude-sonnet-5',
  );
  expect(mismatch.availability).toBe('blocked');
  // Unknown runtime state is never an available model and never live.
  expect(normalizeClaudeInit({ auth_mode: 'api_key', model: 'm', tools: ['x'], mcp_servers: [{ name: 'a' }], mcp_server_errors: {}, unknown_field: 1 })).toEqual({
    auth_mode: 'api_key',
    model: 'm',
    tools: ['x'],
    mcp_servers: ['a'],
    mcp_server_errors: {},
  });
  expect(normalizeClaudeInit({ model: 42 })).toBe(null);
  expect(normalizeClaudeInit({ tools: 'Bash' })).toBe(null);
  expect(normalizeClaudeInit({ mcp_servers: [{ no_name: 1 }] })).toBe(null);
});

// ---------------------------------------------------------------------------
// probe() honesty
// ---------------------------------------------------------------------------

it('reports needs_configuration and never starts a session when the Claude CLI is absent', async () => {
  let transportStarted = 0;
  const adapter = createClaudeLocalAdapter({
    permissions: permissionsConfig({
      command: { executable: join(makeTempDir('t23-nocli-'), 'claude.exe'), argv: [] },
    }),
    transport: () => {
      transportStarted += 1;
      return makeScriptedTransport();
    },
    imageSource: () => ({ grant_id: 'grant_t23_1', region: null }),
    runToken: () => RUN_TOKEN,
    schemaArtifactPath: join(makeTempDir('t23-schema-'), 'schema.json'),
  });
  const profiles = await adapter.probe();
  expect(profiles.length).toBe(1);
  expect(profiles[0]).toMatchObject({
    profile_id: 'claude_local',
    provider_id: 'claude_local',
    auth_kind: 'official_user_login',
    availability: 'needs_configuration',
    verification: 'not_run',
    runtime_version: null,
  });
  expect(transportStarted).toBe(0);
});

it('is blocked without the pinned protocol fixture even when the CLI resolves', async () => {
  let transportStarted = 0;
  const adapter = createClaudeLocalAdapter({
    permissions: permissionsConfig(),
    transport: () => {
      transportStarted += 1;
      return makeScriptedTransport();
    },
    imageSource: () => ({ grant_id: 'grant_t23_1', region: null }),
    runToken: () => RUN_TOKEN,
    schemaArtifactPath: null,
  });
  const profiles = await adapter.probe();
  expect(profiles[0].availability).toBe('blocked');
  expect(profiles[0].verification).toBe('not_run');
  expect(transportStarted).toBe(0);
});

it('captures the runtime version with a session-free probe and stays blocked', async () => {
  // The probe transport must only ever run the verified `--version` surface:
  // no `-p`, no prompt, no model session (probe of the installed CLI is local).
  const transport = makeScriptedTransport();
  transport.push('2.1.183 (Claude Code)');
  transport.finish();
  const schemaPath = join(makeTempDir('t23-schema-'), 'schema.json');
  writeFileSync(schemaPath, '{}');
  let seenPlans: ClaudeLaunchPlan[] = [];
  const adapter = createClaudeLocalAdapter({
    permissions: permissionsConfig(),
    transport: (plan: ClaudeLaunchPlan) => {
      seenPlans = [...seenPlans, plan];
      return transport;
    },
    imageSource: () => ({ grant_id: 'grant_t23_1', region: null }),
    runToken: () => RUN_TOKEN,
    schemaArtifactPath: schemaPath,
    probeTimeoutMs: 5000,
  });
  const profiles = await adapter.probe();
  expect(profiles[0].availability).toBe('blocked');
  expect(profiles[0].verification).toBe('not_run');
  expect(profiles[0].runtime_version).toBe('2.1.183 (Claude Code)');
  expect(seenPlans.length).toBe(1);
  expect(seenPlans[0].mode).toBe('version_probe');
  expect(seenPlans[0].command.argv).toEqual(['--version']);
});

// ---------------------------------------------------------------------------
// protocol: the pinned stream-json event families
// ---------------------------------------------------------------------------

it('parses the pinned stream-json event families with reliable boundaries', () => {
  const init = parseClaudeLine(
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-synthetic-1', tools: ['mcp__weblabel-agent-tools__read_region'], mcp_servers: [{ name: MCP_SERVER_NAME }] }),
  );
  expect(init.kind).toBe('system');
  const assistant = parseClaudeLine(
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'looking' }] } }),
  );
  expect(assistant.kind).toBe('assistant');
  const user = parseClaudeLine(
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } }),
  );
  expect(user.kind).toBe('user');
  const result = parseClaudeLine(JSON.stringify({ type: 'result', session_id: RUN_SESSION, subtype: 'success', is_error: false }));
  expect(result.kind).toBe('result');
  // Unknown event families are tolerated as unknown and never fatal.
  const future = parseClaudeLine(JSON.stringify({ type: 'future/unknown', anything: 1 }));
  expect(future.kind).toBe('unknown');
  expect(future.type).toBe('future/unknown');
});

it('rejects truncated, oversized and malformed lines with controlled protocol errors', () => {
  const bad = (line: string): string => {
    try {
      parseClaudeLine(line);
    } catch (error) {
      return (error as { code: string }).code;
    }
    throw new Error(`expected a controlled protocol error for ${line.slice(0, 40)}`);
  };
  expect(bad('{"type":"result","subtype":"su')).toBe('invalid_json');
  expect(bad('{not json')).toBe('invalid_json');
  expect(bad('[1,2,3]')).toBe('invalid_envelope');
  expect(bad('{"no_type":1}')).toBe('invalid_envelope');
  expect(bad('{"type":42}')).toBe('invalid_envelope');
  expect(bad('{"type":""}')).toBe('invalid_envelope');
  expect(bad('x'.repeat(5 * 1024 * 1024))).toBe('message_too_large');
});

// ---------------------------------------------------------------------------
// run loop: streaming / tool / final boundaries (task card behavior 1)
// ---------------------------------------------------------------------------

it('a truncated stream fails the run controlled and never writes annotations', async () => {
  // The truncated line IS a result event carrying a candidate draft: parsing
  // must fail controlled and the draft must never reach submit_candidates.
  const truncated = JSON.stringify({
    type: 'result', session_id: RUN_SESSION,
    subtype: 'success',
    is_error: false,
    usage: { input_tokens: 10, output_tokens: 10 },
    structured_output: VALID_DRAFT,
  }).slice(0, -25);
  const transport = makeScriptedTransport((_, self) => {
    self.push(initEvent());
    self.push(truncated);
    self.finish();
  });
  const ctx = makeContext();
  const events = await collectRun(adapterWith(() => transport), startRunRequest(), ctx);
  const terminal = events.at(-1)!;
  expect(terminal.type).toBe('failed');
  expect(terminal.data?.error_code).toBe('invalid_json');
  expect(ctx.submitted).toEqual([]);
  expect(events.filter((event) => event.type === 'candidate')).toEqual([]);
});

it('folds streaming output, tool results and the final result with reliable boundaries', async () => {
  const transport = makeScriptedTransport((_, self) => {
    self.push(initEvent());
    self.push(assistantEvent([{ type: 'text', text: 'checking the crop' }]));
    self.push(
      assistantEvent([
        { type: 'tool_use', id: 'toolu_1', name: PERMITTED_TOOLS[3], input: { region: null } },
      ]),
    );
    self.push(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'image bytes' }] },
      }),
    );
    self.push(assistantEvent([{ type: 'text', text: 'done' }]));
    self.push(
      JSON.stringify({
        type: 'result', session_id: RUN_SESSION,
        subtype: 'success',
        is_error: false,
        usage: { input_tokens: 10, output_tokens: 5 },
        structured_output: VALID_DRAFT,
      }),
    );
    self.finish();
  });
  const ctx = makeContext();
  const events = await collectRun(adapterWith(() => transport), startRunRequest(), ctx);
  expect(events.map((event) => event.type)).toEqual([
    'started',
    'progress',
    'tool_call',
    'progress',
    'progress',
    'candidate',
    'succeeded',
  ]);
  const toolCall = events.find((event) => event.type === 'tool_call')!;
  expect(toolCall.data?.tool).toBe(PERMITTED_TOOLS[3]);
  expect(events.find((event) => event.type === 'candidate')!.data?.context).toEqual(RUN_CONTEXT);
  expect(events.at(-1)!.data?.usage).toEqual({ input_tokens: 10, output_tokens: 5, cost_usd: null });
  expect(ctx.submitted.length).toBe(1);
});

it('unmatched tool results and open tool calls at success are controlled boundary failures', async () => {
  const unmatched = makeScriptedTransport((_, self) => {
    self.push(initEvent());
    self.push(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_never_asked', content: 'x' }] },
      }),
    );
    self.push(JSON.stringify({ type: 'result', session_id: RUN_SESSION, subtype: 'success', is_error: false, structured_output: VALID_DRAFT }));
    self.finish();
  });
  const ctx1 = makeContext();
  const events1 = await collectRun(adapterWith(() => unmatched), startRunRequest(), ctx1);
  expect(events1.at(-1)!.type).toBe('failed');
  expect(events1.at(-1)!.data?.error_code).toBe('claude_protocol_violation');
  expect(ctx1.submitted).toEqual([]);

  const openAtResult = makeScriptedTransport((_, self) => {
    self.push(initEvent());
    self.push(
      assistantEvent([{ type: 'tool_use', id: 'toolu_1', name: PERMITTED_TOOLS[3], input: { region: null } }]),
    );
    self.push(JSON.stringify({ type: 'result', session_id: RUN_SESSION, subtype: 'success', is_error: false, structured_output: VALID_DRAFT }));
    self.finish();
  });
  const ctx2 = makeContext();
  const events2 = await collectRun(adapterWith(() => openAtResult), startRunRequest(), ctx2);
  expect(events2.at(-1)!.type).toBe('failed');
  expect(events2.at(-1)!.data?.error_code).toBe('claude_protocol_violation');
  expect(ctx2.submitted).toEqual([]);
});

it('rejects tool calls outside the frozen MCP surface as policy violations', async () => {
  // Tool use outside the permitted MCP surface: the runtime must never offer
  // or run it (the launch plan disables every built-in tool), so observing it
  // is a policy breach and fails the run closed.
  const bashUse = makeScriptedTransport((_, self) => {
    self.push(initEvent());
    self.push(assistantEvent([{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'rm -rf /' } }]));
    self.finish();
  });
  const ctx1 = makeContext();
  const events1 = await collectRun(adapterWith(() => bashUse), startRunRequest(), ctx1);
  expect(events1.at(-1)!.type).toBe('failed');
  expect(events1.at(-1)!.data?.error_code).toBe('method_not_permitted');
  expect(ctx1.submitted).toEqual([]);

  // Runtime metadata: a built-in tool offered at init is the same breach.
  const offeredBash = makeScriptedTransport((_, self) => {
    self.push(initEvent({ tools: [...PERMITTED_TOOLS, 'Bash'] }));
    self.push(JSON.stringify({ type: 'result', session_id: RUN_SESSION, subtype: 'success', is_error: false, structured_output: VALID_DRAFT }));
    self.finish();
  });
  const ctx2 = makeContext();
  const events2 = await collectRun(adapterWith(() => offeredBash), startRunRequest(), ctx2);
  expect(events2.at(-1)!.type).toBe('failed');
  expect(events2.at(-1)!.data?.error_code).toBe('method_not_permitted');
  expect(ctx2.submitted).toEqual([]);

  // An extra MCP server surfaced by the runtime metadata is refused as well.
  const extraServer = makeScriptedTransport((_, self) => {
    self.push(initEvent({ mcp_servers: [{ name: MCP_SERVER_NAME }, { name: 'evil-server' }] }));
    self.push(JSON.stringify({ type: 'result', session_id: RUN_SESSION, subtype: 'success', is_error: false, structured_output: VALID_DRAFT }));
    self.finish();
  });
  const ctx3 = makeContext();
  const events3 = await collectRun(adapterWith(() => extraServer), startRunRequest(), ctx3);
  expect(events3.at(-1)!.type).toBe('failed');
  expect(events3.at(-1)!.data?.error_code).toBe('method_not_permitted');
  expect(ctx3.submitted).toEqual([]);
});

// ---------------------------------------------------------------------------
// launch plan: verified flags only, tool surface, injection and isolation
// ---------------------------------------------------------------------------

// Flag authenticity is checked against the REAL capture of `claude --help` from
// the installed Claude Code 2.1.183 on this workstation (exit 0; committed at
// reports/T23/claude-help.txt). Every flag the launch plan uses MUST appear
// there: no invented flags.
const CLAUDE_HELP_2_1_183 = readFileSync(
  join(repoRoot, 'reports', 'T23', 'claude-help.txt'),
  'utf8',
);

it('builds argv only from flags confirmed by the installed CLI help', () => {
  const plan = buildClaudeLaunchPlan(permissionsConfig(), {
    run_id: 'run_t23_001',
    runToken: RUN_TOKEN,
    apiBase: 'http://127.0.0.1:48100',
  });
  const flags = plan.command.argv.filter((part) => /^-{1,2}[A-Za-z]/.test(part));
  expect(flags.length).toBeGreaterThan(5);
  for (const flag of flags) {
    expect(CLAUDE_HELP_2_1_183.includes(flag), `flag ${flag} must exist in claude --help`).toBe(true);
  }
  // The version probe uses only the verified version flag.
  const probe = buildVersionProbePlan(permissionsConfig(), { run_id: 'claude-probe' });
  expect(probe.command.argv).toEqual(['--version']);
});

it('attaches only this project MCP server and the five permitted tools', () => {
  const config = permissionsConfig();
  const plan = buildClaudeLaunchPlan(config, {
    run_id: 'run_t23_001',
    runToken: RUN_TOKEN,
    apiBase: 'http://127.0.0.1:48100',
  });
  expect(plan.mode).toBe('run');
  expect(plan.toolPolicy.allowed_tools).toEqual([...PERMITTED_TOOLS]);
  expect(plan.toolPolicy.allowed_tools).toEqual(TOOL_NAMES.map((tool) => `mcp__${MCP_SERVER_NAME}__${tool}`));
  for (const tool of plan.toolPolicy.allowed_tools) {
    expect(tool).not.toMatch(/shell|exec|edit|write|delete|patch/i);
  }
  expect(plan.mcpServers.length).toBe(1);
  expect(plan.mcpServers[0]).toMatchObject({ name: MCP_SERVER_NAME, command: config.mcpCommand.executable });
  expect(plan.mcpServers[0].argv).toEqual(config.mcpCommand.argv);
  // Only the run token and loopback API base reach the MCP server child env.
  expect(Object.keys(plan.mcpServers[0].env).sort()).toEqual(['WEBLABEL_API_BASE', 'WEBLABEL_RUN_TOKEN']);
  const argv = plan.command.argv;
  // Official allow/deny policy: no built-in tool at all, our five MCP tools
  // auto-approved, a deny rule over the execution surface, MCP pinned to the
  // single explicit config.
  const toolsIndex = argv.indexOf('--tools');
  expect(toolsIndex).toBeGreaterThanOrEqual(0);
  expect(argv[toolsIndex + 1]).toBe('');
  const allowIndex = argv.indexOf('--allowedTools');
  expect(argv[allowIndex + 1]).toBe([...PERMITTED_TOOLS].join(','));
  const denyIndex = argv.indexOf('--disallowedTools');
  expect(argv[denyIndex + 1]).toContain('Bash');
  expect(argv[denyIndex + 1]).toContain('Write');
  expect(argv).toContain('--strict-mcp-config');
  // The generated MCP config contains exactly this project's server.
  const configPath = argv[argv.indexOf('--mcp-config') + 1];
  const mcpConfig = JSON.parse(readFileSync(configPath, 'utf8')) as {
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  };
  expect(Object.keys(mcpConfig.mcpServers)).toEqual([MCP_SERVER_NAME]);
  expect(mcpConfig.mcpServers[MCP_SERVER_NAME].args).toEqual([...config.mcpCommand.argv]);
});

it('rejects command and flag injection through model, argv and executable inputs', () => {
  expect(() =>
    buildClaudeLaunchPlan(permissionsConfig({ model: 'sonnet; rm -rf /' }), {
      run_id: 'run_t23_001',
      runToken: RUN_TOKEN,
      apiBase: 'http://127.0.0.1:48100',
    }),
  ).toThrow(ClaudePermissionError);
  // A model name that is really a flag can never be smuggled into argv.
  expect(() =>
    buildClaudeLaunchPlan(permissionsConfig({ model: '--bare' }), {
      run_id: 'run_t23_001',
      runToken: RUN_TOKEN,
      apiBase: 'http://127.0.0.1:48100',
    }),
  ).toThrow(/model_invalid/);
  expect(() =>
    buildClaudeLaunchPlan(permissionsConfig({ mcpCommand: { executable: process.execPath, argv: ['--mcp-config', 'evil'] } }), {
      run_id: 'run_t23_001',
      runToken: RUN_TOKEN,
      apiBase: 'http://127.0.0.1:48100',
    }),
  ).toThrow(/argv_flag_injection/);
  expect(() =>
    buildClaudeLaunchPlan(permissionsConfig({ command: { executable: 'claude\0evil', argv: [] } }), {
      run_id: 'run_t23_001',
      runToken: RUN_TOKEN,
      apiBase: 'http://127.0.0.1:48100',
    }),
  ).toThrow(ClaudePermissionError);
  // A legitimate model id is passed as its own argv element after --model.
  const plan = buildClaudeLaunchPlan(permissionsConfig({ model: 'claude-sonnet-5' }), {
    run_id: 'run_t23_001',
    runToken: RUN_TOKEN,
    apiBase: 'http://127.0.0.1:48100',
  });
  const modelIndex = plan.command.argv.indexOf('--model');
  expect(plan.command.argv[modelIndex + 1]).toBe('claude-sonnet-5');
});

it('never uses --bare or permission bypasses and keeps API credentials out of the child env', () => {
  // The subscription channel runs on the user's official login: --bare forces
  // API-key auth and permission bypasses would disable the allow/deny policy.
  const config = permissionsConfig({
    source_env: {
      PATH: 'C:\\synthetic-path',
      SystemRoot: 'C:\\Windows',
      PATHEXT: '.EXE',
      ANTHROPIC_API_KEY: 'sk-synthetic-not-real',
      CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-oauth',
    },
  });
  const plan = buildClaudeLaunchPlan(config, {
    run_id: 'run_t23_001',
    runToken: RUN_TOKEN,
    apiBase: 'http://127.0.0.1:48100',
  });
  const argv = plan.command.argv;
  expect(argv).not.toContain('--bare');
  expect(argv).not.toContain('--dangerously-skip-permissions');
  expect(argv).not.toContain('--allow-dangerously-skip-permissions');
  expect(argv.join(' ')).not.toContain('sk-synthetic-not-real');
  expect(plan.env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(plan.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  // Credentials can never be allowlisted into the child: that would let the
  // run silently switch to API billing (an API call disguised as subscription).
  expect(() =>
    buildClaudeLaunchPlan(permissionsConfig({ envAllowlist: ['PATH', 'ANTHROPIC_API_KEY'] }), {
      run_id: 'run_t23_001',
      runToken: RUN_TOKEN,
      apiBase: 'http://127.0.0.1:48100',
    }),
  ).toThrow(/env_denied/);
  expect(() =>
    buildClaudeLaunchPlan(permissionsConfig({ envAllowlist: ['PATH', 'CLAUDE_CODE_OAUTH_TOKEN'] }), {
      run_id: 'run_t23_001',
      runToken: RUN_TOKEN,
      apiBase: 'http://127.0.0.1:48100',
    }),
  ).toThrow(/env_denied/);
});

it('injects only the minimal allowlisted environment and keeps the run token out of argv', () => {
  const config = permissionsConfig();
  const plan = buildClaudeLaunchPlan(config, {
    run_id: 'run_t23_001',
    runToken: RUN_TOKEN,
    apiBase: 'http://127.0.0.1:48100',
  });
  expect(plan.env.MY_SECRET_TOKEN_X).toBeUndefined();
  expect(plan.env.WEBLABEL_RUN_TOKEN).toBeUndefined();
  expect(() => buildClaudeLaunchPlan({...config, envAllowlist: ['weblabel_run_token']}, {run_id: 'run_t23_001', runToken: RUN_TOKEN, apiBase: 'http://127.0.0.1:48100'})).toThrow(/env_denied/);
  expect(JSON.stringify([plan.command.argv, plan.mcpServers[0].argv])).not.toContain(RUN_TOKEN);
  expect(plan.mcpServers[0].env.WEBLABEL_RUN_TOKEN).toBe(RUN_TOKEN);
  // The prompt travels via stdin, never argv; the token is env-only.
  expect(JSON.stringify(plan.command.argv)).not.toContain('Audit helmet_state');
  // A token smuggled into argv is refused, and module-injection vectors (e.g.
  // NODE_OPTIONS) can never be allowlisted.
  expect(() =>
    buildClaudeLaunchPlan(permissionsConfig({ command: { executable: 'x', argv: [RUN_TOKEN] } }), {
      run_id: 'run_t23_001',
      runToken: RUN_TOKEN,
      apiBase: 'http://127.0.0.1:48100',
    }),
  ).toThrow(/token_in_argv/);
  expect(() =>
    buildClaudeLaunchPlan(permissionsConfig({ envAllowlist: ['PATH', 'NODE_OPTIONS'] }), {
      run_id: 'run_t23_001',
      runToken: RUN_TOKEN,
      apiBase: 'http://127.0.0.1:48100',
    }),
  ).toThrow(/env_denied/);
});

it('keeps the run cwd out of the user repository and fails closed on forbidden roots', () => {
  const userRepo = makeTempDir('t23-userrepo-');
  const runRoot = makeTempDir('t23-isolated-');
  const config = permissionsConfig({ runRoot, forbiddenCwdRoots: [userRepo] });
  const cwd = resolveRunCwd(config, 'run_t23_001');
  expect(cwd.startsWith(resolve(runRoot))).toBe(true);
  expect(cwd.startsWith(resolve(userRepo))).toBe(false);
  const plan = buildClaudeLaunchPlan(config, {
    run_id: 'run_t23_001',
    runToken: RUN_TOKEN,
    apiBase: 'http://127.0.0.1:48100',
  });
  expect(plan.cwd).toBe(cwd);

  expect(() =>
    buildClaudeLaunchPlan(permissionsConfig({ runRoot: userRepo, forbiddenCwdRoots: [userRepo] }), {
      run_id: 'run_t23_001',
      runToken: RUN_TOKEN,
      apiBase: 'http://127.0.0.1:48100',
    }),
  ).toThrow(ClaudePermissionError);
  try {
    buildClaudeLaunchPlan(permissionsConfig({ runRoot: userRepo, forbiddenCwdRoots: [userRepo] }), {
      run_id: 'run_t23_001',
      runToken: RUN_TOKEN,
      apiBase: 'http://127.0.0.1:48100',
    });
  } catch (error) {
    expect((error as ClaudePermissionError).code).toBe('cwd_forbidden');
  }
  expect(() =>
    buildClaudeLaunchPlan(config, {
      run_id: '..\\escape',
      runToken: RUN_TOKEN,
      apiBase: 'http://127.0.0.1:48100',
    }),
  ).toThrow(/run_id_invalid/);
});

// ---------------------------------------------------------------------------
// consent and image egress (task card behavior 5)
// ---------------------------------------------------------------------------

it('refuses to start or read anything without a consent record', async () => {
  let transportStarted = 0;
  let grantsRead = 0;
  const adapter = createClaudeLocalAdapter({
    permissions: permissionsConfig(),
    transport: () => {
      transportStarted += 1;
      return makeScriptedTransport();
    },
    imageSource: () => {
      grantsRead += 1;
      return { grant_id: 'grant_t23_1', region: null };
    },
    runToken: () => RUN_TOKEN,
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

it('binds the run to its consent-approved image grant and never stages pixels to disk', async () => {
  // An image source outside the consent-approved grant fails closed before the
  // runtime starts. On the approved path NO pixel byte is read or staged by
  // the adapter: image bytes reach the model only through the T21 MCP
  // read_region surface, which enforces consent scope and pixel budgets
  // server-side (real image runs remain a T32 gate).
  const mismatch = makeScriptedTransport((_, self) => {
    self.push(initEvent());
    self.finish();
  });
  const ctx1 = makeContext();
  const events1 = await collectRun(
    adapterWith(() => mismatch, {
      imageSource: () => ({ grant_id: 'grant_t23_OTHER' as Id, region: null }),
    }),
    startRunRequest(),
    ctx1,
  );
  expect(events1.at(-1)!.type).toBe('failed');
  expect(events1.at(-1)!.data?.error_code).toBe('image_grant_missing');

  const transport = makeScriptedTransport((_, self) => {
    self.push(initEvent());
    self.push(JSON.stringify({ type: 'result', session_id: RUN_SESSION, subtype: 'success', is_error: false }));
    self.finish();
  });
  const ctx2 = makeContext();
  const events2 = await collectRun(adapterWith(() => transport), startRunRequest(), ctx2);
  expect(events2.at(-1)!.type).toBe('succeeded');
  expect(ctx2.reads).toEqual([]);
});

// ---------------------------------------------------------------------------
// unavailable states (task card behavior 4)
// ---------------------------------------------------------------------------

it('surfaces login, model and subscription mismatches as distinct failures and never fabricates candidates', async () => {
  const scenarios: Array<{
    name: string;
    script: ScriptedServerOptions;
    permissions?: Partial<ClaudePermissionsConfig>;
    expected: string;
  }> = [
    {
      name: 'no-login',
      script: {
        result: { subtype: 'error_during_execution', is_error: true, error: { message: 'no login', state: 'needs_login' } },
      },
      expected: 'needs_login',
    },
    {
      name: 'model-unavailable',
      script: { init: { model: 'claude-other-9' } },
      permissions: { model: 'claude-sonnet-5' },
      expected: 'model_unavailable',
    },
    {
      name: 'subscription-unavailable',
      script: {
        result: {
          subtype: 'error_during_execution',
          is_error: true,
          error: { message: 'no subscription access', state: 'subscription_unavailable' },
        },
      },
      expected: 'subscription_unavailable',
    },
    {
      name: 'insufficient-quota',
      script: {
        result: {
          subtype: 'error_during_execution',
          is_error: true,
          error: { message: 'quota exhausted', state: 'insufficient_quota' },
        },
      },
      expected: 'insufficient_quota',
    },
  ];
  const seen = new Set<string>();
  for (const scenario of scenarios) {
    const transport = makeScriptedTransport(scriptedServer(scenario.script));
    const adapter = adapterWith(() => transport, {
      permissions: permissionsConfig(scenario.permissions ?? {}),
    });
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
  // The marker table is exact-match only: unknown markers are generic failures.
  expect(classifyUnavailable({ message: 'x', state: 'subscription_unavailable' })).toBe('subscription_unavailable');
  expect(classifyUnavailable({ message: 'x', state: 'unknown_future_state' })).toBe(null);
  expect(classifyUnavailable(null)).toBe(null);
});

it('an API-key authenticated runtime is never disguised as a subscription run', async () => {
  // If the runtime reports API-key billing on this channel, the run must fail
  // as a distinct state: an API call can never be presented as a successful
  // subscription run (ADR 0001 decision 2).
  const transport = makeScriptedTransport(
    scriptedServer({
      init: { auth_mode: 'api_key' },
      result: { subtype: 'success', is_error: false, structured_output: VALID_DRAFT },
    }),
  );
  const ctx = makeContext();
  const events = await collectRun(adapterWith(() => transport), startRunRequest(), ctx);
  const terminal = events.at(-1)!;
  expect(terminal.type).toBe('failed');
  expect(terminal.data?.reason).toBe('api_auth_not_subscription');
  expect(terminal.data?.error_code).toBe('api_auth_not_subscription');
  expect(events.filter((event) => event.type === 'succeeded')).toEqual([]);
  expect(events.filter((event) => event.type === 'candidate')).toEqual([]);
  expect(ctx.submitted).toEqual([]);
});

// ---------------------------------------------------------------------------
// run loop, candidates, billing and lifecycle
// ---------------------------------------------------------------------------

it('runs a synthetic session end to end and submits candidates carrying the original run context', async () => {
  const transport = makeScriptedTransport(
    scriptedServer({
      events: [assistantEvent([{ type: 'text', text: 'auditing' }])],
      result: {
        subtype: 'success',
        is_error: false,
        usage: { input_tokens: 1200, output_tokens: 300 },
        structured_output: VALID_DRAFT,
      },
    }),
  );
  const ctx = makeContext();
  const events = await collectRun(adapterWith(() => transport), startRunRequest(), ctx);
  expect(events.at(-1)!.type).toBe('succeeded');
  expect(ctx.submitted.length).toBe(1);
  const candidateEvent = events.find((event) => event.type === 'candidate')!;
  expect(candidateEvent.data?.context).toEqual(RUN_CONTEXT);
  const succeeded = events.at(-1)!;
  expect(succeeded.data?.usage).toEqual({ input_tokens: 1200, output_tokens: 300, cost_usd: null });
  expect(succeeded.data?.cost_display).toBe('unknown');
});

it('keeps empty usage unknown and computes cost only from explicit pricing', async () => {
  const withoutUsage = makeScriptedTransport(
    scriptedServer({ result: { subtype: 'success', is_error: false, structured_output: VALID_DRAFT } }),
  );
  const events = await collectRun(adapterWith(() => withoutUsage), startRunRequest(), makeContext());
  const succeeded = events.at(-1)!;
  expect(succeeded.data?.usage).toEqual({ input_tokens: null, output_tokens: null, cost_usd: null });
  expect(succeeded.data?.cost_display).toBe('unknown');
  expect(JSON.stringify(succeeded.data)).not.toMatch(/"cost_usd":0|"input_tokens":0|"output_tokens":0/);

  const priced = makeScriptedTransport(
    scriptedServer({
      result: {
        subtype: 'success',
        is_error: false,
        usage: { input_tokens: 1200, output_tokens: 300 },
        structured_output: VALID_DRAFT,
      },
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

it('never double-bills replayed or duplicated result events', async () => {
  // The terminal result is consumed exactly once: replays must neither emit a
  // second terminal event, submit candidates twice, nor fold usage twice.
  const resultLine = JSON.stringify({
    type: 'result', session_id: RUN_SESSION,
    subtype: 'success',
    is_error: false,
    usage: { input_tokens: 1200, output_tokens: 300 },
    structured_output: VALID_DRAFT,
  });
  const transport = makeScriptedTransport((_, self) => {
    self.push(initEvent());
    self.push(resultLine);
    self.push(resultLine);
    self.push(resultLine);
    self.finish();
  });
  const ctx = makeContext();
  const events = await collectRun(adapterWith(() => transport), startRunRequest(), ctx);
  const terminals = events.filter((event) => ['succeeded', 'failed', 'cancelled'].includes(event.type));
  expect(terminals.length).toBe(1);
  expect(terminals[0].type).toBe('succeeded');
  expect(terminals[0].data?.usage).toEqual({ input_tokens: 1200, output_tokens: 300, cost_usd: null });
  expect(ctx.submitted.length).toBe(1);
  expect(events.filter((event) => event.type === 'candidate').length).toBe(1);

  // Session level: folding the same terminal result repeatedly (exit, replay
  // and out-of-order delivery) folds usage exactly once and counts the rest as
  // duplicates — no double-billing ever reaches the run totals.
  let state = newClaudeSession({ run_session_id: RUN_SESSION });
  const replay = parseClaudeLine(resultLine);
  state = foldClaudeMessage(state, replay);
  state = foldClaudeMessage(state, replay);
  state = foldClaudeMessage(state, replay);
  expect(billingTotals(state)).toEqual({ input_tokens: 1200, output_tokens: 300, cost_usd: null });
  expect(state.duplicate_billing_events).toBe(2);
  expect(state.proposals.length).toBe(1);
});

it('foreign session results never end the run or leak usage', async () => {
  // This run is bound to its own --session-id; events carrying another session
  // id are foreign and can never terminate the run, bill it or add candidates.
  const transport = makeScriptedTransport((_, self) => {
    self.push(initEvent());
    self.push(
      JSON.stringify({
        type: 'result',
        session_id: 'foreign-session-9',
        subtype: 'success',
        is_error: false,
        usage: { input_tokens: 999, output_tokens: 999 },
        structured_output: VALID_DRAFT,
      }),
    );
    self.push(
      JSON.stringify({
        type: 'result', session_id: RUN_SESSION,
        subtype: 'success',
        is_error: false,
        usage: { input_tokens: 5, output_tokens: 7 },
      }),
    );
    self.finish();
  });
  const ctx = makeContext();
  const events = await collectRun(adapterWith(() => transport), startRunRequest(), ctx);
  const terminals = events.filter((event) => ['succeeded', 'failed', 'cancelled'].includes(event.type));
  expect(terminals.length).toBe(1);
  expect(terminals[0].type).toBe('succeeded');
  expect(terminals[0].data?.usage).toEqual({ input_tokens: 5, output_tokens: 7, cost_usd: null });
  expect(ctx.submitted).toEqual([]);
});

it('a session-less result is a boundary violation and never bills or terminates the run', async () => {
  const transport = makeScriptedTransport((_, self) => {
    self.push(initEvent());
    // Out-of-scope outcome: no session id at all. It must not terminate, bill
    // or feed candidates; the run's own scoped result decides all of that.
    self.push(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        usage: { input_tokens: 999, output_tokens: 999 },
        structured_output: VALID_DRAFT,
      }),
    );
    self.push(
      JSON.stringify({
        type: 'result', session_id: RUN_SESSION,
        subtype: 'success',
        is_error: false,
        usage: { input_tokens: 5, output_tokens: 7 },
      }),
    );
    self.finish();
  });
  const ctx = makeContext();
  const events = await collectRun(adapterWith(() => transport), startRunRequest(), ctx);
  const terminals = events.filter((event) => ['succeeded', 'failed', 'cancelled'].includes(event.type));
  expect(terminals.length).toBe(1);
  expect(terminals[0].type).toBe('succeeded');
  expect(terminals[0].data?.usage).toEqual({ input_tokens: 5, output_tokens: 7, cost_usd: null });
  expect(ctx.submitted).toEqual([]);
});

it('a result without a parsed init is a protocol violation and writes nothing', async () => {
  const transport = makeScriptedTransport((_, self) => {
    self.push(
      JSON.stringify({
        type: 'result', session_id: RUN_SESSION,
        subtype: 'success',
        is_error: false,
        usage: { input_tokens: 5, output_tokens: 7 },
        structured_output: VALID_DRAFT,
      }),
    );
    self.finish();
  });
  const ctx = makeContext();
  const events = await collectRun(adapterWith(() => transport), startRunRequest(), ctx);
  const terminal = events.at(-1)!;
  expect(terminal.type).toBe('failed');
  expect(terminal.data?.error_code).toBe('claude_protocol_violation');
  expect(ctx.submitted).toEqual([]);
});

it('absent or unknown auth is never presented as a subscription success', async () => {
  const transport = makeScriptedTransport(
    scriptedServer({ init: { auth_mode: undefined }, result: { usage: { input_tokens: 5, output_tokens: 7 } } }),
  );
  const ctx = makeContext();
  const events = await collectRun(adapterWith(() => transport), startRunRequest(), ctx);
  const terminal = events.at(-1)!;
  expect(terminal.type).toBe('failed');
  expect(terminal.data?.error_code).toBe('needs_login');
  expect(ctx.submitted).toEqual([]);
});

it('an empty MCP surface is a load error, not a silent success', async () => {
  const transport = makeScriptedTransport(
    scriptedServer({ init: { mcp_servers: [] } }),
  );
  const ctx = makeContext();
  const events = await collectRun(adapterWith(() => transport), startRunRequest(), ctx);
  const terminal = events.at(-1)!;
  expect(terminal.type).toBe('failed');
  expect(terminal.data?.error_code).toBe('mcp_load_error');
  expect(ctx.submitted).toEqual([]);
});

it('proposals seen before the terminal result are still submitted exactly once', async () => {
  // Proposal accumulation: drafts observed on any event survive to the
  // terminal handling and are content-deduplicated (the structured output is
  // the same payload as the early proposal).
  const transport = makeScriptedTransport((_, self) => {
    self.push(initEvent());
    self.push(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'thinking' }] },
        proposals: [VALID_DRAFT],
      }),
    );
    self.push(
      JSON.stringify({
        type: 'user',
        message: { content: [] },
        proposals: [VALID_DRAFT, { ...((VALID_DRAFT as Record<string, unknown>)), score: 0.5 }],
      }),
    );
    self.push(
      JSON.stringify({
        type: 'result', session_id: RUN_SESSION,
        subtype: 'success',
        is_error: false,
        usage: { input_tokens: 1, output_tokens: 1 },
        structured_output: VALID_DRAFT,
      }),
    );
    self.finish();
  });
  const ctx = makeContext();
  const events = await collectRun(adapterWith(() => transport), startRunRequest(), ctx);
  expect(events.at(-1)!.type).toBe('succeeded');
  expect(ctx.submitted.length).toBe(2);
  expect(events.filter((event) => event.type === 'candidate').length).toBe(2);
});

it('rejects a candidate draft that violates domain rules without writing anything', async () => {
  // VLM attribute review must never create objects or move boxes (C4): a
  // create-kind draft is rejected by the strict validator and nothing is
  // submitted, even though the runtime claimed success.
  const createDraft = {
    changes: [
      {
        kind: 'create',
        change_id: 'change_t23_create_1',
        object: {},
        before_hash: null,
        reason: 'synthetic create attempt',
      },
    ],
    issues: [],
    score: null,
  };
  const transport = makeScriptedTransport(
    scriptedServer({
      result: { subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 }, structured_output: createDraft },
    }),
  );
  const ctx = makeContext();
  const events = await collectRun(adapterWith(() => transport), startRunRequest(), ctx);
  const terminal = events.at(-1)!;
  expect(terminal.type).toBe('failed');
  expect(terminal.data?.error_code).toBe('candidate_invalid');
  expect(ctx.submitted).toEqual([]);
  expect(events.filter((event) => event.type === 'candidate')).toEqual([]);
});

it('bounds the tool loop by turns, bytes and time', async () => {
  const turnFlood = makeScriptedTransport((_, self) => {
    self.push(initEvent());
    for (let index = 0; index < 5; index += 1) {
      self.push(
        assistantEvent([{ type: 'tool_use', id: `toolu_${index}`, name: PERMITTED_TOOLS[3], input: { region: null } }]),
      );
      self.push(
        JSON.stringify({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: `toolu_${index}`, content: 'ok' }] },
        }),
      );
    }
    self.push(JSON.stringify({ type: 'result', session_id: RUN_SESSION, subtype: 'success', is_error: false }));
    self.finish();
  });
  const events1 = await collectRun(
    adapterWith(() => turnFlood, { budgets: { max_tool_turns: 2, max_tool_result_bytes: 1_000_000 } }),
    startRunRequest(),
    makeContext(),
  );
  expect(events1.at(-1)!.type).toBe('failed');
  expect(events1.at(-1)!.data?.error_code).toBe('tool_turn_budget_exceeded');

  const byteFlood = makeScriptedTransport((_, self) => {
    self.push(initEvent());
    self.push(assistantEvent([{ type: 'tool_use', id: 'toolu_1', name: PERMITTED_TOOLS[3], input: { region: null } }]));
    self.push(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x'.repeat(4096) }] },
      }),
    );
    self.push(JSON.stringify({ type: 'result', session_id: RUN_SESSION, subtype: 'success', is_error: false }));
    self.finish();
  });
  const events2 = await collectRun(
    adapterWith(() => byteFlood, { budgets: { max_tool_turns: 32, max_tool_result_bytes: 128 } }),
    startRunRequest(),
    makeContext(),
  );
  expect(events2.at(-1)!.type).toBe('failed');
  expect(events2.at(-1)!.data?.error_code).toBe('tool_byte_budget_exceeded');

  const stalled = makeScriptedTransport((_, self) => {
    self.push(initEvent());
    // never sends a result and never finishes: only the time budget stops it
  });
  const events3 = await collectRun(
    adapterWith(() => stalled, { runTimeoutMs: 100, budgets: { max_tool_turns: 32, max_tool_result_bytes: 1_000_000 } }),
    startRunRequest(),
    makeContext(),
  );
  expect(events3.at(-1)!.type).toBe('failed');
  expect(events3.at(-1)!.data?.error_code).toBe('tool_time_budget_exceeded');
}, 10_000);

it('cancels without ever claiming a refund and preserves may-have-cost', async () => {
  const transport = makeScriptedTransport((_, self) => {
    self.push(initEvent());
    self.push(assistantEvent([{ type: 'text', text: 'working' }]));
    // hangs until the run is cancelled
  });
  const ctx = makeContext();
  const controller = new AbortController();
  const run = collectRun(adapterWith(() => transport), startRunRequest(), ctx, controller.signal);
  await transport.awaitSend('Audit helmet_state');
  controller.abort();
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
  const transport = makeScriptedTransport((_, self) => {
    self.push(initEvent());
    self.push(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'working' }] },
        proposals: [VALID_DRAFT],
      }),
    );
    // hangs until the run is cancelled; the accumulated draft is still valid
  });
  const ctx = makeContext();
  const controller = new AbortController();
  const run = collectRun(adapterWith(() => transport), startRunRequest(), ctx, controller.signal);
  await transport.awaitSend('Audit helmet_state');
  controller.abort();
  const events = await run;
  expect(events.at(-1)!.type).toBe('cancelled');
  expect(ctx.submitted.length).toBe(1);
  const candidateEvent = events.find((event) => event.type === 'candidate')!;
  expect(candidateEvent.data?.context).toEqual(RUN_CONTEXT);
});

it('surfaces a mid-stream disconnect as a controlled failure without fabricating candidates', async () => {
  const transport = makeScriptedTransport((_, self) => {
    self.push(initEvent());
    self.push(assistantEvent([{ type: 'text', text: 'working' }]));
    self.finish(); // the runtime dies / the pipe drops before a result
  });
  const ctx = makeContext();
  const events = await collectRun(adapterWith(() => transport), startRunRequest(), ctx);
  const terminal = events.at(-1)!;
  expect(terminal.type).toBe('failed');
  expect(terminal.data?.error_code).toBe('claude_disconnected');
  expect(terminal.data?.usage).toEqual({ input_tokens: null, output_tokens: null, cost_usd: null });
  expect(ctx.submitted).toEqual([]);
  expect(events.filter((event) => event.type === 'candidate')).toEqual([]);
});

// ---------------------------------------------------------------------------
// real stdio loop (synthetic fake CLI; NOT Claude Code evidence)
// ---------------------------------------------------------------------------

const FAKE_CLI_SOURCE = `
import { readFileSync, writeFileSync } from 'node:fs';

const scenario = process.argv[2] ?? 'happy';
const prompt = readFileSync(0, 'utf8');
writeFileSync('capture.json', JSON.stringify({
  scenario,
  argv: process.argv.slice(2),
  env_keys: Object.keys(process.env).sort(),
  cwd: process.cwd(),
  prompt,
}));

const proposal = {
  changes: [{
    kind: 'set_attributes',
    change_id: 'change_t23_001',
    object_id: 'object_person_001',
    values: { helmet_state: 'not_wearing' },
    before_hash: 'h1',
    reason: 'synthetic transcript proposal',
  }],
  issues: [],
  score: null,
};

const sessionIndex = process.argv.indexOf('--session-id');
const sessionId = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : '';
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
out({ type: 'system', subtype: 'init', session_id: sessionId, auth_mode: 'subscription', model: 'claude-synthetic-1', tools: [], mcp_servers: [{ name: 'weblabel-agent-tools' }] });
if (scenario === 'disconnect') {
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } });
  process.exit(3);
}
out({ type: 'assistant', message: { content: [{ type: 'text', text: 'auditing' }] } });
out({
  type: 'result',
  session_id: sessionId,
  subtype: 'success',
  is_error: false,
  usage: { input_tokens: 1200, output_tokens: 300 },
  structured_output: proposal,
});
`;

function writeFakeCli(): { harness: string; fakeCli: string } {
  const harness = makeTempDir('t23-stdio-');
  const fakeCli = join(harness, 'fake-cli.mjs');
  writeFileSync(fakeCli, FAKE_CLI_SOURCE);
  return { harness, fakeCli };
}

function stdioHarness(scenario: string): {
  adapter: ProviderAdapter;
  config: ClaudePermissionsConfig;
  harness: string;
} {
  const { harness, fakeCli } = writeFakeCli();
  const config = permissionsConfig({ command: { executable: process.execPath, argv: [fakeCli, scenario] } });
  const schemaPath = join(harness, 'schema.json');
  writeFileSync(schemaPath, '{}');
  const adapter = createClaudeLocalAdapter({
    permissions: config,
    transport: createStdioClaudeTransport,
    imageSource: () => ({ grant_id: 'grant_t23_1', region: null }),
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
  // per-run directory, the prompt and token never appear in argv, the token
  // arrived via env only, and no parent secret crossed the boundary.
  const capturePath = join(resolveRunCwd(config, ctx.run_id), 'capture.json');
  const capture = JSON.parse(readFileSync(capturePath, 'utf8')) as {
    argv: string[];
    env_keys: string[];
    cwd: string;
    prompt: string;
  };
  expect(resolve(capture.cwd)).toBe(resolveRunCwd(config, ctx.run_id));
  expect(capture.argv.join(' ')).not.toContain(RUN_TOKEN);
  expect(capture.argv.join(' ')).not.toContain('Audit helmet_state');
  expect(capture.prompt).toBe('Audit helmet_state for the selected person.');
  expect(capture.env_keys).not.toContain('WEBLABEL_RUN_TOKEN');
  expect(capture.env_keys).toContain('WEBLABEL_API_BASE');
  expect(capture.env_keys).not.toContain('MY_SECRET_TOKEN_X');
  expect(capture.argv).toContain('--session-id');
  const sessionIndex = capture.argv.indexOf('--session-id');
  expect(capture.argv[sessionIndex + 1]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
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

it('surfaces a child that dies mid-stream as a controlled disconnect failure', async () => {
  const { adapter, harness } = stdioHarness('disconnect');
  const ctx = makeContext();
  const events = await collectRun(adapter, startRunRequest(), ctx);
  const terminal = events.at(-1)!;
  expect(terminal.type).toBe('failed');
  expect(terminal.data?.error_code).toBe('claude_disconnected');
  expect(ctx.submitted).toEqual([]);
  expect(JSON.stringify(events)).not.toContain(RUN_TOKEN);
  rmSync(harness, { recursive: true, force: true });
}, 30_000);

// ---------------------------------------------------------------------------
// evidence honesty (task card behavior 5)
// ---------------------------------------------------------------------------

it('keeps protocol-fixture and live evidence flags false (T32 gates)', () => {
  const evidence = claudeEvidenceStatus();
  expect(evidence.docs_verified).toBe(true);
  expect(evidence.protocol_fixture_tested).toBe(false);
  expect(evidence.live_tested).toBe(false);
  // The synthetic suite above is parsing/loop evidence only.
  const state = classifyClaudeState({ auth_mode: 'subscription', model: 'claude-synthetic-1', tools: [], mcp_servers: [], mcp_server_errors: null });
  expect(state.verification).toBe('not_run');
  // A missing mcp_server_errors field is unknown, never "no server failed".
  const init = normalizeClaudeInit({ auth_mode: 'subscription', model: 'm', tools: [], mcp_servers: [{ name: MCP_SERVER_NAME }] });
  expect(init?.mcp_server_errors).toBe(null);
});

// ---------------------------------------------------------------------------
// shared scripted transport / server helpers (synthetic transcripts)
// ---------------------------------------------------------------------------

interface ScriptedTransport extends ClaudeTransport {
  readonly sent: string[];
  push(line: string): void;
  finish(): void;
  /** Resolves once a line containing `match` has actually been sent. */
  awaitSend(match: string): Promise<void>;
}

function makeScriptedTransport(onPrompt?: (prompt: string, self: ScriptedTransport) => void): ScriptedTransport {
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
    sendPrompt(text: string): void {
      sent.push(text);
      onPrompt?.(text, self);
      for (const waiter of [...sendWaiters]) {
        if (text.includes(waiter.match)) {
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

function initEvent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: RUN_SESSION,
    auth_mode: 'subscription',
    model: 'claude-synthetic-1',
    tools: [...PERMITTED_TOOLS],
    mcp_servers: [{ name: MCP_SERVER_NAME }],
    ...overrides,
  });
}

function assistantEvent(content: unknown[]): string {
  return JSON.stringify({ type: 'assistant', message: { content } });
}

/** The scripted "runtime" answers the prompt like a minimal stream-json peer. */
interface ScriptedServerOptions {
  /** Fields merged into the default init event (or use raw lines for full control). */
  init?: Record<string, unknown>;
  /** Raw event lines emitted after init and before the result. */
  events?: string[];
  /** Fields merged into the default result event. */
  result?: Record<string, unknown>;
}

function scriptedServer(options: ScriptedServerOptions = {}): (prompt: string, self: ScriptedTransport) => void {
  return (_, self) => {
    self.push(initEvent(options.init ?? {}));
    for (const line of options.events ?? []) self.push(line);
    self.push(
      JSON.stringify({
        type: 'result', session_id: RUN_SESSION,
        subtype: 'success',
        is_error: false,
        structured_output: VALID_DRAFT,
        ...(options.result ?? {}),
      }),
    );
    self.finish();
  };
}

function permissionsConfig(overrides: Partial<ClaudePermissionsConfig> = {}): ClaudePermissionsConfig {
  return {
    command: { executable: process.execPath, argv: [] },
    mcpCommand: { executable: process.execPath, argv: [join(repoRoot, 'apps', 'agent-host', 'src', 'mcp', 'main.ts')] },
    runRoot: makeTempDir('t23-runroot-'),
    forbiddenCwdRoots: [],
    envAllowlist: ['PATH', 'SystemRoot', 'PATHEXT'],
    source_env: { PATH: 'C:\\synthetic-path', SystemRoot: 'C:\\Windows', PATHEXT: '.EXE', MY_SECRET_TOKEN_X: 'nope' },
    sessionId: RUN_SESSION,
    ...overrides,
  };
}

function adapterWith(
  transport: (plan: ClaudeLaunchPlan) => ClaudeTransport,
  options: Partial<Parameters<typeof createClaudeLocalAdapter>[0]> = {},
): ProviderAdapter {
  return createClaudeLocalAdapter({
    transport,
    imageSource: () => ({ grant_id: 'grant_t23_1' as Id, region: null }),
    runToken: () => RUN_TOKEN,
    ...options,
    permissions: options.permissions ?? permissionsConfig(),
  });
}
