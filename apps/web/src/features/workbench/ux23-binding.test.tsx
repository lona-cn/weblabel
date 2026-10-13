import * as matchers from '@testing-library/jest-dom/matchers';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useLayoutEffect } from 'react';
import { ActivityCollector } from './activity';
import { ActivityPanel, type ActivityPanelProps } from './ActivityPanel';
import { api, csrfToken, saveAuthorizationEpoch, setCsrfToken } from '../../lib/t15/api';
expect.extend(matchers);
afterEach(() => { cleanup(); setCsrfToken(null); vi.restoreAllMocks(); });
const context = { assetRevisionId: 'asset', ontologyVersionId: 'ontology', taskId: 'task' };
const currentRun = { runId: 'run', projectId: 'project', assetRevisionId: 'asset', ontologyVersionId: 'ontology' };

it('closes spans before binding transitions and preserves old missing fields through restore and ACK', () => {
  let now = 0, raw: string | null = null;
  const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; }, removeItem: () => { raw = null; } };
  const collector = new ActivityCollector('project', 'actor', () => now, storage);
  collector.setEnabled(true); now = 1000; collector.setBinding({ task_id: 'task', run_id: 'run' });
  const prefix = collector.snapshot()[0]!.intervals;
  now = 2000; collector.setBinding({ run_id: 'other-run' }); now = 3000; collector.setBinding({});
  now = 4000; collector.commit();
  const session = collector.snapshot()[0]!;
  expect(session.intervals).toEqual([
    { seq: 0, kind: 'task', duration_ms: 1000 },
    { seq: 1, kind: 'task', duration_ms: 1000, task_id: 'task', run_id: 'run' },
    { seq: 2, kind: 'task', duration_ms: 1000, run_id: 'other-run' },
    { seq: 3, kind: 'task', duration_ms: 1000 },
  ]);
  expect(session.intervals.slice(0, 1)).toEqual(prefix);
  const restored = new ActivityCollector('project', 'actor', () => 0, storage);
  expect(restored.isEnabled()).toBe(false); expect(restored.getBinding()).toEqual({});
  expect(restored.snapshot()).toEqual(collector.snapshot());
  restored.acknowledge(session.session_id, 1);
  expect(JSON.parse(raw!).sessions[0].intervals).toEqual(session.intervals);
  restored.setBinding({ task_id: 'future-task', run_id: 'future-run' });
  expect(restored.snapshot()[0]!.intervals).toEqual(session.intervals);
  expect(Object.hasOwn(restored.snapshot()[0]!.intervals[0]!, 'task_id')).toBe(false);
});

it('retains raw invalid binding journal for rescue rather than silently dropping binding identity', () => {
  const raw = JSON.stringify({ schema_version: 1, sessions: [{ session_id: 'old', version: 1, intervals: [{ seq: 0, kind: 'task', duration_ms: 1000, run_id: null }] }] });
  const write = vi.fn();
  const collector = new ActivityCollector('project', 'actor', () => 0, { getItem: () => raw, setItem: write, removeItem: vi.fn() });
  expect(collector.problem).not.toBeNull(); expect(collector.recoveryJournal).toBe(raw);
  expect(() => collector.setEnabled(true)).toThrow(); expect(write).not.toHaveBeenCalled();
});

it('defaults collection and binding off, publishes only explicitly and keeps the complete bound prefix', async () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  let now = 0;
  const collector = new ActivityCollector('project', 'actor', () => now);
  const request = vi.spyOn(api, 'request').mockImplementation(async <T,>(_path: string, options?: RequestInit) => {
    const body = JSON.parse(String(options?.body)); return { session_id: collector.currentSession, version: body.expected_version + 1, intervals: body.intervals } as T;
  });
  render(<ActivityPanel projectId="project" actorId="actor" collector={collector} context={context} currentRun={currentRun} />);
  expect(screen.getByTestId('activity-opt-in')).not.toBeChecked(); expect(screen.getByTestId('activity-task-binding')).not.toBeChecked();
  expect(screen.getByTestId('activity-run-binding')).toHaveValue('');
  now = 1000; act(() => collector.commit()); expect(collector.snapshot()).toEqual([]);
  fireEvent.click(screen.getByTestId('activity-opt-in'));
  now = 2000; fireEvent.click(screen.getByTestId('activity-task-binding'));
  now = 3000; fireEvent.change(screen.getByTestId('activity-run-binding'), { target: { value: 'run' } });
  now = 4000; act(() => collector.commit());
  expect(request).not.toHaveBeenCalled();
  const prefix = collector.snapshot()[0]!.intervals;
  fireEvent.click(screen.getByTestId('activity-publish'));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  expect(JSON.parse(String(request.mock.calls[0]![1]?.body)).intervals).toEqual(prefix);
  expect(prefix).toEqual([{ seq: 0, kind: 'task', duration_ms: 1000 }, { seq: 1, kind: 'task', duration_ms: 1000, task_id: 'task' }, { seq: 2, kind: 'task', duration_ms: 1000, task_id: 'task', run_id: 'run' }]);
});

