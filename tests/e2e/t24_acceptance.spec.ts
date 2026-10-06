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
import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Panel } from './src/features/ai/Panel';
import { EditorHost } from './src/lib/editor/EditorHost';
import { createEditorFacadeFactory, loadWasmBridge } from './src/lib/editor/loader';
import { SaveQueue } from './src/lib/persistence/save-queue';

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
const api = {
  preview: async (request, grants) => ({ preview_id: 'preview-t24', request: { ...request, context: { ...request.context, input_fingerprint: 'server-preview-fixture' } }, profile, grants, input_fingerprint: 'server-preview-fixture', expires_at: new Date(Date.now() + 600000).toISOString() }),
  start: async (request) => { requestContext = request.context; return { run_id: 'run-t24' }; },
  events: async () => [{ run_id: 'run-t24', seq: 1, type: 'succeeded', message: 'Fixture completed', data: null }],
  suggestions: async () => [{ ...candidate, context: requestContext }],
  cancel: async () => undefined,
};
const records = new Map();
const saves = [];
const savedGenerations = [];
const queue = new SaveQueue({
  storage: { get: async (id) => records.get(id) ?? null, put: async (record) => { records.set(record.asset_revision_id, structuredClone(record)); }, delete: async (id) => { records.delete(id); } },
  transport: {
    save: async (request) => {
      saves.push(structuredClone(request));
      savedGenerations.push(queue.getStatus(asset).local_generation);
      return { operation_id: request.operation_id, idempotent_replay: false, revision: { annotation_revision_id: 'revision-saved-' + saves.length, parent_revision_id: request.base_revision_id, revision_no: saves.length, document: request.document, created_at: new Date().toISOString(), created_by: 'fixture', content_hash: 'fixture' } };
    },
    fetchHead: async () => null,
    fetchRevision: async () => { throw new Error('No conflict revision in this fixture'); },
  },
});
let host;
let root;
function EditorPanel() {
  const [state, setState] = useState({ document: host.getSnapshot(), generation: host.getGeneration() });
  const dispatch = (command) => {
    const delta = host.dispatch(command);
    setState({ document: host.getSnapshot(), generation: host.getGeneration() });
    return delta;
  };
  return createElement(Panel, {
    asset_revision_id: asset, profiles: [profile], context, ontology, getDocument: () => host.getSnapshot(), getGeneration: () => host.getGeneration(), generation: state.generation,
    dispatch, saveQueue: queue, obtainConsent: async () => 'consent-t24', refreshContext: async (snapshot) => ({ ...context, annotation_revision_id: snapshot.annotation_revision_id, draft_generation: snapshot.generation }),
    grants: { allow_image: true, allow_object_context: true, preview_crop: null }, api, intent: 'detect',
  });
}
window.__t24 = {
  async boot() {
    const bridge = await loadWasmBridge('/wasm/wasm_bridge.js');
    host = new EditorHost({ facadeFactory: createEditorFacadeFactory(bridge), onDelta: (delta) => {
      if (delta.document_changed || delta.suggestion_decisions.length) queue.enqueue({ asset_revision_id: asset, ontology_version_id: ontologyId, base_revision_id: queue.getStatus(asset).base_revision_id ?? annotationRevision, generation: delta.generation, document: host.getSnapshot(), suggestion_decisions: delta.suggestion_decisions });
    } });
    const canvas = document.getElementById('t24-canvas');
    host.mount(canvas);
    await host.loadAsset({
      media: {
        asset_id: 'asset-golden', asset_revision_id: asset, project_id: 'project_golden', original_name: 'fixture.png',
        original_sha256: 'a'.repeat(64), canonical_sha256: 'b'.repeat(64), canonical_width: 640, canonical_height: 480,
        exif_orientation: 1, original_to_canonical: [1, 0, 0, 0, 1, 0, 0, 0, 1], source_group_id: 'source-golden',
      },
      ontology, document: initialDocument, frame: { width: 640, height: 480, rgba: new Uint8Array(640 * 480 * 4).fill(255) },
      initial_generation: 0,
    });
    if (host.status !== 'ready') throw new Error('real editor did not reach ready state: ' + host.status);
    queue.initializeFromServerRevision({ asset_revision_id: asset, ontology_version_id: ontologyId, annotation_revision_id: annotationRevision, generation: host.getGeneration(), document: host.getSnapshot() });
    root = createRoot(document.getElementById('t24-react'));
    root.render(createElement(EditorPanel));
    return { status: host.status, snapshot: host.getSnapshot(), generation: host.getGeneration() };
  },
  async undo() {
    const delta = host.dispatch({ kind: 'undo' });
    await queue.flush(asset);
    return { delta, snapshot: host.getSnapshot(), generation: host.getGeneration() };
  },
  snapshot() { return host.getSnapshot(); },
  acceptedJournal() { return saves.flatMap((request) => request.suggestion_decisions); },
  savedState() { return { saves, savedGenerations, record: records.get(asset), status: queue.getStatus(asset) }; },
  dispose() { root?.unmount(); host?.dispose(); },
};
`;

interface EsbuildLike {
  build(options: Record<string, unknown>): Promise<unknown>;
}

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
  const neutralCwd = path.parse(repoRoot).root;
  const build = spawnSync('cargo', ['build', '--target', 'wasm32-unknown-unknown', '-p', 'wasm-bridge', '--manifest-path', path.join(repoRoot, 'Cargo.toml'), '--locked'], {
    cwd: neutralCwd, env, encoding: 'utf8', shell: false, windowsHide: true,
  });
  if (build.status !== 0) throw new Error(`cargo build for wasm32 failed:\n${build.stdout}\n${build.stderr}`);
  const bindgen = spawnSync('wasm-bindgen', ['--target', 'web', '--out-dir', wasmOut, '--out-name', 'wasm_bridge', path.join(repoRoot, 'target', 'wasm32-unknown-unknown', 'debug', 'wasm_bridge.wasm')], {
    cwd: neutralCwd, encoding: 'utf8', shell: false, windowsHide: true,
  });
  if (bindgen.status !== 0) throw new Error(`wasm-bindgen failed:\n${bindgen.stdout}\n${bindgen.stderr}`);
}

async function bootPage(page: Page): Promise<void> {
  await page.route('**/t24-harness.js', (route) => route.fulfill({ path: harnessOut, contentType: 'text/javascript; charset=utf-8' }));
  await page.route('**/wasm/wasm_bridge.js', (route) => route.fulfill({ path: path.join(wasmOut, 'wasm_bridge.js'), contentType: 'text/javascript; charset=utf-8' }));
  await page.route('**/wasm/wasm_bridge_bg.wasm', (route) => route.fulfill({ path: path.join(wasmOut, 'wasm_bridge_bg.wasm'), contentType: 'application/wasm' }));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${origin}/`);
  await page.setContent('<canvas id="t24-canvas" style="width:640px;height:480px;display:block"></canvas><div id="t24-react"></div><script type="module" src="/t24-harness.js"></script>');
  await page.waitForFunction(() => Boolean((window as unknown as { __t24?: unknown }).__t24));
  try {
    const boot = await page.evaluate(() => (window as unknown as { __t24: { boot(): Promise<{ status: string }> } }).__t24.boot());
    expect(boot.status, errors.join('\n')).toBe('ready');
  } catch (error) {
    throw new Error(`T24 real-editor harness failed: ${errors.join('\n')}\n${String(error)}`);
  }
}

