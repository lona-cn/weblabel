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
  const [deviceState, setDeviceState] = useState<'loading' | 'ready' | 'unsupported' | 'lost' | 'recovering'>('loading');
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
    let unsubscribeStatus: (() => void) | undefined;
    queueMicrotask(() => {
      const canvas = canvasRef.current;
      if (!active || !canvas) return;
      host = new EditorHost({ ...optionsRef.current, onDelta: (delta) => {
        if (host !== null) deltaRef.current(host, delta);
      } });
      hostRef.current = host;
      unsubscribe = host.subscribeRendered(() => { if (active && host) setLabels(host.getCanvasLabels()); });
      unsubscribeStatus = host.subscribeStatus(() => {
        if (!active || !host) return;
        const status = host.status;
        if (status === 'ready' || status === 'lost' || status === 'recovering') {
          setDeviceState(status);
          setError(host.error);
          if (status === 'ready') setAdapter(adapterKind(host.getAdapterDiagnostics()));
        } else if (status === 'error') {
          setDeviceState('lost');
          setError(host.error);
        }
      });
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
      unsubscribeStatus?.();
      host?.dispose();
      if (hostRef.current === host) hostRef.current = null;
    };
  }, [request.media.asset_revision_id]);

  useEffect(() => {
    if (canvasRef.current) canvasRef.current.inert = readOnly || deviceState !== 'ready';
    if (readOnly) hostRef.current?.cancelGesture();
  }, [readOnly, deviceState]);


  return <>
    <div className="gpu-diagnostics" data-testid="gpu-status" data-actual-backend={deviceState === 'ready' ? 'webgpu' : 'none'} data-adapter-kind={adapter} data-device-state={deviceState} role="status" aria-live="polite">
      {deviceState === 'ready' ? `WebGPU · ${adapter} adapter · 就绪` : deviceState === 'unsupported' ? 'WebGPU 不支持；仅可查看对象' : deviceState === 'recovering' ? 'WebGPU 设备丢失；正在重建渲染器，未保存内容和撤销历史已保留…' : deviceState === 'lost' ? 'WebGPU 不可用；仅可查看，CPU 文档和未保存内容已保留' : '正在初始化真实 WebGPU…'}
    </div>
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas data-testid="annotation-canvas" ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%', touchAction: 'none' }} />
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
        {labels.map((label) => <span key={label.object_id} data-testid="canvas-label" data-object-id={label.object_id} data-selected={label.selected} style={{ position: 'absolute', transform: 'translate('+label.x_css+'px, '+label.y_css+'px)', fontSize: 11, color: label.selected ? '#fff' : '#f1d68a', background: '#17212be6', padding: '1px 3px' }}>{label.object_id}</span>)}
      </div>
    </div>
    {error ? <div role="alert">{`${error.code}: ${error.message}`}</div> : null}
    {deviceState === 'lost' && hostRef.current?.status === 'lost' ? <button type="button" data-testid="gpu-retry" onClick={() => { void hostRef.current?.retryRenderer(); }}>重试 WebGPU 渲染器</button> : null}
  </>;
}
