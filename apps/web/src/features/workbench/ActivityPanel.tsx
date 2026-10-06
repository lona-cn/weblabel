import { useEffect, useState, useSyncExternalStore } from 'react';
import type { RefObject } from 'react';
import type { ActivityKind } from '../../../../../packages/contracts/generated/ActivityKind';
import type { ActivityCheckpoint } from '../../../../../packages/contracts/generated/ActivityCheckpoint';
import type { ActivitySession } from '../../../../../packages/contracts/generated/ActivitySession';
import { api } from '../../lib/t15/api';
import { ActivityCollector } from './activity';

export type ActivityPanelProps = { projectId: string; actorId: string; collector: ActivityCollector; surfaceRef?: RefObject<HTMLElement | null> };
const LABELS: Record<ActivityKind, string> = { task: '任务准备', annotation: '标注', correction: '修正', review: '审核', switch: '切换图片', model_wait: '模型等待（非人工）' };
const buttonStyle = { padding: '7px 12px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-surface)', fontSize: 12 };

export function ActivityPanel({ projectId, actorId, collector, surfaceRef }: ActivityPanelProps) {
  useSyncExternalStore(collector.subscribe, collector.getRevision, collector.getRevision);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  const enabled = collector.isEnabled();
  const totals = collector.totals();
  const run = (action: () => void) => {
    try { action(); setError(null); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  useEffect(() => {
    const surface = surfaceRef?.current ?? panel?.parentElement;
    const safely = (action: () => void) => { try { action(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } };
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
    setPublishing(true); setError(null); setMessage(null);
    try {
      if (collector.problem) throw new Error(collector.problem);
      collector.commit();
      if (collector.problem) throw new Error(collector.problem);
      const sessions = collector.snapshot();
      if (!sessions.some((session) => session.intervals.length)) { setMessage('无数据，未发送请求。'); return; }
      for (const session of sessions) {
        if (!session.intervals.length) continue;
        const body: ActivityCheckpoint = { expected_version: session.version, intervals: session.intervals };
        const response = await api.request<ActivitySession>(`/api/projects/${encodeURIComponent(projectId)}/activity-sessions/${encodeURIComponent(session.session_id)}`, { method: 'PUT', body: JSON.stringify(body) });
        collector.acknowledge(session.session_id, response.version);
        if (collector.problem) throw new Error(collector.problem);
      }
      setMessage('已明确保存至本机项目，仅包含本人区间统计。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setPublishing(false); }
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
      <h2>本地工时 · 自愿记录</h2>
      <label className="external-policy-toggle"><input type="checkbox" data-testid="activity-opt-in" checked={enabled} disabled={collector.problem !== null} onChange={(event) => {
        const next = event.currentTarget.checked;
        run(() => { collector.setEnabled(next); if (next) setExpanded(true); });
      }} /> 开启本项目工时统计</label>
    </div>
    <p>默认关闭。仅本项目区间分类与时长；无输入内容、按键记录或自动上传。失焦及空闲超过60秒不计人工工时；模型费用未知。</p>
    <details data-testid="activity-details" open={expanded || collector.problem !== null} onToggle={(event) => setExpanded(event.currentTarget.open)} style={{ marginTop: 10 }}>
      <summary style={{ cursor: 'pointer', fontSize: 12 }}>查看工时分类、明细与保存操作</summary>
      <label className="external-policy-toggle">当前工时分类 <select data-testid="activity-kind" value={collector.getKind()} disabled={!enabled} onChange={(event) => run(() => collector.interact(event.currentTarget.value as ActivityKind))}>
        {Object.entries(LABELS).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
      </select></label>
      <dl data-testid="activity-totals" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', gap: 12, margin: '12px 0' }}>{Object.entries(LABELS).map(([kind, label]) => <div key={kind}><dt style={{ fontSize: 12, color: 'var(--color-muted)' }}>{label}</dt><dd style={{ margin: '4px 0 0', fontVariantNumeric: 'tabular-nums' }} data-testid={`activity-duration-${kind}`}>{(totals[kind as ActivityKind] / 1000).toFixed(3)} 秒</dd></div>)}</dl>
      <p data-testid="activity-human-total">人工合计：{((totals.task + totals.annotation + totals.correction + totals.review + totals.switch) / 1000).toFixed(3)} 秒。仅描述统计，不是ROI或节省结论；30%仅试点目标。</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
    <button type="button" style={buttonStyle} data-testid="activity-download" disabled={collector.problem !== null && !Object.values(totals).some((duration) => duration > 0)} onClick={download}>下载本地区间 JSON</button>
    {collector.recoveryJournal && collector.problem ? <button type="button" style={buttonStyle} data-testid="activity-rescue-journal" onClick={() => run(() => {
      const url = URL.createObjectURL(new Blob([collector.recoveryJournal!], { type: 'application/json' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'activity-journal-recovery.json'; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    })}>下载原始本地记录后再清除</button> : null}
    <button type="button" style={buttonStyle} data-testid="activity-publish" disabled={publishing || collector.problem !== null} onClick={() => void publish()}>{publishing ? '保存中…' : '明确保存到本机项目'}</button>
    <button type="button" style={buttonStyle} data-testid="activity-clear" disabled={publishing} onClick={() => run(() => { collector.clear(); setMessage('本地记录已清除；已明确保存的服务端记录不受影响。'); })}>清除本地记录并关闭</button>
      </div>
    </details>
    {message ? <p role="status">{message}</p> : null}
    {error || collector.problem ? <p role="alert">{error ?? collector.problem}。主标注工作台不受影响；请先救援记录或修复浏览器存储。</p> : null}
  </section>;
}
