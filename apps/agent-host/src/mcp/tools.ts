/**
 * The five frozen semantic tool schemas and strict argument validation for the
 * T21 stdio MCP server (docs/contracts.md C5).
 *
 * Every schema is a JSON Schema object with `additionalProperties: false`:
 * anything outside the frozen tables is rejected before it can reach the API.
 * Arguments can never name projects, runs, actors, files, URLs or commands —
 * identity comes from the run token context only. Validation here is defense in
 * depth: the service-side validation behind `/internal/agent-tools/{tool}` is
 * authoritative.
 */

export const TOOL_NAMES = [
  'get_context',
  'list_objects',
  'propose_changes',
  'read_region',
  'report_issues',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const MAX_ARGS_CHARS = 262_144;
export const MAX_CHANGES = 1000;
export const MAX_ISSUES = 1000;
export const MAX_CURSOR_CHARS = 128;
export const MAX_ID_CHARS = 128;
export const MAX_REASON_CHARS = 4096;
export const MAX_MESSAGE_CHARS = 4096;
export const MAX_CODE_CHARS = 128;
export const MAX_ATTRIBUTE_CHARS = 4096;
export const MAX_LIST_LIMIT = 100;

const IDENTITY_KEYS = [
  'project_id',
  'run_id',
  'asset_revision_id',
  'annotation_revision_id',
  'ontology_version_id',
  'actor_id',
  'user_id',
];

const FORBIDDEN_KEYS = ['path', 'url', 'file', 'filename', 'grant_id', 'command', 'argv', 'cwd'];

export class ToolArgsError extends Error {
  readonly code: string;

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'ToolArgsError';
    this.code = code;
  }
}

function rejected(code: string, detail: string): ToolArgsError {
  return new ToolArgsError(code, detail);
}

export interface JsonSchema {
  [key: string]: unknown;
}

export interface ToolSpec {
  name: ToolName;
  description: string;
  inputSchema: JsonSchema;
}

export type ToolArgs = Record<string, unknown>;

const bboxSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'x_min', 'y_min', 'x_max', 'y_max'],
  properties: {
    type: { const: 'bbox_xyxy' },
    x_min: { type: 'number' },
    y_min: { type: 'number' },
    x_max: { type: 'number' },
    y_max: { type: 'number' },
  },
};

const nullableIdSchema: JsonSchema = { type: ['string', 'null'], maxLength: MAX_ID_CHARS };

const scalarSchema: JsonSchema = {
  anyOf: [
    { type: 'string', maxLength: MAX_ATTRIBUTE_CHARS },
    { type: 'boolean' },
    { type: 'number' },
    { type: 'null' },
  ],
};

const originSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'prediction_id', 'model_run_id', 'import_batch_id'],
  properties: {
    type: { enum: ['manual', 'import', 'prediction'] },
    prediction_id: nullableIdSchema,
    model_run_id: nullableIdSchema,
    import_batch_id: nullableIdSchema,
  },
};

const objectSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['object_id', 'label_id', 'geometry', 'attributes', 'origin'],
  properties: {
    object_id: { type: 'string', minLength: 1, maxLength: MAX_ID_CHARS },
    label_id: { type: 'string', minLength: 1, maxLength: MAX_ID_CHARS },
    geometry: bboxSchema,
    attributes: { type: 'object', additionalProperties: scalarSchema },
    origin: originSchema,
  },
};

const changeSchema: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'change_id', 'object', 'before_hash', 'reason'],
      properties: {
        kind: { const: 'create' },
        change_id: { type: 'string', minLength: 1, maxLength: MAX_ID_CHARS },
        object: objectSchema,
        before_hash: { type: 'null' },
        reason: { type: 'string', maxLength: MAX_REASON_CHARS },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'change_id', 'object_id', 'values', 'before_hash', 'reason'],
      properties: {
        kind: { const: 'set_attributes' },
        change_id: { type: 'string', minLength: 1, maxLength: MAX_ID_CHARS },
        object_id: { type: 'string', minLength: 1, maxLength: MAX_ID_CHARS },
        values: { type: 'object', additionalProperties: scalarSchema },
        before_hash: { type: 'string', minLength: 1, maxLength: 256 },
        reason: { type: 'string', maxLength: MAX_REASON_CHARS },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'change_id', 'object_id', 'label_id', 'before_hash', 'reason'],
      properties: {
        kind: { const: 'set_label' },
        change_id: { type: 'string', minLength: 1, maxLength: MAX_ID_CHARS },
        object_id: { type: 'string', minLength: 1, maxLength: MAX_ID_CHARS },
        label_id: { type: 'string', minLength: 1, maxLength: MAX_ID_CHARS },
        before_hash: { type: 'string', minLength: 1, maxLength: 256 },
        reason: { type: 'string', maxLength: MAX_REASON_CHARS },
      },
    },
  ],
};

const issueSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['issue_id', 'object_id', 'code', 'message', 'region'],
  properties: {
    issue_id: { type: 'string', minLength: 1, maxLength: MAX_ID_CHARS },
    object_id: nullableIdSchema,
    code: { type: 'string', minLength: 1, maxLength: MAX_CODE_CHARS },
    message: { type: 'string', maxLength: MAX_MESSAGE_CHARS },
    region: { oneOf: [{ type: 'null' }, bboxSchema] },
  },
};

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'get_context',
    description:
      'Frozen run context: pinned spec, versions and user intent of this run. The project cannot be switched; server-side validation is authoritative.',
    inputSchema: { type: 'object', additionalProperties: false, required: [], properties: {} },
  },
  {
    name: 'list_objects',
    description:
      'Objects of the frozen run scope with bbox, attributes and object_hash. Cursor pagination; server-side validation is authoritative.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        cursor: { type: ['string', 'null'], maxLength: MAX_CURSOR_CHARS },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT },
      },
    },
  },
  {
    name: 'read_region',
    description:
      'Reads the authorized image or crop of this run with its canonical transform. Consumes crop/pixel budgets; never accepts paths or URLs. Server-side validation is authoritative.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['region'],
      properties: { region: { oneOf: [{ type: 'null' }, bboxSchema] } },
    },
  },
  {
    name: 'propose_changes',
    description:
      'Submits candidate changes for this run. Candidates are only stored after server-side schema/domain/capability validation; this tool can never accept or write annotations. Server-side validation is authoritative.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['changes'],
      properties: {
        changes: { type: 'array', minItems: 1, maxItems: MAX_CHANGES, items: changeSchema },
      },
    },
  },
  {
    name: 'report_issues',
    description:
      'Records suspected quality issues for this run. Issues are candidates for human review and never contain review conclusions. Server-side validation is authoritative.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['issues'],
      properties: {
        issues: { type: 'array', minItems: 1, maxItems: MAX_ISSUES, items: issueSchema },
      },
    },
  },
];

export function isToolName(name: unknown): name is ToolName {
  return typeof name === 'string' && (TOOL_NAMES as readonly string[]).includes(name);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkExactKeys(record: Record<string, unknown>, keys: string[], label: string): void {
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) {
      throw rejected('INVALID_ARGUMENTS', `${label} may not carry ${key}`);
    }
  }
  for (const key of keys) {
    if (!(key in record)) {
      throw rejected('INVALID_ARGUMENTS', `${label} requires ${key}`);
    }
  }
}

function checkId(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_CHARS) {
    throw rejected('INVALID_ARGUMENTS', `${label} must be a non-empty id of at most 128 characters`);
  }
}

function checkBBox(value: unknown, label: string, regionCode: 'INVALID_REGION' | 'INVALID_ARGUMENTS'): void {
  if (!isPlainObject(value)) {
    throw rejected('INVALID_ARGUMENTS', `${label} must be a bbox object`);
  }
  checkExactKeys(value, ['type', 'x_min', 'y_min', 'x_max', 'y_max'], label);
  if (value.type !== 'bbox_xyxy') {
    throw rejected('INVALID_ARGUMENTS', `${label} must use type bbox_xyxy`);
  }
  const coordinates = [value.x_min, value.y_min, value.x_max, value.y_max];
  if (coordinates.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) {
    throw rejected(regionCode, `${label} coordinates must be finite numbers`);
  }
  const [xMin, yMin, xMax, yMax] = coordinates as [number, number, number, number];
  if (xMax <= xMin || yMax <= yMin) {
    throw rejected(regionCode, `${label} must be a non-degenerate box`);
  }
}

