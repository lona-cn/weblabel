// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { AuthEntry, SessionController } from '../../app/session';
import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import type { TaskQueue } from './workflow';
import { readRoute } from '../../app/route-state';
import { api } from '../../lib/t15/api';
import type { ReviewMountContext } from '../workbench/workbench-context';
import { reviewApi, type ReviewTask, type TaskSubmission } from './api';
import { mountReviewPanel } from './review-panel';
let serial = 0; const owners: AbortController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.abort()); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
function fixture() {
  const project = `native-review-${++serial}`; const session = { user_id: 'actor', username: 'actor', platform_admin: false, project_roles: [{ project_id: project, role: 'annotator' }] };
  let entry: AuthEntry = { kind: 'authenticated', session, createdUsername: null }; const authListeners = new Set<() => void>();
  const controller: SessionController = { getSnapshot: () => entry, subscribe: listener => { authListeners.add(listener); return () => authListeners.delete(listener); }, login: vi.fn(), bootstrap: vi.fn(), recover: vi.fn(), logout: vi.fn(), refresh: vi.fn(), dispose: vi.fn() };
  const task: ReviewTask = { task_id: 'task', project_id: project, asset_revision_id: 'image', ontology_version_id: 'ontology', assignee_id: 'actor', state: 'open', created_at: '2026-10-10', review_id: null, revision_ids: null, review_decision: null, review_reason: null };
  const submission: TaskSubmission = { review_id: 'review', task_id: task.task_id, submitted_by: session.user_id, revision_ids: ['revision-exact'], state: 'pending', created_at: '2026-10-10', lease_ended: true };
  const owner = new AbortController(); owners.push(owner); const root = document.createElement('div'); document.body.append(root);
  const onTaskOpen = vi.fn(), release = vi.fn(), validate = vi.fn(async () => true), leaseChange = vi.fn(), continueTask = vi.fn(async () => null);
  const ticket = { token: Symbol(), isCurrent: () => true, validateCurrent: validate, onTaskOpen, release };
  const scopeListeners = new Set<() => void>(); let externalQueue: TaskQueue = 'all';
  const context: ReviewMountContext = { session: controller, signal: owner.signal, navigate: vi.fn(), route: readRoute(new URL('http://localhost')), projectId: project, initialQueue: 'all', getQueue: () => externalQueue, getScope: () => ({ session: entry.kind === 'authenticated' ? entry.session : null, project: null, assets: [], ontologies: [], assetId: 'image', ontologyId: 'ontology' }), subscribe: listener => { scopeListeners.add(listener); return () => scopeListeners.delete(listener); }, setReviewViewOpen: vi.fn(), taskSession: { onPrepareTaskOpen: async () => ticket, onPrepareTaskCreate: async () => ticket, onLeaseChange: leaseChange, onSubmitTask: async (_task, submit) => submit('revision-exact'), onContinueTask: continueTask } };
  vi.spyOn(reviewApi, 'tasks').mockResolvedValue({ items: [task], next_cursor: null });
  const lease = vi.spyOn(reviewApi, 'lease').mockResolvedValue({ task_id: task.task_id, holder_id: 'actor', fencing_token: 7, expires_at_unix: Date.now() / 1000 + 60, lease_seconds: 60, heartbeat_seconds: 20 });
  const mount = () => mountReviewPanel(root, context);
  return { root, owner, task, context, mount, lease, submission, onTaskOpen, release, validate, leaseChange, continueTask, notify() { scopeListeners.forEach(listener => listener()); }, navigateQueue(value: TaskQueue) { externalQueue = value; scopeListeners.forEach(listener => listener()); }, logout() { entry = { kind: 'login', usernameHint: '' }; authListeners.forEach(listener => listener()); } };
}
function button(root: HTMLElement, name: string) { const value = [...root.querySelectorAll('button')].find(button => button.textContent === name); if (!value) throw new Error(`Missing button ${name}`); return value; }
it('does not acquire when the task-open barrier loses currency', async () => {
  const view = fixture(); view.validate.mockResolvedValue(false); view.mount();
  await vi.waitFor(() => expect(view.root.querySelector('[data-testid=task-submit]')).not.toBeNull()); button(view.root, '领取任务').click();
  await vi.waitFor(() => expect(view.release).toHaveBeenCalledTimes(1)); expect(view.lease).not.toHaveBeenCalled(); expect(view.onTaskOpen).not.toHaveBeenCalled();
});
it('keeps an unknown acquire fenced across readonly refresh and never renews or releases it', async () => {
  const view = fixture(); view.lease.mockRejectedValue(new TypeError('lost lease ACK')); const dispose = view.mount();
  await vi.waitFor(() => expect(view.root.querySelector('[data-testid=task-submit]')).not.toBeNull()); button(view.root, '领取任务').click();
  await vi.waitFor(() => expect(view.root.querySelector('[data-testid=task-claim-unknown]')).not.toBeNull());
  button(view.root, '刷新任务列表').click(); await vi.waitFor(() => expect(reviewApi.tasks).toHaveBeenCalledTimes(2));
  expect(button(view.root, '领取任务').disabled).toBe(true); button(view.root, '领取任务').click(); dispose(); expect(view.lease).toHaveBeenCalledTimes(1);
});
it('submits exactly the port revision and only readback can confirm unknown submission before continuing', async () => {
  const view = fixture(); const submit = vi.spyOn(reviewApi, 'submit').mockRejectedValue(new TypeError('lost submit ACK'));
  const readback = vi.spyOn(reviewApi, 'submission').mockResolvedValue({ ...view.submission, submitted_by: 'different-actor' }); const dispose = view.mount();
  await vi.waitFor(() => expect(view.root.querySelector('[data-testid=task-submit]')).not.toBeNull()); button(view.root, '领取任务').click();
  await vi.waitFor(() => expect(button(view.root, '同步并提交当前版本').disabled).toBe(false)); button(view.root, '同步并提交当前版本').click();
  await vi.waitFor(() => { expect(button(view.root, '只读核对提交').hidden).toBe(false); expect(button(view.root, '只读核对提交').disabled).toBe(false); }); expect(submit).toHaveBeenCalledWith('task', 'revision-exact');
  button(view.root, '只读核对提交').click(); await vi.waitFor(() => expect(readback).toHaveBeenCalledTimes(1));
  expect(button(view.root, '完成并继续').hidden).toBe(true); expect(view.continueTask).not.toHaveBeenCalled();
  readback.mockResolvedValue(view.submission); await vi.waitFor(() => expect(button(view.root, '只读核对提交').disabled).toBe(false)); button(view.root, '只读核对提交').click();
  await vi.waitFor(() => { expect(button(view.root, '完成并继续').hidden).toBe(false); expect(button(view.root, '完成并继续').disabled).toBe(false); }); button(view.root, '完成并继续').click();
  await vi.waitFor(() => expect(view.continueTask).toHaveBeenCalledTimes(1)); expect(submit).toHaveBeenCalledTimes(1); dispose(); expect(view.lease.mock.calls.filter(call => call[1] === 'release')).toHaveLength(0);
});
it('loads all queue filters through paging without interpreting a returned task as a lease', async () => {
  const view = fixture(); vi.mocked(reviewApi.tasks).mockResolvedValueOnce({ items: [view.task], next_cursor: 'page-2' }).mockResolvedValueOnce({ items: [{ ...view.task, task_id: 'returned', review_decision: 'reject', review_reason: '修正遮挡属性' }, { ...view.task, task_id: 'closed', state: 'closed' }], next_cursor: null }); view.mount();
  await vi.waitFor(() => expect(button(view.root, '继续读取任务').hidden).toBe(false)); button(view.root, '继续读取任务').click();
  await vi.waitFor(() => expect(view.root.textContent).toContain('已读取全部分页'));
  const queue = view.root.querySelector('select')!; queue.value = 'returned'; queue.dispatchEvent(new Event('change', { bubbles: true }));
  expect(view.root.querySelector('[data-testid=review-task-returned]')).not.toBeNull(); expect(view.root.querySelector('[data-testid=review-task-closed]')).toBeNull(); expect(view.lease).not.toHaveBeenCalled();
});
it('aborts owned readonly requests and fences a late task response after logout', async () => {
  const view = fixture(); let finish!: (value: { items: ReviewTask[]; next_cursor: null }) => void; let signal: AbortSignal | undefined;
  vi.mocked(reviewApi.tasks).mockImplementation((_project, _cursor, ownedSignal) => { signal = ownedSignal; return new Promise(resolve => { finish = resolve; }); });
  const dispose = view.mount(); view.logout(); expect(signal?.aborted).toBe(true); finish({ items: [view.task], next_cursor: null }); await Promise.resolve(); await Promise.resolve();
  expect(view.root.querySelector('[data-testid=task-submit]')).toBeNull(); dispose(); expect(view.lease).not.toHaveBeenCalled();
});

