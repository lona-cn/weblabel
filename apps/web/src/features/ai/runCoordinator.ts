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
  const liveDocument = input.getDocument();
  const document = liveDocument ? structuredClone(liveDocument) : null;
  const generation = input.getGeneration();
  if (!document || generation === null || document.asset_revision_id !== input.asset_revision_id ||
    document.ontology_version_id !== input.ontology_version_id) {
    throw new Error('当前标注与图片或类别规范不一致，本次运行未启动。');
  }
  const status = input.saveQueue.getStatus(input.asset_revision_id);
  if (status.dirty || status.writes_paused || status.phase !== 'synced' ||
    status.synced_generation !== generation || !status.base_revision_id) {
    throw new Error('最新标注尚未同步到服务器，本次运行未启动。');
  }
  const context = structuredClone(await input.refreshContext({ document, generation, annotation_revision_id: status.base_revision_id }));
  const currentDocument = input.getDocument();
  const currentStatus = input.saveQueue.getStatus(input.asset_revision_id);
  if (input.getGeneration() !== generation || !currentDocument ||
    currentDocument.asset_revision_id !== document.asset_revision_id ||
    currentDocument.ontology_version_id !== document.ontology_version_id ||
    currentStatus.base_revision_id !== status.base_revision_id || currentStatus.dirty ||
    currentStatus.writes_paused || currentStatus.phase !== 'synced' || currentStatus.synced_generation !== generation) {
    throw new Error('准备授权时图片或标注版本已变化，请重新确认范围。');
  }
  if (context.asset_revision_id !== input.asset_revision_id || context.annotation_revision_id !== status.base_revision_id ||
    context.ontology_version_id !== document.ontology_version_id || context.draft_generation !== generation) {
    throw new Error('授权范围与服务器已确认的标注版本不一致，本次运行未启动。');
  }
  return { context, document, generation };
}


