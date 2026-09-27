// T09 canvas lifecycle suite. Each test drives real EditorHost/loader/CanvasView
// code through their declared seams (EditorFacadeFactory, RenderScheduler,
// EditorWasmBridge); the seams have precise types in ./types.ts and stand in for
// the WASM/GPU boundary that jsdom cannot provide. Real WebGPU + real wasm glue
// verification lives in tests/e2e/t09_canvas.spec.ts.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanvasView } from '../../features/workbench/CanvasView';
import { EditorHost } from './EditorHost';
import { createEditorFacadeFactory, decodeCanonicalFrame, toApiError } from './loader';
import type {
  AnnotationDocument,
  ApiError,
  BinaryTransfer,
  CanonicalFrame,
  CreatedEditor,
  EditorAssetRequest,
  EditorCommand,
  EditorDelta,
  EditorFacade,
  EditorFacadeFactory,
  EditorHostOptions,
  EditorTool,
  EditorWasmBridge,
  Id,
  MediaRevision,
  OntologyVersion,
  PointerInput,
  RenderScheduler,
  SuggestionSet,
  Viewport,
} from './types';

// ---------------------------------------------------------------------------
// Fixtures (golden values per docs/testing-contracts.md section 2).
// ---------------------------------------------------------------------------

function makeMedia(): MediaRevision {
  return {
    asset_id: 'asset-1', asset_revision_id: 'asset-rev-1', project_id: 'sample-project',
    original_name: 'scene.jpg', original_sha256: 'a'.repeat(64), canonical_sha256: 'b'.repeat(64),
    canonical_width: 640, canonical_height: 480, exif_orientation: 1,
    original_to_canonical: [1, 0, 0, 0, 1, 0, 0, 0, 1], source_group_id: 'source-1',
  };
}

function makeOntology(): OntologyVersion {
  return {
    ontology_version_id: 'fixture-ontology-v1', project_id: 'sample-project', version_no: 1,
    labels: [{
      label_id: 'label_person', name: 'person', color: '#2878d0', shortcut: null,
      allowed_geometry_types: ['bbox_xyxy'], attributes: [
        { key: 'helmet_state', kind: 'enum', required: true, default_value: 'unknown', enum_values: ['wearing', 'not_wearing', 'unknown'], min: null, max: null },
      ],
    }], guidelines_markdown: 'Development fixture only.', allow_out_of_bounds: false,
  };
}

function makeDocument(): AnnotationDocument {
  return {
    schema_version: 1, asset_revision_id: 'asset-rev-1',
    ontology_version_id: 'fixture-ontology-v1',
    coordinate_space: { type: 'canonical_image_pixels', width: 640, height: 480 },
    completion: 'unprocessed', objects: [{
      object_id: 'object_person_001', label_id: 'label_person',
      geometry: { type: 'bbox_xyxy', x_min: 10, y_min: 20, x_max: 110, y_max: 220 },
      attributes: { helmet_state: 'unknown' },
      origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null },
    }],
  };
}

function makeFrame(width = 4, height = 2): CanonicalFrame {
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < rgba.length; index += 1) rgba[index] = index % 251;
  return { width, height, rgba };
}

function makeRequest(overrides: Partial<EditorAssetRequest> = {}): EditorAssetRequest {
  return { media: makeMedia(), ontology: makeOntology(), document: makeDocument(), frame: makeFrame(), ...overrides };
}

function makeDelta(overrides: Partial<EditorDelta> = {}): EditorDelta {
  return {
    generation: 0, changed_objects: [], removed_object_ids: [], selected_object_ids: [],
    can_undo: false, can_redo: false, document_changed: false, repaint: false,
    suggestion_decisions: [], error: null, ...overrides,
  };
}

function makeApiError(overrides: Partial<ApiError> = {}): ApiError {
  return { code: 'OBJECT_NOT_FOUND', message: 'selection contains an unknown object', request_id: 'req-fixture', details: null, ...overrides };
}

// ---------------------------------------------------------------------------
// Test doubles for the WASM/GPU boundary (precise types, no pass-through mocks:
// they record real call traffic and emulate the wasm-bindgen copyBytes glue).
// ---------------------------------------------------------------------------

