// T13 · save status + recovery/conflict surface. The indicator mirrors the real
// SaveQueue state (via useSyncExternalStore); the banners carry the mandated
// data-testids (docs/testing-contracts.md §3: save-status / recovery-banner /
// conflict-banner / export-local-draft).
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { JSX } from 'react';
import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import type { Id } from '../../../../../packages/contracts/generated/Id';
import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import { DraftComparison } from './DraftComparison';
import './workbench-ux.css';

import type { BranchDisposition, RecoveryReport } from '../../lib/persistence/recovery';
import type { SaveQueue } from '../../lib/persistence/save-queue';
import type { DraftBranchEnvelope, NativeDraftExport, SavePhase } from '../../lib/persistence/types';
import { serializeNativeDraft } from '../../lib/persistence/draft-store';
import { StorageError } from '../../lib/persistence/types';

export interface SaveStatusProps {
  queue: SaveQueue;
  scopeKey: string;
  isCurrentScope: (key: string) => boolean;
  canWrite: (key: string) => boolean;
  canReconcileInScope: (key: string) => boolean;
  canRetryOwnedFuture: (key: string) => boolean;
  asset_revision_id: Id;
  recovery?: RecoveryReport | null;
  /** Receives the native draft rescue payload; default writes a .json download. */
  onExportDraft?: (draft: NativeDraftExport) => void;
  /** Receives the server revision when the user picks "view server version". */
  onViewServer?: (revision: AnnotationRevision | null) => void;
  onResumeLocal?: () => void;
}

const PHASE_LABELS: Record<SavePhase, string> = {
  idle: '无待保存更改',
  unsaved: '有未保存更改',
  saved_local: '已保存到本地，待同步',
  saving: '正在同步到服务器…',
  synced: '已同步到服务器',
  save_failed: '保存失败，草稿已保留',
  storage_error: '本地存储失败，草稿仍可导出',
  paused: '写入已暂停，草稿已保留；请确认当前权限、任务或原请求',
  conflict: '保存结果或版本待核对，自动写入已暂停',
};

const RECOVERY_LABELS: Record<'restored' | 'conflict' | 'unreachable', string> = {
  restored: '已恢复未同步的本地草稿。',
  conflict: '本地草稿与服务器版本待核对。请先导出本地草稿，或查看服务器版本；不会自动覆盖任何一方。',
  unreachable: '当前图片或版本尚未完成核验，本地草稿已保留，可导出。',
};

interface SaveDiagnostic {
  kind?: string;
  code?: string;
  message: string;
  status?: number | null;
  request_id?: string | null;
  unknownOutcome?: boolean;
}

