// T09 loader: canonical image decode (no second EXIF rotation), the measured
// binary RGBA handoff to the WASM facade, and structured ApiError normalization.
import type {
  ApiError,
  BinaryTransfer,
  CanonicalFrame,
  CreatedEditor,
  EditorFacade,
  EditorFacadeFactory,
  EditorWasmBridge,
  Id,
} from './types';

let requestCounter = 0;

function newRequestId(): Id {
  requestCounter += 1;
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `wasm-bridge-${requestCounter}`;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  if (reason !== null && typeof reason === 'object' && 'message' in reason && typeof (reason as { message: unknown }).message === 'string') {
    return (reason as { message: string }).message;
  }
  return String(reason);
}

function isApiError(value: unknown): value is ApiError {
  return value !== null
    && typeof value === 'object'
    && typeof (value as ApiError).code === 'string'
    && typeof (value as ApiError).message === 'string'
    && typeof (value as ApiError).request_id === 'string'
    && 'details' in value;
}

/**
 * Normalizes anything crossing the WASM boundary (structured Rust ApiError,
 * JsValue string, thrown Error) into the C3 ApiError shape. Already-structured
 * errors pass through untouched so codes stay exact.
 */
export function toApiError(reason: unknown, fallbackCode: string, nextRequestId: () => Id): ApiError {
  if (isApiError(reason)) return reason;
  return { code: fallbackCode, message: errorMessage(reason), request_id: nextRequestId(), details: null };
}

/**
 * Decodes canonical image bytes to continuous RGBA pixels. The server pipeline
 * already applied EXIF orientation (docs/contracts.md C2: the canonical bytes
 * are the oriented result), so the browser decodes with `imageOrientation:
 * 'none'`; the browser default ('from-image') would rotate them a second time.
 */
export async function decodeCanonicalFrame(source: Blob, expected: { width: number; height: number }): Promise<CanonicalFrame> {
  const bitmap = await createImageBitmap(source, { imageOrientation: 'none' });
  if (bitmap.width !== expected.width || bitmap.height !== expected.height) {
    bitmap.close();
    throw {
      code: 'CANONICAL_DECODE_MISMATCH',
      message: `decoded ${bitmap.width}x${bitmap.height} does not match canonical ${expected.width}x${expected.height}`,
      request_id: newRequestId(),
      details: null,
    } satisfies ApiError;
  }
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d');
  if (context === null) {
    bitmap.close();
    throw {
      code: 'CANVAS_2D_UNAVAILABLE',
      message: 'canonical decode requires a 2D canvas context',
      request_id: newRequestId(),
      details: null,
    } satisfies ApiError;
  }
  context.drawImage(bitmap, 0, 0);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  bitmap.close();
  const rgba = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  return { width: canvas.width, height: canvas.height, rgba };
}

/** Default wasm-bridge bundle location (generated packages/wasm-editor output). */
export const DEFAULT_WASM_BRIDGE_URL = '/wasm/wasm_bridge.js';

/**
 * Wraps the wasm-bindgen module into an EditorFacadeFactory. The wasm-bindgen
 * glue copies `canonical_rgba` into wasm linear memory exactly once
 * (passArray8ToWasm0: `memoryView.set(bytes)`); this measures that binary
 * handoff instead of shipping pixels as JSON or base64. A string/URL source is
 * loaded lazily on first use.
 */
export function createEditorFacadeFactory(source: string | URL | EditorWasmBridge): EditorFacadeFactory {
  return {
    async create(canvas, request): Promise<CreatedEditor> {
      const bridge = await loadWasmBridge(source);
      const { width, height, rgba } = request.frame;
      const expectedBytes = width * height * 4;
      if (rgba.byteLength !== expectedBytes) {
        throw {
          code: 'CANONICAL_FRAME_SIZE',
          message: `canonical RGBA is ${rgba.byteLength} bytes; expected ${expectedBytes} for ${width}x${height}`,
          request_id: newRequestId(),
          details: null,
        } satisfies ApiError;
      }
      const startedAt = performance.now();
      const pending: Promise<EditorFacade> = bridge.create_editor(
        canvas,
        request.media,
        request.ontology,
        request.document,
        rgba,
        request.initial_generation,
      );
      const transfer: BinaryTransfer = {
        method: 'copyBytes',
        byteLength: rgba.byteLength,
        durationMs: performance.now() - startedAt,
      };
      return { facade: await pending, transfer };
    },
  };
}

interface WasmBridgeModule extends EditorWasmBridge {
  default?: () => Promise<unknown>;
}

/**
 * Loads the generated wasm-bridge module (packages/wasm-editor or a built
 * wasm-pack bundle) and runs its wasm-bindgen init. A concrete bridge object
 * (tests, or an already-loaded module) passes through unchanged.
 */
export async function loadWasmBridge(source: string | URL | EditorWasmBridge): Promise<EditorWasmBridge> {
  if (typeof source === 'object' && 'create_editor' in source) return source;
  const specifier = source.toString();
  // The wasm bundle URL is runtime-selected (dev server, e2e harness or the
  // generated packages/wasm-editor package), so a static import cannot work.
  const module: WasmBridgeModule = await import(/* @vite-ignore */ specifier);
  if (typeof module.default === 'function') await module.default();
  return module;
}
