import type { PageContext } from '../../ui/page-context';
import type { TaskSessionPort } from '../review/task-session-port';
import type { TaskQueue } from '../review/workflow';
import type { ApiMedia, Project, Session } from '../../lib/t15/api';
import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import type { EditorHostOptions } from '../../lib/editor/types';
import type { AnnotationImportContext } from '../import-export/import-context';

export interface ReviewMountContext extends PageContext {
  projectId: string;
  taskSession: TaskSessionPort;
  initialQueue: TaskQueue;
  getQueue(): TaskQueue;
  getScope(): Readonly<{ session: Session | null; project: Project | null; assets: readonly ApiMedia[]; ontologies: readonly OntologyVersion[]; assetId: string; ontologyId: string }>;
  subscribe(listener: () => void): () => void;
  setReviewViewOpen(open: boolean): void;
}
export interface ManagementMountContext extends PageContext {
  projectId: string;
  getProject(): Project | null;
  onProfilesChanged(): void;
}
export interface TransfersMountContext extends PageContext {
  projectId: string;
  getScope(): Readonly<{ asset: ApiMedia | null; ontology: OntologyVersion | null; scopeKey: object; canWrite: boolean; canExport: boolean; canUploadMedia: boolean }>;
  subscribe(listener: () => void): () => void;
  setImportViewOpen(open: boolean): void;
  prepareImport(): Promise<AnnotationImportContext>;
  releaseImport(scopeKey: object): void;
  commitImport(revision: AnnotationRevision, scopeKey: object): Promise<void>;
  prepareExport(): Promise<AnnotationRevision>;
  refreshAssets(): Promise<void>;
}
export interface WorkbenchPageContext extends PageContext {
  projectId: string;
  initialTaskId?: string | null;
  mountReview: (root: HTMLElement, context: ReviewMountContext) => () => void;
  mountManagement: (root: HTMLElement, context: ManagementMountContext) => () => void;
  mountTransfers: (root: HTMLElement, context: TransfersMountContext) => () => void;
  hostOptions?: Partial<EditorHostOptions>;
}
