// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { EditorFacade, EditorHostOptions, Viewport } from '../../lib/editor/types';
import { nativeFixture } from './native-test-support';
import { mountCanvasView } from './canvas-view';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); document.body.replaceChildren(); });
// Synthetic C3 boundary only. Real wgpu/device coverage is main-agent browser acceptance.
function fixture() {
  const f = nativeFixture(), owner = new AbortController(); cleanups.push(f.dispose, () => owner.abort());
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON: () => ({}) });
  let lost!: (message: string) => void, recovered!: () => void;
  let deviceState: 'ready' | 'lost' | 'recovering' | 'disposed' = 'ready';
  let loss = new Promise<string>(resolve => { lost = resolve; });
  const recovery = new Promise<void>(resolve => { recovered = resolve; });
  let viewport: Viewport = { scale: 1, tx: 0, ty: 0, css_width: 100, css_height: 100, dpr: 1 };
  const facade: EditorFacade = {
    dispatch: vi.fn(() => f.delta), pointer: vi.fn(() => f.delta), set_tool: vi.fn(), set_active_label: vi.fn(), set_viewport: vi.fn(value => { viewport = value; }), zoom_at: vi.fn(), fit_image: vi.fn(), focus_selection: vi.fn(), focus_region: vi.fn(() => true), get_hit_stack_state: vi.fn(() => ({ index: null, count: 0 })), set_selection: vi.fn(() => f.delta), set_local_flags: vi.fn(() => f.delta),
    get_snapshot: vi.fn(() => f.document), get_commit_readback: vi.fn(() => { throw new Error('No document commit in this lifecycle fixture'); }), get_generation: vi.fn(() => 0), get_object_hashes: vi.fn(() => ({ object: 'hash' })), get_viewport: () => viewport, set_predictions: vi.fn(), render: vi.fn(),
    device_lost: () => loss, get_device_state: () => deviceState, recover_renderer: vi.fn(async () => { deviceState = 'recovering'; await recovery; loss = new Promise<string>(resolve => { lost = resolve; }); deviceState = 'ready'; }), dispose: vi.fn(() => { deviceState = 'disposed'; }),
    get_canvas_labels: vi.fn(() => [{ object_id: 'object', x_css: viewport.tx + 2, y_css: viewport.ty + 3, selected: true }]),
  };
  const create = vi.fn(async () => ({ facade, transfer: { method: 'copyBytes' as const, byteLength: 40_000, durationMs: 0 } }));
  const frames: ((time: number) => void)[] = [];
  const hostOptions: Partial<EditorHostOptions> = { facadeFactory: { create }, scheduler: { request(callback) { frames.push(callback); return frames.length; }, cancel: vi.fn() } };
  f.state.host = null;
  const view = mountCanvasView(f.state, f.port, owner.signal, hostOptions); document.body.append(view.element); cleanups.push(view.dispose);
  return { ...f, owner, facade, create, view, frames, lose() { deviceState = 'lost'; lost('device destroyed'); }, recover() { recovered(); } };
}
it('keeps the same canvas and Native host while drawers, panels and save state change', async () => {
  const f = fixture(); await vi.waitFor(() => expect(f.state.host?.status).toBe('ready'));
  const host = f.state.host, canvas = f.view.element.querySelector('canvas');
  f.state.modal = true; f.state.notify(); expect(f.view.element.querySelector('canvas')).toBe(canvas); expect(f.state.host).toBe(host); expect(canvas?.inert).toBe(true);
  f.state.modal = false; f.state.paused = true; f.state.notify(); f.state.paused = false; f.state.notify();
  expect(f.create).toHaveBeenCalledTimes(1); expect(f.facade.dispose).not.toHaveBeenCalled();
});
it('patches labels from the Rust projection during viewport changes without another document serialization', async () => {
  const f = fixture(); await vi.waitFor(() => expect(f.state.host?.status).toBe('ready'));
  for (const frame of f.frames.splice(0)) frame(1);
  const label = f.view.element.querySelector('[data-testid=canvas-label]'), reads = vi.mocked(f.facade.get_snapshot).mock.calls.length;
  f.state.host!.pan(5, 7); for (const frame of f.frames.splice(0)) frame(2);
  expect(f.view.element.querySelector('[data-testid=canvas-label]')).toBe(label); expect((label as HTMLElement).style.transform).toContain('7px'); expect(vi.mocked(f.facade.get_snapshot).mock.calls.length).toBe(reads);
});
it('recovers the same CPU session and keeps all edit commands fenced until real recovery resolves', async () => {
  const f = fixture(); await vi.waitFor(() => expect(f.state.host?.status).toBe('ready')); const host = f.state.host;
  f.lose(); await vi.waitFor(() => expect(host?.status).toBe('recovering')); expect(f.port.getHost()).toBeNull();
  f.port.dispatch({ kind: 'undo' }); expect(f.facade.dispatch).not.toHaveBeenCalled();
  f.recover(); await vi.waitFor(() => expect(host?.status).toBe('ready')); expect(f.state.host).toBe(host); expect(f.create).toHaveBeenCalledTimes(1); expect(f.facade.dispose).not.toHaveBeenCalled();
});

