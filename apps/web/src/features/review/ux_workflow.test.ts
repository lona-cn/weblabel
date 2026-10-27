import { describe, expect, it } from 'vitest';
import { confirmsSubmission, classifyWriteFailure, queueMatches } from './workflow';
import { ApiFailure } from '../../lib/t15/api';
import type { ReviewTask, TaskSubmission } from './api';
const task = { task_id: 't', project_id: 'p', assignee_id: 'a', state: 'open', review_decision: null } as ReviewTask;
const submission = { task_id: 't', submitted_by: 'a', revision_ids: ['r'], state: 'pending', lease_ended: true } as TaskSubmission;
describe('submission target-state readback', () => {
  it('requires the exact actor, task, revision and ended lease', () => {
    expect(confirmsSubmission(submission, { task, actor: 'a', revisionId: 'r' })).toBe(true);
    for (const changed of [{ submitted_by: 'b' }, { task_id: 'other' }, { revision_ids: ['r', 'other'] }, { revision_ids: ['old'] }, { lease_ended: false }, { state: 'rejected' }]) expect(confirmsSubmission({ ...submission, ...changed }, { task, actor: 'a', revisionId: 'r' })).toBe(false);
  });
  it('never treats transport failures or server errors as definite rejection', () => {
    expect(classifyWriteFailure(new Error('connection lost'))).toBe('unknown');
    expect(classifyWriteFailure(new ApiFailure(503, 'BUSY', 'busy'))).toBe('unknown');
    expect(classifyWriteFailure(new ApiFailure(409, 'TASK_NOT_OPEN', 'conflict'))).toBe('rejected');
  });
  it('filters my open work, returned work, review queue and ended tasks separately', () => {
    expect(queueMatches(task, 'mine', 'a')).toBe(true);
    expect(queueMatches(task, 'mine', 'b')).toBe(false);
    expect(queueMatches({ ...task, review_decision: 'reject' }, 'returned', 'a')).toBe(true);
    expect(queueMatches({ ...task, state: 'submitted' }, 'pending', 'b')).toBe(true);
    expect(queueMatches({ ...task, state: 'closed' }, 'closed', 'a')).toBe(true);
  });
});
