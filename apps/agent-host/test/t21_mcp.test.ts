/**
 * T21: the restricted stdio MCP server with its five frozen semantic tools.
 *
 * Behavior under test (docs/contracts.md C5/C6 and tasks/T21.md):
 *  1. the tool surface is exactly the frozen five; unknown tools and identity
 *     overrides in arguments are rejected;
 *  2. read_region arguments can never name paths/URLs/grants and are strictly
 *     schema-checked (pixel budgets live server-side, see t21_agent_tools.rs);
 *  3. propose_changes is a candidate-only tool; hostile arguments fail closed;
 *  4. prompt injection inside data channels cannot expand the tool surface;
 *  5. pagination, repeated calls, oversized input and empty tool results are
 *     recoverable — including through the real stdio transport.
 */

import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';

import { createAgentToolsServer, type FetchLike } from '../src/mcp/server';
import { TOOL_NAMES, TOOL_SPECS, ToolArgsError, validateToolArgs } from '../src/mcp/tools';
import { readLaunchConfig } from '../src/mcp/main';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '..', '..', '..');
const mainEntry = resolve(testDir, '..', 'src', 'mcp', 'main.ts');
const RUN_TOKEN = 'a'.repeat(64);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: string;
  tool: string;
  authorization: string | null;
  body: unknown;
}

function expectArgsError(tool: string, args: unknown, code: string): void {
  let thrown: unknown = null;
  try {
    validateToolArgs(tool, args);
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `expected ${tool} arguments to be rejected with ${code}`).toBeInstanceOf(
    ToolArgsError,
  );
  expect((thrown as ToolArgsError).code).toBe(code);
}

