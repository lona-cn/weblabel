//! Controlled error taxonomy for the provider HTTP boundary.
//!
//! Everything that can go wrong on the wire, and every contract violation in
//! untrusted provider output (tool arguments, candidate drafts), becomes a
//! `ProviderError` with a stable `code`. Error details are redacted with the
//! T16 redaction rules so secrets never reach logs or run events.

import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { AnnotationObject } from '../../../../../packages/contracts/generated/AnnotationObject';
import type { AttributeDef } from '../../../../../packages/contracts/generated/AttributeDef';
import type { BBox } from '../../../../../packages/contracts/generated/BBox';
import type { Change } from '../../../../../packages/contracts/generated/Change';
import type { LabelDef } from '../../../../../packages/contracts/generated/LabelDef';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import type { QualityIssue } from '../../../../../packages/contracts/generated/QualityIssue';
import type { RunIntent } from '../../../../../packages/contracts/generated/RunIntent';
import type { Scalar } from '../../../../../packages/contracts/generated/Scalar';
import { redactText } from '../../security/redaction';

export type ProviderErrorCode =
  | 'base_not_approved'
  | 'ssrf_blocked'
  | 'redirect_rejected'
  | 'secret_ref_invalid'
  | 'unauthorized_401'
  | 'forbidden_403'
  | 'rate_limited_429'
  | 'upstream_5xx'
  | 'request_rejected_4xx'
  | 'timeout'
  | 'network_error'
  | 'invalid_json'
  | 'oversized_response'
  | 'interrupted_stream'
  | 'provider_reported_failure'
  | 'tool_turn_budget_exceeded'
  | 'tool_byte_budget_exceeded'
  | 'tool_time_budget_exceeded'
  | 'image_budget_exceeded'
  | 'image_grant_missing'
  | 'image_invalid'
  | 'invalid_tool_call'
  | 'candidate_invalid'
  | 'method_not_permitted'
  | 'adapter_error';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status: number | null;

  constructor(code: ProviderErrorCode, detail?: string, status: number | null = null) {
    super(detail === undefined ? code : `${code}: ${redactText(detail)}`);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
  }
}

export function mapHttpStatus(status: number, detail?: string): ProviderError {
  if (status === 401) return new ProviderError('unauthorized_401', detail, status);
  if (status === 403) return new ProviderError('forbidden_403', detail, status);
  if (status === 429) return new ProviderError('rate_limited_429', detail, status);
  if (status >= 500) return new ProviderError('upstream_5xx', detail, status);
  return new ProviderError('request_rejected_4xx', detail, status);
}

export function decodeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ProviderError('invalid_json', error instanceof Error ? error.message : 'unparseable JSON');
  }
}

export interface CandidateDraft {
  changes: Change[];
  issues: QualityIssue[];
  score: number | null;
}

export interface CandidateDomainContext {
  intent: RunIntent;
  bbox_output: boolean;
  document: AnnotationDocument;
  ontology: OntologyVersion;
}

const MAX_ID_LENGTH = 128;
const MAX_TEXT_LENGTH = 4096;
const MAX_REASON_LENGTH = 2048;
const MAX_CHANGES = 256;
const MAX_ISSUES = 256;

function invalid(detail: string): ProviderError {
  return new ProviderError('candidate_invalid', detail);
}

// Validation helper for untrusted provider output: throws a controlled
// candidate_invalid on shape violations and returns the checked object.
function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(`${path} must be an object`);
  return value as Record<string, unknown>; // narrowed by the runtime check above
}

function requireId(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH) {
    throw invalid(`${path} must be a non-empty id of at most ${MAX_ID_LENGTH} characters`);
  }
  return value;
}

