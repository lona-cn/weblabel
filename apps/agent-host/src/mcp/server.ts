/**
 * The T21 stdio MCP server: exactly the five frozen semantic tools from
 * docs/contracts.md C5, proxied to the local API through
 * `POST /internal/agent-tools/{tool}` with a run-scoped bearer token.
 *
 * stdout is protocol-only (the MCP stdio transport); every log line goes to
 * stderr after redaction (T16 `security/redaction`). Image bytes leave as MCP
 * image content blocks — never as host file paths — and the canonical transform
 * travels with them as metadata text.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

import { redactText } from '../security/redaction';
import {
  TOOL_SPECS,
  ToolArgsError,
  isToolName,
  validateToolArgs,
  type ToolArgs,
  type ToolName,
} from './tools';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface AgentToolsServerOptions {
  /** Loopback base URL of the local API, e.g. `http://127.0.0.1:48100`. */
  apiBase: string;
  /** Run-scoped bearer token (from the private child environment only). */
  token: string;
  fetch?: FetchLike;
  log?: (line: string) => void;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

interface ApiAnswer {
  ok: boolean;
  status: number;
  body: string;
}

function errorResult(code: string, message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }],
    isError: true,
  };
}

async function callAgentTools(
  options: AgentToolsServerOptions,
  name: ToolName,
  args: ToolArgs,
): Promise<ApiAnswer> {
  const fetchImpl = options.fetch ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const response = await fetchImpl(`${options.apiBase}/internal/agent-tools/${name}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.token}`,
      },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
    const declared = Number(response.headers.get('content-length') ?? '0');
    const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (declared > maxBytes) {
      return { ok: false, status: response.status, body: 'TOOL_OUTPUT_TOO_LARGE' };
    }
    const body = await response.text();
    if (body.length > maxBytes) {
      return { ok: false, status: response.status, body: 'TOOL_OUTPUT_TOO_LARGE' };
    }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, body: JSON.stringify({ code: 'AGENT_TOOLS_UNREACHABLE', message }) };
  } finally {
    clearTimeout(timeout);
  }
}

function imageResult(answer: ApiAnswer): CallToolResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(answer.body) as Record<string, unknown>;
  } catch {
    return errorResult('AGENT_TOOLS_BAD_RESPONSE', 'read_region did not return JSON');
  }
  const { mime, data_base64, width, height, region, transform_to_canonical } = parsed;
  if (mime !== 'image/png' || typeof data_base64 !== 'string') {
    return errorResult('AGENT_TOOLS_BAD_RESPONSE', 'read_region must return a PNG content block');
  }
  return {
    content: [
      { type: 'image', data: data_base64, mimeType: 'image/png' },
      {
        type: 'text',
        text: JSON.stringify({ mime, width, height, region, transform_to_canonical }),
      },
    ],
  };
}

function apiError(answer: ApiAnswer): CallToolResult {
  if (answer.status === 0 || answer.body === 'TOOL_OUTPUT_TOO_LARGE') {
    return errorResult(
      answer.body === 'TOOL_OUTPUT_TOO_LARGE' ? 'TOOL_OUTPUT_TOO_LARGE' : 'AGENT_TOOLS_UNREACHABLE',
      'the local agent-tools API did not answer within budget',
    );
  }
  try {
    const parsed = JSON.parse(answer.body) as Record<string, unknown>;
    const code = typeof parsed.code === 'string' ? parsed.code : `HTTP_${answer.status}`;
    const message = typeof parsed.message === 'string' ? parsed.message : answer.body;
    return errorResult(code, redactText(message));
  } catch {
    return errorResult(`HTTP_${answer.status}`, redactText(answer.body));
  }
}

/**
 * Builds the standalone MCP server. Tool output is untrusted: every call is
 * validated locally, then re-validated by the service before anything is
 * recorded, and failures surface as controlled `isError` results.
 */
export function createAgentToolsServer(options: AgentToolsServerOptions): Server {
  const log = options.log ?? ((line: string) => process.stderr.write(`${redactText(line)}\n`));
  const server = new Server(
    { name: 'weblabel-agent-tools', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_SPECS.map((spec) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    if (!isToolName(name)) {
      throw new McpError(ErrorCode.InvalidParams, `UNKNOWN_TOOL: ${String(name)}`);
    }
    let args: ToolArgs;
    try {
      args = validateToolArgs(name, request.params.arguments ?? {});
    } catch (error) {
      if (error instanceof ToolArgsError) {
        throw new McpError(ErrorCode.InvalidParams, error.message);
      }
      throw error;
    }
    const answer = await callAgentTools(options, name, args);
    log(`agent-tools ${name} -> ${answer.status}`);
    if (!answer.ok) {
      return apiError(answer);
    }
    if (name === 'read_region') {
      return imageResult(answer);
    }
    return { content: [{ type: 'text', text: answer.body }] };
  });

  return server;
}
