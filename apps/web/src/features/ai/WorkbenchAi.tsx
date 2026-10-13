import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { ModelProfile } from '../../../../../packages/contracts/generated/ModelProfile';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import type { RunContext } from '../../../../../packages/contracts/generated/RunContext';
import type { AiConsentRequest } from '../../../../../packages/contracts/generated/AiConsentRequest';
import type { AiConsentResponse } from '../../../../../packages/contracts/generated/AiConsentResponse';
import type { EditorHost } from '../../lib/editor/EditorHost';
import type { SaveQueue } from '../../lib/persistence/save-queue';
import { api, csrfToken, type ApiMedia } from '../../lib/t15/api';
import { Panel } from './Panel';
import type { ConsentPreview, RunScope } from './useRun';

export interface WorkbenchAiEditorPort {
  getDocument(): AnnotationDocument | null;
  getGeneration(): number | null;
  getObjectHashes(): Record<string, string> | null;
  dispatch: EditorHost['dispatch'];
  focusRegion: EditorHost['focusRegion'];
}

export function WorkbenchAi({ assetId, media, ontology, editor, queue, revisionId, selectedIds, onModelWaitingChange, profilesRevision, onRunScopeChange }: {
  assetId: string;
  media: ApiMedia | null;
  ontology: OntologyVersion | null;
  editor: WorkbenchAiEditorPort | null;
  queue: SaveQueue;
  revisionId: string | null;
  selectedIds: readonly string[];
  profilesRevision: number;
  onModelWaitingChange?: (waiting: boolean) => void;
  onRunScopeChange?: (scope: RunScope | null) => void;
}) {
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [profileCheck, setProfileCheck] = useState(0);
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
  }, [profileCheck, profilesRevision]);

  // Keep the panel instance across asset switches so previously authorized runs
  // remain pinned to their original asset; live getters never return old hosts.
  const [lastReady, setLastReady] = useState<{ ontology: OntologyVersion; context: RunContext } | null>(null);
  const generation = editor?.getGeneration() ?? null;
  const objectHashes = useMemo(() => editor?.getObjectHashes() ?? {}, [editor, generation]);
  const baseRevision = media ? syncedRevision ?? revisionId : null;
  const ready = editor && media && ontology && generation !== null && baseRevision ? {
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
  }, [editor, media, ontology, generation, baseRevision, selectedIds]);
  const shown = ready ?? lastReady;

  const refreshContext = (snapshot: { document: AnnotationDocument; generation: number; annotation_revision_id: string }): RunContext => {
    if (!editor || !media || !ontology || media.asset_revision_id !== assetId ||
      snapshot.document.asset_revision_id !== assetId || snapshot.document.ontology_version_id !== ontology.ontology_version_id || editor.getGeneration() !== snapshot.generation) {
      throw new Error('准备授权时图片或标注已变化，请重新确认范围。');
    }
    const hashes = editor.getObjectHashes();
    if (!hashes) throw new Error('无法确认对象版本，请重新加载后再试。');
    return {
      project_id: media.project_id, asset_revision_id: assetId,
      annotation_revision_id: snapshot.annotation_revision_id,
      ontology_version_id: ontology.ontology_version_id, draft_generation: snapshot.generation,
      canonical_sha256: media.canonical_sha256, selected_object_ids: [...selectedIds],
      object_hashes: hashes, input_fingerprint: '',
    };
  };
  const obtainConsent = async (preview: ConsentPreview): Promise<string> => {
    const result = await api.request<AiConsentResponse>('/api/ai/consents', {
      method: 'POST', body: JSON.stringify({
        preview_id: preview.preview_id,
      } satisfies AiConsentRequest),
    });
    return result.consent_id;
  };

  return <section className="workbench-ai" aria-label="工作台 AI 审校">
    <div className="panel-heading"><h2>AI 审校</h2><span>按次授权</span></div>
    {error ? <div role="alert"><p>模型配置读取失败。人工标注可继续；检查登录与读取权限后只读重新检查，不会调用模型。</p><details><summary>读取错误详情</summary>{error}</details></div> : null}
    <button type="button" onClick={() => setProfileCheck(value => value + 1)}>只读重新检查模型列表</button>
    {shown ? <Panel asset_revision_id={assetId} profiles={profiles} context={shown.context}
      ontology={shown.ontology} generation={generation ?? -1}
      getDocument={() => editor?.getDocument() ?? null} getGeneration={() => editor?.getGeneration() ?? null}
      dispatch={(command) => editor?.dispatch(command) ?? null} saveQueue={queue}
      onFocusRegion={ready ? bounds => {
        if (!media || !ontology || media.project_id !== ontology.project_id || media.asset_revision_id !== assetId) return false;
        const document = editor?.getDocument();
        return !!document && document.asset_revision_id === ready.context.asset_revision_id
          && document.ontology_version_id === ready.context.ontology_version_id && (editor?.focusRegion(bounds) ?? false);
      } : undefined}
      refreshContext={refreshContext} obtainConsent={obtainConsent} csrfToken={csrfToken()}
      onModelWaitingChange={onModelWaitingChange} onRunScopeChange={onRunScopeChange}
      grants={{ allow_image: true, allow_object_context: true, preview_crop: null }} /> : <p role="status">加载编辑器后可审校当前图像。</p>}
  </section>;
}
