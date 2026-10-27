// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { nativeFixture } from './native-test-support';
import { mountAttributesView, attributeState, commonAttributes } from './attributes-view';
import { mountEditorKeyboard } from './toolbar-view';
import { projectObjectRows } from './objects-view';
import { applyDelta } from './workspace-data';
import { composeBBox } from './geometry-values';
import { createWorkbenchController } from './controller';
import { api } from '../../lib/t15/api';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); document.body.replaceChildren(); });
function setup() { const fixture = nativeFixture(), owner = new AbortController(), root = document.createElement('section'); document.body.append(root); cleanups.push(fixture.dispose, () => owner.abort()); return { ...fixture, owner, root }; }

it('re-reads synchronous write fences after a control was rendered writable', () => {
  const f = setup(); mountAttributesView(f.root, f.state, f.port, f.owner.signal);
  const field = f.root.querySelector<HTMLInputElement>('[data-testid=attribute-text]')!;
  expect(field.disabled).toBe(false); field.value = 'new'; field.dispatchEvent(new Event('input', { bubbles: true }));
  f.state.paused = true;
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(f.host.dispatch).not.toHaveBeenCalled();
  f.state.paused = false; f.revoke();
  f.port.attribute('text', 'after logout');
  expect(f.host.dispatch).not.toHaveBeenCalled();
});
it('keeps a draft while tabbing to explicit null and sends one scalar decision', () => {
  const f = setup(); mountAttributesView(f.root, f.state, f.port, f.owner.signal);
  const field = f.root.querySelector<HTMLInputElement>('[data-testid=attribute-text]')!, nullButton = f.root.querySelector<HTMLButtonElement>('[data-testid=attribute-value-text-null]')!;
  field.value = 'draft'; field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: nullButton }));
  expect(f.host.dispatch).not.toHaveBeenCalled(); nullButton.click();
  expect(f.host.dispatch).toHaveBeenCalledExactlyOnceWith({ kind: 'set_attributes', object_ids: ['object'], values: { text: null } });
});
it('does not submit text composition and cancels stale geometry input on generation change', () => {
  const f = setup(); mountAttributesView(f.root, f.state, f.port, f.owner.signal);
  const field = f.root.querySelector<HTMLInputElement>('[data-testid=attribute-text]')!;
  field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); field.value = '中文'; field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
  expect(f.host.dispatch).not.toHaveBeenCalled();
  const x = f.root.querySelector<HTMLInputElement>('[data-testid=geometry-x]')!; x.value = '9'; x.dispatchEvent(new Event('input', { bubbles: true }));
  f.host.getGeneration.mockReturnValue(1); f.state.notify(); x.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(f.host.dispatch).not.toHaveBeenCalled(); expect(x.value).toBe('2px');
});
it('excludes native buttons, text fields and IME from canvas delete and space shortcuts', () => {
  const f = setup(); mountEditorKeyboard(f.root, f.state, f.port, f.owner.signal);
  const canvas = document.createElement('canvas'), button = document.createElement('button'), field = document.createElement('input'); f.root.append(canvas, button, field);
  for (const target of [button, field]) for (const key of [{ key: 'Delete', code: 'Delete' }, { key: ' ', code: 'Space' }]) target.dispatchEvent(new KeyboardEvent('keydown', { ...key, bubbles: true }));
  canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', code: 'Delete', isComposing: true, bubbles: true })); expect(f.host.dispatch).not.toHaveBeenCalled(); expect(f.host.setTool).not.toHaveBeenCalled();
  canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', code: 'Delete', bubbles: true })); expect(f.host.dispatch).toHaveBeenCalledExactlyOnceWith({ kind: 'delete', object_ids: ['object'] });
  f.owner.abort(); f.host.dispatch.mockClear(); canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', code: 'Delete', bubbles: true })); expect(f.host.dispatch).not.toHaveBeenCalled();
});
it('filters and groups only the read-only projection while retaining hidden/offscreen selection', () => {
  const f = setup(); const second = { ...f.document.objects[0], object_id: 'offscreen' }; f.state.objects = [...f.document.objects, second]; f.state.flags = { offscreen: { hidden: true, locked: true } };
  f.state.selection.publish({ ...f.delta, selected_object_ids: ['object', 'offscreen'] });
  const rows = projectObjectRows(f.state.objects, f.ontology, 'object', true);
  expect(rows.map(row => row.object.object_id)).toEqual(['object']); expect(f.state.selection.getSelection()).toEqual(['object', 'offscreen']);
  f.port.attribute('text', 'all'); expect(f.host.dispatch).not.toHaveBeenCalled();
  expect(attributeState([{ ...second, attributes: { number: null } }, { ...second, attributes: {} }], 'number').kind).toBe('mixed');
});
it('intersects numeric ranges and enum definitions without inventing missing default values', () => {
  const f = setup(), secondLabel = { ...f.ontology.labels[0], label_id: 'second', attributes: f.ontology.labels[0].attributes.map(def => def.key === 'number' ? { ...def, min: 5, max: 8 } : def) };
  const projected = commonAttributes([f.document.objects[0], { ...f.document.objects[0], label_id: 'second' }], { ...f.ontology, labels: [...f.ontology.labels, secondLabel] });
  expect(projected.find(def => def.key === 'number')).toMatchObject({ min: 5, max: 8 });
  expect(composeBBox({ x: '2.5px', y: '3', w: '4.25', h: '7' }, { width: 100, height: 100 })).toEqual({ bbox: { type: 'bbox_xyxy', x_min: 2.5, y_min: 3, x_max: 6.75, y_max: 10 } });
  expect(composeBBox({ x: 'NaN', y: '3', w: '4', h: '7' }, { width: 100, height: 100 })).toHaveProperty('error');
});
it('uses only committed Native delta snapshots as the full save producer', () => {
  const f = setup(), enqueue = vi.spyOn(f.state.queue, 'enqueue');
  applyDelta(f.state, f.port, f.state.host!, { ...f.delta, repaint: true }); expect(enqueue).not.toHaveBeenCalled();
  applyDelta(f.state, f.port, f.state.host!, { ...f.delta, generation: 1, document_changed: true }); expect(enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ generation: 1, document: f.document }));
  f.revoke(); applyDelta(f.state, f.port, f.state.host!, { ...f.delta, generation: 2, document_changed: true }); expect(enqueue).toHaveBeenCalledTimes(1);
  expect(f.root.querySelector('script')).toBeNull();
});
it('aborts its actual catalog GET and refuses late installation when the owning page is disposed', async () => {
  const f = setup(); let received: AbortSignal | undefined;
  vi.spyOn(api, 'projects').mockImplementation(signal => new Promise((_resolve, reject) => { received = signal; signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); }));
  vi.spyOn(api, 'ontologies').mockResolvedValue({ items: [], next_cursor: null }); vi.spyOn(api, 'assets').mockResolvedValue([]);
  const controller = createWorkbenchController({ session: f.state.sessionController, navigate: vi.fn(), signal: f.owner.signal, route: { projectId: f.state.projectId, assetId: 'asset', ontologyId: 'ontology', dataset: false, revisionId: null, queue: undefined, taskId: null } }, { projectId: f.state.projectId, assetId: 'asset', ontologyId: 'ontology', taskId: null });
  cleanups.push(controller.dispose); const start = controller.start(); expect(received?.aborted).toBe(false); controller.dispose(); await start;
  expect(received?.aborted).toBe(true); expect(controller.state.loaded).toBeNull(); expect(controller.state.queue.toRecord('asset')).toBeNull();
});
