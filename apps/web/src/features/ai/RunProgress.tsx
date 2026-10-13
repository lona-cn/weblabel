import type { RunEvent } from '../../../../../packages/contracts/generated/RunEvent';

export function RunProgress({ runId, events, busy, onCancel }: {
  runId: string | null;
  events: readonly RunEvent[];
  busy: boolean;
  onCancel: () => void;
}) {
  if (!runId && !busy) return null;
  const latest = events[events.length - 1];
  const states: Record<string, string> = { queued: '等待运行', started: '已开始', progress: '运行中', tool_call: '正在处理', candidate: '已有建议', succeeded: '已完成', failed: '运行失败', cancelled: '已取消' };
  return (
    <section aria-label="AI 运行进度" aria-live="polite">
      <p data-testid="ai-status">{busy ? '正在准备已授权的运行…' : states[latest?.type ?? 'queued'] ?? latest?.type}</p>
      {runId ? <details><summary>运行详情</summary><p>运行编号：<code>{runId}</code></p>{latest ? <p>{latest.message} · {latest.type} · 事件 {latest.seq}</p> : null}</details> : null}
      {runId && latest && ['queued', 'started', 'progress', 'tool_call'].includes(latest.type) ? <button type="button" data-testid="ai-cancel" onClick={onCancel}>取消本次运行</button> : null}
    </section>
  );
}