test.beforeAll(async () => {
  test.setTimeout(1_200_000);
  buildWasmBundle();
  await buildHarnessBundle();
});
type SavedFixtureState = { saves: Array<{ document: { objects: Array<{ object_id: string }> }; suggestion_decisions: Array<{ suggestion_set_id: string; decision: string; change_ids: string[] }> }>; savedGenerations: number[]; record: { generation: number; intent_journal: Array<{ seq: number; generation: number; intent: { decision: string } }> }; status: { synced_generation: number; dirty: boolean } };
function savedFixtureState(page: Page): Promise<SavedFixtureState> {
  return page.evaluate(() => (window as unknown as { __t24: { savedState(): SavedFixtureState } }).__t24.savedState());
}

test('T24 selected-subset acceptance is one undo unit with reversible journal intents', async ({ page }) => {
  await bootPage(page);
  await page.getByTestId('ai-prompt').fill('Detect two objects and leave the third for review.');
  await page.getByTestId('ai-run').click();
  await page.getByLabel('I reviewed this exact scope and authorize this run.').check();
  await page.getByRole('button', { name: 'Authorize and run now' }).click();

  await expect(page.getByRole('checkbox', { name: 'Select change change-1' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('checkbox', { name: 'Select change change-1' }).check();
  await page.getByRole('checkbox', { name: 'Select change change-2' }).check();
  await page.getByRole('button', { name: 'Accept selected changes' }).click();
  await expect.poll(async () => page.evaluate(() => (window as unknown as { __t24: { acceptedJournal(): Array<{ decision: string; change_ids: string[] }> } }).__t24.acceptedJournal())).toEqual([
    { suggestion_set_id: 'suggestion-t24', decision: 'accept', change_ids: ['change-1', 'change-2'] },
  ]);

  const acceptedSnapshot = await page.evaluate(() => (window as unknown as { __t24: { snapshot(): { objects: Array<{ object_id: string }> } } }).__t24.snapshot());
  expect(acceptedSnapshot.objects.map((object) => object.object_id)).toEqual(['object-1', 'object-2']);
  const acceptedSave = await savedFixtureState(page);
  expect(acceptedSave.saves.map((save) => save.document)).toEqual([acceptedSnapshot]);
  expect(acceptedSave.savedGenerations).toEqual([1]);
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
  expect(revertedSave.record.intent_journal.map(({ seq, generation, intent }) => [seq, generation, intent.decision])).toEqual([[1, 1, 'accept'], [2, 2, 'revert']]);
  expect(revertedSave.status).toMatchObject({ synced_generation: 2, dirty: false });
  await page.evaluate(() => (window as unknown as { __t24: { dispose(): void } }).__t24.dispose());
});
