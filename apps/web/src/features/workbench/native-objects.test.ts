// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { nativeFixture } from './native-test-support';
import { mountObjectsView } from './objects-view';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
it('uses a bounded real virtual-core window while filtering leaves hidden/offscreen selection intact', async () => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(320); vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(280);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const f = nativeFixture(), owner = new AbortController(), root = document.createElement('section'); document.body.append(root); cleanups.push(f.dispose, () => owner.abort());
  f.state.objects = Array.from({ length: 2000 }, (_, index) => ({ ...f.document.objects[0], object_id: 'object-' + index }));
  f.state.selection.publish({ ...f.delta, selected_object_ids: ['object-0', 'object-1999'] }); f.state.flags = { 'object-1999': { hidden: true, locked: true } };
  mountObjectsView(root, f.state, f.port, owner.signal);
  await vi.waitFor(() => expect(root.querySelectorAll('[role=option]').length).toBeGreaterThan(0));
  expect(root.querySelectorAll('[role=option]').length).toBeLessThan(30);
  const first = root.querySelector('[data-testid=object-item-object-0]'); expect(first?.getAttribute('aria-setsize')).toBe('2000'); expect(first?.getAttribute('aria-posinset')).toBe('1');
  const search = root.querySelector<HTMLInputElement>('input[type=search]')!; search.value = 'object-1999'; search.dispatchEvent(new Event('input', { bubbles: true }));
  expect(f.state.selection.getSelection()).toEqual(['object-0', 'object-1999']); expect(root.textContent).toContain('过滤外 1');
  expect(f.host.setLocalFlags).not.toHaveBeenCalled();
  owner.abort(); f.host.select.mockClear(); root.querySelector<HTMLElement>('[data-testid=object-list]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); expect(f.host.select).not.toHaveBeenCalled();
});
