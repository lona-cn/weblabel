import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import type { EditorDelta } from '../../../../../packages/contracts/generated/EditorDelta';
import type { SessionController } from '../../app/session';
import { api, csrfToken, saveAuthorizationEpoch } from '../../lib/t15/api';
import { decodeCanonicalFrame } from '../../lib/editor/loader';
import type { EditorHost } from '../../lib/editor/EditorHost';
import { IndexedDbDraftStorage, freezeDeep } from '../../lib/persistence/draft-store';
import { FetchSaveTransport, SaveQueue } from '../../lib/persistence/save-queue';
import type { SaveQueueOwner } from '../../lib/persistence/types';
import { classifyDraftBranches, compareWithServer } from '../../lib/persistence/recovery';
import { hasUnconfirmedImportForTarget } from '../import-export/outbox';
import { reviewApi } from '../review/api';
import { wireSaveLease } from '../review/task-session-port';
import { locateOntology } from './fixed-ontology';
import { SelectionStore } from './selection-store';
import { ActivityCollector } from './activity';
import { matchesTask, type EditorPort } from './editor-port';
import { reportError, sessionCurrent, writableRole, type WorkspaceState } from './workspace-state';

// Unresolved in-memory rescue outlives a page; installing a new owner revokes the old writer.
const projectPersistence = new Map<string, { queue: SaveQueue; storage: IndexedDbDraftStorage }>();
export interface WorkspaceInitialScope { projectId: string; assetId: string; ontologyId: string; taskId: string | null }
export function createWorkspaceState(sessionController: SessionController, initial: WorkspaceInitialScope, signal: AbortSignal = new AbortController().signal): WorkspaceState {
  let state: WorkspaceState;
  const listeners = new Set<() => void>();
  const entry = sessionController.getSnapshot(), session = entry.kind === 'authenticated' ? entry.session : null;
  const owner: SaveQueueOwner = { token: {}, actor_id: session?.user_id ?? '', project_id: initial.projectId,
    isCurrent: () => sessionCurrent(state), isWritable: () => writableRole(state),
    canPrepareOperation: (asset, ontology) => matchesTask(state, asset, ontology),
    getLease: asset => state.lease && state.fixedTask && state.lease.asset_revision_id === asset && state.lease.task_id === state.fixedTask.task_id
      && state.lease.ontology_version_id === state.queue.toRecord(asset)?.ontology_version_id && state.leaseActor === state.session?.user_id ? wireSaveLease(state.lease) : null,
  };
  let persistence = projectPersistence.get(initial.projectId);
  if (!persistence) {
    const storage = new IndexedDbDraftStorage();
    // Construction has no pending operations; owner is installed after state exists.
    const queue = new SaveQueue({ transport: new FetchSaveTransport({ csrfToken }), storage,
      owner: { ...owner, isCurrent: () => false, isWritable: () => false } });
    persistence = { queue, storage }; projectPersistence.set(initial.projectId, persistence);
  }
  state = { alive: true, projectId: initial.projectId, sessionController, session, authorizationEpoch: saveAuthorizationEpoch(),
    signal, readonlyRequests: new AbortController(), catalogRead: null, assetRead: null,
    project: null, assets: [], ontologies: [], catalogReady: false, assetId: initial.assetId, ontologyId: initial.ontologyId,
    heads: [], loadToken: {}, scope: {}, phase: 'loading', error: null, loaded: null, host: null, hostStatus: 'idle', document: null, objects: [], flags: {},
    selection: new SelectionStore(), previewSelection: [], tools: null, canUndo: false, canRedo: false, activeLabel: '', paused: false, modal: false,
    ...persistence, owner, assignedAssets: null, fixedTask: initial.taskId ? { task_id: initial.taskId, project_id: initial.projectId, asset_revision_id: initial.assetId, ontology_version_id: initial.ontologyId } : null,
    lease: null, leaseActor: null, preparation: null, submission: false, importing: null,
    branches: [], legacyRows: [], recovery: null, branchBusy: false, activity: new ActivityCollector(initial.projectId, session?.user_id ?? '', undefined, () => window.localStorage), nativeDocuments: new WeakMap(), futureProof: null, continuation: null,
    notify() { if (state.alive) for (const listener of listeners) listener(); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reload: () => loadWorkspaceAsset(state),
    openTask(task, lease, preserve) {
      if (!sessionCurrent(state)) return;
      state.fixedTask = { task_id: task.task_id, project_id: task.project_id, asset_revision_id: task.asset_revision_id, ontology_version_id: task.ontology_version_id };
      state.lease = lease; state.leaseActor = state.session!.user_id;
      state.activity.setBinding({});
      if (!preserve) { state.assetId = task.asset_revision_id; state.ontologyId = task.ontology_version_id; void state.reload().catch(reason => { state.error = reportError(reason); state.notify(); }); }
      state.notify();
    },
  };
  state.queue.setWriteOwner(owner);
  return state;
}

async function catalogBarrier(state: WorkspaceState, scope: object, signal: AbortSignal): Promise<boolean> {
  if (state.preparation && sessionCurrent(state) && state.scope === scope) {
    await new Promise<void>(resolve => {
      const finish = () => { unsubscribe(); signal.removeEventListener('abort', finish); resolve(); };
      const unsubscribe = state.subscribe(() => {
        if (state.preparation && sessionCurrent(state) && state.scope === scope) return;
        finish();
      });
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
  }
  return !signal.aborted && sessionCurrent(state) && state.scope === scope && !state.importing && !state.submission;
}
export async function refreshWorkspaceCatalog(state: WorkspaceState): Promise<void> {
  const scope = state.scope;
  if (!sessionCurrent(state) || state.preparation || state.importing || state.submission) return;
  state.catalogRead?.abort(); const read = new AbortController(); state.catalogRead = read;
  const signal = AbortSignal.any([state.signal, state.readonlyRequests.signal, read.signal]);
  const result = await Promise.all([api.projects(signal), api.ontologies(state.projectId, signal), api.assets(state.projectId, signal)]).catch(reason => { if (signal.aborted) return null; throw reason; });
  if (!result) return;
  const [projects, ontologies, assets] = result;
  if (!await catalogBarrier(state, scope, signal)) return;
  state.project = projects.items.find(item => item.project_id === state.projectId) ?? null;
  state.ontologies = ontologies.items; state.assets = assets; state.catalogReady = true;
  if (!state.assetId) state.assetId = assets[0]?.asset_revision_id ?? '';
  if (!assets.length) state.phase = 'empty';
  state.notify();
  await loadWorkspaceAsset(state);
}
export async function refreshWorkspaceAssets(state: WorkspaceState): Promise<void> {
  if (!state.catalogReady) return refreshWorkspaceCatalog(state);
  if (!sessionCurrent(state) || state.importing || state.submission) return;
  const scope = state.scope; state.catalogRead?.abort();
  const read = new AbortController(); state.catalogRead = read;
  const signal = AbortSignal.any([state.signal, state.readonlyRequests.signal, read.signal]);
  const assets = await api.assets(state.projectId, signal).catch(reason => { if (signal.aborted) return null; throw reason; });
  if (!assets || !await catalogBarrier(state, scope, signal)) return;
  state.assets = assets;
  if (!state.assetId && assets.length) { state.assetId = assets[0].asset_revision_id; await loadWorkspaceAsset(state); }
  else if (state.assetId && !assets.some(asset => asset.asset_revision_id === state.assetId)) await loadWorkspaceAsset(state);
  else { if (!state.loaded && !assets.length) state.phase = 'empty'; state.notify(); }
}
export async function readWorkspaceRescue(state: WorkspaceState, reason: unknown): Promise<void> {
  const scope = state.scope;
  state.error = reportError(reason); state.phase = 'error';
  if (!state.assetId || !sessionCurrent(state)) { state.notify(); return; }
  try {
    const rows = await state.queue.readDraftBranches(state.assetId);
    if (!sessionCurrent(state) || state.scope !== scope) return;
    state.branches = rows;
    const memory = state.queue.toRecord(state.assetId);
    if (memory) state.recovery = { kind: 'unreachable', record: memory, error: { kind: 'load', code: 'CATALOG_UNREACHABLE', message: state.error ?? '', request_id: null } };
  } catch (storageError) {
    if (!sessionCurrent(state) || state.scope !== scope) return;
    state.error += ' · 本地草稿读取失败：' + reportError(storageError);
    if (storageError instanceof Error && 'code' in storageError && (storageError.code === 'STORAGE_UPGRADE_FAILED' || storageError.code === 'STORAGE_BLOCKED')) {
      try { const rows = await state.storage.readLegacyForRescue(); if (sessionCurrent(state) && state.scope === scope) state.legacyRows = rows; }
      catch (legacyError) { if (sessionCurrent(state) && state.scope === scope) state.error += ' · 旧库只读救援失败：' + reportError(legacyError); }
    }
  }
  state.notify();
}
export async function loadWorkspaceAsset(state: WorkspaceState): Promise<void> {
  if (!sessionCurrent(state) || !state.catalogReady) return;
  state.assetRead?.abort(); const read = new AbortController(); state.assetRead = read;
  const signal = AbortSignal.any([state.signal, state.readonlyRequests.signal, read.signal]);
  const token = {}; state.loadToken = token; state.scope = {}; state.host?.cancelGesture(); state.host = null;
  state.loaded = null; state.document = null; state.objects = []; state.flags = {}; state.previewSelection = []; state.canUndo = false; state.canRedo = false;
  state.phase = state.assetId ? 'loading' : 'empty'; state.error = null; state.recovery = null; state.heads = []; state.assignedAssets = null;
  state.selection = new SelectionStore(); state.activity.setBinding({}); state.notify();
  const current = () => !signal.aborted && sessionCurrent(state) && state.loadToken === token;
  const asset = state.assetId;
  if (!asset) return;
  try {
    const media = state.assets.find(item => item.asset_revision_id === asset && item.project_id === state.projectId);
    const branches = await state.queue.readDraftBranches(asset);
    if (!current()) return;
    state.branches = branches;
    if (!media) throw new Error('指定媒体不在可读取列表中；没有切换其他媒体。本地草稿仅可救援。');
    let taskMessage: string | null = null;
    if (!state.fixedTask) {
      try {
        const assigned = new Set<string>(), cursors = new Set<string>(); let cursor: string | null = null;
        do {
          if (cursor !== null) { if (cursors.has(cursor)) throw new Error('任务分页游标循环。'); cursors.add(cursor); }
          const page = await reviewApi.tasks(state.projectId, cursor, signal);
          if (!current()) return;
          for (const task of page.items) { if (task.project_id !== state.projectId) throw new Error('任务项目范围不匹配。'); assigned.add(task.asset_revision_id); }
          cursor = page.next_cursor;
        } while (cursor !== null);
        state.assignedAssets = assigned;
        if (assigned.has(asset)) taskMessage = '图片已关联任务，普通入口只读。请在任务区显式领取匹配 lease；不会自动领取或重放。';
      } catch (reason) { taskMessage = '任务编辑资格尚未确认，保持只读：' + reportError(reason); }
    }
    const memory = state.queue.getDraftBranchSnapshot(asset), draft = state.queue.toRecord(asset);
    const location = locateOntology(asset, state.fixedTask?.ontology_version_id ?? null, state.ontologyId || null, draft);
    const heads: string[] = []; let cursor: string | null = null;
    do { const page = await api.annotationHeads(asset, cursor, signal); if (!current()) return; heads.push(...page.items.map(item => item.ontology_version_id)); cursor = page.next_cursor; } while (cursor !== null);
    state.heads = heads;
    if (!location.ontologyId) { state.phase = 'ready'; state.error = heads.length ? '请选择已有标注 head 的固定规范；不会默认使用最新版本。' : '没有标注 head；不会自动迁移或创建标注。'; state.notify(); return; }
    const ontology = state.ontologies.find(item => item.ontology_version_id === location.ontologyId);
    if (!ontology || ontology.project_id !== state.projectId) throw new Error('固定规范不可读取；不会回退其他版本。');
    if (!heads.includes(ontology.ontology_version_id)) {
      if (state.fixedTask) throw new Error('固定任务的标注 head 缺失；不会回退其他规范或创建替代版本。');
      state.ontologyId = ontology.ontology_version_id; state.phase = 'ready';
      state.error = '此图片与所选固定规范尚无标注版本。满足权限且没有未解决草稿时，可显式导入已有标注；不会自动创建空 revision，也不会替换其他固定版本。';
      state.notify(); return;
    }
    const revision = await api.annotation(asset, ontology.ontology_version_id, signal);
    if (!current()) return;
    if (revision.document.asset_revision_id !== asset || revision.document.ontology_version_id !== ontology.ontology_version_id) throw new Error('标注文档与固定范围不匹配。');
    freezeDeep(revision);
    const report = draft ? location.conflict ? { kind: 'conflict' as const, record: draft, server_head: revision, options: ['keep_local_export', 'view_server'] as const } : compareWithServer(draft, revision) : { kind: 'no_local_record' as const };
    state.recovery = report;
    const prior = state.queue.getStatus(asset), outstanding = draft && (draft.generation > draft.synced_generation || draft.intent_journal.length > draft.synced_intent_seq || draft.pending);
    const foreign = outstanding && (draft?.draft_owner?.actor_id !== state.session?.user_id || draft.draft_owner?.project_id !== state.projectId
      || draft.pending && (draft.pending_owner?.actor_id !== state.session?.user_id || draft.pending_owner?.project_id !== state.projectId));
    const awaiting = !memory && [...classifyDraftBranches(branches, null).values()].some(item => item === 'unresolved' || item === 'rescue_only');
    const conflict = location.conflict || report.kind === 'conflict' || prior.writes_paused && (prior.dirty || prior.last_error || draft?.pending);
    const unknownImport = hasUnconfirmedImportForTarget(state.projectId, asset, ontology.ontology_version_id);
    const blocked = !!(conflict || foreign || awaiting || !writableRole(state) || unknownImport || !matchesTask(state, asset, ontology.ontology_version_id));
    if (!awaiting) { state.queue.initializeFromServerRevision({ asset_revision_id: asset, ontology_version_id: ontology.ontology_version_id, annotation_revision_id: revision.annotation_revision_id, generation: draft?.generation ?? 0, document: revision.document }); await state.queue.whenPersisted(asset); }
    if (!current()) return;
    // Explicitly recovered owned future remains a Native CPU document even while a task claim is required.
    const local = draft && !foreign && !location.conflict && report.kind !== 'conflict' && draft.base_revision_id === revision.annotation_revision_id ? draft : null;
    const record = !blocked || local && state.queue.getStatus(asset).local_commit ? state.queue.toRecord(asset) : null;
    const document = record?.document ?? revision.document;
    const image = await api.image(asset, signal), frame = await decodeCanonicalFrame(image, { width: media.canonical_width, height: media.canonical_height });
    if (!current()) return;
    state.loaded = { media, ontology, document, frame, initial_generation: record?.generation ?? 0, revision,
      readOnlyPreview: (blocked && !local) || !ontology.labels.length || !writableRole(state) };
    state.document = document; state.objects = document.objects; state.ontologyId = ontology.ontology_version_id;
    if (!ontology.labels.some(item => item.label_id === state.activeLabel)) state.activeLabel = ontology.labels[0]?.label_id ?? '';
    state.phase = 'ready'; state.queue.switchAsset(asset);
    state.error = awaiting ? '请选择本地草稿分支；不会自动选择最新分支。' : foreign ? '原草稿作者不属于当前身份，仅可救援；不会接管。' : conflict ? '固定规范、base 或原请求待核对；保留 pending/journal 和暂停队列。'
      : unknownImport ? '存在未确认导入，原操作已保留；只能查看和救援。' : !matchesTask(state, asset, ontology.ontology_version_id) ? taskMessage ?? '当前固定任务没有已确认匹配 lease；请显式领取。' : !writableRole(state) ? '当前角色只读。' : !ontology.labels.length ? '历史空规范只读；不会迁移本图。' : null;
    state.notify();
  } catch (reason) {
    if (!current()) return;
    const record = state.queue.toRecord(asset);
    if (record) state.recovery = { kind: 'unreachable', record, error: { kind: 'load', code: 'WORKSPACE_LOAD_FAILED', message: reportError(reason), request_id: null } };
    state.error = reportError(reason); state.phase = 'error';
    if (reason instanceof Error && 'code' in reason && (reason.code === 'STORAGE_UPGRADE_FAILED' || reason.code === 'STORAGE_BLOCKED')) {
      try { const rows = await state.storage.readLegacyForRescue(); if (current()) state.legacyRows = rows; }
      catch (storageError) { if (current()) state.error += ' · 旧库只读救援：' + reportError(storageError); }
    }
    state.notify();
  }
}

/** The ONLY full committed Native snapshot consumer and save/IDB producer. */
export function applyDelta(state: WorkspaceState, port: EditorPort, host: EditorHost, delta: EditorDelta): void {
  const loaded = state.loaded;
  if (!loaded || port.getReadHost() !== host || (delta.document_changed || delta.suggestion_decisions.length > 0) && port.getHost() !== host) return;
  if (delta.error) { state.error = delta.error.code + ': ' + delta.error.message; state.notify(); return; }
  state.selection.publish(delta); state.previewSelection = state.selection.getSelection();
  state.canUndo = delta.can_undo; state.canRedo = delta.can_redo; state.flags = host.getLocalFlags();
  const snapshot = host.getCommittedSnapshot(delta);
  if (snapshot) {
    state.nativeDocuments.set(host, snapshot); const previousCount = state.objects.length;
    state.document = snapshot; state.objects = snapshot.objects;
    if (delta.document_changed || delta.suggestion_decisions.length) {
      state.queue.enqueue({ asset_revision_id: loaded.media.asset_revision_id, ontology_version_id: loaded.ontology.ontology_version_id,
        base_revision_id: state.queue.getStatus(state.assetId).base_revision_id ?? loaded.revision.annotation_revision_id,
        generation: delta.generation, document: snapshot, suggestion_decisions: delta.suggestion_decisions });
      state.activity.interact(snapshot.objects.length > previousCount ? 'annotation' : 'correction');
    }
  }
  state.notify();
}
export async function installServerPreview(state: WorkspaceState, revision: AnnotationRevision): Promise<void> {
  const loaded = state.loaded;
  if (!sessionCurrent(state) || !loaded || revision.document.asset_revision_id !== state.assetId || revision.document.ontology_version_id !== loaded.ontology.ontology_version_id) throw new Error('服务器版本与固定范围不匹配。');
  freezeDeep(revision);
  state.host?.cancelGesture(); state.host = null; state.scope = {};
  state.loaded = { ...loaded, revision, document: revision.document, initial_generation: 0, readOnlyPreview: true };
  state.document = revision.document; state.objects = revision.document.objects; state.previewSelection = []; state.flags = {}; state.notify();
}