// Only structured identifiers select explanations; messages remain untouched.
// A retained failure records the last check, not current owner/lease eligibility.
function readableDiagnostic(error: SaveDiagnostic): string {
  if (error.unknownOutcome) return '原请求的保存结果尚未确认。后续错误不能证明原请求被拒绝；请保留草稿并只读核对服务器版本，不要替换原请求。';
  switch (error.code) {
    case 'REVISION_CONFLICT': return '上次保存时服务器版本已变化。请先下载本地草稿，再查看服务器版本，核对后决定如何处理。';
    case 'IDEMPOTENCY_KEY_REUSE': return '服务器拒绝了已用于不同内容的请求编号。请下载本地草稿并查看服务器版本；不要用新编号绕过原请求核对。';
    case 'LEASE_REQUIRED': return '上次保存缺少有效的任务租约。请在任务面板核对并领取当前任务，再使用“重试保存”；这不是版本冲突。';
    case 'LEASE_NOT_REQUIRED': return '上次保存携带的租约不适用于该图片。请核对当前任务，再使用“重试保存”；这不是版本冲突。';
    case 'LEASE_NOT_HELD': return '上次保存时账户不是任务租约持有人。请在任务面板核对持有人，取得租约后再重试；这不是版本冲突。';
    case 'LEASE_EXPIRED': return '上次保存时任务租约已过期。请在任务面板重新领取有效租约，再使用“重试保存”；这不是版本冲突。';
    case 'STALE_FENCING_TOKEN': return '上次保存的租约凭据已失效。请在任务面板核对当前租约，再使用“重试保存”；这不是版本冲突。';
    case 'TASK_STATE_INVALID': return '上次保存时该图片存在多个开放任务。请下载本地草稿，并请项目管理员核对任务分配后再重试。';
    case 'TASK_NOT_OPEN': return '上次保存时分配的任务未开放标注。请下载本地草稿，在任务面板核对任务状态后再重试。';
    case 'ONTOLOGY_NOT_FOUND': return '上次保存使用的标注规范版本未在该项目发布。请下载本地草稿，请项目管理员核对已发布规范和任务配置；不要直接更换规范后重发原请求。';
    case 'TASK_ONTOLOGY_MISMATCH': return '上次保存使用的标注规范与任务要求不一致。请先下载本地草稿，请项目管理员核对任务与规范版本；不要直接更换规范后重发原请求。';
    case 'DRAFT_OWNER_UNKNOWN': return '上次核对未找到原草稿作者，无法授权写入。请先下载本地草稿；不要把当前账户当作原作者。';
    case 'PENDING_OWNER_UNKNOWN': return '上次核对未找到原待确认请求作者，无法授权重放。请先下载本地草稿，并只读查看服务器版本；不要替换原请求。';
    case 'DRAFT_OWNER_MISMATCH': return '上次核对时账户或项目与原草稿作者不一致。请下载本地草稿，回到原作者的账户和项目后再核对；当前是否匹配尚需重新检查。';
    case 'PENDING_OWNER_MISMATCH': return '上次核对时账户或项目与原待确认请求作者不一致。请下载本地草稿，回到原作者的账户和项目后再核对原请求；当前是否匹配尚需重新检查。';
    case 'QUOTA_EXCEEDED': return '浏览器本地存储空间不足，未能完成本地保存。请立即下载本地草稿，保留副本后再处理存储空间；不要先清除此站点数据。';
    case 'STORAGE_FAILED':
    case 'STORAGE_OPEN_FAILED':
    case 'INDEXEDDB_UNAVAILABLE': return '浏览器未能完成本地存储操作。请先下载本地草稿，再检查浏览器是否允许此站点使用本地存储；不要先关闭页面或清除站点数据。';
    case 'STORAGE_READ_REVOKED': return '上次读取草稿时账户或项目范围已变化，读取已停止。请回到原账户和项目重新核对；可下载时先保留草稿副本。';
    case 'PROTOCOL_MISMATCH':
    case 'INVALID_ANNOTATION_RESPONSE': return '服务器响应未通过保存协议核验，原请求结果尚未确认。请先下载本地草稿并查看服务器版本；仅在原账户和项目下明确重试原请求，不要另建请求。';
    case 'PROJECT_WRITE_REQUIRED': return '上次保存被拒绝：账户缺少项目写权限。请下载本地草稿，并请项目管理员核对权限后再重试。';
  }
  if (error.kind === 'storage') return '本地存储操作失败，具体原因尚未确认。请先下载本地草稿，展开技术诊断核对；不要先关闭页面或清除站点数据。';
  if (error.kind === 'network') return '网络请求未完成，服务器是否已保存尚未确认。请下载本地草稿，恢复连接后查看服务器版本；需要重试时，在原账户和项目下重放原请求，不要另建请求。';
  if (error.status === 401) return '上次请求未通过身份验证。请先下载本地草稿，用原作者账户重新登录并回到原项目后再核对。';
  if (error.status === 403) return '上次请求被访问规则拒绝。请下载本地草稿，并核对当前账户的项目权限及本地服务入口后再重试。';
  if (error.kind === 'http' || error.kind === 'conflict') return '上次请求返回错误，具体原因和实际保存结果尚未确认。请先下载本地草稿并查看服务器版本，展开技术诊断核对；不能仅凭 HTTP 状态认定为版本冲突、未接受或已保存。';
  return '上次操作失败，原因和保存结果尚未确认。请先下载可用的本地草稿，展开技术诊断核对；不要据此认定已保存或替换原请求。';
}

