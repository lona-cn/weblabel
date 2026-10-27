import type { TransfersMountContext } from '../workbench/workbench-context';
import { api, ApiFailure, type RevisionExportArtifact, type RevisionExportIntent } from '../../lib/t15/api';
import { getOutboxSnapshot, putExportIntent, removeExportIntent, subscribeOutbox, type ExportIntent } from './outbox';
import { element, actions, field, options, details, lossView, lifetime, downloadVerified } from './delivery-dom';
import { readLossReport, diagnosticText as failureText, isAmbiguous, type LossReport } from './loss-report';
import { reviewApi } from '../review/api';
type Operation = { record: ExportIntent; uncertain: boolean };
export function mountRevisionExportView(root: HTMLElement, context: TransfersMountContext): () => void {
  const life = lifetime(context.signal); const initial = context.session.getSnapshot(); const actor = initial.kind === 'authenticated' ? initial.session.user_id : null;
  const action = actions(life.signal);
  let scopeKey = context.getScope().scopeKey, operation: Operation | null = null, report: LossReport | null = null, failure: ApiFailure | null = null, artifact: RevisionExportArtifact | null = null, busy = false, ack = false;
  const section = element('section'); section.setAttribute('aria-label', '单图版本导出'); const format = element('select'); options(format, [{ value: 'native', text: 'Native原生包' }, { value: 'yolo', text: 'YOLO' }, { value: 'coco', text: 'COCO' }], 'native');
  const target = element('p'), reportRoot = element('div'), recordsRoot = element('div'), diagnostics = element('div'); const error = element('p'); error.setAttribute('role', 'alert'); error.hidden = true;
  const start = action('检查损失并导出', () => void begin()); start.className = 'primary'; const check = action('重新检查导出版本', () => void checkRevision());
  const ackInput = element('input'); ackInput.type = 'checkbox'; const ackLabel = field('我已阅读并确认导出损失', ackInput); const confirm = action('确认损失并继续导出', () => void confirmLoss());
  const cancel = action('取消此次导出', () => { if (busy || operation?.uncertain) return; reset(); render(); });
  section.append(element('h3', '导出当前图片版本'), element('p', '仅导出固定revision。继续编辑不改变它；单图原生包不是完整项目备份或审核数据集。'), field('导出格式', format), target, start, reportRoot, ackLabel, confirm, check, cancel, recordsRoot, diagnostics, error); root.append(section);
  function current(key: object = scopeKey) { const scope = context.getScope(), auth = context.session.getSnapshot(); return life.alive && scope.scopeKey === key && auth.kind === 'authenticated' && auth.session.user_id === actor; }
  function records() { const now = context.getScope(); return getOutboxSnapshot().exports.filter(record => record.target.projectId === context.projectId && record.target.assetRevisionId === now.asset?.asset_revision_id); }
  function reset() { operation = null; report = null; artifact = null; failure = null; ack = false; error.hidden = true; }
  function showError(cause: unknown) { if (life.alive) { error.hidden = false; error.textContent = failureText(cause); } }
  function restore() {
    const all = records(); const record = all.find(record => record.scope === scopeKey && !record.artifact) ?? all.filter(record => record.scope === scopeKey).at(-1);
    if (record && (!operation || operation.record.payload.operation_id === record.payload.operation_id)) { operation = { record, uncertain: !record.artifact }; artifact = record.artifact; report = artifact ? readLossReport(artifact.loss_report) : report; }
  }
  function render() {
    if (!life.alive) return; const now = context.getScope(); const fixed = operation?.record;
    section.setAttribute('aria-busy', String(busy)); target.textContent = fixed ? `固定版本 ${fixed.revisionId} · 格式 ${fixed.payload.format} · 原操作 ${fixed.payload.operation_id}` : `目标 ${now.asset?.original_name ?? '未选择媒体'}`;
    format.disabled = busy || !!operation?.uncertain || records().some(record => !record.artifact);
    start.disabled = busy || !current() || !now.canExport || !now.asset || !now.ontology || !!operation || records().some(record => !record.artifact);
    reportRoot.replaceChildren(); if (report && fixed?.scope === now.scopeKey) reportRoot.append(lossView(report));
    const canAck = failure?.status === 422 && failure.code === 'LOSS_ACK_REQUIRED' && !!report && !artifact && !operation?.uncertain && fixed?.scope === now.scopeKey;
    ackLabel.hidden = confirm.hidden = !canAck; ackInput.checked = ack; ackInput.disabled = busy; confirm.disabled = busy || !ack || !current();
    check.hidden = !operation || !!operation.uncertain; check.disabled = busy || !current(); cancel.hidden = !operation || !!operation.uncertain || !!artifact; cancel.disabled = busy;
    diagnostics.replaceChildren(); if (failure) diagnostics.append(details('完整服务端诊断', { code: failure.code, request_id: failure.request_id, details: failure.details }));
    recordsRoot.replaceChildren();
    for (const record of records()) {
      const block = element('section'); block.append(element('p', `固定版本 ${record.revisionId} · 原操作 ${record.payload.operation_id} · ${record.artifact ? `已确认产物 ${record.artifact.export_id}，${record.artifact.byte_size} 字节 · SHA-256 ${record.artifact.object_sha256}` : '结果未知，保留原载荷；不会为新范围创建替代操作。'}`));
      if (record.artifact) { const download = action('重新下载已有产物', () => void downloadArtifact(record.artifact!)); download.disabled = busy || !current(); block.append(download); }
      else { const read = action('只读核对原固定版本', () => void reconcile(record)); read.disabled = busy || !current(); block.append(read); }
      if (record.scope !== now.scopeKey) block.append(element('p', '此记录属于原范围，不代表当前工作台已导出；只可读取已有救援产物。'));
      recordsRoot.append(block);
    }
  }
  async function downloadArtifact(existing: RevisionExportArtifact) {
    if (!current() || busy) return; busy = true; render(); try { await downloadVerified(existing, `weblabel-${existing.export_id}.${existing.format === 'coco' ? 'json' : 'zip'}`, life.signal, existing.format !== 'coco', current); if (current()) { error.hidden = false; error.setAttribute('role', 'status'); error.textContent = '已有产物字节数与SHA-256已校验，已发起下载。'; } }
    catch (cause) { if (current()) showError(new Error(`产物保留，重新下载不会创建新导出。${failureText(cause)}`)); } finally { busy = false; render(); }
  }
  async function send(fixed: ExportIntent) {
    putExportIntent({ ...fixed, sending: true });
    try {
      const result = await api.createRevisionExport(fixed.revisionId, fixed.payload);
      if (!result?.export_id || result.format !== fixed.payload.format || result.download_url !== `/api/exports/${result.export_id}/download` || !Number.isSafeInteger(result.byte_size) || result.byte_size < 0 || !/^[a-f0-9]{64}$/i.test(result.object_sha256) || !readLossReport(result.loss_report)) throw new Error('导出回执身份或损失报告无效。');
      const record = { ...fixed, artifact: result, sending: false }; putExportIntent(record);
      if (!current(fixed.scope as object)) return; operation = { record, uncertain: false }; artifact = result; report = readLossReport(result.loss_report); ack = false; failure = null;
      error.hidden = true;
    } catch (cause) {
      const uncertain = isAmbiguous(cause); const record = { ...fixed, sending: false };
      if (uncertain) putExportIntent(record); else removeExportIntent(record);
      if (!current(fixed.scope as object)) return;
      operation = { record, uncertain }; failure = cause instanceof ApiFailure ? cause : null; ack = false; report = null;
      if (!uncertain && failure?.status === 422 && failure.code === 'LOSS_ACK_REQUIRED') { report = readLossReport(failure.details?.loss_report); showError(new Error(report ? '请阅读服务端实际损失，明确确认后继续。' : '损失报告无效或未知，不能授权继续。')); }
      else showError(uncertain ? new Error(`导出结果未知，保留原固定版本、格式、操作与载荷。只读核对，不自动重发。${failureText(cause)}`) : cause);
    }
  }
  async function begin() {
    const now = context.getScope(); if (!current() || busy || !now.canExport || !now.asset || !now.ontology || operation || records().some(record => !record.artifact)) return;
    const key = now.scopeKey; busy = true; error.hidden = true; render();
    try {
      const revision = await context.prepareExport(); if (!current(key)) return;
      if (!revision.annotation_revision_id || revision.document.asset_revision_id !== now.asset.asset_revision_id || revision.document.ontology_version_id !== now.ontology.ontology_version_id) throw new Error('无法固定导出版本。');
      const record: ExportIntent = { scope: key, target: Object.freeze({ projectId: context.projectId, assetRevisionId: revision.document.asset_revision_id, ontologyId: revision.document.ontology_version_id }), revisionId: revision.annotation_revision_id, payload: Object.freeze({ format: format.value as RevisionExportIntent['format'], loss_ack: false, operation_id: crypto.randomUUID() }), artifact: null, sending: false };
      operation = { record, uncertain: true }; report = null; failure = null; ack = false; await send(record);
    } catch (cause) { if (current(key)) showError(cause); } finally { busy = false; render(); }
  }
  async function confirmLoss() {
    if (!current() || busy || !ack || !report || operation?.uncertain || !operation || failure?.status !== 422 || failure.code !== 'LOSS_ACK_REQUIRED') return;
    const fixed = operation.record; if (fixed.scope !== scopeKey) return;
    // Only a definite initial 422 permits an explicit changed loss authorization.
    const authorized = { ...fixed, payload: Object.freeze({ ...fixed.payload, loss_ack: true }) }; busy = true; operation = { record: authorized, uncertain: true }; render(); try { await send(authorized); } finally { busy = false; render(); }
  }
  async function checkRevision() {
    if (!current() || busy || operation?.uncertain) return; const key = scopeKey; busy = true; render();
    try { const revision = await context.prepareExport(); if (current(key) && revision.annotation_revision_id !== operation?.record.revisionId) { reset(); showError(new Error('实际版本已变化，旧损失确认已撤销；重新检查损失。')); } } catch (cause) { if (current(key)) showError(cause); } finally { busy = false; render(); }
  }
  async function reconcile(record: ExportIntent) { if (!current() || busy) return; busy = true; render(); try { const revision = await reviewApi.revision(record.revisionId, life.signal); if (current()) showError(new Error(`已只读读取原版本 ${revision.annotation_revision_id}；API未提供原导出operation查询证明，结果仍未知，不能重发或声称成功。`)); } catch (cause) { if (current()) showError(cause); } finally { busy = false; render(); } }
  format.addEventListener('change', () => { if (busy || operation?.uncertain || records().some(record => !record.artifact)) return; reset(); render(); }, { signal: life.signal }); ackInput.addEventListener('change', () => { if (!busy) ack = ackInput.checked; render(); }, { signal: life.signal });
  life.add(context.subscribe(() => { const next = context.getScope().scopeKey; if (next !== scopeKey) { scopeKey = next; reset(); restore(); } render(); })); life.add(subscribeOutbox(() => { restore(); render(); })); life.add(context.session.subscribe(render)); life.add(() => section.remove()); restore(); render(); return life.dispose;
}
