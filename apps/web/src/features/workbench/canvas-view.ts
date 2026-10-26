import { EditorHost } from '../../lib/editor/EditorHost';
import type { EditorHostOptions } from '../../lib/editor/types';
import type { EditorPort } from './editor-port';
import { applyDelta } from './workspace-data';
import { reportError, type LoadedAsset, type WorkspaceState } from './workspace-state';

export interface CanvasView { element: HTMLElement; dispose(): void }
export function mountCanvasView(state: WorkspaceState, port: EditorPort, signal: AbortSignal, hostOptions?: Partial<EditorHostOptions>): CanvasView {
  const surface = document.createElement('section'); surface.className = 'r07-canvas-region'; surface.setAttribute('aria-label', '标注画布');
  const stage = document.createElement('div'); stage.className = 'r07-canvas-stage';
  const canvas = document.createElement('canvas'); canvas.dataset.testid = 'annotation-canvas'; canvas.tabIndex = 0; canvas.setAttribute('aria-label', 'WebGPU 标注画布');
  const labels = document.createElement('div'); labels.className = 'r07-canvas-labels'; labels.setAttribute('aria-hidden', 'true');
  const status = document.createElement('div'); status.dataset.testid = 'gpu-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const diagnostic = document.createElement('details'), summary = document.createElement('summary'), diagnosticText = document.createElement('pre'); summary.textContent = 'GPU 诊断'; diagnostic.append(summary, diagnosticText);
  const retry = document.createElement('button'); retry.type = 'button'; retry.dataset.testid = 'gpu-retry'; retry.textContent = '重试画布';
  const empty = document.createElement('p'); empty.className = 'r07-canvas-empty'; empty.setAttribute('role', 'status');
  const rendererState = document.createElement('section'), rendererHeading = document.createElement('h2'), rendererDetail = document.createElement('p');
  rendererState.className = 'r07-renderer-state'; rendererState.hidden = true; rendererState.append(rendererHeading, rendererDetail, retry);
  stage.append(canvas, labels, empty, rendererState); surface.append(stage, status, diagnostic);
  let request: LoadedAsset | null = null, host: EditorHost | null = null, unsubscribeRendered: (() => void) | null = null, unsubscribeStatus: (() => void) | null = null;
  const cache = new Map<string, HTMLSpanElement>();
  let namedObjects = state.objects, namedOntology = state.loaded?.ontology;
  let objectNames = new Map<string, string>();
  function refreshLabels() {
    if (!host || signal.aborted) return;
    const present = new Set<string>();
    // Rust owns visibility/selected/hover prioritization and the first-100 viewport budget.
    for (const label of host.getCanvasLabels()) {
      present.add(label.object_id);
      let element = cache.get(label.object_id);
      if (!element) { element = document.createElement('span'); element.dataset.testid = 'canvas-label'; element.dataset.objectId = label.object_id; cache.set(label.object_id, element); labels.append(element); }
      const text = objectNames.get(label.object_id) ?? '对象';
      if (element.textContent !== text) element.textContent = text;
      element.style.transform = 'translate(' + label.x_css + 'px,' + label.y_css + 'px)'; element.dataset.selected = String(label.selected);
    }
    for (const [id, element] of cache) if (!present.has(id)) { element.remove(); cache.delete(id); }
  }
  function releaseHost() {
    unsubscribeRendered?.(); unsubscribeStatus?.(); unsubscribeRendered = null; unsubscribeStatus = null;
    if (host && state.host === host) state.host = null;
    host?.dispose(); host = null;
    for (const element of cache.values()) element.remove(); cache.clear();
  }
  function updateStatus() {
    if (!host) return;
    const phase = host.status, unsupported = !('gpu' in navigator);
    state.hostStatus = phase;
    const diagnostics = host.getAdapterDiagnostics();
    status.dataset.actualBackend = phase === 'ready' ? 'webgpu' : 'none';
    status.dataset.adapterKind = /swiftshader|llvmpipe|lavapipe|software|basic render|device_type=Cpu/i.test(diagnostics) ? 'software' : /DiscreteGpu|IntegratedGpu|nvidia|intel|amd|apple|blackwell/i.test(diagnostics) ? 'hardware' : 'unknown';
    status.dataset.deviceState = phase === 'error' && unsupported ? 'unsupported' : phase;
    status.textContent = phase === 'ready' ? 'WebGPU · ' + (status.dataset.adapterKind === 'hardware' ? '硬件加速' : status.dataset.adapterKind === 'software' ? '软件适配器' : '适配器类型未知')
      : phase === 'recovering' ? '正在恢复画布；同一 CPU 文档和撤销历史保留，成功前禁止编辑。' : phase === 'lost' ? 'GPU 连接丢失；CPU 文档和撤销历史已保留。'
      : phase === 'error' && unsupported ? '浏览器不支持 WebGPU；仍可查看对象，不启用 Canvas2D 回退。' : phase === 'error' ? '画布初始化失败；只能查看对象。' : '正在准备画布…';
    diagnosticText.textContent = [host.error ? host.error.code + ': ' + host.error.message : '', diagnostics || '未提供适配器诊断'].filter(Boolean).join('\n');
    retry.hidden = phase !== 'lost';
    rendererState.hidden = phase === 'ready';
    rendererHeading.textContent = phase === 'lost' ? 'GPU 连接丢失' : phase === 'recovering' ? '正在恢复画布' : phase === 'error' && unsupported ? '浏览器不支持 WebGPU' : phase === 'error' ? '画布不可用' : '正在准备画布';
    rendererDetail.textContent = status.textContent;
    if (phase === 'ready') state.tools?.reconcileSpaceRelease();
    state.notify();
  }
  function update() {
    if (signal.aborted) return;
    if (namedObjects !== state.objects || namedOntology !== state.loaded?.ontology || !objectNames.size) {
      namedObjects = state.objects; namedOntology = state.loaded?.ontology;
      const labelsById = new Map(namedOntology?.labels.map(label => [label.label_id, label.name]) ?? []);
      objectNames = new Map(namedObjects.map((object, index) => [object.object_id, (labelsById.get(object.label_id) ?? object.label_id) + ' #' + (index + 1)]));
      refreshLabels();
    }
    if (request !== state.loaded) {
      releaseHost(); request = state.loaded;
      if (request) {
        const captured = request;
        host = new EditorHost({ ...hostOptions, onDelta: delta => { if (host) applyDelta(state, port, host, delta); } });
        state.host = host; state.nativeDocuments.set(host, request.document);
        const mounted = host;
        unsubscribeRendered = mounted.subscribeRendered(refreshLabels); unsubscribeStatus = mounted.subscribeStatus(updateStatus);
        mounted.mount(canvas);
        const loading = mounted.loadAsset(request); updateStatus();
        void loading.then(() => {
          if (signal.aborted || host !== mounted || state.loaded !== captured) return;
          if (mounted.status === 'ready') { mounted.setTool(state.tools?.current() ?? 'select'); mounted.setActiveLabel(state.activeLabel); }
          updateStatus(); refreshLabels();
        }).catch(reason => { if (!signal.aborted && host === mounted && state.loaded === captured) { state.error = reportError(reason); updateStatus(); } });
      }
    }
    canvas.inert = !port.getHost() || state.modal;
    empty.hidden = !!request;
    empty.textContent = state.phase === 'loading' ? '正在读取固定图片与规范…' : state.phase === 'empty' ? '先导入图片。空文档不等于已确认无目标。' : state.error ?? '选择图片及其固定规范后开始标注。';
    if (!request) { status.textContent = '画布未载入'; retry.hidden = true; rendererState.hidden = true; }
  }
  const pointerGuard = (event: Event) => { if (port.getHost() !== host || state.modal) { event.stopImmediatePropagation(); host?.cancelGesture(); } };
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) stage.addEventListener(type, pointerGuard, { capture: true, signal });
  retry.addEventListener('click', () => { if (port.getReadHost() === host && host?.status === 'lost') void host.retryRenderer(); }, { signal });
  const unsubscribe = state.subscribe(update);
  const dispose = () => { unsubscribe(); releaseHost(); };
  signal.addEventListener('abort', dispose, { once: true }); update();
  return { element: surface, dispose };
}
