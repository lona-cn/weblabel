import { useEffect, useState } from 'react';
import { api } from '../../lib/t15/api';
export interface RunOutcomeSummary {
  run: { run_id: string; project_id: string; state: string; cost_display: string };
  candidate_change_count: number; accepted_change_count: number; accept_journal_count: number;
  revert_journal_count: number; rejected_change_count: number;
  object_observations: { suggestion_set_id: string; change_id: string; object_id: string; accepted_revision_id: string; current_status: string; attribution: 'unknown' }[];
  task_binding: null | { basis: 'exact_decision_revision_submission'; submissions: { task_id: string; review_id: string; annotation_revision_id: string; asset_revision_id: string; ontology_version_id: string; task_state: string; review_state: string; decision_kinds: ('accept' | 'revert')[]; suggestion_set_ids: string[] }[]; truncated: boolean };
  activity_task_bindings: { task_id: string; recorded_work_seconds: number; basis: 'explicit_voluntary_run_task_interval' }[];
  recorded_work_seconds: number | null; work_time_scope: 'current_actor_explicit_run_intervals'; work_time_reason: string; usage: unknown; cost_display: string;
}
const seconds = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 });
const STATUS: Record<string, string> = { unchanged_since_acceptance: '采纳后至当前版本未改变', changed_since_acceptance: '采纳后当前对象已有变化（归因未知）', absent_from_current_head: '当前版本已无此对象（归因未知）', unknown: '无法核实当前对象状态' };
export function OutcomeSummary({ runId, refreshKey = '', request = api.request }: { runId: string; refreshKey?: string; request?: typeof api.request }) {
  const [result, setResult] = useState<{ runId: string; value: RunOutcomeSummary } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(null);
    request<RunOutcomeSummary>(`/api/ai/runs/${encodeURIComponent(runId)}/outcome-summary`, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted && value.run.run_id === runId) setResult({ runId, value });
    }).catch(() => { if (!controller.signal.aborted) setError('运行结果摘要读取失败。只读重新检查，不重跑模型。'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [runId, refreshKey, request, nonce]);
  const summary = result?.runId === runId ? result.value : null;
  return <section aria-label="本次运行结果摘要">
    <h3>运行结果 · 决策记录</h3>
    <p>运行 {runId}。采纳数量不是准确率；后续对象变化不是人工修正归因，也不代表 ROI。</p>
    {error ? <p role="alert">{error}</p> : null}
    {summary ? <>
      <dl><dt>候选 change 数</dt><dd>{summary.candidate_change_count}</dd><dt>当前有效采纳</dt><dd>{summary.accepted_change_count}</dd><dt>接受 journal / 撤销 journal</dt><dd>{summary.accept_journal_count} / {summary.revert_journal_count}</dd><dt>实际拒绝</dt><dd>{summary.rejected_change_count}</dd><dt>本人自愿关联此运行的工时</dt><dd>{summary.recorded_work_seconds === null ? '未知：没有可归属于此 run 的工时记录，不能填零。' : seconds.format(summary.recorded_work_seconds) + ' 秒'}</dd><dt>工时范围与依据</dt><dd>仅当前用户明确关联运行的自愿区间；不是模型执行时长、因果归属或 ROI。{summary.work_time_reason}</dd><dt>费用状态</dt><dd>{summary.cost_display === 'recorded' ? '服务端已记录费用，详见原始 usage。' : summary.cost_display === 'none' ? '服务端标记不计费，不推算金额。' : '费用未知，不填零。'}</dd></dl>
      {summary.activity_task_bindings.length ? <ul aria-label="自愿运行任务工时">{summary.activity_task_bindings.map(item => <li key={item.task_id}>任务 {item.task_id} · 本人明确关联运行与任务的自愿区间 {seconds.format(item.recorded_work_seconds)} 秒</li>)}</ul> : null}
      <details><summary>实际 usage 与费用记录</summary>{summary.usage === null ? <p>未记录 usage。</p> : <pre>{JSON.stringify(summary.usage, null, 2)}</pre>}</details>
      <details><summary>采纳后的对象观察</summary><ul>{summary.object_observations.map(item => <li key={item.suggestion_set_id + ':' + item.change_id}>{item.object_id} · {STATUS[item.current_status] ?? '未知'}<details><summary>版本来源</summary>{item.accepted_revision_id} · {item.change_id}</details></li>)}</ul></details>
      <h4>精确决策版本对应的任务提交与审核</h4><p>仅匹配此运行接受或撤销决策所保存的同一 revision；同图任务不构成绑定，也不代表运行因果归属。</p>
      {!summary.task_binding?.submissions.length ? <p>没有精确版本匹配的任务提交，审核状态未知。</p> : <ul>{summary.task_binding.submissions.map(item => <li key={item.task_id + ':' + item.review_id + ':' + item.annotation_revision_id}>任务 {item.task_id} · {item.task_state} · 匹配审核 {item.review_id} · {item.review_state} · 决策 {item.decision_kinds.join(' / ')}<p>建议集合：{item.suggestion_set_ids.join('、')}</p><a href={'/?project_id=' + encodeURIComponent(summary.run.project_id) + '&asset_revision_id=' + encodeURIComponent(item.asset_revision_id) + '&ontology_version_id=' + encodeURIComponent(item.ontology_version_id) + '&annotation_revision_id=' + encodeURIComponent(item.annotation_revision_id)}>查看匹配的保存版本 {item.annotation_revision_id}</a>{' · '}<a href={'/?project_id=' + encodeURIComponent(summary.run.project_id) + '&review_queue=all'}>打开项目审核队列（按上述审核 ID 核对）</a></li>)}</ul>}
      {summary.task_binding?.truncated ? <p>精确版本匹配结果已截断，并非完整任务历史。</p> : null}
    </> : <p role="status">{loading ? '正在读取真实运行记录…' : '尚未取得摘要。'}</p>}
    <button type="button" disabled={loading} onClick={() => setNonce(value => value + 1)}>只读重新检查结果摘要</button>
  </section>;
}
