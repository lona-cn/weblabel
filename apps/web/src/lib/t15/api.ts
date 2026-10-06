import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import type { MediaRevision } from '../../../../../packages/contracts/generated/MediaRevision';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import type { ExternalProcessingPolicy } from '../../../../../packages/contracts/generated/ExternalProcessingPolicy';

export type Session = { user_id: string; username: string; platform_admin: boolean; project_roles: { project_id: string; role: string }[] };
export type Project = { project_id: string; name: string; description: string; allow_self_review: boolean; role?: string };
export type ApiMedia = MediaRevision;
export type ApiErrorBody = { code?: string; message?: string };

export class ApiFailure extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ApiFailure';
  }
}

let csrf = '';
export function setCsrfToken(value: string | null): void { csrf = value ?? ''; }
export function csrfToken(): string | null { return csrf || null; }

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
    try { detail = await response.json() as ApiErrorBody; } catch { /* response body may be empty */ }
    throw new ApiFailure(response.status, detail.code ?? `HTTP_${response.status}`, detail.message ?? `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

export const api = {
  request,
  session: () => request<Session>('/api/session'),
  login: async (username: string, password: string) => {
    const result = await request<{ csrf_token: string }>('/api/session/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    setCsrfToken(result.csrf_token);
    globalThis.sessionStorage?.setItem('weblabel_csrf', result.csrf_token);
    return api.session();
  },
  logout: () => request<void>('/api/session/logout', { method: 'POST' }),
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
  exportRevision: (revisionId: string, format: 'coco' | 'yolo' | 'native') => request<{ export_id: string; format: string; download_url: string; byte_size: number; object_sha256: string; loss_report: unknown }>(`/api/annotation-revisions/${encodeURIComponent(revisionId)}/exports`, { method: 'POST', body: JSON.stringify({ format, loss_ack: true, operation_id: crypto.randomUUID() }) }),
  download: async (url: string) => {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) throw new ApiFailure(response.status, `HTTP_${response.status}`, `Export download failed (${response.status})`);
    return { bytes: await response.blob(), loss: response.headers.get('x-weblabel-loss-report') };
  },
};

