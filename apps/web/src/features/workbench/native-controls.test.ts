// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { nativeFixture } from './native-test-support';
import { mountToolbarView } from './toolbar-view';
import { mountHelpView } from './help-view';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanups.splice(0).reverse()) dispose(); vi.restoreAllMocks(); vi.useRealTimers(); document.body.replaceChildren(); });
function fixture() {
  const f = nativeFixture(), owner = new AbortController(), root = document.createElement('section'); document.body.append(root);
  cleanups.push(f.dispose, () => owner.abort());
  const control = <T extends HTMLElement>(id: string) => root.querySelector<T>('[data-testid=' + id + ']')!;
  return { ...f, root, owner, control };
}
it('updates viewport/overlap projection from Native rendering and delegates zoom, fit and focus without a geometry write', () => {
  const f = fixture(); cleanups.push(mountToolbarView(f.root, f.state, f.port, f.owner.signal));
  const notify = f.host.subscribeRendered.mock.calls[0][0];
  f.host.getViewport.mockReturnValue({ scale: 1.234, tx: 2.5, ty: 3.75, css_width: 800, css_height: 600, dpr: 2 });
  f.host.getHitStackState.mockReturnValue({ index: 2, count: 4 }); notify();
  expect(f.root.querySelector('output')?.textContent).toBe('123% · 重叠 3/4');
  f.control<HTMLButtonElement>('zoom-in').click(); expect(f.host.zoomAt).toHaveBeenCalledWith(400, 300, 1.2);
  f.control<HTMLButtonElement>('fit-image').click(); f.control<HTMLButtonElement>('focus-selection').click();
  expect(f.host.fitImage).toHaveBeenCalledTimes(1); expect(f.host.focusSelection).toHaveBeenCalledTimes(1); expect(f.host.dispatch).not.toHaveBeenCalled();
  f.state.loaded!.readOnlyPreview = true; f.state.notify();
  expect(f.control<HTMLButtonElement>('tool-box').disabled).toBe(true); expect(f.control<HTMLButtonElement>('zoom-in').disabled).toBe(false);
  f.control<HTMLButtonElement>('zoom-out').click(); expect(f.host.zoomAt).toHaveBeenLastCalledWith(400, 300, 1 / 1.2); expect(f.host.dispatch).not.toHaveBeenCalled();
});
function dialogBoundary() {
  // JSDOM lacks these platform methods; install only this test-realm boundary.
  const methods = {
    showModal(this: HTMLDialogElement) { this.open = true; },
    close(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event('close')); },
  };
  for (const [name, implementation] of Object.entries(methods)) {
    const original = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name);
    Object.defineProperty(HTMLDialogElement.prototype, name, { configurable: true, writable: true, value: implementation });
    cleanups.push(() => { if (original) Object.defineProperty(HTMLDialogElement.prototype, name, original); else Reflect.deleteProperty(HTMLDialogElement.prototype, name); });
  }
}
it('keeps help usable for a read-only editor and returns focus to its real launcher when the dialog closes', () => {
  dialogBoundary();
  const f = fixture(); f.state.loaded!.readOnlyPreview = true;
  cleanups.push(mountHelpView(f.root, f.state, f.port, f.owner.signal));
  const launcher = f.control<HTMLButtonElement>('open-shortcut-help'); launcher.focus(); launcher.click();
  const dialog = f.control<HTMLDialogElement>('shortcut-help'); expect(dialog.open).toBe(true); expect(f.state.modal).toBe(true); expect(dialog.textContent).toContain('固定规范');
  f.control<HTMLButtonElement>('shortcut-help-close').click();
  expect(dialog.open).toBe(false); expect(f.state.modal).toBe(false); expect(document.activeElement).toBe(launcher); expect(f.host.dispatch).not.toHaveBeenCalled();
});
it('defers a voluntary reminder through a live pointer without pausing or moving keyboard focus', () => {
  vi.useFakeTimers(); dialogBoundary(); const f = fixture(); cleanups.push(mountHelpView(f.root, f.state, f.port, f.owner.signal));
  const launcher = f.control<HTMLButtonElement>('open-shortcut-help'); launcher.focus(); launcher.click();
  const optIn = f.control<HTMLInputElement>('comfort-opt-in'); optIn.click(); f.control<HTMLButtonElement>('shortcut-help-close').click();
  const pointer = new MouseEvent('pointerdown', { bubbles: true }); Object.defineProperty(pointer, 'pointerId', { value: 7 }); f.root.dispatchEvent(pointer);
  vi.advanceTimersByTime(45 * 60_000); expect(f.control('comfort-reminder').textContent).toBe('');
  const up = new MouseEvent('pointerup', { bubbles: true }); Object.defineProperty(up, 'pointerId', { value: 7 }); window.dispatchEvent(up);
  expect(f.control('comfort-reminder').textContent).toContain('45 分钟'); expect(f.state.paused).toBe(false); expect(document.activeElement).toBe(launcher);
  optIn.click(); expect(f.control('comfort-reminder').textContent).toBe('');
});
