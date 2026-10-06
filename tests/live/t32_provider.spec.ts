import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap_admin_for_test, database_path_for_test, start_test_app } from '../support/app';
import { seed, startRunBody, type JsonObject } from '../support/t25-ai';

// ENGINEERING consumer/negative-path tests. No live provider, account, GPU or
// prediction evidence is generated here. These tests cannot satisfy G4.
const root = resolve(import.meta.dirname, '../..');
let directory: string;
beforeAll(async () => { directory = await mkdtemp(resolve(root, 'reports/T32/engineering-')); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
interface DiagnosticChannel {
  provider_id: string;
  status: string;
  actual_provider: string | null;
  full_model_id: string | null;
  response_id: string | null;
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
