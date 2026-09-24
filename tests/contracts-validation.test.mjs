import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateAnnotationDocument, validateContract } from '../packages/contracts/src/validate.js';

const document = JSON.parse(readFileSync(new URL('./fixtures/golden/document.json', import.meta.url), 'utf8'));

test('Node validates canonical documents with Rust-generated JSON Schema', () => {
  assert.deepEqual(validateAnnotationDocument(document), { valid: true, errors: [] });

  const unknownGeometry = structuredClone(document);
  unknownGeometry.objects[0].geometry.type = 'unknown';
  const invalidGeometry = validateAnnotationDocument(unknownGeometry);
  assert.equal(invalidGeometry.valid, false);
  assert.ok(invalidGeometry.errors.some(({ instancePath }) => instancePath.includes('/geometry')));

  const oversizedId = structuredClone(document);
  oversizedId.asset_revision_id = 'x'.repeat(129);
  assert.equal(validateAnnotationDocument(oversizedId).valid, false);

  const oversizedAttributeKey = structuredClone(document);
  oversizedAttributeKey.objects[0].attributes['x'.repeat(129)] = 'value';
  assert.equal(validateAnnotationDocument(oversizedAttributeKey).valid, false);

  const oversizedAttributeValue = structuredClone(document);
  oversizedAttributeValue.objects[0].attributes.helmet_state = 'x'.repeat(4097);
  assert.equal(validateAnnotationDocument(oversizedAttributeValue).valid, false);
});

test('Node validates Rust-generated provider, save and revision schemas', () => {
  const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/golden/${name}.json`, import.meta.url), 'utf8'));
  for (const [schema, fixture] of [
    ['ontology_version', 'ontology'],
    ['media_revision', 'media'],
    ['save_request', 'save'],
    ['suggestion_set', 'prediction'],
  ]) {
    assert.equal(validateContract(schema, load(fixture)).valid, true, `${schema} fixture should validate`);
  }

  const annotation = load('document');
  assert.equal(validateContract('annotation_document', annotation).valid, true);
  annotation.schema_version = 2;
  assert.equal(validateContract('annotation_document', annotation).valid, false);

  const revision = {
    annotation_revision_id: 'revision_v1',
    parent_revision_id: null,
    revision_no: 1,
    document: load('document'),
    created_at: '2026-09-25T12:00:00Z',
    created_by: 'user_v1',
    content_hash: 'hash',
  };
  assert.equal(validateContract('annotation_revision', revision).valid, true);

  revision.created_at = '2026-09-25T12:00:00+01:00';
  assert.equal(validateContract('annotation_revision', revision).valid, false);

  const event = { run_id: 'run_v1', seq: 9_007_199_254_740_991, type: 'progress', message: '', data: null };
  assert.equal(validateContract('run_event', event).valid, true);
  event.seq += 1;
  assert.equal(validateContract('run_event', event).valid, false);
});
test('Node validates generated C3 command, change and delta schemas', () => {
  const object = document.objects[0];
  const prediction = JSON.parse(readFileSync(new URL('./fixtures/golden/prediction.json', import.meta.url), 'utf8'));
  const commands = [
    { kind: 'create', object },
    { kind: 'replace_geometry', object_id: object.object_id, geometry: object.geometry },
    { kind: 'set_attributes', object_ids: [object.object_id], values: { helmet_state: 'wearing' } },
    { kind: 'set_label', object_ids: [object.object_id], label_id: object.label_id },
    { kind: 'delete', object_ids: [object.object_id] },
    { kind: 'duplicate', object_ids: [object.object_id], new_ids: ['object_copy'] },
    { kind: 'set_completion', completion: 'complete' },
    {
      kind: 'apply_suggestions',
      set: prediction,
      change_ids: [prediction.changes[0].change_id],
      expected_generation: 0,
    },
    { kind: 'undo' },
    { kind: 'redo' },
  ];
  for (const command of commands) {
    assert.equal(validateContract('editor_command', command).valid, true, `${command.kind} should validate`);
  }
  assert.equal(validateContract('editor_command', { kind: 'SetCompletion', completion: 'complete' }).valid, false);

  const change = {
    kind: 'set_attributes',
    change_id: 'change_1',
    object_id: 'object_1',
    values: { helmet_state: 'wearing' },
    before_hash: 'hash',
    reason: 'fixture',
  };
  const suggestion = {
    suggestion_set_id: 'suggestion_1',
    model_run_id: 'run_1',
    prediction_id: 'prediction_1',
    context: {
      project_id: 'project_1',
      asset_revision_id: 'asset_1',
      annotation_revision_id: 'revision_1',
      ontology_version_id: 'ontology_1',
      draft_generation: 0,
      canonical_sha256: 'hash',
      selected_object_ids: [],
      object_hashes: {},
      input_fingerprint: 'fingerprint',
    },
    changes: [change],
    issues: [],
    score: null,
    state: 'pending',
  };
  assert.equal(validateContract('suggestion_set', suggestion).valid, true);

  for (const variant of [
    {
      kind: 'create',
      change_id: 'change_create',
      object,
      before_hash: null,
      reason: 'fixture',
    },
    {
      kind: 'set_label',
      change_id: 'change_label',
      object_id: object.object_id,
      label_id: object.label_id,
      before_hash: 'hash',
      reason: 'fixture',
    },
  ]) {
    const variantSuggestion = structuredClone(suggestion);
    variantSuggestion.changes = [variant];
    assert.equal(validateContract('suggestion_set', variantSuggestion).valid, true, `${variant.kind} should validate`);
  }

  for (const values of [{ '': 'value' }, { ['x'.repeat(129)]: 'value' }, { key: 'x'.repeat(4097) }]) {
    const invalidValues = structuredClone(suggestion);
    invalidValues.changes[0].values = values;
    assert.equal(validateContract('suggestion_set', invalidValues).valid, false);
  }

  const invalidKind = structuredClone(suggestion);
  invalidKind.changes[0].kind = 'SetAttributes';
  assert.equal(validateContract('suggestion_set', invalidKind).valid, false);

  const delta = {
    generation: 0,
    changed_objects: [],
    removed_object_ids: [],
    selected_object_ids: [],
    can_undo: false,
    can_redo: false,
    document_changed: false,
    repaint: false,
    suggestion_decisions: [],
    error: null,
  };
  assert.equal(validateContract('editor_delta', delta).valid, true);
  for (const field of Object.keys(delta)) {
    const missingField = structuredClone(delta);
    delete missingField[field];
    assert.equal(validateContract('editor_delta', missingField).valid, false, `missing ${field} should fail`);
  }
  const invalidGeneration = structuredClone(delta);
  invalidGeneration.generation = 1.5;
  assert.equal(validateContract('editor_delta', invalidGeneration).valid, false);
});
