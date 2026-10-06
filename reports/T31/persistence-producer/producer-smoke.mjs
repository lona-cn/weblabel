// Reproducible Node-only producer probe, not the T31 hardware acceptance harness.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from '../../../apps/web/node_modules/typescript/lib/typescript.js';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (!url.endsWith('.ts')) return nextLoad(url, context);
    const source = readFileSync(new URL(url), 'utf8');
    // Deliberate negative control, without editing the production source:
    // Object.isFrozen alone must fail the external shallow-root boundary below.
    const probeSource = process.argv.includes('--unsafe-frozen-check')
      ? source.replace('certifiedFrozen.has(value)', 'Object.isFrozen(value)')
      : source;
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(probeSource, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText };
  },
});
const { DraftStore, InMemoryDraftStorage, freezeDeep } = await import('../../../apps/web/src/lib/persistence/draft-store.ts');
const { SaveQueue } = await import('../../../apps/web/src/lib/persistence/save-queue.ts');
function document(count) {
  return {
    schema_version: 1, asset_revision_id: 'owned_asset', ontology_version_id: 'owned_ontology',
    coordinate_space: { type: 'canonical_image_pixels', width: 640, height: 480 }, completion: 'in_progress',
    objects: Array.from({ length: count }, (_, i) => ({
      object_id: `owned_${i}`, label_id: 'owned_label',
      geometry: { type: 'bbox_xyxy', x_min: 0.12345678901234568, y_min: 2.5, x_max: 13.75, y_max: 24.25 },
      attributes: { text: 'owned value', flag: false, scalar: 0.12345678901234568, absent: null },
      origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null },
    })),
  };
}
function record(doc) {
  return { schema_version: 1, asset_revision_id: doc.asset_revision_id, ontology_version_id: doc.ontology_version_id,
    base_revision_id: 'owned_r0', generation: 1, document: doc, pending: null, intent_journal: [],
    synced_generation: 0, synced_intent_seq: 0, updated_at: '2026-10-06T00:00:00.000Z' };
}
const results = [];
for (const count of [2000, 10000]) {
  const doc = document(count);
  const wire = JSON.stringify(doc);
  const storage = new InMemoryDraftStorage();
  const store = new DraftStore(storage);
  let scans = 0;
  const values = Object.values;
  Object.values = function(value) { scans++; return values(value); };
  let initialScans, wrapperScans, repeatScans;
  try {
    freezeDeep(doc);
    initialScans = scans;
    scans = 0;
    await store.save(record(doc));
    wrapperScans = scans;
    scans = 0;
    await store.save(record(doc));
    repeatScans = scans;
  } finally { Object.values = values; }
  assert.equal(JSON.stringify((await store.load('owned_asset')).document), wire);
  assert.throws(() => { doc.objects[0].geometry.x_min = 99; }, TypeError);
  const fresh = document(count);
  Object.freeze(fresh);
  const inputWire = JSON.stringify(fresh);
  const queueStorage = new InMemoryDraftStorage();
  const queue = new SaveQueue({
    storage: queueStorage,
    transport: { save() { throw new Error('remote send is outside this producer probe'); },
      fetchHead() { throw new Error('not used'); }, fetchRevision() { throw new Error('not used'); } },
    clock: { now: () => 0, setTimeout: () => null, clearTimeout: () => {} },
  });
  scans = 0;
  Object.values = function(value) { scans++; return values(value); };
  let enqueueScans;
  try {
    queue.enqueue({ asset_revision_id: 'owned_asset', ontology_version_id: 'owned_ontology',
      base_revision_id: 'owned_r0', generation: 1, document: fresh });
    enqueueScans = scans;
  } finally { Object.values = values; }
  assert.deepEqual(queueStorage.log, [{ method: 'put', asset_revision_id: 'owned_asset' }]);
  const persistedBeforeAwait = queueStorage.get('owned_asset');
  fresh.objects[0].geometry.x_min = 99;
  assert.equal(JSON.stringify((await persistedBeforeAwait).document), inputWire);
  await queue.whenPersisted('owned_asset');
  assert.equal(queue.getStatus('owned_asset').phase, 'saved_local');
  assert.throws(() => { queue.toRecord('owned_asset').document.objects[0].geometry.x_min = 99; }, TypeError);
  const external = Object.freeze(record(Object.freeze(document(1))));
  await store.save(external);
  assert.throws(() => { external.document.objects[0].attributes.text = 'tampered'; }, TypeError);
  results.push({ count, initial_scans: initialScans, certified_document_wrapper_scans: wrapperScans,
    repeated_document_wrapper_scans: repeatScans, enqueue_scans: enqueueScans,
    wire_equal: true, immediate_local_put: true, caller_isolated: true, exposed_geometry_immutable: true,
    shallow_external_descendant_immutable: true, phase: 'saved_local' });
}
const evidence = { node: process.version, scope: 'actual Node producer only; no browser/GPU/full-consumer timing', results };
console.log(JSON.stringify(evidence, null, 2));
const reportIndex = process.argv.indexOf('--report');
if (reportIndex >= 0) writeFileSync(process.argv[reportIndex + 1], JSON.stringify(evidence, null, 2) + '\n');
assert.ok(results.every(row => row.certified_document_wrapper_scans === 2 && row.repeated_document_wrapper_scans === 2),
  'a fresh record should traverse only its root and new empty journal, not its already certified document');