it('preserves Native label order, fractional CSS positions and semantic names across unchanged frames', async () => {
  const f = fixture(); await vi.waitFor(() => expect(f.state.host?.status).toBe('ready'));
  vi.mocked(f.facade.get_canvas_labels!).mockReturnValue([
    { object_id: 'object', x_css: 2.25, y_css: 3.75, selected: true },
    { object_id: 'second', x_css: 20.5, y_css: 40.125, selected: false },
  ]);
  f.state.host!.pan(1, 0); for (const frame of f.frames.splice(0)) frame(1);
  const first = f.view.element.querySelector<HTMLElement>('[data-object-id=object]')!;
  expect(first.style.transform).toBe('translate(2.25px,3.75px)'); expect(first.textContent).toContain('<script>类别</script> #1'); expect(first.querySelector('script')).toBeNull();
  vi.mocked(f.facade.get_canvas_labels!).mockReturnValue([
    { object_id: 'second', x_css: 20.5, y_css: 40.125, selected: true },
    { object_id: 'object', x_css: 2.25, y_css: 3.75, selected: false },
  ]);
  f.state.host!.pan(1, 0); for (const frame of f.frames.splice(0)) frame(2);
  expect([...f.view.element.querySelectorAll<HTMLElement>('[data-testid=canvas-label]')].map(node => node.dataset.objectId)).toEqual(['second', 'object']);
  expect(f.view.element.querySelector('[data-object-id=object]')).toBe(first); expect(first.dataset.selected).toBe('false');
  f.state.objects = [{ ...f.document.objects[0], label_id: 'renamed' }];
  f.state.loaded!.ontology = { ...f.ontology, labels: [{ ...f.ontology.labels[0], label_id: 'renamed', name: '车辆' }] }; f.state.notify();
  expect(first.textContent).toBe('车辆 #1');
  vi.mocked(f.facade.get_canvas_labels!).mockReturnValue([]); f.state.host!.pan(1, 0); for (const frame of f.frames.splice(0)) frame(3);
  expect(f.view.element.querySelector('[data-testid=canvas-label]')).toBeNull();
});

it('withdraws the old same-asset host and labels until the replacement document is actually ready', async () => {
  const f = fixture(); await vi.waitFor(() => expect(f.state.host?.status).toBe('ready'));
  const oldHost = f.state.host!; for (const frame of f.frames.splice(0)) frame(1);
  const replacement = { ...f.document, completion: 'complete' as const, objects: [{ ...f.document.objects[0], attributes: { text: 'replacement' } }] };
  const pending = Promise.withResolvers<{ facade: EditorFacade; transfer: { method: 'copyBytes'; byteLength: number; durationMs: number } }>();
  f.create.mockImplementationOnce(() => pending.promise);
  f.state.loaded = { ...f.state.loaded!, readOnlyPreview: true, document: replacement, revision: { ...f.revision, document: replacement, annotation_revision_id: 'replacement-revision' } }; f.state.notify();
  expect(oldHost.status).toBe('disposed'); expect(f.view.element.querySelector('[data-testid=canvas-label]')).toBeNull(); expect(f.port.getHost()).toBeNull();
  const nextFacade: EditorFacade = { ...f.facade, get_snapshot: () => replacement, get_device_state: () => 'ready', dispose: vi.fn() };
  pending.resolve({ facade: nextFacade, transfer: { method: 'copyBytes', byteLength: 40_000, durationMs: 0 } });
  await vi.waitFor(() => expect(f.state.host?.status).toBe('ready'));
  expect(f.state.host).not.toBe(oldHost); expect(f.state.host!.getSnapshot()).toEqual(replacement);
  expect(f.view.element.querySelector('canvas')!.inert).toBe(true); expect(f.port.getHost()).toBeNull();
});

it('shows an actual Native initialization error without replacing the canvas with a fake renderer', async () => {
  const f = fixture(); await vi.waitFor(() => expect(f.state.host?.status).toBe('ready'));
  const canvas = f.view.element.querySelector('canvas');
  f.create.mockRejectedValueOnce(new Error('synthetic adapter initialization rejected'));
  f.state.loaded = { ...f.state.loaded!, document: { ...f.document, completion: 'complete' } }; f.state.notify();
  await vi.waitFor(() => expect(f.state.host?.status).toBe('error'));
  expect(f.view.element.textContent).toContain('synthetic adapter initialization rejected');
  expect(f.view.element.querySelector('canvas')).toBe(canvas); expect(canvas!.inert).toBe(true); expect(f.port.getHost()).toBeNull();
});

it('keeps an unavailable WebGPU adapter read-only and exposes the structured cause', async () => {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: {} });
  cleanups.push(() => { if (previous) Object.defineProperty(navigator, 'gpu', previous); else Reflect.deleteProperty(navigator, 'gpu'); });
  const f = fixture(); await vi.waitFor(() => expect(f.state.host?.status).toBe('ready'));
  const canvas = f.view.element.querySelector('canvas');
  f.create.mockRejectedValueOnce({ code: 'WEBGPU_UNAVAILABLE', message: 'No suitable graphics adapter found', request_id: 'synthetic-adapter-error', details: null });
  f.state.loaded = { ...f.state.loaded!, document: { ...f.document, completion: 'complete' } }; f.state.notify();
  await vi.waitFor(() => expect(f.state.error).toContain('No suitable graphics adapter found'));
  const status = f.view.element.querySelector<HTMLElement>('[data-testid=gpu-status]')!;
  expect(status.dataset.deviceState).toBe('unsupported');
  expect(f.view.element.textContent).toContain('WEBGPU_UNAVAILABLE');
  expect(f.state.error).not.toContain('[object Object]');
  expect(f.view.element.querySelector('canvas')).toBe(canvas);
  expect(canvas!.inert).toBe(true); expect(f.port.getHost()).toBeNull();
});
