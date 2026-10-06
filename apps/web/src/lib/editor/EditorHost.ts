// T09 canvas lifecycle owner: asset/dispose tokens around async facade init,
// DPR-aware viewport + canvas-local pointer routing, dirty-flag render
// scheduling, and idempotent disposal. Geometry math lives in Rust
// (geometry::viewport); this class only forwards browser facts.
import { assertCanonicalBudget, bridgeStats, createEditorFacadeFactory, DEFAULT_WASM_BRIDGE_URL, toApiError } from './loader';
import type { CanvasLabel, RenderStats, LocalObjectFlagMap, LocalObjectFlags } from './types';
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

const EMPTY_LOCAL_FLAGS: LocalObjectFlagMap = Object.freeze(Object.create(null));
const DEFAULT_OBJECT_FLAGS: LocalObjectFlags = Object.freeze({ hidden: false, locked: false });
const CANVAS_POINTER_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const;

type CanvasPointerEvent = (typeof CANVAS_POINTER_EVENTS)[number];

/** Normalized wheel delta units (DOM `WheelEvent.deltaMode`). */
const WHEEL_PIXELS_PER_LINE = 16;
const WHEEL_PIXELS_PER_PAGE = 400;
/** Exponential scroll-zoom rate: factor = exp(-pixels * rate). */
const WHEEL_ZOOM_RATE = 0.002;

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
  private localFlagsValue: LocalObjectFlagMap = EMPTY_LOCAL_FLAGS;
  private transfersValue: BinaryTransfer[] = [];
  private dirty = false;
  private paused = true;
  private framePending = false;
  private frameHandle: number | null = null;
  private disposed = false;
  /** Identity of the asset the host currently initializes or mounted. */
  private assetToken = 0;
  private lossWatchToken = 0;
  private readonly renderedListeners = new Set<() => void>();
  private readonly statusListeners = new Set<() => void>();
  subscribeStatus(listener: () => void): () => void { this.statusListeners.add(listener); return () => { this.statusListeners.delete(listener); }; }
  private notifyStatus(): void { for (const listener of this.statusListeners) listener(); }
  private retiredStats: Partial<RenderStats> = {};
  subscribeRendered(listener: () => void): () => void { this.renderedListeners.add(listener); return () => { this.renderedListeners.delete(listener); }; }
  getCanvasLabels(): CanvasLabel[] { return this.facade?.get_canvas_labels?.() ?? []; }
  getAdapterDiagnostics(): string { return this.facade?.get_adapter_diagnostics?.() ?? ''; }
  getValidationInputObjects(): number { return this.facade?.get_validation_input_objects?.() ?? 0; }
  getSerializedInputObjects(): number { return this.facade?.get_serialized_input_objects?.() ?? 0; }
  getRenderStats(): RenderStats | null {
    const current = this.facade?.get_render_stats?.();
    if (!current) return null;
    const result = { ...current };
    for (const key of Object.keys(this.retiredStats) as (keyof RenderStats)[]) result[key] += this.retiredStats[key] ?? 0;
    return result;
  }
  getBridgeStats(): { calls: number; binary_bytes: number; elapsed_ms: number } { return { ...bridgeStats }; }

  /** Invalidated on dispose; in-flight creations compare it before mounting. */
  private disposeToken = 0;
  /** Pointer ids captured by this host so every capture pairs with a release. */
  private readonly capturedPointers = new Set<number>();
  /** The pointer that started (or may still start) the active gesture. */
  private activePointerId: number | null = null;

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
    canvas.addEventListener('contextmenu', this.handleContextMenu);
    canvas.addEventListener('wheel', this.handleWheel, { passive: false });
    window.addEventListener('resize', this.handleResize);
    window.addEventListener('blur', this.handleWindowBlur);
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
    assertCanonicalBudget(request.frame.width, request.frame.height);
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
    // Switching assets destroys any in-progress gesture and its captures (T12).
    this.releaseCaptures();
    this.activePointerId = null;
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
      created.facade.free?.();
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
    this.watchDeviceLoss(created.facade, assetToken, disposeToken);
    this.notifyStatus();
  }

  dispatch(command: EditorCommand): EditorDelta | null {
    const delta = this.guard((facade) => facade.dispatch(command), 'EDITOR_BRIDGE_FAILURE');
    return this.consumeDelta(delta);
  }

  setTool(tool: EditorTool): void {
    // A tool switch cancels any in-progress gesture (T12): the Rust core drops
    // it in set_tool and the web side releases the gesture's pointer captures.
    this.releaseCaptures();
    this.activePointerId = null;
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

  getLocalFlags(): LocalObjectFlagMap { return this.localFlagsValue; }

  setLocalFlags(ids: readonly Id[], flags: { hidden?: boolean; locked?: boolean }): EditorDelta | null {
    const delta = this.guard((facade) => facade.set_local_flags(ids, flags), 'EDITOR_BRIDGE_FAILURE');
    if (delta && delta.error === null) {
      let next: Record<Id, LocalObjectFlags> | null = null;
      for (const id of ids) {
        const previous = this.localFlagsValue[id] ?? DEFAULT_OBJECT_FLAGS;
        const hidden = flags.hidden ?? previous.hidden;
        const locked = flags.locked ?? previous.locked;
        if (hidden === previous.hidden && locked === previous.locked) continue;
        next ??= Object.assign(Object.create(null), this.localFlagsValue);
        if (!hidden && !locked) delete next![id];
        else next![id] = Object.freeze({ hidden, locked });
      }
      if (next) this.localFlagsValue = Object.freeze(next);
    }
    // Delta consumers see accepted transient state before deciding whether to serialize.
    return this.consumeDelta(delta);
  }

  pan(dx: number, dy: number): void {
    this.guard((facade) => { const view = facade.get_viewport(); facade.set_viewport({ ...view, tx: view.tx + dx, ty: view.ty + dy }); return null; }, 'EDITOR_BRIDGE_FAILURE');
    this.markDirty();
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
    }, 'EDITOR_BRIDGE_FAILURE', true);
  }

  getCommittedSnapshot(delta: EditorDelta): AnnotationDocument | null {
    return delta.document_changed || delta.suggestion_decisions.length > 0 ? this.getSnapshot() : null;
  }

  getSnapshot(): AnnotationDocument | null {
    return this.guard((facade) => facade.get_snapshot(), 'EDITOR_BRIDGE_FAILURE', true);
  }

  getGeneration(): number | null {
    return this.guard((facade) => facade.get_generation(), 'EDITOR_BRIDGE_FAILURE', true);
  }

  getObjectHashes(): Record<Id, string> | null {
    return this.guard((facade) => facade.get_object_hashes(), 'EDITOR_BRIDGE_FAILURE', true);
  }

  /** The Rust-owned view (the additive C3 read-back from reports/T09). */
  getViewport(): Viewport | null {
    return this.guard((facade) => facade.get_viewport(), 'EDITOR_BRIDGE_FAILURE', true);
  }

  /**
   * Cancels the in-progress gesture exactly like a pointer cancel (T12): Esc,
   * window blur, tool switch and asset switch all route here. Rust discards
   * the gesture without touching the document or the generation, and every
   * pointer capture taken for the gesture is released.
   */
  cancelGesture(): void {
    this.releaseCaptures();
    const pointerId = this.activePointerId;
    this.activePointerId = null;
    const input: PointerInput = {
      phase: 'cancel',
      pointer_id: pointerId ?? 0,
      x_css: 0,
      y_css: 0,
      button: 0,
      buttons: 0,
      shift: false,
      ctrl: false,
      alt: false,
      meta: false,
    };
    this.consumeDelta(this.guard((facade) => facade.pointer(input), 'EDITOR_BRIDGE_FAILURE'));
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
      canvas.removeEventListener('contextmenu', this.handleContextMenu);
      canvas.removeEventListener('wheel', this.handleWheel);
      window.removeEventListener('resize', this.handleResize);
      window.removeEventListener('blur', this.handleWindowBlur);
    }
    this.releaseCaptures();
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
  private currentFacade(facade: EditorFacade, assetToken: number, disposeToken: number): boolean {
    return !this.stale(assetToken, disposeToken) && this.facade === facade;
  }

  private watchDeviceLoss(facade: EditorFacade, assetToken: number, disposeToken: number): void {
    const watchToken = ++this.lossWatchToken;
    void facade.device_lost().then((message) => {
      if (watchToken !== this.lossWatchToken || !this.currentFacade(facade, assetToken, disposeToken) || this.statusValue === 'recovering') return;
      this.enterDeviceLost(message);
      return this.retryRenderer();
    }).catch((reason: unknown) => {
      if (watchToken !== this.lossWatchToken || !this.currentFacade(facade, assetToken, disposeToken)) return;
      this.enterDeviceLost(toApiError(reason, 'GPU_DEVICE_LOST', this.nextRequestId).message);
    });
  }

  private enterDeviceLost(message: string): void {
    this.statusValue = 'lost';
    this.errorValue = { code: 'GPU_DEVICE_LOST', message: `WebGPU device lost (${message}); CPU editor and unsaved work retained`, request_id: this.nextRequestId(), details: null };
    if (this.frameHandle !== null) this.scheduler.cancel(this.frameHandle);
    this.frameHandle = null;
    this.framePending = false;
    this.dirty = true;
    // Keep the native gesture/preview intact. Browser capture alone is retired.
    this.releaseCaptures();
    this.notifyStatus();
  }

  /** Explicit retry after a failed rebuild; never creates a new CPU editor. */
  async retryRenderer(): Promise<void> {
    const facade = this.facade;
    if (facade === null || this.disposed || this.statusValue !== 'lost') return;
    const assetToken = this.assetToken;
    const disposeToken = this.disposeToken;
    this.statusValue = 'recovering';
    this.notifyStatus();
    try {
      await facade.recover_renderer();
    } catch (reason) {
      if (!this.currentFacade(facade, assetToken, disposeToken)) return;
      this.errorValue = toApiError(reason, 'GPU_RECOVERY_FAILED', this.nextRequestId);
      this.statusValue = 'lost';
      this.notifyStatus();
      return;
    }
    if (!this.currentFacade(facade, assetToken, disposeToken)) return;
    this.statusValue = 'ready';
    this.errorValue = null;
    // Resize may have happened while read-only. Do not reset an unchanged view:
    // set_viewport cancels the native preview, which must survive device loss.
    const view = facade.get_viewport();
    const size = this.size;
    if (size && (view.css_width !== size.width || view.css_height !== size.height || view.dpr !== size.dpr)) this.applyViewport();
    this.watchDeviceLoss(facade, assetToken, disposeToken);
    this.notifyStatus();
    this.markDirty();
  }

  private releaseFacade(): void {
    const facade = this.facade;
    this.facade = null;
    this.localFlagsValue = EMPTY_LOCAL_FLAGS;
    if (facade) {
      facade.dispose();
      const stats = facade.get_render_stats?.();
      if (stats) for (const key of Object.keys(stats) as (keyof RenderStats)[]) {
        if (['live_textures', 'live_buffers', 'logical_texture_bytes', 'visible_instances'].includes(key)) continue;
        this.retiredStats[key] = (this.retiredStats[key] ?? 0) + stats[key];
      }
      facade.free?.();
    }
  }

  private guard<T>(action: (facade: EditorFacade) => T, fallbackCode: string, cpuRead = false): T | null {
    const facade = this.facade;
    if (facade === null || (!cpuRead && this.statusValue !== 'ready')) return null;
    try {
      return action(facade);
    } catch (reason) {
      this.errorValue = toApiError(reason, fallbackCode, this.nextRequestId);
      if (fallbackCode === 'RENDER_FAILED') {
        if (facade.get_device_state() === 'lost') {
          this.enterDeviceLost(this.errorValue.message);
          void this.retryRenderer();
        } else {
          this.statusValue = 'error';
          this.notifyStatus();
        }
      }
      return null;
    }
  }

  private consumeDelta(delta: EditorDelta | null): EditorDelta | null {
    if (delta === null) return null;
    if (delta.error !== null) this.errorValue = delta.error;
    else if (delta.removed_object_ids.length) {
      let next: Record<Id, LocalObjectFlags> | null = null;
      for (const id of delta.removed_object_ids) {
        if (!Object.hasOwn(this.localFlagsValue, id)) continue;
        next ??= Object.assign(Object.create(null), this.localFlagsValue);
        delete next![id];
      }
      if (next) this.localFlagsValue = Object.freeze(next);
    }
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
    if (this.framePending || this.paused || this.disposed || this.statusValue !== 'ready') return;
    this.framePending = true;
    this.frameHandle = this.scheduler.request(this.handleFrame);
  }

  private handleFrame = (timestampMs: number): void => {
    this.framePending = false;
    this.frameHandle = null;
    if (this.disposed || this.paused || !this.dirty || this.statusValue !== 'ready') return;
    this.dirty = false;
    this.guard((facade) => {
      facade.render(timestampMs);
      return null;
    }, 'RENDER_FAILED');
    for (const listener of this.renderedListeners) listener();
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

  /**
   * Precise contextmenu policy (T12): the drawing surface suppresses the
   * native menu on every platform. Right-click and the macOS ctrl+click
   * context gesture never edit, never select, and never start a gesture. No
   * platform branch exists here at all, so macOS handling cannot alter the
   * Windows defaults.
   */
  private readonly handleContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  /**
   * Precise scroll-zoom policy (T12): the wheel zooms at the cursor with an
   * exponential factor of the normalized pixel delta and never edits or
   * selects. A wheel during an active gesture cancels that gesture, because a
   * viewport change invalidates in-flight gesture state.
   */
  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const canvas = this.canvas;
    if (canvas === null || this.disposed || this.statusValue !== 'ready') return;
    if (this.activePointerId !== null) this.cancelGesture();
    const pixels =
      event.deltaMode === 1
        ? event.deltaY * WHEEL_PIXELS_PER_LINE
        : event.deltaMode === 2
          ? event.deltaY * WHEEL_PIXELS_PER_PAGE
          : event.deltaY;
    const rect = canvas.getBoundingClientRect();
    this.zoomAt(event.clientX - rect.left, event.clientY - rect.top, Math.exp(-pixels * WHEEL_ZOOM_RATE));
  };

  /** Window blur cancels the in-progress gesture and releases its captures. */
  private readonly handleWindowBlur = (): void => {
    if (this.activePointerId !== null) this.cancelGesture();
  };

  private releaseCapture(pointerId: number): void {
    if (!this.capturedPointers.has(pointerId)) return;
    this.capturedPointers.delete(pointerId);
    const canvas = this.canvas;
    if (canvas === null) return;
    try {
      if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    } catch {
      // The pointer can already be gone; the pairing bookkeeping is complete.
    }
  }

  private releaseCaptures(): void {
    for (const pointerId of [...this.capturedPointers]) this.releaseCapture(pointerId);
  }

  private handlePointer(event: PointerEvent, phase: PointerPhase): void {
    const canvas = this.canvas;
    if (canvas === null || this.disposed || this.statusValue !== 'ready') return;
    if (phase === 'down' && event.button === 0) {
      // Pointer capture pairs with every gesture: released on up/cancel and on
      // every external cancel path (T12).
      try {
        canvas.setPointerCapture(event.pointerId);
        this.capturedPointers.add(event.pointerId);
      } catch {
        // Synthetic or already-gone pointers have no capture to pair; the
        // gesture still runs and the Rust cancel path still applies.
      }
      this.activePointerId = event.pointerId;
    }
    if (phase === 'up' || phase === 'cancel') {
      if (this.activePointerId === event.pointerId) this.activePointerId = null;
      this.releaseCapture(event.pointerId);
    }
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