function admin(view: { context: ReviewMountContext; task: ReviewTask }) {
  view.context.getScope().session!.project_roles[0].role = 'admin';
  vi.spyOn(api, 'members').mockResolvedValue({ items: [{ user_id: 'actor', username: '本人', role: 'admin' }, { user_id: 'target', username: '接收者', role: 'annotator' }], next_cursor: null });
  vi.spyOn(api, 'ontologies').mockResolvedValue({ items: [{ project_id: view.task.project_id, ontology_version_id: 'ontology', version_no: 1, labels: [], guidelines_markdown: '', allow_out_of_bounds: false }], next_cursor: null });
  vi.spyOn(reviewApi, 'assetsPage').mockResolvedValue({ items: [{ project_id: view.task.project_id, asset_id: 'asset', asset_revision_id: 'image', original_name: 'image.png', original_sha256: 'a'.repeat(64), canonical_sha256: 'a'.repeat(64), canonical_width: 20, canonical_height: 20, exif_orientation: 1, original_to_canonical: [1, 0, 0, 0, 1, 0, 0, 0, 1], source_group_id: 'group' }], next_cursor: null });
}
function selectLabel(root: HTMLElement, name: string, value: string) {
  const select = [...root.querySelectorAll('label')].find(label => label.firstChild?.textContent === name)!.control as HTMLSelectElement;
  select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); return select;
}
it.each(['media', 'member'] as const)('preserves paged creation selections across %s refresh without treating unconfirmed choices as current', async kind => {
  const view = fixture(); admin(view);
  const image = { project_id: view.task.project_id, asset_id: 'asset', asset_revision_id: 'image', original_name: 'image.png', original_sha256: 'a'.repeat(64), canonical_sha256: 'a'.repeat(64), canonical_width: 20, canonical_height: 20, exif_orientation: 1, original_to_canonical: [1, 0, 0, 0, 1, 0, 0, 0, 1], source_group_id: 'group' };
  vi.mocked(reviewApi.assetsPage).mockImplementation(async (_project, cursor) => cursor ? { items: [{ ...image, asset_revision_id: 'later-image' }], next_cursor: null } : { items: [image], next_cursor: 'next' });
  vi.mocked(api.members).mockImplementation(async (_project, cursor) => cursor ? { items: [{ user_id: 'later-member', username: '后页成员', role: 'annotator' }], next_cursor: null } : { items: [{ user_id: 'actor', username: '本人', role: 'admin' }], next_cursor: 'next' });
  view.mount();
  const more = kind === 'media' ? '继续读取媒体' : '继续读取成员', refresh = kind === 'media' ? '刷新可选媒体' : '刷新可选成员';
  const label = kind === 'media' ? '图片版本' : '指派项目标注者', selected = kind === 'media' ? 'later-image' : 'later-member';
  await vi.waitFor(() => expect(button(view.root, more).hidden).toBe(false)); button(view.root, more).click();
  await vi.waitFor(() => expect(view.root.textContent).toContain(selected));
  const select = selectLabel(view.root, label, selected); expect(select.value).toBe(selected);
  button(view.root, refresh).click();
  await vi.waitFor(() => { expect(select.value).toBe(selected); expect(select.selectedOptions[0].disabled).toBe(true); });
  expect(button(view.root, '创建任务').disabled).toBe(true);
  expect(view.root.textContent).toContain('尚未在已读取分页中确认');
  button(view.root, more).click();
  await vi.waitFor(() => { expect(select.value).toBe(selected); expect(select.selectedOptions[0].disabled).toBe(false); });
  expect(button(view.root, '创建任务').disabled).toBe(false);
});
it('shows the confirmed task identity even when the refreshed page does not contain it', async () => {
  const view = fixture(); admin(view);
  vi.spyOn(reviewApi, 'createTask').mockResolvedValue({ task_id: 'created-task', project_id: view.task.project_id, asset_revision_id: 'image', ontology_version_id: 'ontology', assignee_id: 'target', state: 'open', created_at: '2026-10-10' });
  vi.mocked(reviewApi.tasks).mockResolvedValue({ items: [], next_cursor: 'later-page' }); view.mount();
  await vi.waitFor(() => expect(view.root.textContent).toContain('接收者 · target'));
  selectLabel(view.root, '图片版本', 'image'); selectLabel(view.root, '类别规范版本', 'ontology'); selectLabel(view.root, '指派项目标注者', 'target');
  view.root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(view.root.textContent).toContain('created-task'));
  expect(view.root.querySelector('[data-testid=task-create-unknown]')).toBeNull();
});

