import { cleanup, render, screen, act } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OutcomeSummary } from './OutcomeSummary';
import type { RunOutcomeSummary } from './outcome-summary';
import { api } from '../../lib/t15/api';
afterEach(cleanup);
const outcome = (runId = 'run'): RunOutcomeSummary => ({
  run: { run_id: runId, project_id: 'project', state: 'succeeded', cost_display: 'unknown' },
  candidate_change_count: 1, accepted_change_count: 1, accept_journal_count: 1, revert_journal_count: 0, rejected_change_count: 0,
  object_observations: [{ suggestion_set_id: 'set', change_id: 'change', object_id: 'object', accepted_revision_id: 'saved', current_status: 'changed_since_acceptance', attribution: 'unknown' }],
  task_binding: null, activity_task_bindings: [], recorded_work_seconds: null,
  work_time_scope: 'current_actor_explicit_run_intervals', work_time_reason: 'no_explicit_run_intervals', usage: null, cost_display: 'unknown',
});
it('keeps missing exact task binding and own run work unknown, with object attribution unchanged', async () => {
  const request = vi.fn(async <T,>() => outcome() as T);
  render(<OutcomeSummary runId="run" request={request as typeof api.request} />);
  await screen.findByText(/没有精确版本匹配的任务提交/);
  expect(screen.getByText(/没有可归属于此 run 的工时记录/)).toBeTruthy();
  expect(screen.getByText(/采纳后当前对象已有变化（归因未知）/)).toBeTruthy();
  expect(screen.queryAllByRole('link')).toHaveLength(0);
  expect(request.mock.calls).toHaveLength(1);
});
it('displays measured voluntary own run/task work without presenting it as execution time or causal value', async () => {
  const value = outcome(); value.recorded_work_seconds = 3;
  value.work_time_reason = 'explicit_voluntary_run_intervals';
  value.activity_task_bindings = [{ task_id: 'task', recorded_work_seconds: 2, basis: 'explicit_voluntary_run_task_interval' }];
  const request = vi.fn(async <T,>() => value as T);
  render(<OutcomeSummary runId="run" request={request as typeof api.request} />);
  await screen.findByText('3 秒');
  expect(screen.getByText(/本人明确关联运行与任务的自愿区间 2 秒/)).toBeTruthy();
  expect(screen.getByText(/不是模型执行时长、因果归属或 ROI/)).toBeTruthy();
});
it('does not expose a stale run outcome after the real selected run changes', async () => {
  let resolveOld!: (value: RunOutcomeSummary) => void;
  const request = vi.fn((path: string) => path.includes('/old/') ? new Promise<RunOutcomeSummary>(resolve => { resolveOld = resolve; }) : Promise.resolve(outcome('new')));
  const view = render(<OutcomeSummary runId="old" request={request as typeof api.request} />);
  view.rerender(<OutcomeSummary runId="new" request={request as typeof api.request} />);
  await screen.findByText(/没有精确版本匹配的任务提交/);
  const old = outcome('old'); old.recorded_work_seconds = 900;
  await act(async () => resolveOld(old));
  expect(screen.queryByText('900 秒')).toBeNull();
  expect(screen.getByText(/运行 new/)).toBeTruthy();
});