it.each(['asset', 'ontology', 'task', 'run', 'project', 'actor'] as const)('closes and clears binding synchronously when %s scope changes', field => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  let now = 0;
  const collector = new ActivityCollector('project', 'actor', () => now);
  let props: ActivityPanelProps = { projectId: 'project', actorId: 'actor', collector, context, currentRun };
  function Surface({ value }: { value: ActivityPanelProps }) {
    // Parent layout work runs before passive effects: the panel must already reset binding.
    useLayoutEffect(() => { collector.interact(); }, [value]);
    return <ActivityPanel {...value} />;
  }
  const view = render(<Surface value={props} />);
  fireEvent.click(screen.getByTestId('activity-opt-in')); fireEvent.click(screen.getByTestId('activity-task-binding'));
  fireEvent.change(screen.getByTestId('activity-run-binding'), { target: { value: 'run' } });
  now = 1000;
  props = { ...props, context: { ...context }, currentRun: { ...currentRun } };
  if (field === 'asset') props.context!.assetRevisionId = 'other';
  if (field === 'ontology') props.context!.ontologyVersionId = 'other';
  if (field === 'task') props.context!.taskId = 'other';
  if (field === 'run') props.currentRun!.runId = 'other';
  if (field === 'project') props.projectId = 'other';
  if (field === 'actor') props.actorId = 'other';
  view.rerender(<Surface value={props} />);
  expect(collector.getBinding()).toEqual({}); expect(screen.getByTestId('activity-task-binding')).not.toBeChecked();
  expect(screen.getByTestId('activity-run-binding')).toHaveValue('');
  now = 2000; act(() => collector.commit());
  const expected = [{ seq: 0, kind: 'task', duration_ms: 1000, task_id: 'task', run_id: 'run' }];
  if (field === 'project' || field === 'actor') {
    expect(collector.isEnabled()).toBe(false);
    expect(screen.getByTestId('activity-opt-in')).toBeDisabled();
    expect(collector.snapshot()[0]!.intervals).toEqual(expected);
  } else expect(collector.snapshot()[0]!.intervals).toEqual([...expected, { seq: 1, kind: 'task', duration_ms: 1000 }]);
});

it.each(['projectId', 'assetRevisionId', 'ontologyVersionId'] as const)('rejects stale run pins with mismatched %s without fetching or inferring a run', field => {
  const request = vi.spyOn(api, 'request');
  const collector = new ActivityCollector('project', 'actor', () => 0);
  render(<ActivityPanel projectId="project" actorId="actor" collector={collector} context={context} currentRun={{ ...currentRun, [field]: 'other' }} />);
  fireEvent.click(screen.getByTestId('activity-opt-in'));
  expect(screen.getByTestId('activity-run-binding')).toBeDisabled(); expect(screen.queryByRole('option', { name: /当前已启动运行/ })).toBeNull();
  expect(collector.getBinding()).toEqual({}); expect(request).not.toHaveBeenCalled();
});

