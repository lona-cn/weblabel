import type { TaskSessionPort, TaskOpenPreparation, TaskContinuationProof } from '../review/task-session-port';
import type { TaskCreatePreparation, TaskCreateTarget, ReviewTask } from '../review/api';
import { reviewApi } from '../review/api';
import { nextAssignedTask } from '../review/continue-task';
import { submitCurrentReviewRevision } from '../review/submission';
import { api } from '../../lib/t15/api';
import { admitRawDraft } from '../../lib/persistence/draft-store';
import { isLeaseRejection } from '../../lib/persistence/save-queue';
import { hasUnconfirmedImportForTarget, getOutboxSnapshot } from '../import-export/outbox';
import type { DraftRecovery } from './draft-recovery';
import { hasOwnedFuture } from './draft-recovery';
import type { EditorPort } from './editor-port';
import { matchesTask } from './editor-port';
import { recordKey, sameDocument, sessionCurrent, writableRole, type WorkspaceState } from './workspace-state';

export function createTaskSession(state: WorkspaceState, port: EditorPort, recovery: DraftRecovery): TaskSessionPort {
  const pendingImport = (asset: string) => getOutboxSnapshot().imports.some(item => item.target.projectId === state.projectId && item.target.assetRevisionId === asset && !item.receipt);
  async function prepareCreate(target: TaskCreateTarget): Promise<TaskCreatePreparation> {
    const scope = state.scope, session = state.session, assets = state.assets, ontologies = state.ontologies, project = state.project;
    const authority = () => sessionCurrent(state) && state.session === session && state.scope === scope && state.project === project && project?.role === 'admin'
      && writableRole(state) && state.catalogReady && state.assets === assets && state.ontologies === ontologies;
    if (!authority() || state.preparation || state.importing || state.submission || state.phase === 'loading' || target.project_id !== state.projectId
      || !assets.some(item => item.asset_revision_id === target.asset_revision_id && item.project_id === target.project_id)
      || !ontologies.some(item => item.ontology_version_id === target.ontology_version_id && item.project_id === target.project_id)) throw new Error('当前管理员权限或任务目标未核实。');
    const token = Symbol('task-create'); state.preparation = token; state.host?.cancelGesture(); state.notify();
    const current = () => authority() && state.preparation === token;
    const release = () => { if (state.preparation === token) { state.preparation = null; state.notify(); } };
    const ids = [...new Set([target.asset_revision_id, ...(state.assetId ? [state.assetId] : [])])], settled = new Map<string, string>();
    const inspect = (asset: string) => {
      if (!current() || pendingImport(asset)) throw new Error('准备范围变化或存在未确认导入。');
      const record = state.queue.toRecord(asset), status = state.queue.getStatus(asset);
      if (!record) return null;
      admitRawDraft(record, asset);
      const outstanding = record.generation !== record.synced_generation || record.intent_journal.length !== record.synced_intent_seq || record.pending;
      if (!record.base_revision_id || record.document.asset_revision_id !== asset || record.document.ontology_version_id !== record.ontology_version_id
        || !assets.some(item => item.asset_revision_id === asset) || !ontologies.some(item => item.ontology_version_id === record.ontology_version_id)
        || status.writes_paused || status.last_error || record.writes_paused || record.save_error
        || outstanding && (record.draft_owner?.actor_id !== session?.user_id || record.draft_owner?.project_id !== state.projectId)
        || record.pending && (record.pending_owner?.actor_id !== session?.user_id || record.pending_owner?.project_id !== state.projectId
          || record.pending.request.document.asset_revision_id !== asset || record.pending.request.document.ontology_version_id !== record.ontology_version_id
          || record.pending.request.base_revision_id !== record.base_revision_id || record.pending_outcome !== 'prepared' && !(record.pending_outcome === 'unknown' && status.saving))
        || outstanding && asset === state.assetId && (state.loaded?.readOnlyPreview || state.host?.status !== 'ready')) throw new Error('原草稿有作者、规范、存储、冲突或未知结果；先救援，不能创建任务。');
      return record;
    };
    try {
      const others = new Map<string, string>(), holds = new Map<string, string>();
      for (const asset of ids) {
        others.set(asset, await recovery.branchHold(asset, true, true)); inspect(asset);
        if (!state.queue.toRecord(asset)) continue;
        await state.queue.flush(asset, current); inspect(asset); await state.queue.whenPersisted(asset);
        const record = inspect(asset)!, status = state.queue.getStatus(asset), certificate = status.local_commit;
        if (status.dirty || status.saving || record.pending || record.generation !== record.synced_generation || record.intent_journal.length !== record.synced_intent_seq
          || !certificate || certificate.generation !== record.generation || certificate.edit_seq !== record.edit_seq
          || asset === state.assetId && state.host?.getGeneration() !== record.generation) throw new Error('最新本地提交与服务器确认尚未全部完成。');
        settled.set(asset, recordKey(record));
      }
      for (const asset of ids) {
        if (await recovery.branchHold(asset, false, true) !== others.get(asset)) throw new Error('其他草稿分支已变化。');
        holds.set(asset, await recovery.branchHold(asset, false));
      }
      const isCurrent = () => current() && ids.every(asset => {
        const record = state.queue.toRecord(asset), status = state.queue.getStatus(asset);
        return !pendingImport(asset) && !status.dirty && !status.saving && !status.writes_paused && !status.last_error
          && (!record || !!status.local_commit && recordKey(record) === settled.get(asset))
          && (!record || asset !== state.assetId || state.host?.getGeneration() === record.generation);
      });
      return { token, release, isCurrent, validateCurrent: async () => { if (!isCurrent()) return false; for (const asset of ids) if (await recovery.branchHold(asset, false) !== holds.get(asset)) return false; return isCurrent(); } };
    } catch (reason) { release(); throw reason; }
  }
  async function prepareOpen(task: ReviewTask, proof?: TaskContinuationProof): Promise<TaskOpenPreparation> {
    const scope = state.scope, session = state.session, host = state.host, loaded = state.loaded, asset = state.assetId;
    const currentScope = () => sessionCurrent(state) && state.session === session && state.scope === scope && state.host === host && state.loaded === loaded && writableRole(state);
    if (!currentScope() || state.preparation || state.importing || state.submission || state.phase === 'loading' || task.project_id !== state.projectId || task.state !== 'open'
      || !state.assets.some(item => item.asset_revision_id === task.asset_revision_id) || !state.ontologies.some(item => item.ontology_version_id === task.ontology_version_id)
      || proof && !proof.isCurrent(null)) throw new Error('任务、权限或工作区状态不允许领取；未释放原任务。');
    const token = Symbol('task-open'); state.preparation = token; host?.cancelGesture(); state.notify();
    let retainedKey: string | null = null, futureCertificate: string | null = null;
    const current = () => currentScope() && state.preparation === token && (!proof || proof.isCurrent(token))
      && (retainedKey === null || recordKey(state.queue.toRecord(asset)) === retainedKey)
      && (futureCertificate === null || hasOwnedFuture(state) && JSON.stringify(state.queue.getStatus(asset).local_commit) === futureCertificate);
    const release = () => { if (state.preparation === token) { state.preparation = null; state.notify(); } };
    const ids = [...new Set([task.asset_revision_id, ...(asset ? [asset] : [])])];
    const holds = new Map<string, string>(), others = new Map<string, string>();
    let preserve = false;
    try {
      for (const id of ids) others.set(id, await recovery.branchHold(id, true, true));
      if (asset) {
        const record = state.queue.toRecord(asset), status = state.queue.getStatus(asset), fixed = state.fixedTask;
        const own = record?.draft_owner?.actor_id === session?.user_id && record?.draft_owner?.project_id === state.projectId;
        const pendingOwn = record?.pending_owner?.actor_id === session?.user_id && record?.pending_owner?.project_id === state.projectId;
        const targetMatches = asset === task.asset_revision_id && loaded?.ontology.ontology_version_id === task.ontology_version_id && host?.status === 'ready';
        const allowedActor = task.assignee_id === session?.user_id || session?.platform_admin;
        const leaseRejection = !state.lease && own && pendingOwn && targetMatches && record?.pending_outcome === 'rejected'
          && !!record.pending && !!status.last_error && isLeaseRejection(status.last_error.code)
          && (fixed?.task_id === task.task_id || !fixed && status.last_error.code === 'LEASE_REQUIRED' && record.pending.request.lease == null);
        const future = !state.lease && fixed?.task_id === task.task_id && targetMatches && allowedActor && hasOwnedFuture(state);
        preserve = !!(leaseRejection || future);
        if (preserve && !sameDocument(port.getSnapshot(), record?.document)) throw new Error('Native 与原草稿不一致，不能续领。');
        if (future) {
          await state.queue.whenPersisted(asset);
          const certificate = state.queue.getStatus(asset).local_commit;
          if (!current() || !hasOwnedFuture(state) || !certificate || certificate.generation !== record?.generation || certificate.edit_seq !== (record?.edit_seq ?? 0) || certificate.persist_seq < 1) throw new Error('缺少当前真实本地提交凭证。');
          futureCertificate = JSON.stringify(certificate);
          state.futureProof = { scope, host: host!, taskId: task.task_id, record: recordKey(state.queue.toRecord(asset)), certificate: futureCertificate };
        }
        if (preserve) retainedKey = recordKey(state.queue.toRecord(asset));
        if (!preserve && status.writes_paused && (status.dirty || status.last_error || record?.pending)) throw new Error('原请求暂停或结果未知；请先救援。');
        if (pendingImport(asset)) throw new Error('原图片存在未确认导入。');
        if (!preserve && (status.dirty || status.saving)) {
          if (!loaded || loaded.readOnlyPreview || host?.status !== 'ready' || !matchesTask(state, asset, loaded.ontology.ontology_version_id)) throw new Error('原草稿不能安全同步；未释放原任务。');
          await state.queue.flush(asset, current);
        }
        const after = state.queue.getStatus(asset);
        if (!current() || !preserve && (after.dirty || after.saving || after.last_error || state.queue.toRecord(asset)?.pending)) throw new Error('原范围尚未确认同步。');
      }
      for (const id of ids) {
        const allow = preserve && id === asset;
        if (await recovery.branchHold(id, allow, true) !== others.get(id)) throw new Error('其他草稿分支已变化。');
        holds.set(id, await recovery.branchHold(id, allow));
      }
      if (!current()) throw new Error('领取准备范围已变化。');
      return { token, isCurrent: current, release,
        validateCurrent: async () => { if (!current()) return false; for (const id of ids) if (await recovery.branchHold(id, preserve && id === asset) !== holds.get(id)) return false; return current(); },
        onTaskOpen(opened, lease) {
          if (!current() || opened.state !== 'open' || (opened.assignee_id !== session?.user_id && !session?.platform_admin) || opened.task_id !== task.task_id
            || opened.project_id !== state.projectId || opened.asset_revision_id !== task.asset_revision_id || opened.ontology_version_id !== task.ontology_version_id
            || lease.task_id !== opened.task_id || lease.asset_revision_id !== opened.asset_revision_id || lease.ontology_version_id !== opened.ontology_version_id
            || !Number.isSafeInteger(lease.fencing_token) || lease.fencing_token < 1 || state.leaseActor !== session?.user_id || state.lease?.fencing_token !== lease.fencing_token) throw new Error('领取回执与准备范围不匹配。');
          state.openTask(opened, lease, preserve);
        },
      };
    } catch (reason) { release(); throw reason; }
  }
  return {
    onPrepareTaskCreate: prepareCreate, onPrepareTaskOpen: prepareOpen,
    onLeaseChange(lease) {
      if (!sessionCurrent(state)) return;
      state.lease = lease; state.leaseActor = lease ? state.session!.user_id : null;
      // Claim/renew never retries an immutable save or clears unknown state.
      state.notify();
    },
    async onSubmitTask(task, submit) {
      const scopeCurrent = port.scopeGuard(), host = state.host, lease = state.lease;
      const current = () => scopeCurrent() && state.host === host && host?.status === 'ready'
        && state.fixedTask?.task_id === task.task_id && matchesTask(state, task.asset_revision_id, task.ontology_version_id)
        && !!lease && state.lease?.task_id === lease.task_id && state.lease.fencing_token === lease.fencing_token;
      if (!port.getHost() || task.task_id !== state.fixedTask?.task_id || task.asset_revision_id !== state.assetId || task.ontology_version_id !== state.loaded?.ontology.ontology_version_id) throw new Error('当前固定任务或保存状态不允许提交。');
      await submitCurrentReviewRevision({ task, queue: state.queue, readHead: async () => {
        if (!current()) throw new Error('身份或任务范围已变化。');
        const head = await api.annotation(task.asset_revision_id, task.ontology_version_id, state.assetRead?.signal ?? state.readonlyRequests.signal);
        if (!current()) throw new Error('读取版本期间身份或任务范围已变化。'); return head;
      }, submit: async revision => { if (!current() || !writableRole(state)) throw new Error('提交身份已变化。'); await submit(revision); },
      lockEditor(locked) { if (locked && state.submission) throw new Error('提交正在进行。'); state.submission = locked; state.host?.cancelGesture(); state.notify(); } });
    },
    async onContinueTask(input) {
      const scope = state.scope, host = port.getReadHost(), loaded = state.loaded, task = input.task;
      const certificate = state.queue.getStatus(task.asset_revision_id).local_commit;
      let preparation: symbol | null = null;
      const proof: TaskContinuationProof = { isCurrent(token) {
        if (token !== null) { if (state.preparation !== token || preparation !== null && preparation !== token) return false; preparation = token; }
        else if (preparation !== null) return false;
        const status = state.queue.getStatus(task.asset_revision_id), record = state.queue.toRecord(task.asset_revision_id);
        return sessionCurrent(state) && writableRole(state) && state.scope === scope && state.host === host && state.loaded === loaded && host?.status === 'ready'
          && state.fixedTask?.task_id === task.task_id && state.preparation === token && (!state.lease || token !== null)
          && !state.importing && !state.submission && !hasUnconfirmedImportForTarget(state.projectId, task.asset_revision_id, task.ontology_version_id)
          && status.phase === 'synced' && !status.dirty && !status.saving && !status.writes_paused && status.base_revision_id === input.submission.revision_ids[0]
          && !!certificate && JSON.stringify(status.local_commit) === JSON.stringify(certificate) && certificate.generation === status.local_generation
          && host.getGeneration() === status.local_generation && !!record && sameDocument(port.getSnapshot(), record.document);
      } };
      const next = await nextAssignedTask({ task, submission: input.submission, actorId: state.session?.user_id ?? '', projectId: state.projectId,
        isCurrent: () => input.isCurrent() && proof.isCurrent(null), read: {
          session: () => api.session(state.readonlyRequests.signal),
          submission: task => reviewApi.submission(task, state.readonlyRequests.signal),
          tasks: (project, cursor) => reviewApi.tasks(project, cursor, state.readonlyRequests.signal),
        } });
      return next ? { task: next, proof } : null;
    },
  };
}
