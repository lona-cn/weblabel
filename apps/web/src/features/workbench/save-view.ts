import type { Completion } from '../../../../../packages/contracts/generated/Completion';
import type { DraftBranchEnvelope, SavePhase, SaveStatusSnapshot } from '../../lib/persistence/types';
import { admitRawDraft } from '../../lib/persistence/draft-store';
import { classifyDraftBranches, classifyReadonlySnapshot } from '../../lib/persistence/recovery';
import { readonlyVisual } from '../ai/readonly-visual';
import { downloadText, rawDraftJson, type DraftRecovery } from './draft-recovery';
import type { EditorPort } from './editor-port';
import { action, element, labeled, option } from './view-elements';
import { reportError, sessionCurrent, writableRole, type WorkspaceState } from './workspace-state';

export const COMPLETION_LABELS: Readonly<Record<Completion, string>> = {
  unprocessed: '未处理',
  in_progress: '标注中',
  complete: '已完成',
  confirmed_negative: '已确认无目标',
};
const PHASE: Record<SavePhase, string> = { idle: '无待保存更改', unsaved: '有未保存更改', saved_local: '本地事务已完成，待同步', saving: '正在同步到服务器', synced: '服务器已确认', save_failed: '保存失败，草稿已保留', storage_error: '本地存储失败，当前修改尚未持久保存', paused: '写入已暂停，保留原请求', conflict: '保存结果或版本待核对，自动写入已暂停' };
export function mountSaveView(root: HTMLElement, state: WorkspaceState, port: EditorPort, recovery: DraftRecovery, signal: AbortSignal): () => void {
  const status = element('p'); status.dataset.testid = 'save-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const receipts = element('p'), error = element('p'); error.setAttribute('role', 'alert');
  const certificate = element('details'), certificateValues = element('dl');
  certificateValues.dataset.testid = 'save-certificate';
  certificate.append(element('summary', '保存记录与确认凭证（技术详情）'), certificateValues);
  let lastCertificate: SaveStatusSnapshot | null = null;
  const controls = element('div', undefined, 'r07-button-row');
  let busy = false;
  const perform = async (callback: () => Promise<void>) => {
    if (busy || !sessionCurrent(state)) return;
    busy = true; error.textContent = ''; update();
    try { await callback(); } catch (reason) { if (!signal.aborted) error.textContent = reportError(reason); }
    finally { busy = false; if (!signal.aborted) update(); }
  };
  const save = action('保存', 'save-current', signal, () => { const asset = state.assetId, current = port.scopeGuard(); if (port.canSave()) void perform(() => state.queue.flushExplicit(asset, () => current() && port.canSave())); });
  const retry = action('重试原保存', 'save-retry', signal, () => void perform(recovery.retry));
  const rescue = action('下载本地草稿', 'export-local-draft', signal, () => void perform(() => recovery.rescue()));
  const server = action('查看服务器版本（只读）', 'view-server', signal, () => void perform(recovery.viewServer));
  const keep = action('导出并保留本地草稿', 'keep-local-export', signal, () => void perform(recovery.keepLocal));
  controls.append(retry, rescue, server, keep);
  const completion = element('select'); completion.dataset.testid = 'completion-state';
  for (const [value, text] of Object.entries(COMPLETION_LABELS)) completion.append(option(value, text));
  const negative = element('input'); negative.type = 'checkbox'; negative.dataset.testid = 'negative-confirmation';
  const negativeLabel = labeled('我已检查图片，确认没有目标对象。没有画框不代表没有目标。', negative);
  const complete = action('标注完成并保存', 'complete-annotation', signal, () => {
    if (!port.getHost()) return;
    if (completion.value === 'confirmed_negative') { if (!negative.checked || state.objects.length) return; port.dispatch({ kind: 'set_completion', completion: 'confirmed_negative' }); }
    else port.dispatch({ kind: 'set_completion', completion: 'complete' });
    const current = port.scopeGuard(); if (port.canSave()) void perform(() => state.queue.flushExplicit(state.assetId, () => current() && port.canSave()));
  });
  const diagnostics = element('details'); diagnostics.dataset.testid = 'save-diagnostic'; const diagnosticText = element('pre'); diagnostics.append(element('summary', '保存技术诊断（上次操作）'), diagnosticText);
  const recoveryBanner = element('section'); recoveryBanner.dataset.testid = 'recovery-banner';
  const conflictBanner = element('p'); conflictBanner.dataset.testid = 'conflict-banner'; conflictBanner.setAttribute('role', 'status');
  const primary = element('div', undefined, 'r07-save-primary r07-button-row');
  primary.append(save, labeled('完成状态（保存的文档状态）', completion), negativeLabel, complete);
  root.append(status, conflictBanner, primary, receipts, certificate, recoveryBanner, controls, diagnostics, error);
  const branchList = element('div'), compare = element('div'), branchActions = element('div', undefined, 'r07-button-row');
  recoveryBanner.append(element('h2', '草稿恢复'), element('p', '明确选择一个本地分支后恢复或使用服务器版本并留档。不会自动选择最新分支，不会自动合并；原记录与来源始终保留。'), branchList, compare, branchActions);
  let chosen: string | null = null, branchRows: readonly DraftBranchEnvelope[] | null = null, lastDocument = state.document, legacyRows = state.legacyRows, differenceIndex = 0;
  let lastDiagnostic: SaveStatusSnapshot | null = null, hasUnresolvedBranches = false;
  const recover = action('恢复选中分支', 'recover-selected-branch', signal, () => { if (chosen) void perform(() => recovery.choose(chosen!, 'recover')); });
  const useServer = action('使用服务器版并留档选中分支', 'archive-selected-branch', signal, () => { if (chosen) void perform(() => recovery.choose(chosen!, 'use_server')); });
  const rescueBranch = action('下载选中分支原始草稿', 'rescue-selected-branch', signal, () => { if (chosen) void perform(() => recovery.rescue(chosen!)); });
  branchActions.append(recover, useServer, rescueBranch);
  function updateComparison() {
    compare.replaceChildren();
    const row = state.branches.find(item => item.draft_id === chosen), serverDocument = state.loaded?.revision.document;
    if (!row || !serverDocument) return;
    try {
      admitRawDraft(row.record, row.asset_revision_id);
      const local = row.record.document;
      if (local.asset_revision_id !== serverDocument.asset_revision_id || local.ontology_version_id !== serverDocument.ontology_version_id) { compare.append(element('p', '分支与当前固定范围不同；不可将其他图或规范冒充当前对照。')); return; }
      compare.append(element('h3', '只读比较 · 不自动合并'), readonlyVisual(serverDocument, state.assetId, serverDocument.objects.map(object => object.geometry), [], false), readonlyVisual(local, state.assetId, [], local.objects.map(object => object.geometry), false));
      const table = element('table'), header = element('tr'); for (const text of ['对象', '服务器固定版本', '选中本地分支']) header.append(element('th', text)); table.append(header);
      const serverObjects = new Map(serverDocument.objects.map(object => [object.object_id, object])), localObjects = new Map(local.objects.map(object => [object.object_id, object]));
      const ids = [...new Set([...serverObjects.keys(), ...localObjects.keys()])].filter(id => JSON.stringify(serverObjects.get(id)) !== JSON.stringify(localObjects.get(id)));
      differenceIndex = Math.max(0, Math.min(differenceIndex, ids.length - 1));
      const id = ids[differenceIndex];
      if (id) { const tr = element('tr'); tr.append(element('th', id), element('td', JSON.stringify(serverObjects.get(id) ?? null)), element('td', JSON.stringify(localObjects.get(id) ?? null))); table.append(tr); }
      const previous = action('上一处差异', 'draft-diff-previous', signal, () => { differenceIndex--; updateComparison(); }), next = action('下一处差异', 'draft-diff-next', signal, () => { differenceIndex++; updateComparison(); });
      previous.disabled = differenceIndex === 0; next.disabled = differenceIndex >= ids.length - 1;
      compare.append(element('p', '服务器完成状态：' + COMPLETION_LABELS[serverDocument.completion] + '；本地：' + COMPLETION_LABELS[local.completion]), table, previous, element('span', (ids.length ? differenceIndex + 1 : 0) + ' / ' + ids.length + ' 处对象差异'), next);
    } catch { compare.append(element('p', '原始记录不可读，只能下载救援。')); }
  }
  function update() {
    const snapshot = state.queue.getStatus(state.assetId), record = state.queue.toRecord(state.assetId), current = sessionCurrent(state);
    const unresolved = !!record?.pending && record.pending_outcome === 'unknown' && !snapshot.saving;
    status.dataset.state = snapshot.phase;
    status.dataset.phase = snapshot.phase; status.dataset.dirty = String(snapshot.dirty);
    if (lastCertificate !== snapshot) {
      lastCertificate = snapshot; certificateValues.replaceChildren();
      const values: [string, string | number][] = [['local_commit', snapshot.local_commit ? '本地提交凭证' : 'null（无本地提交凭证）']];
      if (snapshot.local_commit) for (const key of ['draft_id', 'write_token', 'persist_seq', 'edit_seq', 'generation'] as const) values.push(['local_commit.' + key, snapshot.local_commit[key]]);
      values.push(['last_ack', snapshot.last_ack ? '服务器确认凭证' : 'null（无服务器确认）']);
      if (snapshot.last_ack) for (const key of ['revision_id', 'generation', 'at'] as const) values.push(['last_ack.' + key, snapshot.last_ack[key]]);
      for (const [key, value] of values) certificateValues.append(element('dt', key), element('dd', String(value)));
    }
    receipts.textContent = (snapshot.local_commit ? '✓ 本地事务已持久化 · ' + snapshot.local_commit.draft_id + ' / ' + snapshot.local_commit.write_token + ' · 编辑序号 ' + snapshot.local_commit.edit_seq : '本地事务尚未完成或凭证不可用')
      + ' ｜ ' + (snapshot.last_ack ? '服务器 ACK：' + snapshot.last_ack.revision_id + ' · 版本 ' + snapshot.last_ack.generation : '服务器尚未确认') + ' ｜ dirty=' + snapshot.dirty;
    conflictBanner.hidden = !snapshot.writes_paused && state.recovery?.kind !== 'conflict' && !unresolved;
    conflictBanner.textContent = record?.pending_outcome === 'unknown' ? '原请求结果未知：后续错误不证明原请求被拒绝。保留 operation、payload、pending、journal；不得换编号或新 lease 包装原请求。' : '版本或原请求待核对；本地草稿已保留，不自动覆盖任一方。';
    save.disabled = busy || !port.canSave() || snapshot.writes_paused;
    retry.disabled = busy || !current || !port.canReconcile() || !(port.canSave() || state.queue.canRetryRetained(state.assetId, () => port.canReconcile()) || state.futureProof);
    rescue.disabled = busy || !current || !snapshot.draft_exportable && !(state.recovery && 'record' in state.recovery);
    keep.disabled = busy || !current || !snapshot.draft_exportable; server.disabled = busy || !state.loaded || !current;
    if (diagnostics.open && lastDiagnostic !== snapshot) {
      lastDiagnostic = snapshot;
      const branch = state.queue.getDraftBranchSnapshot(state.assetId)?.envelope;
      diagnosticText.textContent = JSON.stringify({ owner: record?.draft_owner ?? null, pending_owner: record?.pending_owner ?? null, generation: record?.generation, base: record?.base_revision_id, local_commit: snapshot.local_commit, last_ack: snapshot.last_ack,
        operation: record?.pending, pending_outcome: record?.pending_outcome, journal: record?.intent_journal, draft_id: branch?.draft_id, write_token: branch?.write_token, sources: branch?.sources, error: snapshot.last_error }, null, 2);
    }
    diagnostics.hidden = !record && !snapshot.last_error;
    const changed = lastDocument !== state.document;
    if (changed) { lastDocument = state.document; completion.value = state.document?.completion ?? 'unprocessed'; negative.checked = false; }
    completion.disabled = !port.getHost(); negativeLabel.hidden = completion.value !== 'confirmed_negative'; negative.disabled = !port.getHost() || state.objects.length > 0;
    complete.textContent = completion.value === 'confirmed_negative' ? '确认无目标并保存' : '标注完成并保存'; complete.disabled = busy || !port.getHost() || completion.value === 'confirmed_negative' && (!negative.checked || state.objects.length > 0);
    if (branchRows !== state.branches || legacyRows !== state.legacyRows) {
      branchRows = state.branches; legacyRows = state.legacyRows; branchList.replaceChildren();
      const dispositions = classifyDraftBranches(state.branches, state.queue.getDraftBranchSnapshot(state.assetId));
      hasUnresolvedBranches = state.legacyRows.length > 0 || state.branches.some(row => {
        const disposition = dispositions.get(row.draft_id);
        return disposition === 'unresolved' || disposition === 'rescue_only';
      });
      for (const row of state.branches) {
        if (classifyReadonlySnapshot(row.record, row.asset_revision_id) === 'clean_snapshot') continue;
        const radio = element('input'); radio.type = 'radio'; radio.name = 'r07-draft-branch'; radio.value = row.draft_id; radio.checked = chosen === row.draft_id;
        radio.addEventListener('change', () => { chosen = row.draft_id; differenceIndex = 0; updateComparison(); update(); }, { signal });
        const label = labeled('分支 ' + row.draft_id + ' · ' + dispositions.get(row.draft_id) + ' · token ' + row.write_token, radio), source = element('pre', JSON.stringify(row.sources, null, 2));
        const record = row.record && typeof row.record === 'object' ? row.record as Record<string, unknown> : {};
        branchList.append(label, element('p', '作者：' + JSON.stringify(record.draft_owner ?? '未提供') + ' · base：' + String(record.base_revision_id ?? '未提供') + ' · generation：' + String(record.generation ?? '未提供') + ' · 时间：' + String(record.updated_at ?? '未提供')), source);
      }
      for (const row of state.legacyRows) branchList.append(action('下载旧库原始记录 ' + String(row.key), 'export-legacy-draft', signal, () => { try { downloadText(rawDraftJson(row.record), 'weblabel-legacy-draft.json'); } catch (reason) { error.textContent = reportError(reason); } }));
      if (chosen && !state.branches.some(row => row.draft_id === chosen)) chosen = null;
      updateComparison();
    }
    const row = state.branches.find(item => item.draft_id === chosen), rescueOnly = row ? classifyReadonlySnapshot(row.record, row.asset_revision_id) === 'rescue_only' : true;
    recover.disabled = useServer.disabled = busy || state.branchBusy || !chosen || rescueOnly || !current || !writableRole(state);
    rescueBranch.disabled = busy || !current || !chosen;
    recoveryBanner.hidden = !branchList.childElementCount && !(state.recovery && ['restored', 'conflict', 'unreachable'].includes(state.recovery.kind));
    const retained = hasUnresolvedBranches && !snapshot.dirty && (snapshot.phase === 'idle' || snapshot.phase === 'synced');
    status.textContent = !state.loaded && !record && snapshot.phase === 'idle' && !snapshot.dirty && !snapshot.last_error && !unresolved && !retained
      ? state.phase === 'empty' ? '尚未导入图片；没有标注保存记录。' : '尚未载入标注文档；服务器确认状态未知。'
      : (unresolved ? '保存结果未知，原请求已保留' : retained ? '存在待恢复或救援的本地草稿' : PHASE[snapshot.phase])
        + (retained ? ' · 当前分支本地版本 ' : ' · 本地版本 ') + snapshot.local_generation + ' / 服务器确认 ' + snapshot.synced_generation;
  }
  completion.addEventListener('change', () => { if (!port.getHost()) return; negative.checked = false; if (completion.value !== 'confirmed_negative') port.dispatch({ kind: 'set_completion', completion: completion.value as Completion }); update(); }, { signal });
  negative.addEventListener('change', update, { signal });
  diagnostics.addEventListener('toggle', () => { if (diagnostics.open) { lastDiagnostic = null; update(); } }, { signal });
  const unsubscribe = state.subscribe(update); update(); return unsubscribe;
}
