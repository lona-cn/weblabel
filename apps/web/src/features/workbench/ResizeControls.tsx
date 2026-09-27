type Props = {
  targetId: string;
  axis: 'width' | 'height';
  decreaseName: string;
  increaseName: string;
  minimum: number;
  maximum: number;
  step: number;
};

export function ResizeControls({ targetId, axis, decreaseName, increaseName, minimum, maximum, step }: Props) {
  function adjust(delta: number) {
    const target = document.getElementById(targetId);
    if (!target) return;
    const current = target.getBoundingClientRect()[axis];
    target.style[axis] = `${Math.max(minimum, Math.min(maximum, current + delta))}px`;
  }

  return <div className="resize-controls">
    <button type="button" aria-label={decreaseName} title={`每次调整 ${step} 像素`} onClick={() => adjust(-step)}>−</button>
    <button type="button" aria-label={increaseName} title={`每次调整 ${step} 像素`} onClick={() => adjust(step)}>＋</button>
  </div>;
}