function DiagnosticDetails({ error }: { error: SaveDiagnostic }): JSX.Element {
  return <details data-testid="save-diagnostic">
    <summary style={{ minHeight: 44, display: 'list-item', alignContent: 'center' }}>技术诊断（上次操作）</summary>
    <dl>
      <dt>kind</dt><dd>{error.kind ?? '未提供'}</dd>
      <dt>code</dt><dd>{error.code ?? '未提供'}</dd>
      <dt>status</dt><dd>{error.status ?? '未提供'}</dd>
      <dt>message</dt><dd style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{error.message}</dd>
      <dt>request_id</dt><dd style={{ overflowWrap: 'anywhere' }}>{error.request_id ?? '未提供'}</dd>
    </dl>
  </details>;
}

function downloadNativeDraft(draft: NativeDraftExport): void {
  const text = serializeNativeDraft(draft);
  const objectUrl = typeof URL.createObjectURL === 'function';
  const href = objectUrl
    ? URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    : `data:application/json;charset=utf-8,${encodeURIComponent(text)}`;
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = `weblabel-draft-${draft.asset_revision_id}.json`;
  anchor.click();
  if (objectUrl) URL.revokeObjectURL(href);
}

export function SaveStatus({
  queue,
  scopeKey,
  isCurrentScope,
  canWrite,
  canReconcileInScope,
  canRetryOwnedFuture,
  asset_revision_id,
  recovery = null,
  onExportDraft,
  onViewServer,
  onResumeLocal,
}: SaveStatusProps): JSX.Element {
  const [actionError, setActionError] = useState<SaveDiagnostic | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const busy = busyKey === scopeKey;
  const actionInFlight = useRef<{ key: string; token: object } | null>(null);
  const lifecycle = useRef<object | null>(null);
  useEffect(() => {
    const epoch = {};
    lifecycle.current = epoch;
    actionInFlight.current = null;
    setBusyKey(null);
    setActionError(null);
    return () => { if (lifecycle.current === epoch) lifecycle.current = null; };
  }, [scopeKey, queue, asset_revision_id]);
  const subscribe = useCallback(
    (onStoreChange: () => void) => queue.subscribe(asset_revision_id, onStoreChange),
    [queue, asset_revision_id],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    () => queue.getStatus(asset_revision_id),
    () => queue.getStatus(asset_revision_id),
  );

  const deliverDraft = (draft: NativeDraftExport): void => {
    if (onExportDraft) onExportDraft(draft);
    else downloadNativeDraft(draft);
  };

  const handleExport = (): void => {
    const draft = queue.exportDraft(asset_revision_id);
    if (draft !== null) deliverDraft(draft);
  };

  const runAction = async (action: 'retry' | 'keep_local_export' | 'view_server'): Promise<void> => {
    const key = scopeKey;
    const epoch = lifecycle.current;
    const current = () => epoch !== null && lifecycle.current === epoch && isCurrentScope(key);
    const writable = () => current() && canWrite(key);
    const retainedRetry = () => queue.canRetryRetained(asset_revision_id, () => current() && canReconcileInScope(key));
    if (actionInFlight.current?.key === key || !current() || (action === 'retry' && !writable() && !retainedRetry() && !canRetryOwnedFuture(key))) return;
    const token = {};
    actionInFlight.current = { key, token };
    setBusyKey(key);
    setActionError(null);
    try {
      if (action === 'retry') {
        // Initial retained eligibility is read-only and grants no fresh write authority.
        // Receipt reconciliation and IDB commit use a scope that survives pending clear.
        const permitted = queue.captureWriteGuard(asset_revision_id, () => current() && canReconcileInScope(key));
        const beforeRetry = queue.getStatus(asset_revision_id);
        const previousAck = beforeRetry.last_ack;
        const localAckCommitRetry = beforeRetry.writes_paused && !!previousAck && queue.toRecord(asset_revision_id)?.pending === null;
        const futureHandled = await queue.retryOwnedFuture(asset_revision_id, () => current() && canRetryOwnedFuture(key), permitted);
        if (!permitted()) return;
        const handled = futureHandled || await queue.retryRejectedLease(asset_revision_id, permitted);
        if (!permitted()) return;
        if (!handled) await queue.retry(asset_revision_id, permitted);
        if (!permitted()) return;
        const acknowledged = queue.getStatus(asset_revision_id).last_ack;
        if (!acknowledged || (acknowledged === previousAck && !localAckCommitRetry)) return;
        // A server receipt is not a durable local certificate. Await the latest
        // persistence attempt, including one queued while a previous put settled.
        if (!permitted()) return;
        await queue.whenPersisted(asset_revision_id);
        if (!permitted()) return;
        const confirmed = queue.getStatus(asset_revision_id);
        const record = queue.toRecord(asset_revision_id);
        const certificate = confirmed.local_commit;
        if (permitted() && writable() && record && record.pending === null && !record.writes_paused && !record.save_error &&
          confirmed.last_ack === acknowledged && record.base_revision_id === acknowledged.revision_id &&
          !confirmed.writes_paused && !confirmed.saving && !confirmed.last_error && certificate &&
          certificate.generation === record.generation && certificate.generation === confirmed.local_generation &&
          certificate.edit_seq === (record.edit_seq ?? 0)) onResumeLocal?.();
      } else {
        // Rescue never depends on a network read succeeding.
        if (action === 'keep_local_export') handleExport();
        const resolution = await queue.resolveConflict(asset_revision_id, action, action === 'view_server' ? current : writable);
        if (!current()) return;
        if (resolution.action === 'view_server') onViewServer?.(resolution.server_head);
        if (resolution.action === 'keep_local_export' && resolution.resumed && writable()) {
          const previousAck = queue.getStatus(asset_revision_id).last_ack;
          await queue.flush(asset_revision_id, writable);
          if (!writable()) return;
          await queue.whenPersisted(asset_revision_id);
          if (!writable()) return;
          const confirmed = queue.getStatus(asset_revision_id), record = queue.toRecord(asset_revision_id);
          const acknowledgement = confirmed.last_ack, certificate = confirmed.local_commit;
          if (record && acknowledgement && acknowledgement !== previousAck && certificate
            && !confirmed.saving && !confirmed.writes_paused && !confirmed.last_error
            && !record.writes_paused && !record.save_error && record.pending === null
            && record.base_revision_id === acknowledgement.revision_id
            && record.generation === record.synced_generation && record.synced_intent_seq === record.intent_journal.length
            && certificate.generation === record.generation && certificate.edit_seq === (record.edit_seq ?? 0)) onResumeLocal?.();
        }
      }
    } catch (error: unknown) {
      if (current()) {
        const failure = error as { kind?: unknown; code?: unknown; status?: unknown; message?: unknown; request_id?: unknown; api_error?: { request_id?: unknown } } | null;
        setActionError({
          unknownOutcome: queue.toRecord(asset_revision_id)?.pending_outcome === 'unknown',
          kind: error instanceof StorageError ? 'storage' : typeof failure?.kind === 'string' ? failure.kind : undefined,
          code: typeof failure?.code === 'string' ? failure.code : undefined,
          status: typeof failure?.status === 'number' ? failure.status : null,
          message: typeof failure?.message === 'string' ? failure.message : String(error),
          request_id: typeof failure?.api_error?.request_id === 'string' ? failure.api_error.request_id : typeof failure?.request_id === 'string' ? failure.request_id : null,
        });
      }
    } finally {
      if (actionInFlight.current?.token === token) {
        actionInFlight.current = null;
        if (current()) setBusyKey(null);
      }
    }
  };
  const handleKeepLocal = (): void => { void runAction('keep_local_export'); };
  const handleViewServer = (): void => { void runAction('view_server'); };

  const recoveryKind = recovery === null ? null : recovery.kind;
  const showRecoveryBanner = recoveryKind === 'restored' || recoveryKind === 'conflict' || recoveryKind === 'unreachable';
  const showConflictBanner = snapshot.phase === 'conflict' || recoveryKind === 'conflict';
  const canRetryRetained = queue.canRetryRetained(asset_revision_id, () => isCurrentScope(scopeKey) && canReconcileInScope(scopeKey));

  const diagnosticRecord = snapshot.last_error === null ? null : queue.toRecord(asset_revision_id);
  const recordError = diagnosticRecord?.save_error;
  const lastDiagnostic: SaveDiagnostic | null = snapshot.last_error === null ? null : {
    ...snapshot.last_error,
    unknownOutcome: diagnosticRecord?.pending_outcome === 'unknown',
    status: recordError?.kind === snapshot.last_error.kind && recordError.code === snapshot.last_error.code && recordError.message === snapshot.last_error.message ? recordError.status : null,
  };

  return (
    <section className="save-status-panel">
      <div
        className="save-status"
        data-testid="save-status"
        data-phase={snapshot.phase}
        data-dirty={snapshot.dirty ? 'true' : 'false'}
        role="status"
        aria-live="polite"
      >
        <span className="save-status-text">{PHASE_LABELS[snapshot.phase]}</span>
      </div>
      {snapshot.local_commit ? <p>本地已提交：操作版本 {snapshot.local_commit.generation}，编辑序号 {snapshot.local_commit.edit_seq}</p> : null}
      {snapshot.last_ack ? <p>服务器已确认操作版本 {snapshot.last_ack.generation}。</p> : null}
      <details>
        <summary style={{ minHeight: 44, display: 'list-item', alignContent: 'center' }}>保存记录与确认凭证（技术详情）</summary>
        <dl data-testid="save-certificate">
          <dt>local_commit</dt><dd>{snapshot.local_commit ? '本地提交凭证' : 'null（无本地提交凭证）'}</dd>
          {snapshot.local_commit ? <>
            <dt>local_commit.draft_id</dt><dd>{snapshot.local_commit.draft_id}</dd>
            <dt>local_commit.write_token</dt><dd>{snapshot.local_commit.write_token}</dd>
            <dt>local_commit.persist_seq</dt><dd>{snapshot.local_commit.persist_seq}</dd>
            <dt>local_commit.edit_seq</dt><dd>{snapshot.local_commit.edit_seq}</dd>
            <dt>local_commit.generation</dt><dd>{snapshot.local_commit.generation}</dd>
          </> : null}
          <dt>last_ack</dt><dd>{snapshot.last_ack ? '服务器确认凭证' : 'null（无服务器确认）'}</dd>
          {snapshot.last_ack ? <>
            <dt>last_ack.revision_id</dt><dd style={{ overflowWrap: 'anywhere' }}>{snapshot.last_ack.revision_id}</dd>
            <dt>last_ack.generation</dt><dd>{snapshot.last_ack.generation}</dd>
            <dt>last_ack.at</dt><dd style={{ overflowWrap: 'anywhere' }}>{snapshot.last_ack.at}</dd>
          </> : null}
        </dl>
      </details>
      {lastDiagnostic !== null ? (
        <div>
          <p role="alert" data-save-outcome={lastDiagnostic.unknownOutcome ? 'unknown' : diagnosticRecord?.pending_outcome === 'rejected' ? 'rejected' : 'unconfirmed'}>{readableDiagnostic(lastDiagnostic)}</p>
          <DiagnosticDetails error={lastDiagnostic} />
        </div>
      ) : null}
      {snapshot.phase === 'save_failed' || snapshot.phase === 'conflict' || (snapshot.writes_paused && !!snapshot.last_ack) || (snapshot.phase === 'paused' && snapshot.dirty) ? (
        <button type="button" data-testid="save-retry" disabled={busy || !isCurrentScope(scopeKey) || (!canWrite(scopeKey) && !canRetryRetained && !canRetryOwnedFuture(scopeKey))} onClick={() => { void runAction('retry'); }}>重试保存</button>
      ) : null}
      {snapshot.draft_exportable ? (
        <button type="button" data-testid="export-local-draft" onClick={handleExport}>
          下载本地草稿
        </button>
      ) : null}
      {showRecoveryBanner && recoveryKind !== null ? (
        <div className="recovery-banner" data-testid="recovery-banner" role="status">
          <p>{RECOVERY_LABELS[recoveryKind as 'restored' | 'conflict' | 'unreachable']}</p>
        </div>
      ) : null}
      {showConflictBanner ? (
        <div className="conflict-banner" data-testid="conflict-banner" data-save-outcome={diagnosticRecord?.pending_outcome === 'unknown' ? 'unknown' : diagnosticRecord?.pending_outcome === 'rejected' || snapshot.last_error?.code === 'REVISION_CONFLICT' ? 'rejected' : 'unconfirmed'} role="alert">
          <p>{diagnosticRecord?.pending_outcome === 'rejected' || (diagnosticRecord?.pending_outcome !== 'unknown' && snapshot.last_error?.code === 'REVISION_CONFLICT') ? '上次保存被拒绝。请先下载本地草稿或只读查看服务器版本；不会自动覆盖任何一方。' : RECOVERY_LABELS.conflict}</p>
          <button type="button" data-testid="conflict-keep-local" onClick={handleKeepLocal} disabled={busy}>
            导出并保留本地草稿
          </button>
          <button type="button" data-testid="conflict-view-server" onClick={handleViewServer} disabled={busy}>
            查看服务器版本
          </button>
        </div>
      ) : null}
      {snapshot.phase === 'paused' && snapshot.dirty && !showConflictBanner ? (
        <div className="recovery-banner" role="group" aria-label="暂停保存的只读核对">
          <p>可以只读核对服务器版本；不会清除原草稿、替换原请求或恢复自动写入。</p>
          <button type="button" data-testid="save-view-server" onClick={handleViewServer} disabled={busy || !isCurrentScope(scopeKey)}>查看服务器版本</button>
        </div>
      ) : null}
      {actionError !== null ? (
        <>
          <p data-testid="save-action-error" role="alert">{readableDiagnostic(actionError)}</p>
          <DiagnosticDetails error={actionError} />
        </>
      ) : null}
    </section>
  );
}

