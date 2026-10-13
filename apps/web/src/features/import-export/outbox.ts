import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import type { AnnotationImportCommitRequest, RevisionExportArtifact, RevisionExportIntent } from '../../lib/t15/api';
export type IntentTarget = Readonly<{ projectId: string; assetRevisionId: string; ontologyId: string }>;
export type ImportIntent = Readonly<{ scope: string; target: IntentTarget; batchId: string; payload: AnnotationImportCommitRequest; receipt: AnnotationRevision | null; sending: boolean }>;
export type ExportIntent = Readonly<{ scope: string; target: IntentTarget; revisionId: string; payload: RevisionExportIntent; artifact: RevisionExportArtifact | null; sending: boolean }>;
const imports = new Map<string, ImportIntent>();
const exports = new Map<string, ExportIntent>();
const listeners = new Set<() => void>();
let snapshot: Readonly<{ imports: readonly ImportIntent[]; exports: readonly ExportIntent[] }> = { imports: [], exports: [] };
// This feature memory survives React unmount, not browser reload. Never retain source files or preview documents.
function publish() { snapshot = { imports: [...imports.values()], exports: [...exports.values()] }; for (const listener of listeners) listener(); }
export function subscribeOutbox(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function getOutboxSnapshot() { return snapshot; }
export function hasUnconfirmedImportForTarget(projectId: string, assetRevisionId: string, ontologyId: string): boolean {
  return snapshot.imports.some(record => record.target.projectId === projectId && record.target.assetRevisionId === assetRevisionId && record.target.ontologyId === ontologyId && !record.receipt);
}
export function putImportIntent(record: ImportIntent): void { imports.set(record.payload.operation_id, Object.freeze(record)); publish(); }
export function removeImportIntent(record: ImportIntent): void {
  if (imports.get(record.payload.operation_id)?.scope !== record.scope) return;
  imports.delete(record.payload.operation_id); publish();
}
export function putExportIntent(record: ExportIntent): void { exports.set(record.payload.operation_id, Object.freeze(record)); publish(); }
export function removeExportIntent(record: ExportIntent): void {
  if (exports.get(record.payload.operation_id)?.scope !== record.scope) return;
  exports.delete(record.payload.operation_id); publish();
}
