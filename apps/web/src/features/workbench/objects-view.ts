import { createVirtualList } from '../../ui/virtual-list';
import type { AnnotationObject } from '../../../../../packages/contracts/generated/AnnotationObject';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import type { EditorPort } from './editor-port';
import { selectedIds, type WorkspaceState } from './workspace-state';
import { action, element, labeled } from './view-elements';

export interface ObjectProjection { object: AnnotationObject; name: string; category: string }
export function projectObjectRows(objects: readonly AnnotationObject[], ontology: OntologyVersion | null, query: string, grouped: boolean): ObjectProjection[] {
  const names = new Map(ontology?.labels.map(label => [label.label_id, label.name]) ?? []), search = query.trim().toLocaleLowerCase();
  const rows = objects.flatMap((object, index) => {
    const category = names.get(object.label_id) ?? object.label_id, name = category + ' #' + (index + 1);
    return !search || (name + ' ' + object.label_id + ' ' + object.object_id).toLocaleLowerCase().includes(search) ? [{ object, name, category }] : [];
  });
  if (!grouped) return rows;
  const groups = new Map<string, ObjectProjection[]>();
  for (const row of rows) { const group = groups.get(row.object.label_id); if (group) group.push(row); else groups.set(row.object.label_id, [row]); }
  return [...groups.values()].flat();
}
export function mountObjectsView(root: HTMLElement, state: WorkspaceState, port: EditorPort, signal: AbortSignal): () => void {
  const title = element('h2', '对象'), search = element('input'); search.type = 'search'; search.setAttribute('aria-label', '检索对象'); search.placeholder = '名称 / 类别 / ID';
  const grouped = element('input'); grouped.type = 'checkbox';
  const counts = element('small'), flags = element('div', undefined, 'r07-button-row');
  const hide = action('隐藏选中', 'object-hide-selected', signal, () => { const ids = selectedIds(state); port.flags(ids, { hidden: !ids.every(id => state.flags[id]?.hidden) }); });
  const lock = action('锁定选中', 'object-lock-selected', signal, () => { const ids = selectedIds(state); port.flags(ids, { locked: !ids.every(id => state.flags[id]?.locked) }); });
  const show = action('显示全部', 'object-show-all', signal, () => port.flags(Object.keys(state.flags).filter(id => state.flags[id].hidden), { hidden: false }));
  flags.append(hide, lock, show);
  const viewport = element('div', undefined, 'r07-object-viewport'); viewport.dataset.testid = 'object-list'; viewport.tabIndex = 0; viewport.setAttribute('role', 'listbox'); viewport.setAttribute('aria-label', '标注对象'); viewport.setAttribute('aria-multiselectable', 'true');
  const spacer = element('div', undefined, 'r07-object-spacer'), message = element('p'); message.setAttribute('role', 'status'); viewport.append(spacer);
  root.append(title, labeled('检索对象', search), labeled('按类别分组', grouped), counts, flags, viewport, message);
  let rows: ObjectProjection[] = [], objects: readonly AnnotationObject[] | null = null, ontology: OntologyVersion | null = null, activeId: string | null = null;
  const cache = new Map<string, HTMLElement>();
  function patch(items: readonly { index: number; start: number; size: number }[], total: number) {
    spacer.style.height = total + 'px';
    const present = new Set<string>(), ids = new Set(selectedIds(state));
    for (const item of items) {
      const row = rows[item.index]; if (!row) continue;
      const id = row.object.object_id; present.add(id);
      let node = cache.get(id);
      if (!node) {
        node = element('div', undefined, 'r07-object-row'); node.id = 'object-option-' + id; node.dataset.testid = 'object-item-' + id; node.setAttribute('role', 'option');
        node.append(element('span', undefined, 'r07-object-name'), element('small'));
        node.addEventListener('click', event => { activeId = id; port.select(id, event.ctrlKey || event.metaKey || event.shiftKey); }, { signal });
        cache.set(id, node); spacer.append(node);
      }
      node.style.top = item.start + 'px'; node.style.height = item.size + 'px';
      const flag = state.flags[id], name = node.firstElementChild!;
      name.textContent = row.name; node.lastElementChild!.textContent = (flag?.hidden ? '隐藏 · ' : '') + (flag?.locked ? '锁定' : '未锁定');
      node.dataset.hidden = String(flag?.hidden ?? false); node.dataset.locked = String(flag?.locked ?? false);
      node.setAttribute('aria-label', row.name + (flag?.hidden ? '，已隐藏' : '') + (flag?.locked ? '，已锁定' : ''));
      node.setAttribute('aria-setsize', String(rows.length)); node.setAttribute('aria-posinset', String(item.index + 1)); node.setAttribute('aria-selected', String(ids.has(id)));
      const color = state.loaded?.ontology.labels.find(label => label.label_id === row.object.label_id)?.color;
      node.style.borderInlineStartColor = color ?? 'transparent';
    }
    for (const [id, node] of cache) if (!present.has(id)) { node.remove(); cache.delete(id); }
    const active = activeId ?? rows.find(row => ids.has(row.object.object_id))?.object.object_id;
    if (active && cache.has(active)) viewport.setAttribute('aria-activedescendant', 'object-option-' + active); else viewport.removeAttribute('aria-activedescendant');
  }
  const virtual = createVirtualList(viewport, { count: 0, getItemKey: index => rows[index].object.object_id, estimateSize: () => 44, overscan: 5 }, patch, signal);
  function update(force = false) {
    if (objects !== state.objects || ontology !== state.loaded?.ontology || force) {
      objects = state.objects; ontology = state.loaded?.ontology ?? null; rows = projectObjectRows(objects, ontology, search.value, grouped.checked);
      virtual.update({ count: rows.length, getItemKey: index => rows[index].object.object_id, estimateSize: () => 44, overscan: 5 });
    } else patch(virtual.getVirtualItems(), virtual.getTotalSize());
    const ids = selectedIds(state), selected = new Set(ids), hidden = ids.filter(id => state.flags[id]?.hidden).length, locked = ids.filter(id => state.flags[id]?.locked).length;
    counts.textContent = rows.length + ' / ' + state.objects.length + ' · 已选择 ' + ids.length + '（过滤外 ' + (ids.length - rows.filter(row => selected.has(row.object.object_id)).length) + '）';
    hide.disabled = lock.disabled = !port.getHost() || !ids.length; show.disabled = !port.getHost() || !Object.values(state.flags).some(flag => flag.hidden);
    hide.textContent = ids.length && hidden === ids.length ? '显示选中' : '隐藏选中'; lock.textContent = ids.length && locked === ids.length ? '解锁选中' : '锁定选中';
    hide.setAttribute('aria-pressed', hidden && hidden !== ids.length ? 'mixed' : String(hidden > 0)); lock.setAttribute('aria-pressed', locked && locked !== ids.length ? 'mixed' : String(locked > 0));
    message.textContent = state.phase === 'loading' ? '正在加载对象…' : state.phase === 'error' && !state.objects.length ? '对象加载失败；本地草稿已保留。' : !state.objects.length ? '还没有标注对象；空文档不等于无目标。' : !rows.length ? '没有匹配对象；原选择仍保留。' : '筛选不改变选择；隐藏和离屏选择仍参与批改。';
    viewport.setAttribute('aria-busy', String(state.phase === 'loading'));
  }
  search.addEventListener('input', () => update(true), { signal }); grouped.addEventListener('change', () => update(true), { signal });
  viewport.addEventListener('keydown', event => {
    if (event.isComposing || !rows.length || !['Home', 'End', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
    const ids = selectedIds(state), index = rows.findIndex(row => row.object.object_id === activeId || !activeId && ids.includes(row.object.object_id));
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index < 0 ? event.key === 'ArrowDown' ? 0 : rows.length - 1 : index + (event.key === 'ArrowDown' ? 1 : -1)));
    event.preventDefault(); activeId = rows[next].object.object_id; port.select(activeId, event.shiftKey || event.ctrlKey || event.metaKey); virtual.scrollToIndex(next, { align: 'auto' });
  }, { signal });
  const unsubscribe = state.subscribe(update); update();
  return () => { unsubscribe(); virtual.dispose(); };
}