function stubFetch(
  responder: (tool: string, body: unknown) => { status: number; body: unknown },
): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async fetch(url: string, init: RequestInit): Promise<Response> {
      const body = JSON.parse(String(init.body ?? 'null')) as unknown;
      const headers = new Headers(init.headers);
      const tool = url.split('/').pop() ?? '';
      const call: RecordedCall = {
        url,
        tool,
        authorization: headers.get('authorization'),
        body,
      };
      calls.push(call);
      const answer = responder(tool, body);
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`expected an object, received ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

function contentBlocks(result: unknown): Array<Record<string, unknown>> {
  const content = asRecord(result).content;
  if (!Array.isArray(content)) {
    throw new Error('expected a content block array');
  }
  return content.map((block) => asRecord(block));
}

function textOf(result: unknown): string {
  const blocks = contentBlocks(result);
  const text = blocks.find((block) => block.type === 'text')?.text;
  if (typeof text !== 'string') {
    throw new Error('expected a text content block');
  }
  return text;
}

async function connectedPair(
  responder: (tool: string, body: unknown) => { status: number; body: unknown },
): Promise<{
  client: Client;
  calls: RecordedCall[];
  close: () => Promise<void>;
}> {
  const stub = stubFetch(responder);
  const server = createAgentToolsServer({
    apiBase: 'http://127.0.0.1:48100',
    token: RUN_TOKEN,
    fetch: stub.fetch,
    log: () => {},
  });
  const client = new Client({ name: 't21-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    calls: stub.calls,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const VALID_BBOX = {
  type: 'bbox_xyxy',
  x_min: 1.5,
  y_min: 2.5,
  x_max: 30.5,
  y_max: 40.5,
};

function createChange(changeId: string): Record<string, unknown> {
  return {
    kind: 'create',
    change_id: changeId,
    object: {
      object_id: 'object-1',
      label_id: 'label_person',
      geometry: VALID_BBOX,
      attributes: { helmet_state: 'wearing' },
      origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null },
    },
    before_hash: null,
    reason: 'candidate proposed by the restricted semantic tool',
  };
}

function qualityIssue(issueId: string): Record<string, unknown> {
  return {
    issue_id: issueId,
    object_id: null,
    code: 'suspected_missing_box',
    message: 'the box looks too large',
    region: VALID_BBOX,
  };
}

// ---------------------------------------------------------------------------
// 1) frozen tool surface and hostile arguments
// ---------------------------------------------------------------------------

it('contains no write-through or arbitrary execution tool', () => {
  expect([...TOOL_NAMES].sort()).toEqual([
    'get_context',
    'list_objects',
    'propose_changes',
    'read_region',
    'report_issues',
  ]);
  expect(() =>
    validateToolArgs('read_region', { region: null, path: 'C:\\Users\\secret.txt' }),
  ).toThrow();
});

it('rejects unknown tools and identity or resource overrides', () => {
  for (const hostile of ['accept', 'delete_file', 'shell', 'write_file', 'run_command', 'GET']) {
    expectArgsError(hostile, {}, 'UNKNOWN_TOOL');
    expectArgsError(hostile, { project_id: 'other' }, 'UNKNOWN_TOOL');
  }
  for (const tool of TOOL_NAMES) {
    for (const key of ['project_id', 'run_id', 'asset_revision_id', 'actor_id', 'user_id']) {
      expectArgsError(tool, { [key]: 'anything' }, 'IDENTITY_OVERRIDE');
    }
    for (const key of ['path', 'url', 'file', 'grant_id', 'command', 'argv', 'cwd']) {
      expectArgsError(tool, { [key]: 'anything' }, 'FORBIDDEN_ARGUMENT');
    }
    expectArgsError(tool, 'not-an-object', 'INVALID_ARGUMENTS');
  }
});

it('validates every tool strictly against its frozen schema', () => {
  // Valid arguments pass through untouched.
  expect(validateToolArgs('get_context', {})).toEqual({});
  expect(validateToolArgs('list_objects', { cursor: null, limit: 5 })).toEqual({
    cursor: null,
    limit: 5,
  });
  expect(validateToolArgs('read_region', { region: null })).toEqual({ region: null });
  expect(validateToolArgs('read_region', { region: VALID_BBOX })).toEqual({ region: VALID_BBOX });
  const changes = [createChange('change-1')];
  expect(validateToolArgs('propose_changes', { changes })).toEqual({ changes });
  const issues = [qualityIssue('issue-1')];
  expect(validateToolArgs('report_issues', { issues })).toEqual({ issues });

  // get_context takes nothing at all.
  expectArgsError('get_context', { limit: 1 }, 'INVALID_ARGUMENTS');

  // Pagination bounds come from C5 (limit 1..100, cursor <= 128 chars).
  expectArgsError('list_objects', { limit: 0 }, 'INVALID_ARGUMENTS');
  expectArgsError('list_objects', { limit: 101 }, 'INVALID_ARGUMENTS');
  expectArgsError('list_objects', { limit: 1.5 }, 'INVALID_ARGUMENTS');
  expectArgsError('list_objects', { limit: '10' }, 'INVALID_ARGUMENTS');
  expectArgsError('list_objects', { limit: null }, 'INVALID_ARGUMENTS');
  expectArgsError('list_objects', { cursor: 'x'.repeat(200), limit: 10 }, 'INVALID_ARGUMENTS');

  // read_region only accepts an explicit region with a well-formed bbox.
  expectArgsError('read_region', {}, 'INVALID_ARGUMENTS');
  expectArgsError('read_region', { region: { x_min: 0, y_min: 0, x_max: 1, y_max: 1 } }, 'INVALID_ARGUMENTS');
  expectArgsError('read_region', { region: { ...VALID_BBOX, x_max: 1.5 } }, 'INVALID_REGION');
  expectArgsError('read_region', { region: { ...VALID_BBOX, y_max: 2.5 } }, 'INVALID_REGION');
  expectArgsError('read_region', { region: { ...VALID_BBOX, x_min: Number.NaN } }, 'INVALID_REGION');
  expectArgsError('read_region', { region: { ...VALID_BBOX, extra: 1 } }, 'INVALID_ARGUMENTS');
  expectArgsError('read_region', { region: { ...VALID_BBOX, type: 'url' } }, 'INVALID_ARGUMENTS');

  // Candidate shapes are frozen per change kind.
  expectArgsError('propose_changes', { changes: [] }, 'EMPTY_SUBMISSION');
  expectArgsError('propose_changes', { changes: {} }, 'INVALID_ARGUMENTS');
  expectArgsError(
    'propose_changes',
    { changes: Array.from({ length: 1001 }, (_, index) => createChange(`change-${index}`)) },
    'TOO_MANY_CHANGES',
  );
  const smuggled = { ...createChange('change-2'), execute: 'rm -rf /' };
  expectArgsError('propose_changes', { changes: [smuggled] }, 'INVALID_ARGUMENTS');
  expectArgsError(
    'propose_changes',
    { changes: [{ ...createChange('change-3'), change_id: '' }] },
    'INVALID_ARGUMENTS',
  );
  expectArgsError(
    'propose_changes',
    { changes: [{ ...createChange('change-4'), reason: 'x'.repeat(5000) }] },
    'INVALID_ARGUMENTS',
  );
  const create = createChange('change-5') as Record<string, unknown>;
  const object = create.object as Record<string, unknown>;
  expectArgsError(
    'propose_changes',
    { changes: [{ ...create, object: { ...object, delete: true } }] },
    'INVALID_ARGUMENTS',
  );
  // set_attributes is schema-valid here; only the server can judge the hash.
  const attributeChange = {
    kind: 'set_attributes',
    change_id: 'change-6',
    object_id: 'object-1',
    values: { helmet_state: 'wearing' },
    before_hash: 'a'.repeat(64),
    reason: 'the helmet is visible',
  };
  expect(validateToolArgs('propose_changes', { changes: [attributeChange] })).toEqual({
    changes: [attributeChange],
  });
  expectArgsError(
    'propose_changes',
    {
      changes: [
        {
          kind: 'set_label',
          change_id: 'change-7',
          object_id: 'object-1',
          label_id: 'label_person',
          before_hash: 'a'.repeat(64),
          reason: 'relabel',
          extra: true,
        },
      ],
    },
    'INVALID_ARGUMENTS',
  );

  // Issue shapes are frozen too.
  expectArgsError('report_issues', { issues: [] }, 'EMPTY_SUBMISSION');
  expectArgsError(
    'report_issues',
    { issues: [{ ...qualityIssue('issue-2'), message: 'x'.repeat(5000) }] },
    'INVALID_ARGUMENTS',
  );
  expectArgsError('report_issues', { issues: [{ ...qualityIssue('issue-3'), changes: [] }] }, 'INVALID_ARGUMENTS');
});

it('pins the bearer exfiltration channel to a parsed loopback URL', () => {
  const env = { WEBLABEL_RUN_TOKEN: RUN_TOKEN };
  expect(readLaunchConfig(env).apiBase).toContain('127.0.0.1');
  expect(readLaunchConfig({ ...env, WEBLABEL_API_BASE: 'http://127.0.0.1:8787' }).apiBase).toBe(
    'http://127.0.0.1:8787',
  );
  expect(readLaunchConfig({ ...env, WEBLABEL_API_BASE: 'http://[::1]:8787' }).apiBase).toBe(
    'http://[::1]:8787',
  );
  for (const hostile of [
    'http://127.0.0.1.attacker.example',
    'http://localhost.evil',
    'https://127.0.0.1',
    'http://10.0.0.5',
    'not-a-url',
  ]) {
    expect(() => readLaunchConfig({ ...env, WEBLABEL_API_BASE: hostile }), hostile).toThrow(
      /loopback API/,
    );
  }
});

it('declares strict JSON schemas with additionalProperties false', () => {
  expect(TOOL_SPECS.map((spec) => spec.name).sort()).toEqual([...TOOL_NAMES].sort());
  for (const spec of TOOL_SPECS) {
    const schema = spec.inputSchema as Record<string, unknown>;
    expect(schema.type, spec.name).toBe('object');
    expect(schema.additionalProperties, spec.name).toBe(false);
    expect(Array.isArray(schema.required), spec.name).toBe(true);
    expect(spec.description.length > 20, spec.name).toBe(true);
    expect(spec.description.toLowerCase(), spec.name).toContain('server');
  }
});

// ---------------------------------------------------------------------------
// 2-5) protocol behavior of the real server
// ---------------------------------------------------------------------------

it('proxies the five tools over MCP and delivers images as content blocks', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const imageAnswer = {
    mime: 'image/png',
    width: 2,
    height: 2,
    region: null,
    transform_to_canonical: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    data_base64: png.toString('base64'),
  };
  const pair = await connectedPair((tool) => {
    if (tool === 'read_region') return { status: 200, body: imageAnswer };
    if (tool === 'list_objects') return { status: 200, body: { items: [], next_cursor: null } };
    return { status: 200, body: { run_id: 'run-1', tool } };
  });
  try {
    const listed = await pair.client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of listed.tools) {
      const schema = tool.inputSchema as unknown as Record<string, unknown>;
      expect(schema.type, tool.name).toBe('object');
      expect(schema.additionalProperties, tool.name).toBe(false);
    }

    const context = await pair.client.callTool({ name: 'get_context', arguments: {} });
    expect(JSON.parse(textOf(context))).toEqual({ run_id: 'run-1', tool: 'get_context' });

    const read = await pair.client.callTool({ name: 'read_region', arguments: { region: null } });
    const blocks = contentBlocks(read);
    expect(blocks[0].type).toBe('image');
    expect(blocks[0].mimeType).toBe('image/png');
    expect(blocks[0].data).toBe(png.toString('base64'));
    const metadata = JSON.parse(String(blocks[1].text)) as Record<string, unknown>;
    expect(metadata.transform_to_canonical).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(metadata.region).toBeNull();

    const proposed = await pair.client.callTool({
      name: 'propose_changes',
      arguments: { changes: [createChange('change-10')] },
    });
    expect(JSON.parse(textOf(proposed)).tool).toBe('propose_changes');
    const reported = await pair.client.callTool({
      name: 'report_issues',
      arguments: { issues: [qualityIssue('issue-10')] },
    });
    expect(JSON.parse(textOf(reported)).tool).toBe('report_issues');
    const empty = await pair.client.callTool({
      name: 'list_objects',
      arguments: { cursor: null, limit: 10 },
    });
    expect(JSON.parse(textOf(empty))).toEqual({ items: [], next_cursor: null });

    // Every call is a bearer call against the fixed internal route.
    expect(pair.calls.map((call) => call.tool)).toEqual([
      'get_context',
      'read_region',
      'propose_changes',
      'report_issues',
      'list_objects',
    ]);
    for (const call of pair.calls) {
      expect(call.authorization).toBe(`Bearer ${RUN_TOKEN}`);
      expect(call.url.endsWith(`/internal/agent-tools/${call.tool}`)).toBe(true);
    }
    // The forwarded arguments are exactly what the model passed.
    expect(pair.calls[2].body).toEqual({ changes: [createChange('change-10')] });
  } finally {
    await pair.close();
  }
});

it('turns controlled API failures into isError results and keeps serving', async () => {
  let failing = true;
  const pair = await connectedPair((tool) => {
    if (failing && tool === 'read_region') {
      return {
        status: 401,
        body: { code: 'RUN_TOKEN_EXPIRED', message: 'run token rejected' },
      };
    }
    return { status: 200, body: { run_id: 'run-1', tool } };
  });
  try {
    const denied = await pair.client.callTool({
      name: 'read_region',
      arguments: { region: null },
    });
    expect(asRecord(denied).isError).toBe(true);
    expect(textOf(denied)).toContain('RUN_TOKEN_EXPIRED');

    await expect(
      pair.client.callTool({ name: 'accept', arguments: {} }),
    ).rejects.toThrowError(/UNKNOWN_TOOL/);
    await expect(
      pair.client.callTool({ name: 'delete_file', arguments: { path: 'C:\\secret' } }),
    ).rejects.toThrowError(/UNKNOWN_TOOL/);
    await expect(
      pair.client.callTool({ name: 'shell', arguments: { command: 'whoami' } }),
    ).rejects.toThrowError(/UNKNOWN_TOOL/);
    await expect(
      pair.client.callTool({ name: 'get_context', arguments: { project_id: 'other' } }),
    ).rejects.toThrowError(/IDENTITY_OVERRIDE/);

    failing = false;
    const recovered = await pair.client.callTool({ name: 'get_context', arguments: {} });
    expect(asRecord(recovered).isError).toBeUndefined();
    expect(JSON.parse(textOf(recovered)).run_id).toBe('run-1');
  } finally {
    await pair.close();
  }
});

it('recovers from empty results, repeated calls and oversized input', async () => {
  const pair = await connectedPair((tool) => {
    if (tool === 'list_objects') return { status: 200, body: { items: [], next_cursor: null } };
    return { status: 200, body: { run_id: 'run-1', tool } };
  });
  try {
    const first = await pair.client.callTool({
      name: 'list_objects',
      arguments: { cursor: null, limit: 100 },
    });
    const second = await pair.client.callTool({
      name: 'list_objects',
      arguments: { cursor: null, limit: 100 },
    });
    expect(textOf(first)).toBe(textOf(second));
    expect(JSON.parse(textOf(first))).toEqual({ items: [], next_cursor: null });

    // Oversized input is refused before any request leaves the process.
    const oversized = 'x'.repeat(300_000);
    expectArgsError(
      'report_issues',
      { issues: [{ ...qualityIssue('issue-big'), message: oversized }] },
      'TOO_LARGE',
    );
    const before = pair.calls.length;
    await expect(
      pair.client.callTool({
        name: 'report_issues',
        arguments: { issues: [{ ...qualityIssue('issue-big'), message: oversized }] },
      }),
    ).rejects.toThrowError(/TOO_LARGE/);
    expect(pair.calls.length).toBe(before);

    // The full five-tool sequence still works after empty results and errors.
    await pair.client.callTool({ name: 'get_context', arguments: {} });
    await pair.client.callTool({ name: 'read_region', arguments: { region: null } });
    await pair.client.callTool({
      name: 'propose_changes',
      arguments: { changes: [createChange('change-recovery')] },
    });
    await pair.client.callTool({
      name: 'report_issues',
      arguments: { issues: [qualityIssue('issue-recovery')] },
    });
    const again = await pair.client.callTool({
      name: 'list_objects',
      arguments: { cursor: null, limit: 100 },
    });
    expect(JSON.parse(textOf(again))).toEqual({ items: [], next_cursor: null });
  } finally {
    await pair.close();
  }
});

// ---------------------------------------------------------------------------
// 1-2) the real stdio command
// ---------------------------------------------------------------------------

function writeLoaderHarness(directory: string): string {
  writeFileSync(
    join(directory, 'hooks.mjs'),
    [
      "import { existsSync } from 'node:fs';",
      "import { fileURLToPath } from 'node:url';",
      'export async function resolve(specifier, context, next) {',
      '  try { return await next(specifier, context); }',
      '  catch (error) {',
      "    if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {",
      '      const url = new URL(specifier + \'.ts\', context.parentURL);',
      '      if (existsSync(fileURLToPath(url))) return next(url.href, context);',
      '    }',
      '    throw error;',
      '  }',
      '}',
    ].join('\n'),
  );
  const register = join(directory, 'register.mjs');
  writeFileSync(
    register,
    [
      "import { register } from 'node:module';",
      "register(new URL('./hooks.mjs', import.meta.url));",
    ].join('\n'),
  );
  return register;
}

async function startStubApi(): Promise<{
  base: string;
  calls: RecordedCall[];
  close: () => Promise<void>;
}> {
  const calls: RecordedCall[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const tool = (request.url ?? '').split('/').pop() ?? '';
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') as unknown;
      calls.push({
        url: request.url ?? '',
        tool,
        authorization: request.headers.authorization ?? null,
        body,
      });
      response.setHeader('content-type', 'application/json');
      if (tool === 'read_region') {
        response.end(
          JSON.stringify({
            mime: 'image/png',
            width: 1,
            height: 1,
            region: null,
            transform_to_canonical: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            data_base64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
          }),
        );
      } else if (tool === 'list_objects') {
        response.end(JSON.stringify({ items: [], next_cursor: null }));
      } else {
        response.end(JSON.stringify({ run_id: 'run-stdio', tool }));
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done()))),
  };
}

function childEnvironment(overrides: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === 'string') {
      env[key] = value;
    } else {
      delete env[key];
    }
  }
  return env;
}

it('runs as a real stdio MCP command with the token only in the environment', async () => {
  const harness = mkdtempSync(join(tmpdir(), 't21-mcp-'));
  const register = writeLoaderHarness(harness);
  const api = await startStubApi();
  const env = childEnvironment({
    WEBLABEL_RUN_TOKEN: RUN_TOKEN,
    WEBLABEL_API_BASE: api.base,
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    // `--import` needs a file:// URL; the entry itself is a plain path.
    args: ['--import', pathToFileURL(register).href, mainEntry],
    env,
    stderr: 'pipe',
    cwd: repoRoot,
  });
  // The token travels in env only: argv names files and flags, nothing secret.
  expect(JSON.stringify(['--import', pathToFileURL(register).href, mainEntry])).not.toContain(
    RUN_TOKEN,
  );
  const client = new Client({ name: 't21-stdio-test', version: '0.0.0' });
  let stderr = '';
  const stderrStream = transport.stderr as Readable | null;
  stderrStream?.setEncoding('utf8');
  stderrStream?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    const context = await client.callTool({ name: 'get_context', arguments: {} });
    expect(JSON.parse(textOf(context))).toEqual({ run_id: 'run-stdio', tool: 'get_context' });
    const read = await client.callTool({ name: 'read_region', arguments: { region: null } });
    expect(contentBlocks(read)[0].type).toBe('image');
    const empty = await client.callTool({
      name: 'list_objects',
      arguments: { cursor: null, limit: 100 },
    });
    expect(JSON.parse(textOf(empty))).toEqual({ items: [], next_cursor: null });
    for (const call of api.calls) {
      expect(call.authorization).toBe(`Bearer ${RUN_TOKEN}`);
    }
  } finally {
    await client.close();
    await api.close();
  }
  expect(stderr).toContain('weblabel-agent-tools');
  expect(stderr).not.toContain(RUN_TOKEN);
  rmSync(harness, { recursive: true, force: true });
}, 30_000);

it('refuses to start without a run token in the child environment', async () => {
  const harness = mkdtempSync(join(tmpdir(), 't21-mcp-notoken-'));
  const register = writeLoaderHarness(harness);
  const child = spawn(process.execPath, ['--import', pathToFileURL(register).href, mainEntry], {
    cwd: repoRoot,
    env: childEnvironment({ WEBLABEL_RUN_TOKEN: undefined, WEBLABEL_API_BASE: undefined }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((done) => child.on('exit', done));
  expect(code).toBe(2);
  expect(stderr).toContain('WEBLABEL_RUN_TOKEN');
  expect(stderr).not.toContain('Bearer');
  rmSync(harness, { recursive: true, force: true });
}, 30_000);

it('bounds chunked multibyte tool responses by bytes and cancels before buffering the tail', async () => {
  let cancelled = false;
  let pulls = 0;
  let signal: AbortSignal | null = null;
  const server = createAgentToolsServer({apiBase:'http://127.0.0.1:48100', token:RUN_TOKEN, maxResponseBytes:8,
    fetch: async (_url, init) => {
      signal = init.signal as AbortSignal;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new TextEncoder().encode('界界界'));
          if (pulls === 20) controller.close();
        },
        cancel() { cancelled = true; },
      }, {highWaterMark:0}));
    }});
  const client = new Client({name:'boundary-client', version:'0.0.0'});
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  try {
    const result = await client.callTool({name:'get_context', arguments:{}});
    expect(asRecord(result).isError).toBe(true);
    expect(textOf(result)).toContain('TOOL_OUTPUT_TOO_LARGE');
    expect(pulls).toBe(1);
    expect(cancelled).toBe(true);
    expect(signal!.aborted).toBe(true);
  } finally { await client.close(); await server.close(); }
});

it('rejects an oversized chunked response through the actual stdio MCP caller and closes its HTTP stream', async () => {
  const harness = mkdtempSync(join(tmpdir(), 't21-mcp-boundary-'));
  const register = writeLoaderHarness(harness);
  let sent = 0;
  const chunk = Buffer.from('界'.repeat(256 * 1024));
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const api = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    const timer = setInterval(() => {
      sent += chunk.byteLength;
      response.write(chunk);
      if (sent >= chunk.byteLength * 64) { clearInterval(timer); response.end(); }
    }, 5);
    response.on('close', () => { clearInterval(timer); resolveClosed(); });
  });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  const transport = new StdioClientTransport({command:process.execPath,
    args:['--import', pathToFileURL(register).href, mainEntry],
    env:childEnvironment({WEBLABEL_RUN_TOKEN:RUN_TOKEN, WEBLABEL_API_BASE:
      'http://127.0.0.1:' + (api.address() as AddressInfo).port}),
    stderr:'pipe', cwd:repoRoot});
  const client = new Client({name:'boundary-stdio', version:'0.0.0'});
  try {
    await client.connect(transport);
    const result = await client.callTool({name:'get_context', arguments:{}});
    expect(asRecord(result).isError).toBe(true);
    expect(textOf(result)).toContain('TOOL_OUTPUT_TOO_LARGE');
    await closed;
    expect(sent).toBeLessThan(chunk.byteLength * 64);
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve()));
    rmSync(harness, {recursive:true, force:true});
  }
}, 30_000);

it('cancels a silent response body on timeout and returns a controlled MCP error', async () => {
  let cancelled = false;
  const server = createAgentToolsServer({apiBase:'http://127.0.0.1:48100',token:RUN_TOKEN,timeoutMs:25,
    fetch:async () => new Response(new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => {}); }, cancel() { cancelled = true; },
    }))});
  const client = new Client({name:'boundary-timeout',version:'0.0.0'});
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct),server.connect(st)]);
  try {
    const result = await client.callTool({name:'get_context',arguments:{}});
    expect(asRecord(result).isError).toBe(true);
    expect(textOf(result)).toContain('AGENT_TOOLS_UNREACHABLE');
    expect(cancelled).toBe(true);
  } finally { await client.close(); await server.close(); }
});
