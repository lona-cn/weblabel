import type { BBox } from '../../../../../packages/contracts/generated/BBox';
export type GeometryField = 'x' | 'y' | 'w' | 'h';
export type GeometryDraft = Record<GeometryField, string>;
const CANONICAL_PIXELS = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*(?:px)?\s*$/;
export function parseCanonicalPixels(text: string): number | null {
  const match = CANONICAL_PIXELS.exec(text);
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}
export function composeBBox(draft: GeometryDraft, space: { width: number; height: number }): { bbox: BBox } | { error: string } {
  const x = parseCanonicalPixels(draft.x), y = parseCanonicalPixels(draft.y), w = parseCanonicalPixels(draft.w), h = parseCanonicalPixels(draft.h);
  if (x === null || y === null || w === null || h === null) return { error: '几何值必须是像素单位的数字，例如 50 或 50px' };
  if (w <= 0 || h <= 0) return { error: '宽和高必须为正（bbox 需要正面积）' };
  if (x < 0 || y < 0 || x + w > space.width || y + h > space.height) return { error: `几何必须位于 canonical 图像内（0..${space.width} × 0..${space.height} px）` };
  return { bbox: { type: 'bbox_xyxy', x_min: x, y_min: y, x_max: x + w, y_max: y + h } };
}
export function geometryDraft(geometry: BBox): GeometryDraft {
  return { x: `${geometry.x_min}px`, y: `${geometry.y_min}px`, w: `${geometry.x_max - geometry.x_min}px`, h: `${geometry.y_max - geometry.y_min}px` };
}
export function sameBBox(left: BBox, right: BBox): boolean {
  return left.x_min === right.x_min && left.y_min === right.y_min && left.x_max === right.x_max && left.y_max === right.y_max;
}
