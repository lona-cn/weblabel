import { expect, it } from 'vitest';
import { ProviderRegistry } from '../src/registry';
import { planImageInputs } from '../src/providers/http/images';
import { providerDispatch } from '../src/runtime/dispatch';

it('rejects unknown profiles without running another adapter', async () => {
  const registry = new ProviderRegistry();
  await expect(registry.resolve('unknown')).rejects.toMatchObject({ code: 'unknown_model' });
});

it('plans crop-only input without requesting a full image', () => {
  const crop = { type: 'bbox_xyxy' as const, x_min: 1, y_min: 2, x_max: 10, y_max: 12 };
  const input = { context: { selected_object_ids: [] } } as never;
  const document = { objects: [] } as never;
  expect(planImageInputs(input, document, 4, { allow_image: true, approved_image_region: crop })).toEqual([
    { kind: 'crop', region: crop, object_id: null },
  ]);
  expect(planImageInputs(input, document, 4, { allow_image: false, approved_image_region: null })).toEqual([]);
});

// Engineering smoke: real Node host + bounded synthetic loopback protocol only.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

for (const scenario of ['success', 'denied', 'timeout', 'changed_model', 'changed_budget'] as const) {
  it('real Node host dispatch: ' + scenario, async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'weblabel-runtime-'));
    const token = 'a'.repeat(64);
    let proposals = 0;
    let models = 0;
    let imageReads = 0;
    let submitted: unknown;
    const ontology = JSON.parse(readFileSync(resolve('tests/fixtures/golden/ontology.json'), 'utf8'));
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (req.url?.startsWith('/internal/')) {
        expect(req.headers.authorization).toBe('Bearer ' + token);
        res.setHeader('content-type', 'application/json');
        if (scenario === 'denied') { res.writeHead(403); res.end(JSON.stringify({ code: 'RUN_SCOPE_DENIED' })); return; }
        if (req.url.endsWith('/get_context')) res.end(JSON.stringify({ run_id: 'run-smoke', media: { width: 200, height: 200 }, ontology, allow_image: false, allow_object_context: false, approved_grant_ids: [], approved_image_region: null }));
        else if (req.url.endsWith('/propose_changes')) { proposals++; submitted = body; res.end(JSON.stringify({ suggestion_set_id: 'set-smoke', prediction_id: 'prediction-smoke', state: 'pending' })); }
        else { imageReads++; res.writeHead(403); res.end(JSON.stringify({ code: 'NO_DATA_SCOPE' })); }
      } else {
        models++;
        expect(req.headers.authorization).toBe('Bearer synthetic-engineering-key');
        expect(body.model).toBe('synthetic-engineering-model');
        expect(JSON.stringify(body.messages)).not.toContain('data:image');
        if (scenario === 'timeout') return;
        res.setHeader('content-type', 'text/event-stream');
        res.end(readFileSync(resolve('apps/agent-host/test/fixtures/http/mimo-stream-text-create.sse'), 'utf8'));
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const apiBase = 'http://127.0.0.1:' + port;
    const configPath = join(temporary, 'host.json');
    const capabilities = { image_input: true, tools: true, structured_output: true, bbox_output: true, attributes: true };
    const executionConfig = { profile_id: 'profile-smoke', model_id: 'synthetic-engineering-model', account_model_verified: true, credential: { secret_ref: 'env:SYNTHETIC_KEY' }, capabilities, api_base: apiBase, base_approval: { approved: true, approved_by: 'engineering-admin', approved_at: '2026-10-06T00:00:00Z', allow_private_network: true, allow_insecure_http: true }, local_admins: ['engineering-admin'] };
    const hostConfig = { ...executionConfig, ...(scenario === 'changed_model' ? {model_id: 'unapproved-model'} : {}), ...(scenario === 'changed_budget' ? {budgets: {max_tool_turns: 500}} : {}) };
    writeFileSync(configPath, JSON.stringify({ apiBase, timeoutMs: scenario === 'timeout' ? 150 : 1500, providers: [{ provider: 'mimo_api', config: hostConfig }] }));
    const child = spawn(process.execPath, [resolve(process.env.WEBLABEL_T30_HOST_SCRIPT ?? "target/agent-host/runtime.mjs")], { cwd: temporary, env: { SystemRoot: process.env.SystemRoot, WEBLABEL_HOST_CONFIG: configPath, WEBLABEL_RUN_TOKEN: token, SYNTHETIC_KEY: "synthetic-engineering-key" }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const request = { operation_id: 'op-smoke', profile_id: 'profile-smoke', context: { project_id: 'project_golden', asset_revision_id: 'asset_revision_golden', annotation_revision_id: 'revision-smoke', ontology_version_id: 'ontology_v1', canonical_sha256: 'c'.repeat(64), draft_generation: 1, selected_object_ids: [], object_hashes: {}, input_fingerprint: 'fingerprint-smoke' }, intent: 'detect', prompt: 'Engineering synthetic scene only.', consent_id: null };
    const profile = { profile_id: request.profile_id, provider_id: 'mimo_api', model_id: 'synthetic-engineering-model', auth_kind: 'api_key', capabilities, availability: 'ready', verification: 'not_run', runtime_version: null, verified_at: null };
    const envelope = (id: string, method: string, payload: unknown) => JSON.stringify({ protocol_version: 1, id, kind: 'request', method, payload }) + '\n';
    try {
      child.stdin.write(envelope('probe', 'probe', {}));
      child.stdin.write(envelope('start', 'start_run', { run_id: 'run-smoke', request, profile, execution_profile_config: executionConfig, profile_configuration_hash: 'approved-config-hash' }));
      const deadline = Date.now() + 3000;
      let terminal: any;
      while (!terminal) {
        await new Promise(resolve => setTimeout(resolve, 10));
        terminal = stdout.trim().split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).find(message => message?.id === 'start');
        if (Date.now() > deadline) throw new Error('No terminal response: ' + stderr);
      }
      if (scenario === 'success') { expect(terminal.payload).toMatchObject({ ok: true, status: 'succeeded' }); expect(proposals).toBe(1); expect(submitted).toMatchObject({ changes: [{ kind: 'create', object: { label_id: 'label_person' } }] }); }
      if (scenario === 'denied') { expect(terminal.payload).toMatchObject({ ok: false, error: { code: 'RUN_SCOPE_DENIED' } }); expect(models).toBe(0); expect(proposals).toBe(0); }
      if (scenario === 'timeout') { expect(terminal.payload.status).toBe('timeout'); expect(models).toBe(1); expect(proposals).toBe(0); }
      if (scenario === 'changed_model' || scenario === 'changed_budget') { expect(terminal.payload).toMatchObject({ ok: false, error: { code: 'profile_configuration_changed' } }); expect(models).toBe(0); expect(proposals).toBe(0); }
      expect(imageReads).toBe(0);
      expect(stdout + stderr).not.toContain(token);
      child.stdin.end();
      await new Promise<void>((resolve, reject) => { child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr))); });
    } finally {
      if (child.exitCode === null && child.signalCode === null) { const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill(); await exited; }
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgentToolsServer } from '../src/mcp/server';
it('never exposes private approved execution configuration through provider MCP tools', async () => {
  const server = createAgentToolsServer({ apiBase: 'http://127.0.0.1:40001', token: 'a'.repeat(64), log: () => {}, fetch: async () => new Response(JSON.stringify({ run_id: 'private-smoke', intent: 'detect', execution_profile_config: { endpoint: 'private-runtime-sentinel', credential: {secret_ref: 'env:PRIVATE_KEY'} }, profile_configuration_hash: 'private-config-hash' }), {status: 200}) });
  const client = new Client({name: 'privacy-smoke', version: '1.0'});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({name: 'get_context', arguments: {}});
    expect(JSON.stringify(result)).not.toContain('private-runtime-sentinel');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_KEY');
    expect(JSON.stringify(result)).not.toContain('private-config-hash');
    expect(JSON.parse((result.content as Array<{text: string}>)[0].text)).toEqual({run_id: 'private-smoke', intent: 'detect'});
  } finally { await client.close(); await server.close(); }
});


