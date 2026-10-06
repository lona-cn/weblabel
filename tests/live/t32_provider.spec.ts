import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootstrap_admin_for_test, database_path_for_test, start_test_app } from '../support/app';
import { authorize, seed, startRunBody, type JsonObject, type Seeded } from '../support/t25-ai';
import { hostExecutionConfigurationHash, lockedFilesDiagnostic, observeRun, readHostBudget, requireObservedIdentity, requirePreviewExecutionConfiguration } from '../../scripts/verify-live.mjs';
import type { ApiClient, TestApp } from '../support/app';

// ENGINEERING consumer/negative-path tests. No live provider, account, GPU or
// prediction evidence is generated here. These tests cannot satisfy G4.
const root = resolve(import.meta.dirname, '../..');
let directory: string;
beforeAll(async () => { directory = await mkdtemp(resolve(root, 'reports/T32/interactive-closure/engineering-')); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
interface DiagnosticChannel {
  provider_id: string;
  status: string;
  actual_provider: string | null;
  full_model_id: string | null;
  response_id: string | null;
  tried_probe?: { worker_probe?: unknown };
  missing_prerequisites: string[];
}
interface Diagnostic {
  status: string;
  channels: DiagnosticChannel[];
  outbound_model_calls?: number | null;
  run_error?: string;
}
async function cli(args: string[]) {
  return new Promise<{ exit: number | null; stdout: string; stderr: string; report: Diagnostic }>((resolveResult, reject) => {
    execFile(process.execPath, ['scripts/verify-live.mjs', ...args], {
      cwd: root, timeout: 60_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, OPENAI_API_KEY: 'engineering-never-read-secret', WEBLABEL_LIVE_SESSION_COOKIE: 'engineering-never-read-session' },
    }, (error, stdout, stderr) => {
      const exit = error ? typeof error.code === 'number' ? error.code : null : 0;
      if (exit === null) { reject(error); return; }
      resolveResult({ exit, stdout, stderr, report: JSON.parse(stdout) as Diagnostic });
    });
  });
}
function authorization() {
  return { provider_id: 'openai_api', sample_set: 't32-programmatic-v1', allow_generated_images: true, allow_external_processing: true, expires_at: new Date(Date.now() + 300_000).toISOString(), max_model_runs: 2, max_provider_calls_per_run: 2, acknowledge_unknown_cost: true };
}
function configuration() {
  return { base_url: 'http://127.0.0.1:49332/', provider_id: 'openai_api', profile_id: 't32-openai', model_id: 'gpt-6-luna', host_config_path: '', authorization: authorization() };
}
async function runConfig(body: unknown) {
  const file = resolve(directory, `${randomUUID()}.json`);
  await writeFile(file, JSON.stringify(body));
  return cli(['--run', '--config', relative(root, file)]);
}
async function hostFile(overrides: JsonObject = {}) {
  const file = resolve(directory, `${randomUUID()}.json`);
  await writeFile(file, JSON.stringify({ apiBase: 'http://127.0.0.1:49332', providers: [{ provider: 'openai_api', config: { profile_id: 't32-openai', model_id: 'gpt-6-luna', credential: { secret_ref: 'env:OPENAI_API_KEY' }, budgets: { max_tool_turns: 2, max_total_bytes: 65536, max_run_ms: 10000, max_output_tokens: 512, max_image_bytes: 1048576, max_pixels: 1000000, max_crops: 1 }, ...overrides } }], timeoutMs: 10000 }));
  return relative(root, file);
}

describe('T32 engineering CLI consumer gates (NOT live)', () => {
  it('default and required entry both return five independent blocked channels without inspecting secrets', async () => {
    for (const args of [[], ['--check-required']]) {
      const result = await cli(args);
      expect(result.exit).toBe(2);
      expect(result.report.status).toBe('blocked');
      expect(result.report.channels.map(item => item.provider_id)).toEqual(['codex_local', 'claude_local', 'openai_api', 'mimo_api', 'detector_local']);
      for (const channel of result.report.channels) {
        expect(channel.status).toBe('blocked');
        expect(channel.actual_provider).toBeNull();
        expect(channel.full_model_id).toBeNull();
        expect(channel.response_id).toBeNull();
        expect(channel.missing_prerequisites.length).toBeGreaterThan(0);
      }
      expect(result.report.channels.find(channel => channel.provider_id === 'detector_local')?.tried_probe?.worker_probe).toBe('not_run');
      expect(result.report.outbound_model_calls).toBe(0);
      expect(result.stdout + result.stderr).not.toContain('engineering-never-read');
    }
  });
  it('run without configuration is a nonzero refusal, not a no-op success', async () => {
    const result = await cli(['--run']);
    expect(result.exit).toBe(2);
    expect(result.report.run_error).toBe('RUN_CONFIGURATION_REQUIRED');
    expect(result.report.channels.every(item => item.status === 'blocked')).toBe(true);
  });
  it.each([
    ['mock cannot substitute', { provider_id: 'mock' }, 'REQUIRED_CHANNEL_ONLY_NO_SUBSTITUTION'],
    ['Anthropic API cannot substitute Claude subscription', { provider_id: 'anthropic_api' }, 'REQUIRED_CHANNEL_ONLY_NO_SUBSTITUTION'],
    ['alias cannot substitute full ID', { model_id: 'luna' }, 'FULL_MODEL_ID_REQUIRED'],
    ['other OpenAI model cannot satisfy Luna', { model_id: 'gpt-other' }, 'OFFICIAL_FULL_LUNA_ID_REQUIRED'],
    ['root development port refused', { base_url: 'http://127.0.0.1:5173/' }, 'OWN_LOOPBACK_ORIGIN_REQUIRED_ROOT_PORTS_FORBIDDEN'],
    ['root preview port refused', { base_url: 'http://127.0.0.1:4174/' }, 'OWN_LOOPBACK_ORIGIN_REQUIRED_ROOT_PORTS_FORBIDDEN'],
    ['remote service refused', { base_url: 'https://example.com/' }, 'OWN_LOOPBACK_ORIGIN_REQUIRED_ROOT_PORTS_FORBIDDEN'],
    ['inline credentials refused', { api_key: 'engineering-never-read-secret' }, 'INVALID_RUN_CONFIGURATION'],
  ])('%s before service dispatch', async (_name, mutation, code) => {
    const result = await runConfig({ ...configuration(), ...mutation });
    expect(result.exit).toBe(2);
    expect(result.report.run_error).toBe(code);
    expect(result.stdout).not.toContain('engineering-never-read-secret');
  });
  it.each([
    ['expired authorization', { expires_at: '2020-01-01T00:00:00Z' }, 'AUTHORIZATION_EXPIRED_OR_WINDOW_EXCEEDS_TEN_MINUTES'],
    ['overlong window', { expires_at: new Date(Date.now() + 3600000).toISOString() }, 'AUTHORIZATION_EXPIRED_OR_WINDOW_EXCEEDS_TEN_MINUTES'],
    ['wrong provider scope', { provider_id: 'mimo_api' }, 'AUTHORIZATION_SCOPE_MISMATCH'],
    ['unapproved images', { allow_generated_images: false }, 'AUTHORIZATION_SCOPE_MISMATCH'],
    ['fractional model run budget', { max_model_runs: 2.5 }, 'INVALID_CALL_BUDGET'],
    ['unbounded call budget', { max_provider_calls_per_run: 999 }, 'INVALID_CALL_BUDGET'],
    ['unknown cost not acknowledged', { acknowledge_unknown_cost: false }, 'EXPLICIT_EGRESS_AND_UNKNOWN_COST_AUTHORIZATION_REQUIRED'],
    ['egress unapproved', { allow_external_processing: false }, 'EXPLICIT_EGRESS_AND_UNKNOWN_COST_AUTHORIZATION_REQUIRED'],
  ])('%s before service dispatch', async (_name, mutation, code) => {
    const result = await runConfig({ ...configuration(), authorization: { ...authorization(), ...mutation } });
    expect(result.exit).toBe(2);
    expect(result.report.run_error).toBe(code);
  });
  it('cannot reduce declared call authorization below the actual Host tool-turn bound', async () => {
    const result = await runConfig({ ...configuration(), host_config_path: await hostFile({ budgets: { max_tool_turns: 3, max_total_bytes: 65536, max_run_ms: 10000, max_output_tokens: 512, max_image_bytes: 1048576, max_pixels: 1000000, max_crops: 1 } }) });
    expect(result.report.run_error).toBe('AUTHORIZED_CALL_BUDGET_SMALLER_THAN_HOST_LIMIT');
    expect(result.exit).toBe(2);
  });
  it('rejects injectable/private Host configuration rather than forwarding it', async () => {
    const result = await runConfig({ ...configuration(), host_config_path: await hostFile({ secret_env: { OPENAI_API_KEY: 'engineering-never-read-secret' } }) });
    expect(result.report.run_error).toBe('PUBLIC_CONFIGURATION_ONLY_NO_PRIVATE_VALUES_OR_INJECTION');
    expect(result.stdout).not.toContain('engineering-never-read-secret');
  });
  it('valid public scope and budgets still require an interactive human review, not a JSON claimed response', async () => {
    const result = await runConfig({ ...configuration(), host_config_path: await hostFile() });
    expect(result.report.run_error).toBe('HUMAN_VISUAL_REVIEW_TERMINAL_REQUIRED');
    expect(result.exit).toBe(2);
  });
});

it.each([
  [503, 'SERVICE_HTTP_503'],
  [200, 'HUMAN_AUTHORIZATION_DECLINED'],
])('real interactive HTTP %s preserves %s and closes resources while writing evidence', async (status, reason) => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(status === 503 ? { code: 'SERVICE_UNAVAILABLE' } : { items: [{ profile_id: 't32-openai', provider_id: 'openai_api', model_id: 'gpt-6-luna', auth_kind: 'api_key', availability: 'ready', verification: 'not_run', runtime_version: null, verified_at: null, capabilities: { image_input: true, tools: true, structured_output: true, bbox_output: false, attributes: true } }] }));
  });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TCP address required');
  const config = configuration();
  config.base_url = `http://127.0.0.1:${address.port}/`;
  const hostPath = resolve(directory, `${randomUUID()}.json`);
  const host = JSON.parse(await readFile(resolve(root, await hostFile()), 'utf8'));
  host.apiBase = config.base_url.slice(0, -1);
  await writeFile(hostPath, JSON.stringify(host));
  config.host_config_path = relative(root, hostPath);
  const configPath = resolve(directory, `${randomUUID()}.json`);
  await writeFile(configPath, JSON.stringify(config));
  try {
    const result = await new Promise<{ exit: number | null; stdout: string }>((resolveResult, reject) => {
      const command = `"${process.execPath}" scripts/verify-live.mjs --run --config "${relative(root, configPath)}"`;
      const windows = process.platform === 'win32';
      const args = windows
        ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'reports/T32/interactive-closure/conpty.ps1', '-CommandLine', command]
        : ['-q', '-e', '-c', command, '/dev/null'];
      const child = execFile(windows ? 'powershell.exe' : 'script', args, {
        cwd: root, timeout: 90000, maxBuffer: 1024 * 1024,
        env: { ...process.env, WEBLABEL_LIVE_SESSION_COOKIE: 't32_engineering=noncredential', WEBLABEL_LIVE_CSRF: 't32-noncredential' },
      }, (error, stdout) => {
        const exit = error ? typeof error.code === 'number' ? error.code : null : 0;
        if (exit === null) reject(error); else resolveResult({ exit, stdout });
      });
      let answered = false;
      child.stdout?.on('data', chunk => {
        if (!windows && !answered && String(chunk).includes('Type AUTHORIZE T32 GENERATED')) {
          answered = true;
          child.stdin?.write('DECLINE\n');
        }
      });
    });
    const plain = result.stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
    await writeFile(resolve(root, `reports/T32/interactive-closure/interactive-${status}-output.log`), result.stdout);
    const report = {
      run_error: plain.match(/"run_error": "([^"]+)"/)?.[1],
      evidence_path: plain.match(/"evidence_path": "([^"]+)"/)?.[1] ?? '',
      outbound_model_calls: Number(plain.match(/"outbound_model_calls": (\d+)/)?.[1]),
    };
    expect(result.exit).toBe(2);
    expect(requests).toEqual(['/api/model-profiles']);
    expect(report.run_error).toBe(reason);
    const evidence = JSON.parse(await readFile(resolve(root, report.evidence_path), 'utf8'));
    expect(evidence.run_error).toBe(reason);
    await writeFile(resolve(root, `reports/T32/interactive-closure/interactive-${status}-summary.json`), JSON.stringify(evidence, null, 2));
    expect(evidence.resources).toEqual({ terminal: 'closed', browser: 'not_opened' });
    expect(evidence.samples).toEqual([]);
    expect(report.outbound_model_calls).toBe(0);
    await rm(resolve(root, report.evidence_path, '..'), { recursive: true, force: true });
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  }
}, 120000);

