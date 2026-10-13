/* tslint:disable */
/* eslint-disable */

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

export function initialize_browser_device_probe(): Promise<string>;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_renderer_free: (a: number, b: number) => void;
    readonly initialize_browser_device_probe: () => any;
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
    readonly wasm_bindgen__convert__closures_____invoke__h43b53cc557bf6e42: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h5c2c9a75a6746f64: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h920b1d6c4a49b2c0: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hb52fd36053a2e8eb: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__hc52328d8cde8c446: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__hf91c2a62bb24aec0: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__hbb31a206cd0bdb79: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hcfc1dc1a875adce5: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hd4a907be06eb37af: (a: number, b: number) => number;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
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
