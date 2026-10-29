import type { AnnotationDocument } from '../../lib/editor/types';
import { readonlyVisual } from '../ai/readonly-visual';
import type { EditorPort } from './editor-port';
import { action, element } from './view-elements';
import { selectedIds, sessionCurrent, type WorkspaceState } from './workspace-state';

/** Read-only evidence for the compact inspector; selection still belongs to the editor port. */
export function mountSelectionContextView(root: HTMLElement, state: WorkspaceState, port: EditorPort, signal: AbortSignal, active: () => boolean): () => void {
  root.className = 'r07-selection-context'; root.dataset.testid = 'inspection-context'; root.setAttribute('aria-label', '所选对象图像上下文');
  const identity = element('div', undefined, 'r07-inspection-identity'), name = element('strong'), position = element('p');
  name.dataset.testid = 'inspection-name'; name.setAttribute('role', 'status');
  const ids = element('details'), idValue = element('code'); ids.append(element('summary', '对象 ID'), idValue);
  identity.append(name, position, ids);
  const crop = element('div', undefined, 'r07-inspection-crop'), note = element('p', undefined, 'r07-inspection-note'); note.setAttribute('role', 'status');
  const navigation = element('div', undefined, 'r07-inspection-navigation'); navigation.setAttribute('role', 'group'); navigation.setAttribute('aria-label', '按文档顺序逐个检查');
  const previous = action('上一个对象', 'inspection-previous', signal, () => move(-1)), next = action('下一个对象', 'inspection-next', signal, () => move(1));
  navigation.append(previous, next); root.append(identity, crop, note, navigation);
  let last: { object: WorkspaceState['objects'][number]; document: AnnotationDocument | null; asset: string; scope: object } | null = null;
  function move(delta: number) {
    if (signal.aborted || !active() || !sessionCurrent(state) || state.preparation || state.importing || state.submission) return;
    const selected = selectedIds(state); if (selected.length !== 1) return;
    const index = state.objects.findIndex(object => object.object_id === selected[0]);
    if (index < 0) return;
    const object = state.objects[index + delta]; if (!object) return;
    port.cancelGesture(); port.select(object.object_id);
  }
  function update() {
    const current = sessionCurrent(state), selected = selectedIds(state);
    root.hidden = signal.aborted || !active() || !current || !selected.length;
    if (!current || !selected.length) { crop.replaceChildren(); last = null; }
    if (root.hidden) return;
    const index = selected.length === 1 ? state.objects.findIndex(object => object.object_id === selected[0]) : -1, object = state.objects[index];
    const blocked = !!state.preparation || !!state.importing || state.submission || !object;
    previous.disabled = blocked || index <= 0; next.disabled = blocked || index >= state.objects.length - 1;
    ids.hidden = crop.hidden = !object;
    if (!object) {
      name.textContent = selected.length > 1 ? '已选择 ' + selected.length + ' 个对象' : '所选对象不可用';
      position.textContent = selected.length > 1 ? '多选保持完整范围，包括隐藏和过滤外对象。' : '请核对当前图片、规范与对象。';
      note.textContent = selected.length > 1 ? '先在对象列表中单选，再逐个核对局部。' : '';
      crop.replaceChildren(); last = null;
    } else {
      const category = state.loaded?.ontology.labels.find(label => label.label_id === object.label_id)?.name ?? object.label_id;
      name.textContent = category + ' #' + (index + 1); position.textContent = '文档顺序 ' + (index + 1) + ' / ' + state.objects.length;
      idValue.textContent = object.object_id;
      note.textContent = state.flags[object.object_id]?.hidden ? '已隐藏，仍在修改范围内；此处只读显示，不改变隐藏状态。' : '';
      const snapshot = port.getSnapshot(), document = snapshot?.ontology_version_id === state.ontologyId ? snapshot : null;
      if (!last || last.object !== object || last.document !== document || last.asset !== state.assetId || last.scope !== state.scope) {
        last = { object, document, asset: state.assetId, scope: state.scope };
        const bounds = object.geometry, space = document?.coordinate_space;
        if (space && (bounds.x_max <= 0 || bounds.y_max <= 0 || bounds.x_min >= space.width || bounds.y_min >= space.height)) {
          crop.replaceChildren(element('p', '对象位于图片范围外；请用几何数值核对。'));
        } else {
          const visual = readonlyVisual(document, state.assetId, [], [bounds], true);
          const svg = visual.querySelector('svg'); svg?.setAttribute('aria-label', name.textContent + '，只读 canonical 局部与当前轮廓');
          svg?.setAttribute('data-testid', 'inspection-crop');
          const caption = visual.querySelector('figcaption'); if (caption) caption.textContent = '只读局部 · 非编辑画布';
          crop.replaceChildren(visual);
        }
      }
    }
    note.hidden = !note.textContent;
  }
  const unsubscribe = state.subscribe(update); update();
  return unsubscribe;
}
