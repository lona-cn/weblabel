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
  const rendererState = document.createElement('section'), rendererPanel = document.createElement('div'), rendererHeading = document.createElement('h2'), rendererDetail = document.createElement('p');
  const capability = document.createElement('dl'), backendValue = document.createElement('dd'), gpuValue = document.createElement('dd'), rendererValue = document.createElement('dd'), notice = document.createElement('p');
  rendererState.className = 'r07-renderer-state'; rendererState.hidden = true; rendererState.dataset.testid = 'renderer-state';
  rendererPanel.className = 'r07-renderer-panel';
  const terms: HTMLElement[] = [];
  for (const value of [backendValue, gpuValue, rendererValue]) {
    const term = document.createElement('dt'); terms.push(term); capability.append(term, value);
  }
  notice.textContent = '仍可查看对象和属性；画布未就绪时不可编辑。不启用 Canvas2D 回退。';
  rendererPanel.append(rendererHeading, rendererDetail, capability, notice, retry); rendererState.append(rendererPanel);
  stage.append(canvas, labels, empty, rendererState); surface.append(stage, status, diagnostic);
  let request: LoadedAsset | null = null, host: EditorHost | null = null, unsubscribeRendered: (() => void) | null = null, unsubscribeStatus: (() => void) | null = null;
  const cache = new Map<string, HTMLSpanElement>();
  let namedObjects = state.objects, namedOntology = state.loaded?.ontology;
  let objectNames = new Map<string, string>();
  let restoreCanvasFocus = false;
  function refreshLabels() {
    if (!host || signal.aborted) return;
    const present = new Set<string>();
    let position = labels.firstElementChild;
    // Rust owns visibility/selected/hover prioritization and the first-100 viewport budget.
    for (const label of host.getCanvasLabels()) {
      present.add(label.object_id);
      let element = cache.get(label.object_id);
      if (!element) { element = document.createElement('span'); element.dataset.testid = 'canvas-label'; element.dataset.objectId = label.object_id; cache.set(label.object_id, element); labels.append(element); }
      const text = objectNames.get(label.object_id) ?? '对象';
      if (element !== position) labels.insertBefore(element, position);
      position = element.nextElementSibling;
      if (element.textContent !== text) element.textContent = text;
      element.style.transform = 'translate(' + label.x_css + 'px,' + label.y_css + 'px)'; element.dataset.selected = String(label.selected);
    }
    for (const [id, element] of cache) if (!present.has(id)) { element.remove(); cache.delete(id); }
  }
  function releaseHost() {
    unsubscribeRendered?.(); unsubscribeStatus?.(); unsubscribeRendered = null; unsubscribeStatus = null;
    if (host && state.host === host) state.host = null;
    host?.dispose(); host = null;
    restoreCanvasFocus = false;
    for (const element of cache.values()) element.remove(); cache.clear();
  }
  function updateStatus() {
    if (!host) return;
    const phase = host.status, unsupported = !('gpu' in navigator) || host.error?.code === 'WEBGPU_UNAVAILABLE';
    state.hostStatus = phase;
    const diagnostics = host.getAdapterDiagnostics();
    status.dataset.actualBackend = phase === 'ready' ? 'webgpu' : 'none';
    status.dataset.adapterKind = /swiftshader|llvmpipe|lavapipe|software|basic render|device_type=Cpu/i.test(diagnostics) ? 'software' : /DiscreteGpu|IntegratedGpu|nvidia|intel|amd|apple|blackwell/i.test(diagnostics) ? 'hardware' : 'unknown';
    status.dataset.deviceState = phase === 'error' && unsupported ? 'unsupported' : phase;
    status.textContent = phase === 'ready' ? 'WebGPU · ' + (status.dataset.adapterKind === 'hardware' ? '硬件加速' : status.dataset.adapterKind === 'software' ? '软件适配器' : '适配器类型未知')
      : phase === 'recovering' ? '正在恢复画布；同一 CPU 文档和撤销历史保留，成功前禁止编辑。' : phase === 'lost' ? 'GPU 连接丢失；CPU 文档和撤销历史已保留。'
      : phase === 'error' && unsupported ? 'WebGPU 不可用：浏览器不支持 WebGPU 或没有可用适配器；仍可查看对象，不启用 Canvas2D 回退。' : phase === 'error' ? '画布初始化失败；只能查看对象。' : '正在准备画布…';
    diagnosticText.textContent = [host.error ? reportError(host.error) : '', diagnostics || '未提供适配器诊断'].filter(Boolean).join('\n');
    const unavailable = phase === 'error' && unsupported, continuity = phase === 'lost' || phase === 'recovering', inPanel = unavailable || continuity;
    const active = document.activeElement;
    const diagnosticFocus = active instanceof HTMLElement && diagnostic.contains(active) ? active : null;
    const retryFocus = active === retry && phase !== 'lost';
    retry.hidden = phase !== 'lost';
    rendererState.hidden = phase === 'ready'; rendererState.dataset.state = unavailable ? 'unsupported' : phase;
    rendererHeading.textContent = phase === 'lost' ? 'GPU 连接丢失' : phase === 'recovering' ? '正在恢复画布' : unavailable ? 'WebGPU 不可用' : phase === 'error' ? '画布不可用' : '正在准备画布';
    rendererDetail.textContent = unavailable ? ('gpu' in navigator ? '当前没有可用的 WebGPU 适配器，无法初始化图像渲染器。' : '当前浏览器未提供 WebGPU，无法初始化图像渲染器。')
      : phase === 'lost' ? '渲染器已中断，编辑暂时不可用。' : phase === 'recovering' ? '正在重新连接 GPU，成功前不能编辑。' : status.textContent;
    capability.hidden = !inPanel; notice.hidden = !unavailable;
    if (unavailable) {
      terms[0].textContent = '渲染后端'; terms[1].textContent = 'WebGPU 接口'; terms[2].textContent = '渲染状态';
      backendValue.textContent = '无'; gpuValue.textContent = 'gpu' in navigator ? '已暴露；不可用' : '未提供'; rendererValue.textContent = '未初始化';
    } else if (continuity) {
      terms[0].textContent = '渲染状态'; terms[1].textContent = 'CPU 文档'; terms[2].textContent = '撤销历史';
      backendValue.textContent = phase === 'lost' ? '连接丢失' : '恢复中'; gpuValue.textContent = '已保留'; rendererValue.textContent = '已保留';
    }
    if (inPanel && diagnostic.parentElement !== rendererPanel) rendererPanel.append(diagnostic);
    else if (!inPanel && diagnostic.parentElement !== surface) surface.append(diagnostic);
    if (document.activeElement === document.body) (diagnosticFocus ?? (retryFocus ? summary : null))?.focus({ preventScroll: true });
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
    const blocked = !port.getHost() || state.modal;
    if (blocked && !canvas.inert && document.activeElement === canvas) restoreCanvasFocus = true;
    if (canvas.inert !== blocked) { canvas.inert = blocked; host?.requestRender(); }
    if (!blocked && restoreCanvasFocus) {
      restoreCanvasFocus = false;
      if (document.activeElement === document.body) canvas.focus({ preventScroll: true });
    }
    empty.hidden = !!request;
    empty.textContent = state.phase === 'loading' ? '正在读取固定图片与规范…' : state.phase === 'empty' ? '先导入图片。空文档不等于已确认无目标。' : state.error ?? '选择图片及其固定规范后开始标注。';
    if (!request) {
      status.dataset.actualBackend = 'none'; status.dataset.adapterKind = 'unknown'; status.dataset.deviceState = 'idle';
      status.textContent = '画布未载入'; retry.hidden = true; rendererState.hidden = true;
      if (diagnostic.parentElement !== surface) surface.append(diagnostic);
    }
  }
  const pointerGuard = (event: Event) => { if (port.getHost() !== host || state.modal) { event.stopImmediatePropagation(); host?.cancelGesture(); } };
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) stage.addEventListener(type, pointerGuard, { capture: true, signal });
  retry.addEventListener('click', () => { if (port.getReadHost() === host && host?.status === 'lost') void host.retryRenderer(); }, { signal });
  summary.addEventListener('focus', () => { if (diagnostic.parentElement === rendererPanel) summary.scrollIntoView({ block: 'nearest' }); }, { signal });
  const unsubscribe = state.subscribe(update);
  const dispose = () => { unsubscribe(); releaseHost(); };
  signal.addEventListener('abort', dispose, { once: true }); update();
  return { element: surface, dispose };
}