class FakeEditorFacade implements EditorFacade {
  readonly dispatchCalls: EditorCommand[] = [];
  readonly pointerCalls: PointerInput[] = [];
  readonly toolCalls: EditorTool[] = [];
  readonly labelCalls: Id[] = [];
  readonly viewportCalls: Viewport[] = [];
  readonly zoomCalls: [number, number, number][] = [];
  readonly fitCalls: number[] = [];
  readonly selectionCalls: Id[][] = [];
  readonly flagCalls: [Id[], { hidden?: boolean; locked?: boolean }][] = [];
  readonly snapshotCalls: number[] = [];
  readonly generationCalls: number[] = [];
  readonly predictionCalls: SuggestionSet[][] = [];
  readonly renderCalls: number[] = [];
  disposeCount = 0;
  viewport: Viewport = { scale: 1, tx: 0, ty: 0, css_width: 0, css_height: 0, dpr: 1 };
  deltaFactory: (kind: string) => EditorDelta = () => makeDelta({ repaint: true });
  throwOn: { dispatch?: unknown } = {};

  dispatch(command: EditorCommand): EditorDelta {
    this.dispatchCalls.push(command);
    if (this.throwOn.dispatch !== undefined) throw this.throwOn.dispatch;
    return this.deltaFactory('dispatch');
  }
  pointer(input: PointerInput): EditorDelta {
    this.pointerCalls.push(input);
    return this.deltaFactory('pointer');
  }
  set_tool(tool: EditorTool): void { this.toolCalls.push(tool); }
  set_active_label(label_id: Id): void { this.labelCalls.push(label_id); }
  set_viewport(view: Viewport): void { this.viewportCalls.push(view); this.viewport = view; }
  zoom_at(x_css: number, y_css: number, factor: number): void { this.zoomCalls.push([x_css, y_css, factor]); }
  fit_image(): void { this.fitCalls.push(0); }
  set_selection(ids: Id[]): EditorDelta { this.selectionCalls.push(ids); return this.deltaFactory('selection'); }
  set_local_flags(ids: Id[], flags: { hidden?: boolean; locked?: boolean }): EditorDelta { this.flagCalls.push([ids, flags]); return this.deltaFactory('flags'); }
  get_snapshot(): AnnotationDocument { this.snapshotCalls.push(0); return makeDocument(); }
  get_generation(): number { this.generationCalls.push(0); return 0; }
  get_viewport(): Viewport { return this.viewport; }
  set_predictions(sets: SuggestionSet[]): void { this.predictionCalls.push(sets); }
  render(timestamp_ms: number): void { this.renderCalls.push(timestamp_ms); }
  dispose(): void { this.disposeCount += 1; }
}

interface FakeCreation {
  canvas: HTMLCanvasElement;
  request: EditorAssetRequest;
  facade: FakeEditorFacade;
  settle: (transfer?: BinaryTransfer) => void;
  fail: (reason: unknown) => void;
}

class FakeFacadeFactory implements EditorFacadeFactory {
  readonly creations: FakeCreation[] = [];
  create(canvas: HTMLCanvasElement, request: EditorAssetRequest): Promise<CreatedEditor> {
    const facade = new FakeEditorFacade();
    return new Promise<CreatedEditor>((resolve, reject) => {
      this.creations.push({
        canvas,
        request,
        facade,
        settle: (transfer) => resolve({
          facade,
          transfer: transfer ?? {
            method: 'copyBytes',
            byteLength: request.frame.rgba.byteLength,
            durationMs: 0,
          },
        }),
        fail: reject,
      });
    });
  }
}

class FakeRenderScheduler implements RenderScheduler {
  readonly pending = new Map<number, (timestamp_ms: number) => void>();
  cancelled: number[] = [];
  private nextHandle = 1;
  request(callback: (timestamp_ms: number) => void): number {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.pending.set(handle, callback);
    return handle;
  }
  cancel(handle: number): void {
    this.cancelled.push(handle);
    this.pending.delete(handle);
  }
  /** Runs every frame that was requested before this call; returns how many ran. */
  flush(timestamp_ms = 1000): number {
    const callbacks = [...this.pending.entries()];
    this.pending.clear();
    for (const [, callback] of callbacks) callback(timestamp_ms);
    return callbacks.length;
  }
}

