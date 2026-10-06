import { useEffect, useRef, useState } from 'react';
import { EditorHost } from '../../lib/editor/EditorHost';
import { toApiError } from '../../lib/editor/loader';
import type { ApiError, CanvasLabel, EditorAssetRequest, EditorHostOptions, EditorTool } from '../../lib/editor/types';
import type { EditorDelta } from '../../../../../packages/contracts/generated/EditorDelta';

export interface CanvasViewProps {
  request: EditorAssetRequest;
  readOnly?: boolean;
  hostOptions?: Partial<EditorHostOptions>;
  activeTool: EditorTool;
  onDelta: (host: EditorHost, delta: EditorDelta) => void;
  onHostReady: (host: EditorHost) => void;
}

function adapterKind(diagnostics: string): 'hardware' | 'software' | 'unknown' {
  if (/swiftshader|llvmpipe|lavapipe|software|basic render|device_type=Cpu/i.test(diagnostics)) return 'software';
  if (/DiscreteGpu|IntegratedGpu|nvidia|intel|amd|apple|blackwell/i.test(diagnostics)) return 'hardware';
  return 'unknown';
}

export function CanvasView({ request, hostOptions, activeTool, onDelta, onHostReady, readOnly = false }: CanvasViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef(request);
  const hostRef = useRef<EditorHost | null>(null);
  const optionsRef = useRef(hostOptions);
  const deltaRef = useRef(onDelta);
  const readyRef = useRef(onHostReady);
  const toolRef = useRef(activeTool);
  const [error, setError] = useState<ApiError | null>(null);
  const [deviceState, setDeviceState] = useState<'loading' | 'ready' | 'unsupported' | 'lost'>('loading');
  const [adapter, setAdapter] = useState<'hardware' | 'software' | 'unknown'>('unknown');
  const [labels, setLabels] = useState<CanvasLabel[]>([]);
  requestRef.current = request;
  optionsRef.current = hostOptions;
  deltaRef.current = onDelta;
  readyRef.current = onHostReady;
  toolRef.current = activeTool;

  useEffect(() => {
    let active = true;
    let host: EditorHost | null = null;
    let unsubscribe: (() => void) | undefined;
    queueMicrotask(() => {
      const canvas = canvasRef.current;
      if (!active || !canvas) return;
      host = new EditorHost({ ...optionsRef.current, onDelta: (delta) => {
        if (host !== null) deltaRef.current(host, delta);
      } });
      hostRef.current = host;
      unsubscribe = host.subscribeRendered(() => { if (active && host) setLabels(host.getCanvasLabels()); });
      host.mount(canvas);
      setError(null);
      setDeviceState('loading');
      void host.loadAsset(requestRef.current).then(async () => {
        if (!active || host?.status !== 'ready') return;
        host.setTool(toolRef.current);
        readyRef.current(host);
        const kind = adapterKind(host.getAdapterDiagnostics());
        if (!active) return;
        setAdapter(kind);
        setDeviceState('ready');
      }).catch((reason: unknown) => {
        if (!active) return;
        setError(toApiError(reason, 'EDITOR_INIT_FAILED', () => globalThis.crypto?.randomUUID?.() ?? `canvas-view-${Date.now()}`));
        setDeviceState(typeof navigator !== 'undefined' && 'gpu' in navigator ? 'lost' : 'unsupported');
      });
    });
    return () => {
      active = false;
      unsubscribe?.();
      host?.dispose();
      if (hostRef.current === host) hostRef.current = null;
    };
  }, [request.media.asset_revision_id]);

  useEffect(() => {
    if (canvasRef.current) canvasRef.current.inert = readOnly;
    if (readOnly) hostRef.current?.cancelGesture();
  }, [readOnly]);

  useEffect(() => {
    hostRef.current?.setTool(activeTool);
  }, [activeTool]);

  return <>
    <div className="gpu-diagnostics" data-testid="gpu-status" data-actual-backend={deviceState === 'ready' ? 'webgpu' : 'none'} data-adapter-kind={adapter} data-device-state={deviceState} role="status" aria-live="polite">
      {deviceState === 'ready' ? `WebGPU · ${adapter} adapter · 就绪` : deviceState === 'unsupported' ? 'WebGPU 不支持；仅可查看对象' : deviceState === 'lost' ? 'WebGPU 初始化失败' : '正在初始化真实 WebGPU…'}
    </div>
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas data-testid="annotation-canvas" ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%', touchAction: 'none' }} />
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
        {labels.map((label) => <span key={label.object_id} data-testid="canvas-label" data-object-id={label.object_id} data-selected={label.selected} style={{ position: 'absolute', transform: 'translate('+label.x_css+'px, '+label.y_css+'px)', fontSize: 11, color: label.selected ? '#fff' : '#f1d68a', background: '#17212be6', padding: '1px 3px' }}>{label.object_id}</span>)}
      </div>
    </div>
    {error ? <div role="alert">{`${error.code}: ${error.message}`}</div> : null}
  </>;
}
