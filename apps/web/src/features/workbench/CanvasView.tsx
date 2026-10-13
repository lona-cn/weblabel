import { useEffect, useRef, useState } from 'react';
import type { ReactElement, PointerEvent as ReactPointerEvent } from 'react';
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
  onHostSettled: (host: EditorHost) => void;
  objectNames?: Readonly<Record<string, string>>;
  canInteract?: (host: EditorHost) => boolean;
}

function adapterKind(diagnostics: string): 'hardware' | 'software' | 'unknown' {
  if (/swiftshader|llvmpipe|lavapipe|software|basic render|device_type=Cpu/i.test(diagnostics)) return 'software';
  if (/DiscreteGpu|IntegratedGpu|nvidia|intel|amd|apple|blackwell/i.test(diagnostics)) return 'hardware';
  return 'unknown';
}

export function CanvasView({ request, hostOptions, activeTool, onDelta, onHostSettled, objectNames, canInteract, readOnly = false }: CanvasViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef(request);
  const hostRef = useRef<EditorHost | null>(null);
  const optionsRef = useRef(hostOptions);
  const deltaRef = useRef(onDelta);
  const settledRef = useRef(onHostSettled);
  const toolRef = useRef(activeTool);
  const namesRef = useRef<Readonly<Record<string, string>>>({});
  const refreshLabelsRef = useRef<(() => void) | null>(null);
  namesRef.current = objectNames ?? Object.fromEntries(request.document.objects.map((object, index) => [object.object_id, (request.ontology.labels.find(label => label.label_id === object.label_id)?.name ?? object.label_id) + ' #' + (index + 1)]));
  const [error, setError] = useState<ApiError | null>(null);
  const [deviceState, setDeviceState] = useState<'loading' | 'ready' | 'unsupported' | 'lost' | 'recovering'>('loading');
  const [adapter, setAdapter] = useState<'hardware' | 'software' | 'unknown'>('unknown');
  const [labels, setLabels] = useState<readonly ReactElement[]>([]);
  requestRef.current = request;
  optionsRef.current = hostOptions;
  deltaRef.current = onDelta;
  settledRef.current = onHostSettled;
  toolRef.current = activeTool;

  useEffect(() => {
    let active = true;
    let host: EditorHost | null = null;
    let unsubscribe: (() => void) | undefined;
    let unsubscribeStatus: (() => void) | undefined;
    // Native CSS projection only; this cache lives for one asset/host effect.
    const labelCache = new Map<string, Readonly<CanvasLabel> & { readonly text: string; readonly element: ReactElement }>();
    let renderedLabels: readonly ReactElement[] = [];
    setLabels(renderedLabels);
    queueMicrotask(() => {
      const canvas = canvasRef.current;
      if (!active || !canvas) return;
      host = new EditorHost({ ...optionsRef.current, onDelta: (delta) => {
        if (host !== null) deltaRef.current(host, delta);
      } });
      hostRef.current = host;
      const refreshLabels = () => {
        if (!active || !host) return;
        const nativeLabels = host.getCanvasLabels();
        const present = new Set<string>();
        const nextLabels: ReactElement[] = [];
        for (const label of nativeLabels) {
          present.add(label.object_id);
          let cached = labelCache.get(label.object_id);
          const text = namesRef.current[label.object_id] ?? '对象';
          if (!cached || cached.text !== text || cached.x_css !== label.x_css || cached.y_css !== label.y_css || cached.selected !== label.selected) {
            const element = <span key={label.object_id} data-testid="canvas-label" data-object-id={label.object_id} data-selected={label.selected} title={text} style={{ position: 'absolute', transform: 'translate('+label.x_css+'px, '+label.y_css+'px)', fontSize: 12, color: label.selected ? '#fff' : '#f3d45a', background: '#121a21ed', padding: '2px 4px' }}>{text}</span>;
            cached = { ...label, text, element };
            labelCache.set(label.object_id, cached);
          }
          nextLabels.push(cached.element);
        }
        for (const id of labelCache.keys()) if (!present.has(id)) labelCache.delete(id);
        if (nextLabels.length === renderedLabels.length && nextLabels.every((element, index) => element === renderedLabels[index])) return;
        renderedLabels = nextLabels;
        setLabels(renderedLabels);
      };
      refreshLabelsRef.current = refreshLabels;
      unsubscribe = host.subscribeRendered(refreshLabels);
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
      const loadRequest = requestRef.current;
      let settled = false;
      const currentLoad = () => active && host !== null && hostRef.current === host && requestRef.current === loadRequest && host.status !== 'disposed';
      const settleHost = () => {
        if (!currentLoad() || settled || !host || !['ready', 'error', 'lost'].includes(host.status)) return;
        settled = true;
        settledRef.current(host);
      };
      void host.loadAsset(loadRequest).then(() => {
        if (!currentLoad() || !host) return;
        if (host.status === 'ready') {
          host.setTool(toolRef.current);
          setAdapter(adapterKind(host.getAdapterDiagnostics()));
          setDeviceState('ready');
        } else if (host.status === 'error' || host.status === 'lost') {
          setError(host.error);
          setDeviceState(typeof navigator !== 'undefined' && 'gpu' in navigator ? 'lost' : 'unsupported');
        }
        settleHost();
      }).catch((reason: unknown) => {
        if (!currentLoad()) return;
        setError(toApiError(reason, 'EDITOR_INIT_FAILED', () => globalThis.crypto?.randomUUID?.() ?? `canvas-view-${Date.now()}`));
        setDeviceState(typeof navigator !== 'undefined' && 'gpu' in navigator ? 'lost' : 'unsupported');
        settleHost();
      });
    });
    return () => {
      active = false;
      unsubscribe?.();
      refreshLabelsRef.current = null;
      unsubscribeStatus?.();
      host?.dispose();
      if (hostRef.current === host) hostRef.current = null;
    };
  }, [request]);

  useEffect(() => {
    if (canvasRef.current) canvasRef.current.inert = readOnly || deviceState !== 'ready';
    if (readOnly) hostRef.current?.cancelGesture();
  }, [readOnly, deviceState]);
  useEffect(() => { refreshLabelsRef.current?.(); }, [objectNames, request.document, request.ontology]);


  function guardPointer(event: ReactPointerEvent<HTMLDivElement>) {
    const current = hostRef.current;
    if (!current || readOnly || current.status !== 'ready' || (canInteract && !canInteract(current))) {
      event.stopPropagation(); current?.cancelGesture();
    }
  }
  return <>
    <div className="canvas-surface" onPointerDownCapture={guardPointer} onPointerMoveCapture={guardPointer} onPointerUpCapture={guardPointer} onPointerCancelCapture={guardPointer}>
      <canvas data-testid="annotation-canvas" ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%', touchAction: 'none' }} />
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
        {labels}
      </div>
    </div>
    <div className="canvas-renderer-status">
      <div className="gpu-diagnostics" data-testid="gpu-status" data-actual-backend={deviceState === 'ready' ? 'webgpu' : 'none'} data-adapter-kind={adapter} data-device-state={deviceState} role="status" aria-live="polite">
        {deviceState === 'ready' ? `WebGPU · ${adapter === 'hardware' ? '硬件加速' : adapter === 'software' ? '软件适配器' : '适配器类型未知'}` : deviceState === 'unsupported' ? '浏览器不支持 WebGPU，只能查看对象。' : deviceState === 'recovering' ? '正在恢复画布，未保存的标注和撤销记录仍在。' : deviceState === 'lost' ? '画布暂时不可用，标注已保留。' : '正在准备画布…'}
      </div>
      {error || deviceState === 'lost' ? <div className="canvas-state error">
        {error ? <div role="alert">{`${error.code}: ${error.message}`}</div> : null}
        {deviceState === 'lost' && hostRef.current?.status === 'lost' ? <button type="button" data-testid="gpu-retry" onClick={() => { void hostRef.current?.retryRenderer(); }}>重试画布</button> : null}
      </div> : null}
    </div>
  </>;
}
