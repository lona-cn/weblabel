import type { AnnotationObject } from '../packages/contracts/generated/AnnotationObject';
export interface DenseWorkload {
  fixture_kind: 'synthetic_dense_workload'; seed: number; count: number; width: number; height: number;
  objects: AnnotationObject[];
  operations: ({ kind: 'pan'; dx: number; dy: number } | { kind: 'zoom'; factor: number } | { kind: 'edit'; object_id: string; dx: number } | { kind: 'idle_ms'; duration: number } | { kind: 'asset_cycle'; count: number })[];
}
export function generateDenseWorkload(count: number, seed?: number, width?: number, height?: number): DenseWorkload;
