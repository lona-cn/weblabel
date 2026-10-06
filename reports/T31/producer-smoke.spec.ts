import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { test as fixtureTest, expect } from '../../tests/e2e/fixtures';
import type { MediaRevision } from '../../packages/contracts/generated/MediaRevision';
import type { EditorHost as EditorHostType } from '../../apps/web/src/lib/editor/EditorHost';
import type { IndexedDbDraftStorage as IndexedDbDraftStorageType } from '../../apps/web/src/lib/persistence/draft-store';
import type { SaveQueue as SaveQueueType } from '../../apps/web/src/lib/persistence/save-queue';
import type { AnnotationDocument, EditorDelta, EditorFacade } from '../../apps/web/src/lib/editor/types';
import type { EditorCommand, OntologyVersion, SuggestionSet } from '../../apps/web/src/lib/editor/types';
import type { MediaRevision as NativeMedia } from '../../packages/contracts/generated/MediaRevision';
import type { SaveTransport } from '../../apps/web/src/lib/persistence/types';
import type { T28Stats } from '../../apps/web/src/features/workbench/perf';
interface Counts { generation: number; serialized_objects: number; submissions: number; puts: number; stats: T28Stats }
interface ProducerObservation {
  adapters: unknown[]; submissions: number;
  per_commit_submissions: number[];
  puts: { generation: number; object_count: number; pending: boolean }[];
  documents: AnnotationDocument[]; host: EditorHostType | null; queue: SaveQueueType | null; before: Counts | null;
}
declare global { interface Window { __producer: ProducerObservation } }
const root = path.resolve(import.meta.dirname, '../..');
const report = path.join(root, 'reports/T31/producer');
const origin = process.env.WEBLABEL_T31_ORIGIN!;
const test = fixtureTest.extend({ adminPage: async ({ page, seededProject }, use) => {
  await page.addInitScript(() => {
    const observation: ProducerObservation = { adapters: [], submissions: 0, per_commit_submissions: [], puts: [], documents: [], host: null, queue: null, before: null };
    window.__producer = observation;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      if (this.name === 'drafts') observation.puts.push({ generation: value.generation, object_count: value.document.objects.length, pending: value.pending !== null });
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    };
    const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
    navigator.gpu.requestAdapter = async (...args) => {
      const adapter = await requestAdapter(...args);
      if (!adapter) return adapter;
      observation.adapters.push({ vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description, isFallbackAdapter: adapter.info.isFallbackAdapter });
      const requestDevice = adapter.requestDevice.bind(adapter);
      adapter.requestDevice = async (...deviceArgs) => {
        const device = await requestDevice(...deviceArgs);
        const submit = device.queue.submit.bind(device.queue);
        device.queue.submit = (...submits) => { observation.submissions++; return submit(...submits); };
        return device;
      };
      return adapter;
    };
  });
  await page.route('**/api/**', async route => {
    const target = new URL(route.request().url());
    const response = await route.fetch({ url: seededProject.apiBaseUrl + target.pathname + target.search, headers: { ...route.request().headers(), origin: seededProject.apiBaseUrl, host: new URL(seededProject.apiBaseUrl).host } });
    await route.fulfill({ response });
  });
  await page.goto(origin);
  await page.getByTestId('login-username').fill(seededProject.login.username);
  await page.getByTestId('login-password').fill(seededProject.login.password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-submit')).toHaveCount(0);
  await use(page);
} });

