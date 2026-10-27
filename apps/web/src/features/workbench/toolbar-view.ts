import type { EditorTool } from '../../lib/editor/types';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import type { EditorPort } from './editor-port';
import { selectedIds, type WorkspaceState } from './workspace-state';
import { categoryShortcuts } from './category-shortcuts';
import { action, element, labeled, option } from './view-elements';

export function mountToolbarView(root: HTMLElement, state: WorkspaceState, port: EditorPort, signal: AbortSignal): () => void {
  root.setAttribute('role', 'toolbar'); root.setAttribute('aria-label', '标注工具');
  const buttons = new Map<EditorTool, HTMLButtonElement>();
  for (const [tool, text] of [['select', '选择 V'], ['box', '矩形 B'], ['pan', '平移 H']] as const) {
    const button = action(text, 'tool-' + tool, signal, () => { if (port.getHost()) state.tools?.set(tool); }); buttons.set(tool, button); root.append(button);
  }
  const undo = action('撤销', 'undo', signal, () => port.dispatch({ kind: 'undo' })), redo = action('重做', 'redo', signal, () => port.dispatch({ kind: 'redo' }));
  const duplicate = action('复制选中', 'duplicate-selected', signal, () => { const ids = selectedIds(state); port.dispatch({ kind: 'duplicate', object_ids: [...ids], new_ids: ids.map(() => crypto.randomUUID()) }); });
  const remove = action('删除选中', 'delete-selected', signal, () => port.dispatch({ kind: 'delete', object_ids: [...selectedIds(state)] }));
  const drawing = element('select'); drawing.dataset.testid = 'drawing-label';
  const zoom = element('output'), minus = action('−', 'zoom-out', signal, () => changeZoom(1 / 1.2)), plus = action('+', 'zoom-in', signal, () => changeZoom(1.2)); minus.setAttribute('aria-label', '缩小'); plus.setAttribute('aria-label', '放大');
  const fit = action('适应图片', 'fit-image', signal, () => port.getReadHost()?.fitImage()), focus = action('聚焦选择', 'focus-selection', signal, () => port.getReadHost()?.focusSelection());
  root.append(undo, redo, duplicate, remove, labeled('绘制类别', drawing), minus, zoom, plus, fit, focus);
  let ontology: OntologyVersion | null = null, renderedHost: WorkspaceState['host'] = null, unsubscribeRendered: (() => void) | null = null;
  function changeZoom(factor: number) {
    const host = port.getReadHost(), viewport = host?.getViewport();
    if (host?.status === 'ready' && viewport) host.zoomAt(viewport.css_width / 2, viewport.css_height / 2, factor);
  }
  function renderViewport() {
    const host = port.getReadHost(), viewport = host?.getViewport(), stack = host?.getHitStackState();
    zoom.textContent = viewport ? Math.round(viewport.scale * 100) + '%' + (stack && stack.count > 1 ? ' · 重叠 ' + ((stack.index ?? 0) + 1) + '/' + stack.count : '') : '缩放未知';
  }
  function update() {
    const host = port.getHost();
    for (const [tool, button] of buttons) { button.disabled = !host; button.setAttribute('aria-pressed', String(state.tools?.current() === tool)); }
    undo.disabled = !host || !state.canUndo; redo.disabled = !host || !state.canRedo;
    duplicate.disabled = remove.disabled = !port.selectionWritable();
    drawing.disabled = !host;
    if (ontology !== state.loaded?.ontology) { ontology = state.loaded?.ontology ?? null; drawing.replaceChildren(); for (const label of ontology?.labels ?? []) drawing.append(option(label.label_id, label.name)); }
    drawing.value = state.activeLabel;
    const ready = port.getReadHost()?.status === 'ready'; minus.disabled = plus.disabled = fit.disabled = !ready; focus.disabled = !ready || !selectedIds(state).length;
    if (renderedHost !== state.host) { unsubscribeRendered?.(); renderedHost = state.host; unsubscribeRendered = renderedHost?.subscribeRendered(renderViewport) ?? null; }
    renderViewport();
  }
  drawing.addEventListener('change', () => port.drawingLabel(drawing.value), { signal });
  const unsubscribe = state.subscribe(update); update();
  return () => { unsubscribe(); unsubscribeRendered?.(); };
}

/** Native controls and IME own their keys; each accepted shortcut re-reads the port. */
export function mountEditorKeyboard(root: HTMLElement, state: WorkspaceState, port: EditorPort, signal: AbortSignal): void {
  let composing = false;
  window.addEventListener('compositionstart', () => { composing = true; }, { capture: true, signal });
  window.addEventListener('compositionend', () => { composing = false; }, { capture: true, signal });
  window.addEventListener('keydown', event => {
    if (event.defaultPrevented || composing || event.isComposing || !(event.target instanceof Element) || !root.contains(event.target)
      || event.target.closest('button,a[href],summary,input,textarea,select,dialog,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="checkbox"],[role="radio"],[role="switch"],[role="slider"],[role="spinbutton"],[role="textbox"],[role="combobox"],[role="tab"],[role="menuitem"],.r07-help')) return;
    if (event.key === 'Escape') { port.cancelGesture(); return; }
    if (!port.getHost()) return;
    const accelerator = event.ctrlKey || event.metaKey;
    if (event.code === 'Space') { event.preventDefault(); if (!event.repeat) state.tools?.beginSpacePan(); return; }
    if (accelerator && event.code === 'KeyZ') { event.preventDefault(); port.dispatch({ kind: event.shiftKey ? 'redo' : 'undo' }); return; }
    if (accelerator && !event.shiftKey && event.code === 'KeyY') { event.preventDefault(); port.dispatch({ kind: 'redo' }); return; }
    if (accelerator && event.code === 'KeyD') { event.preventDefault(); const ids = selectedIds(state); if (ids.length) port.dispatch({ kind: 'duplicate', object_ids: [...ids], new_ids: ids.map(() => crypto.randomUUID()) }); return; }
    if (accelerator || event.altKey) return;
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); port.dispatch({ kind: 'delete', object_ids: [...selectedIds(state)] }); return; }
    if (event.shiftKey) return;
    const tool = ({ KeyV: 'select', KeyB: 'box', KeyH: 'pan' } as const)[event.code as 'KeyV' | 'KeyB' | 'KeyH'];
    if (tool) { event.preventDefault(); state.tools?.set(tool); return; }
    const label = categoryShortcuts(state.loaded?.ontology ?? null).bindings[event.key.toLowerCase()];
    if (label) { event.preventDefault(); port.drawingLabel(label); }
  }, { signal });
  window.addEventListener('keyup', event => { if (event.code === 'Space') state.tools?.endSpacePan(); }, { signal });
  window.addEventListener('blur', () => state.tools?.endSpacePan(), { signal });
}
