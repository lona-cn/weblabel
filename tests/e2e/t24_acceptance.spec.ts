import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// This regression runs the production Rust editor through wasm-bindgen and a
// real Chromium WebGPU canvas. Model output is deterministic, and SaveQueue uses
// in-memory transport/storage (not HTTP); acceptance/undo intents are real WASM.
test.use({ channel: 'chromium', launchOptions: { args: ['--enable-unsafe-webgpu'] } });

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const wasmOut = path.join(repoRoot, 'target', 'weblabel-wasm-bridge');
const harnessOut = path.join(repoRoot, 'target', 'weblabel-t24-harness.js');
const origin = 'http://127.0.0.1:4174';

const HARNESS_ENTRY = `
import { mountAiWorkbenchView } from './src/features/ai/ai-workbench-view';
import { createEditorFacadeFactory, loadWasmBridge } from './src/lib/editor/loader';
import { setCsrfToken } from './src/lib/t15/api';
import { createNativeEditorFixture } from '../../tests/e2e/native-editor-fixture';
import { InMemoryDraftStorage } from './src/lib/persistence/draft-store';

const asset = 'asset_revision_golden';
const ontologyId = 'ontology_v1';
const annotationRevision = 'revision_golden';
const initialDocument = {
  schema_version: 1, asset_revision_id: asset, ontology_version_id: ontologyId,
  coordinate_space: { type: 'canonical_image_pixels', width: 640, height: 480 },
  completion: 'in_progress', objects: [],
};
const ontology = {
  ontology_version_id: ontologyId, project_id: 'project_golden', version_no: 1,
  labels: [{
    label_id: 'label_person', name: 'person', color: '#3366ff', shortcut: null,
    allowed_geometry_types: ['bbox_xyxy'],
    attributes: [{ key: 'helmet_state', kind: 'enum', required: true, default_value: 'unknown', enum_values: ['wearing', 'not_wearing', 'unknown'], min: null, max: null }],
  }],
  guidelines_markdown: 'T24 integrated undo fixture', allow_out_of_bounds: false,
};
const context = {
  project_id: 'project_golden', asset_revision_id: asset, annotation_revision_id: annotationRevision,
  ontology_version_id: ontologyId, draft_generation: 0, canonical_sha256: 'b'.repeat(64),
  selected_object_ids: [], object_hashes: {}, input_fingerprint: 't24-integrated-acceptance',
};
const profile = {
  profile_id: 'profile-t24', provider_id: 'openai_api', model_id: 'fixture-model', auth_kind: 'api_key',
  capabilities: { image_input: true, tools: false, structured_output: true, bbox_output: true, attributes: true },
  availability: 'ready', verification: 'mock_only', runtime_version: 'fixture', verified_at: null,
};
const candidate = {
  suggestion_set_id: 'suggestion-t24', model_run_id: 'run-t24', prediction_id: 'prediction-t24', context,
  changes: [
    { kind: 'create', change_id: 'change-1', object: { object_id: 'object-1', label_id: 'label_person', geometry: { type: 'bbox_xyxy', x_min: 10, y_min: 20, x_max: 60, y_max: 90 }, attributes: { helmet_state: 'unknown' }, origin: { type: 'prediction', prediction_id: 'prediction-t24', model_run_id: 'run-t24', import_batch_id: null } }, before_hash: null, reason: 'first selected object' },
    { kind: 'create', change_id: 'change-2', object: { object_id: 'object-2', label_id: 'label_person', geometry: { type: 'bbox_xyxy', x_min: 80, y_min: 30, x_max: 140, y_max: 110 }, attributes: { helmet_state: 'unknown' }, origin: { type: 'prediction', prediction_id: 'prediction-t24', model_run_id: 'run-t24', import_batch_id: null } }, before_hash: null, reason: 'second selected object' },
    { kind: 'create', change_id: 'change-3', object: { object_id: 'object-3', label_id: 'label_person', geometry: { type: 'bbox_xyxy', x_min: 170, y_min: 40, x_max: 230, y_max: 120 }, attributes: { helmet_state: 'unknown' }, origin: { type: 'prediction', prediction_id: 'prediction-t24', model_run_id: 'run-t24', import_batch_id: null } }, before_hash: null, reason: 'unselected object' },
  ],
  issues: [], score: null, state: 'pending',
};
let requestContext;
// Deterministic HTTP responses only. The native controller freezes the actual
// saved document, validates candidates and dispatches real WASM commands.
function modelResponse(url, body) {
  const pathname = new URL(url, location.href).pathname;
  if (pathname === '/api/model-profiles') return { items: [profile] };
  if (pathname === '/api/ai/previews') return { preview_id: 'preview-t24', request: { ...body.request, context: { ...body.request.context, input_fingerprint: 'server-preview-fixture' } }, profile, grants: body.grants, input_fingerprint: 'server-preview-fixture', expires_at: new Date(Date.now() + 600000).toISOString() };
  if (pathname === '/api/ai/consents') return { consent_id: 'consent-t24' };
  if (pathname === '/api/ai/runs') { requestContext = body.context; return { run_id: 'run-t24' }; }
  if (pathname.endsWith('/events')) return { items: [{ run_id: 'run-t24', seq: 1, type: 'succeeded', message: 'Synthetic fixture completed', data: null }] };
  if (pathname.endsWith('/suggestions')) return { items: [{ ...candidate, context: requestContext }], next_cursor: null };
  if (pathname.endsWith('/rejections')) return { suggestion_set_id: candidate.suggestion_set_id, rejected_change_ids: [], operations: [], next_cursor: null };
  return null;
}
const records = new InMemoryDraftStorage();
const saves = [];
const savedGenerations = [];
let queue, fixture, host, ai;
let head = annotationRevision;
window.__t24 = {
  modelResponse,
  async boot() {
    setCsrfToken('t24-synthetic-csrf');
    const bridge = await loadWasmBridge('/wasm/wasm_bridge.js');
    fixture = createNativeEditorFixture(context.project_id, { storage: records, transport: {
      async save(request) {
        if (request.base_revision_id !== head) throw new Error('Synthetic CAS base mismatch');
        saves.push(structuredClone(request)); savedGenerations.push(queue.getStatus(asset).local_generation);
        head = 'revision-saved-' + saves.length;
        return { operation_id: request.operation_id, idempotent_replay: false, revision: { annotation_revision_id: head, parent_revision_id: request.base_revision_id, revision_no: saves.length + 1, document: request.document, created_at: new Date().toISOString(), created_by: 'fixture', content_hash: 'synthetic' } };
      },
      async fetchHead() { throw new Error('Unexpected conflict read in acceptance fixture'); },
      async fetchRevision() { throw new Error('Unexpected revision read in acceptance fixture'); },
    } }, { facadeFactory: createEditorFacadeFactory(bridge) });
    queue = fixture.state.queue;
    document.getElementById('t24-editor').append(fixture.element);
    fixture.load({
      media: {
        asset_id: 'asset-golden', asset_revision_id: asset, project_id: 'project_golden', original_name: 'fixture.png',
        original_sha256: 'a'.repeat(64), canonical_sha256: 'b'.repeat(64), canonical_width: 640, canonical_height: 480,
        exif_orientation: 1, original_to_canonical: [1, 0, 0, 0, 1, 0, 0, 0, 1], source_group_id: 'source-golden',
      },
      ontology, document: initialDocument, frame: { width: 640, height: 480, rgba: new Uint8Array(640 * 480 * 4).fill(255) },
      initial_generation: 0,
    }, annotationRevision);
    host = fixture.state.host;
    if (host.status !== 'ready' && host.status !== 'error') {
      const ready = Promise.withResolvers<void>();
      const unsubscribe = host.subscribeStatus(() => { if (host.status === 'ready' || host.status === 'error') { unsubscribe(); ready.resolve(); } });
      await ready.promise;
    }
    if (host.status !== 'ready') throw new Error('real editor did not reach ready state: ' + host.status);
    ai = mountAiWorkbenchView(document.getElementById('t24-ai'), fixture.state, fixture.port, fixture.signal, () => { throw new Error('Unexpected navigation in acceptance fixture'); });
    return { status: host.status, snapshot: host.getSnapshot(), generation: host.getGeneration() };
  },
  async undo() {
    const delta = fixture.port.dispatch({ kind: 'undo' });
    await queue.flush(asset);
    return { delta, snapshot: host.getSnapshot(), generation: host.getGeneration() };
  },
  snapshot() { return host.getSnapshot(); },
  acceptedJournal() { return saves.flatMap((request) => request.suggestion_decisions); },
  async savedState() { const branch = queue.getDraftBranchSnapshot(asset); return { saves, savedGenerations, record: (await records.get(asset, branch.envelope.draft_id))?.record, status: queue.getStatus(asset) }; },
  dispose() { ai?.dispose(); fixture?.dispose(); },
};
`;

