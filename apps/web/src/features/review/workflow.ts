import { ApiFailure } from '../../lib/t15/api';
import type { ReviewTask, TaskSubmission } from './api';
export type TaskQueue = 'all' | 'mine' | 'pending' | 'returned' | 'closed';
export type SubmissionTarget = Readonly<{ task: ReviewTask; actor: string; revisionId: string }>;
export function confirmsSubmission(value: TaskSubmission, target: SubmissionTarget): boolean {
  return value.task_id === target.task.task_id && value.submitted_by === target.actor &&
    value.revision_ids.length === 1 && value.revision_ids[0] === target.revisionId &&
    value.lease_ended === true && (value.state === 'pending' || value.state === 'approved');
}
export function classifyWriteFailure(error: unknown): 'rejected' | 'unknown' {
  return error instanceof ApiFailure && error.status >= 400 && error.status < 500 ? 'rejected' : 'unknown';
}
export function queueMatches(task: ReviewTask, queue: TaskQueue, actor: string): boolean {
  switch (queue) {
    case 'all': return true;
    case 'mine': return task.assignee_id === actor && task.state === 'open';
    case 'pending': return task.state === 'submitted';
    case 'returned': return task.state === 'open' && task.review_decision === 'reject';
    case 'closed': return task.state === 'closed';
  }
}
