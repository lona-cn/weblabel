import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import type { MediaRevision } from '../../../../../packages/contracts/generated/MediaRevision';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import type { ExternalProcessingPolicy } from '../../../../../packages/contracts/generated/ExternalProcessingPolicy';
import type { BootstrapStatus } from '../../../../../packages/contracts/generated/BootstrapStatus';
import type { AdminRecoveryStatus } from '../../../../../packages/contracts/generated/AdminRecoveryStatus';
import type { AdminRecoveryRequest } from '../../../../../packages/contracts/generated/AdminRecoveryRequest';
export type { AdminRecoveryStatus };
import type { AnnotationHeadPage } from '../../../../../packages/contracts/generated/AnnotationHeadPage';
import type { AssetAnnotationHeadPage } from '../../../../../packages/contracts/generated/AssetAnnotationHeadPage';
import type { ProjectMemberPage } from '../../../../../packages/contracts/generated/ProjectMemberPage';
import { validateContract } from '@weblabel/contracts/validate-browser';
import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { AnnotationImportCommitRequest } from '../../../../../packages/contracts/generated/AnnotationImportCommitRequest';
export type { AnnotationImportCommitRequest };
export type AnnotationImportPreview = { import_batch_id: string; document: AnnotationDocument; loss_report: unknown; base_revision_id: string | null; base_revision_no: number };
export type AnnotationImportReceipt = { import_batch_id: string; revision: AnnotationRevision; idempotent_replay: boolean };
export type RevisionExportIntent = { format: 'coco' | 'yolo' | 'native'; loss_ack: boolean; operation_id: string };
export type RevisionExportArtifact = { export_id: string; format: string; download_url: string; byte_size: number; object_sha256: string; loss_report: unknown };
export type BootstrapResult = { user_id: string; username: string; csrf_token: string };

export type Session = { user_id: string; username: string; platform_admin: boolean; project_roles: { project_id: string; role: string }[] };
export type Project = { project_id: string; name: string; description: string; allow_self_review: boolean; role?: string };
export type ApiMedia = MediaRevision;
export type ApiErrorBody = { code?: string; message?: string; request_id?: string; details?: Record<string, unknown> | null };

export class ApiFailure extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details: Record<string, unknown> | null = null, readonly request_id: string | null = null) {
    super(message);
    this.name = 'ApiFailure';
  }
}

let csrf = '';
let authorizationEpoch = 0;
const authorizationListeners = new Set<() => void>();
function invalidateSaveAuthorization(): void {
  authorizationEpoch += 1;
  for (const notify of authorizationListeners) notify();
}
export function subscribeSaveAuthorization(notify: () => void): () => void {
  authorizationListeners.add(notify);
  return () => { authorizationListeners.delete(notify); };
}
export function setCsrfToken(value: string | null): void {
  const next = value ?? '';
  if (next !== csrf) { invalidateSaveAuthorization(); csrf = next; }
}
export function csrfToken(): string | null { return csrf || null; }
export function saveAuthorizationEpoch(): number { return authorizationEpoch; }

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body !== undefined && !(init.body instanceof FormData)) headers.set('content-type', 'application/json');
  if (init.method && !['GET', 'HEAD', 'OPTIONS'].includes(init.method.toUpperCase())) {
    if (csrf) headers.set('x-csrf-token', csrf);
  }
  const response = await fetch(url, { ...init, headers, credentials: 'same-origin' });
  if (!response.ok) {
    let detail: ApiErrorBody = {};
    try {
      const value: unknown = await response.json();
      if (value && typeof value === 'object') {
        if ('code' in value && typeof value.code === 'string') detail.code = value.code;
        if ('message' in value && typeof value.message === 'string') detail.message = value.message;
        if ('request_id' in value && typeof value.request_id === 'string') detail.request_id = value.request_id;
        if ('details' in value && value.details && typeof value.details === 'object' && !Array.isArray(value.details)) detail.details = value.details as Record<string, unknown>;
      }
    } catch { /* response body may be empty */ }
    throw new ApiFailure(response.status, detail.code ?? `HTTP_${response.status}`, detail.message ?? `Request failed (${response.status})`, detail.details ?? null, detail.request_id ?? null);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}