interface EsbuildLike {
  build(options: Record<string, unknown>): Promise<unknown>;
}

interface T24BrowserHarness {
  modelResponse(url: string, body: unknown): unknown;
  dispose(): void;
}
declare global { interface Window { __t24: T24BrowserHarness } }

async function buildHarnessBundle(): Promise<void> {
  const requireFromWeb = createRequire(path.join(repoRoot, 'apps', 'web', 'package.json'));
  const esbuild = createRequire(requireFromWeb.resolve('vite'))('esbuild') as EsbuildLike;
  await esbuild.build({
    absWorkingDir: repoRoot,
    stdin: { contents: HARNESS_ENTRY, resolveDir: path.join(repoRoot, 'apps', 'web'), loader: 'ts' },
    bundle: true,
    format: 'esm',
    outfile: harnessOut,
    define: { 'process.env.NODE_ENV': '"development"' },
    logLevel: 'error',
  });
}

function buildWasmBundle(): void {
  const toolchain = fs.readFileSync(path.join(repoRoot, 'rust-toolchain.toml'), 'utf8');
  const channel = /channel\s*=\s*"([^"]+)"/.exec(toolchain)?.[1];
  if (!channel) throw new Error('rust-toolchain.toml has no pinned channel');
  const env = { ...process.env, RUSTUP_TOOLCHAIN: channel };
  const neutralCwd = process.env.WEBLABEL_CARGO_CWD ?? path.parse(repoRoot).root;
  const build = spawnSync('cargo', ['build', '--target', 'wasm32-unknown-unknown', '-p', 'wasm-bridge', '--manifest-path', path.join(repoRoot, 'Cargo.toml'), '--locked'], {
    cwd: neutralCwd, env, encoding: 'utf8', shell: false, windowsHide: true,
  });
  if (build.status !== 0) throw new Error(`cargo build for wasm32 failed:\n${build.stdout}\n${build.stderr}`);
  const bindgen = spawnSync('wasm-bindgen', ['--target', 'web', '--out-dir', wasmOut, '--out-name', 'wasm_bridge', path.join(process.env.CARGO_TARGET_DIR ?? path.join(repoRoot, 'target'), 'wasm32-unknown-unknown', 'debug', 'wasm_bridge.wasm')], {
    cwd: neutralCwd, encoding: 'utf8', shell: false, windowsHide: true,
  });
  if (bindgen.status !== 0) throw new Error(`wasm-bindgen failed:\n${bindgen.stdout}\n${bindgen.stderr}`);
}

