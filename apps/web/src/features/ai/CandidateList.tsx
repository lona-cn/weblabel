import type { BBox } from '../../../../../packages/contracts/generated/BBox';
import { useEffect, useRef, useState } from 'react';
import { canAcceptSuggestion, type CandidateEntry } from './useRun';
import { DiffView } from './DiffView';
import { checkedRejectionState, knownRejectionFailure, rejectionApi, type RejectionPayload } from './rejections';

type Props = {
  entries: readonly CandidateEntry[]; activeAsset: string; activeContext: CandidateEntry['candidate']['context'];
  activeGeneration?: number; busy: boolean;
  onAccept: (entry: CandidateEntry, changeIds: string[], rejectedIds: readonly string[]) => void;
  decisionApi?: typeof rejectionApi;
  onDecisionRecorded?: () => void;
  onFocusRegion?: (bounds: BBox) => boolean;
};
export function CandidateList(props: Props) {
  const [batch, setBatch] = useState<Record<string, string[]>>({});
  const [batchNotice, setBatchNotice] = useState<string | null>(null);
  const cards = useRef<Record<string, () => Promise<'success' | 'failed' | 'unknown'>>>({});
  const running = useRef(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const rejectBatch = async () => {
    if (running.current) return;
    running.current = true; setBatchBusy(true);
    const outcomes = await Promise.all(props.entries.filter(entry => (batch[entry.key]?.length ?? 0) > 0).map(entry => cards.current[entry.key]?.() ?? Promise.resolve('failed' as const)));
    const success = outcomes.filter(outcome => outcome === 'success').length;
    setBatchNotice(`跨组拒绝为独立请求，非原子操作：${success} 组成功，${outcomes.filter(outcome => outcome === 'failed').length} 组明确失败，${outcomes.filter(outcome => outcome === 'unknown').length} 组结果未知。未知组仅可只读核对。`);
    running.current = false; setBatchBusy(false);
  };
  return <section aria-label="AI 建议与问题">
    {!props.entries.length ? <p role="status">暂无建议。</p> : null}
    {props.entries.map(entry => <CandidateCard key={entry.key} {...props} busy={props.busy || batchBusy} entry={entry} selected={batch[entry.key] ?? []} onSelection={ids => setBatch(current => ({ ...current, [entry.key]: ids }))} register={action => { if (action) cards.current[entry.key] = action; else delete cards.current[entry.key]; }} />)}
    {props.entries.length > 1 ? <button type="button" disabled={props.busy || batchBusy || !Object.values(batch).some(ids => ids.length > 0)} onClick={() => void rejectBatch()}>跨组拒绝所选（独立请求）</button> : null}
    {batchNotice ? <p role="status">{batchNotice}</p> : null}
  </section>;
}
function CandidateCard({ entry, selected, onSelection, register, decisionApi = rejectionApi, ...props }: Props & {
  entry: CandidateEntry; selected: string[]; onSelection: (ids: string[]) => void;
  register: (action: (() => Promise<'success' | 'failed' | 'unknown'>) | null) => void;
}) {
  const candidate = entry.candidate;
  const [rejected, setRejected] = useState<string[] | null>(null);
  const [pending, setPending] = useState<RejectionPayload | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const gate = useRef(false);
  const scope = useRef(candidate.suggestion_set_id);
  scope.current = candidate.suggestion_set_id;
  const knownIds = candidate.changes.map(change => change.change_id);
  const read = async (signal?: AbortSignal) => {
    try {
      const result = checkedRejectionState(await decisionApi.read(candidate.suggestion_set_id, pending?.operation_id, signal), candidate.suggestion_set_id, knownIds);
      if (signal?.aborted || scope.current !== result.suggestion_set_id) return;
      setRejected(result.rejected_change_ids);
      if (selected.some(id => result.rejected_change_ids.includes(id))) onSelection(selected.filter(id => !result.rejected_change_ids.includes(id)));
      if (pending) {
        const receipt = result.operations.find(operation => operation.operation_id === pending.operation_id);
        if (receipt && JSON.stringify(receipt.change_ids) === JSON.stringify(pending.change_ids)) { setPending(null); setMessage('已只读核实拒绝成功。'); props.onDecisionRecorded?.(); }
        else setMessage('未找到匹配的原 operation 收据，结果仍未知；不要重复写入，稍后只读核对。');
      }
    } catch { if (!signal?.aborted) { setRejected(null); setMessage('拒绝状态读取失败，不能采纳；请只读重新检查。'); } }
  };
  useEffect(() => {
    const controller = new AbortController(); setRejected(null);
    void read(controller.signal);
    return () => controller.abort();
  }, [candidate.suggestion_set_id, decisionApi]);
  const eligible = canAcceptSuggestion({ active_asset: props.activeAsset, candidate_asset: entry.asset_revision_id, active_context: props.activeContext, run_context: entry.run_context, active_generation: props.activeGeneration ?? props.activeContext.draft_generation, candidate, busy: false, schema_error: entry.schema_error });
  const focusAllowed = entry.schema_error === null && entry.asset_revision_id === props.activeAsset
    && [entry.run_context, candidate.context].every(context =>
      context.project_id === props.activeContext.project_id
      && context.asset_revision_id === props.activeContext.asset_revision_id
      && context.ontology_version_id === props.activeContext.ontology_version_id
      && context.canonical_sha256 === props.activeContext.canonical_sha256)
    && entry.fixedDocument?.asset_revision_id === props.activeAsset
    && entry.fixedDocument.ontology_version_id === props.activeContext.ontology_version_id
    && entry.fixedOntology?.project_id === props.activeContext.project_id
    && entry.fixedOntology.ontology_version_id === props.activeContext.ontology_version_id;
  const acceptAllowed = eligible && !props.busy && !writing && pending === null && rejected !== null;
  const selectedIds = selected.filter(id => !rejected?.includes(id));
  const reject = async (ids: string[]): Promise<'success' | 'failed' | 'unknown'> => {
    if (gate.current || pending || props.busy || !rejected || !ids.length || entry.schema_error || props.activeAsset !== entry.asset_revision_id) return 'failed';
    gate.current = true; setWriting(true); setMessage(null);
    const payload = { operation_id: crypto.randomUUID(), change_ids: ids };
    try {
      const receipt = await decisionApi.reject(candidate.suggestion_set_id, payload);
      if (receipt.suggestion_set_id !== candidate.suggestion_set_id || receipt.operation_id !== payload.operation_id || JSON.stringify(receipt.change_ids) !== JSON.stringify(ids)) throw new Error('receipt mismatch');
      setRejected(current => Array.from(new Set([...(current ?? []), ...ids]))); onSelection([]); setMessage('拒绝已保存到服务器。');
      props.onDecisionRecorded?.();
      return 'success';
    } catch (cause) {
      if (knownRejectionFailure(cause)) { setMessage('服务器明确拒绝此操作。已采纳项必须先通过保存事务撤销；权限或版本不符时不能拒绝。'); return 'failed'; }
      setPending(payload); setMessage('拒绝结果未知，保留原 operation 与选择；不要重复拒绝，仅只读核对。'); return 'unknown';
    } finally { gate.current = false; setWriting(false); }
  };
  useEffect(() => { register(() => reject(selectedIds)); return () => register(null); });
  return <article aria-label={`建议 ${candidate.suggestion_set_id}`}>
    {entry.asset_revision_id !== props.activeAsset ? <p role="status">这是另一张图片的结果，只能对照，不能在此采纳。</p> : null}
    {candidate.state === 'stale' || (entry.asset_revision_id === props.activeAsset && !eligible && ['pending', 'partially_accepted'].includes(candidate.state) && !candidate.changes.some(change => change.kind === 'set_label') && !entry.schema_error) ? <p role="status">图片或标注版本已变化，此结果只能对照。请重新运行后再采纳。</p> : null}
    {candidate.state === 'rejected' ? <p role="status">此集合已整体拒绝（服务器集合状态）；不是新增的逐项拒绝收据，不能采纳。</p> : null}
    {candidate.changes.some(change => change.kind === 'set_label') ? <p role="status">当前运行不授权修改类别；改类投影仅供对照，不能采纳。</p> : null}
    {entry.schema_error ? <div role="alert"><p>建议格式或范围不符合当前标注，不能采纳。</p><details><summary>错误详情</summary>{entry.schema_error}</details></div> : null}
    {message ? <p role="status">{message}</p> : null}
    {pending ? <button type="button" disabled={writing} onClick={() => void read()}>只读核对拒绝</button> : rejected === null ? <button type="button" onClick={() => void read()}>只读重新检查拒绝状态</button> : null}
    <ul>{candidate.changes.map(change => <DiffView key={change.change_id} change={change} objects={entry.objects} fixedDocument={entry.fixedDocument} fixedOntology={entry.fixedOntology} set={candidate} activeAsset={props.activeAsset} selected={selectedIds.includes(change.change_id)} disabled={!acceptAllowed || rejected?.includes(change.change_id) === true} rejected={rejected?.includes(change.change_id) === true} rejectDisabled={props.busy || writing || pending !== null || rejected === null || entry.schema_error !== null || entry.asset_revision_id !== props.activeAsset || rejected.includes(change.change_id)} onReject={() => void reject([change.change_id])} onToggle={(id, checked) => onSelection(checked ? [...selectedIds, id] : selectedIds.filter(value => value !== id))} />)}</ul>
    {props.onFocusRegion ? <div aria-label="主画布只读定位">{candidate.changes.map(change => {
      const bounds = change.kind === 'create' ? change.object.geometry
        : entry.objects.get(change.object_id)?.geometry ?? entry.fixedDocument?.objects.find(object => object.object_id === change.object_id)?.geometry;
      return <button key={change.change_id} type="button" aria-label={'定位主画布 ' + change.change_id} disabled={!focusAllowed || !bounds}
        onClick={() => { if (focusAllowed && bounds && !props.onFocusRegion?.(bounds)) setMessage('当前主画布或建议区域不可用，未改变视图。'); }}>定位主画布</button>;
    })}</div> : null}
    {candidate.issues.map(issue => <div key={issue.issue_id} role="note">问题：{issue.message}<details><summary>问题代码</summary>{issue.code}</details></div>)}
    <p>{candidate.score === null ? '未提供评分' : `模型评分：${candidate.score}（不代表正确率）`}</p>
    <button type="button" data-testid="accept-selected" disabled={!acceptAllowed || !selectedIds.length} onClick={() => props.onAccept(entry, selectedIds, rejected!)}>采纳所选建议</button>
    <button type="button" disabled={props.busy || writing || pending !== null || rejected === null || !selectedIds.length} onClick={() => void reject(selectedIds)}>拒绝所选建议</button>
    <button type="button" disabled={props.busy || writing || pending !== null || rejected === null || entry.schema_error !== null || entry.asset_revision_id !== props.activeAsset || candidate.changes.every(change => rejected.includes(change.change_id))} onClick={() => void reject(candidate.changes.filter(change => !rejected?.includes(change.change_id)).map(change => change.change_id))}>拒绝本组未拒绝建议</button>
  </article>;
}
