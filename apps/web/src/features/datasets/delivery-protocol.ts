import type { AssetAnnotationHead } from '../../../../../packages/contracts/generated/AssetAnnotationHead';
import { readLossReport, type LossReport } from '../import-export/loss-report';
export type Format = 'native' | 'yolo' | 'coco';
export type Artifact = { export_id: string; format: Format; download_url: string; byte_size: number; object_sha256: string; loss_report: LossReport };
export const CAP = 1024;
export const ZIP_CAP = 100663296;
export const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
export function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function eligible(row: AssetAnnotationHead, ontology: string): boolean { return Boolean(row.head && row.head.ontology_version_id === ontology && row.head.approved_review_id && ['complete', 'confirmed_negative'].includes(row.head.completion)); }
export function strictReport(value: unknown): LossReport | null { const report = readLossReport(value); return report && report.losses.every(loss => loss.field.trim() && loss.reason.trim()) ? report : null; }
export function readArtifact(value: unknown, job: string, format: Format): Artifact {
  const result = object(value), report = strictReport(result.loss_report);
  if (result.export_id !== job || result.format !== format || result.download_url !== `/api/exports/${job}/download` || !Number.isSafeInteger(result.byte_size) || Number(result.byte_size) < 22 || Number(result.byte_size) > ZIP_CAP || !hash(result.object_sha256) || !report) throw new Error('导出产物身份或校验信息无效。');
  return { export_id: job, format, download_url: String(result.download_url), byte_size: Number(result.byte_size), object_sha256: result.object_sha256, loss_report: report };
}
