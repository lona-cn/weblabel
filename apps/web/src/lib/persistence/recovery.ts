// T13 · refresh recovery: compare the local draft record against the server
// head. Comparison is pure and read-only; only base == head may auto-restore,
// every other divergence becomes an explicit user choice (no last-write-wins).
import type {
  AnnotationRevision,
  Clock,
  DraftRecord,
  DraftStorage,
  Id,
  NativeDraftExport,
  SaveTransport,
  TransportError,
} from './types';
import { realClock } from './types';

import { exportNativeDraft } from './draft-store';

export const RECOVERY_CONFLICT_OPTIONS = ['keep_local_export', 'view_server'] as const;

export type RecoveryReport =
  | { kind: 'no_local_record' }
  | { kind: 'clean'; record: DraftRecord }
  | { kind: 'restored'; record: DraftRecord }
  | {
      kind: 'conflict';
      record: DraftRecord;
      server_head: AnnotationRevision | null;
      options: typeof RECOVERY_CONFLICT_OPTIONS;
    }
  | { kind: 'unreachable'; record: DraftRecord; error: { code: string; message: string } };

/** True when the record carries work the server has not acknowledged. */
export function hasUnsyncedWork(record: DraftRecord): boolean {
  return (
    record.generation > record.synced_generation ||
    record.intent_journal.length > record.synced_intent_seq ||
    record.pending !== null
  );
}

/**
 * Pure classification of a recovered record against the server head. Never
 * writes anything and never picks a winner: only base == head may auto-restore,
 * every other divergence is an explicit user choice (no last-write-wins).
 *
 * `clean` means the record carries no unsynced work; it is informational only
 * (e.g. for an unsaved-changes indicator) and MUST NOT be read as "load this
 * record": even a clean record can be older than the server head. Consumers
 * that need content should load the server head; a later save against a stale
 * base is stopped by the 409 write-pause, not silently merged.
 */
export function compareWithServer(
  record: DraftRecord,
  head: AnnotationRevision | null,
): RecoveryReport {
  if (!hasUnsyncedWork(record)) {
    return { kind: 'clean', record };
  }
  if (head !== null && head.annotation_revision_id === record.base_revision_id) {
    return { kind: 'restored', record };
  }
  return { kind: 'conflict', record, server_head: head, options: RECOVERY_CONFLICT_OPTIONS };
}

export interface RecoveryDeps {
  storage: DraftStorage;
  transport: SaveTransport;
}

/** Loads the local record, fetches the server head, and compares. Read-only. */
export async function runRecovery(
  deps: RecoveryDeps,
  asset_revision_id: Id,
): Promise<RecoveryReport> {
  const record = await deps.storage.get(asset_revision_id);
  if (record === null) {
    return { kind: 'no_local_record' };
  }
  try {
    const head = await deps.transport.fetchHead(record.asset_revision_id, record.ontology_version_id);
    return compareWithServer(record, head);
  } catch (error) {
    const failure = error as Partial<TransportError>;
    return {
      kind: 'unreachable',
      record,
      error: {
        code: failure.code ?? 'RECOVERY_UNREACHABLE',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** "Keep local (export)" side: the rescue download for the retained draft. */
export function keepLocalExport(record: DraftRecord, clock: Clock = realClock): NativeDraftExport {
  return exportNativeDraft(record, clock);
}

/** "View server version" side: read-only fetch of the diverged head revision. */
export function viewServerVersion(
  transport: SaveTransport,
  record: DraftRecord,
): Promise<AnnotationRevision | null> {
  return transport.fetchHead(record.asset_revision_id, record.ontology_version_id);
}
