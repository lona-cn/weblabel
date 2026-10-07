import { act, cleanup, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorHost } from '../../lib/editor/EditorHost';
import type { CanvasLabel, CreatedEditor, EditorAssetRequest, EditorDelta, EditorFacade, EditorFacadeFactory, RenderScheduler, Viewport } from '../../lib/editor/types';
import { CanvasView } from './CanvasView';

// Only the WASM/GPU boundary is synthetic. Drive the real host's scheduled
// rendered subscription and assert the DOM, not element/cache implementation.
const delta: EditorDelta = { generation: 0, changed_objects: [], removed_object_ids: [], selected_object_ids: [], can_undo: false, can_redo: false, document_changed: false, repaint: true, suggestion_decisions: [], error: null };
function request(assetId = 'asset-labels'): EditorAssetRequest {
  return {
    media: { asset_id: assetId, asset_revision_id: assetId, project_id: 'project', original_name: 'synthetic.png', original_sha256: 'a'.repeat(64), canonical_sha256: 'b'.repeat(64), canonical_width: 640, canonical_height: 480, exif_orientation: 1, original_to_canonical: [1, 0, 0, 0, 1, 0, 0, 0, 1], source_group_id: 'source' },
    ontology: { ontology_version_id: 'ontology', project_id: 'project', version_no: 1, labels: [], guidelines_markdown: '', allow_out_of_bounds: false },
    document: { schema_version: 1, asset_revision_id: assetId, ontology_version_id: 'ontology', coordinate_space: { type: 'canonical_image_pixels', width: 640, height: 480 }, completion: 'unprocessed', objects: [] },
    frame: { width: 640, height: 480, rgba: new Uint8Array(640 * 480 * 4) }, initial_generation: 0,
  };
}
class Scheduler implements RenderScheduler {
  private callbacks = new Map<number, (timestamp: number) => void>();
  private next = 0;
  request(callback: (timestamp: number) => void): number { this.callbacks.set(++this.next, callback); return this.next; }
  cancel(handle: number): void { this.callbacks.delete(handle); }
  flush(): void { const pending = [...this.callbacks.values()]; this.callbacks.clear(); for (const callback of pending) callback(1000); }
}
class Factory implements EditorFacadeFactory {
  readonly creations: { labels: CanvasLabel[]; settle: () => void }[] = [];
  create(_canvas: HTMLCanvasElement, asset: EditorAssetRequest): Promise<CreatedEditor> {
    return new Promise((resolve) => {
      let viewport: Viewport = { scale: 1, tx: 0, ty: 0, css_width: 640, css_height: 480, dpr: 1 };
      const creation = { labels: [] as CanvasLabel[], settle: () => resolve({ facade, transfer: { method: 'copyBytes', byteLength: asset.frame.rgba.byteLength, durationMs: 0 } }) };
      const facade: EditorFacade = {
        dispatch: () => delta, pointer: () => delta, set_tool: () => {}, set_active_label: () => {},
        set_viewport: (value) => { viewport = value; }, zoom_at: () => {}, fit_image: () => {},
        set_selection: () => delta, set_local_flags: () => delta, get_snapshot: () => asset.document,
        get_commit_readback: () => { throw Error('Projection fixture has no document commits'); },
        get_generation: () => 0, get_object_hashes: () => ({}), get_viewport: () => viewport,
        set_predictions: () => {}, render: () => {}, device_lost: () => new Promise(() => {}),
        get_device_state: () => 'ready', recover_renderer: async () => {}, dispose: () => {},
        get_canvas_labels: () => creation.labels.map((label) => ({ ...label })),
      };
      this.creations.push(creation);
    });
  }
}
function label(object_id: string, x_css = 10.125, y_css = 20.25, selected = false): CanvasLabel { return { object_id, x_css, y_css, selected }; }
function visible(): { id: string | null; text: string | null; selected: string | null; transform: string }[] {
  return screen.queryAllByTestId('canvas-label').map((node) => ({ id: node.getAttribute('data-object-id'), text: node.textContent, selected: node.getAttribute('data-selected'), transform: node.style.transform }));
}
async function mount() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 640, 480));
  const factory = new Factory(), scheduler = new Scheduler();
  let host: EditorHost | undefined;
  const props = { request: request(), hostOptions: { facadeFactory: factory, scheduler }, activeTool: 'select' as const, onDelta: () => {}, onHostReady: (ready: EditorHost) => { host = ready; } };
  const view = render(<StrictMode><CanvasView {...props} /></StrictMode>);
  await act(async () => { await Promise.resolve(); factory.creations[0].settle(); });
  function frame(labels: CanvasLabel[]): void {
    factory.creations.at(-1)!.labels = labels;
    act(() => { host!.select([]); scheduler.flush(); });
  }
  return { factory, scheduler, props, view, frame, host: () => host! };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('T31 native canvas label DOM projection', () => {
  it('refreshes exact CSS fractions and selection after unchanged native frames and parent renders', async () => {
    const mounted = await mount();
    mounted.frame([label('first'), label('second', 30.5, 40.75)]);
    mounted.frame([label('first'), label('second', 30.5, 40.75)]);
    mounted.view.rerender(<StrictMode><CanvasView {...mounted.props} readOnly /></StrictMode>);
    expect(visible().map(({ id, transform }) => ({ id, transform }))).toEqual([
      { id: 'first', transform: 'translate(10.125px, 20.25px)' }, { id: 'second', transform: 'translate(30.5px, 40.75px)' },
    ]);
    mounted.frame([label('first', 10.125000000000002, 20.250000000000004, true), label('second', 30.5, 40.75)]);
    expect(visible()[0]).toEqual({ id: 'first', text: 'first', selected: 'true', transform: 'translate(10.125000000000002px, 20.250000000000004px)' });
    mounted.frame([label('first', -4.375, 92.625, false), label('second', 30.5, 40.75, true)]);
    expect(visible().map(({ id, selected, transform }) => ({ id, selected, transform }))).toEqual([
      { id: 'first', selected: 'false', transform: 'translate(-4.375px, 92.625px)' }, { id: 'second', selected: 'true', transform: 'translate(30.5px, 40.75px)' },
    ]);
    expect(screen.getAllByTestId('canvas-label')[0].closest('[aria-hidden]')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('preserves native order and removes hidden/deleted labels before reusing an ID', async () => {
    const { frame } = await mount();
    frame([label('first'), label('second'), label('third')]);
    frame([label('third'), label('first'), label('second')]);
    expect(visible().map(({ id }) => id)).toEqual(['third', 'first', 'second']);
    frame([label('second')]);
    expect(visible().map(({ id }) => id)).toEqual(['second']);
    frame([]);
    expect(visible()).toEqual([]);
    frame([label('first', 83.125, 14.875, true), label('replacement')]);
    expect(visible().map(({ text, selected, transform }) => ({ text, selected, transform }))).toEqual([
      { text: 'first', selected: 'true', transform: 'translate(83.125px, 14.875px)' }, { text: 'replacement', selected: 'false', transform: 'translate(10.125px, 20.25px)' },
    ]);
  });

  it('clears old asset labels during replacement and ignores late old rendered notifications', async () => {
    const mounted = await mount();
    mounted.frame([label('shared'), label('old-only')]);
    let lateRendered: (() => void) | undefined;
    const subscribe = EditorHost.prototype.subscribeRendered;
    vi.spyOn(EditorHost.prototype, 'subscribeRendered').mockImplementation(function (this: EditorHost, listener) {
      lateRendered = listener;
      return subscribe.call(this, listener);
    });
    mounted.view.rerender(<StrictMode><CanvasView {...mounted.props} request={request('asset-second')} /></StrictMode>);
    await act(async () => { await Promise.resolve(); });
    expect(visible()).toEqual([]);
    const secondRendered = lateRendered!;
    mounted.factory.creations[1].labels = [label('shared', 100.5, 200.25, true)];
    await act(async () => { mounted.factory.creations[1].settle(); mounted.scheduler.flush(); });
    mounted.frame([label('shared', 100.5, 200.25, true)]);
    mounted.view.rerender(<StrictMode><CanvasView {...mounted.props} request={request('asset-third')} /></StrictMode>);
    await act(async () => { await Promise.resolve(); secondRendered(); });
    expect(visible()).toEqual([]);
    mounted.factory.creations[2].labels = [label('new-only', 7.75, 8.875)];
    await act(async () => { mounted.factory.creations[2].settle(); });
    mounted.frame([label('new-only', 7.75, 8.875)]);
    act(() => { secondRendered(); });
    expect(visible().map(({ id, transform }) => ({ id, transform }))).toEqual([{ id: 'new-only', transform: 'translate(7.75px, 8.875px)' }]);
  });
});
