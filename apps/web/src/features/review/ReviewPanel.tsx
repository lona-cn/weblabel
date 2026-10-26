import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import { api, ApiFailure, type ApiMedia, type Session } from '../../lib/t15/api';
import { reviewApi, type ReviewIssue, type ReviewTask, type TaskCreateTarget, type TaskCreatePreparation, type TaskSubmission } from './api';
import { confirmsSubmission, classifyWriteFailure, queueMatches, type TaskQueue, type SubmissionTarget } from './workflow';
import { VirtualReviewList } from './VirtualReviewList';
import { RevisionReviewView } from './RevisionReviewView';

import type { LocalTaskLease, TaskOpenPreparation, TaskContinuationProof, TaskContinueResult, TaskSessionPort } from './task-session-port';
type Member = { user_id: string; username: string; role: string };
type FixedOntology = { project_id: string; ontology_version_id: string; version_no: number };
type Scope = { key: string; actor: string; alive: boolean; epoch: number; busy: boolean; lease: LocalTaskLease | null; notify: Props['onLeaseChange'] };
type ReviewSnapshot = { review_id: string; revision: AnnotationRevision; parent: AnnotationRevision | null };
type ObjectDelta = { object_id: string; kind: 'added' | 'removed' | 'changed'; fields: string[]; details: string[] };
type Props = TaskSessionPort & { projectId: string; session: Session; initialQueue?: TaskQueue };

function objectDeltas(before: AnnotationRevision | null, after: AnnotationRevision): ObjectDelta[] {
  const previous = new Map((before?.document.objects ?? []).map((item) => [item.object_id, item]));
  const next = new Map(after.document.objects.map((item) => [item.object_id, item]));
  const ids = [...new Set([...previous.keys(), ...next.keys()])].sort();
  const deltas: ObjectDelta[] = [];
  for (const object_id of ids) {
    const left = previous.get(object_id);
    const right = next.get(object_id);
    if (!left) { deltas.push({ object_id, kind: 'added', fields: ['object'], details: [`${JSON.stringify(right)}`] }); continue; }
    if (!right) { deltas.push({ object_id, kind: 'removed', fields: ['object'], details: [`${JSON.stringify(left)}`] }); continue; }
    const fields = (['label_id', 'geometry', 'attributes', 'origin'] as const)
      .filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]));
    if (fields.length) {
      deltas.push({
        object_id,
        kind: 'changed',
        fields: [...fields],
        details: fields.map((key) => `${key}: ${JSON.stringify(left[key])} → ${JSON.stringify(right[key])}`),
      });
    }
  }
  return deltas;
}