it('T32 engineering authoritative service rejects unauthenticated profiles and unavailable real-profile preview without creating a run', async () => {
  const app = await start_test_app('false', 'background');
  try {
    const anonymous = await fetch(`${app.base_url}/api/model-profiles`);
    expect(anonymous.status).toBe(401);
    const admin = await bootstrap_admin_for_test(app);
    const pins = await seed(admin, app);
    const db = new DatabaseSync(database_path_for_test(app));
    try {
      db.prepare("INSERT INTO model_profiles(profile_id,provider_id,model_id,auth_kind,capabilities_json,availability,verification,runtime_version,verified_at,config_json,secret_ref,created_at) VALUES('t32-unconfigured','openai_api','gpt-6-luna','api_key',?,'needs_configuration','not_run',NULL,NULL,'{}',NULL,'2026-10-06T00:00:00Z')").run(JSON.stringify({ image_input: true, tools: true, structured_output: true, bbox_output: false, attributes: true }));
    } finally { db.close(); }
    const original = await admin.request('GET', `/api/assets/${pins.assetRevisionId}/annotation?ontology_version_id=${pins.ontologyId}`);
    const body = startRunBody(pins, randomUUID(), 'Engineering missing configuration consumer', { profile_id: 't32-unconfigured', intent: 'audit_attributes' });
    const preview = await admin.request<{ code: string }>('POST', '/api/ai/previews', { request: body, grants: { allow_image: true, allow_object_context: true, preview_crop: null } });
    expect(preview.status).toBe(403);
    expect(preview.json.code).toBe('PROFILE_UNAVAILABLE');
    const after = await admin.request('GET', `/api/assets/${pins.assetRevisionId}/annotation?ontology_version_id=${pins.ontologyId}`);
    expect(after.json).toEqual(original.json);
    const observed = new DatabaseSync(database_path_for_test(app));
    try { expect(observed.prepare('SELECT COUNT(*) AS n FROM model_runs').get()?.n).toBe(0); } finally { observed.close(); }
  } finally { await app.stop(); }
}, 120000);

