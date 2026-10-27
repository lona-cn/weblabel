import { expect, it } from 'vitest';
import { saveAuthorizationEpoch, type Session } from '../../lib/t15/api';
import type { EditorPort } from './editor-port';
import { mountAttributesView } from './attributes-view';
import type { WorkspaceState } from './workspace-state';

it('cancels dirty inputs before allowing Escape to reach the enclosing drawer', () => {
  const user: Session = { user_id: 'u', username: 'synthetic', platform_admin: false, project_roles: [{ project_id: 'p', role: 'admin' }] };
  const object = { object_id: 'object', label_id: 'label', geometry: { x_min: 4, y_min: 5, x_max: 30, y_max: 25 }, attributes: { note: 'original' } };
  const ontology = { labels: [{ label_id: 'label', name: 'Person', attributes: [{ key: 'note', kind: 'text', required: false, default_value: '', enum_values: [], min: null, max: null }] }] };
  const state = {
    alive: true, session: user, sessionController: { getSnapshot: () => ({ kind: 'authenticated', session: user }) }, authorizationEpoch: saveAuthorizationEpoch(),
    projectId: 'p', project: { project_id: 'p', role: 'admin' }, scope: {}, host: { status: 'ready', getGeneration: () => 0 },
    loaded: { ontology, readOnlyPreview: false }, objects: [object], flags: {}, selection: { getSelection: () => ['object'] },
    subscribe: () => () => {},
  } as unknown as WorkspaceState;
  const port = { selectionWritable: () => true } as unknown as EditorPort;
  const owner = new AbortController(), drawer = document.createElement('div'), root = document.createElement('div'); drawer.append(root); document.body.append(drawer);
  const unmount = mountAttributesView(root, state, port, owner.signal);
  try {
    let escaped = 0;
    drawer.addEventListener('keydown', event => { if (event.key === 'Escape') escaped++; });
    const key = (target: HTMLElement) => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      target.dispatchEvent(event); return event.defaultPrevented;
    };
    const geometry = root.querySelector<HTMLInputElement>('[data-testid="geometry-x"]')!;
    geometry.value = '9px'; geometry.dispatchEvent(new Event('input', { bubbles: true }));
    expect(key(geometry)).toBe(true); expect(geometry.value).toBe('4px'); expect(escaped).toBe(0);
    expect(key(geometry)).toBe(false); expect(escaped).toBe(1);
    const apply = root.querySelector<HTMLButtonElement>('[data-testid="geometry-apply"]')!;
    geometry.value = '9px'; geometry.dispatchEvent(new Event('input', { bubbles: true }));
    expect(key(apply)).toBe(true); expect(geometry.value).toBe('4px'); expect(escaped).toBe(1);
    expect(key(apply)).toBe(false); expect(escaped).toBe(2);
    const note = root.querySelector<HTMLInputElement>('[data-testid="attribute-note"]')!;
    note.value = 'draft'; note.dispatchEvent(new Event('input', { bubbles: true }));
    expect(key(note)).toBe(true); expect(note.value).toBe('original'); expect(escaped).toBe(2);
    expect(key(note)).toBe(false); expect(escaped).toBe(3);
    geometry.value = '9px'; geometry.dispatchEvent(new Event('input', { bubbles: true }));
    expect(key(note)).toBe(true); expect(geometry.value).toBe('4px'); expect(escaped).toBe(3);
    expect(key(note)).toBe(false); expect(escaped).toBe(4);
    note.value = 'draft'; note.dispatchEvent(new Event('input', { bubbles: true }));
    expect(key(apply)).toBe(true); expect(note.value).toBe('original'); expect(escaped).toBe(4);
    expect(key(apply)).toBe(false); expect(escaped).toBe(5);
  } finally { owner.abort(); unmount(); drawer.remove(); }
});
