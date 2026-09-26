// T09 canvas lifecycle owner: asset/dispose tokens around async facade init,
// DPR-aware viewport + canvas-local pointer routing, dirty-flag render
// scheduling, and idempotent disposal. Geometry math lives in Rust
// (geometry::viewport); this class only forwards browser facts.
import { createEditorFacadeFactory, DEFAULT_WASM_BRIDGE_URL, toApiError } from './loader';
import type {
  AnnotationDocument,
  ApiError,
  BinaryTransfer,
  EditorAssetRequest,
  EditorCommand,
  EditorDelta,
  EditorFacade,
  EditorFacadeFactory,
  EditorHostOptions,
  EditorHostStatus,
  EditorTool,
  Id,
  PointerInput,
  PointerPhase,
  RenderScheduler,
  SuggestionSet,
  Viewport,
} from './types';

const CANVAS_POINTER_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const;

type CanvasPointerEvent = (typeof CANVAS_POINTER_EVENTS)[number];

function defaultScheduler(): RenderScheduler {
  return {
    request: (callback) => window.requestAnimationFrame(callback),
    cancel: (handle) => window.cancelAnimationFrame(handle),
  };
}

function defaultRequestId(): Id {
  return globalThis.crypto?.randomUUID?.() ?? `editor-host-${Date.now()}`;
}

interface CanvasSize {
  width: number;
  height: number;
  dpr: number;
}

export class EditorHost {
  private readonly facadeFactory: EditorHostOptions['facadeFactory'];
  private readonly scheduler: RenderScheduler;
  private readonly nextRequestId: () => Id;
  private readonly onDelta: EditorHostOptions['onDelta'];
  private canvas: HTMLCanvasElement | null = null;
  private facade: EditorFacade | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private size: CanvasSize | null = null;
  private statusValue: EditorHostStatus = 'idle';
  private errorValue: ApiError | null = null;
  private transfersValue: BinaryTransfer[] = [];
  private dirty = false;
  private paused = true;
  private framePending = false;
  private frameHandle: number | null = null;
  private disposed = false;
  /** Identity of the asset the host currently initializes or mounted. */
  private assetToken = 0;
  /** Invalidated on dispose; in-flight creations compare it before mounting. */
  private disposeToken = 0;

  constructor(options: Partial<EditorHostOptions> = {}) {
    this.facadeFactory = options.facadeFactory ?? createEditorFacadeFactory(DEFAULT_WASM_BRIDGE_URL);
    this.scheduler = options.scheduler ?? defaultScheduler();
    this.nextRequestId = options.nextRequestId ?? defaultRequestId;
    this.onDelta = options.onDelta ?? null;
  }

  get status(): EditorHostStatus {
    return this.statusValue;
  }

  get error(): ApiError | null {
    return this.errorValue;
  }

  /** Measured binary RGBA transfers performed for mounted assets. */
  get transfers(): readonly BinaryTransfer[] {
    return this.transfersValue;
  }

