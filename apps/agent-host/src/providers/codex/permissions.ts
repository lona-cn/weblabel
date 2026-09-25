//! Hardened launch plan for the official Codex CLI (docs/contracts.md C5,
//! ADR 0001, docs/provider-compatibility.md):
//!
//! - only this project's MCP server (`weblabel-agent-tools`) and its five C5
//!   semantic tools are attached — no third-party MCP config, no plugin
//!   loading, no experimental API surface;
//! - the documented out-of-sandbox methods (`thread/shellCommand`,
//!   `process/spawn`) are never sendable;
//! - the run cwd is a private per-run directory under a private root and is
//!   never the user's repository or this workspace (fail closed);
//! - the environment is a minimal explicit allowlist — never the whole user
//!   config; NODE-style module injection is denied outright;
//! - the run-scoped MCP token is delivered via the child environment only and
//!   is refused in argv and executable paths; the MCP server receives it only
//!   through its own environment entry in the injected launch recipe.
//!
//! The CLI launch recipe itself (`command`) is injected configuration: this
//! module never invents CLI flags. The pinned MCP-config shape is project-side
//! and must be validated against the generated schema in T32.

import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { TOOL_NAMES } from '../../mcp/tools';
import {
  FORBIDDEN_METHODS,
  INITIALIZE_METHOD,
  INITIALIZED_METHOD,
  THREAD_START_METHOD,
  TURN_INTERRUPT_METHOD,
  TURN_START_METHOD,
} from './protocol';

export class CodexPermissionError extends Error {
  readonly code: string;

  constructor(code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'CodexPermissionError';
    this.code = code;
  }
}

export const MCP_SERVER_NAME = 'weblabel-agent-tools';
export const RUN_TOKEN_ENV = 'WEBLABEL_RUN_TOKEN';
export const API_BASE_ENV = 'WEBLABEL_API_BASE';
export const DEFAULT_API_BASE = 'http://127.0.0.1:48100';

export interface CodexCommandSpec {
  executable: string;
  argv: string[];
}

export interface CodexPermissionsConfig {
  /** Fixed launch recipe for the official CLI; supplied by config, never invented here. */
  command: CodexCommandSpec;
  /** This project's own MCP stdio entry (apps/agent-host/src/mcp/main.ts). */
  mcpCommand: CodexCommandSpec;
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
}

export interface CodexMcpServerConfig {
  name: string;
  command: string;
  argv: readonly string[];
  env: Record<string, string>;
}

export interface CodexLaunchPlan {
  command: CodexCommandSpec;
  cwd: string;
  env: Record<string, string>;
  mcpServers: readonly [CodexMcpServerConfig];
  permittedMethods: readonly string[];
  permittedTools: readonly string[];
  experimentalApi: false;
}

const PERMITTED_METHODS: readonly string[] = [
  INITIALIZE_METHOD,
  INITIALIZED_METHOD,
  THREAD_START_METHOD,
  TURN_START_METHOD,
  TURN_INTERRUPT_METHOD,
];
/** Plugin/module-injection vectors can never be allowlisted into the child. */
const DENIED_ENV_NAMES: Record<string, true> = { NODE_OPTIONS: true };
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function canonicalDir(target: string, label: string): string {
  if (typeof target !== 'string' || target.length === 0 || !isAbsolute(target)) {
    throw new CodexPermissionError(`${label}_untrusted`, 'must be an absolute path');
  }
  if (!existsSync(target)) throw new CodexPermissionError(`${label}_missing`, target);
  return realpathSync(target);
}

function dirContains(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** The per-run cwd: strictly inside the private run root, never a user repo. */
export function resolveRunCwd(config: CodexPermissionsConfig, run_id: string): string {
  if (typeof run_id !== 'string' || !RUN_ID_PATTERN.test(run_id) || run_id.includes('..')) {
    throw new CodexPermissionError('run_id_invalid', 'run ids must be simple path-safe identifiers');
  }
  return resolve(config.runRoot, run_id);
}

/**
 * Builds the full launch plan, failing closed on every boundary violation:
 * forbidden cwd roots, a token anywhere in argv, denied environment names, or
 * a method/tool list that is not exactly the pinned surface.
 */
export function buildLaunchPlan(
  config: CodexPermissionsConfig,
  options: { run_id: string; runToken: string; apiBase: string },
): CodexLaunchPlan {
  const cwd = resolveRunCwd(config, options.run_id);
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
    throw new CodexPermissionError('cwd_forbidden', 'the run cwd must never be the user repository or workspace');
  }
  const { runToken } = options;
  if (typeof runToken !== 'string' || runToken.length === 0) {
    throw new CodexPermissionError('token_invalid', 'a run-scoped token is required');
  }
  const argvText = [...config.command.argv, ...config.mcpCommand.argv, config.command.executable, config.mcpCommand.executable];
  if (argvText.some((entry) => typeof entry === 'string' && entry.includes(runToken))) {
    throw new CodexPermissionError('token_in_argv', 'the run-scoped token travels via child environment only, never argv');
  }

  const source = config.source_env ?? process.env;
  const sourceKeys = new Map<string, string>();
  for (const key of Object.keys(source)) sourceKeys.set(key.toLowerCase(), key);
  const env: Record<string, string> = {};
  for (const name of config.envAllowlist) {
    if (!ENV_NAME.test(name)) throw new CodexPermissionError('env_name_invalid', name);
    if (DENIED_ENV_NAMES[name.toUpperCase()] === true) {
      throw new CodexPermissionError('env_denied', `${name} can inject modules/plugins and is never allowed`);
    }
    const sourceKey = sourceKeys.get(name.toLowerCase());
    const value = sourceKey === undefined ? undefined : source[sourceKey];
    if (typeof value === 'string') env[name] = value;
  }
  env[RUN_TOKEN_ENV] = runToken;
  env[API_BASE_ENV] = options.apiBase;

  if (PERMITTED_METHODS.some((method) => FORBIDDEN_METHODS.includes(method))) {
    throw new CodexPermissionError('method_not_permitted', 'the permitted method list must never include out-of-sandbox methods');
  }
  return {
    command: { executable: config.command.executable, argv: [...config.command.argv] },
    cwd,
    env,
    mcpServers: [
      {
        name: MCP_SERVER_NAME,
        command: config.mcpCommand.executable,
        argv: [...config.mcpCommand.argv],
        env: { [RUN_TOKEN_ENV]: runToken, [API_BASE_ENV]: options.apiBase },
      },
    ],
    permittedMethods: PERMITTED_METHODS,
    permittedTools: [...TOOL_NAMES],
    experimentalApi: false,
  };
}

/**
 * Out-of-sandbox methods are refused before any plan lookup: the allowlist is
 * the only other way in, so nothing experimental can leak through.
 */
export function isMethodPermitted(plan: CodexLaunchPlan, method: string): boolean {
  if (FORBIDDEN_METHODS.includes(method)) return false;
  return plan.permittedMethods.includes(method);
}
