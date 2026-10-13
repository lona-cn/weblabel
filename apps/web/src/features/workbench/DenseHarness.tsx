import { useEffect, useRef, useState } from 'react';
import { generateDenseWorkload } from '../../../../../scripts/generate-dense-fixtures.mjs';
import { api, csrfToken, saveAuthorizationEpoch, setCsrfToken } from '../../lib/t15/api';
import { decodeCanonicalFrame, resourceStats } from '../../lib/editor/loader';
import type { AnnotationDocument, EditorAssetRequest, EditorDelta, MediaRevision, LocalObjectFlagMap } from '../../lib/editor/types';
import { EditorHost } from '../../lib/editor/EditorHost';
import { IndexedDbDraftStorage } from '../../lib/persistence/draft-store';
import { FetchSaveTransport, SaveQueue } from '../../lib/persistence/save-queue';
import type { SaveQueueOwner } from '../../lib/persistence/types';
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
  const ownerRef = useRef<SaveQueueOwner | null>(null);
  const queueRef = useRef<SaveQueue | null>(null);
  function createQueue(owner: SaveQueueOwner) {
    return new SaveQueue({ owner, storage: new IndexedDbDraftStorage(), transport: new FetchSaveTransport({ csrfToken,
      fetchImpl: (input, init) => { if (init?.method === 'PUT') saveCount.current += 1; return fetch(input, init); },
    }) });
  }
  if (!queueRef.current) queueRef.current = createQueue({ token: {}, actor_id: '', project_id: '', isCurrent: () => false, isWritable: () => false, canPrepareOperation: () => false, getLease: () => null });

  useEffect(() => {
    let alive = true;
    if (import.meta.env.MODE !== 'test') { setError('Test harness unavailable'); return; }
    setCsrfToken(sessionStorage.getItem('weblabel_csrf'));
    const authorizationEpoch = saveAuthorizationEpoch();
    const token = {};
    const isCurrent = () => alive && ownerRef.current?.token === token && saveAuthorizationEpoch() === authorizationEpoch;
    const query = new URLSearchParams(location.search);
    const project = query.get('project_id');
    const count = Number(query.get('count') ?? 2000);
    const seed = Number(query.get('seed') ?? 17);
    void (async () => {
      if (!project) throw new Error('Dense harness requires an authenticated synthetic project_id');
      const session = await api.session();
      if (!alive || saveAuthorizationEpoch() !== authorizationEpoch) return;
      const role = session.project_roles.find((entry) => entry.project_id === project)?.role;
      const owner: SaveQueueOwner = { token, actor_id: session.user_id, project_id: project, isCurrent, isWritable: () => isCurrent() && ['admin', 'annotator'].includes(role ?? ''), canPrepareOperation: () => true, getLease: () => null };
      ownerRef.current = owner;
      const queue = createQueue(owner);
      queueRef.current = queue;
      if (!owner.isWritable()) throw new Error('Dense harness requires write permission for its project');
      const assets = await api.assets(project);
      if (!owner.isWritable()) return;
      const ontology = (await api.ontologies(project)).items[0];
      if (!owner.isWritable()) return;
      const media = assets.find((asset) => asset.asset_revision_id === query.get('asset_revision_id')) ?? assets[0];
      if (!media || !ontology) throw new Error('Synthetic media and ontology prerequisites are missing');
      const head = await api.annotation(media.asset_revision_id, ontology.ontology_version_id);
      if (!owner.isWritable()) return;
      const workload = generateDenseWorkload(count, seed, media.canonical_width, media.canonical_height);
      const document: AnnotationDocument = { ...head.document, objects: workload.objects };
      if (!owner.isWritable()) return;
      const saved = await api.request<{ revision: { annotation_revision_id: string } }>(`/api/assets/${media.asset_revision_id}/annotation`, { method: 'PUT', body: JSON.stringify({ operation_id: crypto.randomUUID(), base_revision_id: head.annotation_revision_id, document, lease: null, suggestion_decisions: [] }) });
      if (!owner.isWritable()) return;
      const image = await api.image(media.asset_revision_id);
      if (!owner.isWritable()) return;
      const frame = await decodeCanonicalFrame(image, { width: media.canonical_width, height: media.canonical_height });
      if (!owner.isWritable()) return;
      const next: EditorAssetRequest = { media, ontology, document, frame, initial_generation: 7 };
      assetsRef.current = [media, ...assets.filter((asset) => asset !== media)];
      currentRef.current = next;
      baseRevisions.current.set(media.asset_revision_id, saved.revision.annotation_revision_id);
      queue.enqueue({ asset_revision_id: media.asset_revision_id, ontology_version_id: ontology.ontology_version_id, base_revision_id: saved.revision.annotation_revision_id, generation: 7, document, suggestion_decisions: [] });
      await queue.flush(media.asset_revision_id);
      if (!owner.isWritable()) return;
      setObjects(document.objects);
      setRequest(next);
    })().catch((reason: unknown) => { if (alive && saveAuthorizationEpoch() === authorizationEpoch) setError(reason instanceof Error ? reason.message : JSON.stringify(reason)); });
    return () => { alive = false; if (ownerRef.current?.token === token) ownerRef.current = null; removeT28TestHooks(); };
  }, []);

  function consume(host: EditorHost, delta: EditorDelta) {
    if (!ownerRef.current?.isWritable()) return;
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
    const owner = ownerRef.current;
    const queue = queueRef.current!;
    if (!owner?.isWritable()) return;
    hostRef.current = host;
    host.setActiveLabel(currentRef.current!.ontology.labels[0].label_id);
    host.select([currentRef.current!.document.objects[37].object_id]);
    await settled();
    if (!owner.isWritable()) return;
    const hooks: T28TestHooks = {
      ready: true,
      tool: (tool) => owner.isWritable() ? host.setTool(tool) : false,
      undo: async () => { if (!owner.isWritable()) return; host.dispatch({ kind: 'undo' }); await settled(); },
      stats: () => { const stats = host.getRenderStats(); if (!stats) throw new Error('Real renderer instrumentation missing'); const bridge = host.getBridgeStats();
        return { ...stats, js_wasm_calls: bridge.calls, js_wasm_bytes: bridge.binary_bytes, js_wasm_binary_bytes: bridge.binary_bytes, bridge_elapsed_ms: bridge.elapsed_ms,
          ...resourceStats, rejected_resources: stats.rejected_resources + resourceStats.rejected_resources }; },
      pan: async (dx, dy) => { if (!owner.isWritable()) return; host.pan(dx, dy); await settled(); },
      zoom: async (factor) => { if (!owner.isWritable()) return; host.zoomAt(200, 150, factor); await settled(); },
      editObject: async (index, dx = 1) => { if (!owner.isWritable()) return; const object = currentRef.current!.document.objects[index]; host.dispatch({ kind: 'replace_geometry', object_id: object.object_id, geometry: { ...object.geometry, x_max: object.geometry.x_max + dx } }); await settled(); },
      select: async (id) => { if (!owner.isWritable()) return; host.select([id]); await settled(); },
      setFlags: async (ids, flags) => { if (!owner.isWritable()) return; host.setLocalFlags(ids, flags); await settled(); },
      commitBulkAttributes: async () => { if (!owner.isWritable()) return; host.dispatch({ kind: 'set_attributes', object_ids: currentRef.current!.document.objects.map((object) => object.object_id), values: { helmet_state: 'wearing' } }); await settled(); },
      changeAsset: async (index) => {
        if (!owner.isWritable()) return;
        const current = currentRef.current!;
        await queue.flush(current.media.asset_revision_id);
        if (!owner.isWritable()) return;
        const media = assetsRef.current[index % assetsRef.current.length];
        const head = await api.annotation(media.asset_revision_id, current.ontology.ontology_version_id);
        if (!owner.isWritable()) return;
        const image = await api.image(media.asset_revision_id);
        if (!owner.isWritable()) return;
        const frame = await decodeCanonicalFrame(image, { width: media.canonical_width, height: media.canonical_height });
        if (!owner.isWritable()) return;
        const next = { media, ontology: current.ontology, document: head.document, frame, initial_generation: queue.getStatus(media.asset_revision_id).local_generation };
        currentRef.current = next;
        baseRevisions.current.set(media.asset_revision_id, head.annotation_revision_id);
        setObjects(next.document.objects);
        await host.loadAsset(next);
        if (!owner.isWritable()) return;
        host.setActiveLabel(next.ontology.labels[0].label_id);
        setSelected([]);
        setLocalFlags(host.getLocalFlags());
        await settled();
      },
      tryOverBudgetAsset: async () => { if (!owner.isWritable()) throw new Error('Dense harness owner is no longer writable'); const current = currentRef.current!; try { await host.loadAsset({ ...current, frame: { width: 8192, height: 8192, rgba: new Uint8Array(0) } }); if (!owner.isWritable()) throw new Error('Dense harness owner is no longer writable'); return true; } catch (reason) { if (!reason || typeof reason !== 'object' || !('code' in reason) || reason.code !== 'RESOURCE_BUDGET_EXCEEDED') throw reason; return false; } },
      flush: async () => { if (owner.isWritable()) await queue.flush(currentRef.current!.media.asset_revision_id); },
      snapshot: () => host.getSnapshot()!, viewport: () => host.getViewport()!, labels: () => host.getCanvasLabels(),
      saveCount: () => saveCount.current, validationInputObjects: () => host.getValidationInputObjects(), serializedInputObjects: () => host.getSerializedInputObjects(), generation: () => host.getGeneration()!,
    };
    installT28TestHooks(hooks);
  }

  return <main style={{ padding: 20 }}>
    <header><h1>Dense annotation laboratory</h1><p>Synthetic workload · actual Rust / WASM / WebGPU · authenticated API saves</p></header>
    {error ? <p role="alert">{error}</p> : null}
    {request ? <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 300px', gap: 20 }}>
      <section className="canvas-stage" style={{ height: 640, position: 'relative' }} aria-label="Dense annotation canvas"><CanvasView request={request} activeTool="select" onDelta={consume} onHostSettled={(host) => { if (host.status === 'ready') void ready(host); }} /></section>
      <ObjectList objects={objects} selectedIds={selected} localFlags={localFlags}
        onSetLocalFlags={(ids, flags) => { hostRef.current?.setLocalFlags(ids, flags); }}
        onSelect={(id) => { hostRef.current?.select([id]); }} />
    </div> : <p role="status">Preparing authenticated synthetic workload…</p>}
  </main>;
}
