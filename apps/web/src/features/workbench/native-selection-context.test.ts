import { afterEach, expect, it } from 'vitest';
import { saveAuthorizationEpoch, type Session } from '../../lib/t15/api';
import type { AnnotationDocument } from '../../lib/editor/types';
import { createEditorPort } from './editor-port';
import { mountSelectionContextView } from './selection-context-view';
import type { WorkspaceState } from './workspace-state';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); document.body.replaceChildren(); });
function setup() {
  const user: Session = { user_id: 'u', username: 'synthetic', platform_admin: false, project_roles: [{ project_id: 'p', role: 'viewer' }] };
  const document: AnnotationDocument = { schema_version: 1, asset_revision_id: 'a', ontology_version_id: 'v', coordinate_space: { type: 'canonical_image_pixels', width: 1200, height: 900 }, completion: 'in_progress', objects: [
    { object_id: 'first', label_id: 'label', geometry: { type: 'bbox_xyxy', x_min: 20, y_min: 30, x_max: 60, y_max: 80 }, attributes: {}, origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null } },
    { object_id: 'second', label_id: 'label', geometry: { type: 'bbox_xyxy', x_min: 500, y_min: 400, x_max: 600, y_max: 650 }, attributes: {}, origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null } },
  ] };
  const listeners = new Set<() => void>(); let authenticated = true;
  const state = {
    alive: true, session: user, sessionController: { getSnapshot: () => authenticated ? { kind: 'authenticated', session: user } : { kind: 'anonymous' } }, authorizationEpoch: saveAuthorizationEpoch(),
    projectId: 'p', project: { project_id: 'p', role: 'viewer' }, assetId: 'a', ontologyId: 'v', scope: {}, host: null,
    loaded: { document, readOnlyPreview: true, media: { project_id: 'p', asset_revision_id: 'a' }, ontology: { labels: [{ label_id: 'label', name: '类别' }] } },
    objects: document.objects, flags: { second: { hidden: true, locked: true } }, previewSelection: ['first'],
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    notify() { for (const listener of listeners) listener(); },
  } as unknown as WorkspaceState;
  const owner = new AbortController(), root = window.document.createElement('section'); window.document.body.append(root);
  cleanups.push(() => owner.abort()); cleanups.push(mountSelectionContextView(root, state, createEditorPort(state), owner.signal, () => true));
  return { state, root, document, revoke() { authenticated = false; state.notify(); } };
}

it('navigates the full document without wrapping, mutating geometry, or reducing a multi-selection', () => {
  const { state, root, document } = setup(), original = structuredClone(document);
  const previous = root.querySelector<HTMLButtonElement>('[data-testid="inspection-previous"]')!, next = root.querySelector<HTMLButtonElement>('[data-testid="inspection-next"]')!;
  expect(previous.disabled).toBe(true); next.click();
  expect(state.previewSelection).toEqual(['second']);
  expect(root.querySelector('svg rect')?.getAttribute('x')).toBe('500');
  expect(root.querySelector('code')?.textContent).toBe('second'); expect(next.disabled).toBe(true);
  next.dispatchEvent(new MouseEvent('click', { bubbles: true })); expect(state.previewSelection).toEqual(['second']);
  expect(state.flags.second).toEqual({ hidden: true, locked: true });
  state.previewSelection = ['first', 'second']; state.notify();
  expect(previous.disabled).toBe(true); expect(next.disabled).toBe(true);
  previous.dispatchEvent(new MouseEvent('click', { bubbles: true })); expect(state.previewSelection).toEqual(['first', 'second']);
  expect(root.querySelector('svg')).toBeNull(); expect(document).toEqual(original);
});

it('does not project a previous asset or an entirely out-of-image box into a misleading crop', () => {
  const { state, root, document } = setup();
  state.assetId = 'other'; state.notify(); expect(root.querySelector('svg image')).toBeNull();
  state.assetId = 'a';
  const outside = { ...document.objects[0], geometry: { type: 'bbox_xyxy' as const, x_min: 1400, y_min: 30, x_max: 1500, y_max: 80 } };
  state.objects = [outside, document.objects[1]]; state.notify();
  expect(root.querySelector('svg')).toBeNull(); expect(root.querySelector('code')?.textContent).toBe('first');
  expect(outside.geometry).toEqual({ type: 'bbox_xyxy', x_min: 1400, y_min: 30, x_max: 1500, y_max: 80 });
});

it('clears the crop and rejects stale navigation after the session is revoked', () => {
  const { state, root, revoke } = setup(), next = root.querySelector<HTMLButtonElement>('[data-testid="inspection-next"]')!;
  revoke(); next.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(root.hidden).toBe(true); expect(root.querySelector('svg')).toBeNull(); expect(state.previewSelection).toEqual(['first']);
});
