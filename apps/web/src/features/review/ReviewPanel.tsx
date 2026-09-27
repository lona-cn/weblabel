import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import { ApiFailure, type Session } from '../../lib/t15/api';
import { reviewApi, type ReviewIssue, type ReviewTask } from './api';

type TaskLease = { asset_revision_id: string; task_id: string; fencing_token: number };
type ReviewSnapshot = { review_id: string; revision: AnnotationRevision; parent: AnnotationRevision | null };
type ObjectDelta = { object_id: string; kind: 'added' | 'removed' | 'changed'; fields: string[]; details: string[] };
type Props = { projectId: string; session: Session; onLeaseChange: (lease: TaskLease | null) => void; onSubmitTask: (task: ReviewTask, submit: (revisionId: string) => Promise<void>) => Promise<void> };

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

export function ReviewPanel({ projectId, session, onLeaseChange, onSubmitTask }: Props) {
  const [tasks, setTasks] = useState<ReviewTask[]>([]);
  const [asset, setAsset] = useState('');
  const [ontology, setOntology] = useState('');
  const [assignee, setAssignee] = useState(session.user_id);
  const [transferTarget, setTransferTarget] = useState('');
  const [reason, setReason] = useState<Record<string, string>>({});
  const [issues, setIssues] = useState<Record<string, ReviewIssue[]>>({});
  const [snapshots, setSnapshots] = useState<Record<string, ReviewSnapshot>>({});
  const [loadingDiff, setLoadingDiff] = useState<string | null>(null);
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const [activeLease, setActiveLease] = useState<TaskLease | null>(null);
  const activeLeaseRef = useRef<TaskLease | null>(null);
  activeLeaseRef.current = activeLease;

  const role = session.project_roles.find((item) => item.project_id === projectId)?.role;
  const canAssign = role === 'admin';
  const canReview = role === 'reviewer' || role === 'admin';
  const canAnnotate = role === 'annotator' || role === 'admin';
  const refresh = useCallback(async () => {
    try {
      setTasks((await reviewApi.tasks(projectId)).items);
      setFailure('');
    } catch (error) {
      setFailure(error instanceof ApiFailure ? error.code : 'REVIEW_UNAVAILABLE');
    }
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!activeLease) return;
    const timer = window.setTimeout(() => {
      void reviewApi.lease(activeLease.task_id, 'renew').then((result) => {
        const current = activeLeaseRef.current;
        if (current?.task_id !== activeLease.task_id) return;
        const renewed = { ...current, fencing_token: result.fencing_token };
        activeLeaseRef.current = renewed;
        setActiveLease(renewed);
        onLeaseChange(renewed);
      }).catch((error: unknown) => {
        if (activeLeaseRef.current?.task_id !== activeLease.task_id) return;
        activeLeaseRef.current = null;
        setActiveLease(null);
        onLeaseChange(null);
        setFailure(error instanceof ApiFailure ? error.code : 'LEASE_RENEWAL_FAILED');
      });
    }, 20_000);
    return () => window.clearTimeout(timer);
  }, [activeLease, onLeaseChange]);
  useEffect(() => () => {
    const lease = activeLeaseRef.current;
    activeLeaseRef.current = null;
    onLeaseChange(null);
    if (lease) void reviewApi.lease(lease.task_id, 'release').catch(() => {});
  }, [projectId, onLeaseChange]);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      await refresh();
      setFailure('');
    } catch (error) {
      setFailure(error instanceof ApiFailure ? error.code : 'REVIEW_UNAVAILABLE');
    } finally {
      setBusy(false);
    }
  }

  async function acquireLease(task: ReviewTask) {
    await act(async () => {
      const previous = activeLeaseRef.current;
      if (previous) {
        activeLeaseRef.current = null;
        setActiveLease(null);
        onLeaseChange(null);
        await reviewApi.lease(previous.task_id, 'release');
      }
      const result = await reviewApi.lease(task.task_id, 'acquire');
      const next = { asset_revision_id: task.asset_revision_id, task_id: task.task_id, fencing_token: result.fencing_token };
      activeLeaseRef.current = next;
      setActiveLease(next);
      onLeaseChange(next);
    });
  }

  async function releaseLease() {
    const previous = activeLeaseRef.current;
    if (!previous) return;
    await act(async () => {
      await reviewApi.lease(previous.task_id, 'release');
      if (activeLeaseRef.current?.task_id === previous.task_id) {
        activeLeaseRef.current = null;
        setActiveLease(null);
        onLeaseChange(null);
      }
    });
  }
  async function transferTask(taskId: string) {
    if (!transferTarget.trim()) return;
    await act(async () => {
      await reviewApi.lease(taskId, 'transfer', transferTarget.trim());
      if (activeLeaseRef.current?.task_id === taskId) {
        activeLeaseRef.current = null;
        setActiveLease(null);
        onLeaseChange(null);
      }
    });
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    await act(async () => {
      await reviewApi.createTask(projectId, { asset_revision_id: asset, ontology_version_id: ontology, assignee_id: assignee });
      setAsset('');
    });
  }

  async function loadReviewSnapshot(task: ReviewTask) {
    if (!task.review_id || !task.revision_ids?.length) return;
    setLoadingDiff(task.task_id);
    try {
      const revision = await reviewApi.revision(task.revision_ids[0]!);
      const parent = revision.parent_revision_id ? await reviewApi.revision(revision.parent_revision_id) : null;
      const issuePage = await reviewApi.issues(task.review_id);
      setSnapshots((current) => ({ ...current, [task.task_id]: { review_id: task.review_id!, revision, parent } }));
      setIssues((current) => ({ ...current, [task.task_id]: issuePage.items }));
      setFailure('');
    } catch (error) {
      setFailure(error instanceof ApiFailure ? error.code : 'REVIEW_UNAVAILABLE');
    } finally {
      setLoadingDiff(null);
    }
  }
  async function submitTask(task: ReviewTask) {
    await act(async () => {
      await onSubmitTask(task, async (revisionId) => { await reviewApi.submit(task.task_id, revisionId); });
    });
  }

  return <section className="review-panel" aria-labelledby="review-title">
    <h2 id="review-title">任务与审核</h2>
    {failure && <p role="alert" data-testid="review-error">{failure}</p>}
    {activeLease && <p role="status" data-testid="active-task-lease">已领取 {activeLease.asset_revision_id}；租约每 20 秒自动续期。</p>}
    {activeLease && <button type="button" disabled={busy} onClick={() => void releaseLease()}>释放当前任务租约</button>}
    {canAssign && <form onSubmit={(event) => void create(event)}>
      <h3>创建标注任务</h3>
      <label>媒体 revision<input required value={asset} onChange={(event) => setAsset(event.target.value)} /></label>
      <label>Ontology version<input required value={ontology} onChange={(event) => setOntology(event.target.value)} /></label>
      <label>指派用户 ID<input required value={assignee} onChange={(event) => setAssignee(event.target.value)} /></label>
      <button disabled={busy}>创建任务</button>
    </form>}
    <ul aria-label="项目任务">{tasks.map((task) => <li key={task.task_id} data-testid={`review-task-${task.task_id}`}>
      <h3>{task.asset_revision_id}</h3>
      <p>状态：{task.state} · Ontology {task.ontology_version_id}</p>
      {canAnnotate && (task.assignee_id === session.user_id || session.platform_admin) && task.state === 'open' && <button type="button" disabled={busy} onClick={() => void acquireLease(task)}>领取 60 秒任务</button>}
      {canAssign && task.state === 'open' && <form onSubmit={(event) => { event.preventDefault(); void transferTask(task.task_id); }}>
        <label>转交至项目标注者 ID<input required value={transferTarget} onChange={(event) => setTransferTarget(event.target.value)} /></label>
        <button disabled={busy} data-testid={`task-transfer-${task.task_id}`}>转交并更新 fencing token</button>
      </form>}
      {canAnnotate && (task.assignee_id === session.user_id || session.platform_admin) && task.state === 'open' && <button type="button" disabled={busy || activeLease?.task_id !== task.task_id} data-testid="task-submit" onClick={() => void submitTask(task)}>同步并提交当前版本</button>}
      {task.review_id && task.revision_ids && canReview && <button type="button" disabled={busy || loadingDiff === task.task_id} data-testid={`review-diff-${task.task_id}`} onClick={() => void loadReviewSnapshot(task)}>
        {loadingDiff === task.task_id ? '加载版本差异…' : '查看审核差异'}
      </button>}
      {task.review_id && task.revision_ids && <p>审核版本：{task.revision_ids.join(', ')}</p>}
      {canReview && task.state === 'submitted' && task.review_id && task.revision_ids && <div>
        <label>理由<textarea required value={reason[task.task_id] ?? ''} onChange={(event) => setReason((current) => ({ ...current, [task.task_id]: event.target.value }))} /></label>
        {(['approve', 'reject'] as const).map((decision) => <button key={decision} type="button" disabled={busy || !reason[task.task_id]?.trim() || snapshots[task.task_id]?.review_id !== task.review_id} data-testid={decision === 'approve' ? 'review-approve' : 'review-reject'} onClick={() => void act(async () => {
          await reviewApi.decide(task.review_id!, { decision, reason: reason[task.task_id], revision_ids: task.revision_ids! });
        })}>{decision === 'approve' ? '批准' : '退回'}</button>)}
      </div>}
      {snapshots[task.task_id]?.review_id === task.review_id && (() => {
        const snapshot = snapshots[task.task_id]!;
        const deltas = objectDeltas(snapshot.parent, snapshot.revision);
        return <section aria-label={`审核差异 ${task.task_id}`} data-testid={`review-diff-content-${task.task_id}`}>
          <p>不可变版本 {snapshot.revision.annotation_revision_id} · 基线 {snapshot.revision.parent_revision_id ?? '初始版本'}</p>
          <p>完成状态：{snapshot.parent?.document.completion ?? '无基线'} → {snapshot.revision.document.completion}</p>
          {deltas.length
            ? <ul>{deltas.map((delta) => <li key={delta.object_id}>{delta.object_id}：{delta.kind} · {delta.fields.join(', ')} · {delta.details.join('; ')}</li>)}</ul>
            : <p>对象几何与属性无差异</p>}
          {issues[task.task_id]?.map((issue) => <p key={issue.issue_id}>{issue.code}: {issue.message} · source revision {issue.annotation_revision_id}</p>)}
        </section>;
      })()}
    </li>)}</ul>
    {tasks.filter((task) => task.review_decision).map((task) => <p key={`decision-${task.task_id}`}>审核结论：{task.review_decision === 'approve' ? '已批准' : '已退回'} · 版本 {task.revision_ids?.join(', ')} · {task.review_reason}</p>)}
    <p>租约 60 秒到期并每 20 秒自动续期；审核与问题记录引用不可变 revision。</p>
  </section>;
}