it('retains an unknown task creation target and does not create again after readonly refresh', async () => {
  const view = fixture(); admin(view); const create = vi.spyOn(reviewApi, 'createTask').mockRejectedValue(new TypeError('ACK lost')); view.mount();
  await vi.waitFor(() => expect(view.root.textContent).toContain('接收者 · target')); selectLabel(view.root, '图片版本', 'image'); selectLabel(view.root, '类别规范版本', 'ontology'); selectLabel(view.root, '指派项目标注者', 'target');
  view.root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(view.root.querySelector('[data-testid=task-create-unknown]')).not.toBeNull()); button(view.root, '刷新任务列表').click(); await vi.waitFor(() => expect(reviewApi.tasks).toHaveBeenCalledTimes(2));
  expect(button(view.root, '创建任务').disabled).toBe(true); view.root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); expect(create).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledWith(view.task.project_id, { project_id: view.task.project_id, asset_revision_id: 'image', ontology_version_id: 'ontology', assignee_id: 'target' });
});
it('keeps unknown transfer actor and target fixed while blocking all later lease writes', async () => {
  const view = fixture(); admin(view); view.lease.mockImplementation(async (taskId, action) => { if (action !== 'acquire') throw new TypeError('transfer ACK lost'); return { task_id: taskId, holder_id: 'actor', fencing_token: 7, expires_at_unix: Date.now() / 1000 + 60, heartbeat_seconds: 20, lease_seconds: 60 }; }); const dispose = view.mount();
  await vi.waitFor(() => expect(view.root.textContent).toContain('接收者 · target')); button(view.root, '领取任务').click(); await vi.waitFor(() => expect(button(view.root, '同步并提交当前版本').disabled).toBe(false));
  selectLabel(view.root, '转交至项目标注者', 'target'); button(view.root, '转交任务').click(); await vi.waitFor(() => expect(button(view.root, '释放当前任务').disabled).toBe(true));
  await vi.waitFor(() => expect(view.root.textContent).toContain('租约操作结果未知')); expect(view.lease).toHaveBeenLastCalledWith('task', 'transfer', 'target'); button(view.root, '释放当前任务').click(); dispose(); expect(view.lease).toHaveBeenCalledTimes(2);
});
it('does not let a task page started before a lease write overwrite its post-write refresh', async () => {
  const view = fixture(); view.mount(); await vi.waitFor(() => expect(view.root.querySelector('[data-testid=task-submit]')).not.toBeNull());
  let finish!: (value: { items: ReviewTask[]; next_cursor: null }) => void;
  vi.mocked(reviewApi.tasks).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce({ items: [view.task], next_cursor: null });
  button(view.root, '刷新任务列表').click(); button(view.root, '领取任务').click(); await vi.waitFor(() => expect(view.onTaskOpen).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(reviewApi.tasks).toHaveBeenCalledTimes(3)); finish({ items: [{ ...view.task, task_id: 'stale-pre-write-task' }], next_cursor: null }); await Promise.resolve(); await Promise.resolve();
  expect(view.root.querySelector('[data-testid=review-task-stale-pre-write-task]')).toBeNull(); expect(view.root.querySelector('[data-testid=review-task-task]')).not.toBeNull();
});

