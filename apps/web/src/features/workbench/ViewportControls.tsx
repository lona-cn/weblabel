import { useEffect, useRef, useState } from 'react';
import type { EditorHostStatus, HitStackState, Viewport } from '../../lib/editor/types';
import './ViewportControls.css';

/** Read-only render projection; every command delegates geometry to native Rust. */
export interface ViewportControlsHost {
  readonly status: EditorHostStatus;
  getViewport(): Readonly<Viewport> | null;
  getHitStackState(): Readonly<HitStackState> | null;
  zoomAt(xCss: number, yCss: number, factor: number): void;
  fitImage(): void;
  focusSelection(): void;
  subscribeRendered(listener: () => void): () => void;
  subscribeStatus(listener: () => void): () => void;
}
interface Display { scale: number | null; index: number | null; count: number; enabled: boolean }
const EMPTY: Display = { scale: null, index: null, count: 0, enabled: false };

export function ViewportControls({ host }: { host: ViewportControlsHost | null }) {
  const [display, setDisplay] = useState<Display>(EMPTY);
  const current = useRef<Display>(EMPTY);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (!active) return;
      const view = host?.getViewport();
      const hit = host?.getHitStackState();
      const next: Display = {
        scale: view?.scale ?? null, index: hit?.index ?? null, count: hit?.count ?? 0,
        enabled: host?.status === 'ready' && !!view && view.css_width > 0 && view.css_height > 0,
      };
      const previous = current.current;
      if (next.scale !== previous.scale || next.index !== previous.index || next.count !== previous.count || next.enabled !== previous.enabled) {
        current.current = next;
        setDisplay(next);
      }
    };
    const offRender = host?.subscribeRendered(refresh);
    const offStatus = host?.subscribeStatus(refresh);
    refresh();
    return () => { active = false; offRender?.(); offStatus?.(); };
  }, [host]);

  const zoom = (factor: number | 'actual') => {
    const view = host?.getViewport();
    if (!host || host.status !== 'ready' || !view || view.css_width <= 0 || view.css_height <= 0) return;
    host.zoomAt(view.css_width / 2, view.css_height / 2, factor === 'actual' ? 1 / view.scale : factor);
  };
  return <div className="viewport-controls" role="group" aria-label="画布视图" data-testid="viewport-controls">
    <output className="viewport-controls__scale" aria-label="当前倍率">{display.scale === null ? '—' : `${Number((display.scale * 100).toFixed(1))}%`}</output>
    <button type="button" aria-label="缩小" disabled={!display.enabled} onClick={() => zoom(0.8)}>−</button>
    <button type="button" aria-label="放大" disabled={!display.enabled} onClick={() => zoom(1.25)}>+</button>
    <button type="button" aria-label="1:1 像素" title="一个图像像素对应一个 CSS 像素" disabled={!display.enabled} onClick={() => zoom('actual')}>1:1</button>
    <button type="button" aria-label="适配图像" disabled={!display.enabled} onClick={() => host?.fitImage()}>适配</button>
    <button type="button" aria-label="聚焦选中对象" disabled={!display.enabled} onClick={() => host?.focusSelection()}>聚焦选中</button>
    <output className="viewport-controls__hits" aria-label="重叠命中栈" title="最近完成点击的原生候选栈；再次点击循环选择">
      命中 {display.index === null ? '—' : display.index + 1} / {display.count}
    </output>
  </div>;
}
