import { useEffect, useRef, useState } from 'react';
import { EditorHost } from '../../lib/editor/EditorHost';
import { toApiError } from '../../lib/editor/loader';
import type { ApiError, EditorAssetRequest, EditorHostOptions, EditorTool } from '../../lib/editor/types';
import type { EditorDelta } from '../../../../../packages/contracts/generated/EditorDelta';

export interface CanvasViewProps {
  request: EditorAssetRequest;
  hostOptions?: Partial<EditorHostOptions>;
  activeTool: EditorTool;
  onDelta: (host: EditorHost, delta: EditorDelta) => void;
  onHostReady: (host: EditorHost) => void;
}

type GpuInfo = { vendor?: string; device?: string; architecture?: string; description?: string };
type GpuAdapter = { info?: GpuInfo };
type GpuNavigator = Navigator & { gpu?: { requestAdapter(): Promise<GpuAdapter | null> } };

async function adapterKind(): Promise<'hardware' | 'software' | 'unknown'> {
  try {
    const gpu = (navigator as GpuNavigator).gpu;
    if (!gpu) return 'unknown';
    const adapter = await gpu.requestAdapter();
    if (!adapter) return 'unknown';
    const info = adapter.info;
    if (!info) return 'unknown';
    const description = [info.vendor, info.device, info.architecture, info.description].join(' ').toLowerCase();
    if (/swiftshader|llvmpipe|lavapipe|software|mesa|basic render|cpu/.test(description)) return 'software';
    return info.vendor || info.device || info.architecture ? 'hardware' : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function CanvasView({ request, hostOptions, activeTool, onDelta, onHostReady }: CanvasViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef(request);
  const hostRef = useRef<EditorHost | null>(null);
  const optionsRef = useRef(hostOptions);
  const deltaRef = useRef(onDelta);
  const readyRef = useRef(onHostReady);
  const [error, setError] = useState<ApiError | null>(null);
  const [deviceState, setDeviceState] = useState<'loading' | 'ready' | 'unsupported' | 'lost'>('loading');
  const [adapter, setAdapter] = useState<'hardware' | 'software' | 'unknown'>('unknown');
  requestRef.current = request;
  optionsRef.current = hostOptions;
  deltaRef.current = onDelta;
  readyRef.current = onHostReady;

  useEffect(() => {
    let active = true;
    let host: EditorHost | null = null;
    queueMicrotask(() => {
      const canvas = canvasRef.current;
      if (!active || !canvas) return;
      host = new EditorHost({ ...optionsRef.current, onDelta: (delta) => {
        if (host !== null) deltaRef.current(host, delta);
      } });
      hostRef.current = host;
      host.mount(canvas);
      host.setTool(activeTool);
      setError(null);
      setDeviceState('loading');
      void host.loadAsset(requestRef.current).then(async () => {
        if (!active || host?.status !== 'ready') return;
        readyRef.current(host);
        const kind = await adapterKind();
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
      host?.dispose();
      if (hostRef.current === host) hostRef.current = null;
    };
  }, [request.media.asset_revision_id]);

  useEffect(() => {
    hostRef.current?.setTool(activeTool);
  }, [activeTool]);

  return <>
    <div className="gpu-diagnostics" data-testid="gpu-status" data-actual-backend={deviceState === 'ready' ? 'webgpu' : 'none'} data-adapter-kind={adapter} data-device-state={deviceState} role="status" aria-live="polite">
      {deviceState === 'ready' ? `WebGPU · ${adapter} adapter · 就绪` : deviceState === 'unsupported' ? 'WebGPU 不支持；仅可查看对象' : deviceState === 'lost' ? 'WebGPU 初始化失败' : '正在初始化真实 WebGPU…'}
    </div>
    <canvas data-testid="annotation-canvas" ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%', touchAction: 'none' }} />
    {error ? <div role="alert">{`${error.code}: ${error.message}`}</div> : null}
  </>;
}
