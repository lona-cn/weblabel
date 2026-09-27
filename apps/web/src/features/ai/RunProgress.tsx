import type { RunEvent } from '../../../../../packages/contracts/generated/RunEvent';

export function RunProgress({ runId, events, busy, onCancel }: {
  runId: string | null;
  events: readonly RunEvent[];
  busy: boolean;
  onCancel: () => void;
}) {
  if (!runId && !busy) return null;
  const latest = events[events.length - 1];
  return (
    <section aria-label="AI run progress" aria-live="polite">
      <p data-testid="ai-status">{busy ? 'Preparing authorized run…' : latest?.message ?? latest?.type ?? 'Run queued'}</p>
      {runId ? <p>Run: <code>{runId}</code></p> : null}
      {latest ? <p>State: {latest.type} · event {latest.seq}</p> : null}
      {runId && latest && ['queued', 'started', 'progress', 'tool_call'].includes(latest.type) ? <button type="button" data-testid="ai-cancel" onClick={onCancel}>Cancel this run</button> : null}
    </section>
  );
}
