import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../tests/live/manifest.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(path.join(root, manifest.detector.lock_path), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(code); };
function fileSha256(file) {
  const fd = openSync(file, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(count === buffer.length ? buffer : buffer.subarray(0, count));
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}
const probeEnv = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATHEXT'].filter(key => process.env[key]).map(key => [key, process.env[key]]));

// Only fixed, session-free official version/help surfaces. No shell, auth-status,
// settings discovery, account enumeration, environment credential inspection or login.
function probe(command, args, extra = {}, input) {
  const result = spawnSync(command, args, { cwd: root, shell: false, windowsHide: true, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024, env: { ...probeEnv, ...extra }, input });
  return { argv: [path.basename(command), ...args], exit_code: result.status, error_code: result.error && 'code' in result.error ? result.error.code : null, stdout_sha256: sha(result.stdout ?? ''), stdout: result.stdout ?? '' };
}
function publicProbe(result) {
  const { stdout, ...safe } = result;
  return safe;
}
function executable(name) {
  const suffixes = process.platform === 'win32' ? ['.exe'] : [''];
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const candidate = path.join(dir, name + suffix);
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }
  return name;
}
function runtimeProbe(name, flags) {
  const command = executable(name);
  const version = probe(command, ['--version']);
  const help = probe(command, ['--help']);
  return {
    version: version.exit_code === 0 ? version.stdout.trim().match(/^(?:codex-cli )?\d+\.\d+\.\d+(?:[^\r\n]{0,64})?$/)?.[0] ?? null : null,
    supported_flags: flags.filter(flag => help.exit_code === 0 && help.stdout.includes(flag)),
    probes: [publicProbe(version), publicProbe(help)],
    auth_status: 'unknown_not_probed',
    tool_boundary: 'unknown_not_verified',
  };
}
function weightsDiagnostic() {
  const weightsRoot = path.join(root, 'services/detector/weights');
  const files = lock.files.map(entry => {
    const file = path.join(weightsRoot, entry.path);
    if (!existsSync(file)) return { file: entry.path, status: 'missing' };
    const relative = path.relative(root, realpathSync(file));
    if (relative.startsWith('..') || path.isAbsolute(relative)) return { file: entry.path, status: 'outside_repository_refused' };
    return { file: entry.path, status: statSync(file).size === entry.bytes && fileSha256(file) === entry.sha256 ? 'verified' : 'hash_or_size_mismatch' };
  });
  const request = method => JSON.stringify({ protocol_version: 1, id: `t32-${method}`, kind: 'request', method, payload: {} });
  const worker = probe(executable('python'), ['-m', 'weblabel_detector'], {
    PYTHONPATH: path.join(root, 'services/detector/src'), PYTHONDONTWRITEBYTECODE: '1',
    WEBLABEL_DETECTOR_MODELS_LOCK: path.join(root, manifest.detector.lock_path),
    WEBLABEL_DETECTOR_WEIGHTS_DIR: weightsRoot, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
  }, `${request('probe')}\n${request('shutdown')}\n`);
  let profile = null;
  try {
    const response = worker.stdout.trim().split('\n').map(line => JSON.parse(line)).find(item => item.kind === 'response' && item.id === 't32-probe');
    if (response?.payload?.ok === true) profile = response.payload.profile;
  } catch { /* Malformed output is a failed probe, never a success. */ }
  return { files, worker_probe: publicProbe(worker), profile, load_and_forward: 'not_run', predictions_file: 'never_read' };
}
function diagnose() {
  const codex = runtimeProbe('codex', ['app-server']);
  const claude = runtimeProbe('claude', ['--tools', '--strict-mcp-config', '--setting-sources', '--max-budget-usd']);
  const detector = weightsDiagnostic();
  const channel = (required, missing, probes = null) => ({
    provider_id: required.provider_id, required_auth_kind: required.auth_kind, status: 'blocked', verification: 'not_run',
    actual_provider: null, full_model_id: null, auth_kind: null, runtime_version: probes?.version ?? probes?.profile?.runtime_version ?? null,
    input_hashes: [], response_id: null, missing_prerequisites: missing, tried_probe: probes,
  });
  return {
    task_id: 'T32', evidence_kind: 'local_default_diagnostic_not_live', status: 'blocked', checked_at: new Date().toISOString(),
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    channels: manifest.required.map(required => {
      switch (required.provider_id) {
        case 'codex_local': return channel(required, ['UNSUPPORTED_RUNTIME: production Host refuses Codex until native tool/filesystem confinement is verified', ...(codex.version ? [] : ['official executable/version unavailable']), 'user-owned official subscription login and entitled full model remain unknown', 'version-pinned generated schema and real image/tool protocol', 'run-scoped authorization with disclosed hard quantity budgets'], codex);
        case 'claude_local': return channel(required, ['official subscription login, actual full Sonnet model and image transport remain unknown', 'installed version/help does not establish current Sonnet entitlement or safe tool boundaries', 'real version-pinned init/auth/tools/MCP/result capture; placeholder schema files do not qualify', 'Host probe model is unknown/blocked; authorized configuration and hard quantity budgets missing'], claude);
        case 'openai_api': return channel(required, ['explicitly authorized API credential and account-entitled full Luna model unknown (not inspected)', 'run-scoped authorization, service-owned configuration and bounded quantity budgets', 'upstream actual model/response ID/runtime receipt not observed in this run', 'two authorized visual samples and human-reviewed Workbench acceptance/Undo']);
        case 'mimo_api': return channel(required, ['authorized MiMo account/key/plan endpoint and current image-capable full model unknown (not inspected)', 'run-scoped authorization, service-owned configuration and bounded quantity budgets', 'upstream actual model/response ID/runtime receipt not observed in this run', 'current official documentation refresh required; prior T02 metadata is not current account evidence']);
        case 'detector_local': return channel(required, [...detector.files.filter(file => file.status !== 'verified').map(file => `${file.status}: ${file.file}`), ...(detector.profile?.availability === 'ready' ? [] : ['real Python torch/transformers worker reports needs_configuration or cannot start']), 'locked Predictor.load and real forward pass not run', 'service-owned detector configuration/label mapping and authorized hardware Workbench visual review'], detector);
        default: return fail('UNKNOWN_REQUIRED_PROVIDER');
      }
    }),
    authorization: 'not_granted_no_accounts_touched', outbound_model_calls: 0, weights_downloaded: false, run_error: null,
  };
}
function exact(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !(key in value))) fail(code);
}
function readRunConfig(file) {
  if (!file) fail('RUN_CONFIGURATION_REQUIRED');
  const full = path.resolve(root, file);
  const relative = path.relative(root, realpathSync(full));
  if (relative.startsWith('..') || path.isAbsolute(relative) || statSync(full).size > 16_384) fail('RUN_CONFIGURATION_OUTSIDE_REPOSITORY_OR_TOO_LARGE');
  const config = JSON.parse(readFileSync(full, 'utf8'));
  exact(config, ['base_url', 'provider_id', 'profile_id', 'model_id', 'host_config_path', 'authorization'], 'INVALID_RUN_CONFIGURATION');
  const required = manifest.required.find(item => item.provider_id === config.provider_id);
  if (!required) fail('REQUIRED_CHANNEL_ONLY_NO_SUBSTITUTION');
  for (const key of ['profile_id', 'model_id']) if (typeof config[key] !== 'string' || !config[key] || config[key].length > 256) fail('INVALID_PROFILE_OR_FULL_MODEL');
  if (['unknown', 'sonnet', 'opus', 'luna', 'latest'].includes(config.model_id)) fail('FULL_MODEL_ID_REQUIRED');
  if (config.provider_id === 'openai_api' && config.model_id !== 'gpt-6-luna') fail('OFFICIAL_FULL_LUNA_ID_REQUIRED');
  if (config.provider_id === 'claude_local' && !/^claude-sonnet-\d/.test(config.model_id)) fail('FULL_SONNET_ID_REQUIRED');
  if (config.provider_id === 'detector_local' && config.model_id !== lock.model_id) fail('LOCKED_RTDETR_MODEL_REQUIRED');
  const url = new URL(config.base_url);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || ['5173', '4174'].includes(url.port)) fail('OWN_LOOPBACK_ORIGIN_REQUIRED_ROOT_PORTS_FORBIDDEN');
  exact(config.authorization, ['provider_id', 'sample_set', 'allow_generated_images', 'allow_external_processing', 'expires_at', 'max_model_runs', 'max_provider_calls_per_run', 'acknowledge_unknown_cost'], 'INVALID_RUN_AUTHORIZATION');
  const auth = config.authorization;
  if (auth.provider_id !== config.provider_id || auth.sample_set !== 't32-programmatic-v1' || auth.allow_generated_images !== true || typeof auth.allow_external_processing !== 'boolean' || typeof auth.acknowledge_unknown_cost !== 'boolean') fail('AUTHORIZATION_SCOPE_MISMATCH');
  const expiration = Date.parse(auth.expires_at);
  if (!Number.isFinite(expiration) || expiration <= Date.now() || expiration > Date.now() + 600_000) fail('AUTHORIZATION_EXPIRED_OR_WINDOW_EXCEEDS_TEN_MINUTES');
  if (!Number.isSafeInteger(auth.max_model_runs) || auth.max_model_runs < 2 || auth.max_model_runs > 3 || !Number.isSafeInteger(auth.max_provider_calls_per_run) || auth.max_provider_calls_per_run < 1 || auth.max_provider_calls_per_run > 8) fail('INVALID_CALL_BUDGET');
  if (config.provider_id !== 'detector_local' && (!auth.allow_external_processing || auth.acknowledge_unknown_cost !== true)) fail('EXPLICIT_EGRESS_AND_UNKNOWN_COST_AUTHORIZATION_REQUIRED');
  return { config, required };
}
function readHostBudget(config) {
  if (typeof config.host_config_path !== 'string' || config.host_config_path.length === 0) fail('PUBLIC_SERVICE_HOST_CONFIGURATION_REQUIRED');
  const file = path.resolve(root, config.host_config_path);
  const relative = path.relative(root, realpathSync(file));
  if (relative.startsWith('..') || path.isAbsolute(relative) || statSync(file).size > 1_048_576) fail('HOST_CONFIGURATION_OUTSIDE_REPOSITORY_OR_TOO_LARGE');
  const host = JSON.parse(readFileSync(file, 'utf8'));
  const forbidden = value => value && typeof value === 'object' && Object.entries(value).some(([key, item]) => ['secret_env', 'source_env', 'fetch_impl', 'transport', 'runToken', 'imageSource', 'api_key', 'token', 'password'].includes(key) || forbidden(item));
  if (forbidden(host)) fail('PUBLIC_CONFIGURATION_ONLY_NO_PRIVATE_VALUES_OR_INJECTION');
  if (host.apiBase !== config.base_url.replace(/\/$/, '') || !Array.isArray(host.providers)) fail('HOST_SERVICE_ORIGIN_MISMATCH');
  const matches = host.providers.filter(item => item.provider === config.provider_id && (item.config?.profile_id === config.profile_id || ['claude_local', 'detector_local'].includes(config.provider_id)));
  if (matches.length !== 1) fail('EXACT_SERVICE_PROVIDER_CONFIGURATION_REQUIRED');
  const selected = matches[0].config;
  if (['openai_api', 'mimo_api'].includes(config.provider_id)) {
    if (selected.model_id !== config.model_id || !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(selected.credential?.secret_ref ?? '')) fail('SERVICE_MODEL_OR_SECRET_REFERENCE_MISMATCH');
    const limits = { max_tool_turns: 8, max_total_bytes: 1_048_576, max_run_ms: 120_000, max_output_tokens: 2048, max_image_bytes: 20_971_520, max_pixels: 4_000_000, max_crops: 4 };
    exact(selected.budgets, Object.keys(limits), 'EXPLICIT_HOST_QUANTITY_BUDGET_REQUIRED');
    for (const [key, cap] of Object.entries(limits)) if (!Number.isSafeInteger(selected.budgets[key]) || selected.budgets[key] < 1 || selected.budgets[key] > cap) fail('HOST_QUANTITY_BUDGET_OUT_OF_BOUNDS');
    if (selected.budgets.max_tool_turns > config.authorization.max_provider_calls_per_run) fail('AUTHORIZED_CALL_BUDGET_SMALLER_THAN_HOST_LIMIT');
    return { ...selected.budgets, host_configuration_sha256: sha(readFileSync(file)), cost_usd: null };
  }
  if (!Number.isSafeInteger(selected.runTimeoutMs) || selected.runTimeoutMs < 1 || selected.runTimeoutMs > 120_000) fail('EXPLICIT_HOST_RUNTIME_TIMEOUT_REQUIRED');
  if (config.provider_id === 'claude_local') {
    if (!selected.budgets || !Number.isSafeInteger(selected.budgets.max_tool_turns) || selected.budgets.max_tool_turns < 1 || selected.budgets.max_tool_turns > config.authorization.max_provider_calls_per_run) fail('EXPLICIT_CLAUDE_TOOL_BUDGET_REQUIRED');
  } else {
    const python = executable('python');
    if (!existsSync(python) || realpathSync(selected.workerCommand?.executable ?? '') !== realpathSync(python) || JSON.stringify(selected.workerCommand?.argv) !== JSON.stringify(['-m', 'weblabel_detector']) || realpathSync(selected.lockPath ?? '') !== realpathSync(path.join(root, manifest.detector.lock_path))) fail('REAL_PINNED_DETECTOR_WORKER_CONFIGURATION_REQUIRED');
  }
  return { max_run_ms: selected.runTimeoutMs, max_provider_calls_per_run: config.provider_id === 'detector_local' ? 1 : config.authorization.max_provider_calls_per_run, host_configuration_sha256: sha(readFileSync(file)), cost_usd: null };
}
async function generatedSamples() {
  const { default: sharp } = await import('sharp');
  return Promise.all(manifest.samples.map(async kind => {
    // Own procedural pixels only, not user media or a predictions fixture.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#ddd"/><circle cx="210" cy="90" r="35" fill="#e0b090"/><path d="M175 85Q210 30 245 85Z" fill="#ffd400"/><rect x="165" y="130" width="90" height="190" fill="#2050a0"/><path d="M180 320L170 450M240 320L260 450M170 160L100 270M250 160L320 270" stroke="#203050" stroke-width="25"/>${kind === 'occluded' ? '<rect x="150" y="35" width="130" height="100" fill="#555"/>' : ''}</svg>`;
    const bytes = await sharp(Buffer.from(svg)).png().toBuffer();
    return { kind, bytes, source_sha256: sha(bytes), visual_expectation: kind === 'clear' ? 'Stylized person with a yellow helmet; confirm what the model actually sees, no accuracy claim.' : 'Same person with head/helmet occluded; helmet_state should be unknown if not visible.' };
  }));
}
async function run(file, diagnostic) {
  const { config, required } = readRunConfig(file);
  // The production Host still refuses this exact unsupported channel. No API
  // impersonation or config flag can turn that into a subscription pass.
  if (config.provider_id === 'codex_local') fail('UNSUPPORTED_RUNTIME');
  if (config.provider_id === 'detector_local') {
    const detector = diagnostic.channels.find(item => item.provider_id === 'detector_local').tried_probe;
    if (detector.files.some(item => item.status !== 'verified') || detector.profile?.availability !== 'ready') fail('LOCKED_WEIGHTS_AND_REAL_RUNTIME_REQUIRED');
  }
  const budget = readHostBudget(config);
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail('HUMAN_VISUAL_REVIEW_TERMINAL_REQUIRED');
  const cookie = process.env.WEBLABEL_LIVE_SESSION_COOKIE;
  const csrf = process.env.WEBLABEL_LIVE_CSRF;
  if (!cookie || !csrf || /[\r\n]/.test(cookie + csrf)) fail('EXPLICIT_SERVICE_SESSION_AND_CSRF_REQUIRED_NO_LOGIN_PERFORMED');
  const { validateContract } = await import('../packages/contracts/src/validate.js');
  const { chromium, expect } = await import('@playwright/test');
  const evidenceDir = path.join(root, 'reports/T32/local-live', randomUUID());
  await mkdir(evidenceDir, { recursive: true });
  /** @type {Record<string, 'not_run' | Record<string, unknown>>} */
  const errorPaths = Object.fromEntries(['quota_error', 'cancel', 'unsupported_image', 'tool_restriction'].map(key => [key, 'not_run']));
  const evidence = { provider_id: config.provider_id, requested_model_id: config.model_id, required_auth_kind: required.auth_kind, status: 'blocked', samples: [], error_paths: errorPaths, identity_receipt: 'not_observed', local_runtime: { runner_node: process.version, runner_sha256: sha(readFileSync(fileURLToPath(import.meta.url))), checkout_host_dispatch_sha256: sha(readFileSync(path.join(root, 'apps/agent-host/src/runtime/dispatch.ts'))), executed_host_build_identity: 'must_come_from_runtime_receipt_not_checkout_hash' } };
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let browser;
  let started = 0;
  try {
    const request = async (method, route, body) => {
      const response = await fetch(new URL(route, config.base_url), { method, redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { cookie, origin: config.base_url.replace(/\/$/, ''), 'x-csrf-token': csrf, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      if (!response.ok) fail(`SERVICE_HTTP_${response.status}`);
      return response.json();
    };
    const profiles = await request('GET', '/api/model-profiles');
    const profile = profiles.items?.find(item => item.profile_id === config.profile_id);
    if (!profile || !validateContract('model_profile', profile).valid || profile.provider_id !== config.provider_id || profile.model_id !== config.model_id || profile.auth_kind !== required.auth_kind || profile.availability !== 'ready' || !profile.capabilities.image_input) fail('SERVICE_PROFILE_NOT_READY_OR_CHANNEL_MISMATCH');
    const samples = await generatedSamples();
    const external = config.provider_id !== 'detector_local';
    console.error(JSON.stringify({ data_egress: external, possible_model_fees_usd: external ? null : 0, cost_display: external ? 'unknown; calls may incur fees including after cancellation' : 'local inference only', account: required.auth_kind, hard_quantity_budget: budget, max_model_runs: config.authorization.max_model_runs, samples: samples.map(({ bytes, ...publicSample }) => publicSample) }, null, 2));
    const authorizationPhrase = `AUTHORIZE T32 GENERATED ${config.provider_id}`;
    if (await terminal.question(`Type ${authorizationPhrase} to create an isolated project and execute this channel: `) !== authorizationPhrase) fail('HUMAN_AUTHORIZATION_DECLINED');
    const project = await request('POST', '/api/projects', { name: `T32 live ${randomUUID()}`, description: 'Authorized generated images only; not business data', allow_self_review: true });
    const ontology = await request('POST', `/api/projects/${project.project_id}/ontologies`, { guidelines_markdown: 'Inspect actual visible helmet attributes; occlusion means unknown. Never invent a visual result.', labels: [{ label_id: 'label_person', name: 'Person', color: '#0099ff', shortcut: null, allowed_geometry_types: ['bbox_xyxy'], attributes: [{ key: 'helmet_state', kind: 'enum', required: false, default_value: 'unknown', enum_values: ['wearing', 'not_wearing', 'unknown'], min: null, max: null }] }] });
    if (external) await request('PUT', `/api/projects/${project.project_id}/external-processing-policy`, { allow_external_processing: true });
    browser = await chromium.launch({ channel: 'chrome', headless: false });
    const context = await browser.newContext();
    const separator = cookie.indexOf('=');
    if (separator < 1 || cookie.includes(';')) fail('SINGLE_EXPLICIT_SESSION_COOKIE_REQUIRED');
    await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: config.base_url, httpOnly: true, sameSite: 'Strict' }]);
    const page = await context.newPage();
    // No synthetic provider response, test facade, or manual job drain is used.
    // The only interception is a deny/continue guard on actual START requests.
    await page.goto(`${config.base_url}?project_id=${encodeURIComponent(project.project_id)}`);
    const pending = new Map();
    await page.route('**/api/ai/runs', async route => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        const approved = pending.get(body.context?.canonical_sha256);
        pending.delete(body.context?.canonical_sha256);
        if (!validateContract('start_run_request', body).valid || Date.parse(config.authorization.expires_at) <= Date.now() || started >= config.authorization.max_model_runs || body.profile_id !== config.profile_id || !approved || body.context.input_fingerprint !== approved.input_fingerprint || body.context.project_id !== project.project_id || body.context.annotation_revision_id !== approved.annotation_revision_id) { await route.abort('blockedbyclient'); return; }
        started += 1;
      }
      await route.continue();
    });
    for (const sample of samples) {
      await page.getByTestId('media-import').setInputFiles({ name: `t32-${sample.kind}.png`, mimeType: 'image/png', buffer: sample.bytes });
      let asset;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const assets = await request('GET', `/api/projects/${project.project_id}/assets`);
        asset = assets.items.find(item => item.original_name === `t32-${sample.kind}.png`);
        if (asset) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!asset || !validateContract('media_revision', asset).valid) fail('CANONICAL_MEDIA_IMPORT_FAILED');
      const head = () => request('GET', `/api/assets/${asset.asset_revision_id}/annotation?ontology_version_id=${encodeURIComponent(ontology.ontology_version_id)}`);
      let before = await head();
      await page.reload();
      await page.getByTestId(`asset-item-${asset.asset_revision_id}`).click();
      const gpu = page.getByTestId('gpu-status');
      await expect(gpu).toHaveAttribute('data-actual-backend', 'webgpu', { timeout: 30_000 });
      await expect(gpu).toHaveAttribute('data-device-state', 'ready');
      await expect(gpu).toHaveAttribute('data-adapter-kind', 'hardware');
      await page.getByTestId('ai-provider').locator(`input[value=${JSON.stringify(config.profile_id)}]`).check();
      const detectorRun = config.provider_id === 'detector_local';
      if (!detectorRun) {
        // Real native EditorCore interaction creates the audit object, then the
        // nativeSaveQueue flushes it before preview. Never write a JS draft.
        const canvas = await page.getByTestId('annotation-canvas').boundingBox();
        if (!canvas) fail('REAL_EDITOR_CANVAS_REQUIRED');
        const scale = Math.min(canvas.width / 640, canvas.height / 480);
        /** @returns {[number, number]} */
        const point = (x, y) => [canvas.x + (canvas.width - 640 * scale) / 2 + x * scale, canvas.y + (canvas.height - 480 * scale) / 2 + y * scale];
        await page.getByTestId('tool-box').click();
        await page.mouse.move(...point(95, 35));
        await page.mouse.down();
        await page.mouse.move(...point(325, 455), { steps: 5 });
        await page.mouse.up();
        if (sample.kind === 'occluded') {
          await page.getByTestId('object-list').getByRole('option').first().click();
          await page.getByTestId('attribute-helmet_state').selectOption('wearing');
        }
      }
      await page.getByLabel('Run intent').selectOption(detectorRun ? 'detect' : 'audit_attributes');
      await page.getByTestId('ai-prompt').fill(detectorRun ? 'Detect visible persons using the locked real RT-DETR; propose candidates only.' : 'Inspect the actual image. Only propose helmet_state attributes, never change boxes. Visible yellow helmet means wearing; head occlusion means unknown. Explain the visual evidence; propose only real differences.');
      const previewResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/ai/previews');
      await page.getByTestId('ai-run').click();
      const previewHttp = await previewResponse;
      assert.equal(previewHttp.status(), 201);
      const preview = await previewHttp.json();
      assert.ok(validateContract('ai_preview_response', preview).valid);
      assert.equal(preview.request.context.canonical_sha256, asset.canonical_sha256);
      before = await head();
      console.error(JSON.stringify({ sample: sample.kind, canonical_sha256: asset.canonical_sha256, input_fingerprint: preview.request.context.input_fingerprint, actual_preview: preview.grants }));
      if (await terminal.question(`Type RUN ${sample.kind} after inspecting the scope and image: `) !== `RUN ${sample.kind}`) fail('HUMAN_RUN_AUTHORIZATION_DECLINED');
      pending.set(asset.canonical_sha256, { input_fingerprint: preview.input_fingerprint, annotation_revision_id: before.annotation_revision_id });
      await page.getByTestId('ai-consent').getByRole('checkbox').check();
      const queuedResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/ai/runs');
      await page.getByRole('button', { name: 'Authorize and run now' }).click();
      const queuedHttp = await queuedResponse;
      assert.equal(queuedHttp.status(), 202);
      const queued = await queuedHttp.json();
      diagnostic.authorization = 'explicit_run_authorization';
      diagnostic.model_runs_started = started;
      diagnostic.outbound_model_calls = external ? null : 0;
      const row = { sample: sample.kind, source_sha256: sample.source_sha256, canonical_sha256: asset.canonical_sha256, input_fingerprint: preview.request.context.input_fingerprint, run_id: queued.run_id, actual_provider: null, full_model_id: null, auth_kind: null, runtime_version: null, response_id: null, receipt: null, receipts: [], terminal: null, human_visual_review: null, accept_save: null, undo_save: null };
      evidence.samples.push(row);
      for (let attempt = 0; attempt < 240; attempt += 1) {
        const events = await request('GET', `/api/ai/runs/${queued.run_id}/events?limit=200`);
        for (const event of events.items) assert.ok(validateContract('run_event', event).valid);
        const terminalEvent = events.items.findLast(event => ['succeeded', 'failed', 'cancelled'].includes(event.type));
        if (terminalEvent) {
          row.terminal = terminalEvent.type;
          const data = terminalEvent.data ?? {};
          row.receipts = Array.isArray(data.receipts) ? data.receipts : [];
          const receipt = data.receipt ?? data.receipts?.at(-1) ?? null;
          if (receipt) {
            row.actual_provider = receipt.provider_id ?? null;
            row.full_model_id = receipt.actual_model_id ?? null;
            row.auth_kind = receipt.auth_kind ?? null;
            row.runtime_version = receipt.runtime_version ?? null;
            row.response_id = receipt.response_id ?? null;
            row.receipt = receipt;
            evidence.identity_receipt = 'observed_from_persisted_run_event';
          }
          const code = data.error_code ?? data.code ?? null;
          if (typeof code === 'string') {
            if (/quota|rate_limit/.test(code)) evidence.error_paths.quota_error = { code, run_id: queued.run_id };
            if (/image|unsupported/.test(code)) evidence.error_paths.unsupported_image = { code, run_id: queued.run_id };
            if (/tool_|method_not_permitted/.test(code)) evidence.error_paths.tool_restriction = { code, run_id: queued.run_id };
          }
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (row.terminal !== 'succeeded') fail('REAL_RUN_DID_NOT_SUCCEED');
      if (row.receipt) {
        assert.equal(row.actual_provider, config.provider_id);
        assert.equal(row.full_model_id, config.model_id);
        assert.equal(row.auth_kind, required.auth_kind);
        assert.equal(row.receipt.requested_model_id, config.model_id);
        // Remote HTTP server versions are not a documented response field.
        // null + not_exposed is recorded, not an impossible API prerequisite.
        if (row.runtime_version === null && ['openai_api', 'mimo_api'].includes(config.provider_id)) assert.equal(row.receipt.runtime_version_status, 'not_exposed');
      }
      const suggestions = await request('GET', `/api/ai/runs/${queued.run_id}/suggestions`);
      for (const set of suggestions.items) assert.ok(validateContract('suggestion_set', set).valid);
      const suggestion = suggestions.items.find(set => set.context.asset_revision_id === asset.asset_revision_id && set.state === 'pending' && set.changes.length > 0);
      if (!suggestion) fail('NO_ACCEPTABLE_REAL_CANDIDATE_DIFF');
      const candidateSet = page.getByRole('article', { name: `Candidate set ${suggestion.suggestion_set_id}`, exact: true });
      await expect(candidateSet).toBeVisible({ timeout: 10_000 });
      await page.screenshot({ path: path.join(evidenceDir, `${sample.kind}-diff.png`), fullPage: true });
      const review = await terminal.question(`Inspect actual ${sample.kind} image, candidate differences and visual expectation. Describe the visual result. This answer is stored locally; do not enter private information: `);
      if (review.trim().length < 8) fail('HUMAN_VISUAL_REVIEW_REQUIRED');
      row.human_visual_review = review;
      assert.deepEqual(await head(), before);
      const changes = suggestion.changes;
      for (const checkbox of await candidateSet.getByRole('checkbox').all()) await checkbox.check();
      const savedResponse = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith('/annotation') && response.request().postDataJSON().suggestion_decisions?.some(item => item.decision === 'accept'));
      await candidateSet.getByTestId('accept-selected').click();
      const saved = await savedResponse;
      assert.equal(saved.status(), 200);
      const accepted = await saved.json();
      assert.ok(validateContract('save_response', accepted).valid);
      for (const change of changes) {
        const object = accepted.revision.document.objects.find(item => item.object_id === (change.kind === 'create' ? change.object.object_id : change.object_id));
        assert.ok(object, 'Actual accepted change must exist in saved revision');
        if (change.kind === 'create') assert.deepEqual(object, change.object);
        if (change.kind === 'set_label') assert.equal(object.label_id, change.label_id);
        if (change.kind === 'set_attributes') for (const [key, value] of Object.entries(change.values)) assert.deepEqual(object.attributes[key], value);
      }
      if (external) for (const object of accepted.revision.document.objects) assert.deepEqual(object.geometry, before.document.objects.find(item => item.object_id === object.object_id)?.geometry);
      row.accept_save = accepted.revision.annotation_revision_id;
      const undoResponse = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith('/annotation') && response.request().postDataJSON().suggestion_decisions?.some(item => item.decision === 'revert'));
      await page.getByTestId('undo').click();
      const undoneHttp = await undoResponse;
      assert.equal(undoneHttp.status(), 200);
      const undone = await undoneHttp.json();
      assert.ok(validateContract('save_response', undone).valid);
      assert.deepEqual(undone.revision.document, before.document);
      row.undo_save = undone.revision.annotation_revision_id;
      await page.screenshot({ path: path.join(evidenceDir, `${sample.kind}-undone.png`), fullPage: true });
    }
    if (config.authorization.max_model_runs === 3) {
      const last = evidence.samples.at(-1);
      const lastSuggestions = await request('GET', `/api/ai/runs/${last.run_id}/suggestions`);
      const pinnedAsset = lastSuggestions.items[0]?.context.asset_revision_id;
      if (!pinnedAsset) fail('CANCEL_SCOPE_PIN_REQUIRED');
      const headPath = `/api/assets/${pinnedAsset}/annotation?ontology_version_id=${encodeURIComponent(ontology.ontology_version_id)}`;
      const beforeCancel = await request('GET', headPath);
      if (await terminal.question('Type AUTHORIZE T32 CANCEL to spend the third bounded run on this same generated image and exercise actual cancellation: ') === 'AUTHORIZE T32 CANCEL') {
        const previewResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/ai/previews');
        await page.getByTestId('ai-run').click();
        const previewHttp = await previewResponse;
        assert.equal(previewHttp.status(), 201);
        const preview = await previewHttp.json();
        assert.ok(validateContract('ai_preview_response', preview).valid);
        assert.equal(preview.request.context.asset_revision_id, pinnedAsset);
        pending.set(preview.request.context.canonical_sha256, { input_fingerprint: preview.input_fingerprint, annotation_revision_id: beforeCancel.annotation_revision_id });
        await page.getByTestId('ai-consent').getByRole('checkbox').check();
        const queuedResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/ai/runs');
        await page.getByRole('button', { name: 'Authorize and run now' }).click();
        const queuedHttp = await queuedResponse;
        assert.equal(queuedHttp.status(), 202);
        const queued = await queuedHttp.json();
        const cancelResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/ai/runs/${queued.run_id}/cancel`);
        await page.getByTestId('ai-cancel').click();
        const cancelledHttp = await cancelResponse;
        const cancellation = { run_id: queued.run_id, cancel_http_status: cancelledHttp.status(), terminal: null, remote_billing: external ? 'may_have_cost_unknown' : 'local_only', receipts: [] };
        evidence.error_paths.cancel = cancellation;
        for (let attempt = 0; attempt < 240; attempt += 1) {
          const events = await request('GET', `/api/ai/runs/${queued.run_id}/events?limit=200`);
          const terminalEvent = events.items.findLast(event => ['succeeded', 'failed', 'cancelled'].includes(event.type));
          if (terminalEvent) {
            cancellation.terminal = terminalEvent.type;
            cancellation.receipts = terminalEvent.data?.receipts ?? [];
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        assert.deepEqual(await request('GET', headPath), beforeCancel);
        await page.screenshot({ path: path.join(evidenceDir, 'cancel.png'), fullPage: true });
        diagnostic.model_runs_started = started;
      }
    }
    // No fixture or config may fill in absent runtime identity, error-path or
    // load/forward attestation. Successful UI steps alone are still blocked.
    evidence.missing_evidence = evidence.samples.flatMap(row => [
      ...(!row.actual_provider || !row.full_model_id || !row.auth_kind || !row.response_id ? [`${row.sample}: actual runtime identity/response ID not fully exposed`] : []),
      ...(config.provider_id === 'detector_local' && !row.receipt?.weights_loaded ? [`${row.sample}: actual locked load/forward receipt not exposed`] : []),
    ]);
    for (const [kind, outcome] of Object.entries(evidence.error_paths)) if (outcome === 'not_run') evidence.missing_evidence.push(`${kind}: not_run`);
  } finally {
    diagnostic.model_runs_started = started;
    diagnostic.outbound_model_calls = external && started > 0 ? null : 0;
    const observedChannel = diagnostic.channels.find(channel => channel.provider_id === config.provider_id);
    const observedReceipt = evidence.samples.findLast(sample => sample.receipt)?.receipt;
    observedChannel.verification = evidence.samples.length > 0 ? 'partial_live_observation_not_gate_pass' : 'not_run';
    observedChannel.input_hashes = evidence.samples.map(sample => sample.canonical_sha256);
    observedChannel.actual_provider = observedReceipt?.provider_id ?? null;
    observedChannel.full_model_id = observedReceipt?.actual_model_id ?? null;
    observedChannel.auth_kind = observedReceipt?.auth_kind ?? null;
    observedChannel.response_id = observedReceipt?.response_id ?? null;
    observedChannel.runtime_version = observedReceipt?.runtime_version ?? observedChannel.runtime_version;
    terminal.close();
    await browser?.close();
    await writeFile(path.join(evidenceDir, 'summary.json'), JSON.stringify(evidence, null, 2));
    diagnostic.evidence_path = path.relative(root, path.join(evidenceDir, 'summary.json')).replaceAll('\\', '/');
  }
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('T32 live gates: node scripts/verify-live.mjs [--check-required] | --run --config <repo-local-public-authorization.json>\nDefault diagnoses five independent channels; blocked exits 2. No account commands/model calls/downloads.\n--run needs ten-minute provider-specific authorization, generated-image scope, max_model_runs (2..3), max_provider_calls_per_run (1..8), unknown-cost acknowledgement for external channels, explicit public service Host configuration with hard quantity budgets, own loopback production origin (not 5173/4174), existing service session via WEBLABEL_LIVE_SESSION_COOKIE and WEBLABEL_LIVE_CSRF, and human visual review. No login or credential-file reading.\nCalls go through actual Workbench, preview/consent, service jobs, Host, native EditorCore and nativeSaveQueue. Codex production remains UNSUPPORTED_RUNTIME; unavailable profiles and missing locked detector weights refuse dispatch. Prices/metadata not exposed by upstream remain null/unknown. No engineering fixture or UI-only result passes G4.');
  console.log('--prepare-inputs writes only the two own generated local PNGs and their hashes under reports/T32/programmatic-inputs. It does not authorize upload, execute a model, or satisfy a live gate.');
} else if (args.length === 1 && args[0] === '--prepare-inputs') {
  const directory = path.join(root, 'reports/T32/programmatic-inputs');
  await mkdir(directory, { recursive: true });
  const inputs = [];
  for (const { bytes, ...sample } of await generatedSamples()) {
    const filename = `${sample.kind}.png`;
    await writeFile(path.join(directory, filename), bytes);
    inputs.push({ ...sample, path: `reports/T32/programmatic-inputs/${filename}` });
  }
  const metadata = { evidence_kind: 'generated_local_inputs_not_model_output', sample_set: 't32-programmatic-v1', uploaded: false, model_calls: 0, inputs };
  await writeFile(path.join(directory, 'inputs.json'), JSON.stringify(metadata, null, 2));
  console.log(JSON.stringify(metadata, null, 2));
} else {
  let report;
  try {
    if (!(args.length === 0 || (args.length === 1 && args[0] === '--check-required') || (args.length === 3 && args[0] === '--run' && args[1] === '--config') || (args.length === 1 && args[0] === '--run'))) fail('INVALID_ARGUMENTS');
    report = diagnose();
    if (args[0] === '--run') await run(args[2], report);
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'DIAGNOSTIC_OR_RUN_FAILED';
    report ??= { task_id: 'T32', evidence_kind: 'local_diagnostic', status: 'blocked', channels: [], run_error: null };
    report.run_error = code;
  }
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = manifest.blocked_exit_code;
}
