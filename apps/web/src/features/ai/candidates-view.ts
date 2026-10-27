import type { AnnotationObject } from '../../../../../packages/contracts/generated/AnnotationObject';
import type { RunContext } from '../../../../../packages/contracts/generated/RunContext';
import type { BBox } from '../../../../../packages/contracts/generated/BBox';
import type { RunController, CandidateEntry } from './run-controller';
import { canAcceptSuggestion, canDecideSuggestion } from './run-controller';
import { checkedRejectionState, knownRejectionFailure, rejectionApi, type RejectionPayload } from './rejections';
import { projectRelabel } from '../../lib/editor/loader';
import { readonlyVisual } from './readonly-visual';
import { action, element, labeled } from '../workbench/view-elements';

export interface CandidateViewContext {
  signal: AbortSignal;
  controller: RunController;
  getScope(): { assetId: string; context: RunContext; generation: number; writable: boolean; current: boolean };
  focusRegion(bounds: BBox): boolean;
  onDecisionRecorded(): void;
}
export interface CandidateCard {
  element: HTMLElement;
  update(entry: CandidateEntry): void;
  setExpanded(expanded: boolean): void;
  refresh(): void;
  rejectSelected(): Promise<'success' | 'failed' | 'unknown'>;
  selectedCount(): number;
}
function createCandidateCard(initial: CandidateEntry, context: CandidateViewContext, selectionChanged: () => void): CandidateCard {
  let entry = initial, rejected: string[] | null = null, pending: RejectionPayload | null = null, writing = false;
  const selected = new Set<string>(), root = element('article', undefined, 'r07-candidate-card'), heading = element('h3'), notice = element('p'), message = element('p');
  notice.setAttribute('role', 'status'); message.setAttribute('role', 'status');
  const readButton = action('只读重新检查拒绝状态', 'check-rejection-' + entry.candidate.suggestion_set_id, context.signal, () => void read());
  const changesRoot = element('ul'), combined = element('div', undefined, 'r07-candidate-combined'), comparisonGrid = element('div', undefined, 'r07-candidate-comparison');
  combined.dataset.testid = 'candidate-combined-visual'; combined.hidden = true; comparisonGrid.append(combined, changesRoot);
  const issues = element('div'), score = element('p'), accept = action('采纳所选建议', 'accept-selected', context.signal, () => {
    const scope = context.getScope();
    if (!allowed() || !scope.current || !scope.writable || !selected.size || pending || !rejected) return;
    void context.controller.acceptSelected(entry.candidate, entry.asset_revision_id, [...selected], entry.schema_error, rejected).then(context.onDecisionRecorded);
  });
  const rejectSelected = action('拒绝所选建议', 'reject-selected', context.signal, () => void reject([...selected]));
  const rejectAll = action('拒绝本组未拒绝建议', 'reject-all', context.signal, () => void reject(entry.candidate.changes.filter(change => !rejected?.includes(change.change_id)).map(change => change.change_id)));
  root.append(heading, notice, message, readButton, comparisonGrid, issues, score, accept, rejectSelected, rejectAll);
  const rows = new Map<string, { checkbox: HTMLInputElement; rejection: HTMLElement; reject: HTMLButtonElement; focus: HTMLButtonElement; local: HTMLButtonElement; bounds: BBox | null; projectionReady: boolean; geometry(): { before: BBox | null; after: BBox | null }; render(): void }>();
  let visualAsset = context.getScope().assetId, expanded = false, focusedChange: string | null = null;
  function allowed() {
    const scope = context.getScope();
    return scope.current && scope.writable && !writing && !pending && rejected !== null
      && canAcceptSuggestion({ active_asset: scope.assetId, candidate_asset: entry.asset_revision_id, active_context: scope.context, run_context: entry.run_context, active_generation: scope.generation,
        candidate: entry.candidate, busy: context.controller.getSnapshot().busy, schema_error: entry.schema_error });
  }
  function rejectable() {
    const scope = context.getScope();
    return scope.current && !writing && !pending && rejected !== null
      && canDecideSuggestion({ active_asset: scope.assetId, candidate_asset: entry.asset_revision_id, active_context: scope.context, run_context: entry.run_context, active_generation: scope.generation,
        candidate: entry.candidate, busy: context.controller.getSnapshot().busy, schema_error: entry.schema_error });
  }
  function renderCombined() {
    if (!expanded) { combined.replaceChildren(); return; }
    const before: BBox[] = [], after: BBox[] = [];
    for (const [id, row] of rows) {
      if (focusedChange && id !== focusedChange) continue;
      const geometry = row.geometry();
      if (geometry.before) before.push(geometry.before);
      if (geometry.after) after.push(geometry.after);
    }
    combined.replaceChildren(readonlyVisual(entry.fixedDocument, context.getScope().assetId, before, after, !!focusedChange));
    for (const [id, row] of rows) row.local.textContent = focusedChange === id ? '查看整图对照' : '定位建议局部';
  }
  function refresh() {
    const scope = context.getScope(), eligible = allowed(), canReject = rejectable();
    if (visualAsset !== scope.assetId) { visualAsset = scope.assetId; for (const row of rows.values()) row.render(); renderCombined(); }
    heading.textContent = '候选 ' + entry.candidate.suggestion_set_id + ' · ' + entry.asset_revision_id;
    notice.textContent = entry.schema_error ? '建议格式或范围错误，只能对照：' + entry.schema_error : entry.asset_revision_id !== scope.assetId ? '这是另一张图片的结果，只能对照。'
      : !canDecideSuggestion({ active_asset: scope.assetId, candidate_asset: entry.asset_revision_id, active_context: scope.context, run_context: entry.run_context, active_generation: scope.generation, candidate: entry.candidate, busy: false }) ? '此结果只能对照：版本、范围、状态或授权已变化。' : pending ? '拒绝结果未知，不能采纳或再次拒绝。' : rejected === null ? '拒绝状态尚未核实，不能采纳。' : !canAcceptSuggestion({ active_asset: scope.assetId, candidate_asset: entry.asset_revision_id, active_context: scope.context, run_context: entry.run_context, active_generation: scope.generation, candidate: entry.candidate, busy: false }) ? '当前运行不授权改类，不能采纳；可拒绝建议。' : '固定版本与拒绝状态已核实；显式采纳经 Native 命令，一次撤销。';
    for (const [id, row] of rows) {
      row.checkbox.checked = selected.has(id); row.checkbox.disabled = !eligible || !row.projectionReady || rejected?.includes(id) === true;
      row.rejection.textContent = rejected?.includes(id) ? '已拒绝（服务器记录）' : '';
      row.reject.disabled = !canReject || rejected?.includes(id) === true;
      const fixed = entry.fixedDocument, ontology = entry.fixedOntology;
      row.focus.disabled = !scope.current || !row.bounds || !!entry.schema_error || scope.assetId !== entry.asset_revision_id || !fixed || fixed.asset_revision_id !== scope.assetId
        || fixed.ontology_version_id !== scope.context.ontology_version_id || ontology?.project_id !== scope.context.project_id || ontology.ontology_version_id !== scope.context.ontology_version_id
        || [entry.run_context, entry.candidate.context].some(value => value.project_id !== scope.context.project_id || value.asset_revision_id !== scope.assetId || value.ontology_version_id !== scope.context.ontology_version_id || value.canonical_sha256 !== scope.context.canonical_sha256);
    }
    accept.disabled = !eligible || !selected.size;
    rejectSelected.disabled = !canReject || !selected.size;
    rejectAll.disabled = !canReject || !entry.candidate.changes.some(change => !rejected?.includes(change.change_id));
    readButton.disabled = writing || !scope.current; readButton.hidden = rejected !== null && !pending;
    readButton.textContent = pending ? '只读核对拒绝' : '只读重新检查拒绝状态';
    score.textContent = entry.candidate.score === null ? '未提供评分；采纳数量不是正确率。' : '模型评分 ' + entry.candidate.score + '，不代表正确率。';
    selectionChanged();
  }
  async function read() {
    if (context.signal.aborted || !context.getScope().current) return;
    try {
      const result = checkedRejectionState(await rejectionApi.read(entry.candidate.suggestion_set_id, pending?.operation_id, context.signal), entry.candidate.suggestion_set_id, entry.candidate.changes.map(change => change.change_id));
      if (context.signal.aborted || !context.getScope().current) return;
      rejected = result.rejected_change_ids;
      if (pending) {
        const payload = pending, receipt = result.operations.find(operation => operation.operation_id === payload.operation_id);
        if (receipt && JSON.stringify(receipt.change_ids) === JSON.stringify(payload.change_ids)) { pending = null; message.textContent = '已只读核实拒绝成功。'; context.onDecisionRecorded(); }
        else message.textContent = '未找到原 operation ' + payload.operation_id + ' 的匹配收据，结果仍未知；不要重复写入。';
      }
      if (!pending) for (const id of selected) if (rejected.includes(id)) selected.delete(id);
    } catch { if (!context.signal.aborted) { rejected = null; message.textContent = pending ? '原 operation ' + pending.operation_id + ' 核对失败；保留选择，只读重新检查。' : '拒绝状态读取失败，不能采纳；请只读重新检查。'; } }
    refresh();
  }
  async function reject(ids: string[]): Promise<'success' | 'failed' | 'unknown'> {
    const candidate = entry.candidate;
    if (!rejectable() || rejected === null || !ids.length) return 'failed';
    writing = true; refresh();
    const payload: RejectionPayload = { operation_id: crypto.randomUUID(), change_ids: [...ids] };
    try {
      const receipt = await rejectionApi.reject(candidate.suggestion_set_id, payload);
      if (receipt.suggestion_set_id !== candidate.suggestion_set_id || receipt.operation_id !== payload.operation_id || JSON.stringify(receipt.change_ids) !== JSON.stringify(payload.change_ids)) throw new Error('拒绝回执不匹配');
      if (context.signal.aborted || !context.getScope().current) return 'unknown';
      rejected = [...new Set([...rejected, ...ids])]; for (const id of ids) selected.delete(id); message.textContent = '拒绝已保存到服务器。'; context.onDecisionRecorded(); return 'success';
    } catch (reason) {
      if (knownRejectionFailure(reason)) { message.textContent = '服务器明确拒绝此操作；已采纳项须先通过保存事务撤销。'; return 'failed'; }
      pending = payload; message.textContent = '原 operation ' + payload.operation_id + ' 与选择已保留；仅可只读核对。'; return 'unknown';
    } finally { writing = false; if (!context.signal.aborted) refresh(); }
  }
  function build() {
    focusedChange = null; rows.clear(); changesRoot.replaceChildren(); issues.replaceChildren();
    for (const change of entry.candidate.changes) {
      const li = element('li'); li.dataset.testid = 'candidate-' + change.change_id;
      const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.setAttribute('aria-label', '选择建议 ' + change.change_id);
      checkbox.addEventListener('change', () => { if (!allowed()) return; if (checkbox.checked) selected.add(change.change_id); else selected.delete(change.change_id); refresh(); }, { signal: context.signal });
      const objectId = change.kind === 'create' ? change.object.object_id : change.object_id;
      const before = change.kind === 'create' ? null : change.kind === 'set_label' ? entry.fixedDocument?.objects.find(object => object.object_id === objectId) ?? null : entry.objects.get(objectId) ?? null;
      let after: AnnotationObject | null = change.kind === 'create' ? change.object : change.kind === 'set_attributes' && before ? { ...before, attributes: { ...before.attributes, ...change.values } } : null;
      const values = element('dl'), beforeValue = element('dd'), afterValue = element('dd'); values.append(element('dt', '原值'), beforeValue, element('dt', '建议值'), afterValue);
      const comparison = element('div'), attributeDiff = change.kind === 'set_attributes' ? element('dl') : null;
      if (attributeDiff) {
        attributeDiff.dataset.testid = 'candidate-attribute-diff';
        const details = element('details'); details.append(element('summary', '完整对象对照（技术详情）'), values);
        comparison.append(attributeDiff, details);
      } else comparison.append(values);
      const visual = element('div'), focusLocal = action('定位建议局部', 'candidate-local-' + change.change_id, context.signal, () => {
        if (expanded) { focusedChange = focusedChange === change.change_id ? null : change.change_id; renderCombined(); }
        else { localFocus = !localFocus; renderProjection(); }
      }), focusMain = action('定位主画布', 'candidate-focus-' + change.change_id, context.signal, () => { const row = rows.get(change.change_id); refresh(); if (row && !row.focus.disabled && row.bounds && !context.focusRegion(row.bounds)) message.textContent = '当前主画布或建议区域不可用，未改变视图。'; });
      let localFocus = false;
      function renderProjection() {
        beforeValue.textContent = before ? JSON.stringify({ label_id: before.label_id, attributes: before.attributes, geometry: before.geometry }) : '—';
        afterValue.textContent = after ? JSON.stringify({ label_id: after.label_id, attributes: after.attributes, geometry: after.geometry }) : '固定投影不可用';
        if (attributeDiff && change.kind === 'set_attributes') {
          const show = (object: AnnotationObject | null, key: string) => !object ? '固定投影不可用'
            : !Object.hasOwn(object.attributes, key) ? '缺少键' : JSON.stringify(object.attributes[key]) ?? '无法显示';
          attributeDiff.replaceChildren();
          for (const key of Object.keys(change.values)) attributeDiff.append(
            element('dt', key + ' · 原值'), element('dd', show(before, key)),
            element('dt', key + ' · 建议值'), element('dd', show(after, key)),
          );
        }
        if (expanded) visual.replaceChildren();
        else visual.replaceChildren(readonlyVisual(entry.fixedDocument, context.getScope().assetId, before ? [before.geometry] : [], after ? [after.geometry] : [], localFocus));
        focusLocal.textContent = expanded ? focusedChange === change.change_id ? '查看整图对照' : '定位建议局部' : localFocus ? '查看整图对照' : '定位建议局部';
      }
      const rejectButton = action('拒绝此项', 'candidate-reject-' + change.change_id, context.signal, () => void reject([change.change_id]));
      const rejection = element('p'); rejection.setAttribute('role', 'status');
      const row = { checkbox, rejection, reject: rejectButton, focus: focusMain, local: focusLocal, bounds: change.kind === 'create' ? change.object.geometry : before?.geometry ?? null, projectionReady: change.kind !== 'set_label',
        geometry: () => ({ before: before?.geometry ?? null, after: after?.geometry ?? null }), render: renderProjection };
      rows.set(change.change_id, row);
      li.append(labeled(({ create: '新增对象', set_attributes: '修改属性', set_label: '修改类别（仅对照）' }[change.kind]) + ' · ' + objectId, checkbox), rejection, comparison, element('p', change.reason || '未提供理由'), visual, focusLocal, focusMain, rejectButton); changesRoot.append(li); renderProjection();
      if (change.kind === 'set_label' && entry.fixedDocument && entry.fixedOntology && entry.fixedDocument.asset_revision_id === entry.candidate.context.asset_revision_id
        && entry.fixedDocument.ontology_version_id === entry.candidate.context.ontology_version_id && entry.fixedOntology.project_id === entry.candidate.context.project_id
        && entry.candidate.context.object_hashes[change.object_id] === change.before_hash) {
        const fixed = entry;
        void projectRelabel(entry.fixedDocument, entry.fixedOntology, change).then(object => { if (!context.signal.aborted && entry === fixed) { after = object; row.projectionReady = true; renderProjection(); renderCombined(); refresh(); } }).catch(() => { if (!context.signal.aborted && entry === fixed) afterValue.textContent = '固定建议投影失败，仅可对照。'; });
      }
    }
    renderCombined();
    for (const issue of entry.candidate.issues) { const note = element('p', '问题：' + issue.message + ' · ' + issue.code); note.setAttribute('role', 'note'); issues.append(note); }
  }
  build(); refresh(); void read();
  return { element: root, refresh, update(next) { if (next === entry) { refresh(); return; } entry = next; build(); refresh(); },
    setExpanded(value) { if (expanded === value) return; expanded = value; focusedChange = null; combined.hidden = !expanded; for (const row of rows.values()) row.render(); renderCombined(); },
    rejectSelected: () => reject([...selected]), selectedCount: () => rejectable() ? selected.size : 0 };
}
export function mountCandidatesView(root: HTMLElement, context: CandidateViewContext): { update(entries: readonly CandidateEntry[]): void; setExpanded(expanded: boolean): void; dispose(): void } {
  const list = element('div'), message = element('p'); message.setAttribute('role', 'status');
  const cards = new Map<string, CandidateCard>(); let batchBusy = false, showingEmpty = false, expanded = false;
  const batch = action('跨组拒绝所选（独立请求）', 'reject-cross-groups', context.signal, () => {
    if (batchBusy || !context.getScope().current) return;
    batchBusy = true; batch.disabled = true;
    void Promise.all([...cards.values()].filter(card => card.selectedCount()).map(card => card.rejectSelected())).then(results => {
      if (!context.signal.aborted) {
        showingEmpty = false;
        message.textContent = '独立请求，非原子操作：' + results.filter(value => value === 'success').length + ' 组成功，' + results.filter(value => value === 'failed').length + ' 组明确失败，' + results.filter(value => value === 'unknown').length + ' 组结果未知。';
      }
    }).finally(() => { batchBusy = false; refreshBatch(); });
  });
  function refreshBatch() { batch.disabled = batchBusy || !context.getScope().current || ![...cards.values()].some(card => card.selectedCount()); }
  root.append(list, batch, message);
  return { update(entries) {
    const present = new Set(entries.map(entry => entry.key));
    for (const [key, card] of cards) if (!present.has(key)) { card.element.remove(); cards.delete(key); }
    for (const entry of entries) { let card = cards.get(entry.key); if (!card) { card = createCandidateCard(entry, context, refreshBatch); card.setExpanded(expanded); cards.set(entry.key, card); list.append(card.element); } else card.update(entry); }
    if (!entries.length) { message.textContent = '暂无建议。人工标注仍可继续。'; showingEmpty = true; }
    else if (showingEmpty) { message.textContent = ''; showingEmpty = false; }
    batch.hidden = entries.length < 2; refreshBatch();
  }, setExpanded(value) { expanded = value; for (const card of cards.values()) card.setExpanded(value); }, dispose() { cards.clear(); } };
}
