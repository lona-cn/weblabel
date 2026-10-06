import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readFile, mkdtemp, mkdir, symlink, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { GrantStore } from '../src/security/grants';
import { BoundedHttpClient } from '../src/providers/http/client';
import { createAgentToolsServer } from '../src/mcp/server';
import { startSecurityApp, raw, text, object, root, type SecurityApp } from '../../../tests/fixtures/security/harness';
import { attacks, injectionImage, injectionText } from '../../../tests/fixtures/security/attacks';
import { buildHost, runHost, maliciousSse, toolSse, type SyntheticProviderId } from '../../../tests/fixtures/security/host';
import { authorize, type Seeded } from '../../../tests/support/t25-ai';
import { seedSecurity, startSecurityRun as startRunBody, syntheticProfileId } from '../../../tests/fixtures/security/seed';

let app: SecurityApp;
let seeded: Seeded;
let modelServer: Server;
let modelBase: string;
let selectedTool = 'read_file';
let selectedArgs: unknown = { path: '.secret' };
let selectedProvider: SyntheticProviderId = 'mimo_api';
let observedTurnServed = false;
const providerCalls: Array<{ headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }> = [];
let executionConfig: Record<string, unknown>;
const capabilities = { image_input: true, tools: true, structured_output: true, bbox_output: false, attributes: true };
const modelEvidence: Array<Record<string, unknown>> = [];
beforeAll(async () => {
  buildHost(); app = await startSecurityApp(); seeded = await seedSecurity(app.admin.client, app);
  const image = await injectionImage();
  await writeFile(join(root, 'reports/T29/injection-image.png'), image);
  const uploaded = await app.admin.client.upload(`/api/projects/${seeded.projectId}/assets`, image, 'synthetic-injection.png', randomUUID(), 'image/png'); expect(uploaded.status).toBe(202);
  expect((await app.admin.client.request('POST', '/internal/test/jobs/drain', {})).status).toBe(200);
  const listed = await app.admin.client.request('GET', `/api/projects/${seeded.projectId}/assets`);
  const items = object(listed.json).items;
  if (!Array.isArray(items)) throw new Error('Missing imported image list');
  const media = items.map(object).find(item => item.asset_revision_id !== seeded.assetRevisionId)!;
  seeded = { ...seeded, assetRevisionId: text(media, 'asset_revision_id'), canonicalSha256: text(media, 'canonical_sha256') };
  const head = await app.admin.client.request('GET', `/api/assets/${seeded.assetRevisionId}/annotation?ontology_version_id=${seeded.ontologyId}`);
  seeded.annotationRevisionId = text(head.json, 'annotation_revision_id');
  modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    providerCalls.push({ headers: request.headers, body: object(JSON.parse(Buffer.concat(chunks).toString())) });
    const credential = request.headers.authorization?.replace(/^Bearer /, '') ?? request.headers['x-api-key'];
    if (typeof credential !== 'string') throw new Error('Synthetic provider did not receive a credential');
    if (selectedTool === 'sse_name' || (selectedTool === 'sse_id_after_usage' && !observedTurnServed)) {
      observedTurnServed = true;
      response.setHeader('content-type', 'text/event-stream');
      response.end(toolSse(selectedProvider, selectedTool === 'sse_name' ? credential : 'read_region', credential, selectedTool === 'sse_name' ? {} : { region: null }));
      return;
    }
    if (selectedTool === 'http_error' || selectedTool === 'sse_id_after_usage') {
      response.writeHead(502, { 'content-type': 'text/plain' });
      response.end('Untrusted provider diagnostic echoed ' + credential);
      return;
    }
    response.setHeader('content-type', 'text/event-stream'); response.end(maliciousSse(selectedTool, selectedArgs));
  });
  await new Promise<void>(resolveListening => modelServer.listen(0, '127.0.0.1', resolveListening));
  const address = modelServer.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  modelBase = `http://127.0.0.1:${address.port}`;
  executionConfig = { profile_id: syntheticProfileId, model_id: 'T29-synthetic-model', credential: { secret_ref: 'env:T29_SYNTHETIC_KEY' }, capabilities, account_model_verified: true, api_base: modelBase, base_approval: { approved: true, approved_by: 'T29-engineering-admin', approved_at: '2026-10-06T00:00:00Z', allow_private_network: true, allow_insecure_http: true }, local_admins: ['T29-engineering-admin'] };
  configureProfile('mimo_api');
  expect((await app.admin.client.request('PUT', `/api/projects/${seeded.projectId}/external-processing-policy`, { allow_external_processing: true })).status).toBe(200);
}, 120_000);
afterAll(async () => {
  if (modelServer) { modelServer.closeAllConnections(); await new Promise<void>(resolveClosed => modelServer.close(() => resolveClosed())); }
  if (app) await app.stop();
  await writeFile(join(root, 'reports/T29/model-evidence.json'), JSON.stringify({ channel: 'synthetic_loopback_engineering', providers: ['openai_api', 'anthropic_api', 'mimo_api'], model_id: 'T29-synthetic-model', verification: 'not_run', live: 'not_run', software_gpu: 'not_run', hardware_gpu: 'not_run', cases: modelEvidence }, null, 2) + '\n');
});
function configureProfile(provider: SyntheticProviderId): void {
  const db = new DatabaseSync(join(app.directory, 'api.sqlite'));
  try { db.prepare("UPDATE model_profiles SET provider_id=?,model_id='T29-synthetic-model',auth_kind=?,verification='not_run',config_json=?,capabilities_json=?,secret_ref='env:T29_SYNTHETIC_KEY' WHERE profile_id=?").run(provider, provider === 'codex_local' ? 'official_user_login' : 'api_key', JSON.stringify(executionConfig), JSON.stringify(capabilities), syntheticProfileId); }
  finally { db.close(); }
}
async function authorizedRun() {
  const request = await authorize(app.admin.client, startRunBody(seeded, randomUUID(), injectionText, { intent: 'audit_attributes' }));
  const started = await app.admin.client.request('POST', '/api/ai/runs', request); expect(started.status, JSON.stringify(started.json)).toBe(202);
  const runId = text(started.json, 'run_id'); const token = await app.issue(runId, seeded.projectId);
  const db = new DatabaseSync(join(app.directory, 'api.sqlite'));
  try {
    const row = object(db.prepare('SELECT profile_snapshot_json FROM model_runs WHERE run_id=?').get(runId));
    return { request, runId, token, profile: object(JSON.parse(text(row, 'profile_snapshot_json'))) };
  } finally { db.close(); }
}

