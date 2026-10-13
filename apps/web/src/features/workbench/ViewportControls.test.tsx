import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ViewportControls, type ViewportControlsHost } from './ViewportControls';
import type { EditorHostStatus, HitStackState, Viewport } from '../../lib/editor/types';

afterEach(cleanup);
function host() {
  let view: Viewport = { scale: 2, tx: 12, ty: -7, css_width: 800, css_height: 600, dpr: 2 };
  let hit: HitStackState = { index: null, count: 0 };
  let status: EditorHostStatus = 'ready';
  const rendered = new Set<() => void>(), statuses = new Set<() => void>();
  const bridge: ViewportControlsHost = {
    get status() { return status; }, getViewport: () => view, getHitStackState: () => hit,
    zoomAt: vi.fn(), fitImage: vi.fn(), focusSelection: vi.fn(),
    subscribeRendered: (fn) => { rendered.add(fn); return () => { rendered.delete(fn); }; },
    subscribeStatus: (fn) => { statuses.add(fn); return () => { statuses.delete(fn); }; },
  };
  return { bridge, frame: (scale: number, index: number | null, count: number) => { view = { ...view, scale }; hit = { index, count }; for (const fn of rendered) fn(); },
    status: (next: EditorHostStatus) => { status = next; for (const fn of statuses) fn(); }, rendered };
}
it('forwards center zoom, CSS 1:1, fit and native focus without DPR math', () => {
  const h = host(); render(<ViewportControls host={h.bridge} />);
  expect(screen.getByLabelText('当前倍率').textContent).toBe('200%');
  fireEvent.click(screen.getByRole('button', { name: '放大' }));
  fireEvent.click(screen.getByRole('button', { name: '缩小' }));
  fireEvent.click(screen.getByRole('button', { name: '1:1 像素' }));
  expect(h.bridge.zoomAt).toHaveBeenNthCalledWith(1, 400, 300, 1.25);
  expect(h.bridge.zoomAt).toHaveBeenNthCalledWith(2, 400, 300, 0.8);
  expect(h.bridge.zoomAt).toHaveBeenNthCalledWith(3, 400, 300, 0.5);
  fireEvent.click(screen.getByRole('button', { name: '适配图像' }));
  fireEvent.click(screen.getByRole('button', { name: '聚焦选中对象' }));
  expect(h.bridge.fitImage).toHaveBeenCalledOnce(); expect(h.bridge.focusSelection).toHaveBeenCalledOnce();
});
it('projects native hit index/count and skips state updates on identical rendered values', () => {
  const h = host(); const committed = vi.fn();
  const mounted = render(<Profiler id="view" onRender={committed}><ViewportControls host={h.bridge} /></Profiler>);
  act(() => h.frame(1.25, 2, 7));
  expect(screen.getByLabelText('当前倍率').textContent).toBe('125%');
  expect(screen.getByLabelText('重叠命中栈').textContent).toContain('3 / 7');
  const count = committed.mock.calls.length;
  act(() => { for (let i = 0; i < 20; i++) h.frame(1.25, 2, 7); });
  expect(committed.mock.calls.length).toBe(count);
  const late = [...h.rendered][0]; mounted.unmount();
  expect(h.rendered.size).toBe(0); act(() => late());
});
it('disables controls for missing, paused or unavailable native sessions', () => {
  const h = host(); const mounted = render(<ViewportControls host={h.bridge} />);
  act(() => h.status('lost'));
  expect((screen.getByRole('button', { name: '放大' }) as HTMLButtonElement).disabled).toBe(true);
  mounted.rerender(<ViewportControls host={null} />);
  expect(screen.getByLabelText('当前倍率').textContent).toBe('—');
});