function submittedRevision(task: ReviewTask): AnnotationRevision {
  return { annotation_revision_id: 'review-revision', parent_revision_id: null, revision_no: 1, created_at: '2026-10-10', created_by: 'actor', content_hash: 'a'.repeat(64), document: { schema_version: 1, asset_revision_id: task.asset_revision_id, ontology_version_id: task.ontology_version_id, coordinate_space: { type: 'canonical_image_pixels', width: 20, height: 20 }, completion: 'complete', objects: [] } };
}
it('preserves a locally selected returned queue on ordinary notifications but follows changed external navigation', async () => {
  const view = fixture(); vi.mocked(reviewApi.tasks).mockResolvedValue({ items: [view.task, { ...view.task, task_id: 'returned', review_decision: 'reject' }], next_cursor: null }); view.mount();
  await vi.waitFor(() => expect(view.root.querySelector('[data-testid=review-task-returned]')).not.toBeNull());
  const queue = view.root.querySelector('select')!; queue.value = 'returned'; queue.dispatchEvent(new Event('change')); view.notify();
  expect(queue.value).toBe('returned'); expect(view.root.querySelector('[data-testid=review-task-task]')).toBeNull();
  view.navigateQueue('mine'); expect(queue.value).toBe('mine'); expect(view.root.querySelector('[data-testid=review-task-task]')).not.toBeNull();
});
it('aborts child image reads on logout and never publishes a late image URL', async () => {
  const view = fixture(); admin(view); Object.assign(view.task, { state: 'submitted', review_id: 'review', revision_ids: ['review-revision'] });
  vi.spyOn(reviewApi, 'revision').mockResolvedValue(submittedRevision(view.task)); vi.spyOn(reviewApi, 'issues').mockResolvedValue({ items: [], next_cursor: null });
  let finish!: (value: Blob) => void; let signal: AbortSignal | undefined;
  vi.spyOn(api, 'image').mockImplementation((_id, ownedSignal) => { signal = ownedSignal; return new Promise(resolve => { finish = resolve; }); });
  const create = vi.fn(() => 'blob:late'); const NativeURL = URL; vi.stubGlobal('URL', class extends NativeURL { static createObjectURL = create; static revokeObjectURL = vi.fn(); });
  view.mount(); await vi.waitFor(() => expect(button(view.root, '查看审核差异').disabled).toBe(false)); button(view.root, '查看审核差异').click();
  await vi.waitFor(() => expect(api.image).toHaveBeenCalledTimes(1)); view.logout(); expect(signal?.aborted).toBe(true);
  finish(new Blob(['late'])); await Promise.resolve(); await Promise.resolve(); expect(create).not.toHaveBeenCalled(); expect(view.root.querySelector('svg')).toBeNull();
});
it('disposes removed review presentations and preserves unsent reason drafts across queue eviction', async () => {
  const view = fixture(); admin(view); Object.assign(view.task, { state: 'submitted', review_id: 'review', revision_ids: ['review-revision'] });
  vi.spyOn(reviewApi, 'revision').mockResolvedValue(submittedRevision(view.task)); vi.spyOn(reviewApi, 'issues').mockResolvedValue({ items: [], next_cursor: null });
  let imageSignal: AbortSignal | undefined; vi.spyOn(api, 'image').mockImplementation(async (_id, signal) => { imageSignal = signal; return new Blob(['image']); });
  const revoke = vi.fn(); const NativeURL = URL; vi.stubGlobal('URL', class extends NativeURL { static createObjectURL() { return 'blob:review-row'; } static revokeObjectURL = revoke; });
  view.mount(); await vi.waitFor(() => expect(button(view.root, '查看审核差异').disabled).toBe(false)); button(view.root, '查看审核差异').click(); await vi.waitFor(() => expect(view.root.querySelector('svg')).not.toBeNull());
  const reason = view.root.querySelector('textarea')!; reason.value = '尚未提交的具体理由'; reason.dispatchEvent(new Event('input'));
  const queue = view.root.querySelector('select')!; queue.value = 'closed'; queue.dispatchEvent(new Event('change'));
  expect(imageSignal?.aborted).toBe(true); expect(revoke).toHaveBeenCalledWith('blob:review-row'); queue.value = 'pending'; queue.dispatchEvent(new Event('change'));
  expect(view.root.querySelector('textarea')?.value).toBe('尚未提交的具体理由');
  vi.mocked(reviewApi.tasks).mockResolvedValue({ items: [], next_cursor: null }); button(view.root, '刷新任务列表').click(); await vi.waitFor(() => expect(view.root.querySelector('[data-testid=review-task-task]')).toBeNull());
});
