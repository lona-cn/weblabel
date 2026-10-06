// T09: browser-side types for the C3 editor facade (docs/contracts.md C3) and
// the canvas lifecycle seams. Viewport/PointerInput mirror the Rust boundary
// types (geometry::Viewport, editor_core::PointerInput) field for field; the
// generated contract types are consumed from packages/contracts/generated and
// never re-declared here.
import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { ApiError } from '../../../../../packages/contracts/generated/ApiError';
import type { EditorCommand } from '../../../../../packages/contracts/generated/EditorCommand';
import type { EditorDelta } from '../../../../../packages/contracts/generated/EditorDelta';
import type { Id } from '../../../../../packages/contracts/generated/Id';
import type { MediaRevision } from '../../../../../packages/contracts/generated/MediaRevision';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import type { SuggestionSet } from '../../../../../packages/contracts/generated/SuggestionSet';

/** C3 view state. DPR sizes the backing store only; it never enters image coords. */
export interface Viewport {
  scale: number;
  tx: number;
  ty: number;
  css_width: number;
  css_height: number;
  dpr: number;
}

export type PointerPhase = 'down' | 'move' | 'up' | 'cancel';

/** C3 pointer input; x_css/y_css are canvas-local CSS pixels (rect offset removed). */
export interface PointerInput {
  phase: PointerPhase;
  pointer_id: number;
  x_css: number;
  y_css: number;
  button: number;
  buttons: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

export type EditorTool = 'select' | 'box' | 'pan';

/** Transient sidebar state; never part of AnnotationDocument or saved revisions. */
export type LocalObjectFlags = Readonly<{ hidden: boolean; locked: boolean }>;
export type LocalObjectFlagMap = Readonly<Record<Id, LocalObjectFlags>>;

/** C3 EditorFacade. Errors surface as `EditorDelta.error`; void setters throw
 *  a structured ApiError value (never a panic). `get_viewport` is the additive
 *  T09 extension documented in reports/T09/review.md: it returns the Rust-owned
 *  view so resize can preserve zoom/pan without duplicating geometry in TS. */
export interface CanvasLabel { object_id: Id; x_css: number; y_css: number; selected: boolean }
export interface RenderStats {
  cpu_calls: number; cpu_elapsed_ns: number; cpu_objects_examined: number;

  gpu_buffer_upload_calls: number; gpu_buffer_upload_bytes: number;
  gpu_texture_upload_calls: number; gpu_texture_upload_bytes: number;
  bbox_upload_calls: number; bbox_upload_bytes: number; uniform_upload_bytes: number;
  draw_calls: number; gpu_submissions: number; live_textures: number;
  live_buffers: number; buffer_creations: number; buffer_releases: number;
  visible_instances: number; logical_texture_bytes: number; rejected_resources: number;
}
export interface EditorFacade {
  dispatch(command: EditorCommand): EditorDelta;
  pointer(input: PointerInput): EditorDelta;
  set_tool(tool: EditorTool): void;
  set_active_label(label_id: Id): void;
  set_viewport(view: Viewport): void;
  zoom_at(x_css: number, y_css: number, factor: number): void;
  fit_image(): void;
  set_selection(ids: Id[]): EditorDelta;
  set_local_flags(ids: readonly Id[], flags: { hidden?: boolean; locked?: boolean }): EditorDelta;
  get_snapshot(): AnnotationDocument;
  get_generation(): number;
  get_object_hashes(): Record<Id, string>;
  get_viewport(): Viewport;
  set_predictions(sets: SuggestionSet[]): void;
  render(timestamp_ms: number): void;
  /** Owned, one-shot real device-loss notification; never holds a WASM borrow. */
  device_lost(): Promise<string>;
  get_device_state(): 'ready' | 'lost' | 'recovering' | 'disposed';
  /** Rebuild GPU resources only; retains the same CPU session and history. */
  recover_renderer(): Promise<void>;
  dispose(): void;
  free?(): void;
  get_render_stats?(): RenderStats;
  get_adapter_diagnostics?(): string;
  get_canvas_labels?(): CanvasLabel[];
  get_validation_input_objects?(): number;
  get_serialized_input_objects?(): number;
}

/** Canonical RGBA pixels: already EXIF-oriented by the server pipeline; the
 *  browser must not apply orientation again (see loader.decodeCanonicalFrame). */
export interface CanonicalFrame {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export interface EditorAssetRequest {
  media: MediaRevision;
  ontology: OntologyVersion;
  document: AnnotationDocument;
  frame: CanonicalFrame;
  initial_generation: number;
}

/** Measured binary RGBA handoff across the WASM boundary. The wasm-bindgen
 *  glue copies the typed array into wasm linear memory exactly once
 *  (passArray8ToWasm0 semantics: `memoryView.set(bytes)`); never JSON/base64. */
export interface BinaryTransfer {
  method: 'copyBytes';
  byteLength: number;
  durationMs: number;
}

export interface CreatedEditor {
  facade: EditorFacade;
  transfer: BinaryTransfer;
}

export interface EditorFacadeFactory {
  create(canvas: HTMLCanvasElement, request: EditorAssetRequest): Promise<CreatedEditor>;
}

/** Minimal wasm-bindgen module surface T09 consumes (create_editor per C3). */
export interface EditorWasmBridge {
  create_editor(
    canvas: HTMLCanvasElement,
    media: MediaRevision,
    ontology: OntologyVersion,
    document: AnnotationDocument,
    canonical_rgba: Uint8Array,
    initial_generation: number,
  ): Promise<EditorFacade>;
}

/** On-demand render scheduling; a frame is requested only while dirty. */
export interface RenderScheduler {
  request(callback: (timestamp_ms: number) => void): number;
  cancel(handle: number): void;
}

export type EditorHostStatus = 'idle' | 'loading' | 'ready' | 'lost' | 'recovering' | 'error' | 'disposed';

export interface EditorHostOptions {
  facadeFactory: EditorFacadeFactory;
  scheduler: RenderScheduler;
  /** Source of structured request ids for normalized ApiErrors. */
  nextRequestId: () => Id;
  onDelta: ((delta: EditorDelta) => void) | null;
}

export type { AnnotationDocument, ApiError, EditorCommand, EditorDelta, Id, MediaRevision, OntologyVersion, SuggestionSet };