export function DraftRecoveryChoice({ branches, selected, busy, onChoose, onUseServer, onRescue, serverDocument, canReadBranch }: {
  branches: readonly { envelope: DraftBranchEnvelope; disposition: BranchDisposition }[];
  selected: string | null; busy: boolean; serverDocument?: AnnotationDocument; canReadBranch(envelope: DraftBranchEnvelope): boolean;
  onChoose(draftId: string): void; onUseServer(draftId: string): void; onRescue(draftId: string): void;
}) {
  const [checked, setChecked] = useState<string | null>(selected);
  useEffect(() => { setChecked(selected); }, [selected]);
  const labels = { unresolved: '未处理', synced: '已同步', recovered: '恢复后已同步', archived: '明确留档（不表示上传）', rescue_only: '只救援' };
  const compact = branches.length === 1 && branches[0].disposition === 'synced' && canReadBranch(branches[0].envelope);
  const contents = <fieldset data-testid="draft-branches"><legend>选择本地草稿分支（不会覆盖原记录）</legend>
    {branches.map(({ envelope, disposition }) => {
      const readable = disposition !== 'rescue_only' && canReadBranch(envelope);
      const raw = readable ? envelope.record : null;
      const metadata = (key: 'ontology_version_id' | 'base_revision_id' | 'updated_at') => { const value = raw && typeof raw === 'object' && key in raw ? Reflect.get(raw, key) : undefined; return typeof value === 'string' ? value : '未知'; };
      return <div key={envelope.draft_id}>
        <label><input type="radio" name="draft-branch" value={envelope.draft_id} checked={checked === envelope.draft_id} disabled={busy} onChange={() => setChecked(envelope.draft_id)} />分支 {envelope.draft_id} · {labels[disposition]}</label>
        <p>规范 {metadata('ontology_version_id')} · base {metadata('base_revision_id')} · 时间 {metadata('updated_at')}</p>
        <DraftComparison envelope={envelope} server={serverDocument} readable={readable} />
        <button type="button" disabled={busy || checked !== envelope.draft_id || !readable} onClick={() => { if (canReadBranch(envelope)) onChoose(envelope.draft_id); }}>恢复选中分支</button>
        <button type="button" disabled={busy || checked !== envelope.draft_id || !readable} onClick={() => { if (canReadBranch(envelope)) onUseServer(envelope.draft_id); }}>使用服务版并仅留档选中分支</button>
        <button type="button" disabled={busy || checked !== envelope.draft_id} onClick={() => onRescue(envelope.draft_id)}>下载选中分支原始草稿</button>
      </div>;
    })}
  </fieldset>;
  return compact ? <details className="draft-branch-fold"><summary>已同步草稿分支（技术详情）</summary>{contents}</details> : <section className="draft-branch-fold" aria-label="需要处理的本地草稿分支">{contents}</section>;
} 
