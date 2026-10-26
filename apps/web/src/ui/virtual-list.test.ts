import { afterEach, expect, it, vi } from 'vitest';
import { createVirtualList } from './virtual-list';

const observers = new Set<TrackingObserver>();
class TrackingObserver implements ResizeObserver {
  private readonly targets = new Set<Element>();
  constructor(_callback: ResizeObserverCallback) {}
  observe(target: Element) { this.targets.add(target); observers.add(this); }
  unobserve(target: Element) { this.targets.delete(target); if (!this.targets.size) observers.delete(this); }
  disconnect() { this.targets.clear(); observers.delete(this); }
}

afterEach(() => {
  for (const observer of [...observers]) observer.disconnect();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it('aborting from the first visible-range notification releases observers and prevents later notifications', () => {
  vi.stubGlobal('ResizeObserver', TrackingObserver);
  const scroll = document.createElement('div');
  Object.defineProperties(scroll, { offsetWidth: { value: 320 }, offsetHeight: { value: 128 } });
  scroll.getBoundingClientRect = () => new DOMRect(0, 0, 320, 128);
  document.body.append(scroll);
  const owner = new AbortController();
  const notifications: boolean[] = [];
  const list = createVirtualList(scroll, {
    count: 20, getItemKey: index => `object-${index}`, estimateSize: () => 32, overscan: 1,
  }, items => {
    expect(items.map(item => item.key)).toEqual(['object-0', 'object-1', 'object-2', 'object-3', 'object-4']);
    notifications.push(owner.signal.aborted);
    owner.abort();
  }, owner.signal);
  try {
    expect(owner.signal.aborted).toBe(true);
    expect(notifications).toEqual([false]);
    expect(observers.size).toBe(0);
    list.update({ count: 40, getItemKey: index => `object-${index}`, estimateSize: () => 32, overscan: 1 });
    list.dispose();
    expect(notifications).toEqual([false]);
    expect(observers.size).toBe(0);
  } finally {
    list.dispose();
  }
});
