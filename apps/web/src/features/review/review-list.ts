import { createVirtualList } from '../../ui/virtual-list';
import { element, lifetime } from '../import-export/delivery-dom';

export function mountReviewList<T>(root: HTMLElement, label: string, key: (item: T) => string, render: (item: T, signal: AbortSignal) => HTMLElement, signal: AbortSignal, onEvict?: (id: string) => void) {
  const scroll = element('div', undefined, 'delivery-scroll'); scroll.tabIndex = 0; scroll.setAttribute('aria-label', label);
  const list = element('ul'); list.setAttribute('aria-label', label); scroll.append(list); root.append(scroll);
  let items: readonly T[] = []; let disposed = false;
  let virtual: { update(options: { count: number; getItemKey(index: number): string; estimateSize(index: number): number; overscan: number }): void; measureElement(element: HTMLElement | null): void; dispose(): void } | null = null;
  const rows = new Map<string, { item: T; node: HTMLLIElement; owner: { signal: AbortSignal; dispose(): void } }>();
  function evict(id: string) {
    const cached = rows.get(id); if (!cached) return;
    if (cached.node.contains(document.activeElement)) scroll.focus({ preventScroll: true });
    cached.owner.dispose(); cached.node.remove(); rows.delete(id); onEvict?.(id);
  }
  function row(index: number) {
    const item = items[index], id = key(item); let cached = rows.get(id);
    if (!cached) {
      const owner = lifetime(signal), node = element('li'); node.dataset.key = id; node.append(render(item, owner.signal)); cached = { item, node, owner }; rows.set(id, cached);
    } else if (cached.item !== item) {
      cached.owner.dispose(); cached.owner = lifetime(signal);
      const content = render(item, cached.owner.signal); cached.item = item;
      if (cached.node.firstElementChild !== content) {
        if (cached.node.contains(document.activeElement)) scroll.focus({ preventScroll: true });
        cached.node.replaceChildren(content);
      }
    }
    cached.node.dataset.index = String(index); cached.node.setAttribute('aria-setsize', String(items.length)); cached.node.setAttribute('aria-posinset', String(index + 1)); return cached.node;
  }
  function paint(indices: readonly { index: number; start: number }[], total?: number) {
    if (disposed) return;
    const valid = indices.filter(value => value.index < items.length);
    const visible = new Set(valid.map(value => key(items[value.index])));
    for (const id of [...rows.keys()]) if (!visible.has(id)) evict(id);
    list.style.height = total === undefined ? '' : `${total}px`;
    let position = list.firstElementChild;
    for (const value of valid) {
      const node = row(value.index); node.style.position = total === undefined ? '' : 'absolute'; node.style.width = total === undefined ? '' : '100%'; node.style.top = total === undefined ? '' : '0'; node.style.transform = total === undefined ? '' : `translateY(${value.start}px)`;
      if (node !== position) list.insertBefore(node, position);
      position = node.nextElementSibling;
    }
    if (total !== undefined) queueMicrotask(() => { if (!disposed) for (const node of list.children) virtual?.measureElement(node as HTMLElement); });
  }
  function update(next: readonly T[]) {
    if (disposed) return; items = next;
    const present = new Set(next.map(key)); for (const id of [...rows.keys()]) if (!present.has(id)) evict(id);
    if (next.length <= 50) { virtual?.dispose(); virtual = null; paint(next.map((_, index) => ({ index, start: 0 }))); }
    else {
      const options = { count: next.length, getItemKey: (index: number) => key(items[index]), estimateSize: () => 180, overscan: 3 };
      if (virtual) virtual.update(options); else virtual = createVirtualList(scroll, options, paint, signal);
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true; virtual?.dispose(); for (const id of [...rows.keys()]) evict(id);
    signal.removeEventListener('abort', dispose); scroll.remove();
  }
  signal.addEventListener('abort', dispose, { once: true }); if (signal.aborted) dispose();
  return { update, dispose };
}