async function bootPage(page: Page): Promise<void> {
  await page.route(origin + '/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.route('**/t24-harness.js', (route) => route.fulfill({ path: harnessOut, contentType: 'text/javascript; charset=utf-8' }));
  await page.route('**/wasm/wasm_bridge.js', (route) => route.fulfill({ path: path.join(wasmOut, 'wasm_bridge.js'), contentType: 'text/javascript; charset=utf-8' }));
  await page.route('**/wasm/wasm_bridge_bg.wasm', (route) => route.fulfill({ path: path.join(wasmOut, 'wasm_bridge_bg.wasm'), contentType: 'application/wasm' }));
  await page.route('**/api/**', async route => {
    const request = route.request(), body: unknown = request.postData() ? request.postDataJSON() : null;
    const value = await page.evaluate(({ url, body }) => window.__t24.modelResponse(url, body), { url: request.url(), body });
    await route.fulfill({ status: value === null ? 404 : 200, contentType: 'application/json', body: JSON.stringify(value ?? { code: 'FIXTURE_ENDPOINT_UNAVAILABLE' }) });
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${origin}/`);
  await page.setContent('<style>.r07-canvas-stage{position:relative;width:640px;height:480px}.r07-canvas-stage canvas{display:block;width:640px;height:480px}.r07-canvas-labels{position:absolute;inset:0;pointer-events:none}.r07-canvas-labels span{position:absolute}</style><div id="t24-editor"></div><div id="t24-ai"></div><script type="module" src="/t24-harness.js"></script>');
  await page.waitForFunction(() => Boolean((window as unknown as { __t24?: unknown }).__t24));
  try {
    const boot = await page.evaluate(() => (window as unknown as { __t24: { boot(): Promise<{ status: string }> } }).__t24.boot());
    expect(boot.status, errors.join('\n')).toBe('ready');
    await expect(page.getByTestId('gpu-status')).toHaveAttribute('data-device-state', 'ready');
    await expect(page.getByTestId('gpu-status')).toHaveAttribute('data-actual-backend', 'webgpu');
    await expect(page.getByTestId('gpu-status')).toHaveAttribute('data-adapter-kind', 'hardware');
  } catch (error) {
    throw new Error(`T24 real-editor harness failed: ${errors.join('\n')}\n${String(error)}`);
  }
}

test.beforeAll(async () => {
  test.setTimeout(1_200_000);
  buildWasmBundle();
  await buildHarnessBundle();
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.__t24?.dispose());
});
type SavedFixtureState = { saves: Array<{ document: { objects: Array<{ object_id: string }> }; suggestion_decisions: Array<{ suggestion_set_id: string; decision: string; change_ids: string[] }> }>; savedGenerations: number[]; record: { generation: number; intent_journal: Array<{ seq: number; generation: number; intent: { decision: string } }> }; status: { synced_generation: number; dirty: boolean } };
function savedFixtureState(page: Page): Promise<SavedFixtureState> {
  return page.evaluate(() => (window as unknown as { __t24: { savedState(): Promise<SavedFixtureState> } }).__t24.savedState());
}

test('T24 selected-subset acceptance is one undo unit with reversible journal intents', async ({ page }) => {
  await bootPage(page);
  await page.getByTestId('ai-provider').selectOption('profile-t24');
  await page.getByRole('combobox', { name: '运行任务' }).selectOption('detect');
  await page.getByTestId('ai-prompt').fill('Detect two objects and leave the third for review.');
  await page.getByTestId('ai-run').click();
  await page.getByTestId('ai-consent').getByRole('checkbox').check();
  await page.getByTestId('ai-authorize').click();

  await expect(page.getByTestId('candidate-change-1').getByRole('checkbox')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('candidate-change-1').getByRole('checkbox').check();
  await page.getByTestId('candidate-change-2').getByRole('checkbox').check();
  await page.getByTestId('accept-selected').click();
  await expect.poll(async () => page.evaluate(() => (window as unknown as { __t24: { acceptedJournal(): Array<{ decision: string; change_ids: string[] }> } }).__t24.acceptedJournal())).toEqual([
    { suggestion_set_id: 'suggestion-t24', decision: 'accept', change_ids: ['change-1', 'change-2'] },
  ]);

  const acceptedSnapshot = await page.evaluate(() => (window as unknown as { __t24: { snapshot(): { objects: Array<{ object_id: string }> } } }).__t24.snapshot());
  expect(acceptedSnapshot.objects.map((object) => object.object_id)).toEqual(['object-1', 'object-2']);
  await expect.poll(async () => (await savedFixtureState(page)).status).toMatchObject({ synced_generation: 1, dirty: false });
  const acceptedSave = await savedFixtureState(page);
  expect(acceptedSave.saves.map((save) => save.document)).toEqual([acceptedSnapshot]);
  expect(acceptedSave.savedGenerations).toEqual([1]);
  expect(acceptedSave.saves[0]).toMatchObject({ base_revision_id: 'revision_golden', lease: null });
  expect(acceptedSave.status).toMatchObject({ synced_generation: 1, dirty: false });
  const undone = await page.evaluate(() => (window as unknown as { __t24: { undo(): { delta: { suggestion_decisions: Array<{ suggestion_set_id: string; decision: string; change_ids: string[] }> }; snapshot: { objects: Array<{ object_id: string }> } } } }).__t24.undo());
  expect(undone.snapshot.objects).toEqual([]);
  expect(undone.delta.suggestion_decisions).toEqual([
    { suggestion_set_id: 'suggestion-t24', decision: 'revert', change_ids: ['change-1', 'change-2'] },
  ]);
  const revertedSave = await savedFixtureState(page);
  expect(revertedSave.saves.map((save) => save.document)).toEqual([acceptedSnapshot, undone.snapshot]);
  expect(revertedSave.saves.flatMap((save) => save.suggestion_decisions)).toEqual([
    { suggestion_set_id: 'suggestion-t24', decision: 'accept', change_ids: ['change-1', 'change-2'] },
    { suggestion_set_id: 'suggestion-t24', decision: 'revert', change_ids: ['change-1', 'change-2'] },
  ]);
  expect(revertedSave.savedGenerations).toEqual([1, 2]);
  expect(revertedSave.saves[1]).toMatchObject({ base_revision_id: 'revision-saved-1', lease: null });
  expect(revertedSave.record.intent_journal.map(({ seq, generation, intent }) => [seq, generation, intent.decision])).toEqual([[1, 1, 'accept'], [2, 2, 'revert']]);
  expect(revertedSave.status).toMatchObject({ synced_generation: 2, dirty: false });
  await page.evaluate(() => (window as unknown as { __t24: { dispose(): void } }).__t24.dispose());
});
