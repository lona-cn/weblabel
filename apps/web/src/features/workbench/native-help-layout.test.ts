import { afterEach, expect, it, vi } from 'vitest';
import { saveAuthorizationEpoch, type Session } from '../../lib/t15/api';
import type { EditorPort } from './editor-port';
import { mountHelpView } from './help-view';
import type { WorkspaceState } from './workspace-state';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); document.body.replaceChildren(); });

it('retains pause and reminder choices while restoring the launcher and scroll after help closes', () => {
  const dialogMethods = {
    showModal(this: HTMLDialogElement) { this.open = true; },
    close(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event('close')); },
  };
  for (const [name, implementation] of Object.entries(dialogMethods)) {
    const previous = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name);
    Object.defineProperty(HTMLDialogElement.prototype, name, { configurable: true, writable: true, value: implementation });
    cleanups.push(() => { if (previous) Object.defineProperty(HTMLDialogElement.prototype, name, previous); else Reflect.deleteProperty(HTMLDialogElement.prototype, name); });
  }
  const scrolling = document.createElement('div'); scrolling.scrollTop = 420; scrolling.scrollLeft = 3;
  const previousScrolling = Object.getOwnPropertyDescriptor(document, 'scrollingElement');
  Object.defineProperty(document, 'scrollingElement', { configurable: true, value: scrolling });
  cleanups.push(() => { if (previousScrolling) Object.defineProperty(document, 'scrollingElement', previousScrolling); else Reflect.deleteProperty(document, 'scrollingElement'); });
  const user: Session = { user_id: 'u', username: 'synthetic', platform_admin: false, project_roles: [{ project_id: 'p', role: 'admin' }] };
  const listeners = new Set<() => void>(), host = { cancelGesture: vi.fn() };
  const state = {
    alive: true, session: user, sessionController: { getSnapshot: () => ({ kind: 'authenticated', session: user }) }, authorizationEpoch: saveAuthorizationEpoch(),
    projectId: 'p', project: { name: 'Synthetic project' }, activeLabel: 'label', fixedTask: null, paused: false, modal: false, host,
    loaded: { media: { original_name: 'synthetic.png' }, ontology: { ontology_version_id: 'v1', labels: [{ label_id: 'label', name: 'Equipment', shortcut: '1' }] } },
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    notify() { for (const listener of listeners) listener(); },
  } as unknown as WorkspaceState;
  const port = { cancelGesture: vi.fn(), getReadHost: () => host } as unknown as EditorPort;
  const owner = new AbortController(), root = document.createElement('div'); document.body.append(root);
  cleanups.push(() => owner.abort()); cleanups.push(mountHelpView(root, state, port, owner.signal));
  const control = <T extends HTMLElement>(id: string) => root.querySelector<T>(`[data-testid="${id}"]`)!;
  const launcher = control<HTMLButtonElement>('open-shortcut-help'); launcher.focus(); launcher.click();
  const dialog = control<HTMLDialogElement>('shortcut-help'), reminder = control<HTMLInputElement>('comfort-opt-in'), pause = control<HTMLButtonElement>('pause-editing');
  expect(dialog.open).toBe(true); expect(state.modal).toBe(true); expect(scrolling.scrollTop).toBe(0);
  expect(dialog.textContent).toContain('Synthetic project'); expect(dialog.textContent).toContain('synthetic.png'); expect(dialog.textContent).toContain('v1');
  expect(reminder.checked).toBe(false); reminder.click(); pause.click(); expect(state.paused).toBe(true);
  control<HTMLButtonElement>('shortcut-help-close').click();
  expect(dialog.open).toBe(false); expect(state.modal).toBe(false); expect(scrolling.scrollTop).toBe(420); expect(scrolling.scrollLeft).toBe(3); expect(document.activeElement).toBe(launcher);
  launcher.click(); expect(reminder.checked).toBe(true); expect(pause.getAttribute('aria-pressed')).toBe('true');
  pause.click(); reminder.click(); expect(state.paused).toBe(false); expect(reminder.checked).toBe(false);
  control<HTMLButtonElement>('shortcut-help-close').click();
});
