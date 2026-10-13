import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { AnnotationObject } from '../../../../../packages/contracts/generated/AnnotationObject';
export function CandidateVisual({ document, before, after, activeAsset, focus = false }: {
  document: AnnotationDocument | null; before: AnnotationObject | null; after: AnnotationObject | null;
  activeAsset: string; focus?: boolean;
}) {
  if (!document || document.asset_revision_id !== activeAsset) return <p role="status">仅当前图片可显示 canonical 对照；异图结果不会覆盖当前图片。</p>;
  const { width, height } = document.coordinate_space;
  const boxes = [before?.geometry, after?.geometry].filter(box => box !== undefined);
  const left = Math.max(0, Math.min(...boxes.map(box => box.x_min)) - 12);
  const top = Math.max(0, Math.min(...boxes.map(box => box.y_min)) - 12);
  const right = Math.min(width, Math.max(...boxes.map(box => box.x_max)) + 12);
  const bottom = Math.min(height, Math.max(...boxes.map(box => box.y_max)) + 12);
  const viewBox = focus && boxes.length ? `${left} ${top} ${right - left} ${bottom - top}` : `0 0 ${width} ${height}`;
  return <figure className="ai-candidate-visual">
    <svg role="img" aria-label={focus ? '建议局部区域：原轮廓虚线，建议轮廓实线，只读' : '当前 canonical 图片与建议对照，只读'} viewBox={viewBox} style={{ width: '100%', maxHeight: 260, background: '#151d28' }}>
      <image href={`/api/assets/${encodeURIComponent(activeAsset)}/image`} x={0} y={0} width={width} height={height} />
      {before ? <rect x={before.geometry.x_min} y={before.geometry.y_min} width={before.geometry.x_max - before.geometry.x_min} height={before.geometry.y_max - before.geometry.y_min} fill="none" stroke="#f4d377" strokeWidth={2} strokeDasharray="5 3" vectorEffect="non-scaling-stroke" /> : null}
      {after ? <rect x={after.geometry.x_min} y={after.geometry.y_min} width={after.geometry.x_max - after.geometry.x_min} height={after.geometry.y_max - after.geometry.y_min} fill="none" stroke="#80ddcf" strokeWidth={2} vectorEffect="non-scaling-stroke" /> : null}
    </svg>
    <figcaption>原值：虚线；建议值：实线。只读 SVG 对照，不是编辑器渲染，不改变标注文档。</figcaption>
  </figure>;
}
