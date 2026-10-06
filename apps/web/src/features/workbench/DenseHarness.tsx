import { useEffect, useRef, useState } from 'react';
import { generateDenseWorkload } from '../../../../../scripts/generate-dense-fixtures.mjs';
import { api, csrfToken, setCsrfToken } from '../../lib/t15/api';
import { decodeCanonicalFrame, resourceStats } from '../../lib/editor/loader';
import type { AnnotationDocument, EditorAssetRequest, EditorDelta, MediaRevision, LocalObjectFlagMap } from '../../lib/editor/types';
import { EditorHost } from '../../lib/editor/EditorHost';
import { IndexedDbDraftStorage } from '../../lib/persistence/draft-store';
import { FetchSaveTransport, SaveQueue } from '../../lib/persistence/save-queue';
import { CanvasView } from './CanvasView';
import { ObjectList } from './ObjectList';
import { installT28TestHooks, removeT28TestHooks, type T28TestHooks } from './perf';

const settled = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/** TEST BUILD ONLY: synthetic annotations on authenticated, real API media.
 * The canvas, editor host, queue, IndexedDB and HTTP transport are production consumers. */
export default function DenseHarness() {
  const [request, setRequest] = useState<EditorAssetRequest | null>(null);
  const [objects, setObjects] = useState<AnnotationDocument['objects']>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [localFlags, setLocalFlags] = useState<LocalObjectFlagMap>({});
  const [error, setError] = useState<string | null>(null);
  const hostRef = useRef<EditorHost | null>(null);
  const currentRef = useRef<EditorAssetRequest | null>(null);
  const assetsRef = useRef<MediaRevision[]>([]);
  const saveCount = useRef(0);
  const baseRevisions = useRef(new Map<string, string>());
  const queueRef = useRef<SaveQueue | null>(null);
  if (!queueRef.current) queueRef.current = new SaveQueue({ storage: new IndexedDbDraftStorage(), transport: new FetchSaveTransport({ csrfToken,
    fetchImpl: (input, init) => { if (init?.method === 'PUT') saveCount.current += 1; return fetch(input, init); },
  }) });

  useEffect(() => {
    let alive = true;
    if (import.meta.env.MODE !== 'test') { setError('Test harness unavailable'); return; }
    setCsrfToken(sessionStorage.getItem('weblabel_csrf'));
    const query = new URLSearchParams(location.search);
    const project = query.get('project_id');
    const count = Number(query.get('count') ?? 2000);
    const seed = Number(query.get('seed') ?? 17);
    void (async () => {
      if (!project) throw new Error('Dense harness requires an authenticated synthetic project_id');
      const assets = await api.assets(project);
      if (!alive) return;
      const ontology = (await api.ontologies(project)).items[0];
      const media = assets.find((asset) => asset.asset_revision_id === query.get('asset_revision_id')) ?? assets[0];
      if (!media || !ontology) throw new Error('Synthetic media and ontology prerequisites are missing');
      const head = await api.annotation(media.asset_revision_id, ontology.ontology_version_id);
      const workload = generateDenseWorkload(count, seed, media.canonical_width, media.canonical_height);
      const document: AnnotationDocument = { ...head.document, objects: workload.objects };
      if (!alive) return;
      const saved = await api.request<{ revision: { annotation_revision_id: string } }>(`/api/assets/${media.asset_revision_id}/annotation`, { method: 'PUT', body: JSON.stringify({ operation_id: crypto.randomUUID(), base_revision_id: head.annotation_revision_id, document, lease: null, suggestion_decisions: [] }) });
      const frame = await decodeCanonicalFrame(await api.image(media.asset_revision_id), { width: media.canonical_width, height: media.canonical_height });
      if (!alive) return;
      const next: EditorAssetRequest = { media, ontology, document, frame, initial_generation: 7 };
      assetsRef.current = [media, ...assets.filter((asset) => asset !== media)];
      currentRef.current = next;
      baseRevisions.current.set(media.asset_revision_id, saved.revision.annotation_revision_id);
      queueRef.current!.enqueue({ asset_revision_id: media.asset_revision_id, ontology_version_id: ontology.ontology_version_id, base_revision_id: saved.revision.annotation_revision_id, generation: 7, document, suggestion_decisions: [] });
      await queueRef.current!.flush(media.asset_revision_id);
      if (!alive) return;
      setObjects(document.objects);
      setRequest(next);
    })().catch((reason: unknown) => { if (alive) setError(reason instanceof Error ? reason.message : JSON.stringify(reason)); });
    return () => { alive = false; removeT28TestHooks(); };
  }, []);

  function consume(host: EditorHost, delta: EditorDelta) {
    if (delta.error) { setError(`${delta.error.code}: ${delta.error.message}`); return; }
    setError(null);
    setSelected(current => current.length === delta.selected_object_ids.length && current.every((id, index) => id === delta.selected_object_ids[index]) ? current : delta.selected_object_ids);
    setLocalFlags(host.getLocalFlags());
    const document = host.getCommittedSnapshot(delta);
    const current = currentRef.current;
    if (!document || !current) return;
    current.document = document;
    setObjects(document.objects);
    queueRef.current!.enqueue({ asset_revision_id: current.media.asset_revision_id, ontology_version_id: current.ontology.ontology_version_id,
      base_revision_id: queueRef.current!.getStatus(current.media.asset_revision_id).base_revision_id ?? baseRevisions.current.get(current.media.asset_revision_id)!, generation: delta.generation, document, suggestion_decisions: delta.suggestion_decisions });
  }

  async function ready(host: EditorHost) {
    hostRef.current = host;
    host.setActiveLabel(currentRef.current!.ontology.labels[0].label_id);
    host.select([currentRef.current!.document.objects[37].object_id]);
    await settled();
    const hooks: T28TestHooks = {
      ready: true,
      tool: (tool) => host.setTool(tool),
      undo: async () => { host.dispatch({ kind: 'undo' }); await settled(); },
      stats: () => { const stats = host.getRenderStats(); if (!stats) throw new Error('Real renderer instrumentation missing'); const bridge = host.getBridgeStats();
        return { ...stats, js_wasm_calls: bridge.calls, js_wasm_bytes: bridge.binary_bytes, js_wasm_binary_bytes: bridge.binary_bytes, bridge_elapsed_ms: bridge.elapsed_ms,
          ...resourceStats, rejected_resources: stats.rejected_resources + resourceStats.rejected_resources }; },
      pan: async (dx, dy) => { host.pan(dx, dy); await settled(); },
      zoom: async (factor) => { host.zoomAt(200, 150, factor); await settled(); },
      editObject: async (index, dx = 1) => { const object = currentRef.current!.document.objects[index]; host.dispatch({ kind: 'replace_geometry', object_id: object.object_id, geometry: { ...object.geometry, x_max: object.geometry.x_max + dx } }); await settled(); },
      select: async (id) => { host.select([id]); await settled(); },
      setFlags: async (ids, flags) => { host.setLocalFlags(ids, flags); await settled(); },
      commitBulkAttributes: async () => { host.dispatch({ kind: 'set_attributes', object_ids: currentRef.current!.document.objects.map((object) => object.object_id), values: { helmet_state: 'wearing' } }); await settled(); },
      changeAsset: async (index) => {
        const current = currentRef.current!;
        await queueRef.current!.flush(current.media.asset_revision_id);
        const media = assetsRef.current[index % assetsRef.current.length];
        const head = await api.annotation(media.asset_revision_id, current.ontology.ontology_version_id);
        const frame = await decodeCanonicalFrame(await api.image(media.asset_revision_id), { width: media.canonical_width, height: media.canonical_height });
        const next = { media, ontology: current.ontology, document: head.document, frame, initial_generation: queueRef.current!.getStatus(media.asset_revision_id).local_generation };
        currentRef.current = next;
        baseRevisions.current.set(media.asset_revision_id, head.annotation_revision_id);
        setObjects(next.document.objects);
        await host.loadAsset(next);
        host.setActiveLabel(next.ontology.labels[0].label_id);
        setSelected([]);
        setLocalFlags(host.getLocalFlags());
        await settled();
      },
      tryOverBudgetAsset: async () => { const current = currentRef.current!; try { await host.loadAsset({ ...current, frame: { width: 8192, height: 8192, rgba: new Uint8Array(0) } }); return true; } catch (reason) { if (!reason || typeof reason !== 'object' || !('code' in reason) || reason.code !== 'RESOURCE_BUDGET_EXCEEDED') throw reason; return false; } },
      flush: async () => { await queueRef.current!.flush(currentRef.current!.media.asset_revision_id); },
      snapshot: () => host.getSnapshot()!, viewport: () => host.getViewport()!, labels: () => host.getCanvasLabels(),
      saveCount: () => saveCount.current, validationInputObjects: () => host.getValidationInputObjects(), serializedInputObjects: () => host.getSerializedInputObjects(), generation: () => host.getGeneration()!,
    };
    installT28TestHooks(hooks);
  }

  return <main style={{ padding: 20 }}>
    <header><h1>Dense annotation laboratory</h1><p>Synthetic workload · actual Rust / WASM / WebGPU · authenticated API saves</p></header>
    {error ? <p role="alert">{error}</p> : null}
    {request ? <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 300px', gap: 20 }}>
      <section style={{ height: 640 }} aria-label="Dense annotation canvas"><CanvasView request={request} activeTool="select" onDelta={consume} onHostReady={(host) => { void ready(host); }} /></section>
      <ObjectList objects={objects} selectedIds={selected} localFlags={localFlags}
        onSetLocalFlags={(ids, flags) => { hostRef.current?.setLocalFlags(ids, flags); }}
        onSelect={(id) => { hostRef.current?.select([id]); }} />
    </div> : <p role="status">Preparing authenticated synthetic workload…</p>}
  </main>;
}
