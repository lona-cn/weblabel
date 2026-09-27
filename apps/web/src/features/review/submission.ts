import type { EditorHost } from '../../lib/editor/EditorHost';
import type { ReviewTask } from './api';
import type { SaveQueue } from '../../lib/persistence/save-queue';


export function setReviewEditorLocked(input: {
  locked: boolean;
  state: { current: boolean };
  host: Pick<EditorHost, 'cancelGesture'> | null;
  surfaces: readonly (HTMLElement | null)[];
}): void {
  if (input.locked) {
    if (input.state.current) throw new Error('审核提交正在进行。');
    input.state.current = true;
    for (const surface of input.surfaces) surface?.setAttribute('inert', '');
    input.host?.cancelGesture();
    return;
  }
  for (const surface of input.surfaces) surface?.removeAttribute('inert');
  input.state.current = false;
}
export async function submitCurrentReviewRevision(input: {
  task: ReviewTask;
  queue: Pick<SaveQueue, 'flush' | 'getStatus'>;
  readHead: () => Promise<{ annotation_revision_id: string }>;
  submit: (revisionId: string) => Promise<void>;
  lockEditor: (locked: boolean) => void;
}): Promise<void> {
  const { task, queue, readHead, submit, lockEditor } = input;
  lockEditor(true);
  try {
    await queue.flush(task.asset_revision_id);
    const before = queue.getStatus(task.asset_revision_id);
    if (before.dirty || before.writes_paused || !['idle', 'synced'].includes(before.phase) || !before.base_revision_id) {
      throw new Error('本地标注尚未同步；审核提交已停止。');
    }
    const head = await readHead();
    const after = queue.getStatus(task.asset_revision_id);
    if (after.dirty || after.writes_paused || after.phase !== before.phase ||
      after.local_generation !== before.local_generation || after.synced_generation !== before.synced_generation ||
      after.base_revision_id !== before.base_revision_id || after.base_revision_id !== head.annotation_revision_id) {
      throw new Error('读取版本期间标注发生变化；审核提交已停止，请重试。');
    }
    await submit(head.annotation_revision_id);
  } finally {
    lockEditor(false);
  }
}
