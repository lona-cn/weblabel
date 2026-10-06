import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react';
import type { ActivityKind } from '../../../../../packages/contracts/generated/ActivityKind';
import type { ActivityCheckpoint } from '../../../../../packages/contracts/generated/ActivityCheckpoint';
import type { ActivitySession } from '../../../../../packages/contracts/generated/ActivitySession';
import { api } from '../../lib/t15/api';
import { ActivityCollector } from './activity';

export type ActivityPanelProps = { projectId: string; actorId: string; collector: ActivityCollector; surfaceRef?: RefObject<HTMLElement | null> };
const LABELS: Record<ActivityKind, string> = { task: '任务准备', annotation: '标注', correction: '修正', review: '审核', switch: '切换图片', model_wait: '模型等待（非人工）' };

export function ActivityPanel({ projectId, actorId, collector, surfaceRef }: ActivityPanelProps) {
  useSyncExternalStore(collector.subscribe, collector.getRevision, collector.getRevision);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
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
    const timer = setInterval(checkpoint, 15_000);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', focus);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', focus);
      window.removeEventListener('pagehide', blur);
      surface?.removeEventListener('pointerdown', interact);
      surface?.removeEventListener('input', interact);
      safely(() => collector.setEnabled(false));
    };
  }, [collector, panel, surfaceRef]);

  async function publish() {
    setPublishing(true); setError(null); setMessage(null);
    try {
      collector.commit();
      const sessions = collector.snapshot();
      if (!sessions.some((session) => session.intervals.length)) { setMessage('无数据，未发送请求。'); return; }
      for (const session of sessions) {
        if (!session.intervals.length) continue;
        const body: ActivityCheckpoint = { expected_version: session.version, intervals: session.intervals };
        const response = await api.request<ActivitySession>(`/api/projects/${encodeURIComponent(projectId)}/activity-sessions/${encodeURIComponent(session.session_id)}`, { method: 'PUT', body: JSON.stringify(body) });
        collector.acknowledge(session.session_id, response.version);
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
  return <section ref={setPanel} className="panel" aria-label="自愿本地工时统计" data-testid="activity-panel">
    <h2>本地工时 · 自愿记录</h2>
    <p>默认关闭。只记录本项目的区间分类与时长，不记录输入内容或按键。不自动上传；失焦及空闲超过60秒不计人工工时。模型费用未知。</p>
    <label><input type="checkbox" data-testid="activity-opt-in" checked={enabled} onChange={(event) => run(() => collector.setEnabled(event.currentTarget.checked))} /> 开启本项目工时统计</label>
    <label>当前工时分类 <select data-testid="activity-kind" value={collector.getKind()} disabled={!enabled} onChange={(event) => run(() => collector.interact(event.currentTarget.value as ActivityKind))}>
      {Object.entries(LABELS).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
    </select></label>
    <dl data-testid="activity-totals">{Object.entries(LABELS).map(([kind, label]) => <div key={kind}><dt>{label}</dt><dd data-testid={`activity-duration-${kind}`}>{(totals[kind as ActivityKind] / 1000).toFixed(3)} 秒</dd></div>)}</dl>
    <p data-testid="activity-human-total">人工合计：{((totals.task + totals.annotation + totals.correction + totals.review + totals.switch) / 1000).toFixed(3)} 秒。仅描述统计，不是ROI或节省结论；30%仅试点目标。</p>
    <button type="button" data-testid="activity-download" onClick={download}>下载本地区间 JSON</button>
    <button type="button" data-testid="activity-publish" disabled={publishing} onClick={() => void publish()}>{publishing ? '保存中…' : '明确保存到本机项目'}</button>
    <button type="button" data-testid="activity-clear" disabled={publishing} onClick={() => run(() => { collector.clear(); setMessage('本地记录已清除；已明确保存的服务端记录不受影响。'); })}>清除本地记录并关闭</button>
    {message ? <p role="status">{message}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
