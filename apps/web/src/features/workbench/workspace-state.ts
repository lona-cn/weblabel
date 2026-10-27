import type { AnnotationDocument, EditorDelta, EditorHostStatus, EditorAssetRequest, LocalObjectFlagMap } from '../../lib/editor/types';
import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import type { AnnotationObject } from '../../../../../packages/contracts/generated/AnnotationObject';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import type { SessionController } from '../../app/session';
import type { ApiMedia, Project, Session } from '../../lib/t15/api';
import { ApiFailure, saveAuthorizationEpoch } from '../../lib/t15/api';
import type { SaveQueue } from '../../lib/persistence/save-queue';
import type { IndexedDbDraftStorage } from '../../lib/persistence/draft-store';
import type { DraftBranchEnvelope, SaveQueueOwner } from '../../lib/persistence/types';
import type { RecoveryReport } from '../../lib/persistence/recovery';
import type { LocalTaskLease, TaskContinuationProof } from '../review/task-session-port';
import type { ReviewTask } from '../review/api';
import type { AnnotationImportContext } from '../import-export/import-context';
import { SelectionStore } from './selection-store';
import type { EditorHost } from '../../lib/editor/EditorHost';
import type { ToolState } from './tool-state';
import { ActivityCollector } from './activity';

export type FixedTask = Pick<ReviewTask, 'task_id' | 'project_id' | 'asset_revision_id' | 'ontology_version_id'>;
export type LoadedAsset = EditorAssetRequest & { revision: AnnotationRevision; readOnlyPreview: boolean };
export interface WorkspaceState {
  alive: boolean; projectId: string; sessionController: SessionController; session: Session | null; authorizationEpoch: number;
  signal: AbortSignal; readonlyRequests: AbortController; catalogRead: AbortController | null; assetRead: AbortController | null;
  project: Project | null; assets: readonly ApiMedia[]; ontologies: readonly OntologyVersion[]; catalogReady: boolean;
  assetId: string; ontologyId: string; heads: readonly string[]; loadToken: object; scope: object;
  phase: 'loading' | 'ready' | 'empty' | 'error'; error: string | null;
  loaded: LoadedAsset | null; host: EditorHost | null; hostStatus: EditorHostStatus;
  document: AnnotationDocument | null; objects: readonly AnnotationObject[]; flags: LocalObjectFlagMap;
  selection: SelectionStore; previewSelection: readonly string[]; tools: ToolState | null;
  canUndo: boolean; canRedo: boolean; activeLabel: string; paused: boolean; modal: boolean; importViewModal: boolean;
  queue: SaveQueue; storage: IndexedDbDraftStorage; owner: SaveQueueOwner;
  assignedAssets: ReadonlySet<string> | null; fixedTask: FixedTask | null; lease: LocalTaskLease | null; leaseActor: string | null;
  preparation: symbol | null; submission: boolean; importing: { scope: object; context: AnnotationImportContext | null; receipt: AnnotationRevision | null } | null;
  branches: readonly DraftBranchEnvelope[]; legacyRows: readonly { key: IDBValidKey; record: unknown }[]; recovery: RecoveryReport | null;
  branchBusy: boolean; activity: ActivityCollector; nativeDocuments: WeakMap<EditorHost, AnnotationDocument>;
  notify(): void; subscribe(listener: () => void): () => void;
  reload(): Promise<void>; openTask(task: ReviewTask, lease: LocalTaskLease, preserve: boolean): void;
  futureProof: null | { scope: object; host: EditorHost; taskId: string; record: string; certificate: string };
  continuation: TaskContinuationProof | null;
}
export function reportError(reason: unknown): string {
  if (reason instanceof ApiFailure) return [reason.code, reason.message, reason.request_id].filter(Boolean).join(' · ');
  if (reason instanceof Error) return reason.message;
  if (reason && typeof reason === 'object' && 'code' in reason && typeof reason.code === 'string' && 'message' in reason && typeof reason.message === 'string') {
    const requestId = 'request_id' in reason && typeof reason.request_id === 'string' ? reason.request_id : '';
    return [reason.code, reason.message, requestId].filter(Boolean).join(' · ');
  }
  return String(reason);
}
export function sessionCurrent(state: WorkspaceState): boolean {
  const entry = state.sessionController.getSnapshot();
  return state.alive && entry.kind === 'authenticated' && entry.session === state.session && state.authorizationEpoch === saveAuthorizationEpoch();
}
export function writableRole(state: WorkspaceState): boolean {
  const role = state.session?.project_roles.find(item => item.project_id === state.projectId)?.role;
  return sessionCurrent(state) && state.project?.project_id === state.projectId && state.project.role === role && ['admin', 'annotator'].includes(role ?? '');
}
export function recordKey(record: unknown): string {
  return JSON.stringify(record && typeof record === 'object' ? { ...record, updated_at: '' } : record);
}
export function sameDocument(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameDocument((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}
export function selectedIds(state: WorkspaceState): readonly string[] {
  return !state.loaded || state.loaded.readOnlyPreview || !writableRole(state) || state.host?.status !== 'ready' ? state.previewSelection : state.selection.getSelection();
}
export type DeltaConsumer = (host: EditorHost, delta: EditorDelta) => void;
