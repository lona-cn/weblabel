import Ajv from 'ajv';
import runEvent from '../generated/run_event.schema.json';
import suggestionSet from '../generated/suggestion_set.schema.json';
import bootstrapStatus from '../generated/bootstrap_status.schema.json';
import adminRecoveryStatus from '../generated/admin_recovery_status.schema.json';
import adminRecoveryRequest from '../generated/admin_recovery_request.schema.json';
import annotationHeadSummary from '../generated/annotation_head_summary.schema.json';
import annotationHeadPage from '../generated/annotation_head_page.schema.json';
import assetAnnotationHead from '../generated/asset_annotation_head.schema.json';
import assetAnnotationHeadPage from '../generated/asset_annotation_head_page.schema.json';
import projectMemberRole from '../generated/project_member_role.schema.json';
import projectMember from '../generated/project_member.schema.json';
import projectMemberPage from '../generated/project_member_page.schema.json';
import annotationImportCommitRequest from '../generated/annotation_import_commit_request.schema.json';
import annotationRevision from '../generated/annotation_revision.schema.json';
import saveResponse from '../generated/save_response.schema.json';
import annotationDocument from '../generated/annotation_document.schema.json';
import saveRequest from '../generated/save_request.schema.json';

const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addFormat('uint8', { type: 'number', validate: (value) => Number.isInteger(value) && value >= 0 && value <= 255 });
ajv.addFormat('uint32', { type: 'number', validate: (value) => Number.isInteger(value) && value >= 0 && value <= 4_294_967_295 });
ajv.addFormat('uint64', { type: 'number', validate: (value) => Number.isSafeInteger(value) && value >= 0 });
ajv.addFormat('double', { type: 'number', validate: Number.isFinite });
const validators = new Map([
  ['bootstrap_status', ajv.compile(bootstrapStatus)],
  ['admin_recovery_status', ajv.compile(adminRecoveryStatus)],
  ['admin_recovery_request', ajv.compile(adminRecoveryRequest)],
  ['run_event', ajv.compile(runEvent)],
  ['suggestion_set', ajv.compile(suggestionSet)],
  ['annotation_head_summary', ajv.compile(annotationHeadSummary)],
  ['annotation_head_page', ajv.compile(annotationHeadPage)],
  ['asset_annotation_head', ajv.compile(assetAnnotationHead)],
  ['asset_annotation_head_page', ajv.compile(assetAnnotationHeadPage)],
  ['project_member_role', ajv.compile(projectMemberRole)],
  ['project_member', ajv.compile(projectMember)],
  ['project_member_page', ajv.compile(projectMemberPage)],
  ['annotation_import_commit_request', ajv.compile(annotationImportCommitRequest)],
  ['annotation_revision', ajv.compile(annotationRevision)],
  ['save_response', ajv.compile(saveResponse)],
  ['annotation_document', ajv.compile(annotationDocument)],
  ['save_request', ajv.compile(saveRequest)],
]);

export function validateContract(name, value) {
  const validate = validators.get(name);
  if (!validate) throw new RangeError(`unknown generated contract: ${name}`);
  const valid = validate(value);
  return {
    valid,
    errors: valid ? [] : (validate.errors ?? []).map(({ instancePath, keyword, message }) => ({ instancePath, keyword, message })),
  };
}