function checkAttributes(value: unknown, label: string): void {
  if (!isPlainObject(value)) {
    throw rejected('INVALID_ARGUMENTS', `${label} must be an attributes object`);
  }
  for (const [key, entry] of Object.entries(value)) {
    const kind = typeof entry;
    if (entry !== null && kind !== 'string' && kind !== 'boolean' && kind !== 'number') {
      throw rejected('INVALID_ARGUMENTS', `${label}.${key} must be a scalar`);
    }
    if (kind === 'number' && !Number.isFinite(entry)) {
      throw rejected('INVALID_ARGUMENTS', `${label}.${key} must be finite`);
    }
    if (kind === 'string' && (entry as string).length > MAX_ATTRIBUTE_CHARS) {
      throw rejected('INVALID_ARGUMENTS', `${label}.${key} exceeds ${MAX_ATTRIBUTE_CHARS} characters`);
    }
  }
}

function checkOrigin(value: unknown, label: string): void {
  if (!isPlainObject(value)) {
    throw rejected('INVALID_ARGUMENTS', `${label} must be an origin object`);
  }
  checkExactKeys(value, ['type', 'prediction_id', 'model_run_id', 'import_batch_id'], label);
  if (!['manual', 'import', 'prediction'].includes(String(value.type))) {
    throw rejected('INVALID_ARGUMENTS', `${label} has an unknown origin type`);
  }
  for (const key of ['prediction_id', 'model_run_id', 'import_batch_id']) {
    const entry = value[key];
    if (entry !== null && typeof entry !== 'string') {
      throw rejected('INVALID_ARGUMENTS', `${label}.${key} must be an id or null`);
    }
    if (typeof entry === 'string' && entry.length > MAX_ID_CHARS) {
      throw rejected('INVALID_ARGUMENTS', `${label}.${key} exceeds ${MAX_ID_CHARS} characters`);
    }
  }
}

function checkReason(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.length > MAX_REASON_CHARS) {
    throw rejected('INVALID_ARGUMENTS', `${label} must be a reason of at most ${MAX_REASON_CHARS} characters`);
  }
}

function checkChange(value: unknown, index: number): void {
  const label = `changes[${index}]`;
  if (!isPlainObject(value)) {
    throw rejected('INVALID_ARGUMENTS', `${label} must be a change object`);
  }
  if (value.kind === 'create') {
    checkExactKeys(value, ['kind', 'change_id', 'object', 'before_hash', 'reason'], label);
    if (value.before_hash !== null) {
      throw rejected('INVALID_ARGUMENTS', `${label}.before_hash must be null for create`);
    }
    const object = value.object;
    if (!isPlainObject(object)) {
      throw rejected('INVALID_ARGUMENTS', `${label}.object must be an object`);
    }
    checkExactKeys(object, ['object_id', 'label_id', 'geometry', 'attributes', 'origin'], `${label}.object`);
    checkId(object.object_id, `${label}.object.object_id`);
    checkId(object.label_id, `${label}.object.label_id`);
    checkBBox(object.geometry, `${label}.object.geometry`, 'INVALID_ARGUMENTS');
    checkAttributes(object.attributes, `${label}.object.attributes`);
    checkOrigin(object.origin, `${label}.object.origin`);
  } else if (value.kind === 'set_attributes') {
    checkExactKeys(value, ['kind', 'change_id', 'object_id', 'values', 'before_hash', 'reason'], label);
    checkId(value.object_id, `${label}.object_id`);
    checkAttributes(value.values, `${label}.values`);
    if (typeof value.before_hash !== 'string' || value.before_hash.length === 0) {
      throw rejected('INVALID_ARGUMENTS', `${label}.before_hash must be a non-empty hash`);
    }
  } else if (value.kind === 'set_label') {
    checkExactKeys(value, ['kind', 'change_id', 'object_id', 'label_id', 'before_hash', 'reason'], label);
    checkId(value.object_id, `${label}.object_id`);
    checkId(value.label_id, `${label}.label_id`);
    if (typeof value.before_hash !== 'string' || value.before_hash.length === 0) {
      throw rejected('INVALID_ARGUMENTS', `${label}.before_hash must be a non-empty hash`);
    }
  } else {
    throw rejected('INVALID_ARGUMENTS', `${label}.kind must be create, set_attributes or set_label`);
  }
  checkId(value.change_id, `${label}.change_id`);
  checkReason(value.reason, `${label}.reason`);
}

