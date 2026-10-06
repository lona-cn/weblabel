import type { AnnotationDocument, CanvasLabel, RenderStats, Viewport } from '../../lib/editor/types';

export type T28Stats = RenderStats & {
  js_wasm_calls: number; js_wasm_bytes: number;
  /** Only actual binary RGBA copies. JsValue object references are not byte copies. */
  js_wasm_binary_bytes: number;
  bridge_elapsed_ms: number;
  live_decoded_bitmaps: number; decoded_bitmap_creations: number; decoded_bitmap_releases: number;
};
export interface T28TestHooks {
  ready: boolean;
  stats(): T28Stats;
  pan(dx: number, dy: number): Promise<void>;
  zoom(factor: number): Promise<void>;
  editObject(index: number, dx?: number): Promise<void>;
  changeAsset(index: number): Promise<void>;
  tryOverBudgetAsset(): Promise<boolean>;
  setFlags(ids: string[], flags: { hidden?: boolean; locked?: boolean }): Promise<void>;
  select(id: string): Promise<void>;
  commitBulkAttributes(): Promise<void>;
  flush(): Promise<void>;
  snapshot(): AnnotationDocument;
  viewport(): Viewport;
  labels(): CanvasLabel[];
  saveCount(): number;
  validationInputObjects(): number;
  serializedInputObjects(): number;
  generation(): number;
  tool(tool: 'select' | 'box' | 'pan'): void;
  undo(): Promise<void>;
}
declare global { interface Window { __wl_test?: T28TestHooks } }
export function installT28TestHooks(hooks: T28TestHooks): void {
  if (import.meta.env.MODE !== 'test') throw new Error('T28 test hooks are unavailable outside test builds');
  Object.defineProperty(window, '__wl_test', { configurable: true, enumerable: false, value: hooks });
}
export function removeT28TestHooks(): void { if (import.meta.env.MODE === 'test') delete window.__wl_test; }
