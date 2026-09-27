// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Session } from '../../lib/t15/api';
import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import type { ReviewTask } from './api';

const mocked = vi.hoisted(() => ({
  tasks: vi.fn(),
  createTask: vi.fn(),
  lease: vi.fn(),
  submit: vi.fn(),
  decide: vi.fn(),
  issues: vi.fn(),
  revision: vi.fn(),
}));
vi.mock('./api', () => ({ reviewApi: mocked }));

import { ReviewPanel } from './ReviewPanel';

const task: ReviewTask = {
  task_id: 'task-1', project_id: 'project-1', asset_revision_id: 'asset-1', ontology_version_id: 'ontology-1',
  assignee_id: 'annotator-1', state: 'open', created_at: '2026-09-26T00:00:00Z', review_id: null,
  revision_ids: null, review_decision: null, review_reason: null,
};
const annotator: Session = {
  user_id: 'annotator-1', username: 'annotator', platform_admin: false,
  project_roles: [{ project_id: 'project-1', role: 'annotator' }],
};
const previousRevision: AnnotationRevision = {
  annotation_revision_id: 'revision-old', parent_revision_id: null, revision_no: 1,
  document: {
    schema_version: 1, asset_revision_id: 'asset-1', ontology_version_id: 'ontology-1',
    coordinate_space: { type: 'canonical_image_pixels', width: 100, height: 100 }, completion: 'complete',
    objects: [{ object_id: 'object-1', label_id: 'person', geometry: { type: 'bbox_xyxy', x_min: 1, y_min: 2, x_max: 20, y_max: 30 }, attributes: { helmet: 'unknown' }, origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null } }],
  },
  created_at: '2026-09-26T00:00:00Z', created_by: 'annotator-1', content_hash: 'old-hash',
};
const currentRevision: AnnotationRevision = {
  ...previousRevision,
  annotation_revision_id: 'revision-current', parent_revision_id: 'revision-old', revision_no: 2,
  document: { ...previousRevision.document, objects: [{ ...previousRevision.document.objects[0]!, attributes: { helmet: 'wearing' } }] },
  content_hash: 'new-hash',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocked.tasks.mockResolvedValue({ items: [task], next_cursor: null });
  mocked.createTask.mockResolvedValue({});
  mocked.lease.mockImplementation(async (taskId: string, action: string, holderId?: string) => ({
    task_id: taskId, holder_id: action === 'release' ? null : holderId ?? annotator.user_id,
    fencing_token: action === 'transfer' ? 43 : 42, expires_at_unix: 1_800_000_000, lease_seconds: 60, heartbeat_seconds: 20,
  }));
  mocked.submit.mockResolvedValue({ review_id: 'review-1', revision_ids: ['revision-1'], state: 'pending' });
  mocked.decide.mockResolvedValue({});
  mocked.issues.mockResolvedValue({ items: [], next_cursor: null });
  mocked.revision.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('T26 review panel integration', () => {
  it('flushes through the workbench callback before submitting the exact returned saved revision', async () => {
    const order: string[] = [];
    const onSubmitTask = vi.fn(async (_task: ReviewTask, submit: (revisionId: string) => Promise<void>) => {
      order.push('flush-and-read-head');
      await submit('revision-current');
    });
    render(<ReviewPanel projectId="project-1" session={annotator} onLeaseChange={() => undefined} onSubmitTask={onSubmitTask} />);
    await screen.findByTestId('review-task-task-1');

    fireEvent.click(screen.getByRole('button', { name: '领取 60 秒任务' }));
    await waitFor(() => expect(mocked.lease).toHaveBeenCalledWith('task-1', 'acquire'));
    fireEvent.click(screen.getByTestId('task-submit'));
    await waitFor(() => expect(mocked.submit).toHaveBeenCalledWith('task-1', 'revision-current'));

    expect(order).toEqual(['flush-and-read-head']);
  });

  it('renews the current lease at 20 seconds and releases it on unmount', async () => {
    vi.useFakeTimers();
    const onLeaseChange = vi.fn();
    const view = render(<ReviewPanel projectId="project-1" session={annotator} onLeaseChange={onLeaseChange} onSubmitTask={async (_task, submit) => { await submit('revision-1'); }} />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole('button', { name: '领取 60 秒任务' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(onLeaseChange).toHaveBeenCalledWith({ asset_revision_id: 'asset-1', task_id: 'task-1', fencing_token: 42 });

    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(mocked.lease).toHaveBeenCalledWith('task-1', 'renew');
    expect(onLeaseChange).toHaveBeenLastCalledWith({ asset_revision_id: 'asset-1', task_id: 'task-1', fencing_token: 42 });

    view.unmount();
    expect(mocked.lease).toHaveBeenCalledWith('task-1', 'release');
  });

  it('shows immutable revision differences before decisions and retains issue history after a decision', async () => {
    const submittedTask: ReviewTask = { ...task, state: 'submitted', review_id: 'review-1', revision_ids: ['revision-current'] };
    mocked.tasks.mockResolvedValueOnce({ items: [submittedTask], next_cursor: null }).mockResolvedValue({ items: [{ ...submittedTask, state: 'closed', review_decision: 'approve', review_reason: 'Verified' }], next_cursor: null });
    mocked.revision.mockImplementation(async (revisionId: string) => revisionId === 'revision-old' ? previousRevision : currentRevision);
    mocked.issues.mockResolvedValue({ items: [{ issue_id: 'issue-1', review_id: 'review-1', annotation_revision_id: 'revision-current', ontology_version_id: 'ontology-1', object_id: 'object-1', code: 'attribute-check', message: 'Verify helmet attribute', region: null, created_at: '2026-09-26T00:00:00Z' }] });
    const reviewer: Session = { ...annotator, user_id: 'reviewer-1', username: 'reviewer', project_roles: [{ project_id: 'project-1', role: 'reviewer' }] };
    render(<ReviewPanel projectId="project-1" session={reviewer} onLeaseChange={() => undefined} onSubmitTask={async () => undefined} />);
    await screen.findByTestId('review-task-task-1');
    expect((screen.getByTestId('review-approve') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('review-diff-task-1'));
    const diff = await screen.findByTestId('review-diff-content-task-1');
    expect(diff.textContent).toContain('object-1：changed · attributes');
    expect(diff.textContent).toContain('attributes: {"helmet":"unknown"} → {"helmet":"wearing"}');
    fireEvent.change(screen.getByLabelText('理由'), { target: { value: 'Verified' } });
    await waitFor(() => expect((screen.getByTestId('review-approve') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('review-approve'));
    await waitFor(() => expect(mocked.decide).toHaveBeenCalledWith('review-1', { decision: 'approve', reason: 'Verified', revision_ids: ['revision-current'] }));
    await waitFor(() => expect(screen.getByTestId('review-task-task-1').textContent).toContain('Verify helmet attribute'));
  });
  it('transfers through the project-admin route with the selected holder id', async () => {
    mocked.tasks.mockResolvedValue({ items: [{ ...task, assignee_id: 'annotator-2' }], next_cursor: null });
    const admin: Session = { ...annotator, user_id: 'admin-1', username: 'admin', project_roles: [{ project_id: 'project-1', role: 'admin' }] };
    render(<ReviewPanel projectId="project-1" session={admin} onLeaseChange={() => undefined} onSubmitTask={async (_task, submit) => { await submit('revision-1'); }} />);
    await screen.findByTestId('review-task-task-1');
    fireEvent.change(screen.getByLabelText('转交至项目标注者 ID'), { target: { value: 'annotator-3' } });
    fireEvent.click(screen.getByTestId('task-transfer-task-1'));
    await waitFor(() => expect(mocked.lease).toHaveBeenCalledWith('task-1', 'transfer', 'annotator-3'));
  });
});