// Provider-only scope fence: stale acknowledgements must not install browser tokens.
export function loginInScope(username: string, password: string): Promise<Session>;
export function loginInScope(username: string, password: string, isCurrent: () => boolean): Promise<Session | null>;
export async function loginInScope(username: string, password: string, isCurrent: () => boolean = () => true): Promise<Session | null> {
  invalidateSaveAuthorization();
  const result = await request<{ csrf_token: string }>('/api/session/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  if (!isCurrent()) return null;
  if (typeof result.csrf_token !== 'string' || !result.csrf_token.trim()) throw new Error('登录响应未提供 CSRF token');
  setCsrfToken(result.csrf_token);
  globalThis.sessionStorage.setItem('weblabel_csrf', result.csrf_token);
  return api.session();
}

function parseRecoveryStatus(value: unknown): AdminRecoveryStatus {
  if (!validateContract('admin_recovery_status', value).valid) throw new Error('恢复状态响应无效');
  const status = value as AdminRecoveryStatus;
  if (status.state === 'disabled' ? status.request_id !== null || status.username !== null :
    !status.request_id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(status.request_id) || !status.username?.trim()) throw new Error('恢复状态字段不一致');
  return status;
}
export const api = {
  adminRecoveryStatus: async (): Promise<AdminRecoveryStatus> => parseRecoveryStatus(await request<unknown>('/api/session/password-recovery')),
  adminRecover: async (body: AdminRecoveryRequest): Promise<AdminRecoveryStatus> => {
    const response = await fetch('/api/session/password-recovery', { method: 'POST', credentials: 'omit', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) {
      const error: unknown = await response.json();
      if (!error || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'string' || !('message' in error) || typeof error.message !== 'string') throw new Error('恢复错误响应无效');
      throw new ApiFailure(response.status, error.code, '恢复请求被拒绝');
    }
    const result = parseRecoveryStatus(await response.json());
    if (result.state !== 'completed') throw new Error('恢复响应未确认完成');
    return result;
  },
  request,
  annotationHeads: async (assetId: string, cursor: string | null = null): Promise<AnnotationHeadPage> => {
    const result = await request<unknown>(`/api/assets/${encodeURIComponent(assetId)}/annotation-heads?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (!validateContract('annotation_head_page', result).valid) throw new ApiFailure(502, 'INVALID_ANNOTATION_HEAD_PAGE', '标注版本摘要响应无效');
    return result as AnnotationHeadPage;
  },
  projectAnnotationHeads: async (projectId: string, ontologyId: string, cursor: string | null = null): Promise<AssetAnnotationHeadPage> => {
    const result = await request<unknown>(`/api/projects/${encodeURIComponent(projectId)}/annotation-heads?ontology_version_id=${encodeURIComponent(ontologyId)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (!validateContract('asset_annotation_head_page', result).valid) throw new ApiFailure(502, 'INVALID_ASSET_ANNOTATION_HEAD_PAGE', '媒体标注摘要响应无效');
    return result as AssetAnnotationHeadPage;
  },
  members: async (projectId: string, cursor: string | null = null): Promise<ProjectMemberPage> => {
    const result = await request<unknown>(`/api/projects/${encodeURIComponent(projectId)}/members?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (!validateContract('project_member_page', result).valid) throw new ApiFailure(502, 'INVALID_PROJECT_MEMBER_PAGE', '项目成员响应无效');
    return result as ProjectMemberPage;
  },
  session: () => request<Session>('/api/session'),
  bootstrapStatus: async (): Promise<BootstrapStatus> => {
    const result = await request<BootstrapStatus>('/api/session/bootstrap');
    if (!validateContract('bootstrap_status', result).valid) throw new ApiFailure(502, 'INVALID_BOOTSTRAP_STATUS', '初始化状态响应无效');
    return result;
  },
  bootstrap: (launchCode: string, password: string) => request<BootstrapResult>('/api/session/bootstrap', { method: 'POST', body: JSON.stringify({ launch_code: launchCode, password }) }),
  login: (username: string, password: string) => loginInScope(username, password),
  logout: () => { invalidateSaveAuthorization(); return request<void>('/api/session/logout', { method: 'POST' }); },
  projects: () => request<{ items: Project[]; next_cursor: string | null }>('/api/projects'),
  createProject: (body: { name: string; description: string; allow_self_review: boolean }) => request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),
  externalProcessingPolicy: (projectId: string) => request<ExternalProcessingPolicy>(`/api/projects/${encodeURIComponent(projectId)}/external-processing-policy`),
  setExternalProcessingPolicy: (projectId: string, allow: boolean) => request<ExternalProcessingPolicy>(`/api/projects/${encodeURIComponent(projectId)}/external-processing-policy`, { method: 'PUT', body: JSON.stringify({ allow_external_processing: allow } satisfies ExternalProcessingPolicy) }),
  ontologies: (projectId: string) => request<{ items: OntologyVersion[]; next_cursor: string | null }>(`/api/projects/${encodeURIComponent(projectId)}/ontologies`),
  publishOntology: (projectId: string, body: Pick<OntologyVersion, 'labels' | 'guidelines_markdown'>) => request<OntologyVersion>(`/api/projects/${encodeURIComponent(projectId)}/ontologies`, { method: 'POST', body: JSON.stringify(body) }),
  assets: async (projectId: string) => {
    const items: ApiMedia[] = [];
    let cursor: string | null = null;
    do {
      const assetPage: { items: ApiMedia[]; next_cursor: string | null } = await request(
        `/api/projects/${encodeURIComponent(projectId)}/assets?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      items.push(...assetPage.items);
      cursor = assetPage.next_cursor;
    } while (cursor !== null);
    return items;
  },
  importAssets: (projectId: string, files: File[]) => {
    const body = new FormData();
    for (const file of files) body.append('images', file, file.name);
    return request<{ import_job_id: string; duplicate: boolean }>(`/api/projects/${encodeURIComponent(projectId)}/assets`, { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body });
  },
  job: (jobId: string) => request<{ job_id: string; kind: string; state: string; progress_completed: number; progress_total: number; result: unknown }>(`/api/jobs/${encodeURIComponent(jobId)}`),
  annotation: (assetId: string, ontologyId: string) => request<AnnotationRevision>(`/api/assets/${encodeURIComponent(assetId)}/annotation?ontology_version_id=${encodeURIComponent(ontologyId)}`),
  image: (assetId: string) => fetch(`/api/assets/${encodeURIComponent(assetId)}/image`, { credentials: 'same-origin' }).then(async (response) => {
    if (!response.ok) throw new ApiFailure(response.status, `HTTP_${response.status}`, `Image request failed (${response.status})`);
    return response.blob();
  }),
  previewAnnotationImport: (assetRevisionId: string, body: FormData) => request<AnnotationImportPreview>(`/api/assets/${encodeURIComponent(assetRevisionId)}/annotation-import-previews`, { method: 'POST', body }),
  commitAnnotationImport: (batchId: string, body: AnnotationImportCommitRequest) => request<AnnotationImportReceipt>(`/api/annotation-import-previews/${encodeURIComponent(batchId)}/commit`, { method: 'POST', body: JSON.stringify(body) }),
  createRevisionExport: (revisionId: string, body: RevisionExportIntent) => request<RevisionExportArtifact>(`/api/annotation-revisions/${encodeURIComponent(revisionId)}/exports`, { method: 'POST', body: JSON.stringify(body) }),
  download: async (url: string) => {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) throw new ApiFailure(response.status, `HTTP_${response.status}`, `Export download failed (${response.status})`);
    return { bytes: await response.blob(), loss: response.headers.get('x-weblabel-loss-report') };
  },
};

