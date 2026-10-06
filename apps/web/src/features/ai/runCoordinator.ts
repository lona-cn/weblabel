import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { RunContext } from '../../../../../packages/contracts/generated/RunContext';
import type { SaveQueue } from '../../lib/persistence/save-queue';

export interface RunFreezeInput {
  asset_revision_id: string;
  ontology_version_id: string;
  saveQueue: SaveQueue;
  getDocument: () => AnnotationDocument | null;
  getGeneration: () => number | null;
  refreshContext: (snapshot: { document: AnnotationDocument; generation: number; annotation_revision_id: string }) => RunContext | Promise<RunContext>;
}

export async function freezeAfterFlush(input: RunFreezeInput): Promise<{ context: RunContext; document: AnnotationDocument; generation: number }> {
  await input.saveQueue.flush(input.asset_revision_id);
  const document = input.getDocument();
  const generation = input.getGeneration();
  if (!document || generation === null || document.asset_revision_id !== input.asset_revision_id ||
    document.ontology_version_id !== input.ontology_version_id) {
    throw new Error('Editor snapshot does not match the active asset and ontology; no run was started.');
  }
  const status = input.saveQueue.getStatus(input.asset_revision_id);
  if (status.dirty || status.writes_paused || status.phase !== 'synced' ||
    status.synced_generation !== generation || !status.base_revision_id) {
    throw new Error('The latest editor generation is not acknowledged by the save queue; no run was started.');
  }
  const context = await input.refreshContext({ document, generation, annotation_revision_id: status.base_revision_id });
  if (context.asset_revision_id !== input.asset_revision_id || context.annotation_revision_id !== status.base_revision_id ||
    context.ontology_version_id !== document.ontology_version_id || context.draft_generation !== generation) {
    throw new Error('Refreshed AI context does not match the acknowledged editor snapshot; no run was started.');
  }
  return { context, document, generation };
}


