import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { RefObject } from 'react';
import type { ActivityKind } from '../../../../../packages/contracts/generated/ActivityKind';
import type { ActivityCheckpoint } from '../../../../../packages/contracts/generated/ActivityCheckpoint';
import type { ActivitySession } from '../../../../../packages/contracts/generated/ActivitySession';
import { api, saveAuthorizationEpoch, subscribeSaveAuthorization } from '../../lib/t15/api';
import { ActivityCollector } from './activity';

export type ActivityPanelProps = { projectId: string; actorId: string; collector: ActivityCollector; surfaceRef?: RefObject<HTMLElement | null>; verifiedAuthorizationEpoch?: number; context?: { assetRevisionId: string; ontologyVersionId: string; taskId: string | null }; currentRun?: { runId: string; projectId: string; assetRevisionId: string; ontologyVersionId: string } | null };
const LABELS: Record<ActivityKind, string> = { task: '任务准备', annotation: '标注', correction: '修正', review: '审核', switch: '切换图片', model_wait: '模型等待（非人工）' };
const buttonStyle = { padding: '7px 12px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-surface)', fontSize: 12 };

export function ActivityPanel({ projectId, actorId, collector, surfaceRef, context, currentRun, verifiedAuthorizationEpoch }: ActivityPanelProps) {
  useSyncExternalStore(collector.subscribe, collector.getRevision, collector.getRevision);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  const liveAuthorizationEpoch = useSyncExternalStore(subscribeSaveAuthorization, saveAuthorizationEpoch, saveAuthorizationEpoch);
  const mountAuthorizationEpoch = useRef(saveAuthorizationEpoch());
  const authorizationEpoch = verifiedAuthorizationEpoch ?? mountAuthorizationEpoch.current;
  const publishOwner = useRef<object | null>(null);
  const publishFlight = useRef<object | null>(null);
  const publishIdentity = useRef({ projectId, actorId, collector });
  publishIdentity.current = { projectId, actorId, collector };
  useLayoutEffect(() => {
    const owner = {};
    publishOwner.current = owner;
    setPublishing(false); setError(null); setMessage(null);
    return () => {
      if (publishOwner.current === owner) { publishOwner.current = null; publishFlight.current = null; }
    };
  }, [projectId, actorId, collector, authorizationEpoch, liveAuthorizationEpoch]);
  const scopeKey = JSON.stringify([projectId, actorId, context?.assetRevisionId, context?.ontologyVersionId, context?.taskId, currentRun?.runId, currentRun?.projectId, currentRun?.assetRevisionId, currentRun?.ontologyVersionId]);
  const scopeMatchesCollector = collector.projectId === projectId && collector.actorId === actorId;
  const eligibleRun = scopeMatchesCollector && context && currentRun && currentRun.projectId === projectId && currentRun.assetRevisionId === context.assetRevisionId && currentRun.ontologyVersionId === context.ontologyVersionId ? currentRun : null;
  const latestScope = useRef(scopeKey); latestScope.current = scopeKey;
  const appliedScope = useRef<{ key: string; collector: ActivityCollector } | null>(null);
  const guardScope = () => {
    if (appliedScope.current?.key === latestScope.current && appliedScope.current.collector === collector) return;
    collector.commit(); collector.setBinding({});
    if (!scopeMatchesCollector) collector.setEnabled(false);
    appliedScope.current = { key: latestScope.current, collector };
  };
  useLayoutEffect(() => { guardScope(); }, [collector, scopeKey]);
  const enabled = collector.isEnabled();
  const totals = collector.totals();
  const run = (action: () => void) => {
    try { guardScope(); action(); setError(null); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  useEffect(() => {
    const surface = surfaceRef?.current ?? panel?.parentElement;
    const safely = (action: () => void) => { try { guardScope(); action(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } };
    const focus = () => safely(() => collector.setFocused(document.hasFocus() && document.visibilityState !== 'hidden'));
    const blur = () => safely(() => collector.setFocused(false));
    const interact = () => safely(() => collector.interact());
    const checkpoint = () => safely(() => collector.commit());
    focus();
    window.addEventListener('focus', focus);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', focus);
    window.addEventListener('pagehide', blur);
    surface?.addEventListener('pointerdown', interact, { passive: true });
    surface?.addEventListener('input', interact, { passive: true });
    surface?.addEventListener('keydown', interact, { passive: true });
    const timer = setInterval(checkpoint, 15_000);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', focus);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', focus);
      window.removeEventListener('pagehide', blur);
      surface?.removeEventListener('pointerdown', interact);
      surface?.removeEventListener('input', interact);
      surface?.removeEventListener('keydown', interact);
      safely(() => collector.setEnabled(false));
    };
  }, [collector, panel, surfaceRef]);

  async function publish() {
    const owner = publishOwner.current;
    const epoch = authorizationEpoch;
    const flight = {};
    const current = () => owner !== null && publishOwner.current === owner &&
      publishIdentity.current.projectId === projectId && publishIdentity.current.actorId === actorId &&
      publishIdentity.current.collector === collector && saveAuthorizationEpoch() === epoch;
    if (publishFlight.current || !current()) return;
    publishFlight.current = flight;
    setPublishing(true); setError(null); setMessage(null);
    try {
      guardScope();
      if (collector.projectId !== projectId || collector.actorId !== actorId) throw new Error('工时项目或用户范围不匹配，未上传。');
      if (collector.problem) throw new Error(collector.problem);
      collector.commit();
      if (collector.problem) throw new Error(collector.problem);
      const sessions = collector.snapshot();
      if (!sessions.some((session) => session.intervals.length)) { setMessage('暂无工时记录，未上传。'); return; }
      for (const session of sessions) {
        if (!session.intervals.length) continue;
        const body: ActivityCheckpoint = { expected_version: session.version, intervals: session.intervals };
        if (!current()) return;
        const response = await api.request<ActivitySession>(`/api/projects/${encodeURIComponent(projectId)}/activity-sessions/${encodeURIComponent(session.session_id)}`, { method: 'PUT', body: JSON.stringify(body) });
        if (!current()) return;
        collector.acknowledge(session.session_id, response.version);
        if (collector.problem) throw new Error(collector.problem);
      }
      if (current()) setMessage('本人工时已保存到项目服务器。');
    } catch (reason) { if (current()) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally {
      if (publishFlight.current === flight) {
        publishFlight.current = null;
        if (current()) setPublishing(false);
      }
    }
  }
  function download() {
    run(() => {
      collector.commit();
      const blob = new Blob([JSON.stringify({ schema_version: 1, evidence_kind: 'local_voluntary_intervals_not_a_pilot', project_id: projectId, actor_id: actorId, sessions: collector.snapshot(), fees_usd: null }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'local-activity.json'; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    });
  }
  return <section ref={setPanel} className="external-policy" style={{ display: 'block' }} aria-label="自愿本地工时统计" data-testid="activity-panel">
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
      <h2>工时记录</h2>
      <label className="external-policy-toggle"><input type="checkbox" data-testid="activity-opt-in" checked={enabled} disabled={collector.problem !== null || !scopeMatchesCollector} onChange={(event) => {
        const next = event.currentTarget.checked;
        run(() => { collector.setEnabled(next); if (next) setExpanded(true); });
      }} /> 开启本项目工时统计</label>
    </div>
    <p>默认关闭。仅本项目区间分类与时长；无输入内容、按键记录或自动上传。失焦及空闲超过60秒不计人工工时；模型费用未知。</p>
    {!scopeMatchesCollector ? <p role="alert">工时项目或用户范围不匹配，已关闭记录；不会使用旧记录器关联当前范围。</p> : null}
    <details data-testid="activity-details" open={expanded || collector.problem !== null} onToggle={(event) => setExpanded(event.currentTarget.open)} style={{ marginTop: 10 }}>
      <summary style={{ cursor: 'pointer', fontSize: 12 }}>工时明细</summary>
      <label className="external-policy-toggle">当前工时分类 <select data-testid="activity-kind" value={collector.getKind()} disabled={!enabled} onChange={(event) => run(() => collector.interact(event.currentTarget.value as ActivityKind))}>
        {Object.entries(LABELS).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
      </select></label>
      <label className="external-policy-toggle"><input data-testid="activity-task-binding" type="checkbox" checked={appliedScope.current?.key === scopeKey && !!context?.taskId && collector.getBinding().task_id === context.taskId} disabled={!enabled || !context?.taskId} onChange={event => { const checked = event.currentTarget.checked; run(() => { const binding = collector.getBinding(); if (checked && context?.taskId) binding.task_id = context.taskId; else delete binding.task_id; collector.setBinding(binding); }); }} /> 自愿关联当前任务的后续工时</label>
      <label className="external-policy-toggle">自愿关联运行 <select data-testid="activity-run-binding" value={appliedScope.current?.key === scopeKey && eligibleRun && collector.getBinding().run_id === eligibleRun.runId ? eligibleRun.runId : ''} disabled={!enabled || !eligibleRun} onChange={event => { const id = event.currentTarget.value; run(() => { const binding = collector.getBinding(); if (eligibleRun && id === eligibleRun.runId) binding.run_id = id; else delete binding.run_id; collector.setBinding(binding); }); }}><option value="">不关联运行</option>{eligibleRun ? <option value={eligibleRun.runId}>当前已启动运行 {eligibleRun.runId}</option> : null}</select></label>
      {!eligibleRun ? <p>没有与当前项目、图片及规范精确匹配的已启动运行，不推断运行归属。</p> : null}
      <p>任务与运行关联默认关闭，仅对选择之后的新区间生效；切换图片、规范、任务或运行会关闭关联，不改写历史区间。无自动上传。</p>
      <dl data-testid="activity-totals" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', gap: 12, margin: '12px 0' }}>{Object.entries(LABELS).map(([kind, label]) => <div key={kind}><dt style={{ fontSize: 12, color: 'var(--color-muted)' }}>{label}</dt><dd style={{ margin: '4px 0 0', fontVariantNumeric: 'tabular-nums' }} data-testid={`activity-duration-${kind}`}>{(totals[kind as ActivityKind] / 1000).toFixed(3)} 秒</dd></div>)}</dl>
      <p data-testid="activity-human-total">人工合计：{((totals.task + totals.annotation + totals.correction + totals.review + totals.switch) / 1000).toFixed(3)} 秒。仅记录时长，不代表效率提升。</p>
    </details>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
    <button type="button" style={buttonStyle} data-testid="activity-download" disabled={collector.problem !== null && !Object.values(totals).some((duration) => duration > 0)} onClick={download}>下载本地工时记录</button>
    {collector.recoveryJournal && collector.problem ? <button type="button" style={buttonStyle} data-testid="activity-rescue-journal" onClick={() => run(() => {
      const url = URL.createObjectURL(new Blob([collector.recoveryJournal!], { type: 'application/json' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'activity-journal-recovery.json'; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    })}>下载原始本地记录后再清除</button> : null}
    <button type="button" style={buttonStyle} data-testid="activity-publish" disabled={publishing || collector.problem !== null || liveAuthorizationEpoch !== authorizationEpoch} onClick={() => void publish()}>{publishing ? '保存中…' : '保存到项目服务器'}</button>
    <button type="button" style={buttonStyle} data-testid="activity-clear" disabled={publishing} onClick={() => run(() => { collector.clear(); setMessage('本地记录已清除；服务器记录未改变。'); })}>清除本地记录并关闭</button>
      </div>
    {liveAuthorizationEpoch !== authorizationEpoch ? <p role="status">登录身份尚未重新核实，工时暂停上传；原始区间保留，可下载本地记录。</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {error || collector.problem ? <p role="alert">{error ?? collector.problem}。主标注工作台不受影响；请先救援记录或修复浏览器存储。</p> : null}
  </section>;
}
