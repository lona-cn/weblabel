import { useRef, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
export function VirtualReviewList<T>({ items, itemKey, children, label }: { items: readonly T[]; itemKey(item: T): string; children(item: T): ReactNode; label: string }) {
  const viewport = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({ count: items.length, getScrollElement: () => viewport.current, estimateSize: () => 180, getItemKey: index => itemKey(items[index]!), initialRect: { width: 640, height: 600 }, overscan: 3, enabled: items.length > 50 });
  if (items.length <= 50) return <ul aria-label={label}>{items.map(item => <li key={itemKey(item)}>{children(item)}</li>)}</ul>;
  return <div ref={viewport} style={{ maxHeight: 600, overflow: 'auto' }} tabIndex={0} aria-label={`${label}滚动范围`}><ul aria-label={label} style={{ height: virtual.getTotalSize(), position: 'relative', margin: 0 }}>{virtual.getVirtualItems().map(row => <li key={row.key} data-index={row.index} ref={virtual.measureElement} aria-posinset={row.index + 1} aria-setsize={items.length} style={{ position: 'absolute', width: '100%', top: 0, transform: `translateY(${row.start}px)` }}>{children(items[row.index]!)}</li>)}</ul></div>;
}
