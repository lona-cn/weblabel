import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { BBox } from '../../../../../packages/contracts/generated/BBox';
import { element } from '../workbench/view-elements';

/** Display-only SVG. No hit testing, edit buffers, transforms or persisted geometry. */
export function readonlyVisual(document: AnnotationDocument | null, assetId: string, before: readonly BBox[], after: readonly BBox[], focus = false, exactBounds?: BBox): HTMLElement {
  const figure = element('figure', undefined, 'r07-readonly-visual');
  if (!document || document.asset_revision_id !== assetId) { figure.append(element('p', '异图或固定版本不可用；不在当前图片显示轮廓。')); return figure; }
  const { width, height } = document.coordinate_space, ns = 'http://www.w3.org/2000/svg', svg = window.document.createElementNS(ns, 'svg');
  const boxes = [...before, ...after];
  const left = Math.max(0, Math.min(...boxes.map(box => box.x_min)) - 12), top = Math.max(0, Math.min(...boxes.map(box => box.y_min)) - 12);
  const right = Math.min(width, Math.max(...boxes.map(box => box.x_max)) + 12), bottom = Math.min(height, Math.max(...boxes.map(box => box.y_max)) + 12);
  svg.setAttribute('viewBox', exactBounds ? `${exactBounds.x_min} ${exactBounds.y_min} ${exactBounds.x_max - exactBounds.x_min} ${exactBounds.y_max - exactBounds.y_min}` : focus && boxes.length ? `${left} ${top} ${right - left} ${bottom - top}` : `0 0 ${width} ${height}`);
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', '只读 canonical 对照：原轮廓虚线，建议轮廓实线');
  const image = window.document.createElementNS(ns, 'image'); image.setAttribute('href', '/api/assets/' + encodeURIComponent(assetId) + '/image'); image.setAttribute('width', String(width)); image.setAttribute('height', String(height)); svg.append(image);
  // Draw the dashed original last so coincident attribute-only outlines show both styles.
  for (const [suggested, group] of [[true, after], [false, before]] as const) for (const box of group) {
    const rect = window.document.createElementNS(ns, 'rect');
    for (const [key, value] of Object.entries({ x: box.x_min, y: box.y_min, width: box.x_max - box.x_min, height: box.y_max - box.y_min })) rect.setAttribute(key, String(value));
    rect.setAttribute('fill', 'none'); rect.setAttribute('stroke', suggested ? '#69d9bb' : '#f1c975'); rect.setAttribute('stroke-width', '2'); rect.setAttribute('vector-effect', 'non-scaling-stroke');
    if (!suggested) rect.setAttribute('stroke-dasharray', '5 3'); svg.append(rect);
  }
  figure.append(svg, element('figcaption', '只读 SVG 投影，不是可编辑 wgpu；原值虚线，建议值实线。'));
  return figure;
}
