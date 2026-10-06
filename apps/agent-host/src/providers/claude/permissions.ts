//! Hardened launch plan and tool policy for the official Claude Code headless
//! CLI (docs/contracts.md C5, ADR 0001, docs/provider-compatibility.md).
//!
//! PINNED FLAGS: every CLI flag used here is confirmed verbatim by the captured
//! `claude --help` of the installed 2.1.183 runtime (reports/T23/claude-help.txt).
//! Nothing else is ever passed. In particular:
//!   - `--bare` is NEVER used: it drops subscription OAuth and switches to
//!     API-key billing (verified help text), which would disguise an API call
//!     as this subscription channel;
//!   - `--dangerously-skip-permissions` / `--allow-dangerously-skip-permissions`
//!     are NEVER used: the allow/deny policy must stay enforceable;
//!   - built-in tools are disabled entirely (`--tools ""`, verified help text),
//!     only this project's MCP server is loaded (`--mcp-config` +
//!     `--strict-mcp-config`), and only its five C5 semantic tools are
//!     auto-approved (`--allowedTools`), with a deny rule over the execution
//!     surface (`--disallowedTools`);
//!   - user/project settings bleed-through is restricted with
//!     `--setting-sources local` and `--no-session-persistence` (pinned
//!     semantics: T32 must verify which files each source loads);
//!   - the run-scoped MCP token travels via the child environment and the
//!     0600-mode generated MCP config file — never argv, never prompt, never
//!     output; credential environment names can never be allowlisted.
//!
//! The generated MCP config shape (`mcpServers.<name>.{command,args,env}`) is a
//! project pin over the documented `--mcp-config` JSON file form; T32 must
//! validate it against the version-pinned runtime.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { TOOL_NAMES } from '../../mcp/tools';

export class ClaudePermissionError extends Error {
  readonly code: string;

  constructor(code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'ClaudePermissionError';
    this.code = code;
  }
}

export const MCP_SERVER_NAME = 'weblabel-agent-tools';
export const RUN_TOKEN_ENV = 'WEBLABEL_RUN_TOKEN';
export const API_BASE_ENV = 'WEBLABEL_API_BASE';
export const DEFAULT_API_BASE = 'http://127.0.0.1:48100';

/** `mcp__<server>__<tool>` naming for the frozen T21 surface (pin: T32 revalidate). */
export function mcpToolName(tool: string): string {
  return `mcp__${MCP_SERVER_NAME}__${tool}`;
}

export const PERMITTED_TOOLS: readonly string[] = [...TOOL_NAMES].map(mcpToolName);

/**
 * Deny-rule defense in depth over the built-in execution/edit/network surface.
 * The authoritative restriction is `--tools ""` (all built-ins disabled); these
 * names are denied again explicitly and never auto-approved. Denying a name the
 * runtime does not expose is an idempotent no-op.
 */
export const DENIED_BUILTIN_TOOLS: readonly string[] = [
  'Bash',
  'Edit',
  'Write',
  'Read',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Glob',
  'Grep',
  'Task',
];

export interface ClaudeToolPolicy {
  /** Auto-approved tools; must be exactly the frozen project MCP surface. */
  allowed_tools: readonly string[];
  /** Extra deny rules; the project's own five tools may never be denied. */
  denied_tools: readonly string[];
}

/** The candidate draft contract for `--json-schema` structured output. The
 * strict per-change validation is authoritative in ../http/errors.ts; this
 * schema only shapes the transport-level envelope (project pin: T32 must
 * verify how the pinned runtime reports structured output). */
export const CANDIDATE_JSON_SCHEMA = JSON.stringify({
  type: 'object',
  additionalProperties: false,
  required: ['changes'],
  properties: {
    changes: { type: 'array', items: { type: 'object' } },
    issues: { type: 'array', items: { type: 'object' } },
    score: { type: ['number', 'null'] },
  },
});

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TOOL_NAME_LENGTH = 128;
/** Plugin/module-injection vectors can never be allowlisted into the child. */
const DENIED_ENV_NAMES: Record<string, true> = {
  NODE_OPTIONS: true,
  WEBLABEL_RUN_TOKEN: true,
  // Credential channels: this profile is the user's official subscription
  // login. Letting an API key or OAuth token into the child would silently
  // switch billing and could disguise an API call as a subscription run.
  ANTHROPIC_API_KEY: true,
  ANTHROPIC_AUTH_TOKEN: true,
  CLAUDE_CODE_OAUTH_TOKEN: true,
};

