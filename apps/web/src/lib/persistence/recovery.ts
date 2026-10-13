// T13: branch recovery compares the original local record with the server head.
// Comparison is pure; restoring a branch always requires an explicit choice.
import type { SourceRef } from './types';
import type {
  DraftBranchEnvelope, DraftBranchSnapshot,
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

import { DraftStore, admitRawDraft, exportNativeDraft } from './draft-store';

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
  | { kind: 'unreachable'; record: unknown; error: { kind: string; code: string; message: string; request_id: string | null } };

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
  draft_id: Id,
): Promise<RecoveryReport> {
  const envelope = await new DraftStore(deps.storage).load(asset_revision_id, draft_id);
  const record = envelope?.record ?? null;
  if (record === null) {
    return { kind: 'no_local_record' };
  }
  try {
    admitRawDraft(record, asset_revision_id);
    const head = await deps.transport.fetchHead(record.asset_revision_id, record.ontology_version_id);
    return compareWithServer(record, head);
  } catch (error) {
    const failure = error as Partial<TransportError>;
    return {
      kind: 'unreachable',
      record,
      error: {
        kind: failure.kind ?? 'network',
        request_id: failure.api_error?.request_id ?? null,
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

/** Display only: local sync markers are not independent server ACK evidence.
 * Never use for adoption, lineage, restore or write authority.
 * Explicit null authors are required; missing authors remain unknown. */
export function classifyReadonlySnapshot(value: unknown, asset: Id): 'clean_snapshot' | 'recovery_required' | 'rescue_only' {
  try { admitRawDraft(value, asset); } catch { return 'rescue_only'; }
  return value.draft_owner === null && value.pending_owner === null
    && !hasUnsyncedWork(value)
    && value.generation === value.synced_generation
    && value.intent_journal.length === value.synced_intent_seq
    && value.pending_outcome !== 'unknown' && value.pending_outcome !== 'rejected'
    && value.save_error == null && value.writes_paused !== true
    ? 'clean_snapshot' : 'recovery_required';
}
export type BranchDisposition = 'unresolved' | 'synced' | 'recovered' | 'archived' | 'rescue_only';
/** Explicit, token-bound decisions only. No source record is changed by classification. */
export function classifyDraftBranches(branches: readonly DraftBranchEnvelope[], memory: DraftBranchSnapshot | null): ReadonlyMap<Id, BranchDisposition> {
  const rows = new Map(branches.map(row => [row.draft_id, row]));
  if (memory) rows.set(memory.envelope.draft_id, memory.envelope);
  const committed = (row: DraftBranchEnvelope): boolean => {
    if (memory?.envelope.draft_id !== row.draft_id) return branches.some(disk => disk.draft_id === row.draft_id && disk.write_token === row.write_token);
    const proof = memory.local_commit;
    const record = row.record as Partial<DraftRecord> | null;
    return !!proof && !memory.ack_local_barrier && proof.draft_id === row.draft_id && proof.write_token === row.write_token && Number.isSafeInteger(proof.persist_seq) && proof.persist_seq > 0 && proof.generation === record?.generation && proof.edit_seq === (record?.edit_seq ?? record?.pending?.edit_seq ?? 0) && branches.some(disk => disk.draft_id === row.draft_id && disk.write_token === row.write_token);
  };
  const result = new Map<Id, BranchDisposition>();
  for (const row of rows.values()) {
    try {
      admitRawDraft(row.record, row.asset_revision_id);
      const record = row.record;
      result.set(row.draft_id, committed(row) && record.pending === null && record.generation === record.synced_generation && record.intent_journal.length === record.synced_intent_seq && record.writes_paused !== true && record.save_error == null ? 'synced' : 'unresolved');
    } catch { result.set(row.draft_id, 'rescue_only'); }
  }
  const intrinsic = new Map(result);
  const edges = new Map<Id, { destination: DraftBranchEnvelope; action: SourceRef['action'] }[]>();
  for (const destination of rows.values()) {
    if (!committed(destination) || !Array.isArray(destination.sources)) continue;
    for (const ref of destination.sources) {
      const source = rows.get(ref.draft_id);
      if (!source || source.write_token !== ref.write_token || !committed(source) || !['recover', 'use_server'].includes(ref.action)) continue;
      const outgoing = edges.get(source.draft_id) ?? [];
      outgoing.push({ destination, action: ref.action }); edges.set(source.draft_id, outgoing);
    }
  }
  function reaches(start: Id, target: Id, seen = new Set<Id>()): boolean {
    if (start === target) return true;
    if (seen.has(start)) return false;
    seen.add(start);
    return (edges.get(start) ?? []).some(edge => reaches(edge.destination.draft_id, target, seen));
  }
  function paths(source: DraftBranchEnvelope, visited: ReadonlySet<Id>): 'recovered' | 'archived' | null {
    if (visited.has(source.draft_id) || !committed(source)) return null;
    const seen = new Set(visited); seen.add(source.draft_id);
    let archived = false;
    for (const { destination, action } of edges.get(source.draft_id) ?? []) {
      // A circular acknowledgement cannot prove that any source was handled.
      if (seen.has(destination.draft_id) || reaches(destination.draft_id, source.draft_id)) continue;
      if (action === 'use_server') { archived = true; continue; }
      if (intrinsic.get(source.draft_id) === 'rescue_only') continue;
      const downstream = intrinsic.get(destination.draft_id) === 'synced' ? 'recovered' : paths(destination, seen);
      if (downstream === 'recovered') return 'recovered';
      if (downstream === 'archived') archived = true;
    }
    return archived ? 'archived' : null;
  }
  for (const row of rows.values()) {
    if (intrinsic.get(row.draft_id) === 'synced') continue;
    const disposition = paths(row, new Set());
    if (disposition) result.set(row.draft_id, disposition);
  }
  return result;
} 
