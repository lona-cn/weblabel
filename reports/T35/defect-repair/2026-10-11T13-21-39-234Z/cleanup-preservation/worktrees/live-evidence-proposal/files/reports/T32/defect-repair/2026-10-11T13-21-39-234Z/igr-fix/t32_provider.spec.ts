import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootstrap_admin_for_test, database_path_for_test, start_test_app } from '../support/app';
import { authorize, seed, startRunBody, type JsonObject, type Seeded } from '../support/t25-ai';
import { aggregateLiveEvidence, askLiveQuestion, hostExecutionConfigurationHash, lockedFilesDiagnostic, observeRun, readHostBudget, requireObservedIdentity, requirePreviewExecutionConfiguration } from '../../scripts/verify-live.mjs';
import type { ApiClient, TestApp } from '../support/app';
import { taskReportPath } from '../support/report-paths.mjs';

// ENGINEERING consumer/negative-path tests. No live provider, account, GPU or
// prediction evidence is generated here. These tests cannot satisfy G4.
const root = resolve(import.meta.dirname, '../..');
let directory: string;
beforeAll(async () => { directory = await mkdtemp(taskReportPath('T32', 'engineering-')); });
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
    execFile(process.execPath, ['scripts/verify-live.mjs', ...args, '--report-dir', relative(root, directory)], {
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
  it('default and required entry both return four independent blocked channels without inspecting secrets', async () => {
    for (const args of [[], ['--check-required']]) {
      const result = await cli(args);
      expect(result.exit).toBe(2);
      expect(result.report.status).toBe('blocked');
      expect(result.report.channels.map(item => item.provider_id)).toEqual(['claude_local', 'openai_api', 'mimo_api', 'detector_local']);
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
      const command = `"${process.execPath}" scripts/verify-live.mjs --run --config "${relative(root, configPath)}" --report-dir "${relative(root, directory)}"`;
      const windows = process.platform === 'win32';
      const args = windows
        ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'tests/fixtures/interactive-terminal/conpty.ps1', '-CommandLine', command]
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
    await writeFile(resolve(directory, `interactive-${status}-output.log`), result.stdout);
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
    await writeFile(resolve(directory, `interactive-${status}-summary.json`), JSON.stringify(evidence, null, 2));
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
    await writeFile(resolve(directory, 'configuration-hash-observation.json'), JSON.stringify({
      evidence_kind: 'real_api_and_rust_wasm_canonical_hash_not_live_provider',
      execution_configuration_hash: matching, mismatched_public_budget_hash: mismatched,
      distinct_integer_scalar_form_hash: integerForm, model_runs_started: 0, consents_created: 0,
    }, null, 2));
  } finally { await app.stop(); }
}, 120000);
// Synthetic filesystem consumer fixtures only. Never provider/GPU/live/G4 evidence.
const consumerIdentity = {source_commit:'fixture-commit',source_snapshot_sha256:'a'.repeat(64),manifest_sha256:'b'.repeat(64),runner_sha256:'c'.repeat(64),source_hashes:{'fixture':'d'.repeat(64),'apps/agent-host/src/runtime/dispatch.ts':'e'.repeat(64)}};
async function consumerFixture() {
  const directory = await mkdtemp(taskReportPath('T32','offline-consumer-'));
  const manifest = JSON.parse(await readFile(resolve(root,'tests/live/manifest.json'),'utf8'));
  const hash = (value: any) => createHash('sha256').update(value).digest('hex');
  async function put(name: string,value: any,binary=false) { const bytes=binary?value:JSON.stringify(value); await writeFile(resolve(directory,name),bytes); return {path:name,sha256:hash(bytes)}; }
  const index: any={schema_version:1,evidence_kind:'required_channel_live_index',identity:consumerIdentity,channels:[]};
  const summaries: any[]=[];
  const stamp='2026-10-11T00:00:00Z';
  for (const required of manifest.required) {
    const provider=required.provider_id;
    const detector=provider==='detector_local';
    const model=detector?JSON.parse(await readFile(resolve(root,manifest.detector.lock_path),'utf8')).model_id:provider==='claude_local'?'claude-sonnet-4-20250514':provider==='openai_api'?'gpt-6-luna-20261001':'mimo-v2-flash-20261001';
    // Representative native schemas, NOT assertions that these fixture model IDs exist.
    const config={base_url:'http://127.0.0.1:49332/',provider_id:provider,profile_id:provider+'-profile',model_id:model,host_config_path:'public-host.json',authorization:{...authorization(),provider_id:provider,expires_at:stamp}};
    const budgets={max_tool_turns:2,max_total_bytes:65536,max_run_ms:10000,max_output_tokens:512,max_image_bytes:1048576,max_pixels:1000000,max_crops:1};
    const selected=detector?{runTimeoutMs:10000,workerCommand:{executable:'python.exe',argv:['-m','weblabel_detector']},lockPath:resolve(root,manifest.detector.lock_path)}:provider==='claude_local'?{runTimeoutMs:10000,budgets:{max_tool_turns:2}}:{profile_id:config.profile_id,model_id:model,credential:{secret_ref:'env:ENGINEERING_NONCREDENTIAL'},budgets};
    const host={apiBase:config.base_url.slice(0,-1),providers:[{provider,config:selected}]};
    const executionHash=await hostExecutionConfigurationHash(JSON.stringify(host),config);
    const capture: any={schema_version:1,evidence_kind:'actual_channel_live_capture',identity:consumerIdentity,provider_id:provider,requested_model_id:model,capture_status:'completed',run_error:null,resources:{terminal:'closed',browser:'closed'},local_runtime:{runner_node:process.version,runner_sha256:consumerIdentity.runner_sha256,checkout_host_dispatch_sha256:consumerIdentity.source_hashes['apps/agent-host/src/runtime/dispatch.ts']},run_configuration_sha256:hash(JSON.stringify(config)),public_config_artifact:await put(provider+'-config.json',config),host_config_artifact:await put(provider+'-host.json',host),samples:[],error_paths:{}};
    for (const sample of manifest.samples) {
      const prefix=provider+'-'+sample, run_id=prefix+'-run', prediction_id=prefix+'-prediction';
      const receipt={provider_id:provider,actual_model_id:model,requested_model_id:model,auth_kind:required.auth_kind,response_id:prefix+'-response',runtime_version:'fixture-runtime',weights_loaded:detector};
      const origin={type:'manual',prediction_id:null,model_run_id:null,import_batch_id:null};
      const manual={object_id:'object',label_id:'person',attributes:{helmet_state:'unknown'},geometry:{type:'bbox_xyxy',x_min:0,y_min:0,x_max:1,y_max:1},origin};
      const doc={schema_version:1,asset_revision_id:prefix+'-asset',ontology_version_id:'ontology',coordinate_space:{type:'canonical_image_pixels',width:640,height:480},completion:'in_progress',objects:detector?[]:[manual]};
      const revision=(id:string,parent:string|null,document:any,no:number)=>({annotation_revision_id:id,parent_revision_id:parent,revision_no:no,document,created_at:stamp,created_by:'reviewer',content_hash:hash(JSON.stringify(document))});
      const before=revision(prefix+'-before',null,doc,0);
      const object={...manual,attributes:{helmet_state:'wearing'},origin:detector?{type:'prediction',prediction_id,model_run_id:run_id,import_batch_id:null}:origin};
      const changes=detector?[{kind:'create',change_id:'change',object,before_hash:null,reason:'synthetic'}]:[{kind:'set_attributes',change_id:'change',object_id:'object',values:{helmet_state:'wearing'},before_hash:'1'.repeat(64),reason:'synthetic'}];
      const set=prefix+'-set';
      const row: any={sample,run_id,terminal:'succeeded',receipt,receipts:[receipt],canonical_sha256:'e'.repeat(64),input_fingerprint:'f'.repeat(64),execution_configuration_hash:executionHash,host_configuration_sha256:capture.host_config_artifact.sha256,human_visual_review:'Synthetic consumer oracle, not real visual review',accept_save:prefix+'-accept',undo_save:prefix+'-undo'};
      const context={project_id:'project',asset_revision_id:doc.asset_revision_id,annotation_revision_id:before.annotation_revision_id,ontology_version_id:doc.ontology_version_id,draft_generation:0,canonical_sha256:row.canonical_sha256,selected_object_ids:detector?[]:['object'],object_hashes:detector?{}:{object:'1'.repeat(64)},input_fingerprint:row.input_fingerprint};
      const request={operation_id:prefix+'-operation',profile_id:config.profile_id,context,intent:detector?'detect':'audit_attributes',prompt:'Synthetic consumer fixture',consent_id:null};
      const bytes=Buffer.from('fixture-input'); row.source_sha256=hash(bytes); row.input_artifact=await put(prefix+'-input.png',bytes,true);
      row.media_artifact=await put(prefix+'-media.json',{asset_id:prefix+'-asset-id',asset_revision_id:doc.asset_revision_id,project_id:context.project_id,original_name:'t32-'+sample+'.png',original_sha256:row.source_sha256,canonical_sha256:row.canonical_sha256,canonical_width:640,canonical_height:480,exif_orientation:1,original_to_canonical:[1,0,0,0,1,0,0,0,1],source_group_id:prefix+'-group'});
      const profile={profile_id:config.profile_id,provider_id:provider,model_id:model,auth_kind:required.auth_kind,capabilities:{image_input:true,tools:true,structured_output:true,bbox_output:detector,attributes:!detector},availability:'ready',verification:'not_run',runtime_version:receipt.runtime_version,verified_at:null};
      row.preview_artifact=await put(prefix+'-preview.json',{preview_id:prefix+'-preview',input_fingerprint:row.input_fingerprint,execution_configuration_hash:executionHash,request,profile,grants:{allow_image:true,allow_object_context:true,preview_crop:null},expires_at:stamp});
      row.consent_artifact=await put(prefix+'-consent.json',{request:{preview_id:prefix+'-preview'},response:{consent_id:prefix+'-consent',preview_id:prefix+'-preview',input_fingerprint:row.input_fingerprint,expires_at:stamp}});
      row.start_artifact=await put(prefix+'-start.json',{request:{...request,consent_id:prefix+'-consent'},response:{run_id,project_id:'project',state:'queued',source:'interactive',intent:request.intent,profile_id:config.profile_id,provider_id:provider,model_id:model,verification:'not_run',input_fingerprint:row.input_fingerprint,request_hash:'2'.repeat(64),job_id:prefix+'-job',cost_display:'unknown',cancel_requested:false,created_at:stamp,started_at:null,finished_at:null,idempotent_replay:false}});
      row.observation_artifact=await put(prefix+'-events.json',{run_id,terminal:'succeeded',receipts:[receipt],events:[{run_id,seq:1,type:'succeeded',message:'synthetic',data:{receipt,receipts:[receipt]}},{run_id,seq:2,type:'succeeded',message:'service terminal',data:null}]});
      row.candidate_diff={suggestion_set_id:set,base_annotation_revision_id:before.annotation_revision_id,changes,screenshot:await put(prefix+'-diff.png',Buffer.from('fixture-screenshot'),true)};
      row.suggestion_artifact=await put(prefix+'-suggestion.json',{suggestion_set_id:set,model_run_id:run_id,prediction_id,context,changes,issues:[],score:null,state:'pending'});
      row.before_artifact=await put(prefix+'-before.json',before);
      const acceptedDoc={...doc,objects:[object]};
      const save=(decision:string,base:string,document:any,revisionId:string,no:number)=>{const operation_id=prefix+'-'+decision;return {request:{operation_id,base_revision_id:base,document,lease:null,suggestion_decisions:[{suggestion_set_id:set,change_ids:['change'],decision}]},response:{operation_id,revision:revision(revisionId,base,document,no),idempotent_replay:false}};};
      row.accept_artifact=await put(prefix+'-accepted.json',save('accept',before.annotation_revision_id,acceptedDoc,row.accept_save,1));
      row.undo_artifact=await put(prefix+'-undone.json',save('revert',row.accept_save,doc,row.undo_save,2));
      capture.samples.push(row);
    }
    for (const kind of ['quota_error','cancel','unsupported_image']) {
      const run_id=provider+'-'+kind,terminal=kind==='cancel'?'cancelled':'failed',code=kind==='quota_error'?'upstream_quota':'unsupported_image';
      const receipt={provider_id:provider,requested_model_id:model,actual_model_id:model,auth_kind:required.auth_kind,response_id:run_id+'-response',runtime_version:'fixture-runtime'};
      const events=[{run_id,seq:1,type:terminal,message:'synthetic provider error',data:{error_code:code,receipt,receipts:[receipt]}},{run_id,seq:2,type:terminal,message:'service terminal',data:terminal==='failed'?{code:'MODEL_RUN_FAILED'}:null}];
      capture.error_paths[kind]={run_id,code};
      const first=capture.samples[0];
      const start=JSON.parse(await readFile(resolve(directory,first.start_artifact.path),'utf8')); start.response.run_id=run_id;
      capture.samples.push({...first,sample:'error-'+kind,run_id,terminal,start_artifact:await put(run_id+'-start.json',start),observation_artifact:await put(run_id+'-events.json',{run_id,terminal,receipts:[receipt],events})});
    }
    summaries.push(capture);
    index.channels.push({provider_id:provider,summaries:[await put(provider+'-summary.json',capture)]});
  }
  async function save() { for(let i=0;i<summaries.length;i++) index.channels[i].summaries=[await put(index.channels[i].provider_id+'-summary.json',summaries[i])]; await writeFile(resolve(directory,'index.json'),JSON.stringify(index)); }
  async function changeArtifact(ref:any, mutate:(value:any)=>void) {const value=JSON.parse(await readFile(resolve(directory,ref.path),'utf8'));mutate(value);Object.assign(ref,await put(ref.path,value));}
  await save();
  return {directory,manifest,index,summaries,save,changeArtifact,aggregate:()=>aggregateLiveEvidence(directory,{repository:root,manifest,identity:consumerIdentity,skipSecurity:true})};
}
it('four synthetic consumer channels can be non-security complete but never full-ready when scope skipped',async()=>{
  const f=await consumerFixture();try {const result=await f.aggregate();assert.equal(result.non_security_channels_complete,true);assert.equal(result.exit_code,2);assert.equal(result.status,'blocked');assert.equal(result.aggregation_model_calls,0);assert.ok(result.channels.every(c=>c.full_channel_evidence.missing.includes('tool_restriction:skipped_by_user')));}finally{await rm(f.directory,{recursive:true,force:true});}
});
it.each(['identity','field','provider','stale','diagnostic','fixture','prepared','mock'])('offline consumer rejects %s without live operations',async(kind)=>{
  const f=await consumerFixture();try {
    if(kind==='identity') delete f.summaries[0].identity;
    if(kind==='field') delete f.summaries[0].samples[0].human_visual_review;
    if(kind==='provider') f.summaries[0].provider_id='anthropic_api';
    if(kind==='stale') f.summaries[0].identity={...consumerIdentity,runner_sha256:'9'.repeat(64)};
    if(kind==='diagnostic') f.summaries[0].evidence_kind='local_default_diagnostic_not_live';
    if(kind==='fixture') f.summaries[0].fixture=true;
    if(kind==='prepared') f.summaries[0].evidence_kind='generated_local_inputs_not_model_output';
    if(kind==='mock') f.summaries[0].mock=true;
    await f.save();const result=await f.aggregate();assert.equal(result.non_security_channels_complete,false);assert.equal(result.exit_code,2);
  }finally{await rm(f.directory,{recursive:true,force:true});}
});
it('offline consumer treats corrupt JSON and changed bytes as failures',async()=>{
  const f=await consumerFixture();try {
    await writeFile(resolve(f.directory,'index.json'),'{');assert.equal((await f.aggregate()).exit_code,1);
    await f.save();await writeFile(resolve(f.directory,f.index.channels[0].summaries[0].path),'{}');assert.equal((await f.aggregate()).exit_code,1);
  }finally{await rm(f.directory,{recursive:true,force:true});}
});
it('same-byte source committed later remains fresh while unexpected actual errors fail',async()=>{
  const f=await consumerFixture();try {
    f.summaries[0].identity={...consumerIdentity,source_commit:'later-commit'};await f.save();assert.equal((await f.aggregate()).non_security_channels_complete,true);
    f.summaries[0].run_error='UNEXPECTED_RUNTIME_FAILURE';await f.save();assert.equal((await f.aggregate()).exit_code,1);
  }finally{await rm(f.directory,{recursive:true,force:true});}
});

it.each(['wrong_family','partial_document','partial_revision','native_asset','native_ontology','save_base','operation','consent','prediction_provenance','provider_error_receipt'])('offline consumer rejects %s with matching artifact hashes',async(kind)=>{
  const f=await consumerFixture();try {
    const capture=f.summaries[0],row=capture.samples[0];
    if(kind==='wrong_family') {await f.changeArtifact(capture.public_config_artifact,value=>{value.model_id='claude-opus-4-20250514';capture.requested_model_id=value.model_id;capture.run_configuration_sha256=createHash('sha256').update(JSON.stringify(value)).digest('hex');});}
    if(kind==='partial_document') await f.changeArtifact(row.before_artifact,value=>{delete value.document.coordinate_space;});
    if(kind==='partial_revision') await f.changeArtifact(row.accept_artifact,value=>{delete value.response.revision.created_by;});
    if(kind==='native_asset') await f.changeArtifact(row.accept_artifact,value=>{value.response.revision.document.asset_revision_id='other';});
    if(kind==='native_ontology') await f.changeArtifact(row.before_artifact,value=>{value.document.ontology_version_id='other';});
    if(kind==='save_base') await f.changeArtifact(row.undo_artifact,value=>{value.request.base_revision_id='other';});
    if(kind==='operation') await f.changeArtifact(row.accept_artifact,value=>{value.response.operation_id='other';});
    if(kind==='consent') await f.changeArtifact(row.consent_artifact,value=>{value.response.preview_id='other';});
    if(kind==='prediction_provenance') {const detector=f.summaries[3].samples[0];await f.changeArtifact(detector.suggestion_artifact,value=>{value.changes[0].object.origin.model_run_id='other';detector.candidate_diff.changes=value.changes;});}
    if(kind==='provider_error_receipt') await f.changeArtifact(capture.samples.find((item:any)=>item.sample==='error-quota_error').observation_artifact,value=>{value.events[0].data.receipts[0].provider_id='mimo_api';});
    await f.save();const result=await f.aggregate();assert.equal(result.non_security_channels_complete,false);assert.equal(result.exit_code,2);
  }finally{await rm(f.directory,{recursive:true,force:true});}
});
it('offline consumer retains upstream quota and unsupported errors across final service failure without certifying partial success',async()=>{
  const f=await consumerFixture();try {
    f.summaries[0].run_error='REAL_RUN_DID_NOT_SUCCEED';
    const row=f.summaries[1].samples.find((item:any)=>item.sample==='error-quota_error');
    await f.changeArtifact(row.observation_artifact,value=>{const receipt=value.events[0].data.receipts[0];receipt.actual_model_id=null;receipt.response_id=null;receipt.runtime_version=null;receipt.runtime_version_status='not_exposed';value.events[0].data.receipt={...receipt};});
    await f.save();const result=await f.aggregate();assert.equal(result.non_security_channels_complete,true);assert.equal(result.exit_code,2);
    await f.changeArtifact(row.observation_artifact,value=>{value.events[0].data.error_code='unrelated_error';});
    await f.save();assert.equal((await f.aggregate()).non_security_channels_complete,false);
  }finally{await rm(f.directory,{recursive:true,force:true});}
});
it.each(['Type RUN clear after inspecting the scope and image: ','Inspect actual clear image, candidate differences: '])('interrupt aborts a waiting later terminal question: %s',async(prompt)=>{
  const {createInterface}=await import('node:readline/promises');const {PassThrough}=await import('node:stream');
  const input=new PassThrough(),output=new PassThrough();const terminal=createInterface({input,output});const controller=new AbortController();
  try {const pending=askLiveQuestion(terminal,prompt,controller.signal);controller.abort(new Error('CAPTURE_INTERRUPTED'));await assert.rejects(pending,{name:'AbortError'});await assert.rejects(askLiveQuestion(terminal,prompt,controller.signal),/CAPTURE_INTERRUPTED/);}
  finally{terminal.close();input.destroy();output.destroy();}
});
