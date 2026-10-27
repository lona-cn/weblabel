import { generateDenseWorkload } from '../../../../../scripts/generate-dense-fixtures.mjs';
import type { PageContext } from '../../ui/page-context';
import { api, csrfToken, saveAuthorizationEpoch, setCsrfToken, subscribeSaveAuthorization } from '../../lib/t15/api';
import { decodeCanonicalFrame, resourceStats } from '../../lib/editor/loader';
import { EditorHost } from '../../lib/editor/EditorHost';
import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import type { SaveResponse } from '../../../../../packages/contracts/generated/SaveResponse';
import { IndexedDbDraftStorage } from '../../lib/persistence/draft-store';
import { FetchSaveTransport, SaveQueue } from '../../lib/persistence/save-queue';
import type { AnnotationDocument, EditorAssetRequest } from '../../lib/editor/types';
import { createWorkspaceState, applyDelta } from './workspace-data';
import { createEditorPort } from './editor-port';
import { mountObjectsView } from './objects-view';
import { element } from './view-elements';
import { installT28TestHooks, removeT28TestHooks, type T28TestHooks } from './perf';
import './native-workbench.css';
function settled() {
  const { promise, resolve } = Promise.withResolvers<void>();
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  return promise;
}

/** Test-mode-only synthetic annotations; real authenticated HTTP, IndexedDB, Rust/WASM and wgpu. */
export function mountDenseHarness(root: HTMLElement, context: PageContext): () => void {
  if (import.meta.env.MODE !== 'test') throw new Error('Test harness unavailable');
  const life = new AbortController();
  const stop = () => life.abort();
  context.signal.addEventListener('abort', stop, { once: true });
  setCsrfToken(sessionStorage.getItem('weblabel_csrf'));
  const epoch = saveAuthorizationEpoch(), initialIdentity = context.session.getSnapshot();
  const query = new URL(location.href).searchParams, projectId = query.get('project_id') ?? '';
  const state = createWorkspaceState(context.session, { projectId, assetId: '', ontologyId: '', taskId: null }, life.signal);
  let saveCount = 0, request: EditorAssetRequest | null = null, disposed = false;
  const current = () => !life.signal.aborted && state.alive && epoch === saveAuthorizationEpoch() && context.session.getSnapshot() === initialIdentity;
  const writable = () => current() && state.owner.isWritable();
  state.queue = new SaveQueue({ owner: state.owner, storage: new IndexedDbDraftStorage(), transport: new FetchSaveTransport({ csrfToken,
    fetchImpl: (input, init) => { if (init?.method === 'PUT') saveCount++; return fetch(input, init); },
  }) });
  const queue = state.queue;
  const main = element('main', undefined, 'r07-workbench dense-harness'), header = element('header'), error = element('p');
  header.append(element('h1', 'Dense annotation laboratory'), element('p', 'Synthetic workload · actual Rust / WASM / WebGPU · authenticated API saves'));
  error.setAttribute('role', 'alert'); error.hidden = true;
  const preparing = element('p', 'Preparing authenticated synthetic workload…'); preparing.setAttribute('role', 'status');
  const workspace = element('div', undefined, 'dense-workspace'), region = element('section', undefined, 'r07-canvas-region'), stage = element('div', undefined, 'r07-canvas-stage');
  region.setAttribute('aria-label', 'Dense annotation canvas');
  const canvas = element('canvas'); canvas.dataset.testid = 'annotation-canvas'; canvas.tabIndex = 0; canvas.setAttribute('aria-label', 'WebGPU 标注画布');
  const labels = element('div', undefined, 'r07-canvas-labels'); labels.setAttribute('aria-hidden', 'true');
  const gpu = element('p'); gpu.dataset.testid = 'gpu-status'; gpu.setAttribute('role', 'status');
  const objects = element('aside'); stage.append(canvas, labels); region.append(stage, gpu); workspace.append(region, objects); workspace.hidden = true;
  main.append(header, error, preparing, workspace); root.append(main);
  const port = createEditorPort(state), unmountObjects = mountObjectsView(objects, state, port, life.signal);
  const host = new EditorHost({ onDelta(delta) { if (writable()) applyDelta(state, port, host, delta); } });
  const labelNodes = new Map<string, HTMLSpanElement>();
  let namesFor: readonly unknown[] | null = null, names = new Map<string, string>();
  const unsubscribeRender = host.subscribeRendered(() => {
    if (!current()) return;
    if (namesFor !== state.objects) {
      namesFor = state.objects;
      const categories = new Map(state.loaded?.ontology.labels.map(label => [label.label_id, label.name]));
      names = new Map(state.objects.map((object, index) => [object.object_id, (categories.get(object.label_id) ?? object.label_id) + ' #' + (index + 1)]));
    }
    const present = new Set<string>();
    let position = labels.firstElementChild;
    for (const label of host.getCanvasLabels()) {
      present.add(label.object_id); let node = labelNodes.get(label.object_id);
      if (!node) { node = element('span'); node.dataset.testid = 'canvas-label'; node.dataset.objectId = label.object_id; labelNodes.set(label.object_id, node); labels.append(node); }
      if (node !== position) labels.insertBefore(node, position);
      position = node.nextElementSibling;
      node.textContent = names.get(label.object_id) ?? label.object_id; node.dataset.selected = String(label.selected);
      node.style.transform = 'translate(' + label.x_css + 'px,' + label.y_css + 'px)';
    }
    for (const [id, node] of labelNodes) if (!present.has(id)) { node.remove(); labelNodes.delete(id); }
  });
  const unsubscribeStatus = host.subscribeStatus(() => {
    if (!current()) return;
    state.hostStatus = host.status;
    const diagnostics = host.getAdapterDiagnostics();
    gpu.dataset.actualBackend = host.status === 'ready' ? 'webgpu' : 'none';
    gpu.dataset.adapterKind = /swiftshader|llvmpipe|lavapipe|software|basic render|device_type=Cpu/i.test(diagnostics) ? 'software' : /DiscreteGpu|IntegratedGpu|nvidia|intel|amd|apple|blackwell/i.test(diagnostics) ? 'hardware' : 'unknown';
    gpu.dataset.deviceState = host.status; gpu.textContent = host.status + ' · ' + diagnostics;
    canvas.inert = host.status !== 'ready';
    state.notify();
  });
  const unsubscribeErrors = state.subscribe(() => { error.hidden = !state.error; error.textContent = state.error ?? ''; });
  const unsubscribeSession = context.session.subscribe(() => { if (!current()) stop(); });
  const unsubscribeAuth = subscribeSaveAuthorization(() => { if (!current()) stop(); });
  function check() { if (!writable()) throw new Error('Dense harness owner is no longer writable'); }
  async function load(next: EditorAssetRequest, revision: AnnotationRevision) {
    check(); request = next; state.assetId = next.media.asset_revision_id; state.ontologyId = next.ontology.ontology_version_id;
    state.loaded = { ...next, revision, readOnlyPreview: false }; state.document = next.document; state.objects = next.document.objects;
    state.flags = {}; state.previewSelection = []; state.nativeDocuments.set(host, next.document); state.host = host; state.phase = 'ready';
    await host.loadAsset(next); check();
    host.setActiveLabel(next.ontology.labels[0].label_id); state.activeLabel = next.ontology.labels[0].label_id; state.notify();
  }
  void (async () => {
    if (!projectId) throw new Error('Dense harness requires an authenticated synthetic project_id');
    const session = await api.session(life.signal); if (!current()) return;
    const role = session.project_roles.find(item => item.project_id === projectId)?.role;
    if (initialIdentity.kind !== 'authenticated' || initialIdentity.session.user_id !== session.user_id || initialIdentity.session.platform_admin !== session.platform_admin
      || initialIdentity.session.project_roles.find(item => item.project_id === projectId)?.role !== role) throw new Error('Dense harness requires a verified authenticated identity and roles');
    const projects = await api.projects(life.signal); if (!current()) return;
    state.project = projects.items.find(project => project.project_id === projectId) ?? null; check();
    const assets = await api.assets(projectId, life.signal); check();
    const ontology = (await api.ontologies(projectId, life.signal)).items[0]; check();
    const target = query.get('asset_revision_id');
    const media = target !== null ? assets.find(asset => asset.asset_revision_id === target) : assets[0];
    if (!media || !ontology) throw new Error('Synthetic media and ontology prerequisites are missing; fixed targets never fall back');
    const head = await api.annotation(media.asset_revision_id, ontology.ontology_version_id, life.signal); check();
    const workload = generateDenseWorkload(Number(query.get('count') ?? 2000), Number(query.get('seed') ?? 17), media.canonical_width, media.canonical_height);
    const syntheticDocument: AnnotationDocument = { ...head.document, objects: workload.objects };
    const saved = await api.request<SaveResponse>(`/api/assets/${media.asset_revision_id}/annotation`, { method: 'PUT', body: JSON.stringify({ operation_id: crypto.randomUUID(), base_revision_id: head.annotation_revision_id, document: syntheticDocument, lease: null, suggestion_decisions: [] }) }); check();
    const document = saved.revision.document;
    const image = await api.image(media.asset_revision_id, life.signal); check();
    const frame = await decodeCanonicalFrame(image, { width: media.canonical_width, height: media.canonical_height }); check();
    state.assets = [media, ...assets.filter(asset => asset !== media)]; state.ontologies = [ontology]; state.catalogReady = true; state.assignedAssets = new Set();
    queue.enqueue({ asset_revision_id: media.asset_revision_id, ontology_version_id: ontology.ontology_version_id, base_revision_id: saved.revision.annotation_revision_id, generation: 7, document, suggestion_decisions: [] });
    await queue.flush(media.asset_revision_id); check();
    preparing.hidden = true; workspace.hidden = false; host.mount(canvas);
    await load({ media, ontology, document, frame, initial_generation: 7 }, saved.revision);
    if (host.status !== 'ready') throw new Error(host.error?.message ?? 'Real WebGPU renderer unavailable');
    if (document.objects[37]) host.select([document.objects[37].object_id]);
    await settled(); check();
    const hooks: T28TestHooks = {
      ready: true,
      tool: tool => { if (writable()) host.setTool(tool); },
      undo: async () => { if (!writable()) return; host.dispatch({ kind: 'undo' }); await settled(); },
      stats: () => { const stats = host.getRenderStats(); if (!stats) throw new Error('Real renderer instrumentation missing'); const bridge = host.getBridgeStats(); return { ...stats, js_wasm_calls: bridge.calls, js_wasm_bytes: bridge.binary_bytes, js_wasm_binary_bytes: bridge.binary_bytes, bridge_elapsed_ms: bridge.elapsed_ms, ...resourceStats, rejected_resources: stats.rejected_resources + resourceStats.rejected_resources }; },
      pan: async (dx, dy) => { if (!writable()) return; host.pan(dx, dy); await settled(); },
      zoom: async factor => { if (!writable()) return; host.zoomAt(200, 150, factor); await settled(); },
      editObject: async (index, dx = 1) => { check(); const object = state.document!.objects[index]; host.dispatch({ kind: 'replace_geometry', object_id: object.object_id, geometry: { ...object.geometry, x_max: object.geometry.x_max + dx } }); await settled(); },
      select: async id => { if (!writable()) return; host.select([id]); await settled(); },
      setFlags: async (ids, flags) => { if (!writable()) return; host.setLocalFlags(ids, flags); await settled(); },
      commitBulkAttributes: async () => { check(); host.dispatch({ kind: 'set_attributes', object_ids: state.document!.objects.map(object => object.object_id), values: { helmet_state: 'wearing' } }); await settled(); },
      changeAsset: async index => {
        check(); const previous = request!; await queue.flush(previous.media.asset_revision_id); check();
        const media = state.assets[index % state.assets.length];
        const head = await api.annotation(media.asset_revision_id, previous.ontology.ontology_version_id, life.signal); check();
        const image = await api.image(media.asset_revision_id, life.signal); check();
        const frame = await decodeCanonicalFrame(image, { width: media.canonical_width, height: media.canonical_height }); check();
        if (!queue.toRecord(media.asset_revision_id)) queue.initializeFromServerRevision({ asset_revision_id: media.asset_revision_id, ontology_version_id: previous.ontology.ontology_version_id, annotation_revision_id: head.annotation_revision_id, generation: 0, document: head.document });
        await load({ media, ontology: previous.ontology, document: head.document, frame, initial_generation: queue.getStatus(media.asset_revision_id).local_generation }, head);
        state.flags = host.getLocalFlags(); state.notify(); await settled();
      },
      tryOverBudgetAsset: async () => { check(); try { await host.loadAsset({ ...request!, frame: { width: 8192, height: 8192, rgba: new Uint8Array(0) } }); check(); return true; } catch (reason) { if (!reason || typeof reason !== 'object' || !('code' in reason) || reason.code !== 'RESOURCE_BUDGET_EXCEEDED') throw reason; return false; } },
      flush: async () => { if (writable()) await queue.flush(request!.media.asset_revision_id); },
      snapshot: () => host.getSnapshot()!, viewport: () => host.getViewport()!, labels: () => host.getCanvasLabels(),
      saveCount: () => saveCount, validationInputObjects: () => host.getValidationInputObjects(), serializedInputObjects: () => host.getSerializedInputObjects(), generation: () => host.getGeneration()!,
    };
    installT28TestHooks(hooks);
  })().catch(reason => { if (current()) { error.hidden = false; error.textContent = reason instanceof Error ? reason.message : String(reason); preparing.hidden = true; } });
  function dispose() {
    if (disposed) return;
    disposed = true; life.abort(); context.signal.removeEventListener('abort', stop);
    state.alive = false; queue.revokeWriteOwner(state.owner.token); state.readonlyRequests.abort(); state.activity.setEnabled(false);
    unsubscribeSession(); unsubscribeAuth(); unsubscribeErrors(); unsubscribeRender(); unsubscribeStatus(); unmountObjects(); host.dispose(); removeT28TestHooks(); main.remove();
  }
  life.signal.addEventListener('abort', dispose, { once: true });
  if (context.signal.aborted) dispose();
  return dispose;
}