function requireText(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw invalid(`${path} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function requireFinite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(`${path} must be a finite number`);
  return value;
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw invalid(`${path} has unknown field ${JSON.stringify(key)}`);
  }
}

function requireBBox(value: unknown, path: string, document: AnnotationDocument): BBox {
  const record = requireObject(value, path);
  assertExactKeys(record, ['type', 'x_min', 'y_min', 'x_max', 'y_max'], path);
  if (record.type !== 'bbox_xyxy') throw invalid(`${path}.type must be "bbox_xyxy"`);
  const x_min = requireFinite(record.x_min, `${path}.x_min`);
  const y_min = requireFinite(record.y_min, `${path}.y_min`);
  const x_max = requireFinite(record.x_max, `${path}.x_max`);
  const y_max = requireFinite(record.y_max, `${path}.y_max`);
  if (x_min >= x_max || y_min >= y_max) throw invalid(`${path} must have positive extent`);
  const { width, height } = document.coordinate_space;
  if (x_min < 0 || y_min < 0 || x_max > width || y_max > height) {
    throw invalid(`${path} escapes the canonical image (${width}x${height})`);
  }
  return { type: 'bbox_xyxy', x_min, y_min, x_max, y_max };
}

function requireScalar(value: unknown, path: string): Scalar {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return requireFinite(value, path);
  if (typeof value === 'string') {
    if (value.length > MAX_TEXT_LENGTH) throw invalid(`${path} string exceeds ${MAX_TEXT_LENGTH} characters`);
    return value;
  }
  throw invalid(`${path} must be a scalar (string, boolean, finite number or null)`);
}

function requireAttributes(value: unknown, path: string, defs: AttributeDef[], requireAll: boolean): Record<string, Scalar> {
  const record = requireObject(value, path);
  const values: Record<string, Scalar> = {};
  for (const [key, item] of Object.entries(record)) {
    const def = defs.find((candidate) => candidate.key === key);
    if (def === undefined) throw invalid(`${path}.${key} is not an attribute of the target label`);
    const scalar = requireScalar(item, `${path}.${key}`);
    if (def.kind === 'boolean' && typeof scalar !== 'boolean') throw invalid(`${path}.${key} must be a boolean`);
    if (def.kind === 'number' && typeof scalar !== 'number') throw invalid(`${path}.${key} must be a number`);
    if (def.kind === 'text' && typeof scalar !== 'string') throw invalid(`${path}.${key} must be text`);
    if (def.kind === 'enum' && (typeof scalar !== 'string' || !def.enum_values.includes(scalar))) {
      throw invalid(`${path}.${key} must be one of ${def.enum_values.join(', ')}`);
    }
    if (typeof scalar === 'number') {
      if (def.min !== null && scalar < def.min) throw invalid(`${path}.${key} is below the minimum`);
      if (def.max !== null && scalar > def.max) throw invalid(`${path}.${key} is above the maximum`);
    }
    values[key] = scalar;
  }
  if (requireAll) {
    for (const def of defs) {
      if (def.required && !(def.key in values)) throw invalid(`${path}.${def.key} is required by the ontology`);
    }
  }
  return values;
}

function labelOf(ontology: OntologyVersion, label_id: string, path: string): LabelDef {
  const label = ontology.labels.find((candidate) => candidate.label_id === label_id);
  if (label === undefined) throw invalid(`${path} references unknown label ${JSON.stringify(label_id)}`);
  return label;
}

function objectOf(document: AnnotationDocument, object_id: string, path: string): AnnotationObject {
  const object = document.objects.find((candidate) => candidate.object_id === object_id);
  if (object === undefined) throw invalid(`${path} references unknown object ${JSON.stringify(object_id)}`);
  return object;
}

function requireBeforeHash(value: unknown, path: string): string {
  return requireText(value, path, MAX_ID_LENGTH);
}

function validateCreateObject(value: unknown, path: string, ctx: CandidateDomainContext): AnnotationObject {
  const record = requireObject(value, path);
  assertExactKeys(record, ['object_id', 'label_id', 'geometry', 'attributes', 'origin'], path);
  const object_id = requireId(record.object_id, `${path}.object_id`);
  const label_id = requireId(record.label_id, `${path}.label_id`);
  const label = labelOf(ctx.ontology, label_id, `${path}.label_id`);
  const geometry = requireBBox(record.geometry, `${path}.geometry`, ctx.document);
  const attributes = requireAttributes(record.attributes, `${path}.attributes`, label.attributes, true);
  const origin = requireObject(record.origin, `${path}.origin`);
  assertExactKeys(origin, ['type', 'prediction_id', 'model_run_id', 'import_batch_id'], path);
  if (origin.type !== 'prediction') throw invalid(`${path}.origin.type must be "prediction" for model output`);
  if (origin.prediction_id !== null || origin.model_run_id !== null || origin.import_batch_id !== null) {
    throw invalid(`${path}.origin ids are assigned by the server and must be null`);
  }
  return {
    object_id,
    label_id,
    geometry,
    attributes,
    origin: { type: 'prediction', prediction_id: null, model_run_id: null, import_batch_id: null },
  };
}

function validateChange(value: unknown, path: string, ctx: CandidateDomainContext, seen: Set<string>): Change {
  const record = requireObject(value, path);
  const kind = record.kind;
  const change_id = requireId(record.change_id, `${path}.change_id`);
  if (seen.has(change_id)) throw invalid(`${path}.change_id ${JSON.stringify(change_id)} is duplicated`);
  seen.add(change_id);
  const reason = requireText(record.reason, `${path}.reason`, MAX_REASON_LENGTH);
  if (kind === 'create') {
    assertExactKeys(record, ['kind', 'change_id', 'object', 'before_hash', 'reason'], path);
    if (ctx.intent !== 'detect' || !ctx.bbox_output) {
      throw invalid(`${path}: create changes are only allowed for a bbox-capable detect run`);
    }
    if (record.before_hash !== null) throw invalid(`${path}.before_hash must be null for create`);
    return { kind: 'create', change_id, object: validateCreateObject(record.object, `${path}.object`, ctx), before_hash: null, reason };
  }
  if (kind === 'set_attributes') {
    assertExactKeys(record, ['kind', 'change_id', 'object_id', 'values', 'before_hash', 'reason'], path);
    const object_id = requireId(record.object_id, `${path}.object_id`);
    const object = objectOf(ctx.document, object_id, `${path}.object_id`);
    const label = labelOf(ctx.ontology, object.label_id, `${path}.object_id`);
    return {
      kind: 'set_attributes',
      change_id,
      object_id,
      values: requireAttributes(record.values, `${path}.values`, label.attributes, false),
      before_hash: requireBeforeHash(record.before_hash, `${path}.before_hash`),
      reason,
    };
  }
  if (kind === 'set_label') {
    assertExactKeys(record, ['kind', 'change_id', 'object_id', 'label_id', 'before_hash', 'reason'], path);
    const object_id = requireId(record.object_id, `${path}.object_id`);
    objectOf(ctx.document, object_id, `${path}.object_id`);
    const label_id = requireId(record.label_id, `${path}.label_id`);
    labelOf(ctx.ontology, label_id, `${path}.label_id`);
    return {
      kind: 'set_label',
      change_id,
      object_id,
      label_id,
      before_hash: requireBeforeHash(record.before_hash, `${path}.before_hash`),
      reason,
    };
  }
  throw invalid(`${path}.kind must be create, set_attributes or set_label`);
}

function validateIssue(value: unknown, path: string, ctx: CandidateDomainContext): QualityIssue {
  const record = requireObject(value, path);
  assertExactKeys(record, ['issue_id', 'object_id', 'code', 'message', 'region'], path);
  const issue_id = requireId(record.issue_id, `${path}.issue_id`);
  let object_id: string | null = null;
  if (record.object_id !== null) {
    object_id = requireId(record.object_id, `${path}.object_id`);
    objectOf(ctx.document, object_id, `${path}.object_id`);
  }
  const code = requireText(record.code, `${path}.code`, MAX_ID_LENGTH);
  const message = requireText(record.message, `${path}.message`, MAX_TEXT_LENGTH);
  const region = record.region === null ? null : requireBBox(record.region, `${path}.region`, ctx.document);
  return { issue_id, object_id, code, message, region };
}

export function validateQualityIssues(input: unknown, ctx: CandidateDomainContext): QualityIssue[] {
  if (!Array.isArray(input)) throw invalid('issues must be an array');
  if (input.length > MAX_ISSUES) throw invalid(`issues exceeds ${MAX_ISSUES} entries`);
  const seen = new Set<string>();
  return input.map((value, index) => {
    const issue = validateIssue(value, `issues[${index}]`, ctx);
    if (seen.has(issue.issue_id)) throw invalid(`issues[${index}].issue_id ${JSON.stringify(issue.issue_id)} is duplicated`);
    seen.add(issue.issue_id);
    return issue;
  });
}

export function validateCandidateDraft(input: unknown, ctx: CandidateDomainContext): CandidateDraft {
  const record = requireObject(input, 'candidate');
  assertExactKeys(record, ['changes', 'issues', 'score'], 'candidate');
  if (!('changes' in record)) throw invalid('candidate.changes is required');
  if (!Array.isArray(record.changes)) throw invalid('candidate.changes must be an array');
  if (record.changes.length > MAX_CHANGES) throw invalid(`candidate.changes exceeds ${MAX_CHANGES} entries`);
  const seen = new Set<string>();
  const changes = record.changes.map((value, index) => validateChange(value, `changes[${index}]`, ctx, seen));
  const issues = 'issues' in record ? validateQualityIssues(record.issues, ctx) : [];
  let score: number | null = null;
  if ('score' in record && record.score !== null) score = requireFinite(record.score, 'candidate.score');
  return { changes, issues, score };
}

export type ToolName = 'read_region' | 'propose_changes' | 'report_issues';

export type ToolCallArgs =
  | { tool: 'read_region'; region: BBox | null }
  | { tool: 'propose_changes'; draft: CandidateDraft }
  | { tool: 'report_issues'; issues: QualityIssue[] };

function invalidTool(detail: string): ProviderError {
  return new ProviderError('invalid_tool_call', detail);
}

export function parseToolCallArguments(name: string, raw: unknown, ctx: CandidateDomainContext): ToolCallArgs {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown;
    } catch (error) {
      throw invalidTool(`${name} arguments are not valid JSON: ${error instanceof Error ? error.message : 'unparseable'}`);
    }
  }
  if (name === 'read_region') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidTool('read_region arguments must be an object');
    const record = value as Record<string, unknown>; // narrowed by the runtime check above
    assertToolKeys(record, ['region'], 'read_region');
    if (!('region' in record)) throw invalidTool('read_region.region is required');
    return { tool: 'read_region', region: requireToolBBox(record.region, ctx) };
  }
  if (name === 'propose_changes') {
    return { tool: 'propose_changes', draft: validateCandidateDraft(value, ctx) };
  }
  if (name === 'report_issues') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidTool('report_issues arguments must be an object');
    const record = value as Record<string, unknown>; // narrowed by the runtime check above
    assertToolKeys(record, ['issues'], 'report_issues');
    if (!('issues' in record)) throw invalidTool('report_issues.issues is required');
    return { tool: 'report_issues', issues: validateQualityIssues(record.issues, ctx) };
  }
  throw invalidTool(`unknown tool ${JSON.stringify(name)}`);
}

function assertToolKeys(record: Record<string, unknown>, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw invalidTool(`${name} arguments have unknown field ${JSON.stringify(key)}`);
  }
}

function requireToolBBox(value: unknown, ctx: CandidateDomainContext): BBox | null {
  if (value === null) return null;
  try {
    return requireBBox(value, 'read_region.region', ctx.document);
  } catch (error) {
    if (error instanceof ProviderError) throw invalidTool(error.message);
    throw error;
  }
}
