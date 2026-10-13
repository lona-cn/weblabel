/* tslint:disable */
/* eslint-disable */

export class EditorFacade {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Returning an owned one-shot promise releases the WASM borrow before
     * JS awaits an idle device. It resolves for real Destroyed losses too.
     */
    device_lost(): Promise<any>;
    /**
     * C3 `dispatch`. Never throws: parse and domain failures come back as
     * `EditorDelta.error` at the current generation.
     */
    dispatch(command: any): any;
    /**
     * Idempotent teardown of listeners-free WASM state: drops the CPU
     * projection and destroys the GPU device exactly once.
     */
    dispose(): void;
    fit_image(): void;
    get_adapter_diagnostics(): string;
    get_canvas_labels(): any;
    get_commit_readback(expected_generation: number, changed_ids: string[]): any;
    get_device_state(): string;
    /**
     * Generation is bounded by 2^53-1 in editor-core; it crosses the
     * boundary as a plain JS number (a u64 return would become a BigInt
     * and break the C3 `get_generation(): number` contract).
     */
    get_generation(): number;
    get_object_hashes(): any;
    /**
     * Read-only diagnostics from the device actually used by this facade.
     */
    get_render_stats(): any;
    get_serialized_input_objects(): number;
    get_snapshot(): any;
    get_validation_input_objects(): number;
    /**
     * Additive C3 extension (reports/T09/review.md): Rust-owned view state
     * so resize preserves zoom/pan without duplicating geometry in TS.
     */
    get_viewport(): any;
    /**
     * C3 `pointer`. One call per DOM event; the payload is the small
     * C3 `PointerInput`, the result the incremental `EditorDelta`.
     */
    pointer(input: any): any;
    /**
     * The shared slot keeps the old scene/resources synchronously disposable.
     * Only request metadata/new GPU handles cross await, never a WASM borrow.
     */
    recover_renderer(): Promise<any>;
    /**
     * A clean session performs no renderer call. Dirty viewport and
     * projection updates share one native call and one GPU submission;
     * renderer instances never round-trip through JavaScript.
     */
    render(timestamp_ms: number): void;
    set_active_label(label_id: string): void;
    set_local_flags(ids: string[], flags: any): any;
    set_predictions(sets: any): void;
    set_selection(ids: string[]): any;
    set_tool(tool: string): void;
    set_viewport(view: any): void;
    zoom_at(x_css: number, y_css: number, factor: number): void;
}

/**
 * Browser-backed renderer. No alternate canvas renderer is provided.
 */
export class Renderer {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    adapter_diagnostics(): string;
    /**
     * Owned notification: waiting in JS never borrows this WASM object.
     */
    device_lost(): Promise<any>;
    device_state(): string;
    dispose(): void;
    is_device_lost(): boolean;
    static new(canvas: HTMLCanvasElement, width: number, height: number, rgba: Uint8Array): Promise<Renderer>;
    recover(): Promise<void>;
    render(): void;
    resize(css_width: number, css_height: number, dpr: number): void;
    /**
     * Update annotation geometry/overlays without retransferring the image.
     */
    update_objects(projection: any): void;
    /**
     * Replace the complete renderer scene, including the canonical image.
     * Use the narrower update methods for ordinary viewport or object changes.
     */
    update_scene(scene: any): void;
    /**
     * Update pan/zoom without transferring image pixels or rebuilding instances.
     */
    update_viewport(viewport: any): void;
}

/**
 * C3 `create_editor`: asynchronous GPU device creation. Every failure is a
 * structured ApiError rejection — never a panic — so the host can show it.
 */
export function create_editor(canvas: HTMLCanvasElement, media: any, ontology: any, document: any, canonical_rgba: Uint8Array, initial_generation: any): Promise<EditorFacade>;

/**
 * Read-only authorization hashing; no editor, canvas, DOM, or GPU is created.
 */
export function host_execution_configuration_hash(host_json: string, provider_id: string, profile_id: string): string;

export function initialize_browser_device_probe(): Promise<string>;

/**
 * Pure fixed-snapshot projection; no EditorFacade, DOM or GPU is needed.
 */
export function project_relabel(document: any, ontology: any, object_id: string, before_hash: string, label_id: string): any;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_editorfacade_free: (a: number, b: number) => void;
    readonly __wbg_renderer_free: (a: number, b: number) => void;
    readonly create_editor: (a: any, b: any, c: any, d: any, e: number, f: number, g: any) => any;
    readonly editorfacade_device_lost: (a: number) => [number, number, number];
    readonly editorfacade_dispatch: (a: number, b: any) => [number, number, number];
    readonly editorfacade_dispose: (a: number) => void;
    readonly editorfacade_fit_image: (a: number) => [number, number];
    readonly editorfacade_get_adapter_diagnostics: (a: number) => [number, number];
    readonly editorfacade_get_canvas_labels: (a: number) => [number, number, number];
    readonly editorfacade_get_commit_readback: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly editorfacade_get_device_state: (a: number) => [number, number];
    readonly editorfacade_get_generation: (a: number) => number;
    readonly editorfacade_get_object_hashes: (a: number) => [number, number, number];
    readonly editorfacade_get_render_stats: (a: number) => [number, number, number];
    readonly editorfacade_get_serialized_input_objects: (a: number) => number;
    readonly editorfacade_get_snapshot: (a: number) => [number, number, number];
    readonly editorfacade_get_validation_input_objects: (a: number) => number;
    readonly editorfacade_get_viewport: (a: number) => [number, number, number];
    readonly editorfacade_pointer: (a: number, b: any) => [number, number, number];
    readonly editorfacade_recover_renderer: (a: number) => [number, number, number];
    readonly editorfacade_render: (a: number, b: number) => [number, number];
    readonly editorfacade_set_active_label: (a: number, b: number, c: number) => [number, number];
    readonly editorfacade_set_local_flags: (a: number, b: number, c: number, d: any) => [number, number, number];
    readonly editorfacade_set_predictions: (a: number, b: any) => [number, number];
    readonly editorfacade_set_selection: (a: number, b: number, c: number) => [number, number, number];
    readonly editorfacade_set_tool: (a: number, b: number, c: number) => [number, number];
    readonly editorfacade_set_viewport: (a: number, b: any) => [number, number];
    readonly editorfacade_zoom_at: (a: number, b: number, c: number, d: number) => [number, number];
    readonly host_execution_configuration_hash: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly initialize_browser_device_probe: () => any;
    readonly project_relabel: (a: any, b: any, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly renderer_adapter_diagnostics: (a: number) => [number, number];
    readonly renderer_device_lost: (a: number) => any;
    readonly renderer_device_state: (a: number) => [number, number];
    readonly renderer_dispose: (a: number) => void;
    readonly renderer_is_device_lost: (a: number) => number;
    readonly renderer_new: (a: any, b: number, c: number, d: number, e: number) => any;
    readonly renderer_recover: (a: number) => any;
    readonly renderer_render: (a: number) => [number, number];
    readonly renderer_resize: (a: number, b: number, c: number, d: number) => [number, number];
    readonly renderer_update_objects: (a: number, b: any) => [number, number];
    readonly renderer_update_scene: (a: number, b: any) => [number, number];
    readonly renderer_update_viewport: (a: number, b: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h1a420b74d19188ed: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h57b5526d5c4c51b2: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h670d5a728a879904: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h8a591b61a2aadc7c: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__habd8ecfe2fd235f4: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hd42b9790444fca6e: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h4a8a2f1ac0ec5e5f: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h6674c696ee03657d: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h46238804fe218674: (a: number, b: number) => number;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