function rejected(code: string, detail: string): ClaudePermissionError {
  return new ClaudePermissionError(code, detail);
}

function validToolName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOOL_NAME_LENGTH;
}

function assertCommandSpec(spec: { executable: string; argv: readonly string[] }, label: string, runToken: string): void {
  if (typeof spec.executable !== 'string' || spec.executable.length === 0 || spec.executable.includes('\0')) {
    throw rejected('executable_invalid', `${label} executable must be a non-empty string without NUL bytes`);
  }
  for (const entry of spec.argv) {
    if (typeof entry !== 'string' || entry.includes('\0') || entry.includes('\n') || entry.includes('\r')) {
      throw rejected('argv_invalid', `${label} argv entries must be single-line strings`);
    }
    // Argv prefixes are literal paths/values: a leading dash would inject an
    // extra CLI flag, and the run token must never ride in argv.
    if (entry.startsWith('-')) {
      throw rejected('argv_flag_injection', `${label} argv must not contain CLI flags: ${entry}`);
    }
    if (runToken.length > 0 && entry.includes(runToken)) {
      throw rejected('token_in_argv', 'the run-scoped token travels via child environment only, never argv');
    }
  }
  if (runToken.length > 0 && spec.executable.includes(runToken)) {
    throw rejected('token_in_argv', 'the run-scoped token travels via child environment only, never argv');
  }
}

function canonicalDir(target: string, label: string): string {
  if (typeof target !== 'string' || target.length === 0 || !isAbsolute(target)) {
    throw rejected(`${label}_untrusted`, 'must be an absolute path');
  }
  if (!existsSync(target)) throw rejected(`${label}_missing`, target);
  return realpathSync(target);
}

function dirContains(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/**
 * The tool allow/deny policy for one run. Broad execution permissions are
 * rejected outright: `allowed_tools` must be exactly this project's frozen MCP
 * surface (the five T21 tools), and nothing else — no wildcards, no built-in
 * execution/edit/network tools, no third-party MCP tools.
 */
export function validateClaudeToolPolicy(input: unknown): ClaudeToolPolicy {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw rejected('tool_policy_invalid', 'the tool policy must be an object');
  }
  const record = input as { allowed_tools?: unknown; denied_tools?: unknown };
  if (!Array.isArray(record.allowed_tools)) {
    throw rejected('tool_policy_invalid', 'allowed_tools must be an array of tool names');
  }
  const allowed: string[] = [];
  for (const entry of record.allowed_tools) {
    if (!validToolName(entry)) {
      throw rejected('tool_policy_invalid', 'allowed_tools entries must be non-empty tool name strings');
    }
    if (entry.includes('*')) {
      throw rejected('tool_policy_wildcard', `wildcard tool permissions are never allowed: ${entry}`);
    }
    if (DENIED_BUILTIN_TOOLS.includes(entry)) {
      throw rejected('tool_policy_execution_tool', `execution/edit tools are never auto-approved: ${entry}`);
    }
    if (!PERMITTED_TOOLS.includes(entry)) {
      throw rejected('tool_policy_unknown_tool', `only this project's MCP tools may be auto-approved: ${entry}`);
    }
    if (allowed.includes(entry)) {
      throw rejected('tool_policy_invalid', `duplicated tool permission: ${entry}`);
    }
    allowed.push(entry);
  }
  if (allowed.length !== PERMITTED_TOOLS.length) {
    throw rejected('tool_policy_incomplete', 'the frozen five-tool MCP surface must be auto-approved exactly');
  }
  const denied: string[] = [];
  if (record.denied_tools !== undefined) {
    if (!Array.isArray(record.denied_tools)) {
      throw rejected('tool_policy_invalid', 'denied_tools must be an array of tool names');
    }
    for (const entry of record.denied_tools) {
      if (!validToolName(entry)) {
        throw rejected('tool_policy_invalid', 'denied_tools entries must be non-empty tool name strings');
      }
      if (entry.includes('*')) {
        throw rejected('tool_policy_wildcard', `wildcard deny rules could swallow the project MCP surface: ${entry}`);
      }
      if (PERMITTED_TOOLS.includes(entry)) {
        throw rejected('tool_policy_denies_own_surface', `this project's frozen tools may never be denied: ${entry}`);
      }
      denied.push(entry);
    }
  }
  return { allowed_tools: allowed, denied_tools: denied };
}