it.each(attacks)('image/text injection requesting $tool fails at actual Host and final API permission boundary', async attack => {
  selectedTool = attack.tool; selectedArgs = attack.args;
  const { request, runId, token, profile } = await authorizedRun();
  const secret = `T29-synthetic-secret-${randomUUID()}`;
  const before = await app.admin.client.request('GET', `/api/assets/${seeded.assetRevisionId}/annotation?ontology_version_id=${seeded.ontologyId}`);
  const result = await runHost({ directory: app.directory, apiBase: app.base_url, token, secret, provider: 'mimo_api', config: executionConfig, runId, request, profile });
  expect(result.exitCode).toBe(0); expect(result.terminal).toMatchObject({ ok: false, status: 'failed', error: { code: 'invalid_tool_call' } });
  expect(result.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'failed', data: expect.objectContaining({ error_code: 'invalid_tool_call' }) })]));
  const sent = providerCalls.at(-1)!;
  expect(sent.headers.authorization).toBe(`Bearer ${secret}`);
  expect(JSON.stringify(sent.body.messages)).toContain(injectionText);
  const messages = sent.body.messages; if (!Array.isArray(messages)) throw new Error('Missing model messages');
  const imageUrls = messages.flatMap(message => { const content = object(message).content; return Array.isArray(content) ? content.filter(part => object(part).type === 'image_url').map(part => text(object(part).image_url, 'url')) : []; });
  expect(imageUrls).toHaveLength(1);
  const png = Buffer.from(imageUrls[0]!.split(',', 2)[1]!, 'base64');
  expect(await sharp(png).metadata()).toMatchObject({ format: 'png', width: 800, height: 160 });
  expect(createHash('sha256').update(png).digest('hex')).toBe(seeded.canonicalSha256);
  const finalDenial = await raw(app.base_url, 'POST', `/internal/agent-tools/${attack.tool}`, attack.args, { authorization: `Bearer ${token}` });
  expect(finalDenial.status).toBe(404); expect(finalDenial.json.code).toBe('UNKNOWN_TOOL');
  const smuggled = await raw(app.base_url, 'POST', '/internal/agent-tools/read_region', { region: null, path: '.secret' }, { authorization: `Bearer ${token}` });
  expect(smuggled.status).toBe(400); expect(smuggled.json.code).toBe('FORBIDDEN_ARGUMENT');
  const humanRoute = await raw(app.base_url, 'POST', '/api/reviews/T29-synthetic-review/decision', { decision: 'approve', reason: injectionText, revision_ids: [seeded.annotationRevisionId] }, { authorization: `Bearer ${token}` });
  expect(humanRoute.status).toBe(401); expect(humanRoute.json.code).toBe('UNAUTHENTICATED');
  const after = await app.admin.client.request('GET', `/api/assets/${seeded.assetRevisionId}/annotation?ontology_version_id=${seeded.ontologyId}`);
  expect(after.json).toEqual(before.json);
  const db = new DatabaseSync(join(app.directory, 'api.sqlite'));
  try {
    expect(db.prepare('SELECT COUNT(*) AS count FROM predictions WHERE run_id=?').get(runId)).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM review_decisions').get()).toEqual({ count: 0 });
  } finally { db.close(); }
  expect(await readFile(join(app.directory, '.secret'), 'utf8')).toBe(secret);
  expect(result.shellExecuted).toBe(false);
  for (const output of [result.stdout, result.stderr, app.logs(), JSON.stringify(finalDenial.json), JSON.stringify(smuggled.json)]) {
    expect(output).not.toContain(secret); expect(output).not.toContain(token);
  }
  modelEvidence.push({ requested_tool: attack.tool, prompt_sha256: createHash('sha256').update(injectionText).digest('hex'), canonical_image_sha256: seeded.canonicalSha256, provider_request_sha256: createHash('sha256').update(JSON.stringify(sent.body)).digest('hex'), provider_response_sha256: createHash('sha256').update(maliciousSse(attack.tool, attack.args)).digest('hex'), host_exit_code: result.exitCode, terminal: result.terminal, final_tool_denial: { status: finalDenial.status, code: finalDenial.json.code }, forbidden_argument_denial: { status: smuggled.status, code: smuggled.json.code }, human_approval_denial: { status: humanRoute.status, code: humanRoute.json.code }, annotation_unchanged: true, shell_executed: result.shellExecuted, public_output_contains_credentials: false });
});
const apiThreats = (['openai_api', 'anthropic_api', 'mimo_api'] as const).flatMap(provider => (['http_error', 'sse_name', 'sse_id_after_usage'] as const).map(scenario => ({ provider, scenario })));
it.each(apiThreats)('actual $provider Host refuses credential reflection through $scenario and preserves usage', async ({ provider, scenario }) => {
  selectedTool = scenario; selectedProvider = provider; observedTurnServed = false; configureProfile(provider);
  try {
    const { request, runId, token, profile } = await authorizedRun();
    const secret = `T29-arbitrary-credential-${randomUUID()}`;
    const firstCall = providerCalls.length;
    const result = await runHost({ directory: app.directory, apiBase: app.base_url, token, secret, provider, config: executionConfig, runId, request, profile });
    const code = scenario === 'sse_name' ? 'invalid_tool_call' : 'upstream_5xx';
    const usage = { input_tokens: scenario === 'http_error' ? null : 17, output_tokens: scenario === 'http_error' ? null : 5, cost_usd: null };
    expect(result.terminal).toMatchObject({ ok: false, status: 'failed', error: { code } });
    expect(result.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'failed', data: expect.objectContaining({ error_code: code, usage, cost_display: 'unknown' }) })]));
    expect(result.exitCode).toBe(0);
    const calls = providerCalls.slice(firstCall);
    expect(calls).toHaveLength(scenario === 'sse_id_after_usage' ? 2 : 1);
    for (const sent of calls) expect(provider === 'anthropic_api' ? sent.headers['x-api-key'] : sent.headers.authorization).toBe(provider === 'anthropic_api' ? secret : `Bearer ${secret}`);
    expect(result.stdout).not.toContain(secret); expect(result.stderr).not.toContain(secret);
    expect(result.stdout + result.stderr).not.toContain(token);
    modelEvidence.push({ attack: scenario, provider_id: provider, profile, provider_request_sha256: calls.map(sent => createHash('sha256').update(JSON.stringify(sent.body)).digest('hex')), host_exit_code: result.exitCode, terminal: result.terminal, failed_event: result.events.find(event => event.type === 'failed'), public_output_contains_credentials: false });
  } finally { configureProfile('mimo_api'); }
});
it('MCP revalidates hostile arguments and propagates authoritative expired-token refusal', async () => {
  const { runId } = await authorizedRun(); const expired = await app.issue(runId, seeded.projectId, 0);
  const server = createAgentToolsServer({ apiBase: app.base_url, token: expired, log: () => {} });
  const client = new Client({ name: 'T29-synthetic-attacker', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    await expect(client.callTool({ name: 'shell', arguments: { command: 'echo forbidden' } })).rejects.toThrow(/UNKNOWN_TOOL/);
    await expect(client.callTool({ name: 'read_region', arguments: { region: null, path: '.secret' } })).rejects.toThrow(/FORBIDDEN_ARGUMENT/);
    const denied = await client.callTool({ name: 'get_context', arguments: {} });
    expect(denied.isError).toBe(true); expect(JSON.stringify(denied.content)).toContain('RUN_TOKEN_EXPIRED');
    expect(JSON.stringify(denied)).not.toContain(expired);
  } finally { await client.close(); await server.close(); }
});
it('production Codex dispatch stays UNSUPPORTED_RUNTIME without launching a fake official SDK', async () => {
  configureProfile('codex_local');
  try {
    const { request, runId, token, profile } = await authorizedRun(); const calls = providerCalls.length;
    const result = await runHost({ directory: app.directory, apiBase: app.base_url, token, secret: `T29-synthetic-${randomUUID()}`, provider: 'codex_local', config: executionConfig, runId, request, profile });
    expect(result.exitCode).toBe(0); expect(result.terminal).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_RUNTIME' } });
    expect(providerCalls.length).toBe(calls); expect(result.shellExecuted).toBe(false);
  } finally { configureProfile('mimo_api'); }
});

it('grant filesystem containment rejects real junction/symlink escape and portable path bypasses', async () => {
  const directory = await mkdtemp(join(tmpdir(), 't29-grant-')); const stage = join(directory, 'stage'); const outside = join(directory, 'other-project');
  await mkdir(stage); await mkdir(outside); const secret = `T29-synthetic-${randomUUID()}`;
  await writeFile(join(outside, '.secret'), secret); await writeFile(join(stage, 'approved.png'), await injectionImage());
  try {
    // Windows junction does not need symlink privilege. POSIX creates a real
    // symlink; neither is replaced by a mock or skipped on permission failure.
    await symlink(outside, join(stage, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const grants = new GrantStore(); const grant = grants.issue({ run_id: 'T29-run', project_id: 'T29-project', media_hash: 'T29-media-hash', root: stage });
    const binding = { run_id: grant.run_id, project_id: grant.project_id, media_hash: grant.media_hash };
    expect(grants.resolve(grant.grant_id, { ...binding, relative_path: 'approved.png' })).toBe(await realpath(join(stage, 'approved.png')));
    expect(() => grants.resolve(grant.grant_id, { ...binding, relative_path: 'escape/.secret' })).toThrow(/grant_path_escape/);
    for (const path of ['../other-project/.secret', '..\\other-project\\.secret', 'C:outside.secret', 'C:\\outside.secret', '\\\\synthetic-server\\share\\.secret', '/other-project/.secret']) {
      expect(() => grants.resolve(grant.grant_id, { ...binding, relative_path: path })).toThrow(/grant_path_(traversal|absolute)/);
    }
    expect(() => grants.resolve(grant.grant_id, { ...binding, project_id: 'foreign-project', relative_path: 'approved.png' })).toThrow(/grant_binding_mismatch/);
    grants.revokeRun(binding.run_id);
    expect(() => grants.resolve(grant.grant_id, { ...binding, relative_path: 'approved.png' })).toThrow(/unknown_grant/);
    expect(await readFile(join(outside, '.secret'), 'utf8')).toBe(secret);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it.each(['loopback', 'metadata', 'unapproved-domain'] as const)('bounded HTTP rejects %s redirects and never forwards Authorization cross-origin', async target => {
  const captured: Array<string | undefined> = []; const attempts: string[] = [];
  const sink = createServer((request, response) => { captured.push(request.headers.authorization); response.end('forbidden'); });
  await new Promise<void>(resolveListening => sink.listen(0, '127.0.0.1', resolveListening));
  const sinkAddress = sink.address(); if (!sinkAddress || typeof sinkAddress === 'string') throw new Error('Missing sink address');
  const sinkUrl = `http://127.0.0.1:${sinkAddress.port}/stolen`;
  const location = target === 'loopback' ? sinkUrl : target === 'metadata' ? 'http://169.254.169.254/latest/meta-data' : 'https://unapproved.invalid/steal';
  const originalAuthorization: Array<string | undefined> = [];
  const original = createServer((request, response) => { originalAuthorization.push(request.headers.authorization); response.writeHead(307, { location }); response.end(); });
  await new Promise<void>(resolveListening => original.listen(0, '127.0.0.1', resolveListening));
  const address = original.address(); if (!address || typeof address === 'string') throw new Error('Missing source address');
  const base = `http://127.0.0.1:${address.port}`; const secret = `T29-synthetic-redirect-${randomUUID()}`;
  try {
    const client = new BoundedHttpClient({ provider_id: 'openai_api', api_base: base, local_admins: ['T29-admin'], base_approval: { approved: true, approved_by: 'T29-admin', approved_at: '2026-10-06T00:00:00Z', allow_private_network: true, allow_insecure_http: true }, fetch_impl: async (url, init) => {
      attempts.push(url);
      // A test-only network guard prevents even a regressed implementation from
      // contacting metadata or public networks; the approved source is real HTTP.
      if (url !== base + '/responses' || init.redirect !== 'manual') throw new Error('T29 external-network guard');
      return fetch(url, init);
    } });
    await expect(client.send('/responses', { headers: { authorization: `Bearer ${secret}` }, body: '{}' })).rejects.toMatchObject({ code: 'redirect_rejected', status: 307 });
    const frames: unknown[] = [];
    await expect((async () => { for await (const frame of client.sendStream('/responses', { headers: { authorization: `Bearer ${secret}` }, body: '{}' })) frames.push(frame); })()).rejects.toMatchObject({ code: 'redirect_rejected', status: 307 });
    expect(originalAuthorization).toEqual([`Bearer ${secret}`, `Bearer ${secret}`]);
    expect(captured).toEqual([]); expect(frames).toEqual([]);
    expect(attempts).toEqual([base + '/responses', base + '/responses']);
  } finally {
    for (const server of [original, sink]) { server.closeAllConnections(); await new Promise<void>(resolveClosed => server.close(() => resolveClosed())); }
  }
});
it.each(['https://127.0.0.1/admin', 'https://169.254.169.254/latest/meta-data', 'https://unapproved.invalid', 'file:///synthetic/.secret'])('unapproved provider endpoint %s fails without network', async api_base => {
  let fetched = false;
  const client = new BoundedHttpClient({ provider_id: 'openai_api', api_base, fetch_impl: async () => { fetched = true; throw new Error('No external traffic allowed'); } });
  await expect(client.send('/responses', { headers: {}, body: '{}' })).rejects.toMatchObject({ code: 'base_not_approved' });
  expect(fetched).toBe(false);
});