it('real Host rejects retired JSON configuration before context or model execution', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'weblabel-retired-'));
  const configPath = join(temporary, 'host.json');
  let calls = 0;
  const server = createServer((_request, response) => { calls++; response.end('{}'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const apiBase = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  writeFileSync(configPath, JSON.stringify({ apiBase, timeoutMs: 1500, providers: [{ provider: 'codex_local', config: {} }] }));
  const child = spawn(process.execPath, [resolve(process.env.WEBLABEL_T30_HOST_SCRIPT ?? 'target/agent-host/runtime.mjs')], { cwd: temporary, env: { SystemRoot: process.env.SystemRoot, WEBLABEL_HOST_CONFIG: configPath, WEBLABEL_RUN_TOKEN: 'a'.repeat(64) }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  try {
    child.stdin.end();
    expect(await exited).not.toBe(0);
    expect(stderr).toContain('PROVIDER_RETIRED');
    expect(stdout).toBe('');
    expect(calls).toBe(0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(temporary, { recursive: true, force: true });
  }
});

it('rejects a cached retired payload before opening runtime context', async () => {
  const dispatch = providerDispatch({ apiBase: 'http://127.0.0.1:1', timeoutMs: 100, providers: [] }, 'synthetic');
  const events = dispatch({request: {profile_id: 'retired'}, profile: {profile_id: 'retired', provider_id: 'codex_local'}}, new AbortController().signal);
  await expect(events[Symbol.asyncIterator]().next()).rejects.toMatchObject({code: 'PROVIDER_RETIRED'});
});