export interface ClaudeCommandSpec {
  executable: string;
  /** Argv prefix before the generated flag list (e.g. a node script in tests). */
  argv: readonly string[];
}

export interface ClaudePermissionsConfig {
  /** Fixed executable (and optional prefix argv) of the official CLI. */
  command: ClaudeCommandSpec;
  /** This project's own MCP stdio entry (apps/agent-host/src/mcp/main.ts). */
  mcpCommand: ClaudeCommandSpec;
  /** Private root for per-run working directories. */
  runRoot: string;
  /** Roots that must never become a run cwd (user repositories, the workspace). */
  forbiddenCwdRoots: readonly string[];
  /** Explicit minimal parent-environment allowlist. */
  envAllowlist: readonly string[];
  /** Where allowlisted values are read from (defaults to process.env). */
  source_env?: Record<string, string | undefined>;
  /** Loopback API base for the run-scoped MCP channel. */
  apiBase?: string;
  /** Requested model id or alias; null lets the runtime default apply. */
  model?: string | null;
  /**
   * Pinned run session id (passed via the verified `--session-id` flag). Tests
   * and integration fixtures pin it for deterministic event scoping; production
   * generates a fresh UUID per run.
   */
  sessionId?: string;
  /** Tool policy override; defaults to exactly the frozen MCP surface. */
  toolPolicy?: unknown;
}

export interface ClaudeMcpServerConfig {
  name: string;
  command: string;
  argv: readonly string[];
  env: Record<string, string>;
}

export interface ClaudeLaunchPlan {
  command: { executable: string; argv: string[] };
  cwd: string;
  env: Record<string, string>;
  /** Exactly one entry in run mode; empty for the session-free version probe. */
  mcpServers: readonly ClaudeMcpServerConfig[];
  /** Path of the generated 0600 MCP config file referenced by --mcp-config. */
  mcpConfigPath: string | null;
  toolPolicy: ClaudeToolPolicy;
  model: string | null;
  /** This run's conversation id, passed via the verified --session-id flag. */
  sessionId: string;
  mode: 'run' | 'version_probe';
}

/** The per-run cwd: strictly inside the private run root, never a user repo. */
export function resolveRunCwd(config: ClaudePermissionsConfig, run_id: string): string {
  if (typeof run_id !== 'string' || !RUN_ID_PATTERN.test(run_id) || run_id.includes('..')) {
    throw rejected('run_id_invalid', 'run ids must be simple path-safe identifiers');
  }
  return resolve(config.runRoot, run_id);
}

function buildEnv(
  config: ClaudePermissionsConfig,
  apiBase: string,
): Record<string, string> {
  const source = config.source_env ?? process.env;
  const sourceKeys = new Map<string, string>();
  for (const key of Object.keys(source)) sourceKeys.set(key.toLowerCase(), key);
  const env: Record<string, string> = {};
  for (const name of config.envAllowlist) {
    if (!ENV_NAME.test(name)) throw rejected('env_name_invalid', name);
    if (DENIED_ENV_NAMES[name.toUpperCase()] === true) {
      throw rejected('env_denied', `${name} can inject modules or credentials and is never allowed`);
    }
    const sourceKey = sourceKeys.get(name.toLowerCase());
    const value = sourceKey === undefined ? undefined : source[sourceKey];
    if (typeof value === 'string') env[name] = value;
  }
  env[API_BASE_ENV] = apiBase;
  return env;
}

function prepareCwd(config: ClaudePermissionsConfig, run_id: string): string {
  const cwd = resolveRunCwd(config, run_id);
  const canonicalRunRoot = canonicalDir(config.runRoot, 'run_root');
  const canonicalForbidden = [...config.forbiddenCwdRoots].map((root) => canonicalDir(root, 'forbidden_root'));
  // Create the per-run directory up front and canonicalize it: a pre-existing
  // symlink at runRoot/<run_id> can never redirect the run cwd past the
  // forbidden-root or run-root containment checks.
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const canonicalCwd = realpathSync(cwd);
  if (
    !dirContains(canonicalRunRoot, canonicalCwd) ||
    canonicalForbidden.some((root) => dirContains(root, canonicalRunRoot) || dirContains(root, canonicalCwd))
  ) {
    throw rejected('cwd_forbidden', 'the run cwd must never be the user repository or workspace');
  }
  return cwd;
}

