import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import { admitRawDraft, serializeNativeDraft } from '../../lib/persistence/draft-store';
import { classifyDraftBranches, classifyReadonlySnapshot, compareWithServer } from '../../lib/persistence/recovery';
import type { DraftBranchEnvelope } from '../../lib/persistence/types';
import { api } from '../../lib/t15/api';
import type { EditorPort } from './editor-port';
import { matchesTask } from './editor-port';
import { recordKey, sameDocument, sessionCurrent, writableRole, type WorkspaceState } from './workspace-state';

// No lossy stringify fallback for a raw v1/unknown record. The original store stays untouched.
export function rawDraftJson(record: unknown): string {
  const active = new WeakSet<object>();
  const invalid = () => { throw new Error('原始草稿无法无损表示为 JSON；保留原库，不宣称已救援。'); };
  function visit(value: unknown): void {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') { if (!Number.isFinite(value) || Object.is(value, -0)) invalid(); return; }
    if (typeof value !== 'object') return invalid();
    if (active.has(value)) return invalid();
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if ((!array && prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length) invalid();
    active.add(value);
    if (array) for (let index = 0; index < value.length; index++) { if (!(index in value)) invalid(); visit(value[index]); }
    else for (const key of Object.keys(value)) visit((value as Record<string, unknown>)[key]);
    active.delete(value);
  }
  visit(record);
  const text = JSON.stringify(record); if (text === undefined) return invalid(); return text;
}
export function downloadText(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  try { const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); }
  finally { URL.revokeObjectURL(url); }
}
export interface DraftRecovery {
  refresh(): Promise<void>;
  choose(draftId: string, action: 'recover' | 'use_server'): Promise<void>;
  rescue(draftId?: string): Promise<void>;
  branchHold(asset: string, allowCurrent: boolean, excludeCurrent?: boolean): Promise<string>;
  retry(): Promise<void>;
  keepLocal(): Promise<void>;
  viewServer(): Promise<void>;
  resume(): Promise<void>;
}
export function hasOwnedFuture(state: WorkspaceState): boolean {
  const loaded = state.loaded, host = state.host, fixed = state.fixedTask;
  if (!loaded || !host || host.status !== 'ready' || !fixed || fixed.asset_revision_id !== state.assetId || fixed.project_id !== state.projectId
    || fixed.ontology_version_id !== loaded.ontology.ontology_version_id) return false;
  const record = state.queue.toRecord(state.assetId), status = state.queue.getStatus(state.assetId);
  return !!record && !record.pending && !record.pending_owner && (record.pending_outcome == null || record.pending_outcome === 'prepared')
    && !record.save_error && !status.last_error && !status.saving && record.draft_owner?.actor_id === state.session?.user_id && record.draft_owner?.project_id === state.projectId
    && record.document.asset_revision_id === state.assetId && record.document.ontology_version_id === fixed.ontology_version_id
    && Number.isSafeInteger(record.generation) && Number.isSafeInteger(record.synced_generation) && record.synced_generation >= 0 && record.generation >= record.synced_generation
    && Number.isSafeInteger(record.synced_intent_seq) && record.synced_intent_seq >= 0 && record.synced_intent_seq <= record.intent_journal.length
    && (record.generation > record.synced_generation || record.intent_journal.length > record.synced_intent_seq)
    && host.getGeneration() === record.generation && (status.last_ack?.revision_id === record.base_revision_id || loaded.revision.annotation_revision_id === record.base_revision_id);
}
export function createDraftRecovery(state: WorkspaceState, port: EditorPort, installRevision: (revision: AnnotationRevision, preview: boolean) => Promise<void>): DraftRecovery {
  let busy: object | null = null;
  const refresh = async () => {
    const asset = state.assetId, current = port.scopeGuard();
    if (!asset || !current()) return;
    const rows = await state.queue.readDraftBranches(asset);
    if (current() && state.assetId === asset) { state.branches = rows; state.notify(); }
  };
  const rescue = async (draftId?: string) => {
    const asset = state.assetId, current = port.scopeGuard();
    if (!current()) return;
    if (!draftId) {
      const draft = state.queue.exportDraft(asset);
      if (draft) { downloadText(serializeNativeDraft(draft), 'weblabel-draft-' + asset + '.json'); return; }
      if (state.recovery && 'record' in state.recovery) { downloadText(rawDraftJson(state.recovery.record), 'weblabel-native-draft.json'); return; }
      throw new Error('没有可下载的本地草稿。');
    }
    let source: DraftBranchEnvelope | null;
    try { source = await state.queue.readDraftBranch(asset, draftId); }
    catch (reason) {
      if (!current()) return;
      const cached = state.branches.find(row => row.draft_id === draftId);
      if (!cached) throw reason;
      downloadText(rawDraftJson(cached.record), 'weblabel-draft-' + draftId + '.json');
      throw new Error('已导出先前完整读取的缓存快照；不是最新读取确认或本地保存凭证。');
    }
    if (current() && source) downloadText(rawDraftJson(source.record), 'weblabel-draft-' + draftId + '.json');
  };
  const branchHold = async (asset: string, allowCurrent: boolean, excludeCurrent = false) => {
    const rows = await state.queue.readDraftBranches(asset), memory = state.queue.getDraftBranchSnapshot(asset), dispositions = classifyDraftBranches(rows, memory);
    const recoverySources = new Set<string>(), lineage = new Map<string, string>();
    if (allowCurrent && memory?.local_commit && !memory.ack_local_barrier && hasOwnedFuture(state)) {
      for (const ref of memory.envelope.sources) {
        if (ref.action !== 'recover') continue;
        const source = rows.find(row => row.draft_id === ref.draft_id && row.write_token === ref.write_token);
        if (!source) throw new Error('恢复来源已变化，不能续领原任务。');
        admitRawDraft(source.record, asset); lineage.set(source.draft_id, rawDraftJson(source.record));
        const record = source.record;
        if (record.draft_owner?.actor_id === state.session?.user_id && record.draft_owner?.project_id === state.projectId && !record.pending && !record.pending_owner
          && !record.save_error && (record.pending_outcome == null || record.pending_outcome === 'prepared')
          && record.ontology_version_id === state.fixedTask?.ontology_version_id && record.base_revision_id === state.queue.toRecord(asset)?.base_revision_id) recoverySources.add(source.draft_id);
      }
    }
    for (const [draft, disposition] of dispositions) if ((disposition === 'unresolved' || disposition === 'rescue_only') && !(allowCurrent && draft === memory?.envelope.draft_id) && !recoverySources.has(draft)) throw new Error('存在未处理草稿分支；请明确恢复或留档，不能准备任务。');
    return JSON.stringify({ branches: rows.filter(row => !excludeCurrent || row.draft_id !== memory?.envelope.draft_id).map(row => ({ draft_id: row.draft_id, write_token: row.write_token, sources: row.sources, record: lineage.get(row.draft_id) })).sort((a, b) => a.draft_id.localeCompare(b.draft_id)), memory: !excludeCurrent && memory ? { draft_id: memory.envelope.draft_id, write_token: memory.envelope.write_token, sources: memory.envelope.sources, local_commit: memory.local_commit, ack_local_barrier: memory.ack_local_barrier } : null });
  };
  const resume = async () => {
    const loaded = state.loaded, record = state.queue.toRecord(state.assetId), status = state.queue.getStatus(state.assetId), proof = status.local_commit;
    if (!loaded || !record || !port.canSave() || !proof || status.writes_paused || status.last_error || status.saving || record.writes_paused || record.save_error
      || proof.generation !== record.generation || proof.edit_seq !== (record.edit_seq ?? 0) || !matchesTask(state, state.assetId, record.ontology_version_id)) return;
    if (!loaded.readOnlyPreview && state.host?.getGeneration() === record.generation && sameDocument(state.nativeDocuments.get(state.host), record.document)) { state.recovery = null; state.notify(); return; }
    await state.reload();
  };
  const retry = async () => {
    const current = port.scopeGuard(), asset = state.assetId;
    if (busy || !current() || !port.canReconcile()) return;
    const reconcile = state.queue.captureWriteGuard(asset, () => current() && port.canReconcile());
    const proof = state.futureProof;
    const future = () => !!proof && reconcile() && hasOwnedFuture(state) && proof.scope === state.scope && proof.host === state.host && proof.taskId === state.fixedTask?.task_id
      && recordKey(state.queue.toRecord(asset)) === proof.record && JSON.stringify(state.queue.getStatus(asset).local_commit) === proof.certificate
      && !!state.loaded && matchesTask(state, asset, state.loaded.ontology.ontology_version_id);
    if (!port.canSave() && !state.queue.canRetryRetained(asset, reconcile) && !future()) return;
    const token = {}; busy = token;
    try {
      const handled = await state.queue.retryOwnedFuture(asset, future, reconcile);
      if (!reconcile()) return;
      const leaseHandled = handled || await state.queue.retryRejectedLease(asset, reconcile);
      if (!reconcile()) return;
      if (!leaseHandled) await state.queue.retry(asset, reconcile);
      if (!reconcile()) return;
      await state.queue.whenPersisted(asset);
      if (reconcile()) await resume();
    } finally { if (busy === token) busy = null; }
  };
  return { refresh, rescue, branchHold, retry, resume,
    async choose(draftId, action) {
      if (busy || state.branchBusy || state.preparation || state.importing || state.submission || !writableRole(state)) return;
      const current = port.scopeGuard(), loaded = state.loaded, asset = state.assetId, token = {}; busy = token; state.branchBusy = true;
      state.host?.cancelGesture(); state.notify();
      try {
        await state.queue.whenPersisted(asset);
        if (!current()) return;
        const source = await state.queue.readDraftBranch(asset, draftId);
        if (!current() || !source) throw new Error('所选分支已变化。');
        if (classifyReadonlySnapshot(source.record, asset) === 'rescue_only') throw new Error('原始分支只能下载救援。');
        admitRawDraft(source.record, asset);
        const expected = state.queue.getDraftBranchSnapshot(asset)?.local_commit ?? null;
        const memory = state.queue.getDraftBranchSnapshot(asset);
        if (memory && (!expected || memory.ack_local_barrier || state.queue.getStatus(asset).saving || state.queue.getStatus(asset).last_error?.kind === 'storage')) throw new Error('当前分支尚未完成真实本地提交，请先下载救援。');
        const norm = source.record.ontology_version_id;
        const head = await api.annotation(asset, norm, state.assetRead?.signal ?? state.readonlyRequests.signal);
        if (!current()) return;
        if (head.document.asset_revision_id !== asset || head.document.ontology_version_id !== norm) throw new Error('服务器版本范围不匹配。');
        const report = compareWithServer(source.record, head);
        const outstanding = source.record.generation > source.record.synced_generation || source.record.intent_journal.length > source.record.synced_intent_seq || source.record.pending;
        const owned = !outstanding || source.record.draft_owner?.actor_id === state.session?.user_id && source.record.draft_owner?.project_id === state.projectId
          && (!source.record.pending || source.record.pending_owner?.actor_id === state.session?.user_id && source.record.pending_owner?.project_id === state.projectId);
        const installed = action === 'recover' ? await state.queue.forkFromRecord(source, { expectedCurrent: expected, pauseForUserChoice: report.kind === 'conflict' || !owned || !matchesTask(state, asset, norm) })
          : await state.queue.forkFromServerRevision({ asset_revision_id: asset, ontology_version_id: norm, annotation_revision_id: head.annotation_revision_id, generation: 0, document: head.document }, [{ draft_id: source.draft_id, write_token: source.write_token, action }], { expectedCurrent: expected });
        if (!current()) return;
        if (!installed) throw new Error('未获得当前真实本地提交凭证；原分支及内存救援保留。');
        state.ontologyId = norm;
        // Scope changes only after the queue confirms the explicit token-bound fork.
        if (state.loaded === loaded) await state.reload();
      } finally { if (busy === token) busy = null; state.branchBusy = false; state.notify(); }
    },
    async viewServer() {
      const loaded = state.loaded, current = port.scopeGuard();
      if (!loaded || !current() || busy) return;
      const revision = await api.annotation(state.assetId, loaded.ontology.ontology_version_id, state.assetRead?.signal ?? state.readonlyRequests.signal);
      if (current()) await installRevision(revision, true);
    },
    async keepLocal() {
      const asset = state.assetId, current = port.scopeGuard();
      await rescue();
      if (!port.canSave() || !current()) return;
      const result = await state.queue.resolveConflict(asset, 'keep_local_export', () => current() && port.canSave());
      if (current() && result.action === 'keep_local_export' && result.resumed) {
        await state.queue.flush(asset, () => current() && port.canSave());
        await state.queue.whenPersisted(asset);
        if (current()) await resume();
      }
    },
  };
}
