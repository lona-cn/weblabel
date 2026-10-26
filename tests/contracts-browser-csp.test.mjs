import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateContract } from '../packages/contracts/src/validate-browser.js';

// This entry point is deliberately the public browser validator, not the Node
// AJV compiler. Run with --disallow-code-generation-from-strings after generation.
const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/golden/${name}.json`, import.meta.url), 'utf8'));
const document = load('document');
const media = load('media');
const revision = {
  annotation_revision_id: 'revision_golden',
  parent_revision_id: null,
  revision_no: 1,
  document,
  created_at: '2026-09-25T12:00:00Z',
  created_by: 'user_golden',
  content_hash: 'hash',
};
const head = {
  annotation_revision_id: revision.annotation_revision_id,
  approved_review_id: null,
  completion: document.completion,
  content_hash: revision.content_hash,
  object_count: document.objects.length,
  ontology_version_id: document.ontology_version_id,
  revision_no: revision.revision_no,
};
const member = { user_id: 'user_golden', username: 'synthetic-user', role: 'annotator' };
const event = { run_id: 'run_golden', seq: 0, type: 'progress', message: '', data: null };
const assetHead = { head, media };
const examples = [
  ['bootstrap_status', { bootstrap_available: true, mode: 'initial' }],
  ['admin_recovery_status', { state: 'available', request_id: null, username: 'synthetic-user' }],
  ['admin_recovery_request', { password: 'synthetic-only', recovery_code: 'synthetic-only' }],
  ['run_event', event],
  ['suggestion_set', load('prediction')],
  ['annotation_head_summary', head],
  ['annotation_head_page', { items: [head], next_cursor: null }],
  ['asset_annotation_head', assetHead],
  ['asset_annotation_head_page', { items: [assetHead], next_cursor: null }],
  ['project_member_role', 'annotator'],
  ['project_member', member],
  ['project_member_page', { items: [member], next_cursor: null }],
  ['annotation_import_commit_request', { lease: null, loss_ack: false, operation_id: 'import_golden' }],
  ['annotation_revision', revision],
  ['save_response', { operation_id: 'save_golden', revision, idempotent_replay: false }],
  ['annotation_document', document],
  ['save_request', load('save')],
];

for (const [name, value] of examples) {
  test(`browser validates ${name} without string code generation`, () => {
    const original = structuredClone(value);
    assert.deepEqual(validateContract(name, value), { valid: true, errors: [] });
    assert.deepEqual(value, original, 'validation must not mutate the payload');
    const invalid = validateContract(name, null);
    assert.equal(invalid.valid, false);
    assert.ok(invalid.errors.length > 0);
  });
}

test('browser preserves allErrors and the public error shape across calls', () => {
  const result = validateContract('bootstrap_status', { bootstrap_available: 'yes', mode: 'unknown', extra: true });
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 3);
  assert.ok(result.errors.some(({ keyword, instancePath }) => keyword === 'additionalProperties' && instancePath === ''));
  assert.ok(result.errors.some(({ keyword, instancePath }) => keyword === 'type' && instancePath === '/bootstrap_available'));
  assert.ok(result.errors.some(({ keyword, instancePath }) => keyword === 'enum' && instancePath === '/mode'));
  for (const error of result.errors) {
    assert.deepEqual(Object.keys(error).sort(), ['instancePath', 'keyword', 'message']);
    assert.equal(typeof error.message, 'string');
  }
  const errors = structuredClone(result.errors);
  assert.deepEqual(validateContract('bootstrap_status', { bootstrap_available: false, mode: 'login' }), { valid: true, errors: [] });
  assert.deepEqual(result.errors, errors, 'later validations must not overwrite returned errors');
});

test('browser rejects invalid nested geometry, attributes and save leases', () => {
  const invalidGeometry = structuredClone(document);
  invalidGeometry.objects[0].geometry.type = 'unknown';
  const geometryResult = validateContract('annotation_document', invalidGeometry);
  assert.equal(geometryResult.valid, false);
  assert.ok(geometryResult.errors.some(({ instancePath }) => instancePath === '/objects/0/geometry/type'));

  for (const attributes of [{ '': 'value' }, { ['x'.repeat(129)]: 'value' }, { key: 'x'.repeat(4097) }]) {
    const invalidAttributes = structuredClone(document);
    invalidAttributes.objects[0].attributes = attributes;
    assert.equal(validateContract('annotation_document', invalidAttributes).valid, false);
  }
  const save = load('save');
  save.lease = { task_id: 'task_golden', fencing_token: Number.MAX_SAFE_INTEGER };
  assert.equal(validateContract('save_request', save).valid, true);
  save.lease.fencing_token += 1;
  assert.equal(validateContract('save_request', save).valid, false);
});

test('browser retains uint8 validation and narrower schema bounds', () => {
  assert.equal(validateContract('annotation_document', document).valid, true);
  for (const value of [-1, 0, 1.5, 2, 255, 256, NaN, Infinity, '1']) {
    const candidate = structuredClone(document);
    candidate.schema_version = value;
    assert.equal(validateContract('annotation_document', candidate).valid, false, `schema_version ${value}`);
  }
  for (const value of [1, 8]) {
    const candidate = structuredClone(assetHead);
    candidate.media.exif_orientation = value;
    assert.equal(validateContract('asset_annotation_head', candidate).valid, true);
  }
  for (const value of [0, 9, 255, 256, -1, 1.5]) {
    const candidate = structuredClone(assetHead);
    candidate.media.exif_orientation = value;
    assert.equal(validateContract('asset_annotation_head', candidate).valid, false, `exif_orientation ${value}`);
  }
});

test('browser retains uint32 integer and inclusive upper bounds', () => {
  for (const value of [1, 4_294_967_295]) {
    const candidate = structuredClone(document);
    candidate.coordinate_space.width = value;
    assert.equal(validateContract('annotation_document', candidate).valid, true);
  }
  for (const value of [0, -1, 1.5, 4_294_967_296, NaN, Infinity, '640']) {
    const candidate = structuredClone(document);
    candidate.coordinate_space.width = value;
    assert.equal(validateContract('annotation_document', candidate).valid, false, `width ${value}`);
  }
});

test('browser retains uint64 safe-integer boundaries', () => {
  for (const seq of [0, Number.MAX_SAFE_INTEGER]) {
    assert.equal(validateContract('run_event', { ...event, seq }).valid, true);
  }
  for (const seq of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.MAX_VALUE, NaN, Infinity, '0']) {
    const result = validateContract('run_event', { ...event, seq });
    assert.equal(result.valid, false, `seq ${seq}`);
    assert.ok(result.errors.some(({ instancePath }) => instancePath === '/seq'));
  }
});

test('browser accepts finite doubles and rejects nonfinite geometry, attributes and transforms', () => {
  for (const value of [-Number.MAX_VALUE, -0, 0, Number.MIN_VALUE, 0.125, Number.MAX_VALUE]) {
    const candidate = structuredClone(document);
    candidate.objects[0].geometry.x_min = value;
    candidate.objects[0].attributes.numeric = value;
    assert.equal(validateContract('annotation_document', candidate).valid, true, `finite double ${value}`);
  }
  for (const value of [NaN, Infinity, -Infinity]) {
    const geometry = structuredClone(document);
    geometry.objects[0].geometry.x_min = value;
    assert.equal(validateContract('annotation_document', geometry).valid, false);
    const attributes = structuredClone(document);
    attributes.objects[0].attributes.numeric = value;
    assert.equal(validateContract('annotation_document', attributes).valid, false);
    const transform = structuredClone(assetHead);
    transform.media.original_to_canonical[0] = value;
    assert.equal(validateContract('asset_annotation_head', transform).valid, false);
  }
});

test('browser keeps date-time strings unchecked without relaxing their string type', () => {
  for (const created_at of ['2026-09-25T12:00:00Z', '2026-09-25T12:00:00+01:00', 'not-a-date']) {
    assert.equal(validateContract('annotation_revision', { ...revision, created_at }).valid, true);
  }
  assert.equal(validateContract('annotation_revision', { ...revision, created_at: 42 }).valid, false);
});

test('browser rejects unknown contract names including prototype keys', () => {
  for (const name of ['', 'missing_contract', 'constructor', 'toString', '__proto__', 'hasOwnProperty', 'ontology_version']) {
    assert.throws(() => validateContract(name, {}), {
      name: 'RangeError',
      message: `unknown generated contract: ${name}`,
    });
  }
});
