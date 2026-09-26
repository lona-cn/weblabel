// T09 React canvas view: owns one EditorHost per canvas mount and surfaces
// structured ApiErrors as an accessible alert instead of a blank page.
import { useEffect, useRef, useState } from 'react';
import { EditorHost } from '../../lib/editor/EditorHost';
import { toApiError } from '../../lib/editor/loader';
import type { ApiError, EditorAssetRequest, EditorHostOptions } from '../../lib/editor/types';

export interface CanvasViewProps {
  request: EditorAssetRequest;
  hostOptions?: Partial<EditorHostOptions>;
}

export function CanvasView({ request, hostOptions }: CanvasViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef(request);
  const optionsRef = useRef(hostOptions);
  const [error, setError] = useState<ApiError | null>(null);
  requestRef.current = request;
  optionsRef.current = hostOptions;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    const host = new EditorHost(optionsRef.current);
    host.mount(canvas);
    setError(null);
    host.loadAsset(requestRef.current).catch((reason: unknown) => {
      setError(toApiError(reason, 'EDITOR_INIT_FAILED', () => globalThis.crypto?.randomUUID?.() ?? `canvas-view-${Date.now()}`));
    });
    // StrictMode double-invokes this effect: the first host is disposed before
    // its async init resolves and must destroy the stale instance (T09 tests).
    return () => {
      host.dispose();
    };
  }, [request.media.asset_revision_id]);

  return (
    <>
      <canvas
        data-testid="annotation-canvas"
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%' }}
      />
      {error !== null ? (
        <div role="alert">{`${error.code}: ${error.message}`}</div>
      ) : null}
    </>
  );
}