describe('persisted service events consumed by the actual CLI (synthetic protocol, NOT live)', () => {
  let app: TestApp;
  let admin: ApiClient;
  let pins: Seeded;
  beforeAll(async () => {
    app = await start_test_app('false', 'manual');
    admin = await bootstrap_admin_for_test(app);
    pins = await seed(admin, app);
  }, 120000);
  afterAll(async () => { await app?.stop(); });
  const observed = (responseId = 'engineering-response-1') => ({
    provider_id: 'openai_api', requested_model_id: 'gpt-6-luna', actual_model_id: 'gpt-6-luna',
    auth_kind: 'api_key', runtime_version: null, runtime_version_status: 'not_exposed', response_id: responseId,
  });
  const observation = (receipt = observed()) => ({
    receipt, receipts: [receipt], usage: { input_tokens: 19, output_tokens: 7, cost_usd: null }, cost_display: 'unknown',
  });
  async function persisted(events: Array<{ type: string; data: JsonObject | null }>, state: string, cancelAfterFirstRead = false) {
    const queued = await admin.request<JsonObject>('POST', '/api/ai/runs', await authorize(admin, startRunBody(pins, randomUUID(), 'Engineering event consumer')));
    expect(queued.status).toBe(202);
    const runId = String(queued.json.run_id);
    const db = new DatabaseSync(database_path_for_test(app));
    try {
      db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
      db.prepare('DELETE FROM run_events WHERE run_id=?').run(runId);
      const insert = db.prepare("INSERT INTO run_events(run_id,seq,event_type,message,data_json,created_at) VALUES(?,?,?,'Synthetic protocol consumer boundary',?,'2026-10-06T00:00:00Z')");
      events.forEach((event, index) => insert.run(runId, index + 1, event.type, event.data === null ? null : JSON.stringify(event.data)));
      db.prepare("UPDATE model_runs SET state='running' WHERE run_id=?").run(runId);
      db.prepare('UPDATE model_runs SET state=? WHERE run_id=?').run(state, runId);
      db.exec('COMMIT');
    } finally { db.close(); }
    const routes: string[] = [];
    const request = async (method: string, route: string) => {
      routes.push(route);
      const response = await admin.request<JsonObject>(method, route);
      expect(response.status).toBe(200);
      if (cancelAfterFirstRead && routes.length === 1) {
        const cancellation = await admin.request('POST', `/api/ai/runs/${runId}/cancel`, {});
        expect(cancellation.status).toBe(200);
      }
      return response.json;
    };
    const row: JsonObject = {};
    return { row, runId, routes, consume: () => observeRun(request, runId, row) };
  }
  it.each(['succeeded', 'failed'])('retains provider receipt/usage/error across the later service %s terminal', async state => {
    const run = await persisted([
      { type: state, data: { ...observation(), error_code: state === 'failed' ? 'upstream_quota' : null } },
      { type: state, data: state === 'failed' ? { code: 'MODEL_RUN_FAILED' } : null },
    ], state);
    await run.consume();
    expect(run.row.terminal).toBe(state);
    expect(run.row.receipt).toEqual(observed());
    expect(run.row.usage).toEqual({ input_tokens: 19, output_tokens: 7, cost_usd: null });
    expect(run.row.provider_error).toBe(state === 'failed' ? 'upstream_quota' : null);
    expect(run.row.service_error).toBe(state === 'failed' ? 'MODEL_RUN_FAILED' : null);
    requireObservedIdentity(run.row, configuration(), { auth_kind: 'api_key' });
    expect(run.row.response_id).toBe('engineering-response-1');
  });
  it('drains every HTTP page through the provider terminal and later service terminal without losing ordered turns', async () => {
    const first = observed('engineering-turn-1');
    const latest = observed('engineering-turn-2');
    const padding: Array<{ type: string; data: JsonObject | null }> = Array.from({ length: 405 }, () => ({ type: 'progress', data: null }));
    padding.splice(199, 0, { type: 'progress', data: observation(first) });
    const run = await persisted([
      ...padding,
      { type: 'succeeded', data: { receipt: latest, receipts: [first, latest], usage: { input_tokens: 30, output_tokens: 12, cost_usd: null }, cost_display: 'unknown' } },
      { type: 'succeeded', data: null },
    ], 'succeeded');
    await run.consume();
    requireObservedIdentity(run.row, configuration(), { auth_kind: 'api_key' });
    expect(run.row.receipts).toEqual([first, latest]);
    expect(run.row.receipt).toEqual(latest);
    expect(run.row.response_id).toBe('engineering-turn-2');
    expect(run.row.usage).toEqual({ input_tokens: 30, output_tokens: 12, cost_usd: null });
    expect(run.row.terminal).toBe('succeeded');
    expect(run.routes).toEqual([0, 200, 400].map(after => `/api/ai/runs/${run.runId}/events?limit=200&after=${after}`));
    expect((run.row.events as Array<{ seq: number }>).map(event => event.seq)).toEqual(Array.from({ length: 408 }, (_, index) => index + 1));
  });
  it('consumes multiple real HTTP pages in sequence and retains the checkpoint before actual cancellation', async () => {
    const padding = Array.from({ length: 405 }, () => ({ type: 'progress', data: null }));
    const run = await persisted([
      ...padding, { type: 'progress', data: observation() },
    ], 'running');
    const cancel = await admin.request('POST', `/api/ai/runs/${run.runId}/cancel`, {});
    expect(cancel.status).toBe(200);
    await run.consume();
    expect(run.row.terminal).toBe('cancelled');
    expect(run.row.receipt).toEqual(observed());
    expect(run.row.usage).toEqual({ input_tokens: 19, output_tokens: 7, cost_usd: null });
    expect(run.routes).toEqual([0, 200, 400].map(after => `/api/ai/runs/${run.runId}/events?limit=200&after=${after}`));
    expect((run.row.events as Array<{ seq: number }>).map(event => event.seq)).toEqual(Array.from({ length: 407 }, (_, index) => index + 1));
  });
  it('advances the retained after sequence when actual cancellation arrives after a short nonterminal poll', async () => {
    const run = await persisted([{ type: 'progress', data: observation() }], 'running', true);
    await run.consume();
    expect(run.routes).toEqual([0, 1].map(after => `/api/ai/runs/${run.runId}/events?limit=200&after=${after}`));
    expect(run.row.terminal).toBe('cancelled');
    expect(run.row.receipt).toEqual(observed());
    expect(run.row.usage).toEqual({ input_tokens: 19, output_tokens: 7, cost_usd: null });
    expect((run.row.events as Array<{ seq: number }>).map(event => event.seq)).toEqual([1, 2]);
  });
  it('blocks dropped 16KiB data before an identity check can authorize Native acceptance', async () => {
    const run = await persisted([{ type: 'succeeded', data: { dropped: 'event_data_too_large' } }, { type: 'succeeded', data: null }], 'succeeded');
    await expect(run.consume()).rejects.toThrow('PROVIDER_OBSERVATION_DATA_DROPPED');
    expect(run.row.receipts).toEqual([]);
    expect(() => requireObservedIdentity(run.row, configuration(), { auth_kind: 'api_key' })).toThrow('ACTUAL_PROVIDER_IDENTITY_REQUIRED');
  });
  it.each([null, { receipt: null, receipts: [] }, observation({ ...observed(), actual_model_id: '' })])('refuses absent or incomplete actual identity instead of substituting requested identity: %j', async data => {
    const run = await persisted([{ type: 'succeeded', data }, { type: 'succeeded', data: null }], 'succeeded');
    await run.consume();
    expect(() => requireObservedIdentity(run.row, configuration(), { auth_kind: 'api_key' })).toThrow('ACTUAL_PROVIDER_IDENTITY_REQUIRED');
    expect(run.row.actual_provider).toBeUndefined();
  });
});