test('actual unchanged dense consumer shares immutable commits and persists complete records on hardware', async ({ adminPage: page, seededProject }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const loadedWasm: string[] = [];
  await page.route('**/wasm/wasm_bridge_bg.wasm', async route => {
    const response = await route.fetch(); loadedWasm.push(createHash('sha256').update(await response.body()).digest('hex')); await route.fulfill({ response });
  });
  const png = await sharp({ create: { width: 2048, height: 2048, channels: 4, background: { r: 28, g: 37, b: 49, alpha: 1 } } }).png().toBuffer();
  expect((await seededProject.api.upload(`/api/projects/${seededProject.project_id}/assets`, png, 'producer-dense.png', crypto.randomUUID(), 'image/png')).status).toBe(202);
  expect((await seededProject.api.request('POST', '/internal/test/jobs/drain', {})).status).toBe(200);
  const assets = (await seededProject.api.request<{ items: MediaRevision[] }>('GET', `/api/projects/${seededProject.project_id}/assets`)).json.items;
  const media = assets.find(asset => asset.original_name === 'producer-dense.png')!;
  await page.goto(`${origin}/test-harness/dense?count=2000&seed=17&project_id=${seededProject.project_id}&asset_revision_id=${media.asset_revision_id}`);
  await page.waitForFunction(() => window.__wl_test?.ready === true || document.querySelector('[role="alert"]') !== null);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByTestId('gpu-status')).toHaveAttribute('data-adapter-kind', 'hardware');
  await page.evaluate(async () => {
    // Node static imports cannot load this browser-owned Vite module instance.
    const { EditorHost } = await import('/src/lib/editor/EditorHost.ts' as string) as { EditorHost: typeof EditorHostType };
    // The observed queue is the unchanged DenseHarness browser consumer.
    const { SaveQueue } = await import('/src/lib/persistence/save-queue.ts' as string) as { SaveQueue: typeof SaveQueueType };
    const enqueue = SaveQueue.prototype.enqueue;
    SaveQueue.prototype.enqueue = function(input: Parameters<SaveQueueType['enqueue']>[0]) {
      window.__producer.queue = this;
      return enqueue.call(this, input);
    };
    const original = EditorHost.prototype.getCommittedSnapshot;
    const observed = window.__producer;
    observed.documents = [];
    EditorHost.prototype.getCommittedSnapshot = function(delta: EditorDelta) {
      const document = original.call(this, delta);
      if (document) { observed.host = this; observed.documents.push(document); }
      return document;
    };
    for (let index = 0; index < 40; index++) await window.__wl_test!.editObject(37, index % 2 ? -1 : 1);
    await window.__wl_test!.flush();
    await observed.queue!.whenPersisted(observed.documents.at(-1)!.asset_revision_id);
    observed.documents = [];
    observed.before = { generation: window.__wl_test!.generation(), serialized_objects: window.__wl_test!.serializedInputObjects(), submissions: observed.submissions, puts: observed.puts.length, stats: window.__wl_test!.stats() };
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
  await cdp.send('Profiler.start');
  await page.evaluate(async () => {
    const observed = window.__producer;
    for (let index = 0; index < 100; index++) {
      const submissions = observed.submissions;
      await window.__wl_test!.editObject(37, index % 2 ? -1 : 1);
      observed.per_commit_submissions.push(observed.submissions - submissions);
    }
  });
  const { profile } = await cdp.send('Profiler.stop');
  await writeFile(path.join(report, 'actual-dense-100.cpuprofile'), JSON.stringify(profile));
  const diagnostic = await page.evaluate(async () => {
    const observed = window.__producer;
    const hooks = window.__wl_test!;
    const after = { generation: hooks.generation(), serialized_objects: hooks.serializedInputObjects(), submissions: observed.submissions, puts: observed.puts.length, stats: hooks.stats() };
    const documents = observed.documents;
    const shared = documents.slice(1).map((document, index) => document.objects.filter((object, slot) => object === documents[index].objects[slot]).length);
    const mirror = documents.at(-1)!;
    // This is the exact in-process host captured above, inspected only by smoke.
    const observedHost = observed.host as unknown as { facade: EditorFacade };
    const facade = observedHost.facade;
    const native = facade.get_snapshot();
    if (JSON.stringify(mirror) !== JSON.stringify(native)) throw new Error('Final dense mirror differs from authoritative native snapshot');
    await hooks.flush();
    // Inspect the browser module instance, not a Node imitation of IndexedDB.
    const { IndexedDbDraftStorage } = await import('/src/lib/persistence/draft-store.ts' as string) as { IndexedDbDraftStorage: typeof IndexedDbDraftStorageType };
    const persisted = await new IndexedDbDraftStorage().get(mirror.asset_revision_id);
    if (!persisted || JSON.stringify(persisted.document) !== JSON.stringify(native)) throw new Error('Actual IndexedDB document differs from native');
    const before = observed.before!;
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="annotation-canvas"]')!.getBoundingClientRect();
    return { before, after, commits: documents.length, per_commit_submissions: observed.per_commit_submissions, shared_objects_each_later_commit: shared, puts_during_profile: observed.puts.slice(before.puts, after.puts), native_snapshot_equal_at_boundary: true, idb_document_equal_at_boundary: true, adapters: observed.adapters, frozen: Object.isFrozen(mirror) && Object.isFrozen(mirror.objects[37].geometry), canvas: { width: canvas.width, height: canvas.height }, dpr: devicePixelRatio, user_agent: navigator.userAgent };
  });
  await writeFile(path.join(report, 'dense-observation.json'), JSON.stringify({ ...diagnostic, loaded_wasm_sha256: loadedWasm, browser: page.context().browser()!.version(), page_errors: pageErrors }, null, 2));
  expect(diagnostic.commits).toBe(100);
  expect(diagnostic.after.generation - diagnostic.before.generation).toBe(100);
  expect(diagnostic.after.serialized_objects - diagnostic.before.serialized_objects).toBe(0);
  expect(diagnostic.after.submissions - diagnostic.before.submissions).toBe(100);
  expect(diagnostic.per_commit_submissions).toEqual(Array(100).fill(1));
  expect(diagnostic.shared_objects_each_later_commit).toEqual(Array(99).fill(1999));
  expect(new Set(diagnostic.puts_during_profile.map(row => row.generation))).toEqual(new Set(Array.from({ length: 100 }, (_, index) => diagnostic.before.generation + index + 1)));
  expect(diagnostic.puts_during_profile.every(row => row.object_count === 2000)).toBe(true);
  expect(diagnostic.frozen).toBe(true);
  expect(loadedWasm).toEqual([createHash('sha256').update(await readFile(path.join(root, 'crates/wasm-bridge/target/weblabel-web-public/wasm/wasm_bridge_bg.wasm'))).digest('hex')]);
  expect(pageErrors).toEqual([]);
  await page.screenshot({ path: path.join(report, 'dense-hardware.png'), fullPage: true });
});

