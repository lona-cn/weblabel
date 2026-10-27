import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import { api, type ApiMedia, type Session } from '../../lib/t15/api';
import type { ReviewMountContext } from '../workbench/workbench-context';
import { reviewApi, type ReviewTask, type TaskCreateTarget, type TaskSubmission, type ReviewIssue } from './api';
import type { LocalTaskLease, TaskContinuationProof, TaskOpenPreparation, TaskContinueResult } from './task-session-port';
import { classifyWriteFailure, confirmsSubmission, queueMatches, type SubmissionTarget, type TaskQueue } from './workflow';
import { element, actions, field, options, details, lifetime, createAuthorizedReadScope } from '../import-export/delivery-dom';
import { diagnosticText as failureText } from '../import-export/loss-report';
import { mountReviewList } from './review-list';
import { assertRevision, mountRevisionReviewView } from './revision-review-view';
import { createDialog } from '../../ui/dialog';

type LeaseWrite = { taskId: string; action: 'acquire' | 'renew' | 'release' | 'transfer'; actor: string; holderId?: string };
type Decision = { taskId: string; actor: string; reviewId: string; decision: 'approve' | 'reject'; reason: string; revisionIds: string[] };
type Retained = { create: TaskCreateTarget | null; leaseWrite: LeaseWrite | null; pending: SubmissionTarget | null; confirmed: { target: SubmissionTarget; submission: TaskSubmission } | null; decisions: Map<string, Decision> };
// Original uncertain writes survive panel disposal. No write is repeated by a refresh.
const retained = new Map<string, Retained>();
export function mountReviewPanel(root: HTMLElement, context: ReviewMountContext): () => void {
  const life = lifetime(context.signal), port = context.taskSession;
  const action = actions(life.signal);
  const initial = context.getScope().session; const actor = initial?.user_id ?? ''; const identity = JSON.stringify([context.projectId, actor]);
  let state = retained.get(identity); if (!state) { state = { create: null, leaseWrite: null, pending: null, confirmed: null, decisions: new Map() }; retained.set(identity, state); }
  const writes = state;
  let session: Session | null = initial, role = initial?.project_roles.find(item => item.project_id === context.projectId)?.role;
  const authorization = JSON.stringify([initial?.user_id, initial?.platform_admin, initial?.project_roles]);
  let validScope = true, busy = false, taskLoading = false, taskRead = 0, tasksReady = false, taskCursor: string | null = null;
  let tasks: ReviewTask[] = [], queue: TaskQueue = context.initialQueue, lease: LocalTaskLease | null = null;
  let externalQueue = context.getQueue();
  const reasonDrafts = new Map<string, string>();
  const transferDrafts = new Map<string, string>();
  let members: { user_id: string; username: string; role: string }[] = [], media: ApiMedia[] = [], ontologies: OntologyVersion[] = [];
  let assetsSource: readonly ApiMedia[] | null = null, ontologiesSource: readonly OntologyVersion[] | null = null, membersSource: typeof members | null = null;
  let assetNames = new Map<string, string>(), ontologyNames = new Map<string, string>(), memberNames = new Map<string, string>(), memberSignature = '';
  let memberCursor: string | null = null, mediaCursor: string | null = null, membersReady = false, mediaReady = false;
  const pageBusy = new Set<string>(); const timers = new Set<number>(); let renewal: number | null = null;
  const panel = element('section', undefined, 'native-delivery'); panel.setAttribute('aria-label', '任务与审核');
  const title = element('h2', '任务与审核'); title.tabIndex = -1; const status = element('div'); status.setAttribute('role', 'status');
  const error = element('p'); error.setAttribute('role', 'alert'); error.dataset.testid = 'review-error'; error.hidden = true;
  const toolbar = element('div', undefined, 'delivery-toolbar'); const filter = element('select'); const summary = element('p');
  options(filter, [{ value: 'all', text: '全部' }, { value: 'mine', text: '我的待办' }, { value: 'pending', text: '待审核' }, { value: 'returned', text: '退回' }, { value: 'closed', text: '结束' }], queue);
  const refreshButton = action('刷新任务列表', () => { if (current() && !busy) void refresh().catch(fail); }, 'task-list-refresh');
  const more = action('继续读取任务', () => { if (taskCursor && !busy && !taskLoading) void refresh(taskCursor).catch(fail); });
  toolbar.append(refreshButton, field('任务队列', filter), more); const unknown = element('div');
  const releaseButton = action('释放当前任务', () => void perform(async () => { const held = lease; if (!held || fenced()) return false; await mutateLease(held.task_id, 'release'); if (current() && lease === held) install(null); }));
  const submitCheck = action('只读核对提交', () => void perform(async () => {
    const target = writes.pending; if (!target) return false;
    const observed = await reviewApi.submission(target.task.task_id, reads.signal); if (!current()) return false;
    if (!confirmsSubmission(observed, target)) throw new Error('尚未确认同一身份、固定版本与租约终结；保持原工作，不重发。');
    writes.pending = null; writes.confirmed = { target, submission: observed }; install(null);
    fail(new Error('已核对目标状态；这不是原 POST 的唯一归因或幂等回执。'));
  }));
  const nextButton = action('完成并继续', () => void continueTask());
  const creation = element('form'); const assetSelect = element('select'), ontologySelect = element('select'), assigneeSelect = element('select');
  for (const select of [assetSelect, ontologySelect, assigneeSelect]) select.required = true;
  const mediaRefresh = action('刷新可选媒体', () => void loadPage('media', null), 'task-media-refresh');
  const mediaMore = action('继续读取媒体', () => void loadPage('media', mediaCursor), 'task-media-more');
  const memberRefresh = action('刷新可选成员', () => void loadPage('members', null), 'task-members-refresh');
  const memberMore = action('继续读取成员', () => void loadPage('members', memberCursor), 'task-members-more');
  const selectionNote = element('p'); selectionNote.setAttribute('role', 'status');
  const createButton = element('button', '创建任务'); createButton.type = 'submit'; createButton.className = 'primary';
  creation.append(field('图片版本', assetSelect), mediaRefresh, mediaMore, field('类别规范版本', ontologySelect), field('指派项目标注者', assigneeSelect), memberRefresh, memberMore, selectionNote, createButton);
  for (const select of [assetSelect, assigneeSelect]) select.addEventListener('change', render, { signal: life.signal });
  const creationDetails = element('details', undefined, 'review-task-creation'); creationDetails.append(element('summary', '创建标注任务'), creation);
  const listRoot = element('div', undefined, 'review-task-list'); const columns = element('div', undefined, 'review-task-columns'); columns.setAttribute('aria-hidden', 'true');
  for (const label of ['任务', '图片', '固定规范', '标注者', '状态', '提交版本', '租约信息', '操作']) columns.append(element('span', label));
  listRoot.append(columns); const rowViews = new Map<string, { task: ReviewTask; node: HTMLElement; update(): void; dispose(): void }>();
  const list = mountReviewList<ReviewTask>(listRoot, '项目任务', task => task.task_id, renderTask, life.signal, id => {
    rowViews.get(id)?.dispose(); rowViews.delete(id);
  });
  panel.append(title, toolbar, summary, status, error, unknown, releaseButton, submitCheck, nextButton, creationDetails, listRoot, element('p', '任务每20秒续期，60秒未续期会释放。审核只绑定提交的固定版本；新head不继承旧批准。')); root.append(panel);
  const reads = createAuthorizedReadScope(life.signal, context.session, context.projectId, () => {
    validScope = false; taskRead++; taskLoading = false;
    for (const timer of timers) clearTimeout(timer); timers.clear();
    list.update([]); port.onLeaseChange(null); render();
  });
  life.add(reads.dispose);
  function current() {
    if (!life.alive || !validScope) return false;
    const scoped = context.getScope().session;
    if (JSON.stringify([scoped?.user_id, scoped?.platform_admin, scoped?.project_roles]) !== authorization) { reads.revoke(); return false; }
    return reads.current();
  }
  function fenced() { return !!(writes.pending || writes.confirmed || writes.leaseWrite); }
  function fail(reason: unknown) { if (!life.alive) return; error.hidden = false; error.textContent = failureText(reason); }
  function render() {
    if (!life.alive) return;
    panel.setAttribute('aria-busy', String(busy));
    refreshButton.disabled = busy || taskLoading || !current(); more.hidden = taskCursor === null; more.disabled = busy || taskLoading || !current(); filter.disabled = !current(); filter.value = queue;
    summary.textContent = `当前项目已加载 ${tasks.length} 项；${tasksReady && taskCursor === null ? '已读取全部分页（读取时点，非全站统计）' : '尚未读取全部分页，计数仅限已加载任务'}。`;
    status.textContent = !current() ? '身份或权限已变化；原请求保留，当前面板只读。' : lease ? fenced() ? '原操作待核对，已暂停续期与租约写入。' : `已领取 ${lease.task_id}，每20秒自动续期。` : '列表不含租约证明，不能从任务状态推断租约。';
    if (lease) status.dataset.testid = 'active-task-lease'; else delete status.dataset.testid;
    releaseButton.hidden = !lease; releaseButton.disabled = busy || fenced() || !current();
    submitCheck.hidden = !writes.pending; submitCheck.disabled = busy || !current(); nextButton.hidden = !writes.confirmed || !port.onContinueTask; nextButton.disabled = busy || !!writes.leaseWrite || !current() || !['admin', 'annotator'].includes(role ?? '');
    unknown.replaceChildren();
    for (const [name, value] of [['创建结果尚未确认；不能重复创建', writes.create], ['租约操作结果未知；任务刷新不会解锁租约写入', writes.leaseWrite], ['提交结果未知；固定原请求只读核对', writes.pending]] as const) if (value) { const block = element('section'); if (value === writes.create) block.dataset.testid = 'task-create-unknown'; if (value === writes.leaseWrite && writes.leaseWrite?.action === 'acquire') block.dataset.testid = 'task-claim-unknown'; block.append(element('p', name), details('固定原请求', value), action('只读核对任务', () => { if (current() && !busy) void refresh().catch(fail); })); unknown.append(block); }
    creationDetails.hidden = creation.hidden = role !== 'admin';
    const staleMedia = !!assetSelect.value && !media.some(item => item.asset_revision_id === assetSelect.value);
    const staleMember = !!assigneeSelect.value && !members.some(item => item.user_id === assigneeSelect.value);
    selectionNote.hidden = !staleMedia && !staleMember;
    selectionNote.textContent = staleMedia || staleMember ? `所选${[staleMedia && '图片', staleMember && '成员'].filter(Boolean).join('和')}尚未在已读取分页中确认；请继续读取或重新选择后创建。` : '';
    for (const select of [assetSelect, ontologySelect, assigneeSelect]) select.disabled = busy || !!writes.create || !current();
    createButton.disabled = busy || !!writes.create || !current() || staleMedia || staleMember;
    mediaMore.hidden = mediaReady && mediaCursor === null; memberMore.hidden = membersReady && memberCursor === null;
    for (const button of [mediaRefresh, mediaMore, memberRefresh, memberMore]) button.disabled = busy || pageBusy.size > 0 || !current();
    const scope = context.getScope();
    if (scope.assets !== assetsSource) { assetsSource = scope.assets; assetNames = new Map(scope.assets.map(item => [item.asset_revision_id, item.original_name])); }
    if (scope.ontologies !== ontologiesSource) { ontologiesSource = scope.ontologies; ontologyNames = new Map(scope.ontologies.map(item => [item.ontology_version_id, `ontology ${item.version_no}`])); }
    if (members !== membersSource) { membersSource = members; memberNames = new Map(members.map(item => [item.user_id, item.username])); memberSignature = JSON.stringify(members); }
    const visible = current() ? tasks.filter(task => queueMatches(task, queue, actor)) : [];
    columns.hidden = !visible.length; list.update(visible); for (const view of rowViews.values()) view.update();
  }
  async function refresh(cursor: string | null = null) {
    if (!current() || taskLoading) return; const sequence = ++taskRead; taskLoading = true; render();
    try { const page = await reviewApi.tasks(context.projectId, cursor, reads.signal); if (!current() || sequence !== taskRead) return;
      if (page.items.some(task => task.project_id !== context.projectId) || (page.next_cursor !== null && page.next_cursor === cursor)) throw new Error('任务分页范围无效。');
      tasks = cursor === null ? page.items : [...new Map([...tasks, ...page.items].map(task => [task.task_id, task])).values()]; taskCursor = page.next_cursor; tasksReady = true;
    } finally { if (life.alive && sequence === taskRead) { taskLoading = false; render(); } }
  }
  function updateChoices(select: HTMLSelectElement, rows: { value: string; text: string; disabled?: boolean }[]) {
    const selected = select.value, previous = select.selectedOptions[0];
    if (selected && previous && !rows.some(row => row.value === selected)) rows.push({ value: selected, text: previous.text, disabled: true });
    options(select, rows, selected);
  }
  async function loadPage(kind: 'members' | 'media', cursor: string | null) {
    if (!current() || role !== 'admin' || busy || pageBusy.has(kind)) return; pageBusy.add(kind); render();
    try {
      if (kind === 'members') {
        const page = await api.members(context.projectId, cursor, reads.signal); if (!current()) return;
        const qualified = page.items.filter(item => ['admin', 'annotator'].includes(item.role));
        members = cursor === null ? qualified : [...new Map([...members, ...qualified].map(item => [item.user_id, item])).values()];
        memberCursor = page.next_cursor; membersReady = true;
        updateChoices(assigneeSelect, [{ value: '', text: '选择项目成员' }, ...members.map(item => ({ value: item.user_id, text: `${item.username} · ${item.user_id}` }))]);
      } else {
        const page = await reviewApi.assetsPage(context.projectId, cursor, reads.signal); if (!current()) return;
        if (page.items.some(item => item.project_id !== context.projectId)) throw new Error('媒体范围不匹配。');
        media = cursor === null ? page.items : [...new Map([...media, ...page.items].map(item => [item.asset_revision_id, item])).values()];
        mediaCursor = page.next_cursor; mediaReady = true;
        updateChoices(assetSelect, [{ value: '', text: '选择图片版本' }, ...media.map(item => ({ value: item.asset_revision_id, text: `${item.original_name} · ${item.asset_revision_id}` }))]);
      }
    } catch (reason) { if (current()) fail(reason); } finally { pageBusy.delete(kind); render(); }
  }
  async function perform(run: () => Promise<unknown>) {
    if (!current() || busy) return;
    // A pre-write task page cannot overwrite the post-write observation.
    taskRead++; taskLoading = false; busy = true; error.hidden = true; render();
    try { const result = await run(); if (current() && result !== false) { try { await refresh(); } catch (reason) { fail(new Error(`写入已确认，刷新失败；不要重发。${failureText(reason)}`)); } } }
    catch (reason) { if (current()) fail(reason); } finally { busy = false; render(); scheduleRenewal(); }
  }
  function install(next: LocalTaskLease | null) { if (!current()) return; lease = next; port.onLeaseChange(next); scheduleRenewal(); render(); }
  function scheduleRenewal() {
    if (renewal !== null) { clearTimeout(renewal); timers.delete(renewal); renewal = null; }
    if (!current() || !lease || busy || fenced()) return;
    const held = lease; renewal = window.setTimeout(() => { timers.delete(renewal!); renewal = null; if (!current() || lease !== held || busy || fenced()) return; void perform(async () => {
      writes.leaseWrite = { taskId: held.task_id, action: 'renew', actor };
      try { const result = await reviewApi.lease(held.task_id, 'renew'); if (result.task_id !== held.task_id || result.holder_id !== actor || result.fencing_token !== held.fencing_token || result.expires_at_unix <= Date.now() / 1000) throw new Error('续期响应身份无法确认。'); writes.leaseWrite = null; }
      catch (reason) { if (classifyWriteFailure(reason) === 'rejected') { writes.leaseWrite = null; install(null); } throw reason; } return false;
    }); }, 20_000); timers.add(renewal);
  }
  async function mutateLease(taskId: string, action: 'release' | 'transfer', holderId?: string) {
    if (!current() || writes.leaseWrite) throw new Error('先只读核对原租约操作，不能重发。');
    writes.leaseWrite = { taskId, action, actor, ...(holderId ? { holderId } : {}) }; render();
    try { const result = await reviewApi.lease(taskId, action, holderId); if (result.task_id !== taskId || (action === 'transfer' && result.holder_id !== holderId) || (action === 'release' && result.holder_id !== null)) throw new Error('租约响应身份无法确认。'); writes.leaseWrite = null; }
    catch (reason) { if (classifyWriteFailure(reason) === 'rejected') writes.leaseWrite = null; throw reason; }
  }
  async function acquire(task: ReviewTask, proof?: TaskContinuationProof) {
    if (!current() || !['admin', 'annotator'].includes(role ?? '') || task.project_id !== context.projectId || task.state !== 'open' || (task.assignee_id !== actor && !session?.platform_admin) || fenced()) return;
    await perform(async () => {
      const previous = lease; let ticket: TaskOpenPreparation | null = null; let acquired: LocalTaskLease | null = null;
      try {
        ticket = await port.onPrepareTaskOpen(task, proof); const ready = () => current() && ticket!.isCurrent();
        if (!ready() || lease !== previous || !await ticket.validateCurrent() || !ready()) return false;
        if (previous) { await mutateLease(previous.task_id, 'release'); if (!ready() || lease !== previous) return false; install(null); }
        if (!ready() || !await ticket.validateCurrent() || !ready()) return false;
        writes.leaseWrite = { taskId: task.task_id, action: 'acquire', actor }; render();
        let result;
        try { result = await reviewApi.lease(task.task_id, 'acquire'); }
        catch (reason) { if (classifyWriteFailure(reason) === 'rejected') writes.leaseWrite = null; throw reason; }
        if (result.task_id !== task.task_id || result.holder_id !== actor || !Number.isSafeInteger(result.fencing_token) || result.fencing_token < 1 || result.expires_at_unix <= Date.now() / 1000) throw new Error('领取响应不能确认，暂停租约写入。');
        acquired = { asset_revision_id: task.asset_revision_id, ontology_version_id: task.ontology_version_id, task_id: task.task_id, fencing_token: result.fencing_token };
        if (!ready() || !await ticket.validateCurrent() || !ready()) return false;
        writes.leaseWrite = null; install(acquired); ticket.onTaskOpen(task, acquired); acquired = null;
      } finally {
        ticket?.release();
        if (acquired && current()) { writes.leaseWrite = null; await mutateLease(acquired.task_id, 'release'); }
      }
    });
  }
  creation.addEventListener('submit', event => { event.preventDefault();
    if (!current() || role !== 'admin' || writes.create || !members.some(item => item.user_id === assigneeSelect.value) || !media.some(item => item.asset_revision_id === assetSelect.value) || !ontologies.some(item => item.ontology_version_id === ontologySelect.value)) return;
    const target: TaskCreateTarget = Object.freeze({ project_id: context.projectId, asset_revision_id: assetSelect.value, ontology_version_id: ontologySelect.value, assignee_id: assigneeSelect.value });
    void perform(async () => { const ticket = await port.onPrepareTaskCreate(target); try { if (!current() || !ticket.isCurrent() || !await ticket.validateCurrent() || !current() || !ticket.isCurrent()) return false;
      writes.create = target; render(); try { await reviewApi.createTask(context.projectId, target); writes.create = null; } catch (reason) { if (classifyWriteFailure(reason) === 'rejected') writes.create = null; throw reason; }
    } finally { ticket.release(); } });
  }, { signal: life.signal });
  async function submit(task: ReviewTask) {
    if (!current() || fenced() || lease?.task_id !== task.task_id || lease.asset_revision_id !== task.asset_revision_id || lease.ontology_version_id !== task.ontology_version_id) return;
    await perform(async () => { const held = lease;
      await port.onSubmitTask(task, async revisionId => { if (!current() || lease !== held || !revisionId) throw new Error('提交期间任务范围已变化。');
        const target: SubmissionTarget = Object.freeze({ task: { ...task }, actor, revisionId }); writes.pending = target; render();
        let response: TaskSubmission; try { response = await reviewApi.submit(task.task_id, revisionId); } catch (reason) { if (classifyWriteFailure(reason) === 'rejected') writes.pending = null; throw reason; }
        if (!confirmsSubmission(response, target)) throw new Error('提交响应未确认固定版本与租约终结；只读核对。');
        writes.pending = null; writes.confirmed = { target, submission: response }; if (current() && lease === held) install(null);
      });
    });
  }
  async function continueTask() {
    const confirmed = writes.confirmed; if (!confirmed || !port.onContinueTask || !current() || busy || writes.leaseWrite || !['admin', 'annotator'].includes(role ?? '')) return;
    let next: TaskContinueResult | null = null;
    await perform(async () => { if (!confirmsSubmission(confirmed.submission, confirmed.target)) return false; next = await port.onContinueTask!({ task: confirmed.target.task, submission: confirmed.submission, isCurrent: current }); return false; });
    if (!current() || writes.confirmed !== confirmed) return;
    if (!next) { fail(new Error('固定版本已提交且租约已终结；队列没有下一项可领取任务。')); return; }
    const candidate = next as { task: ReviewTask; proof: TaskContinuationProof };
    if (candidate.task.project_id !== context.projectId || candidate.task.assignee_id !== actor || candidate.task.state !== 'open' || candidate.task.task_id === confirmed.target.task.task_id) { fail(new Error('下一任务范围无效，未领取。')); return; }
    writes.confirmed = null; await acquire(candidate.task, candidate.proof); if (current() && lease?.task_id !== candidate.task.task_id) writes.confirmed = confirmed; render();
  }
  function renderTask(task: ReviewTask): HTMLElement {
    const cached = rowViews.get(task.task_id); if (cached) { cached.task = task; cached.update(); return cached.node; }
    const rowLife = lifetime(reads.signal), action = actions(rowLife.signal);
    const node = element('article', undefined, 'review-task-row'); node.dataset.testid = `review-task-${task.task_id}`;
    const cell = (label: string) => { const wrapper = element('div', undefined, 'review-task-cell'), name = element('span', label + '：', 'review-task-cell-label'), value = element('span', undefined, 'review-task-cell-value'); wrapper.append(name, value); return { wrapper, value }; };
    const taskCell = cell('任务'), imageCell = cell('图片'), ontologyCell = cell('固定规范'), assigneeCell = cell('标注者'), stateCell = cell('状态'), revisionCell = cell('提交版本'), leaseCell = cell('租约信息');
    const conclusion = element('small', undefined, 'review-task-conclusion'), controls = element('div', undefined, 'review-task-actions'); stateCell.wrapper.append(conclusion);
    const transfer = element('select'); let transferMembers = '';
    transfer.addEventListener('change', () => { transferDrafts.set(task.task_id, transfer.value); }, { signal: rowLife.signal });
    const claim = action('领取任务', () => void acquire(view.task)); const submitButton = action('同步并提交当前版本', () => void submit(view.task), 'task-submit');
    const transferButton = action('转交任务', () => { const target = transfer.value; if (!current() || role !== 'admin' || fenced() || !members.some(item => item.user_id === target)) return; void perform(async () => { await mutateLease(view.task.task_id, 'transfer', target); if (lease?.task_id === view.task.task_id) install(null); }); }, `task-transfer-${task.task_id}`);
    const diffButton = action('查看审核差异', () => { if (snapshot) openExpanded(); else void loadDiff(); }, `review-diff-${task.task_id}`); const diffRoot = element('div'); diffRoot.dataset.testid = `review-diff-content-${task.task_id}`;
    const reason = element('textarea'); reason.required = true; reason.value = reasonDrafts.get(task.task_id) ?? (task.review_id ? writes.decisions.get(task.review_id)?.reason : '') ?? ''; const unknownDecision = element('div');
    const approve = action('批准', () => void decide('approve'), 'review-approve'), reject = action('退回', () => void decide('reject'), 'review-reject');
    const reviewControls = element('div', undefined, 'review-decision'); reviewControls.append(field('理由', reason), unknownDecision, approve, reject);
    const transferDetails = element('details', undefined, 'review-task-transfer'); transferDetails.append(element('summary', '转交'), field('转交至项目标注者', transfer), transferButton);
    controls.append(claim, submitButton, transferDetails, diffButton); diffRoot.hidden = true; reviewControls.hidden = true;
    node.append(taskCell.wrapper, imageCell.wrapper, ontologyCell.wrapper, assigneeCell.wrapper, stateCell.wrapper, revisionCell.wrapper, leaseCell.wrapper, controls, diffRoot, reviewControls);
    let snapshot: { reviewId: string; revision: AnnotationRevision; parent: AnnotationRevision | null; issues: ReviewIssue[] } | null = null, diffDispose: (() => void) | null = null, loading = false;
    let expandedDialog: ReturnType<typeof createDialog> | null = null, expandedFooter: HTMLElement | null = null, expandedContext: HTMLElement | null = null, expanded = false;
    let returnScroll: { element: Element; top: number; left: number } | null = null;
    function restoreExpanded() {
      if (!expanded) return;
      expanded = false; diffRoot.hidden = true; reviewControls.hidden = true; node.append(diffRoot, reviewControls);
      if (rowLife.alive) context.setReviewViewOpen(false);
      else queueMicrotask(() => context.setReviewViewOpen(false));
      if (returnScroll && rowLife.alive && panel.isConnected) { returnScroll.element.scrollTop = returnScroll.top; returnScroll.element.scrollLeft = returnScroll.left; }
      returnScroll = null;
    }
    function openExpanded() {
      const fixed = view.task;
      if (!current() || !rowLife.alive || expanded || !snapshot || snapshot.reviewId !== fixed.review_id || fixed.revision_ids?.length !== 1 || fixed.revision_ids[0] !== snapshot.revision.annotation_revision_id) return;
      if (!expandedDialog) {
        const dialog = createDialog({ id: `review-expanded-${fixed.task_id}`, title: '审核差异', testId: 'review-expanded', signal: rowLife.signal, fallbackFocus: () => panel.querySelector<HTMLElement>('[data-testid="task-list-refresh"]') });
        dialog.element.classList.add('native-delivery', 'review-expanded'); dialog.content.classList.add('review-expanded-content');
        const heading = dialog.element.querySelector('h2')!; heading.tabIndex = -1; heading.setAttribute('autofocus', '');
        const close = dialog.element.querySelector<HTMLButtonElement>('button')!; close.textContent = '返回任务队列';
        expandedContext = element('p', undefined, 'review-expanded-context'); dialog.element.insertBefore(expandedContext, dialog.content);
        expandedFooter = element('footer', undefined, 'review-expanded-footer'); expandedFooter.append(close); dialog.element.append(expandedFooter);
        (panel.closest('.r07-workbench') ?? panel).append(dialog.element);
        dialog.element.addEventListener('close', restoreExpanded, { signal: rowLife.signal }); expandedDialog = dialog;
      }
      expandedContext!.textContent = `任务 ${fixed.task_id} · 图片 ${fixed.asset_revision_id} · 规范 ${fixed.ontology_version_id} · 固定提交 ${snapshot.revision.annotation_revision_id} · 基线 ${snapshot.parent?.annotation_revision_id ?? '无父版本'}`;
      const scrolling = document.scrollingElement;
      if (scrolling) { returnScroll = { element: scrolling, top: scrolling.scrollTop, left: scrolling.scrollLeft }; scrolling.scrollTop = 0; scrolling.scrollLeft = 0; }
      expanded = true; diffRoot.hidden = false; expandedDialog.content.append(diffRoot); expandedFooter!.prepend(reviewControls); view.update();
      try { expandedDialog.open(diffButton); }
      catch (cause) { restoreExpanded(); throw cause; }
      context.setReviewViewOpen(true);
    }
    const view = { task, node, update() {
      const value = view.task; const states: Record<string, string> = { open: '待标注', submitted: '待审核', closed: '已结束' };
      const name = assetNames.get(value.asset_revision_id), norm = ontologyNames.get(value.ontology_version_id), assignee = value.assignee_id === actor ? session?.username : memberNames.get(value.assignee_id);
      taskCell.value.textContent = value.task_id; taskCell.value.title = value.task_id;
      imageCell.value.textContent = name ?? value.asset_revision_id; imageCell.value.title = name ? `${name} · ${value.asset_revision_id}` : value.asset_revision_id;
      ontologyCell.value.textContent = norm ?? value.ontology_version_id; ontologyCell.value.title = norm ? `${norm} · ${value.ontology_version_id}` : value.ontology_version_id;
      assigneeCell.value.textContent = assignee ? `${assignee} · ${value.assignee_id}` : value.assignee_id; assigneeCell.value.title = assigneeCell.value.textContent;
      stateCell.value.textContent = value.state === 'open' && value.review_decision === 'reject' ? '已退回' : states[value.state] ?? value.state;
      conclusion.textContent = value.review_decision ? `${value.review_decision === 'approve' ? '已批准' : '已退回'}${value.review_reason ? `：${value.review_reason}` : ''}` : '';
      revisionCell.value.textContent = value.revision_ids?.join(', ') ?? '未提交'; revisionCell.value.title = revisionCell.value.textContent;
      leaseCell.value.textContent = lease?.task_id === value.task_id ? fenced() ? '原操作待核对' : '本人持有（当前回执）' : '未知';
      if (snapshot && (snapshot.reviewId !== value.review_id || value.revision_ids?.length !== 1 || snapshot.revision.annotation_revision_id !== value.revision_ids[0])) { expandedDialog?.close(); diffDispose?.(); snapshot = null; diffDispose = null; }
      const canAnnotate = ['admin', 'annotator'].includes(role ?? '') && (value.assignee_id === actor || !!session?.platform_admin) && value.state === 'open';
      claim.hidden = !canAnnotate || lease?.task_id === value.task_id; submitButton.hidden = !canAnnotate || lease?.task_id !== value.task_id;
      claim.disabled = busy || fenced() || !current(); submitButton.disabled = busy || fenced() || lease?.task_id !== value.task_id || !current();
      transferDetails.hidden = role !== 'admin' || value.state !== 'open'; transfer.parentElement!.hidden = transferDetails.hidden; transferButton.hidden = transferDetails.hidden; transfer.disabled = busy || fenced() || !current(); transferButton.disabled = transfer.disabled;
      if (transferMembers !== memberSignature) { transferMembers = memberSignature; options(transfer, [{ value: '', text: '选择项目成员' }, ...members.map(item => ({ value: item.user_id, text: `${item.username} · ${item.user_id}` }))], transferDrafts.get(value.task_id) ?? transfer.value); }
      const canReview = ['admin', 'reviewer'].includes(role ?? ''); diffButton.hidden = !canReview || !value.review_id || !value.revision_ids; diffButton.disabled = busy || loading || !current();
      reviewControls.hidden = !expanded || !canReview || value.state !== 'submitted' || !value.review_id; const pending = value.review_id ? writes.decisions.get(value.review_id) : undefined;
      reason.disabled = !!pending || busy || !current(); approve.disabled = reject.disabled = busy || !current() || !!pending || !reason.value.trim() || snapshot?.reviewId !== value.review_id;
      unknownDecision.replaceChildren(); if (pending) unknownDecision.append(element('p', '审核结果未知，原固定版本与理由保留，只读刷新核对，不重发。'), details('原审核请求', pending));
    }, dispose() { rowLife.dispose(); } }; rowViews.set(task.task_id, view);
    rowLife.add(() => {
      const wasExpanded = expanded; restoreExpanded(); expandedDialog?.dispose(); diffDispose?.(); node.remove();
      if (wasExpanded && life.alive && panel.isConnected && document.activeElement === document.body) {
        const fallback = panel.closest('.r07-workbench')?.querySelector<HTMLElement>('[data-testid="nav-review"]') ?? title;
        fallback.focus({ preventScroll: true });
      }
    });
    reason.addEventListener('input', () => { reasonDrafts.set(task.task_id, reason.value); view.update(); }, { signal: rowLife.signal });
    async function loadDiff() {
      const fixed = view.task; if (!current() || !rowLife.alive || busy || loading || !fixed.review_id || fixed.revision_ids?.length !== 1) return; loading = true; view.update();
      try {
        const revision = await reviewApi.revision(fixed.revision_ids[0], rowLife.signal); if (!current() || !rowLife.alive) return;
        assertRevision(revision, fixed.revision_ids[0], fixed.asset_revision_id, fixed.ontology_version_id);
        const parent = revision.parent_revision_id ? await reviewApi.revision(revision.parent_revision_id, rowLife.signal) : null; if (!current() || !rowLife.alive) return;
        if (parent) assertRevision(parent, revision.parent_revision_id!, fixed.asset_revision_id, fixed.ontology_version_id);
        const issues = await reviewApi.issues(fixed.review_id, rowLife.signal); if (!current() || !rowLife.alive || view.task.review_id !== fixed.review_id || view.task.revision_ids?.[0] !== revision.annotation_revision_id) return;
        snapshot = { reviewId: fixed.review_id, revision, parent, issues: issues.items }; diffDispose?.();
        diffDispose = mountRevisionReviewView(diffRoot, { projectId: context.projectId, revision, parent, issues: issues.items, signal: rowLife.signal, isCurrent: current, detailed: true });
        openExpanded();
      } catch (cause) { if (current() && rowLife.alive) fail(cause); } finally { if (rowLife.alive) { loading = false; view.update(); } }
    }
    async function decide(decision: 'approve' | 'reject') {
      const value = view.task; if (!current() || !['admin', 'reviewer'].includes(role ?? '') || value.state !== 'submitted' || !value.review_id || !value.revision_ids || snapshot?.reviewId !== value.review_id || !reason.value.trim() || writes.decisions.has(value.review_id)) return;
      const target: Decision = { taskId: value.task_id, actor, reviewId: value.review_id, decision, reason: reason.value, revisionIds: [...value.revision_ids] };
      await perform(async () => { writes.decisions.set(target.reviewId, target); render(); try { await reviewApi.decide(target.reviewId, { decision, reason: target.reason, revision_ids: target.revisionIds }); writes.decisions.delete(target.reviewId); } catch (cause) { if (classifyWriteFailure(cause) === 'rejected') writes.decisions.delete(target.reviewId); throw cause; } });
    }
    view.update(); return node;
  }
  filter.addEventListener('change', () => { if (!current()) return; queue = filter.value as TaskQueue; render(); }, { signal: life.signal });
  const unsubscribe = context.subscribe(() => {
    const next = context.getScope().session;
    if (JSON.stringify([next?.user_id, next?.platform_admin, next?.project_roles]) !== authorization) reads.revoke();
    session = next; role = next?.project_roles.find(item => item.project_id === context.projectId)?.role;
    const requested = context.getQueue(); if (requested !== externalQueue) { externalQueue = requested; queue = requested; }
    render();
  }); life.add(unsubscribe);
  life.add(() => {
    for (const timer of timers) clearTimeout(timer); timers.clear(); port.onLeaseChange(null);
    const owned = lease; lease = null;
    const entry = context.session.getSnapshot();
    if (owned && validScope && entry.kind === 'authenticated' && entry.session.user_id === actor && !fenced()) {
      const target: LeaseWrite = { taskId: owned.task_id, action: 'release', actor }; writes.leaseWrite = target;
      void reviewApi.lease(owned.task_id, 'release').then(result => {
        if (writes.leaseWrite === target && result.task_id === owned.task_id && result.holder_id === null && result.fencing_token === owned.fencing_token) writes.leaseWrite = null;
      }).catch(cause => { if (writes.leaseWrite === target && classifyWriteFailure(cause) === 'rejected') writes.leaseWrite = null; });
    }
    for (const view of rowViews.values()) view.dispose(); list.dispose(); panel.remove();
  });
  render(); void refresh().catch(fail);
  if (role === 'admin') { void loadPage('members', null); void loadPage('media', null); void api.ontologies(context.projectId, reads.signal).then(page => { if (!current()) return; ontologies = page.items.filter(item => item.project_id === context.projectId); options(ontologySelect, [{ value: '', text: '选择固定规范' }, ...ontologies.map(item => ({ value: item.ontology_version_id, text: `版本 ${item.version_no} · ${item.ontology_version_id}` }))]); render(); }).catch(fail); }
  return life.dispose;
}