/**
 * Builds the full run launch plan, failing closed on every boundary violation:
 * forbidden cwd roots, injection through model/argv/executable, a token anywhere
 * in argv, denied environment names (credentials, module injection) and a tool
 * policy that is not exactly the frozen surface. The prompt is never part of the
 * plan: it travels via stdin only.
 */
export function buildClaudeLaunchPlan(
  config: ClaudePermissionsConfig,
  options: { run_id: string; runToken: string; apiBase: string },
): ClaudeLaunchPlan {
  const toolPolicy = validateClaudeToolPolicy(config.toolPolicy ?? { allowed_tools: PERMITTED_TOOLS });
  const cwd = prepareCwd(config, options.run_id);
  const { runToken } = options;
  if (typeof runToken !== 'string' || runToken.length === 0) {
    throw rejected('token_invalid', 'a run-scoped token is required');
  }
  const model = config.model ?? null;
  if (model !== null && (typeof model !== 'string' || !MODEL_PATTERN.test(model))) {
    // A model name is passed as its own argv element after --model; anything
    // shaped like a flag or a shell fragment is refused outright.
    throw rejected('model_invalid', 'model ids and aliases must be simple name-shaped strings');
  }
  assertCommandSpec(config.command, 'command', runToken);
  assertCommandSpec(config.mcpCommand, 'mcp_command', runToken);

  const apiBase = config.apiBase ?? DEFAULT_API_BASE;
  const env = buildEnv(config, apiBase);
  const sessionId = config.sessionId ?? randomUUID();
  if (!SESSION_ID.test(sessionId)) {
    throw rejected('session_id_invalid', 'the run session id must be a UUID');
  }

  // The MCP config file is the only place the token appears outside the child
  // environment: written 0600 inside the private run cwd and referenced by
  // path so no credential ever reaches argv or the prompt.
  const mcpConfigPath = join(cwd, 'mcp-config.json');
  const mcpServer: ClaudeMcpServerConfig = {
    name: MCP_SERVER_NAME,
    command: config.mcpCommand.executable,
    argv: [...config.mcpCommand.argv],
    env: { [RUN_TOKEN_ENV]: runToken, [API_BASE_ENV]: apiBase },
  };
  writeFileSync(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: {
        [MCP_SERVER_NAME]: { command: mcpServer.command, args: mcpServer.argv, env: mcpServer.env },
      },
    }),
    { mode: 0o600 },
  );

  const argv = [
    ...config.command.argv,
    '-p',
    '--output-format',
    'stream-json',
    '--input-format',
    'text',
    '--mcp-config',
    mcpConfigPath,
    '--strict-mcp-config',
    '--tools',
    '',
    '--allowedTools',
    [...toolPolicy.allowed_tools].join(','),
    '--disallowedTools',
    [...DENIED_BUILTIN_TOOLS, ...toolPolicy.denied_tools].join(','),
    '--setting-sources',
    'local',
    '--no-session-persistence',
    '--json-schema',
    CANDIDATE_JSON_SCHEMA,
    ...(model === null ? [] : ['--model', model]),
    '--session-id',
    sessionId,
  ];
  return {
    command: { executable: config.command.executable, argv },
    cwd,
    env,
    mcpServers: [mcpServer],
    mcpConfigPath,
    toolPolicy,
    model,
    sessionId,
    mode: 'run',
  };
}

/**
 * The only probe plan: the verified session-free `--version` surface. It never
 * carries `-p`, a prompt, MCP config or a session id, so probing can never
 * start a model session, load servers or touch the network.
 */
export function buildVersionProbePlan(
  config: ClaudePermissionsConfig,
  options: { run_id: string },
): ClaudeLaunchPlan {
  const cwd = prepareCwd(config, options.run_id);
  assertCommandSpec(config.command, 'command', '');
  return {
    command: { executable: config.command.executable, argv: [...config.command.argv, '--version'] },
    cwd,
    env: buildEnv(config, config.apiBase ?? DEFAULT_API_BASE),
    mcpServers: [],
    mcpConfigPath: null,
    toolPolicy: validateClaudeToolPolicy({ allowed_tools: PERMITTED_TOOLS }),
    model: config.model ?? null,
    sessionId: '',
    mode: 'version_probe',
  };
}