test('real WASM mirror retains all headers, exact numbers, restored order and decision-only journals', async ({ adminPage: page, seededProject }) => {
  const ontologyResponse = await seededProject.api.request<{ items: OntologyVersion[] }>('GET', `/api/projects/${seededProject.project_id}/ontologies`);
  expect(ontologyResponse.status).toBe(200);
  const evidence = await page.evaluate(async ({ ontologySource, projectId }) => {
    // Real browser-owned Vite module instances cannot be statically imported in Node.
    const { EditorHost } = await import('/src/lib/editor/EditorHost.ts' as string) as { EditorHost: typeof EditorHostType };
    const { IndexedDbDraftStorage } = await import('/src/lib/persistence/draft-store.ts' as string) as { IndexedDbDraftStorage: typeof IndexedDbDraftStorageType };
    const { SaveQueue } = await import('/src/lib/persistence/save-queue.ts' as string) as { SaveQueue: typeof SaveQueueType };
    const ontology: OntologyVersion = { ...ontologySource, ontology_version_id: 'producer-ontology-fractional',
      labels: ontologySource.labels.map(label => ({ ...label, attributes: [...label.attributes,
        { key: 'score', kind: 'number', required: false, default_value: null, enum_values: [], min: null, max: null },
        { key: 'checked', kind: 'boolean', required: false, default_value: false, enum_values: [], min: null, max: null },
        { key: 'note', kind: 'text', required: false, default_value: '', enum_values: [], min: null, max: null },
      ] })),
    };
    const media: NativeMedia = { asset_id: 'producer-edge', asset_revision_id: 'producer-edge-revision', project_id: projectId,
      original_name: 'synthetic-edge.png', original_sha256: 'a'.repeat(64), canonical_sha256: 'b'.repeat(64),
      canonical_width: 64, canonical_height: 48, exif_orientation: 1, original_to_canonical: [1,0,0,0,1,0,0,0,1], source_group_id: 'producer-edge-source' };
    const document: AnnotationDocument = { schema_version: 1, asset_revision_id: media.asset_revision_id,
      ontology_version_id: ontology.ontology_version_id, coordinate_space: { type: 'canonical_image_pixels', width: 64, height: 48 }, completion: 'complete',
      objects: ['first', 'middle', 'last'].map((id, index) => ({ object_id: id, label_id: ontology.labels[0].label_id,
        geometry: { type: 'bbox_xyxy', x_min: 0.06661827370077533 + index, y_min: 0.7999999999999999, x_max: 11.2018526541 + index, y_max: 23.000000000000004 },
        attributes: { helmet_state: 'unknown', score: 0.30000000000000004, checked: false, note: '原始 exact / null' },
        origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null } })),
    };
    const storage = new IndexedDbDraftStorage();
    const transport: SaveTransport = {
      save: async () => { throw new Error('Edge journal smoke must not send synthetic suggestion ids to server'); },
      fetchHead: async () => { throw new Error('Edge smoke does not adopt server data'); },
      fetchRevision: async () => { throw new Error('Edge smoke does not fetch historical server revisions'); },
    };
    // This separate edge journal never schedules HTTP during the bounded smoke;
    // every enqueue still immediately invokes the production full-record IDB put.
    const queue = new SaveQueue({ storage, transport, debounceMs: 60_000 });
    const canvas = window.document.createElement('canvas');
    canvas.style.width = '640px'; canvas.style.height = '480px';
    window.document.body.append(canvas);
    const host = new EditorHost({ onDelta: delta => {
      if (delta.error) return;
      const mirror = host.getCommittedSnapshot(delta);
      if (mirror) queue.enqueue({ asset_revision_id: media.asset_revision_id, ontology_version_id: ontology.ontology_version_id,
        base_revision_id: 'edge-base', generation: delta.generation, document: mirror, suggestion_decisions: delta.suggestion_decisions });
    } });
    host.mount(canvas);
    const mutations: { command: string; generation: number; completion: string; order: string[]; journal: string[] }[] = [];
    const ownedVersions: { delta: EditorDelta; document: AnnotationDocument; wire: string }[] = [];
    let sharingChecks = 0;
    let equalBoundaries = 0;
    try {
      await host.loadAsset({ media, ontology, document, frame: { width: 64, height: 48, rgba: new Uint8Array(64 * 48 * 4) }, initial_generation: 700 });
      const nativeHost = host as unknown as { facade: EditorFacade };
      const facade = nativeHost.facade;
      if (!equalWire(host.getSnapshot(), document)) throw new Error('Native load changed headers, fractional numbers or attributes');
      function equalWire(left: unknown, right: unknown): boolean {
        if (Object.is(left, right)) return true;
        if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
        const a = left as Record<string, unknown>;
        const b = right as Record<string, unknown>;
        return Object.keys(a).length === Object.keys(b).length &&
          Object.keys(a).every(key => Object.hasOwn(b, key) && equalWire(a[key], b[key]));
      }
      let previous: AnnotationDocument = host.getSnapshot()!;
      async function mutate(command: EditorCommand) {
        const delta = host.dispatch(command)!;
        if (delta.error) throw new Error(`${command.kind}: ${delta.error.code}`);
        const mirror = host.getCommittedSnapshot(delta);
        if (!mirror) throw new Error(`${command.kind} did not expose a committed document`);
        const native = facade.get_snapshot();
        if (JSON.stringify(mirror) !== JSON.stringify(native)) throw new Error(`${command.kind} mirror/native drift`);
        for (const object of mirror.objects) {
          const old = previous.objects.find(item => item.object_id === object.object_id);
          if (ownedVersions.length > 0 && old && !delta.changed_objects.some(item => item.object_id === object.object_id) && old !== object) throw new Error('Unchanged native object reference was replaced');
          if (old && old === object) sharingChecks++;
        }
        if (!Object.isFrozen(mirror) || !Object.isFrozen(mirror.objects) || mirror.objects.some(object => !Object.isFrozen(object.attributes) || !Object.isFrozen(object.geometry))) throw new Error('Producer document contains mutable descendants');
        await queue.whenPersisted(media.asset_revision_id);
        const stored = await storage.get(media.asset_revision_id);
        if (!stored || stored.generation !== delta.generation || JSON.stringify(stored.document) !== JSON.stringify(native)) throw new Error(`${command.kind} full IDB record drift`);
        const enqueued = queue.toRecord(media.asset_revision_id)!;
        if (enqueued.document !== mirror) throw new Error('Queue copied privately owned document');
        if (JSON.stringify(stored.intent_journal) !== JSON.stringify(enqueued.intent_journal)) throw new Error('IDB ordered journal changed');
        ownedVersions.push({ delta, document: mirror, wire: JSON.stringify(mirror) });
        previous = mirror;
        equalBoundaries++;
        mutations.push({ command: command.kind, generation: delta.generation, completion: mirror.completion,
          order: mirror.objects.map(object => object.object_id), journal: stored.intent_journal.map(entry => entry.intent.decision) });
        return delta;
      }
      await mutate({ kind: 'set_attributes', object_ids: ['middle'], values: { helmet_state: 'not_wearing', score: 0.12345678901234566, checked: true, note: null } });
      await mutate({ kind: 'duplicate', object_ids: ['first', 'last'], new_ids: ['copy-first', 'copy-last'] });
      await mutate({ kind: 'delete', object_ids: ['middle', 'copy-first'] });
      await mutate({ kind: 'undo' });
      if (previous.objects.map(object => object.object_id).join() !== 'first,middle,last,copy-first,copy-last') throw new Error('Middle-delete undo did not restore native order');
      await mutate({ kind: 'redo' });
      await mutate({ kind: 'undo' });
      await mutate({ kind: 'replace_geometry', object_id: 'middle', geometry: { ...previous.objects[1].geometry, x_min: 1.0000000000000002 } });
      await mutate({ kind: 'set_completion', completion: 'in_progress' });
      await mutate({ kind: 'set_completion', completion: 'complete' });
      await mutate({ kind: 'delete', object_ids: previous.objects.map(object => object.object_id) });
      await mutate({ kind: 'set_completion', completion: 'confirmed_negative' });
      await mutate({ kind: 'undo' });
      await mutate({ kind: 'undo' });
      await mutate({ kind: 'create', object: { ...previous.objects[0], object_id: 'created' } });
      await mutate({ kind: 'undo' });
      await mutate({ kind: 'redo' });
      function suggestion(changeId: string, value: string): SuggestionSet {
        return { suggestion_set_id: `edge-set-${changeId}`, prediction_id: 'edge-prediction', model_run_id: 'edge-run',
          context: { project_id: projectId, asset_revision_id: media.asset_revision_id, ontology_version_id: ontology.ontology_version_id,
            annotation_revision_id: 'edge-base', draft_generation: host.getGeneration()!, canonical_sha256: media.canonical_sha256,
            selected_object_ids: ['first'], object_hashes: host.getObjectHashes()!, input_fingerprint: 'synthetic-native-only' },
          changes: [{ kind: 'set_attributes', change_id: changeId, object_id: 'first', values: { helmet_state: value },
            before_hash: host.getObjectHashes()!['first'], reason: 'synthetic mirror regression' }], issues: [], score: null, state: 'pending' };
      }
      const accepted = suggestion('accept', 'wearing');
      await mutate({ kind: 'apply_suggestions', set: accepted, change_ids: ['accept'], expected_generation: host.getGeneration()! });
      await mutate({ kind: 'undo' });
      await mutate({ kind: 'redo' });
      const generation = host.getGeneration()!;
      const decisionOnly = suggestion('equal', 'wearing');
      const sameGeneration = await mutate({ kind: 'apply_suggestions', set: decisionOnly, change_ids: ['equal'], expected_generation: generation });
      if (sameGeneration.generation !== generation || sameGeneration.document_changed || sameGeneration.suggestion_decisions[0]?.decision !== 'accept') throw new Error('Value-equal accept lost same-generation decision');
      const journal = queue.toRecord(media.asset_revision_id)!.intent_journal;
      if (journal.map(entry => entry.intent.decision).join() !== 'accept,revert,accept,accept') throw new Error('Ordered decision journal lost transition');
      for (const version of ownedVersions) {
        if (host.getCommittedSnapshot(version.delta) !== version.document || JSON.stringify(version.document) !== version.wire) throw new Error('Old committed version changed after future edits');
      }
      for (const stale of [generation - 1, generation + 0.5, NaN, Infinity]) {
        let rejected = false;
        try { facade.get_commit_readback(stale, []); } catch (error) { rejected = !!error && typeof error === 'object' && 'code' in error && error.code === 'STALE_GENERATION'; }
        if (!rejected) throw new Error('Native stale generation readback was not rejected');
      }
      const latestWire = JSON.stringify(previous);
      const failed = host.dispatch({ kind: 'replace_geometry', object_id: 'missing', geometry: previous.objects[0].geometry })!;
      if (!failed.error || host.getCommittedSnapshot(failed) !== null || JSON.stringify(previous) !== latestWire) throw new Error('Failed mutation changed mirror');
      return { equal_native_and_full_idb_boundaries: equalBoundaries, sharing_checks: sharingChecks, headers: { schema_version: previous.schema_version, asset_revision_id: previous.asset_revision_id, ontology_version_id: previous.ontology_version_id, coordinate_space: previous.coordinate_space },
        generation: host.getGeneration(), same_generation_decision: true, stale_and_malformed_readbacks_rejected: 4, old_versions_retained: ownedVersions.length, mutations, journal };
    } finally { host.dispose(); canvas.remove(); await storage.delete(media.asset_revision_id); }
  }, { ontologySource: ontologyResponse.json.items[0], projectId: seededProject.project_id });
  await writeFile(path.join(report, 'native-edge-observation.json'), JSON.stringify(evidence, null, 2));
  expect(evidence.equal_native_and_full_idb_boundaries).toBe(20);
  expect(evidence.journal.map(entry => entry.intent.decision)).toEqual(['accept', 'revert', 'accept', 'accept']);
});
