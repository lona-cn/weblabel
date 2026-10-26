// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
const adapter = vi.hoisted(() => ({ create: vi.fn(), measure: vi.fn(), dispose: vi.fn(), paint: null as null | ((items: readonly { index: number; start: number }[], total: number) => void) }));
vi.mock('../../ui/virtual-list', () => ({ createVirtualList: (...args: unknown[]) => { adapter.create(...args); adapter.paint = args[2] as typeof adapter.paint; adapter.paint?.([{ index: 0, start: 0 }, { index: 1, start: 240 }], 10000); return { update: vi.fn(), measureElement: adapter.measure, dispose: adapter.dispose }; } }));
import { mountReviewList } from './review-list';
const owners: AbortController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.abort()); vi.clearAllMocks(); adapter.paint = null; document.body.replaceChildren(); });
function fixture(count: number, onEvict?: (id: string) => void) {
  const root = document.createElement('div'); document.body.append(root); const owner = new AbortController(); owners.push(owner);
  const items = Array.from({ length: count }, (_, index) => ({ id: `task-${index}`, reason: '保留多行审核理由。'.repeat(30) }));
  const render = (item: typeof items[number]) => { const row = document.createElement('div'); const input = document.createElement('textarea'); input.value = item.reason; input.setAttribute('aria-label', item.id); row.append(input); return row; };
  const list = mountReviewList<typeof items[number]>(root, '项目任务', item => item.id, render, owner.signal, onEvict); list.update(items); return { root, owner, list, items };
}
it('keeps fifty tasks as ordinary semantic list rows and retains field focus across updates', () => {
  const view = fixture(50); expect(adapter.create).not.toHaveBeenCalled(); expect(view.root.querySelectorAll('ul>li')).toHaveLength(50);
  const input = view.root.querySelector('textarea')!; input.focus(); input.value = '未提交审核理由'; view.list.update(view.items);
  expect(document.activeElement).toBe(input); expect(input.value).toBe('未提交审核理由'); expect(view.root.querySelector('li')?.getAttribute('aria-setsize')).toBe('50');
});
it('uses measured dynamic rows over fifty items and moves focus before recycling a focused row', async () => {
  const view = fixture(51); const config = adapter.create.mock.calls[0][1]; expect(config.estimateSize(0)).toBe(180); expect(config.overscan).toBe(3); expect(config.getItemKey(0)).toBe('task-0');
  await Promise.resolve(); expect(adapter.measure).toHaveBeenCalledWith(view.root.querySelector('li'));
  view.root.querySelector('textarea')!.focus(); adapter.paint?.([{ index: 2, start: 500 }], 10000);
  expect(document.activeElement).toBe(view.root.querySelector('.delivery-scroll')); expect(view.root.querySelectorAll('ul>li')).toHaveLength(1); expect(view.root.querySelector('li')?.getAttribute('aria-posinset')).toBe('3');
  view.owner.abort(); expect(adapter.dispose).toHaveBeenCalledTimes(1);
});
it('evicts recycled presentation caches and notifies their owner before creating a fresh presentation', () => {
  const evict = vi.fn(); const view = fixture(51, evict); const original = view.root.querySelector('textarea')!;
  adapter.paint?.([{ index: 2, start: 500 }], 10000); expect(evict).toHaveBeenCalledWith('task-0'); expect(evict).toHaveBeenCalledWith('task-1');
  adapter.paint?.([{ index: 0, start: 0 }], 10000); expect(view.root.querySelector('textarea')).not.toBe(original); expect(evict).toHaveBeenCalledWith('task-2');
});
