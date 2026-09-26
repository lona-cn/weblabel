// T13 · save status + recovery/conflict surface. The indicator mirrors the real
// SaveQueue state (via useSyncExternalStore); the banners carry the mandated
// data-testids (docs/testing-contracts.md §3: save-status / recovery-banner /
// conflict-banner / export-local-draft).
import { useCallback, useState, useSyncExternalStore } from 'react';
import type { JSX } from 'react';
import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import type { Id } from '../../../../../packages/contracts/generated/Id';

import type { RecoveryReport } from '../../lib/persistence/recovery';
import type { SaveQueue } from '../../lib/persistence/save-queue';
import type { NativeDraftExport, SavePhase } from '../../lib/persistence/types';
import { serializeNativeDraft } from '../../lib/persistence/draft-store';

export interface SaveStatusProps {
  queue: SaveQueue;
  asset_revision_id: Id;
  recovery?: RecoveryReport | null;
  /** Receives the native draft rescue payload; default writes a .json download. */
  onExportDraft?: (draft: NativeDraftExport) => void;
  /** Receives the server revision when the user picks "view server version". */
  onViewServer?: (revision: AnnotationRevision | null) => void;
}

const PHASE_LABELS: Record<SavePhase, string> = {
  idle: '无待保存更改',
  unsaved: '有未保存更改',
  saved_local: '已保存到本地，待同步',
  saving: '正在保存…',
  synced: '已同步到服务器',
  save_failed: '保存失败，草稿已保留',
  storage_error: '本地存储失败，草稿仍可导出',
  conflict: '保存冲突，自动写入已暂停',
};

const RECOVERY_LABELS: Record<'restored' | 'conflict' | 'unreachable', string> = {
  restored: '检测到未同步的本地草稿，已恢复到编辑队列。',
  conflict: '本地草稿与服务器版本不一致：请保留本地（可导出）或查看服务端版本，系统不会自动覆盖任何一方。',
  unreachable: '无法连接服务器，本地草稿已保留，可导出。',
};

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
  asset_revision_id,
  recovery = null,
  onExportDraft,
  onViewServer,
}: SaveStatusProps): JSX.Element {
  const [actionError, setActionError] = useState<string | null>(null);
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

  const handleKeepLocal = (): void => {
    setActionError(null);
    void queue
      .resolveConflict(asset_revision_id, 'keep_local_export')
      .then((resolution) => {
        if (resolution.action === 'keep_local_export') deliverDraft(resolution.export);
      })
      .catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error));
      });
  };

  const handleViewServer = (): void => {
    setActionError(null);
    void queue
      .resolveConflict(asset_revision_id, 'view_server')
      .then((resolution) => {
        if (resolution.action === 'view_server' && onViewServer) {
          onViewServer(resolution.server_head);
        }
      })
      .catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error));
      });
  };

  const recoveryKind = recovery === null ? null : recovery.kind;
  const showRecoveryBanner = recoveryKind === 'restored' || recoveryKind === 'conflict' || recoveryKind === 'unreachable';
  const showConflictBanner = snapshot.phase === 'conflict' || recoveryKind === 'conflict';

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
      {snapshot.draft_exportable ? (
        <button type="button" data-testid="export-local-draft" onClick={handleExport}>
          下载原生草稿
        </button>
      ) : null}
      {showRecoveryBanner && recoveryKind !== null ? (
        <div className="recovery-banner" data-testid="recovery-banner" role="status">
          <p>{RECOVERY_LABELS[recoveryKind as 'restored' | 'conflict' | 'unreachable']}</p>
        </div>
      ) : null}
      {showConflictBanner ? (
        <div className="conflict-banner" data-testid="conflict-banner" role="alert">
          <p>{RECOVERY_LABELS.conflict}</p>
          <button type="button" data-testid="conflict-keep-local" onClick={handleKeepLocal}>
            保留本地（导出）
          </button>
          <button type="button" data-testid="conflict-view-server" onClick={handleViewServer}>
            查看服务端版本
          </button>
        </div>
      ) : null}
      {actionError !== null ? (
        <p data-testid="save-action-error" role="alert">
          {actionError}
        </p>
      ) : null}
    </section>
  );
}
