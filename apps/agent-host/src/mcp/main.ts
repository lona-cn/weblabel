/**
 * Entry point of the standalone stdio MCP command installed for Codex/Claude
 * (docs/contracts.md C5). The run-scoped bearer token is read from the private
 * child environment only — never from argv, tool arguments or config files —
 * and stdout stays protocol-only; logs go to stderr after redaction.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { redactText } from '../security/redaction';
import { createAgentToolsServer } from './server';

export const RUN_TOKEN_ENV = 'WEBLABEL_RUN_TOKEN';
export const API_BASE_ENV = 'WEBLABEL_API_BASE';
/** Matches `ServerConfig::default()` of the local service (loopback only). */
export const DEFAULT_API_BASE = 'http://127.0.0.1:48100';

export interface LaunchConfig {
  token: string;
  apiBase: string;
}

export function readLaunchConfig(env: Record<string, string | undefined>): LaunchConfig {
  const token = env[RUN_TOKEN_ENV];
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(`${RUN_TOKEN_ENV} is required in the child environment`);
  }
  const apiBase = env[API_BASE_ENV];
  if (apiBase !== undefined) {
    // The token's exfil channel is pinned to the loopback API: parse the URL
    // and require a real loopback host, never a string-prefix match.
    let parsed: URL;
    try {
      parsed = new URL(apiBase);
    } catch {
      throw new Error(`${API_BASE_ENV} must be an absolute URL of the loopback API`);
    }
    const loopbackHosts = ['127.0.0.1', 'localhost', '[::1]', '::1'];
    if (parsed.protocol !== 'http:' || !loopbackHosts.includes(parsed.hostname)) {
      throw new Error(`${API_BASE_ENV} must point at the loopback API`);
    }
  }
  return { token, apiBase: apiBase ?? DEFAULT_API_BASE };
}

export async function main(): Promise<number> {
  let config: LaunchConfig;
  try {
    config = readLaunchConfig(process.env);
  } catch (error) {
    process.stderr.write(
      `${redactText(error instanceof Error ? error.message : String(error))}\n`,
    );
    return 2;
  }
  const server = createAgentToolsServer({ apiBase: config.apiBase, token: config.token });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('weblabel-agent-tools: ready (run-scoped token in effect)\n');
  await new Promise<void>((finished) => {
    server.onclose = () => finished();
    const stop = () => {
      void server.close();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  return 0;
}

const entryPath = process.argv[1];
const invokedDirectly =
  typeof entryPath === 'string' &&
  import.meta.url.toLowerCase() === pathToFileURL(resolve(entryPath)).href.toLowerCase();

if (invokedDirectly) {
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(
        `${redactText(error instanceof Error ? error.message : String(error))}\n`,
      );
      process.exitCode = 1;
    },
  );
}
