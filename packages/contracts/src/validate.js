import Ajv from 'ajv';
import { readFileSync } from 'node:fs';

const schemaFiles = {
  bootstrap_status: 'bootstrap_status.schema.json',
  annotation_document: 'annotation_document.schema.json',
  ontology_version: 'ontology_version.schema.json',
  media_revision: 'media_revision.schema.json',
  annotation_revision: 'annotation_revision.schema.json',
  save_request: 'save_request.schema.json',
  save_response: 'save_response.schema.json',
  api_error: 'api_error.schema.json',
  model_profile: 'model_profile.schema.json',
  start_run_request: 'start_run_request.schema.json',
  suggestion_set: 'suggestion_set.schema.json',
  run_event: 'run_event.schema.json',
  editor_command: 'editor_command.schema.json',
  editor_delta: 'editor_delta.schema.json',
  ai_approved_grants: 'ai_approved_grants.schema.json',
  ai_preview_request: 'ai_preview_request.schema.json',
  ai_preview_response: 'ai_preview_response.schema.json',
  ai_consent_request: 'ai_consent_request.schema.json',
  ai_consent_response: 'ai_consent_response.schema.json',
  external_processing_policy: 'external_processing_policy.schema.json',
};
const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addFormat('uint8', { type: 'number', validate: (value) => Number.isInteger(value) && value >= 0 && value <= 255 });
ajv.addFormat('uint32', { type: 'number', validate: (value) => Number.isInteger(value) && value >= 0 && value <= 4_294_967_295 });
ajv.addFormat('uint64', { type: 'number', validate: (value) => Number.isSafeInteger(value) && value >= 0 });
ajv.addFormat('double', { type: 'number', validate: Number.isFinite });
ajv.addFormat('date-time', {
  type: 'string',
  validate: (value) => {
    const match = value.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
    if (match === null || (match[1] !== 'Z' && match[1] !== '+00:00') || !Number.isFinite(Date.parse(value))) return false;
    return new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
  },
});
const validators = new Map(Object.entries(schemaFiles).map(([name, filename]) => {
  const schema = JSON.parse(readFileSync(new URL(`../generated/${filename}`, import.meta.url), 'utf8'));
  return [name, ajv.compile(schema)];
}));

export function validateContract(name, value) {
  const validate = validators.get(name);
  if (!validate) throw new RangeError(`unknown generated contract: ${name}`);
  const valid = validate(value);
  return {
    valid,
    errors: valid ? [] : (validate.errors ?? []).map(({ instancePath, keyword, message }) => ({ instancePath, keyword, message })),
  };
}

export function validateAnnotationDocument(value) {
  return validateContract('annotation_document', value);
}
