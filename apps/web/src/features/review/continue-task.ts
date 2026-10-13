import type { Session } from '../../lib/t15/api';
import type { ReviewTask, TaskSubmission } from './api';
import { confirmsSubmission } from './workflow';
type ReadApi = {
  session(): Promise<Session>;
  submission(taskId: string): Promise<TaskSubmission>;
  tasks(projectId: string, cursor: string | null): Promise<{ items: ReviewTask[]; next_cursor: string | null }>;
};
export async function nextAssignedTask(input: {
  task: ReviewTask; submission: TaskSubmission; actorId: string; projectId: string;
  isCurrent(): boolean; read: ReadApi;
}): Promise<ReviewTask | null> {
  const { task, submission, actorId, projectId, read } = input;
  const check = () => {
    if (!input.isCurrent() || task.project_id !== projectId || submission.task_id !== task.task_id ||
      submission.submitted_by !== actorId || submission.revision_ids.length !== 1 || !submission.lease_ended) {
      throw new Error('身份、固定任务或本地保存围栏已变化；保持当前上下文。');
    }
  };
  check();
  const session = await read.session(); check();
  if (session.user_id !== actorId || !session.project_roles.some(role => role.project_id === projectId && ['admin', 'annotator'].includes(role.role))) {
    throw new Error('当前身份已没有领取本项目标注任务的权限。');
  }
  const actual = await read.submission(task.task_id); check();
  if (actual.review_id !== submission.review_id || !confirmsSubmission(actual, { task, actor: actorId, revisionId: submission.revision_ids[0] })) {
    throw new Error('原固定提交或租约终结未得到只读确认；不会重发提交或自动释放。');
  }
  let cursor: string | null = null;
  const cursors = new Set<string>();
  do {
    const page = await read.tasks(projectId, cursor); check();
    const next = page.items.find(item => item.project_id === projectId && item.assignee_id === actorId && item.state === 'open' && item.task_id !== task.task_id);
    if (next) return next;
    cursor = page.next_cursor;
    if (cursor && cursors.has(cursor)) throw new Error('任务分页游标重复，不能可靠选择下一任务。');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return null;
}