function checkIssue(value: unknown, index: number): void {
  const label = `issues[${index}]`;
  if (!isPlainObject(value)) {
    throw rejected('INVALID_ARGUMENTS', `${label} must be an issue object`);
  }
  checkExactKeys(value, ['issue_id', 'object_id', 'code', 'message', 'region'], label);
  checkId(value.issue_id, `${label}.issue_id`);
  if (value.object_id !== null) {
    checkId(value.object_id, `${label}.object_id`);
  }
  if (typeof value.code !== 'string' || value.code.length === 0 || value.code.length > MAX_CODE_CHARS) {
    throw rejected('INVALID_ARGUMENTS', `${label}.code must be 1..${MAX_CODE_CHARS} characters`);
  }
  if (typeof value.message !== 'string' || value.message.length > MAX_MESSAGE_CHARS) {
    throw rejected('INVALID_ARGUMENTS', `${label}.message must be at most ${MAX_MESSAGE_CHARS} characters`);
  }
  if (value.region !== null) {
    checkBBox(value.region, `${label}.region`, 'INVALID_ARGUMENTS');
  }
}

/**
 * Strictly validates one tool call against the frozen schema. Throws
 * `ToolArgsError` for anything outside the contract; returns the arguments
 * unchanged on success. Cheap bounds run first, then the payload cap, then the
 * deep per-field structure.
 */
export function validateToolArgs(tool: string, args: unknown): ToolArgs {
  if (!isToolName(tool)) {
    throw rejected('UNKNOWN_TOOL', `tool ${String(tool)} does not exist`);
  }
  if (!isPlainObject(args)) {
    throw rejected('INVALID_ARGUMENTS', `${tool} arguments must be a JSON object`);
  }
  for (const key of Object.keys(args)) {
    if (IDENTITY_KEYS.includes(key)) {
      throw rejected('IDENTITY_OVERRIDE', `${key} comes from the run token and cannot be passed`);
    }
    if (FORBIDDEN_KEYS.includes(key)) {
      throw rejected('FORBIDDEN_ARGUMENT', `${key} would address files, URLs or processes`);
    }
  }

  // Count bounds before the payload cap so oversized batches report the real
  // reason instead of a generic size failure.
  if (tool === 'propose_changes') {
    const changes = args.changes;
    if (!Array.isArray(changes)) {
      throw rejected('INVALID_ARGUMENTS', 'changes must be an array');
    }
    if (changes.length === 0) {
      throw rejected('EMPTY_SUBMISSION', 'changes must contain at least one candidate');
    }
    if (changes.length > MAX_CHANGES) {
      throw rejected('TOO_MANY_CHANGES', `changes may contain at most ${MAX_CHANGES} entries`);
    }
  } else if (tool === 'report_issues') {
    const issues = args.issues;
    if (!Array.isArray(issues)) {
      throw rejected('INVALID_ARGUMENTS', 'issues must be an array');
    }
    if (issues.length === 0) {
      throw rejected('EMPTY_SUBMISSION', 'issues must contain at least one entry');
    }
    if (issues.length > MAX_ISSUES) {
      throw rejected('TOO_MANY_ISSUES', `issues may contain at most ${MAX_ISSUES} entries`);
    }
  }

  if (JSON.stringify(args).length > MAX_ARGS_CHARS) {
    throw rejected('TOO_LARGE', `tool arguments exceed ${MAX_ARGS_CHARS} characters`);
  }

  if (tool === 'get_context') {
    checkExactKeys(args, [], 'get_context');
  } else if (tool === 'list_objects') {
    for (const key of Object.keys(args)) {
      if (key !== 'cursor' && key !== 'limit') {
        throw rejected('INVALID_ARGUMENTS', `list_objects may not carry ${key}`);
      }
    }
    if ('cursor' in args) {
      const cursor = args.cursor;
      if (cursor !== null && (typeof cursor !== 'string' || cursor.length > MAX_CURSOR_CHARS)) {
        throw rejected('INVALID_ARGUMENTS', `cursor must be null or a string of at most ${MAX_CURSOR_CHARS} characters`);
      }
    }
    if ('limit' in args) {
      const limit = args.limit;
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
        throw rejected('INVALID_ARGUMENTS', `limit must be an integer between 1 and ${MAX_LIST_LIMIT}`);
      }
    }
  } else if (tool === 'read_region') {
    checkExactKeys(args, ['region'], 'read_region');
    if (args.region !== null) {
      checkBBox(args.region, 'region', 'INVALID_REGION');
    }
  } else if (tool === 'propose_changes') {
    checkExactKeys(args, ['changes'], 'propose_changes');
    (args.changes as unknown[]).forEach(checkChange);
  } else if (tool === 'report_issues') {
    checkExactKeys(args, ['issues'], 'report_issues');
    (args.issues as unknown[]).forEach(checkIssue);
  }
  return args;
}
