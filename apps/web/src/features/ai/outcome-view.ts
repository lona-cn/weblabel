import type { RunOutcomeSummary } from './outcome-summary';
import { api } from '../../lib/t15/api';
import { action, element } from '../workbench/view-elements';
export interface OutcomeViewContext { signal: AbortSignal; isCurrent(): boolean; navigate(url: URL): void }
export function mountOutcomeView(root: HTMLElement, context: OutcomeViewContext): { update(runId: string | null, refreshKey: string): void; refresh(): Promise<void>; dispose(): void } {
  const title = element('h3', '运行结果 · 决策记录'), body = element('div'), message = element('p'); message.setAttribute('role', 'status');
  root.append(title, element('p', '采纳数量不是准确率；对象后续变化归因未知，不代表人工修正或 ROI。'), body, message);
  let runId: string | null = null, key = '', read: AbortController | null = null;
  const refresh = async () => {
    if (!runId || !context.isCurrent()) return;
    read?.abort(); const controller = new AbortController(); read = controller;
    const fixed = runId; message.textContent = '正在读取真实运行记录…';
    try {
      const value = await api.request<RunOutcomeSummary>('/api/ai/runs/' + encodeURIComponent(fixed) + '/outcome-summary', { signal: controller.signal });
      if (controller.signal.aborted || context.signal.aborted || !context.isCurrent() || runId !== fixed || value.run.run_id !== fixed) return;
      body.replaceChildren();
      const dl = element('dl');
      for (const [label, text] of [['候选 change 数', value.candidate_change_count], ['当前有效采纳', value.accepted_change_count], ['接受 journal / 撤销 journal', value.accept_journal_count + ' / ' + value.revert_journal_count], ['实际拒绝', value.rejected_change_count],
        ['本人明确关联运行的工时', value.recorded_work_seconds === null ? '未知；没有明确关联的自愿区间，不能填零。' : value.recorded_work_seconds + ' 秒'],
        ['费用', value.cost_display === 'recorded' ? '服务端已记录，详见实际 usage。' : value.cost_display === 'none' ? '服务端标记不计费，不推算金额。' : '费用未知，不填零。'], ['工时依据', value.work_time_reason]]) dl.append(element('dt', String(label)), element('dd', String(text)));
      const usage = element('details'); usage.append(element('summary', '实际 usage 与费用记录'), element('pre', value.usage === null ? '未记录 usage。' : JSON.stringify(value.usage, null, 2)));
      body.append(dl, usage, element('h4', '精确决策版本对应的任务提交与审核'));
      if (!value.task_binding?.submissions.length) body.append(element('p', '没有精确版本匹配的任务提交，审核状态未知。'));
      for (const binding of value.task_binding?.submissions ?? []) {
        const link = element('a', '查看固定版本 ' + binding.annotation_revision_id), url = new URL(location.href);
        for (const [name, text] of Object.entries({ project_id: value.run.project_id, asset_revision_id: binding.asset_revision_id, ontology_version_id: binding.ontology_version_id, annotation_revision_id: binding.annotation_revision_id })) url.searchParams.set(name, text);
        link.href = url.href; link.addEventListener('click', event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); context.navigate(url); } }, { signal: context.signal });
        body.append(element('p', '任务 ' + binding.task_id + ' · 审核 ' + binding.review_id + ' · ' + binding.review_state + ' · ' + binding.decision_kinds.join('/')), link);
      }
      if (value.task_binding?.truncated) body.append(element('p', '匹配结果已截断，并非完整任务历史。'));
      const observations = element('details'); observations.append(element('summary', '采纳后的对象观察（归因未知）'));
      for (const observation of value.object_observations) observations.append(element('p', observation.object_id + ' · ' + observation.current_status + ' · 固定接受版本 ' + observation.accepted_revision_id));
      for (const binding of value.activity_task_bindings) observations.append(element('p', '本人明确关联任务 ' + binding.task_id + ' 与此运行的自愿区间：' + binding.recorded_work_seconds + ' 秒'));
      body.append(observations); message.textContent = '';
    } catch { if (!controller.signal.aborted && !context.signal.aborted) message.textContent = '摘要读取失败；只读重查，不重跑模型。'; }
  };
  root.append(action('只读重新检查结果摘要', 'outcome-refresh', context.signal, () => void refresh()));
  const dispose = () => read?.abort(); context.signal.addEventListener('abort', dispose, { once: true });
  return { refresh, dispose, update(next, nextKey) {
    root.hidden = !next;
    if (next === runId && key === nextKey) return;
    if (next !== runId) { read?.abort(); body.replaceChildren(); message.textContent = ''; }
    runId = next; key = nextKey; void refresh();
  } };
}
