import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { ModelProfile } from '../../../../../packages/contracts/generated/ModelProfile';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import type { RunContext } from '../../../../../packages/contracts/generated/RunContext';
import type { EditorHost } from '../../lib/editor/EditorHost';
import type { SaveQueue } from '../../lib/persistence/save-queue';
import { api, csrfToken, type ApiMedia } from '../../lib/t15/api';
import { Panel } from './Panel';
import type { ConsentPreview } from './useRun';

export function WorkbenchAi({ assetId, media, ontology, host, queue, revisionId, selectedIds }: {
  assetId: string;
  media: ApiMedia | null;
  ontology: OntologyVersion | null;
  host: EditorHost | null;
  queue: SaveQueue;
  revisionId: string | null;
  selectedIds: readonly string[];
}) {
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const subscribe = useCallback((notify: () => void) => assetId ? queue.subscribe(assetId, notify) : () => {}, [queue, assetId]);
  const syncedRevision = useSyncExternalStore(subscribe, () => assetId ? queue.getStatus(assetId).base_revision_id : null, () => null);
  useEffect(() => {
    let active = true;
    api.request<{ items: ModelProfile[] }>('/api/model-profiles').then((result) => {
      if (active) { setProfiles(result.items); setError(null); }
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; };
  }, []);

  // Keep the panel instance across asset switches so previously authorized runs
  // remain pinned to their original asset; live getters never return old hosts.
  const [lastReady, setLastReady] = useState<{ ontology: OntologyVersion; context: RunContext } | null>(null);
  const generation = host?.getGeneration() ?? null;
  const objectHashes = useMemo(() => host?.getObjectHashes() ?? {}, [host, generation]);
  const baseRevision = media ? syncedRevision ?? revisionId : null;
  const ready = host?.status === 'ready' && media && ontology && generation !== null && baseRevision ? {
    ontology,
    context: {
      project_id: media.project_id, asset_revision_id: media.asset_revision_id,
      annotation_revision_id: baseRevision, ontology_version_id: ontology.ontology_version_id,
      draft_generation: generation, canonical_sha256: media.canonical_sha256,
      selected_object_ids: [...selectedIds], object_hashes: objectHashes, input_fingerprint: '',
    } satisfies RunContext,
  } : null;
  useEffect(() => {
    if (ready) setLastReady(ready);
  }, [host, media, ontology, generation, baseRevision, selectedIds]);
  const shown = ready ?? lastReady;

  const refreshContext = (snapshot: { document: AnnotationDocument; generation: number; annotation_revision_id: string }): RunContext => {
    if (!host || !media || !ontology || media.asset_revision_id !== assetId ||
      snapshot.document.asset_revision_id !== assetId || host.getGeneration() !== snapshot.generation) {
      throw new Error('Active editor changed while preparing the AI scope.');
    }
    const hashes = host.getObjectHashes();
    if (!hashes) throw new Error('The Rust editor could not provide pinned object hashes.');
    return {
      project_id: media.project_id, asset_revision_id: assetId,
      annotation_revision_id: snapshot.annotation_revision_id,
      ontology_version_id: ontology.ontology_version_id, draft_generation: snapshot.generation,
      canonical_sha256: media.canonical_sha256, selected_object_ids: [...selectedIds],
      object_hashes: hashes, input_fingerprint: '',
    };
  };
  const obtainConsent = async (preview: ConsentPreview): Promise<string> => {
    const result = await api.request<{ consent_id: string }>('/api/ai/consents', {
      method: 'POST', body: JSON.stringify({
        profile_id: preview.profile.profile_id, input_fingerprint: preview.context.input_fingerprint,
        approved_grants: preview.grants,
      }),
    });
    return result.consent_id;
  };

  return <section aria-label="工作台 AI 审校">
    {error ? <p role="alert">模型配置不可用：{error}</p> : null}
    {shown ? <Panel asset_revision_id={assetId} profiles={profiles} context={shown.context}
      ontology={shown.ontology} generation={generation ?? -1}
      getDocument={() => host?.getSnapshot() ?? null} getGeneration={() => host?.getGeneration() ?? null}
      dispatch={(command) => host?.dispatch(command) ?? null} saveQueue={queue}
      refreshContext={refreshContext} obtainConsent={obtainConsent} csrfToken={csrfToken()}
      grants={{ image: true, selected_objects: true, crop: null }} /> : <p role="status">加载编辑器后可审校当前图像。</p>}
  </section>;
}
