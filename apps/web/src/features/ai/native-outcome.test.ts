// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../lib/t15/api';
import { mountOutcomeView } from './outcome-view';
import type { RunOutcomeSummary } from './outcome-summary';
import * as runController from './run-controller';
import { mountAiWorkbenchView } from './ai-workbench-view';
import { nativeFixture } from '../workbench/native-test-support';

const owners: AbortController[] = [];
afterEach(() => { for (const owner of owners.splice(0)) owner.abort(); vi.restoreAllMocks(); document.body.replaceChildren(); });

it('never attributes the previous run summary or fixed task links to a pending or failed new run', async () => {
  const prior: RunOutcomeSummary = {
    run: { run_id: 'run-a', project_id: 'project', state: 'succeeded', cost_display: 'recorded' },
    candidate_change_count: 3, accepted_change_count: 2, accept_journal_count: 2, revert_journal_count: 0, rejected_change_count: 1,
    object_observations: [], activity_task_bindings: [], recorded_work_seconds: 901,
    work_time_scope: 'current_actor_explicit_run_intervals', work_time_reason: 'explicit_voluntary_run_intervals',
    usage: { input_tokens: 1234, receipt_marker: 'run-a-only-usage' }, cost_display: 'recorded',
    task_binding: { basis: 'exact_decision_revision_submission', truncated: false, submissions: [{ task_id: 'task-a', review_id: 'review-a', annotation_revision_id: 'revision-a', asset_revision_id: 'asset-a', ontology_version_id: 'ontology', task_state: 'closed', review_state: 'approved', decision_kinds: ['accept'], suggestion_set_ids: ['set-a'] }] },
  };
  let reject!: (reason: Error) => void;
  const pending = new Promise<RunOutcomeSummary>((_resolve, fail) => { reject = fail; });
  vi.spyOn(api, 'request').mockResolvedValueOnce(prior).mockReturnValueOnce(pending);
  const root = document.createElement('section'), owner = new AbortController(); owners.push(owner); document.body.append(root);
  const view = mountOutcomeView(root, { signal: owner.signal, isCurrent: () => true, navigate: vi.fn() });
  view.update('run-a', 'first');
  await vi.waitFor(() => expect(root.querySelector('a[href*="revision-a"]')).not.toBeNull());
  expect(root.textContent).toContain('901 秒'); expect(root.textContent).toContain('run-a-only-usage');
  view.update('run-b', 'first');
  expect(root.textContent).not.toContain('901 秒'); expect(root.textContent).not.toContain('run-a-only-usage');
  expect(root.querySelector('a[href*="revision-a"]')).toBeNull();
  reject(new Error('synthetic run-b read failure')); await pending.catch(() => {});
  expect(root.textContent).not.toContain('901 秒'); expect(root.textContent).not.toContain('run-a-only-usage');
  expect(root.querySelector('a[href*="revision-a"]')).toBeNull();
});

it('refreshes decision counts after a save ACK without a new run event or saved notice', async () => {
  const f = nativeFixture(), owner = new AbortController(), root = document.createElement('section');
  owners.push(owner); document.body.append(root);
  const unsubscribe = f.state.queue.subscribe('asset', () => f.state.notify());
  owner.signal.addEventListener('abort', () => { unsubscribe(); f.dispose(); }, { once: true });
  const snapshot: runController.RunSnapshot = {
    runId: 'run', runScope: { runId: 'run', projectId: f.state.projectId, assetRevisionId: 'asset', ontologyVersionId: 'ontology' },
    events: [], candidates: [], error: null, busy: false, modelWaiting: false, savedMessage: 'later local edit',
  };
  vi.spyOn(runController, 'createRunController').mockReturnValue({
    getSnapshot: () => snapshot, subscribe: vi.fn(() => vi.fn()), update: vi.fn(), dispose: vi.fn(),
    run: vi.fn(), preparePreview: vi.fn(), getPreviewSnapshot: vi.fn(), cancel: vi.fn(), acceptSelected: vi.fn(),
  });
  let acknowledged = false;
  f.transport.save.mockImplementation(async payload => {
    acknowledged = true;
    return { operation_id: payload.operation_id, revision: { ...f.revision, annotation_revision_id: 'reverted-revision', parent_revision_id: 'revision', revision_no: 2, document: payload.document }, idempotent_replay: false };
  });
  vi.spyOn(api, 'request').mockImplementation(async path => {
    if (path === '/api/model-profiles') return { items: [] };
    if (path !== '/api/ai/runs/run/outcome-summary') throw new Error('Unexpected request: ' + path);
    const summary: RunOutcomeSummary = {
      run: { run_id: 'run', project_id: f.state.projectId, state: 'succeeded', cost_display: 'unknown' },
      candidate_change_count: 1, accepted_change_count: acknowledged ? 0 : 1, accept_journal_count: 1,
      revert_journal_count: acknowledged ? 1 : 0, rejected_change_count: 0, object_observations: [], activity_task_bindings: [],
      recorded_work_seconds: null, work_time_scope: 'current_actor_explicit_run_intervals', work_time_reason: 'no_recorded_intervals',
      usage: null, cost_display: 'unknown', task_binding: null,
    };
    return summary;
  });
  mountAiWorkbenchView(root, f.state, f.port, owner.signal, vi.fn());
  const count = (label: string) => [...root.querySelectorAll('dt')].find(item => item.textContent === label)?.nextElementSibling?.textContent;
  await vi.waitFor(() => expect(count('当前有效采纳')).toBe('1'));
  f.state.queue.enqueue({ asset_revision_id: 'asset', ontology_version_id: 'ontology', generation: 1, document: { ...f.document, objects: [] } });
  await f.state.queue.flush('asset');
  expect(f.state.queue.getStatus('asset').base_revision_id).toBe('reverted-revision');
  await vi.waitFor(() => expect(count('当前有效采纳')).toBe('0'));
  expect(count('接受 journal / 撤销 journal')).toBe('1 / 1');
});