it('default locked-file diagnostic refuses a symlink escape and does not hash a size-matching public file', async () => {
  const repository = resolve(directory, 'repository');
  const outside = resolve(directory, 'outside');
  await mkdir(repository); await mkdir(outside);
  const weights = resolve(repository, 'weights');
  // A directory junction is a real Windows symlink boundary, requires no admin.
  await symlink(outside, weights, process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(resolve(outside, 'model.safetensors'), 'not-authorized-content');
  // Call-through observers retain actual filesystem behavior and ensure an
  // escaped target is not queried for existence/size before canonical refusal.
  const existence = vi.spyOn(fs, 'existsSync');
  const metadata = vi.spyOn(fs, 'statSync');
  syncBuiltinESMExports();
  try {
    expect(lockedFilesDiagnostic(repository, weights, [{ path: 'model.safetensors', bytes: 22, sha256: '0'.repeat(64) }])).toEqual([{ file: 'model.safetensors', status: 'outside_repository_refused' }]);
    expect(lockedFilesDiagnostic(repository, weights, [{ path: 'model.safetensors', bytes: 22, sha256: '0'.repeat(64) }], true)).toEqual([{ file: 'model.safetensors', status: 'outside_repository_refused' }]);
    expect(existence.mock.calls).toEqual([]);
    expect(metadata.mock.calls).toEqual([]);
    expect(lockedFilesDiagnostic(repository, repository, [{ path: 'missing-public-file', bytes: 6, sha256: '0'.repeat(64) }])).toEqual([{ file: 'missing-public-file', status: 'missing' }]);
    expect(existence.mock.calls).toEqual([]);
    expect(metadata.mock.calls).toEqual([]);
    await writeFile(resolve(repository, 'public-lock-file'), 'public');
    expect(lockedFilesDiagnostic(repository, repository, [{ path: 'public-lock-file', bytes: 6, sha256: '0'.repeat(64) }])[0].status).toBe('present_size_checked_not_hashed');
    // Positive control: the observer really captures an allowed metadata read.
    expect(metadata.mock.calls).toEqual([[fs.realpathSync(resolve(repository, 'public-lock-file'))]]);
    expect(lockedFilesDiagnostic(repository, repository, [{ path: 'public-lock-file', bytes: 6, sha256: '0'.repeat(64) }], true)[0].status).toBe('hash_mismatch');
  } finally {
    existence.mockRestore();
    metadata.mockRestore();
    syncBuiltinESMExports();
  }
});

it('actual preview binds the checked public provider budget to Rust-WASM canonical configuration before consent/START', async () => {
  const app = await start_test_app('false', 'manual');
  try {
    const admin = await bootstrap_admin_for_test(app);
    const pins = await seed(admin, app);
    expect((await admin.request('PUT', `/api/projects/${pins.projectId}/external-processing-policy`, { allow_external_processing: true })).status).toBe(200);
    const config = configuration();
    config.base_url = `${app.base_url}/`;
    const existing = JSON.parse(await readFile(resolve(root, await hostFile()), 'utf8'));
    const providerConfig = JSON.stringify(existing.providers[0].config);
    // Raw serde Value scalar categories and UTF-8 keys must survive the JS
    // budget inspection unchanged, including integer keys and supplementary Unicode.
    const rawConfig = providerConfig.slice(0, -1) + ',"canonical_numbers":[1.0,-0.0,1e-7,1e+21,1e-300,18446744073709551615],"canonical_keys":{"10":"ten","2":"two","\\uE000":"bmp","\\uD800\\uDC00":"supplementary"}}';
    const host = (selected: string) => `{"apiBase":${JSON.stringify(app.base_url)},"timeoutMs":999,"providers":[{"provider":"mimo_api","config":{"profile_id":"other","budgets":{"max_tool_turns":8}}},{"provider":"openai_api","config":${selected}}]}`;
    const hostPath = resolve(directory, `${randomUUID()}.json`);
    await writeFile(hostPath, host(rawConfig));
    config.host_config_path = relative(root, hostPath);
    const db = new DatabaseSync(database_path_for_test(app));
    try {
      db.prepare("INSERT INTO model_profiles(profile_id,provider_id,model_id,auth_kind,capabilities_json,availability,verification,runtime_version,verified_at,config_json,secret_ref,created_at) VALUES('t32-openai','openai_api','gpt-6-luna','api_key',?,'ready','not_run',NULL,NULL,?,'env:OPENAI_API_KEY','2026-10-06T00:00:00Z')").run(JSON.stringify({ image_input: true, tools: true, structured_output: true, bbox_output: false, attributes: true }), rawConfig);
    } finally { db.close(); }
    const body = startRunBody(pins, randomUUID(), 'Engineering configuration fingerprint, no model request', { profile_id: config.profile_id, intent: 'audit_attributes' });
    const preview = await admin.request<JsonObject>('POST', '/api/ai/previews', { request: body, grants: { allow_image: true, allow_object_context: true, preview_crop: null } });
    expect(preview.status).toBe(201);
    const inspected = readHostBudget(config);
    const matching = await hostExecutionConfigurationHash(inspected.rawHostConfiguration, config);
    expect(preview.json.execution_configuration_hash).toBe(matching);
    requirePreviewExecutionConfiguration(preview.json, matching);
    // A lower, otherwise valid local public budget must not authorize a
    // service whose persisted execution configuration permits more calls.
    await writeFile(hostPath, host(rawConfig.replace('"max_tool_turns":2', '"max_tool_turns":1')));
    config.authorization.max_provider_calls_per_run = 1;
    const smaller = readHostBudget(config);
    const mismatched = await hostExecutionConfigurationHash(smaller.rawHostConfiguration, config);
    expect(mismatched).not.toBe(matching);
    await expect((async () => {
      requirePreviewExecutionConfiguration(preview.json, mismatched);
      const consent = await admin.request<JsonObject>('POST', '/api/ai/consents', { preview_id: preview.json.preview_id });
      expect(consent.status).toBe(201);
      await admin.request('POST', '/api/ai/runs', { ...(preview.json.request as JsonObject), consent_id: consent.json.consent_id });
    })()).rejects.toThrow('SERVICE_EXECUTION_CONFIGURATION_HASH_MISMATCH');
    const checked = new DatabaseSync(database_path_for_test(app));
    try {
      expect(checked.prepare('SELECT COUNT(*) AS n FROM model_runs').get()?.n).toBe(0);
      expect(checked.prepare('SELECT COUNT(*) AS n FROM consents').get()?.n).toBe(0);
    } finally { checked.close(); }
    expect(() => requirePreviewExecutionConfiguration({ profile_configuration_hash: matching }, matching)).toThrow('SERVICE_EXECUTION_CONFIGURATION_HASH_MISMATCH');
    expect(() => requirePreviewExecutionConfiguration({ execution_configuration_hash: null }, matching)).toThrow('SERVICE_EXECUTION_CONFIGURATION_HASH_MISMATCH');
    const integerForm = await hostExecutionConfigurationHash(host(rawConfig.replace('[1.0,-0.0,', '[1,0,')), config);
    expect(integerForm).not.toBe(matching);
    await expect(hostExecutionConfigurationHash(host(rawConfig.replace('1e-300', '1e400')), config)).rejects.toThrow('INVALID_PUBLIC_EXECUTION_CONFIGURATION');
    await writeFile(resolve(root, 'reports/T32/interactive-closure/configuration-hash-observation.json'), JSON.stringify({
      evidence_kind: 'real_api_and_rust_wasm_canonical_hash_not_live_provider',
      execution_configuration_hash: matching, mismatched_public_budget_hash: mismatched,
      distinct_integer_scalar_form_hash: integerForm, model_runs_started: 0, consents_created: 0,
    }, null, 2));
  } finally { await app.stop(); }
}, 120000);
