import type { ActivityKind } from '../../../../../packages/contracts/generated/ActivityKind';
import type { ActivitySession } from '../../../../../packages/contracts/generated/ActivitySession';
import type { RunScope } from '../ai/run-controller';
import { api } from '../../lib/t15/api';
import { downloadText } from './draft-recovery';
import { reportError, sessionCurrent, type WorkspaceState } from './workspace-state';
import { action, element, labeled, option } from './view-elements';

const LABELS: Record<ActivityKind, string> = { task: '任务准备', annotation: '标注', correction: '修正', review: '审核', switch: '切换图片', model_wait: '模型等待（非人工）' };
export function mountActivityView(root: HTMLElement, surface: HTMLElement, state: WorkspaceState, getRunScope: () => RunScope | null, signal: AbortSignal): () => void {
  root.dataset.testid = 'activity-panel'; root.setAttribute('aria-label', '自愿本地工时统计');
  const enabled = element('input'); enabled.type = 'checkbox'; enabled.dataset.testid = 'activity-opt-in';
  const kind = element('select'); kind.dataset.testid = 'activity-kind'; for (const [value, text] of Object.entries(LABELS)) kind.append(option(value, text));
  const task = element('input'); task.type = 'checkbox'; task.dataset.testid = 'activity-task-binding';
  const run = element('select'); run.dataset.testid = 'activity-run-binding';
  const totalsRoot = element('dl'); totalsRoot.dataset.testid = 'activity-totals'; const duration = new Map<ActivityKind, HTMLElement>();
  for (const [value, text] of Object.entries(LABELS)) { const dd = element('dd', '未记录'); dd.dataset.testid = 'activity-duration-' + value; duration.set(value as ActivityKind, dd); totalsRoot.append(element('dt', text), dd); }
  const human = element('p'); human.dataset.testid = 'activity-human-total'; const message = element('p'); message.setAttribute('role', 'status');
  const error = element('p'); error.setAttribute('role', 'alert'); let publishing = false, bindingScope = '', updating = false;
  const eligibleRun = () => { const scope = getRunScope(), loaded = state.loaded; return scope && loaded && scope.projectId === state.projectId && scope.assetRevisionId === state.assetId && scope.ontologyVersionId === loaded.ontology.ontology_version_id ? scope : null; };
  function guardBinding() {
    const scope = JSON.stringify([state.assetId, state.loaded?.ontology.ontology_version_id, state.fixedTask?.task_id, getRunScope()]);
    if (scope !== bindingScope) { bindingScope = scope; state.activity.setBinding({}); }
  }
  function perform(callback: () => void) {
    if (!sessionCurrent(state)) return;
    try { guardBinding(); callback(); error.textContent = ''; } catch (reason) { error.textContent = reportError(reason); }
    update();
  }
  const publish = action('保存到项目服务器', 'activity-publish', signal, () => {
    if (publishing || !sessionCurrent(state)) return;
    const session = state.session, epoch = state.authorizationEpoch;
    const current = () => sessionCurrent(state) && state.session === session && state.authorizationEpoch === epoch;
    publishing = true; update();
    void (async () => {
      guardBinding(); state.activity.commit();
      if (state.activity.problem) throw new Error(state.activity.problem);
      const sessions = state.activity.snapshot();
      if (!sessions.some(item => item.intervals.length)) { message.textContent = '暂无工时记录，未上传。'; return; }
      for (const item of sessions) {
        if (!item.intervals.length || !current()) continue;
        const response = await api.request<ActivitySession>('/api/projects/' + encodeURIComponent(state.projectId) + '/activity-sessions/' + encodeURIComponent(item.session_id), { method: 'PUT', body: JSON.stringify({ expected_version: item.version, intervals: item.intervals }) });
        if (!current()) return;
        if (response.session_id !== item.session_id || !Number.isSafeInteger(response.version) || response.version < item.version) throw new Error('工时回执不匹配；原始区间保留。');
        state.activity.acknowledge(item.session_id, response.version);
      }
      if (current()) message.textContent = '本人工时已保存到项目服务器。';
    })().catch(reason => { if (current()) error.textContent = reportError(reason); }).finally(() => { publishing = false; if (!signal.aborted) update(); });
  });
  const download = action('下载本地工时记录（JSON）', 'activity-download', signal, () => perform(() => {
    state.activity.commit(); downloadText(JSON.stringify({ schema_version: 1, evidence_kind: 'local_voluntary_intervals_not_a_pilot', project_id: state.projectId, actor_id: state.session?.user_id, sessions: state.activity.snapshot(), fees_usd: null }, null, 2), 'local-activity.json');
  }));
  const raw = action('下载原始本地记录', 'activity-rescue-journal', signal, () => { if (state.activity.recoveryJournal) downloadText(state.activity.recoveryJournal, 'activity-journal-recovery.json'); });
  const clear = action('清除本地记录并关闭', 'activity-clear', signal, () => perform(() => { state.activity.clear(); message.textContent = '本地记录已清除；服务器记录未改变。'; }));
  root.append(element('h2', '自愿工时与运行摘要'), labeled('开启本项目工时统计（默认关闭）', enabled), element('p', '仅记录本项目区间分类和时长；不记录输入内容或按键，不自动上传。失焦及空闲超过 60 秒不计人工工时。费用未知，不填零。'),
    labeled('当前工时分类', kind), labeled('自愿关联当前任务的后续工时', task), labeled('自愿关联运行', run), element('p', '仅对后续新区间生效；切换图片、规范、任务或运行会关闭关联。不改写历史，不推断因果归属。'), totalsRoot, human, download, publish, raw, clear, message, error);
  function update() {
    if (updating || signal.aborted) return; updating = true;
    try {
      guardBinding(); const collector = state.activity, binding = collector.getBinding(), scope = eligibleRun(), sessions = collector.snapshot(), totals = collector.totals();
      enabled.checked = collector.isEnabled(); enabled.disabled = !sessionCurrent(state) || !!collector.problem;
      kind.value = collector.getKind(); kind.disabled = !collector.isEnabled();
      task.checked = !!state.fixedTask && binding.task_id === state.fixedTask.task_id; task.disabled = !collector.isEnabled() || !state.fixedTask;
      if (run.dataset.runId !== (scope?.runId ?? '')) { run.replaceChildren(option('', '不关联运行')); if (scope) run.append(option(scope.runId, '当前已启动运行 ' + scope.runId)); run.dataset.runId = scope?.runId ?? ''; }
      run.value = scope && binding.run_id === scope.runId ? scope.runId : ''; run.disabled = !collector.isEnabled() || !scope;
      for (const [value, dd] of duration) dd.textContent = sessions.some(item => item.intervals.some(interval => interval.kind === value)) ? (totals[value] / 1000).toFixed(3) + ' 秒' : '未记录';
      const humanTotal = totals.task + totals.annotation + totals.correction + totals.review + totals.switch;
      human.textContent = '本人人工工时：' + (humanTotal ? (humanTotal / 1000).toFixed(3) + ' 秒' : '未记录（未知，不填零）') + '。模型等待不是人工工时，采纳数不是准确率。';
      publish.disabled = publishing || !sessionCurrent(state) || !!collector.problem || !sessions.some(item => item.intervals.length); clear.disabled = publishing;
      raw.hidden = !collector.problem || !collector.recoveryJournal;
      if (collector.problem) error.textContent = collector.problem + '；主标注流程不受影响。';
    } finally { updating = false; }
  }
  enabled.addEventListener('change', () => perform(() => state.activity.setEnabled(enabled.checked)), { signal });
  kind.addEventListener('change', () => perform(() => state.activity.interact(kind.value as ActivityKind)), { signal });
  task.addEventListener('change', () => perform(() => { const binding = state.activity.getBinding(); if (task.checked && state.fixedTask) binding.task_id = state.fixedTask.task_id; else delete binding.task_id; state.activity.setBinding(binding); }), { signal });
  run.addEventListener('change', () => perform(() => { const binding = state.activity.getBinding(), current = eligibleRun(); if (current && run.value === current.runId) binding.run_id = current.runId; else delete binding.run_id; state.activity.setBinding(binding); }), { signal });
  const focus = () => { if (sessionCurrent(state)) state.activity.setFocused(document.hasFocus() && document.visibilityState !== 'hidden'); };
  window.addEventListener('focus', focus, { signal }); window.addEventListener('blur', () => state.activity.setFocused(false), { signal }); document.addEventListener('visibilitychange', focus, { signal }); window.addEventListener('pagehide', () => state.activity.setFocused(false), { signal });
  for (const event of ['pointerdown', 'input', 'keydown']) surface.addEventListener(event, () => { if (sessionCurrent(state)) { guardBinding(); state.activity.interact(); } }, { signal, passive: true });
  const timer = window.setInterval(() => { if (sessionCurrent(state)) { guardBinding(); state.activity.commit(); } }, 15_000);
  const unsubscribe = state.subscribe(update), unsubscribeActivity = state.activity.subscribe(update);
  function dispose() { clearInterval(timer); unsubscribe(); unsubscribeActivity(); state.activity.setEnabled(false); }
  signal.addEventListener('abort', dispose, { once: true }); focus(); update(); return dispose;
}
