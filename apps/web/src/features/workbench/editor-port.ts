import type { AnnotationDocument, EditorCommand, EditorDelta, EditorTool } from '../../lib/editor/types';
import type { EditorHost } from '../../lib/editor/EditorHost';
import type { Scalar } from '../../../../../packages/contracts/generated/Scalar';
import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import { hasUnconfirmedImportForTarget } from '../import-export/outbox';
import { wireSaveLease } from '../review/task-session-port';
import { api } from '../../lib/t15/api';
import { sameDocument, selectedIds, sessionCurrent, writableRole, type WorkspaceState } from './workspace-state';
import type { AnnotationImportContext } from '../import-export/import-context';

export interface EditorPort {
  getReadHost(): EditorHost | null;
  getHost(): EditorHost | null;
  getSnapshot(): AnnotationDocument | null;
  dispatch(command: EditorCommand): EditorDelta | null;
  canSave(): boolean; canReconcile(): boolean; canExport(): boolean; selectionWritable(): boolean; canImport(): boolean;
  scopeGuard(): () => boolean;
  cancelGesture(): void; setTool(tool: EditorTool): boolean;
  select(id: string, additive?: boolean): void;
  selectAsset(assetId: string): Promise<void>; selectOntology(ontologyId: string): Promise<void>;
  flags(ids: readonly string[], flags: { hidden?: boolean; locked?: boolean }): void;
  attribute(key: string, value: Scalar): EditorDelta | null; relabel(label: string): void; drawingLabel(label: string): void;
  prepareImport(): Promise<AnnotationImportContext>; releaseImport(): void;
  commitImport(revision: AnnotationRevision): Promise<void>; prepareExport(): Promise<AnnotationRevision>;
}
export function matchesTask(state: WorkspaceState, asset: string, ontology: string): boolean {
  const fixed = state.fixedTask, lease = state.lease;
  if (!fixed) return state.assignedAssets !== null && !state.assignedAssets.has(asset);
  return !!lease && fixed.project_id === state.projectId && fixed.asset_revision_id === asset && fixed.ontology_version_id === ontology
    && lease.task_id === fixed.task_id && lease.asset_revision_id === asset && lease.ontology_version_id === ontology && state.leaseActor === state.session?.user_id;
}
export function createEditorPort(state: WorkspaceState): EditorPort {
  const read = () => sessionCurrent(state) && state.loaded && state.host && state.loaded.media.asset_revision_id === state.assetId
    && state.loaded.media.project_id === state.projectId ? state.host : null;
  const reconcile = () => !!read() && writableRole(state) && read()?.status === 'ready' && !state.preparation && !state.importing && !state.submission
    && !!state.loaded?.ontology.labels.length && !hasUnconfirmedImportForTarget(state.projectId, state.assetId, state.loaded.ontology.ontology_version_id);
  const getHost = () => {
    const host = read(), loaded = state.loaded;
    return host && loaded && reconcile() && !loaded.readOnlyPreview && !state.paused && !state.branchBusy
      && matchesTask(state, state.assetId, loaded.ontology.ontology_version_id)
      && state.queue.canAcceptEdits(state.assetId, loaded.ontology.ontology_version_id) ? host : null;
  };
  const canExport = () => {
    const host = read();
    return !!host && (host.status === 'ready' || host.status === 'error') && !state.preparation && !state.importing && !state.submission;
  };
  const selectionWritable = () => {
    const ids = selectedIds(state), known = new Set(state.objects.map(object => object.object_id));
    return !!getHost() && ids.length > 0 && ids.every(id => known.has(id) && !state.flags[id]?.locked);
  };
  const dispatch = (command: EditorCommand) => {
    const host = getHost();
    if (!host) return null;
    if (['set_attributes', 'set_label', 'replace_geometry', 'delete', 'duplicate'].includes(command.kind) && !selectionWritable()) return null;
    return host.dispatch(command);
  };
  const canSave = () => {
    if (!reconcile() || !state.loaded || !matchesTask(state, state.assetId, state.loaded.ontology.ontology_version_id)) return false;
    const record = state.queue.toRecord(state.assetId);
    if (!record || record.ontology_version_id !== state.loaded.ontology.ontology_version_id) return false;
    const draftOwner = record.draft_owner, pendingOwner = record.pending_owner;
    return !(record.generation > record.synced_generation || record.intent_journal.length > record.synced_intent_seq || record.pending)
      || draftOwner?.actor_id === state.session?.user_id && draftOwner?.project_id === state.projectId
        && (!record.pending || pendingOwner?.actor_id === state.session?.user_id && pendingOwner?.project_id === state.projectId);
  };
  const canImport = () => {
    const media = state.assets.find(asset => asset.asset_revision_id === state.assetId && asset.project_id === state.projectId);
    const ontology = state.ontologies.find(item => item.ontology_version_id === state.ontologyId && item.project_id === state.projectId);
    const held = state.importing?.scope === state.scope;
    if (!media || !ontology?.labels.length || !state.catalogReady || !writableRole(state) || state.paused || state.modal || state.preparation || state.submission || state.branchBusy
      || state.importing && !held || !matchesTask(state, media.asset_revision_id, ontology.ontology_version_id)
      || hasUnconfirmedImportForTarget(state.projectId, media.asset_revision_id, ontology.ontology_version_id) && !held) return false;
    if (held && state.importing?.context) return state.importing.context.asset_revision_id === media.asset_revision_id && state.importing.context.ontology_version_id === ontology.ontology_version_id;
    const loaded = state.loaded, record = state.queue.toRecord(state.assetId);
    if (loaded) return !loaded.readOnlyPreview && loaded.media.asset_revision_id === media.asset_revision_id && loaded.media.canonical_sha256 === media.canonical_sha256 && loaded.ontology.ontology_version_id === ontology.ontology_version_id && read()?.status === 'ready'
      && record?.ontology_version_id === ontology.ontology_version_id && (held || state.queue.canAcceptEdits(state.assetId, ontology.ontology_version_id));
    // A never-annotated target is importable without manufacturing a blank revision or GPU session.
    return !state.fixedTask && state.phase === 'ready' && !state.heads.includes(ontology.ontology_version_id) && !record && state.branches.length === 0;
  };
  const scopeGuard = () => { const scope = state.scope; return () => state.scope === scope && sessionCurrent(state); };
  return {
    getReadHost: read, getHost, dispatch, canSave, canReconcile: reconcile, canExport, selectionWritable, scopeGuard, canImport,
    getSnapshot: () => read() ? state.nativeDocuments.get(read()!) ?? state.loaded?.document ?? null : sessionCurrent(state) ? state.loaded?.document ?? null : null,
    cancelGesture: () => { read()?.cancelGesture(); },
    setTool: (tool: EditorTool) => getHost()?.setTool(tool) ?? false,
    select(id: string, additive = false) {
      if (!sessionCurrent(state) || state.preparation || state.importing || state.submission || !state.objects.some(object => object.object_id === id)) return;
      const current = selectedIds(state), next = additive ? current.includes(id) ? current.filter(value => value !== id) : [...current, id] : [id];
      state.previewSelection = next;
      read()?.select(next);
      state.notify();
    },
    async selectAsset(assetId) {
      if (!sessionCurrent(state) || state.preparation || state.importing || state.submission || state.branchBusy || state.fixedTask && state.lease) { state.error = '当前任务已固定图片，或任务准备/导入/提交尚未结束；未切图。'; state.notify(); return; }
      if (!state.assets.some(asset => asset.asset_revision_id === assetId && asset.project_id === state.projectId) || state.assetId === assetId) return;
      read()?.cancelGesture(); state.fixedTask = null; state.assetId = assetId; state.activity.interact('switch'); await state.reload();
    },
    async selectOntology(ontologyId) {
      if (!sessionCurrent(state) || state.preparation || state.importing || state.submission || state.branchBusy || state.fixedTask || !state.ontologies.some(item => item.project_id === state.projectId && item.ontology_version_id === ontologyId)) return;
      state.ontologyId = ontologyId; read()?.cancelGesture(); await state.reload();
    },
    flags(ids: readonly string[], flags: { hidden?: boolean; locked?: boolean }) { getHost()?.setLocalFlags(ids, flags); },
    attribute(key: string, value: Scalar) { return selectionWritable() ? dispatch({ kind: 'set_attributes', object_ids: [...selectedIds(state)], values: { [key]: value } }) : null; },
    relabel(label: string) { if (selectionWritable()) dispatch({ kind: 'set_label', object_ids: [...selectedIds(state)], label_id: label }); },
    drawingLabel(label: string) {
      const host = getHost();
      if (!host || !state.loaded?.ontology.labels.some(item => item.label_id === label)) return;
      host.cancelGesture(); host.setActiveLabel(label); state.activeLabel = label; state.notify();
    },
    async prepareImport(): Promise<AnnotationImportContext> {
      const host = read(), current = scopeGuard(), asset = state.assetId, ontologyId = state.ontologyId;
      if (state.importing || !canImport()) throw new Error('当前固定媒体、规范、权限或任务状态不能导入。');
      const token = { scope: state.scope, context: null as AnnotationImportContext | null, receipt: null as AnnotationRevision | null };
      state.importing = token; host?.cancelGesture(); state.notify();
      try {
        await state.queue.flush(asset, current);
        const status = state.queue.getStatus(asset), record = state.queue.toRecord(asset);
        if (!current() || state.importing !== token || !canImport() || state.assetId !== asset || state.ontologyId !== ontologyId
          || status.dirty || status.saving || status.writes_paused || !['idle', 'synced'].includes(status.phase)
          || record && !status.base_revision_id || !record && state.heads.includes(ontologyId)) throw new Error('当前范围已变化或草稿尚未同步；原请求已保留。');
        token.context = { asset_revision_id: asset, ontology_version_id: ontologyId, base_revision_id: record ? status.base_revision_id : null, lease: wireSaveLease(state.lease) };
        return token.context;
      } catch (reason) { if (state.importing === token) { state.importing = null; state.scope = {}; state.notify(); } throw reason; }
    },
    releaseImport() { if (!state.importing || state.importing.scope !== state.scope || state.importing.receipt) return; state.importing = null; state.scope = {}; state.notify(); },
    async commitImport(revision: AnnotationRevision) {
      const token = state.importing, context = token?.context, loaded = state.loaded;
      if (!token || !context || token.scope !== state.scope || !sessionCurrent(state) || !writableRole(state)
        || state.assetId !== context.asset_revision_id || state.ontologyId !== context.ontology_version_id
        || revision.document.asset_revision_id !== context.asset_revision_id || revision.document.ontology_version_id !== context.ontology_version_id
        || revision.parent_revision_id !== context.base_revision_id) throw new Error('导入回执范围不匹配；原请求已保留。');
      if (token.receipt && (token.receipt.annotation_revision_id !== revision.annotation_revision_id || !sameDocument(token.receipt.document, revision.document))) throw new Error('已有固定导入回执；不能替换其身份或内容。');
      token.receipt = revision;
      const adopted = context.base_revision_id === null && !state.queue.toRecord(context.asset_revision_id)
        ? state.queue.initializeFromServerRevision({ asset_revision_id: context.asset_revision_id, ontology_version_id: context.ontology_version_id, annotation_revision_id: revision.annotation_revision_id, generation: 0, document: revision.document })
        : state.queue.adoptImportReceipt(revision, context.base_revision_id);
      if (!adopted) throw new Error('原队列不再干净，不能采纳导入回执。');
      await state.queue.whenPersisted(context.asset_revision_id);
      const record = state.queue.toRecord(context.asset_revision_id), status = state.queue.getStatus(context.asset_revision_id), proof = status.local_commit;
      if (!sessionCurrent(state) || !writableRole(state) || state.importing !== token || state.scope !== token.scope || state.loaded !== loaded
        || state.assetId !== context.asset_revision_id || state.ontologyId !== context.ontology_version_id
        || !record || record.base_revision_id !== revision.annotation_revision_id || !sameDocument(record.document, revision.document)
        || record.pending || status.saving || status.dirty || status.writes_paused || status.last_error || !proof
        || proof.generation !== record.generation || proof.edit_seq !== (record.edit_seq ?? 0)) {
        state.notify();
        throw new Error('服务器导入回执已保留，但本地持久提交或原范围交接未完成；保留围栏，重试已有回执的本地采纳，不重发导入。');
      }
      state.importing = null;
      await state.reload();
    },
    async prepareExport(): Promise<AnnotationRevision> {
      const loaded = state.loaded, current = scopeGuard();
      if (!loaded || !canExport()) throw new Error('当前范围不能导出。');
      if (canSave()) {
        await state.queue.flush(state.assetId, current);
        const status = state.queue.getStatus(state.assetId);
        if (!current() || status.dirty || status.saving || status.writes_paused) throw new Error('草稿尚未同步；不能导出旧版本。');
      }
      const revision = await api.annotation(loaded.media.asset_revision_id, loaded.ontology.ontology_version_id, state.assetRead?.signal ?? state.readonlyRequests.signal);
      if (!current() || revision.document.asset_revision_id !== loaded.media.asset_revision_id || revision.document.ontology_version_id !== loaded.ontology.ontology_version_id) throw new Error('固定导出范围已变化。');
      return revision;
    },
  };
}