export function ReviewPanel({ projectId, session, onLeaseChange, onSubmitTask, onPrepareTaskOpen, onPrepareTaskCreate, onContinueTask, initialQueue = 'all' }: Props) {
  const role = session.project_roles.find((item) => item.project_id === projectId)?.role;
  const canAssign = role === 'admin';
  const canReview = role === 'reviewer' || role === 'admin';
  const canAnnotate = role === 'annotator' || role === 'admin';
  const key = JSON.stringify([projectId, session.user_id, session.platform_admin, session.project_roles]);
  const scopeRef = useRef<Scope | null>(null);
  if (scopeRef.current?.key !== key) {
    if (scopeRef.current) scopeRef.current.alive = false;
    scopeRef.current = { key, actor: session.user_id, alive: true, epoch: 0, busy: false, lease: null, notify: onLeaseChange };
  }
  const scope = scopeRef.current!;
  scope.notify = onLeaseChange;
  const current = () => scope.alive && scopeRef.current === scope;
  const [tasks, setTasks] = useState<ReviewTask[]>([]);
  const [taskCursor, setTaskCursor] = useState<string | null>(null);
  const [tasksReady, setTasksReady] = useState(false);
  const [taskLoading, setTaskLoading] = useState(false);
  const taskRead = useRef(0);
  const [queue, setQueue] = useState<TaskQueue>(initialQueue);
  useEffect(() => setQueue(initialQueue), [initialQueue]);
  const pendingSubmissions = useRef(new Map<string, SubmissionTarget>());
  const confirmedSubmissions = useRef(new Map<string, { target: SubmissionTarget; submission: TaskSubmission }>());
  const [, renderSubmissions] = useState(0);
  const submissionKey = JSON.stringify([projectId, session.user_id]);
  const unknownDecisions = useRef(new Map<string, { taskId: string; actor: string; reviewId: string; decision: 'approve' | 'reject'; reason: string; revisionIds: string[] }>());
  const [, renderDecisions] = useState(0);
  const unknownLeaseWrites = useRef(new Map<string, { taskId: string; action: 'acquire' | 'release' | 'transfer'; actor: string; holderId?: string }>());
  const [, renderLeaseWrites] = useState(0);
  const unknownLeaseWrite = unknownLeaseWrites.current.get(submissionKey);
  const pendingSubmission = pendingSubmissions.current.get(submissionKey);
  const confirmedSubmission = confirmedSubmissions.current.get(submissionKey);
  const visibleTasks = tasks.filter(task => queueMatches(task, queue, session.user_id));
  const [asset, setAsset] = useState('');
  const [ontology, setOntology] = useState('');
  const [assignee, setAssignee] = useState(session.user_id);
  const [transferTarget, setTransferTarget] = useState<Record<string, string>>({});
  const [members, setMembers] = useState<Member[]>([]);
  const [media, setMedia] = useState<ApiMedia[]>([]);
  const [ontologies, setOntologies] = useState<FixedOntology[]>([]);
  const [memberCursor, setMemberCursor] = useState<string | null>(null);
  const [mediaCursor, setMediaCursor] = useState<string | null>(null);
  const [membersReady, setMembersReady] = useState(false);
  const [mediaReady, setMediaReady] = useState(false);
  const pageBusy = useRef(new Set<string>());
  const [pageLoading, setPageLoading] = useState(false);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [issues, setIssues] = useState<Record<string, ReviewIssue[]>>({});
  const [snapshots, setSnapshots] = useState<Record<string, ReviewSnapshot>>({});
  const [loadingDiff, setLoadingDiff] = useState<string | null>(null);
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const unknownClaim = unknownLeaseWrite?.action === 'acquire';
  // Unconfirmed writes belong to project/actor, not mutable roles or epochs.
  // This mounted panel preserves them when switching away and back.
  const createScopeKey = JSON.stringify([projectId, session.user_id]);
  const currentCreateScopeKey = useRef(createScopeKey);
  currentCreateScopeKey.current = createScopeKey;
  const unknownCreates = useRef(new Map<string, TaskCreateTarget>());
  const [, renderUnknownCreates] = useState(0);
  const unknownCreate = unknownCreates.current.has(createScopeKey);
  function confirmCreate() {
    unknownCreates.current.delete(createScopeKey);
    if (scopeRef.current?.alive && currentCreateScopeKey.current === createScopeKey) renderUnknownCreates(version => version + 1);
  }
  const [activeLease, setActiveLease] = useState<LocalTaskLease | null>(null);
  function install(lease: LocalTaskLease | null) {
    if (!current()) return;
    scope.lease = lease; setActiveLease(lease); scope.notify(lease);
  }
  const fail = (error: unknown) => { if (current()) setFailure(error instanceof ApiFailure ? error.code : error instanceof Error ? error.message : 'REVIEW_UNAVAILABLE'); };
  async function refresh(cursor: string | null = null) {
    const epoch = scope.epoch;
    const request = ++taskRead.current;
    if (current()) setTaskLoading(true);
    try {
      const result = await reviewApi.tasks(projectId, cursor);
      if (current() && scope.epoch === epoch && taskRead.current === request) {
        setTasks(old => cursor === null ? result.items : [...new Map([...old, ...result.items].map(task => [task.task_id, task])).values()]);
        setTaskCursor(result.next_cursor); setTasksReady(true);
      }
    } catch (error) { if (current() && scope.epoch === epoch && taskRead.current === request) throw error; }
    finally { if (current() && taskRead.current === request) setTaskLoading(false); }
  }
  async function loadPage(kind: 'members' | 'media', cursor: string | null) {
    if (!canAssign || !current() || scope.busy) return;
    const epoch = scope.epoch;
    const lock = key + kind;
    if (pageBusy.current.has(lock)) return;
    pageBusy.current.add(lock); setPageLoading(true);
    try {
      if (kind === 'members') {
        const result = await api.members(projectId, cursor);
        if (!current() || scope.epoch !== epoch) return;
        const qualified = result.items.filter((item) => item.role === 'admin' || item.role === 'annotator');
        setMembers((old) => cursor === null ? qualified : [...new Map([...old, ...qualified].map((item) => [item.user_id, item])).values()]);
        setMemberCursor(result.next_cursor); setMembersReady(true);
      } else {
        const result = await reviewApi.assetsPage(projectId, cursor);
        if (!current() || scope.epoch !== epoch) return;
        setMedia((old) => cursor === null ? result.items : [...new Map([...old, ...result.items].map((item) => [item.asset_revision_id, item])).values()]);
        setMediaCursor(result.next_cursor); setMediaReady(true);
      }
      setFailure('');
    } catch (error) { if (current() && scope.epoch === epoch) fail(error); }
    finally { pageBusy.current.delete(lock); if (current()) setPageLoading([...pageBusy.current].some((item) => item.startsWith(key))); }
  }
  useEffect(() => {
    scope.alive = true;
    setTasks([]); setTasksReady(false); setTaskCursor(null); setMembers([]); setMedia([]); setOntologies([]); setMemberCursor(null); setMediaCursor(null);
    setMembersReady(false); setMediaReady(false); setActiveLease(null); scope.notify(null);
    setReason({}); setLoadingDiff(null);
    setBusy(false); setPageLoading(false); setFailure(''); setAsset(''); setOntology(''); setAssignee(session.user_id); setTransferTarget({}); setSnapshots({}); setIssues({});
    void refresh().catch(fail);
    if (canAssign) {
      const epoch = scope.epoch;
      void loadPage('members', null); void loadPage('media', null);
      void api.ontologies(projectId).then((result) => { if (current() && scope.epoch === epoch) setOntologies(result.items); }).catch((error) => { if (current() && scope.epoch === epoch) fail(error); });
    }
    return () => {
      scope.alive = false; scope.epoch++;
      const owned = scope.lease; scope.lease = null;
      // Never release under a different actor's session, nor release an unknown claim.
      if (scopeRef.current === scope) scope.notify(null);
      if (owned && scopeRef.current?.actor === scope.actor && !pendingSubmissions.current.has(submissionKey) && !confirmedSubmissions.current.has(submissionKey) && !unknownLeaseWrites.current.has(submissionKey)) void reviewApi.lease(owned.task_id, 'release').catch(() => undefined);
    };
  }, [key]);
  useEffect(() => {
    if (!activeLease || scope.lease !== activeLease) return;
    const epoch = scope.epoch;
    const valid = () => current() && scope.epoch === epoch && scope.lease === activeLease;
    const timer = window.setTimeout(() => {
      if (!valid() || scope.busy || pendingSubmissions.current.has(submissionKey) || unknownLeaseWrites.current.has(submissionKey)) return;
      void reviewApi.lease(activeLease.task_id, 'renew').then((result) => {
        if (!valid()) return;
        if (result.task_id !== activeLease.task_id || result.holder_id !== scope.actor || result.fencing_token !== activeLease.fencing_token) throw new Error('Invalid renewal identity');
        install({ ...activeLease });
      }).catch((error: unknown) => { if (valid()) { install(null); fail(error); } });
    }, 20_000);
    return () => window.clearTimeout(timer);
  }, [activeLease, key, busy]);
  async function act(action: (valid: () => boolean) => Promise<unknown>) {
    if (!current() || scope.busy) return;
    scope.busy = true; const epoch = ++scope.epoch; setBusy(true); setFailure('');
    const valid = () => current() && scope.epoch === epoch;
    try { const outcome = await action(valid); if (valid() && outcome !== false) { try { await refresh(); } catch (error) { if (valid()) setFailure('写入已成功，但读取刷新失败；不要重发操作。' + (error instanceof Error ? error.message : '')); } } }
    catch (error) { if (valid()) fail(error); }
    finally { if (valid()) { scope.busy = false; setBusy(false); setActiveLease(scope.lease); } }
  }
  async function mutateLease(taskId: string, action: 'release' | 'transfer', holderId?: string) {
    if (unknownLeaseWrites.current.has(submissionKey)) throw new Error('先只读核对未确认的租约操作；不能重发。');
    unknownLeaseWrites.current.set(submissionKey, { taskId, action, actor: session.user_id, holderId }); renderLeaseWrites(version => version + 1);
    try { if (holderId === undefined) await reviewApi.lease(taskId, action); else await reviewApi.lease(taskId, action, holderId); }
    catch (error) {
      if (classifyWriteFailure(error) === 'rejected') { unknownLeaseWrites.current.delete(submissionKey); renderLeaseWrites(version => version + 1); throw new Error('租约操作被明确拒绝；当前上下文保留。' + (error instanceof ApiFailure ? error.code : '')); }
      throw new Error('租约操作结果未知；固定目标保留，暂停后续租约写入，只读核对任务，不重发。');
    }
    unknownLeaseWrites.current.delete(submissionKey); renderLeaseWrites(version => version + 1);
  }
  async function acquireLease(task: ReviewTask, proof?: TaskContinuationProof) {
    if (!canAnnotate || task.project_id !== projectId || task.state !== 'open' || pendingSubmissions.current.has(submissionKey) || confirmedSubmissions.current.has(submissionKey) || unknownLeaseWrites.current.has(submissionKey)) return;
    await act(async (valid) => {
      const previous = scope.lease;
      let ticket: TaskOpenPreparation | undefined;
      let acquired: LocalTaskLease | null = null;
      try {
        ticket = await onPrepareTaskOpen(task, proof);
        const ready = () => valid() && ticket!.isCurrent();
        if (!ready() || scope.lease !== previous) return;
        if (!ready() || !await ticket.validateCurrent() || !ready()) return;
        if (previous) {
          await mutateLease(previous.task_id, 'release');
          if (!valid() || scope.lease !== previous) return;
          install(null);
          if (!ready()) return;
        }
        if (!ready() || !await ticket.validateCurrent() || !ready()) return;
        let result;
        unknownLeaseWrites.current.set(submissionKey, { taskId: task.task_id, action: 'acquire', actor: scope.actor }); renderLeaseWrites(version => version + 1);
        try { result = await reviewApi.lease(task.task_id, 'acquire'); }
        catch (error) {
          if (classifyWriteFailure(error) !== 'rejected') return false;
          unknownLeaseWrites.current.delete(submissionKey); renderLeaseWrites(version => version + 1);
          throw error;
        }
        if (result.task_id !== task.task_id || result.holder_id !== scope.actor || !Number.isSafeInteger(result.fencing_token) || result.fencing_token < 1 || result.expires_at_unix <= Date.now() / 1000) {
          return false;
        }
        const lease = { asset_revision_id: task.asset_revision_id, ontology_version_id: task.ontology_version_id, task_id: task.task_id, fencing_token: result.fencing_token };
        acquired = lease;
        if (!ready() || scope.lease !== null && scope.lease !== previous) return;
        if (!ready() || !await ticket.validateCurrent() || !ready()) return;
        unknownLeaseWrites.current.delete(submissionKey); renderLeaseWrites(version => version + 1);
        install(lease);
        ticket.onTaskOpen(task, lease);
        acquired = null;
      } finally {
        ticket?.release();
        if (acquired && scopeRef.current?.actor === scope.actor) {
          if (scope.lease === acquired) install(null);
          unknownLeaseWrites.current.delete(submissionKey); renderLeaseWrites(version => version + 1);
          await mutateLease(acquired.task_id, 'release');
        }
      }
    });
  }
  async function releaseLease() {
    const previous = scope.lease;
    if (!previous || pendingSubmissions.current.has(submissionKey) || confirmedSubmissions.current.has(submissionKey) || unknownLeaseWrites.current.has(submissionKey)) return;
    await act(async (valid) => { await mutateLease(previous.task_id, 'release'); if (valid() && scope.lease === previous) install(null); });
  }
  async function transferTask(taskId: string) {
    const target = transferTarget[taskId];
    if (!canAssign || pendingSubmissions.current.has(submissionKey) || confirmedSubmissions.current.has(submissionKey) || unknownLeaseWrites.current.has(submissionKey) || !members.some((item) => item.user_id === target)) return;
    const previous = scope.lease;
    await act(async (valid) => {
      await mutateLease(taskId, 'transfer', target);
      if (valid() && scope.lease === previous && previous?.task_id === taskId) install(null);
    });
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!canAssign || unknownCreates.current.has(createScopeKey) || !members.some(item => item.user_id === assignee && ['admin', 'annotator'].includes(item.role)) || !media.some(item => item.asset_revision_id === asset && item.project_id === projectId) || !ontologies.some(item => item.project_id === projectId && item.ontology_version_id === ontology)) return;
    const target: TaskCreateTarget = Object.freeze({ project_id: projectId, asset_revision_id: asset, ontology_version_id: ontology, assignee_id: assignee });
    await act(async valid => {
      let ticket: TaskCreatePreparation | undefined;
      try {
        ticket = await onPrepareTaskCreate(target);
        if (!valid() || !ticket.isCurrent()) return false;
        if (!valid() || !ticket.isCurrent() || !await ticket.validateCurrent() || !valid() || !ticket.isCurrent()) return false;
        // Record before dispatch so loss of currency cannot permit a resend.
        unknownCreates.current.set(createScopeKey, target);
        renderUnknownCreates(version => version + 1);
        try { await reviewApi.createTask(target.project_id, { asset_revision_id: target.asset_revision_id, ontology_version_id: target.ontology_version_id, assignee_id: target.assignee_id }); }
        catch (error) {
          if (!(error instanceof ApiFailure) || error.status < 400 || error.status >= 500) return false;
          confirmCreate();
          throw new Error('创建被明确拒绝；目标保留，修正原因后才能再次创建。' + (error instanceof ApiFailure ? error.code : ''));
        }
        confirmCreate();
        return valid() && ticket.isCurrent();
      } finally { ticket?.release(); }
    });
  }
  async function loadReviewSnapshot(task: ReviewTask) {
    if (!task.review_id || task.revision_ids?.length !== 1) return;
    const epoch = scope.epoch;
    const valid = () => current() && scope.epoch === epoch;
    setLoadingDiff(task.task_id);
    try {
      const revision = await reviewApi.revision(task.revision_ids[0]!); if (!valid()) return;
      if (revision.annotation_revision_id !== task.revision_ids[0] || revision.document.asset_revision_id !== task.asset_revision_id || revision.document.ontology_version_id !== task.ontology_version_id) throw new Error('审核版本身份不匹配，不能使用当前 head 替代。');
      const parent = revision.parent_revision_id ? await reviewApi.revision(revision.parent_revision_id) : null; if (!valid()) return;
      const issuePage = await reviewApi.issues(task.review_id); if (!valid()) return;
      setSnapshots((old) => ({ ...old, [task.task_id]: { review_id: task.review_id!, revision, parent } }));
      setIssues((old) => ({ ...old, [task.task_id]: issuePage.items })); setFailure('');
    } catch (error) { if (valid()) fail(error); }
    finally { if (valid()) setLoadingDiff(null); }
  }
  async function submitTask(task: ReviewTask) {
    if (pendingSubmissions.current.has(submissionKey) || confirmedSubmissions.current.has(submissionKey) || unknownLeaseWrites.current.has(submissionKey)) return;
    await act(async valid => {
      const held = scope.lease;
      if (held?.task_id !== task.task_id) return false;
      await onSubmitTask(task, async revisionId => {
        if (!valid() || scope.lease !== held) throw new Error('Task scope changed');
        const target = Object.freeze({ task: { ...task }, actor: session.user_id, revisionId });
        pendingSubmissions.current.set(submissionKey, target); renderSubmissions(version => version + 1);
        let response: TaskSubmission;
        try { response = await reviewApi.submit(task.task_id, revisionId); }
        catch (error) {
          if (classifyWriteFailure(error) === 'rejected') { pendingSubmissions.current.delete(submissionKey); renderSubmissions(version => version + 1); throw new Error('提交被明确拒绝；当前工作保留。' + (error instanceof Error ? error.message : '')); }
          throw new Error('提交结果未知；保留固定目标，只读核对，不自动重发。');
        }
        if (!confirmsSubmission(response, target)) throw new Error('提交响应无法确认固定目标与租约终结；请只读核对。');
        pendingSubmissions.current.delete(submissionKey);
        confirmedSubmissions.current.set(submissionKey, { target, submission: response }); renderSubmissions(version => version + 1);
        if (valid() && scope.lease === held) install(null);
      });
    });
  }
  async function checkSubmission() {
    const target = pendingSubmissions.current.get(submissionKey);
    if (!target) return;
    await act(async valid => {
      const observed = await reviewApi.submission(target.task.task_id);
      if (!valid()) return false;
      if (!confirmsSubmission(observed, target)) throw new Error('尚未确认同一身份、固定版本和租约终结；保持当前工作，不重发提交。');
      pendingSubmissions.current.delete(submissionKey); confirmedSubmissions.current.set(submissionKey, { target, submission: observed });
      install(null); renderSubmissions(version => version + 1);
      setFailure('已核对目标状态；这不是原 POST 的唯一归因或幂等回执。');
    });
  }
  async function continueTask() {
    const confirmed = confirmedSubmissions.current.get(submissionKey);
    if (!confirmed || !onContinueTask || !canAnnotate || scope.busy || !current() || unknownLeaseWrites.current.has(submissionKey)) return;
    let next: TaskContinueResult | null = null;
    await act(async valid => {
      if (!valid() || !confirmsSubmission(confirmed.submission, confirmed.target)) return false;
      const candidate = await onContinueTask({ task: confirmed.target.task, submission: confirmed.submission, isCurrent: valid });
      if (!valid()) return false;
      if (!candidate) { setFailure('固定版本已提交且租约已终结；队列中没有下一项可领取任务，保留当前上下文。'); return false; }
      if (candidate.task.project_id !== projectId || candidate.task.assignee_id !== session.user_id || candidate.task.state !== 'open' || candidate.task.task_id === confirmed.target.task.task_id) throw new Error('下一任务不符合当前项目、身份和待办范围；未领取。');
      next = candidate;
      return false;
    });
    if (!next || !current() || scope.busy || confirmedSubmissions.current.get(submissionKey) !== confirmed) return;
    const candidate: TaskContinueResult = next;
    confirmedSubmissions.current.delete(submissionKey); renderSubmissions(version => version + 1);
    await acquireLease(candidate.task, candidate.proof);
    if (current() && scope.lease?.task_id !== candidate.task.task_id) {
      confirmedSubmissions.current.set(submissionKey, confirmed); renderSubmissions(version => version + 1);
      setFailure(old => old || '下一任务未领取；保留当前上下文，请先核对领取状态。');
    }
  }
  async function decideTask(task: ReviewTask, decision: 'approve' | 'reject') {
    if (!canReview || !task.review_id || !task.revision_ids || !reason[task.task_id]?.trim() || snapshots[task.task_id]?.review_id !== task.review_id) return;
    const decisionKey = JSON.stringify([projectId, session.user_id, task.review_id]);
    if (unknownDecisions.current.has(decisionKey)) return;
    await act(async valid => {
      const target = { taskId: task.task_id, actor: session.user_id, reviewId: task.review_id!, decision, reason: reason[task.task_id]!, revisionIds: [...task.revision_ids!] };
      unknownDecisions.current.set(decisionKey, target); renderDecisions(version => version + 1);
      try { await reviewApi.decide(target.reviewId, { decision: target.decision, reason: target.reason, revision_ids: target.revisionIds }); }
      catch (error) {
        if (classifyWriteFailure(error) === 'rejected') { unknownDecisions.current.delete(decisionKey); renderDecisions(version => version + 1); throw new Error('审核被明确拒绝；原版本与理由保留。' + (error instanceof ApiFailure ? error.code : '')); }
        throw new Error('审核结果未知；原版本与理由保留，只读刷新核对，不重发审核。');
      }
      unknownDecisions.current.delete(decisionKey); renderDecisions(version => version + 1);
      return valid();
    });
  }

  return <section className="review-panel" aria-labelledby="review-title">
    <h2 id="review-title">任务与审核</h2>
    <button type="button" data-testid="task-list-refresh" disabled={busy || taskLoading} onClick={() => { if (current() && !scope.busy) void refresh().catch(fail); }}>刷新任务列表</button>
    {pendingSubmission && <div role="status">提交结果未知：{pendingSubmission.task.task_id} · {pendingSubmission.revisionId} · {pendingSubmission.actor}。只读核对不会重新提交。<button type="button" disabled={busy} onClick={() => void checkSubmission()}>只读核对提交</button></div>}
    {confirmedSubmission && <div role="status">固定版本已提交且服务端租约已终结。{onContinueTask && <button type="button" disabled={busy || !canAnnotate || !!unknownLeaseWrite} onClick={() => void continueTask()}>完成并继续</button>}</div>}
    <label>任务队列<select value={queue} onChange={event => setQueue(event.target.value as TaskQueue)}>{(['all', 'mine', 'pending', 'returned', 'closed'] as const).map(value => <option key={value} value={value}>{{ all: '全部', mine: '我的待办', pending: '待审核', returned: '退回', closed: '结束' }[value]}（{tasks.filter(task => queueMatches(task, value, session.user_id)).length}）</option>)}</select></label>
    <p>当前项目已加载范围：{tasks.length} 项；{tasksReady && taskCursor === null ? '已读取全部分页（读取时点，非全站统计）' : '尚未读取全部分页，计数仅限已加载任务'}。</p>
    {taskCursor && <button type="button" disabled={busy || taskLoading} onClick={() => void refresh(taskCursor).catch(fail)}>继续读取任务</button>}
    {unknownCreate && <div role="status" data-testid="task-create-unknown">创建结果尚未确认；任务可能已经创建。固定目标：{JSON.stringify(unknownCreates.current.get(createScopeKey))}。请只读重新核对任务，不要重复创建。<button type="button" disabled={busy} onClick={() => void refresh().catch(fail)}>只读核对任务</button></div>}
    {unknownLeaseWrite && <div role="status">租约操作结果未知，固定目标：{JSON.stringify(unknownLeaseWrite)}。已暂停后续租约写入；任务列表只核对任务状态，不冒充租约确认。<button type="button" disabled={busy} onClick={() => void refresh().catch(fail)}>只读核对租约相关任务</button></div>}
    {failure && <div role="alert" data-testid="review-error"><p>{failure === 'LEASE_RENEWAL_FAILED' ? '任务续期失败，请重新领取。' : failure}</p><details><summary>错误详情</summary>{failure}</details></div>}
    {unknownClaim && <div role="status" data-testid="task-claim-unknown"><p>领取结果尚未确认，固定任务：{unknownLeaseWrite?.taskId}，身份：{unknownLeaseWrite?.actor}。当前 API 不提供只读租约证明；保持保守只读，任务刷新不会解锁领取或其他租约写入。</p><button type="button" disabled={busy} onClick={() => void refresh().catch(fail)}>重新检查</button></div>}
    {activeLease && <p role="status" data-testid="active-task-lease">{pendingSubmission || unknownLeaseWrite ? '操作结果未知，已暂停续期与租约写入；只读核对固定目标。' : '已领取任务，每 20 秒自动续期。'}</p>}
    {activeLease && <button type="button" disabled={busy || !!pendingSubmission || !!confirmedSubmission || !!unknownLeaseWrite} onClick={() => void releaseLease()}>释放当前任务</button>}
    {canAssign && <form onSubmit={(event) => void create(event)}>
      <h3>创建标注任务</h3>
      <label>图片版本<select required disabled={busy || unknownCreate} value={asset} onChange={(event) => setAsset(event.target.value)}><option value="">选择图片版本</option>{media.map((item) => <option key={item.asset_revision_id} value={item.asset_revision_id}>{item.original_name} · {item.asset_revision_id}</option>)}</select></label>
      <button type="button" data-testid="task-media-refresh" disabled={pageLoading || busy} onClick={() => void loadPage('media', null)}>刷新可选媒体</button>
      {(!mediaReady || mediaCursor !== null) && <button type="button" data-testid="task-media-more" disabled={pageLoading || busy} onClick={() => void loadPage('media', mediaCursor)}>继续读取媒体</button>}
      <label>类别规范版本<select required disabled={busy || unknownCreate} value={ontology} onChange={(event) => setOntology(event.target.value)}><option value="">选择固定规范</option>{ontologies.map((item) => <option key={item.ontology_version_id} value={item.ontology_version_id}>版本 {item.version_no} · {item.ontology_version_id}</option>)}</select></label>
      <label>指派项目标注者<select required disabled={busy || unknownCreate} value={assignee} onChange={(event) => setAssignee(event.target.value)}><option value="">选择项目成员</option>{members.map((item) => <option key={item.user_id} value={item.user_id}>{item.username}</option>)}</select></label>
      <button type="button" data-testid="task-members-refresh" disabled={pageLoading || busy} onClick={() => void loadPage('members', null)}>刷新可选成员</button>
      {(!membersReady || memberCursor !== null) && <button type="button" data-testid="task-members-more" disabled={pageLoading || busy} onClick={() => void loadPage('members', memberCursor)}>继续读取成员</button>}
      <button disabled={busy || unknownCreate}>创建任务</button>
    </form>}
    <VirtualReviewList items={visibleTasks} itemKey={task => task.task_id} label="项目任务">{task => <div data-testid={`review-task-${task.task_id}`}>
      <details><summary>任务与版本详情</summary><p>任务：{task.task_id}</p><p>图片：{task.asset_revision_id}</p><p>类别规范：{task.ontology_version_id}</p></details>
      <p>状态：{({ open: '待标注', submitted: '待审核', closed: '已结束' } as Record<string, string>)[task.state] ?? task.state}</p>
      {canAnnotate && (task.assignee_id === session.user_id || session.platform_admin) && task.state === 'open' && <button type="button" disabled={busy || !!pendingSubmission || !!confirmedSubmission || !!unknownLeaseWrite} onClick={() => void acquireLease(task)}>领取任务</button>}
      {canAssign && task.state === 'open' && <form onSubmit={(event) => { event.preventDefault(); void transferTask(task.task_id); }}>
        <label>转交至项目标注者<select required value={transferTarget[task.task_id] ?? ''} onChange={(event) => setTransferTarget((old) => ({ ...old, [task.task_id]: event.target.value }))}><option value="">选择项目成员</option>{members.map((item) => <option key={item.user_id} value={item.user_id}>{item.username}</option>)}</select></label>
        <button disabled={busy || !!unknownLeaseWrite} data-testid={`task-transfer-${task.task_id}`}>转交任务</button>
      </form>}
      {canAnnotate && (task.assignee_id === session.user_id || session.platform_admin) && task.state === 'open' && <button type="button" disabled={busy || !!pendingSubmission || !!confirmedSubmission || !!unknownLeaseWrite || activeLease?.task_id !== task.task_id} data-testid="task-submit" onClick={() => void submitTask(task)}>同步并提交当前版本</button>}
      {task.review_id && task.revision_ids && canReview && <button type="button" disabled={busy || loadingDiff === task.task_id} data-testid={`review-diff-${task.task_id}`} onClick={() => void loadReviewSnapshot(task)}>
        {loadingDiff === task.task_id ? '加载版本差异…' : '查看审核差异'}
      </button>}
      {task.review_id && task.revision_ids && <details><summary>指定审核版本</summary>{task.revision_ids.join(', ')}</details>}
      {canReview && task.state === 'submitted' && task.review_id && task.revision_ids && <div>
        <label>理由<textarea required value={reason[task.task_id] ?? ''} onChange={(event) => setReason((current) => ({ ...current, [task.task_id]: event.target.value }))} /></label>
        {unknownDecisions.current.has(JSON.stringify([projectId, session.user_id, task.review_id])) && <p role="status">审核结果未知；固定目标与理由：{JSON.stringify(unknownDecisions.current.get(JSON.stringify([projectId, session.user_id, task.review_id])))}。只读刷新核对，不重发。</p>}
        {(['approve', 'reject'] as const).map(decision => <button key={decision} type="button" disabled={busy || unknownDecisions.current.has(JSON.stringify([projectId, session.user_id, task.review_id])) || !reason[task.task_id]?.trim() || snapshots[task.task_id]?.review_id !== task.review_id} data-testid={decision === 'approve' ? 'review-approve' : 'review-reject'} onClick={() => void decideTask(task, decision)}>{decision === 'approve' ? '批准' : '退回'}</button>)}
      </div>}
      {snapshots[task.task_id]?.review_id === task.review_id && (() => {
        const snapshot = snapshots[task.task_id]!;
        const deltas = objectDeltas(snapshot.parent, snapshot.revision);
        return <section aria-label={`审核差异 ${task.task_id}`} data-testid={`review-diff-content-${task.task_id}`}>
          <p>正在查看提交时指定的版本，后续编辑不会改变本次审核。</p><details><summary>审核版本与基线</summary>{snapshot.revision.annotation_revision_id} · {snapshot.revision.parent_revision_id ?? '初始版本'}</details>
          <p>完成状态：{snapshot.parent ? ({ unprocessed: '未处理', in_progress: '标注中', complete: '已完成', confirmed_negative: '已确认无目标（不是空文档）' }[snapshot.parent.document.completion] ?? snapshot.parent.document.completion) : '无基线'} → {{ unprocessed: '未处理', in_progress: '标注中', complete: '已完成', confirmed_negative: '已确认无目标（不是空文档）' }[snapshot.revision.document.completion] ?? snapshot.revision.document.completion}</p>
          <RevisionReviewView projectId={projectId} revision={snapshot.revision} parent={snapshot.parent} issues={issues[task.task_id] ?? []} />
          {deltas.length
            ? <VirtualReviewList items={deltas} itemKey={delta => delta.object_id} label="对象差异">{delta => <div>{{ added: '新增对象', removed: '删除对象', changed: '修改对象' }[delta.kind]} · {delta.fields.map(field => (({ object: '对象', label_id: '类别', geometry: '形状', attributes: '属性', origin: '来源' } as Record<string, string>)[field] ?? field)).join('、')}<details><summary>对象差异详情</summary>{delta.object_id} · {delta.details.join('; ')}</details></div>}</VirtualReviewList>
            : <p>对象几何与属性无差异；仍可检查全图所有区域。</p>}
        </section>;
      })()}
    </div>}</VirtualReviewList>
    <VirtualReviewList items={tasks.filter(task => task.review_decision)} itemKey={task => task.task_id} label="审核结论">{task => <div>审核结论：{task.review_decision === 'approve' ? '已批准' : '已退回'} · {task.review_reason}<details><summary>审核版本</summary>{task.revision_ids?.join(', ')}</details></div>}</VirtualReviewList>
    <p>任务每 20 秒续期，60 秒未续期会释放。审核只针对提交时指定的版本，不会随之后的编辑变化。</p>
  </section>;
}