interface ObservedResize {
  trigger(target: Element): void;
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed: Element[] = [];
  disconnected = false;
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element): void { this.observed.push(target); }
  unobserve(target: Element): void {
    const index = this.observed.indexOf(target);
    if (index >= 0) this.observed.splice(index, 1);
  }
  disconnect(): void { this.disconnected = true; this.observed.length = 0; }
  trigger(target: Element): void {
    this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

/** Models the real wasm-bindgen glue copyBytes (passArray8ToWasm0: one
 *  `memoryView.set(arg)` into wasm linear memory) over a real WebAssembly.Memory. */
class TestWasmMemoryBridge implements EditorWasmBridge {
  readonly memory = new WebAssembly.Memory({ initial: 1 });
  readonly writes: { ptr: number; byteLength: number }[] = [];
  readonly received: Uint8Array[] = [];
  readonly facades: FakeEditorFacade[] = [];
  private nextPtr = 8;
  async create_editor(
    canvas: HTMLCanvasElement,
    _media: MediaRevision,
    _ontology: OntologyVersion,
    _document: AnnotationDocument,
    canonical_rgba: Uint8Array,
  ): Promise<EditorFacade> {
    void canvas;
    const byteLength = canonical_rgba.byteLength;
    const ptr = this.nextPtr;
    this.nextPtr += byteLength;
    const requiredPages = Math.ceil(this.nextPtr / 65_536);
    const heldPages = this.memory.buffer.byteLength / 65_536;
    if (requiredPages > heldPages) this.memory.grow(requiredPages - heldPages);
    new Uint8Array(this.memory.buffer, ptr, byteLength).set(canonical_rgba);
    this.writes.push({ ptr, byteLength });
    this.received.push(canonical_rgba);
    const facade = new FakeEditorFacade();
    this.facades.push(facade);
    return facade;
  }
}

// ---------------------------------------------------------------------------
// Environment seams (browser APIs jsdom does not implement).
// ---------------------------------------------------------------------------

const realRaf = globalThis.requestAnimationFrame;
const realCaf = globalThis.cancelAnimationFrame;

function stubCanvasRect(canvas: HTMLElement, rect: Partial<DOMRect>): void {
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
    toJSON: () => ({}),
    ...rect,
  } as DOMRect);
}

function stubDevicePixelRatio(value: number): void {
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  FakeResizeObserver.instances = [];
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
  delete (window as { devicePixelRatio?: unknown }).devicePixelRatio;
  if (realRaf) globalThis.requestAnimationFrame = realRaf;
  if (realCaf) globalThis.cancelAnimationFrame = realCaf;
});

function makeHost(overrides: Partial<EditorHostOptions> = {}): {
  host: EditorHost; factory: FakeFacadeFactory; scheduler: FakeRenderScheduler; deltas: EditorDelta[];
} {
  const factory = overrides.facadeFactory instanceof FakeFacadeFactory ? overrides.facadeFactory : new FakeFacadeFactory();
  const scheduler = overrides.scheduler instanceof FakeRenderScheduler ? overrides.scheduler : new FakeRenderScheduler();
  const deltas: EditorDelta[] = [];
  const host = new EditorHost({
    facadeFactory: factory,
    scheduler,
    nextRequestId: () => 'req-test',
    onDelta: (delta) => { deltas.push(delta); },
    ...overrides,
  });
  return { host, factory, scheduler, deltas };
}

// ---------------------------------------------------------------------------
// Behavior 1: stale-asset async init race.
// ---------------------------------------------------------------------------

describe('T09 stale-asset async initialization', () => {
  it('destroys the stale async init that resolves after a newer asset and never mounts it', async () => {
    const { host, factory, scheduler } = makeHost();
    const canvas = document.createElement('canvas');
    stubCanvasRect(canvas, { width: 640, height: 480 });
    host.mount(canvas);

    const loadOld = host.loadAsset(makeRequest({ media: { ...makeMedia(), asset_revision_id: 'asset-rev-old' } }));
    const loadNew = host.loadAsset(makeRequest());

    await act(async () => { factory.creations[1].settle(); });
    await act(async () => { factory.creations[0].settle(); });
    await loadOld;
    await loadNew;

    const [stale, current] = factory.creations;
    expect(stale.facade.disposeCount).toBe(1);
    expect(stale.facade.viewportCalls).toHaveLength(0);
    expect(stale.facade.renderCalls).toHaveLength(0);
    expect(stale.facade.fitCalls).toHaveLength(0);
    expect(current.facade.disposeCount).toBe(0);
    expect(stale.canvas).toBe(canvas);
    expect(current.canvas).toBe(canvas);
    expect(scheduler.pending.size).toBe(1);
    expect(scheduler.flush()).toBe(1);
    expect(current.facade.renderCalls).toHaveLength(1);
    expect(stale.facade.renderCalls).toHaveLength(0);
    expect(host.status).toBe('ready');
  });

  it('destroys a pending facade when the host is disposed before its async init resolves', async () => {
    const { host, factory } = makeHost();
    const canvas = document.createElement('canvas');
    stubCanvasRect(canvas, { width: 640, height: 480 });
    host.mount(canvas);
    const load = host.loadAsset(makeRequest());

    host.dispose();
    await act(async () => { factory.creations[0].settle(); });
    await load;

    expect(factory.creations[0].facade.disposeCount).toBe(1);
    expect(factory.creations[0].facade.viewportCalls).toHaveLength(0);
    expect(factory.creations[0].facade.renderCalls).toHaveLength(0);
    expect(host.status).toBe('disposed');
  });
});

