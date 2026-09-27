import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import { api } from '../../lib/t15/api';

export type ReviewTask = { task_id:string; project_id:string; asset_revision_id:string; ontology_version_id:string; assignee_id:string; state:string; created_at:string; review_id:string|null; revision_ids:string[]|null; review_decision:'approve'|'reject'|null; review_reason:string|null };
export type ReviewIssue = { issue_id:string; review_id:string; annotation_revision_id:string; ontology_version_id:string; object_id:string|null; code:string; message:string; region:unknown; created_at:string };
export type ReviewLeaseResponse = { task_id:string; holder_id:string|null; fencing_token:number; expires_at_unix:number; lease_seconds:number; heartbeat_seconds:number };
export const reviewApi = {
  tasks: (projectId:string) => api.request<{items:ReviewTask[];next_cursor:null|string}>(`/api/projects/${encodeURIComponent(projectId)}/tasks`),
  createTask: (projectId:string, body:{asset_revision_id:string;ontology_version_id:string;assignee_id:string}) => api.request(`/api/projects/${encodeURIComponent(projectId)}/tasks`,{method:'POST',body:JSON.stringify(body)}),
  lease: (taskId:string, action:'acquire'|'renew'|'release'|'transfer', holder_id?:string) => api.request<ReviewLeaseResponse>(`/api/tasks/${encodeURIComponent(taskId)}/lease`,{method:'POST',body:JSON.stringify({action,...(holder_id?{holder_id}:{})})}),
  submit: (taskId:string, annotationRevisionId:string) => api.request<{review_id:string;revision_ids:string[];state:string}>(`/api/tasks/${encodeURIComponent(taskId)}/submit`,{method:'POST',body:JSON.stringify({annotation_revision_ids:[annotationRevisionId]})}),
  decide: (reviewId:string, body:{decision:'approve'|'reject';reason:string;revision_ids:string[]}) => api.request(`/api/reviews/${encodeURIComponent(reviewId)}/decision`,{method:'POST',body:JSON.stringify(body)}),
  revision: (revisionId:string) => api.request<AnnotationRevision>(`/api/annotation-revisions/${encodeURIComponent(revisionId)}`),
  issues: (reviewId:string) => api.request<{items:ReviewIssue[];next_cursor:null|string}>(`/api/reviews/${encodeURIComponent(reviewId)}/issues`),
};