  mount(canvas: HTMLCanvasElement): void {
    if (this.canvas !== null || this.disposed) return;
    this.canvas = canvas;
    for (const type of CANVAS_POINTER_EVENTS) canvas.addEventListener(type, this.pointerListeners[type]);
    window.addEventListener('resize', this.handleResize);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.handleResize);
      this.resizeObserver.observe(canvas);
    }
    this.handleResize();
  }

  /**
   * Asynchronously creates and mounts the editor for one asset. The asset and
   * dispose tokens are checked before and after every async step: a stale
   * creation that resolves after a newer asset (or after dispose) is destroyed
   * and never mounted onto the canvas.
   */
  async loadAsset(request: EditorAssetRequest): Promise<void> {
    const assetToken = this.assetToken + 1;
    this.assetToken = assetToken;
    const disposeToken = this.disposeToken;
    if (this.disposed) return;
    const canvas = this.canvas;
    if (canvas === null) {
      this.errorValue = { code: 'EDITOR_NOT_MOUNTED', message: 'mount a canvas before loading an asset', request_id: this.nextRequestId(), details: null };
      this.statusValue = 'error';
      throw this.errorValue;
    }
    this.statusValue = 'loading';
    this.errorValue = null;
    this.releaseFacade();
    let created;
    try {
      created = await this.facadeFactory.create(canvas, request);
    } catch (reason) {
      if (this.stale(assetToken, disposeToken)) return;
      this.errorValue = toApiError(reason, 'EDITOR_INIT_FAILED', this.nextRequestId);
      this.statusValue = 'error';
      throw this.errorValue;
    }
    if (this.stale(assetToken, disposeToken)) {
      created.facade.dispose();
      return;
    }
    this.facade = created.facade;
    this.transfersValue = [...this.transfersValue, created.transfer];
    this.statusValue = 'ready';
    this.applyViewport();
    if (this.size !== null && !this.paused) {
      this.guard(() => created.facade.fit_image(), 'EDITOR_FIT_FAILED');
    }
    this.markDirty();
  }

  dispatch(command: EditorCommand): EditorDelta | null {
    const delta = this.guard((facade) => facade.dispatch(command), 'EDITOR_BRIDGE_FAILURE');
    return this.consumeDelta(delta);
  }

  setTool(tool: EditorTool): void {
    this.guard((facade) => {
      facade.set_tool(tool);
      return null;
    }, 'EDITOR_BRIDGE_FAILURE');
  }

  setActiveLabel(labelId: Id): void {
    this.guard((facade) => {
      facade.set_active_label(labelId);
      return null;
    }, 'EDITOR_BRIDGE_FAILURE');
  }

  select(ids: Id[]): EditorDelta | null {
    return this.consumeDelta(this.guard((facade) => facade.set_selection(ids), 'EDITOR_BRIDGE_FAILURE'));
  }

  setLocalFlags(ids: Id[], flags: { hidden?: boolean; locked?: boolean }): EditorDelta | null {
    return this.consumeDelta(this.guard((facade) => facade.set_local_flags(ids, flags), 'EDITOR_BRIDGE_FAILURE'));
  }

  zoomAt(xCss: number, yCss: number, factor: number): void {
    this.guard((facade) => {
      facade.zoom_at(xCss, yCss, factor);
      return null;
    }, 'EDITOR_BRIDGE_FAILURE');
    this.markDirty();
  }

  fitImage(): void {
    this.guard((facade) => {
      facade.fit_image();
      return null;
    }, 'EDITOR_BRIDGE_FAILURE');
    this.markDirty();
  }

  setPredictions(sets: SuggestionSet[]): void {
    this.guard((facade) => {
      facade.set_predictions(sets);
      return null;
    }, 'EDITOR_BRIDGE_FAILURE');
  }

  getSnapshot(): AnnotationDocument | null {
    return this.guard((facade) => facade.get_snapshot(), 'EDITOR_BRIDGE_FAILURE');
  }

  getGeneration(): number | null {
    return this.guard((facade) => facade.get_generation(), 'EDITOR_BRIDGE_FAILURE');
  }

  /** Idempotent teardown: listeners, pending frames, and the GPU device. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeToken += 1;
    this.assetToken += 1;
    const canvas = this.canvas;
    if (canvas !== null) {
      for (const type of CANVAS_POINTER_EVENTS) canvas.removeEventListener(type, this.pointerListeners[type]);
      window.removeEventListener('resize', this.handleResize);
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.frameHandle !== null) {
      this.scheduler.cancel(this.frameHandle);
      this.frameHandle = null;
    }
    this.framePending = false;
    this.releaseFacade();
    this.canvas = null;
    this.statusValue = 'disposed';
  }

  private stale(assetToken: number, disposeToken: number): boolean {
    return this.disposed || disposeToken !== this.disposeToken || assetToken !== this.assetToken;
  }

  private releaseFacade(): void {
    const facade = this.facade;
    this.facade = null;
    facade?.dispose();
  }

  private guard<T>(action: (facade: EditorFacade) => T, fallbackCode: string): T | null {
    const facade = this.facade;
    if (facade === null) return null;
    try {
      return action(facade);
    } catch (reason) {
      this.errorValue = toApiError(reason, fallbackCode, this.nextRequestId);
      return null;
    }
  }

  private consumeDelta(delta: EditorDelta | null): EditorDelta | null {
    if (delta === null) return null;
    if (delta.error !== null) this.errorValue = delta.error;
    if (delta.repaint) this.markDirty();
    this.onDelta?.(delta);
    return delta;
  }

  private applyViewport(): void {
    const size = this.size;
    if (size === null) return;
    // Read-back and apply inside the same guard: a get_viewport failure is
    // normalized to a structured ApiError exactly like set_viewport's.
    this.guard((current) => {
      const view: Viewport = {
        ...current.get_viewport(),
        css_width: size.width,
        css_height: size.height,
        dpr: size.dpr,
      };
      current.set_viewport(view);
      return null;
    }, 'EDITOR_VIEWPORT_FAILED');
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.framePending || this.paused || this.disposed) return;
    this.framePending = true;
    this.frameHandle = this.scheduler.request(this.handleFrame);
  }

  private handleFrame = (timestampMs: number): void => {
    this.framePending = false;
    this.frameHandle = null;
    if (this.disposed || this.paused || !this.dirty) return;
    this.dirty = false;
    this.guard((facade) => {
      facade.render(timestampMs);
      return null;
    }, 'RENDER_FAILED');
  };

  private handleResize = (): void => {
    const canvas = this.canvas;
    if (canvas === null || this.disposed) return;
    const rect = canvas.getBoundingClientRect();
    const size: CanvasSize = { width: rect.width, height: rect.height, dpr: window.devicePixelRatio || 1 };
    const previous = this.size;
    if (previous !== null && previous.width === size.width && previous.height === size.height && previous.dpr === size.dpr) return;
    this.size = size;
    // 0x0 pauses rendering entirely: no render frame is requested and the
    // renderer backing store stays unallocated (asserted live in the e2e).
    this.paused = size.width === 0 || size.height === 0;
    if (this.facade !== null) this.applyViewport();
    this.markDirty();
  };

  private readonly pointerListeners: Record<CanvasPointerEvent, (event: PointerEvent) => void> = {
    pointerdown: (event) => this.handlePointer(event, 'down'),
    pointermove: (event) => this.handlePointer(event, 'move'),
    pointerup: (event) => this.handlePointer(event, 'up'),
    pointercancel: (event) => this.handlePointer(event, 'cancel'),
  };

  private handlePointer(event: PointerEvent, phase: PointerPhase): void {
    const canvas = this.canvas;
    if (canvas === null || this.disposed) return;
    // Pointer coordinates become canvas-local CSS pixels here; DPR never
    // multiplies into them (docs/architecture.md view formula).
    const rect = canvas.getBoundingClientRect();
    const input: PointerInput = {
      phase,
      pointer_id: event.pointerId,
      x_css: event.clientX - rect.left,
      y_css: event.clientY - rect.top,
      button: event.button,
      buttons: event.buttons,
      shift: event.shiftKey,
      ctrl: event.ctrlKey,
      alt: event.altKey,
      meta: event.metaKey,
    };
    this.consumeDelta(this.guard((facade) => facade.pointer(input), 'EDITOR_BRIDGE_FAILURE'));
  }
}