// ---------------------------------------------------------------------------
// Behavior 2: DPR / resize / CSS offset / 0x0 pause / unmount cleanup.
// ---------------------------------------------------------------------------

describe('T09 canvas sizing and cleanup', () => {
  it('passes canvas-local CSS pointer coordinates and a DPR-correct viewport without baking DPR into image coordinates', async () => {
    const { host, factory } = makeHost();
    const canvas = document.createElement('canvas');
    stubCanvasRect(canvas, { left: 50, top: 25, width: 640, height: 480 });
    stubDevicePixelRatio(2);
    host.mount(canvas);
    const load = host.loadAsset(makeRequest());
    await act(async () => { factory.creations[0].settle(); });
    await load;

    expect(factory.creations[0].facade.viewportCalls[0]).toEqual({
      scale: 1, tx: 0, ty: 0, css_width: 640, css_height: 480, dpr: 2,
    });

    fireEvent.pointerMove(canvas, { clientX: 150, clientY: 125, pointerId: 7, button: 0, buttons: 0, shiftKey: true });
    expect(factory.creations[0].facade.pointerCalls).toEqual([{
      phase: 'move', pointer_id: 7, x_css: 100, y_css: 100,
      button: 0, buttons: 0, shift: true, ctrl: false, alt: false, meta: false,
    }]);
  });

  it('updates the viewport exactly once per size change and renders exactly once', async () => {
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
    const { host, factory, scheduler } = makeHost();
    const canvas = document.createElement('canvas');
    stubCanvasRect(canvas, { width: 640, height: 480 });
    host.mount(canvas);
    const load = host.loadAsset(makeRequest());
    await act(async () => { factory.creations[0].settle(); });
    await load;
    scheduler.flush();
    const facade = factory.creations[0].facade;
    const viewportBefore = facade.viewportCalls.length;
    const rendersBefore = facade.renderCalls.length;

    stubCanvasRect(canvas, { width: 800, height: 480 });
    const observer = FakeResizeObserver.instances.at(-1) as ObservedResize;
    act(() => { observer.trigger(canvas); });
    expect(facade.viewportCalls.slice(viewportBefore)).toEqual([
      { scale: 1, tx: 0, ty: 0, css_width: 800, css_height: 480, dpr: 1 },
    ]);
    expect(scheduler.pending.size).toBe(1);
    expect(scheduler.flush()).toBe(1);
    expect(facade.renderCalls.length).toBe(rendersBefore + 1);

    // Spurious observer callbacks with an unchanged size are inert.
    act(() => { observer.trigger(canvas); });
    expect(facade.viewportCalls).toHaveLength(viewportBefore + 1);
    expect(scheduler.pending.size).toBe(0);
  });

  it('pauses rendering at 0x0 with no backing store and resumes when the canvas grows again', async () => {
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
    const { host, factory, scheduler } = makeHost();
    const canvas = document.createElement('canvas');
    stubCanvasRect(canvas, { width: 0, height: 0 });
    host.mount(canvas);
    const load = host.loadAsset(makeRequest());
    await act(async () => { factory.creations[0].settle(); });
    await load;
    const facade = factory.creations[0].facade;

    expect(facade.renderCalls).toHaveLength(0);
    expect(facade.fitCalls).toHaveLength(0);
    expect(scheduler.pending.size).toBe(0);
    scheduler.flush();
    expect(facade.renderCalls).toHaveLength(0);

    stubCanvasRect(canvas, { width: 640, height: 480 });
    const observer = FakeResizeObserver.instances.at(-1) as ObservedResize;
    act(() => { observer.trigger(canvas); });
    expect(scheduler.flush()).toBe(1);
    expect(facade.renderCalls).toHaveLength(1);
  });

  it('unmount removes listeners, cancels pending frames and disposes the device exactly once', async () => {
    const { host, factory, scheduler } = makeHost();
    const canvas = document.createElement('canvas');
    stubCanvasRect(canvas, { width: 640, height: 480 });
    const canvasAdds: string[] = [];
    const canvasRemoves: string[] = [];
    const windowAdds: string[] = [];
    const windowRemoves: string[] = [];
    const realCanvasAdd = canvas.addEventListener.bind(canvas);
    const realCanvasRemove = canvas.removeEventListener.bind(canvas);
    const realWindowAdd = window.addEventListener.bind(window);
    const realWindowRemove = window.removeEventListener.bind(window);
    vi.spyOn(canvas, 'addEventListener').mockImplementation((type: string, ...rest: [EventListenerOrEventListenerObject?, ...unknown[]]) => {
      canvasAdds.push(type);
      return realCanvasAdd(type, ...(rest as [EventListenerOrEventListenerObject]));
    });
    vi.spyOn(canvas, 'removeEventListener').mockImplementation((type: string, ...rest: [EventListenerOrEventListenerObject?, ...unknown[]]) => {
      canvasRemoves.push(type);
      return realCanvasRemove(type, ...(rest as [EventListenerOrEventListenerObject]));
    });
    vi.spyOn(window, 'addEventListener').mockImplementation((type: string, ...rest: [EventListenerOrEventListenerObject?, ...unknown[]]) => {
      windowAdds.push(type);
      return realWindowAdd(type, ...(rest as [EventListenerOrEventListenerObject]));
    });
    vi.spyOn(window, 'removeEventListener').mockImplementation((type: string, ...rest: [EventListenerOrEventListenerObject?, ...unknown[]]) => {
      windowRemoves.push(type);
      return realWindowRemove(type, ...(rest as [EventListenerOrEventListenerObject]));
    });

    host.mount(canvas);
    const load = host.loadAsset(makeRequest());
    await act(async () => { factory.creations[0].settle(); });
    await load;

    fireEvent.pointerMove(canvas, { clientX: 10, clientY: 10, pointerId: 1, button: 0, buttons: 0 });
    const facade = factory.creations[0].facade;
    expect(facade.pointerCalls).toHaveLength(1);
    expect(scheduler.pending.size).toBe(1);

    host.dispose();
    host.dispose();

    expect(scheduler.cancelled.length).toBeGreaterThanOrEqual(1);
    expect(scheduler.pending.size).toBe(0);
    expect(facade.disposeCount).toBe(1);
    for (const type of canvasAdds) expect(canvasRemoves.filter((t) => t === type).length).toBeGreaterThanOrEqual(1);
    for (const type of windowAdds) expect(windowRemoves.filter((t) => t === type).length).toBeGreaterThanOrEqual(1);
    expect(canvasAdds.length).toBe(canvasRemoves.length);
    expect(windowAdds.length).toBe(windowRemoves.length);

    fireEvent.pointerMove(canvas, { clientX: 10, clientY: 10, pointerId: 1, button: 0, buttons: 0 });
    expect(facade.pointerCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Behavior 3: one pointermove round passes input/small deltas only.
// ---------------------------------------------------------------------------

describe('T09 pointer streaming', () => {
  it('forwards one input per pointermove and never snapshots or serializes the document', async () => {
    const { host, factory, deltas } = makeHost();
    const canvas = document.createElement('canvas');
    stubCanvasRect(canvas, { left: 0, top: 0, width: 640, height: 480 });
    host.mount(canvas);
    const load = host.loadAsset(makeRequest());
    await act(async () => { factory.creations[0].settle(); });
    await load;
    const facade = factory.creations[0].facade;
    const returned: EditorDelta[] = [];

    for (let index = 0; index < 5; index += 1) {
      facade.deltaFactory = () => {
        const delta = makeDelta({ repaint: true, generation: index });
        returned.push(delta);
        return delta;
      };
      fireEvent.pointerMove(canvas, { clientX: 100 + index, clientY: 50, pointerId: 3, button: 0, buttons: 1 });
    }

    expect(facade.pointerCalls).toHaveLength(5);
    expect(facade.snapshotCalls).toHaveLength(0);
    expect(facade.generationCalls).toHaveLength(0);
    for (const [index, input] of facade.pointerCalls.entries()) {
      expect(input).toEqual({
        phase: 'move', pointer_id: 3, x_css: 100 + index, y_css: 50,
        button: 0, buttons: 1, shift: false, ctrl: false, alt: false, meta: false,
      });
      // Small-delta boundary: the payload is the C3 PointerInput, nothing more.
      expect(JSON.stringify(input).length).toBeLessThan(200);
    }
    // The returned deltas are consumed as projections, not re-fetched.
    expect(deltas.slice(-5)).toEqual(returned);
    expect(facade.dispatchCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Behavior 4: React StrictMode double mount.
// ---------------------------------------------------------------------------

describe('T09 StrictMode double mounting', () => {
  it('keeps one listener set and one submit per pointer round under StrictMode', async () => {
    const factory = new FakeFacadeFactory();
    const scheduler = new FakeRenderScheduler();
    const canvasAdds: string[] = [];
    const canvasRemoves: string[] = [];
    const proto = HTMLCanvasElement.prototype;
    const spyAdd = vi.spyOn(proto, 'addEventListener').mockImplementation(function (this: HTMLCanvasElement, type: string, ...rest: [EventListenerOrEventListenerObject?, ...unknown[]]) {
      canvasAdds.push(type);
      return EventTarget.prototype.addEventListener.call(this, type, ...(rest as [EventListenerOrEventListenerObject]));
    });
    const spyRemove = vi.spyOn(proto, 'removeEventListener').mockImplementation(function (this: HTMLCanvasElement, type: string, ...rest: [EventListenerOrEventListenerObject?, ...unknown[]]) {
      canvasRemoves.push(type);
      return EventTarget.prototype.removeEventListener.call(this, type, ...(rest as [EventListenerOrEventListenerObject]));
    });
    void spyAdd; void spyRemove;

    render(
      createElement(
        StrictMode,
        null,
        createElement(CanvasView, {
          request: makeRequest(),
          hostOptions: { facadeFactory: factory, scheduler },
          activeTool: 'select',
          onDelta: () => {},
          onHostReady: () => {},
        }),
      ),
    );
    const canvas = screen.getByTestId('annotation-canvas');
    await act(async () => {
      await Promise.resolve();
      for (const creation of factory.creations) creation.settle();
    });

    expect(factory.creations).toHaveLength(1);
    const active = factory.creations.filter(({ facade }) => facade.disposeCount === 0);
    expect(active).toHaveLength(1);
    for (const { facade } of factory.creations) {
      if (facade !== active[0].facade) expect(facade.disposeCount).toBeGreaterThanOrEqual(1);
    }

    fireEvent.pointerMove(canvas, { clientX: 20, clientY: 30, pointerId: 1, button: 0, buttons: 0 });
    const submits = factory.creations.reduce((sum, { facade }) => sum + facade.pointerCalls.length, 0);
    expect(submits).toBe(1);
    expect(active[0].facade.pointerCalls).toHaveLength(1);

    const livePointerListeners = canvasAdds.filter((type) => type === 'pointermove').length
      - canvasRemoves.filter((type) => type === 'pointermove').length;
    expect(livePointerListeners).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Behavior 5: canonical decode path + measured binary copyBytes.
// ---------------------------------------------------------------------------

describe('T09 canonical decode and binary transfer', () => {
  it('decodes canonical pixels with imageOrientation none so EXIF is never applied twice', async () => {
    const pixels = new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255, 13, 14, 15, 255, 16, 17, 18, 255, 19, 20, 21, 255, 22, 23, 24, 255]);
    let capturedOptions: unknown;
    vi.stubGlobal('createImageBitmap', async (_source: Blob, options?: unknown) => {
      capturedOptions = options;
      return { width: 4, height: 2, close: () => undefined };
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      return {
        drawImage: () => undefined,
        getImageData: () => ({ data: pixels }),
      } as unknown as CanvasRenderingContext2D;
    });

    const frame = await decodeCanonicalFrame(new Blob([new Uint8Array([1])]), { width: 4, height: 2 });

    // The canonical pipeline already applied EXIF orientation; the browser must
    // decode the stored pixels as-is ('from-image' would rotate them again).
    expect(capturedOptions).toEqual({ imageOrientation: 'none' });
    expect(frame.width).toBe(4);
    expect(frame.height).toBe(2);
    expect(frame.rgba).toBeInstanceOf(Uint8Array);
    expect(Array.from(frame.rgba)).toEqual(Array.from(pixels));
    expect(frame.rgba.byteLength).toBe(4 * 2 * 4);
  });

  it('rejects a decode whose pixel dimensions do not match the canonical media revision', async () => {
    vi.stubGlobal('createImageBitmap', async () => ({ width: 4, height: 2, close: () => undefined }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      drawImage: () => undefined,
      getImageData: () => ({ data: new Uint8ClampedArray(32) }),
    }) as unknown as CanvasRenderingContext2D);

    await expect(decodeCanonicalFrame(new Blob([new Uint8Array([1])]), { width: 8, height: 4 }))
      .rejects.toMatchObject({ code: 'CANONICAL_DECODE_MISMATCH', message: expect.any(String), request_id: expect.any(String) });
  });

  it('hands the decoded RGBA to the WASM facade through a measured single copyBytes into wasm memory', async () => {
    const bridge = new TestWasmMemoryBridge();
    const factory = createEditorFacadeFactory(bridge);
    const { host } = makeHost({ facadeFactory: factory });
    const canvas = document.createElement('canvas');
    stubCanvasRect(canvas, { width: 640, height: 480 });
    const request = makeRequest({ frame: makeFrame(640, 480) });
    host.mount(canvas);
    await act(async () => { await host.loadAsset(request); });

    expect(bridge.received).toHaveLength(1);
    const handedOver = bridge.received[0];
    // Binary interface: the exact decoded Uint8Array crosses the boundary; the
    // loader adds no copy, no base64 and no JSON serialization.
    expect(handedOver).toBe(request.frame.rgba);
    expect(handedOver).toBeInstanceOf(Uint8Array);
    expect(bridge.writes).toHaveLength(1);
    const write = bridge.writes[0];
    expect(write.byteLength).toBe(640 * 480 * 4);
    const landed = new Uint8Array(bridge.memory.buffer, write.ptr, write.byteLength);
    expect(landed.slice(0, 64)).toEqual(request.frame.rgba.slice(0, 64));
    expect(landed.slice(-64)).toEqual(request.frame.rgba.slice(-64));

    expect(host.transfers).toHaveLength(1);
    const transfer = host.transfers[0];
    expect(transfer.method).toBe('copyBytes');
    expect(transfer.byteLength).toBe(640 * 480 * 4);
    expect(Number.isFinite(transfer.durationMs)).toBe(true);
    expect(transfer.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Behavior 6: Rust domain errors surface as structured ApiError; no panics.
// ---------------------------------------------------------------------------

describe('T09 structured error surfaces', () => {
  it('keeps structured ApiError from Rust deltas visible without crashing the page', async () => {
    const { host, factory, deltas } = makeHost();
    const canvas = document.createElement('canvas');
    stubCanvasRect(canvas, { width: 640, height: 480 });
    host.mount(canvas);
    const load = host.loadAsset(makeRequest());
    await act(async () => { factory.creations[0].settle(); });
    await load;
    const facade = factory.creations[0].facade;
    const error = makeApiError({ code: 'ACTIVE_LABEL_REQUIRED' });
    facade.deltaFactory = () => makeDelta({ error, generation: 0 });

    const delta = host.dispatch({ kind: 'undo' });
    expect(delta?.error).toEqual(error);
    expect(deltas.at(-1)?.error).toEqual(error);
    expect(host.error).toEqual(error);
    expect(host.status).toBe('ready');

    // The page keeps serving input after the domain error.
    fireEvent.pointerMove(canvas, { clientX: 5, clientY: 5, pointerId: 1, button: 0, buttons: 0 });
    expect(facade.pointerCalls).toHaveLength(1);
  });

  it('normalizes thrown wasm failures to structured ApiError and keeps serving input', async () => {
    const { host, factory } = makeHost();
    const canvas = document.createElement('canvas');
    stubCanvasRect(canvas, { width: 640, height: 480 });
    host.mount(canvas);
    const load = host.loadAsset(makeRequest());
    await act(async () => { factory.creations[0].settle(); });
    await load;
    const facade = factory.creations[0].facade;
    facade.throwOn.dispatch = 'wasm unreachable';

    expect(host.dispatch({ kind: 'undo' })).toBeNull();
    const normalized = host.error;
    expect(normalized).not.toBeNull();
    expect(normalized?.code).toBeTruthy();
    expect(normalized?.message).toContain('wasm unreachable');
    expect(normalized?.request_id).toBeTruthy();
    expect(host.status).toBe('ready');

    fireEvent.pointerMove(canvas, { clientX: 5, clientY: 5, pointerId: 1, button: 0, buttons: 0 });
    expect(facade.pointerCalls).toHaveLength(1);
    expect(toApiError('boom', 'X', () => 'req-2')).toEqual({
      code: 'X', message: 'boom', request_id: 'req-2', details: null,
    });
  });

  it('rejects a failed asset load with a structured ApiError and shows it instead of a blank canvas', async () => {
    const factory = new FakeFacadeFactory();
    const hostOptions: Partial<EditorHostOptions> = { facadeFactory: factory, scheduler: new FakeRenderScheduler() };
    render(createElement(CanvasView, {
      request: makeRequest(),
      hostOptions,
      activeTool: 'select',
      onDelta: () => {},
      onHostReady: () => {},
    }));
    await act(async () => {
      await Promise.resolve();
      factory.creations[0].fail('bridge exploded');
    });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('bridge exploded');
    expect(screen.getByTestId('annotation-canvas')).not.toBeNull();
    expect(factory.creations[0].facade.disposeCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Behavior 7: dirty-flag render scheduling; idle is GPU-quiet.
// ---------------------------------------------------------------------------

describe('T09 dirty-flag render scheduling', () => {
  it('renders on demand and stays quiet while idle', async () => {
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
    const { host, factory, scheduler } = makeHost();
    const canvas = document.createElement('canvas');
    stubCanvasRect(canvas, { width: 640, height: 480 });
    host.mount(canvas);
    const load = host.loadAsset(makeRequest());
    await act(async () => { factory.creations[0].settle(); });
    await load;
    scheduler.flush();
    const facade = factory.creations[0].facade;
    const settled = facade.renderCalls.length;
    expect(settled).toBeGreaterThan(0);

    // Idle: no events, repeated frame flushing, spurious same-size resize noise.
    scheduler.flush();
    scheduler.flush();
    const observer = FakeResizeObserver.instances.at(-1) as ObservedResize;
    act(() => { observer.trigger(canvas); });
    scheduler.flush();
    expect(facade.renderCalls).toHaveLength(settled);
    expect(scheduler.pending.size).toBe(0);
  });

  it('coalesces resize and selection triggers into one GPU submission per frame', async () => {
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
    const { host, factory, scheduler } = makeHost();
    const canvas = document.createElement('canvas');
    stubCanvasRect(canvas, { width: 640, height: 480 });
    host.mount(canvas);
    const load = host.loadAsset(makeRequest());
    await act(async () => { factory.creations[0].settle(); });
    await load;
    scheduler.flush();
    const facade = factory.creations[0].facade;
    const settled = facade.renderCalls.length;

    stubCanvasRect(canvas, { width: 700, height: 480 });
    const observer = FakeResizeObserver.instances.at(-1) as ObservedResize;
    act(() => {
      observer.trigger(canvas);
      host.select(['object_person_001']);
    });

    expect(scheduler.pending.size).toBe(1);
    expect(scheduler.flush()).toBe(1);
    expect(facade.renderCalls).toHaveLength(settled + 1);
    expect(facade.selectionCalls).toEqual([['object_person_001']]);
  });

  it('lets selection and resource load mark the frame dirty even without a resize', async () => {
    const { host, factory, scheduler } = makeHost();
    const canvas = document.createElement('canvas');
    stubCanvasRect(canvas, { width: 640, height: 480 });
    host.mount(canvas);
    const load = host.loadAsset(makeRequest());
    await act(async () => { factory.creations[0].settle(); });
    await load;
    scheduler.flush();
    const facade = factory.creations[0].facade;
    const settled = facade.renderCalls.length;

    act(() => { host.select(['object_person_001']); });
    expect(scheduler.pending.size).toBe(1);
    expect(scheduler.flush()).toBe(1);
    expect(facade.renderCalls.length).toBe(settled + 1);
    expect(scheduler.pending.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Card entry case.
// ---------------------------------------------------------------------------

it('disposing twice is safe before initialization', () => {
  const host = new EditorHost();
  expect(() => {
    host.dispose();
    host.dispose();
  }).not.toThrow();
});

// Keep the default rAF/cancelAnimationFrame restored for other suites.
afterEach(() => {
  if (realRaf) globalThis.requestAnimationFrame = realRaf;
  if (realCaf) globalThis.cancelAnimationFrame = realCaf;
});
