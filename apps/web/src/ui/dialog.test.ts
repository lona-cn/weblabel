// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDialog } from './dialog';

const owners: AbortController[] = [];
const nativeRestores: (() => void)[] = [];
beforeEach(() => {
  const methods = {
    showModal(this: HTMLDialogElement) { this.open = true; },
    close(this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    },
  };
  for (const [name, implementation] of Object.entries(methods)) {
    const original = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name);
    Object.defineProperty(HTMLDialogElement.prototype, name, { configurable: true, writable: true, value: implementation });
    nativeRestores.push(() => { if (original) Object.defineProperty(HTMLDialogElement.prototype, name, original); else Reflect.deleteProperty(HTMLDialogElement.prototype, name); });
  }
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    return (this.closest('[hidden],dialog:not([open])') ? [] : [new DOMRect(0, 0, 80, 36)]) as unknown as DOMRectList;
  });
});
afterEach(() => { for (const owner of owners.splice(0)) owner.abort(); for (const restore of nativeRestores.splice(0).reverse()) restore(); document.body.replaceChildren(); vi.restoreAllMocks(); });
function fixture(fallbackFocus?: () => HTMLElement | null) {
  const owner = new AbortController(); owners.push(owner);
  const trigger = document.createElement('button'); document.body.append(trigger);
  const dialog = createDialog({ id: 'synthetic-dialog', title: 'Synthetic confirmation', testId: 'synthetic-dialog', signal: owner.signal, fallbackFocus });
  dialog.element.querySelector('button')!.hidden = true;
  const first = document.createElement('input'), last = document.createElement('button'), hidden = document.createElement('input'), disabled = document.createElement('button');
  hidden.hidden = true; disabled.disabled = true;
  dialog.content.append(first, last, hidden, disabled); document.body.append(dialog.element); dialog.open(trigger);
  return { dialog, trigger, first, last };
}
it('cycles both Tab boundaries without landing on hidden or disabled controls', () => {
  const { dialog, first, last } = fixture();
  last.focus();
  const forward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }); last.dispatchEvent(forward);
  expect(forward.defaultPrevented).toBe(true); expect(document.activeElement).toBe(first);
  const reverse = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }); first.dispatchEvent(reverse);
  expect(reverse.defaultPrevented).toBe(true); expect(document.activeElement).toBe(last);
  dialog.close();
});
it('returns to the available launcher when responsive layout removed the original trigger', () => {
  const launcher = document.createElement('button'); document.body.append(launcher);
  const { dialog, trigger, first } = fixture(() => launcher);
  first.focus(); trigger.remove(); dialog.close();
  expect(document.activeElement).toBe(launcher);
});
