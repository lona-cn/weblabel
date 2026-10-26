import { Virtualizer, observeElementRect, observeElementOffset, elementScroll, type VirtualItem, type ScrollToOptions } from '@tanstack/virtual-core';

export interface VirtualListOptions {
  count: number;
  getItemKey: (index: number) => string | number | bigint;
  estimateSize: (index: number) => number;
  overscan: number;
}

// The consumer owns semantic rows, keyed patches and focus. TanStack owns all
// ranges, scrolling and dynamic measurement; no second windowing algorithm.
export function createVirtualList(scrollElement: HTMLElement, options: VirtualListOptions, onChange: (items: readonly VirtualItem[], totalSize: number) => void, signal: AbortSignal) {
  let disposed = false;
  let binding = false;
  const virtualizer = new Virtualizer<HTMLElement, HTMLElement>({
    ...options,
    getScrollElement: () => scrollElement,
    observeElementRect,
    observeElementOffset,
    scrollToFn: elementScroll,
    onChange(instance) { if (!disposed && !binding) onChange(instance.getVirtualItems(), instance.getTotalSize()); },
  });
  const unmount = virtualizer._didMount();
  function dispose() {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener('abort', dispose);
    if (!binding) unmount();
  }
  function synchronize() {
    if (disposed) return;
    binding = true;
    try {
      virtualizer._willUpdate();
    } finally {
      binding = false;
      if (disposed) unmount();
    }
    if (!disposed) onChange(virtualizer.getVirtualItems(), virtualizer.getTotalSize());
  }
  if (signal.aborted) dispose();
  else {
    signal.addEventListener('abort', dispose, { once: true });
    synchronize();
  }
  return {
    getVirtualItems: virtualizer.getVirtualItems,
    getTotalSize: virtualizer.getTotalSize,
    measureElement: (element: HTMLElement | null) => { if (!disposed) virtualizer.measureElement(element); },
    scrollToIndex: (index: number, scrollOptions?: ScrollToOptions) => { if (!disposed) virtualizer.scrollToIndex(index, scrollOptions); },
    update(next: VirtualListOptions) {
      if (disposed) return;
      virtualizer.setOptions({ ...virtualizer.options, ...next });
      synchronize();
    },
    dispose,
  };
}