function restoredPair() {
  const sessions = [
    { session_id: 'first-restored', version: 3, intervals: [{ seq: 0, kind: 'task', duration_ms: 1000 }] },
    { session_id: 'second-restored', version: 7, intervals: [{ seq: 0, kind: 'review', duration_ms: 2000, task_id: 'task', run_id: 'run' }] },
  ];
  let raw = JSON.stringify({ schema_version: 1, sessions });
  const collector = new ActivityCollector('project', 'actor', () => 0, { getItem: () => raw, setItem: (_key, value) => { raw = value; }, removeItem: () => { raw = ''; } });
  return { collector, raw: () => raw };
}
function deferredAck() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise(resolveValue => { resolve = resolveValue; });
  return { promise, resolve };
}
it.each(['unmount', 'actor', 'actor-return', 'project', 'collector', 'authorization', 'authorization-return'] as const)('discards delayed multi-session ACK after %s without changing the original journal', async change => {
  const fixture = restoredPair();
  const before = fixture.collector.snapshot(), raw = fixture.raw();
  const ack = vi.spyOn(fixture.collector, 'acknowledge');
  const pending = deferredAck();
  const request = vi.spyOn(api, 'request').mockImplementation(() => pending.promise as never);
  const props = { projectId: 'project', actorId: 'actor', collector: fixture.collector };
  const view = render(<ActivityPanel {...props} />);
  fireEvent.click(screen.getByTestId('activity-publish'));
  expect(request).toHaveBeenCalledTimes(1);
  if (change === 'unmount') view.unmount();
  if (change === 'actor' || change === 'actor-return') view.rerender(<ActivityPanel {...props} actorId="other" />);
  if (change === 'actor-return') view.rerender(<ActivityPanel {...props} />);
  if (change === 'project') view.rerender(<ActivityPanel {...props} projectId="other" />);
  if (change === 'collector') view.rerender(<ActivityPanel {...props} collector={restoredPair().collector} />);
  if (change.startsWith('authorization')) {
    const token = csrfToken();
    act(() => setCsrfToken('changed-publish-authorization'));
    if (change === 'authorization-return') act(() => setCsrfToken(token));
  }
  await act(async () => { pending.resolve({ ...before[0], version: 4 }); await pending.promise; });
  expect(request).toHaveBeenCalledTimes(1); expect(ack).not.toHaveBeenCalled();
  expect(fixture.collector.snapshot()).toEqual(before); expect(fixture.raw()).toBe(raw);
  expect(screen.queryByText('本人工时已保存到项目服务器。')).toBeNull();
});
it('admits only one same-frame publish flight and normally acknowledges both restored sessions', async () => {
  const fixture = restoredPair(), before = fixture.collector.snapshot();
  const pending = deferredAck();
  const ack = vi.spyOn(fixture.collector, 'acknowledge');
  const request = vi.spyOn(api, 'request').mockImplementationOnce(() => pending.promise as never).mockResolvedValueOnce({ ...before[1], version: 8 });
  render(<ActivityPanel projectId="project" actorId="actor" collector={fixture.collector} />);
  const button = screen.getByTestId('activity-publish');
  act(() => { button.click(); button.click(); });
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => { pending.resolve({ ...before[0], version: 4 }); await pending.promise; });
  expect(request).toHaveBeenCalledTimes(2);
  expect(ack.mock.calls).toEqual([['first-restored', 4], ['second-restored', 8]]);
  expect(fixture.collector.snapshot()).toEqual(before.map(session => ({ ...session, version: session.version + 1 })));
  expect(screen.getByText('本人工时已保存到项目服务器。')).toBeInTheDocument();
});
it('does not mistake image task or run binding changes for publisher identity changes', async () => {
  const fixture = restoredPair(), before = fixture.collector.snapshot(), pending = deferredAck();
  const request = vi.spyOn(api, 'request').mockImplementationOnce(() => pending.promise as never).mockResolvedValueOnce({ ...before[1], version: 8 });
  const props = { projectId: 'project', actorId: 'actor', collector: fixture.collector, context, currentRun };
  const view = render(<ActivityPanel {...props} />);
  fireEvent.click(screen.getByTestId('activity-publish'));
  view.rerender(<ActivityPanel {...props} context={{ ...context, assetRevisionId: 'other', taskId: 'other' }} currentRun={{ ...currentRun, runId: 'other' }} />);
  await act(async () => { pending.resolve({ ...before[0], version: 4 }); await pending.promise; });
  expect(request).toHaveBeenCalledTimes(2);
  expect(fixture.collector.snapshot().map(session => session.version)).toEqual([4, 8]);
});
it('an obsolete flight finally cannot unlock a new identity flight', async () => {
  const old = restoredPair(), fresh = restoredPair(), first = deferredAck(), second = deferredAck();
  const request = vi.spyOn(api, 'request').mockImplementationOnce(() => first.promise as never).mockImplementationOnce(() => second.promise as never).mockResolvedValueOnce({ version: 8 });
  const props = { projectId: 'project', actorId: 'actor' };
  const view = render(<ActivityPanel {...props} collector={old.collector} />);
  fireEvent.click(screen.getByTestId('activity-publish'));
  view.rerender(<ActivityPanel {...props} collector={fresh.collector} />);
  fireEvent.click(screen.getByTestId('activity-publish'));
  await act(async () => { first.resolve({ version: 4 }); await first.promise; });
  expect(screen.getByTestId('activity-publish')).toBeDisabled();
  fireEvent.click(screen.getByTestId('activity-publish')); expect(request).toHaveBeenCalledTimes(2);
  await act(async () => { second.resolve({ version: 4 }); await second.promise; });
  expect(request).toHaveBeenCalledTimes(3);
});
it.each(['mount', 'verified-parent'] as const)('does not reauthorize old actor props from a new token using %s authorization', async authorization => {
  setCsrfToken('actor-a-token');
  const fixture = restoredPair(), before = fixture.collector.snapshot(), original = fixture.raw();
  const request = vi.spyOn(api, 'request').mockResolvedValue({ version: 8 });
  const verified = saveAuthorizationEpoch();
  const props = { projectId: 'project', actorId: 'actor', collector: fixture.collector };
  const view = render(<ActivityPanel {...props} verifiedAuthorizationEpoch={authorization === 'verified-parent' ? verified : undefined} />);
  act(() => setCsrfToken('actor-b-token'));
  fireEvent.click(screen.getByTestId('activity-publish'));
  expect(request).not.toHaveBeenCalled();
  expect(fixture.collector.snapshot()).toEqual(before); expect(fixture.raw()).toBe(original);
  let now = 0;
  const verifiedCollector = new ActivityCollector('project', 'actor-b', () => now);
  verifiedCollector.setEnabled(true); now = 1700; verifiedCollector.setEnabled(false);
  view.rerender(<ActivityPanel projectId="project" actorId="actor-b" collector={verifiedCollector} verifiedAuthorizationEpoch={saveAuthorizationEpoch()} />);
  fireEvent.click(screen.getByTestId('activity-publish'));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  const body = JSON.parse(vi.mocked(api.request).mock.calls[0]![1]!.body as string);
  expect(body.intervals).toEqual([{ seq: 0, kind: 'task', duration_ms: 1700 }]);
  expect(fixture.collector.snapshot()).toEqual(before); expect(fixture.raw()).toBe(original);
});
