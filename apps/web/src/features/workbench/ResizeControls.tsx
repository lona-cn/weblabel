import { useCallback, useEffect, useState } from 'react';

type Props = {
  targetId: string;
  axis: 'width' | 'height';
  decreaseName: string;
  increaseName: string;
  minimum: number;
  maximum: number;
  step: number;
  disabled?: boolean;
};

export function ResizeControls({ targetId, axis, decreaseName, increaseName, minimum, maximum, step, disabled = false }: Props) {
  const [limits, setLimits] = useState({ canDecrease: false, canIncrease: false });

  const syncLimits = useCallback((target: HTMLElement) => {
    const current = target.getBoundingClientRect()[axis];
    const canDecrease = current > minimum;
    const canIncrease = current < maximum;
    setLimits((previous) => previous.canDecrease === canDecrease && previous.canIncrease === canIncrease
      ? previous : { canDecrease, canIncrease });
  }, [axis, minimum, maximum]);

  useEffect(() => {
    const target = document.getElementById(targetId);
    if (!target) {
      setLimits({ canDecrease: false, canIncrease: false });
      return;
    }
    syncLimits(target);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => syncLimits(target));
    observer.observe(target);
    return () => observer.disconnect();
  }, [targetId, syncLimits]);

  function adjust(delta: number) {
    if (disabled) return;
    const target = document.getElementById(targetId);
    if (!target) return;
    const current = target.getBoundingClientRect()[axis];
    target.style[axis] = `${Math.max(minimum, Math.min(maximum, current + delta))}px`;
    syncLimits(target);
  }

  return <div className="resize-controls">
    <button type="button" aria-label={decreaseName} title={`每次调整 ${step} 像素`} disabled={disabled || !limits.canDecrease} onClick={() => adjust(-step)}>−</button>
    <button type="button" aria-label={increaseName} title={`每次调整 ${step} 像素`} disabled={disabled || !limits.canIncrease} onClick={() => adjust(step)}>＋</button>
  </div>;
}
