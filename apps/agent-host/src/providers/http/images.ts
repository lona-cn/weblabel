//! Image input planning and preparation for provider egress.
//!
//! Two explicit input kinds exist: the full image and per-object crops. Every
//! prepared input carries its canonical transform and a privacy fingerprint
//! (a hash over kind, region, transform and bytes) so logs and run events can
//! reference an image without exposing pixels. Byte and pixel budgets are
//! enforced before anything leaves the process.

import { createHash } from 'node:crypto';

import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { BBox } from '../../../../../packages/contracts/generated/BBox';
import type { Id } from '../../../../../packages/contracts/generated/Id';
import type { StartRunRequest } from '../../../../../packages/contracts/generated/StartRunRequest';
import type { RuntimeContext, RuntimeReadRegion } from '../../registry';

import { ProviderError } from './errors';

/**
 * Additive host-side channel (C5 `RuntimeContext` is unchanged): the run-scoped
 * image grants the user consented to for egress. The host supplies them when
 * driving an HTTP provider adapter; adapters never mint grants.
 */
export interface ImageGrantContext {
  readonly approved_grant_ids: readonly Id[];
  readonly allow_image?: boolean;
  readonly approved_image_region?: BBox | null;
}

const MAX_GRANT_ID_LENGTH = 128;

export function imageGrantIds(ctx: RuntimeContext): readonly Id[] {
  if (!('approved_grant_ids' in ctx)) {
    throw new ProviderError('image_grant_missing', 'the host must provide run-scoped approved image grants');
  }
  const grants: unknown = ctx.approved_grant_ids;
  if (!Array.isArray(grants) || grants.length === 0) {
    throw new ProviderError('image_grant_missing', 'the run has no approved image grant');
  }
  for (const grant of grants) {
    if (typeof grant !== 'string' || grant.length === 0 || grant.length > MAX_GRANT_ID_LENGTH) {
      throw new ProviderError('image_grant_missing', 'approved image grant ids must be non-empty strings');
    }
  }
  // Single-grant semantics: every read in a run is charged to exactly one
  // approved grant. With several grants the adapter cannot know which one
  // authorizes a given region, so it fails closed instead of mis-charging;
  // the host's read_region enforces grant scope regardless.
  if (grants.length > 1) {
    throw new ProviderError(
      'image_grant_missing',
      'exactly one approved image grant per run is supported; multiple grants must be split into separate runs',
    );
  }
  return grants as readonly Id[]; // every entry validated above
}

export interface ImageInputRequest {
  kind: 'full' | 'crop';
  region: BBox | null;
  object_id: Id | null;
}

export function planImageInputs(input: StartRunRequest, document: AnnotationDocument, max_crops: number, scope?: { allow_image?: boolean; approved_image_region?: BBox | null }): ImageInputRequest[] {
  if (scope?.allow_image === false) return [];
  if (scope?.approved_image_region) return [{ kind: "crop", region: scope.approved_image_region, object_id: null }];
  const requests: ImageInputRequest[] = [{ kind: 'full', region: null, object_id: null }];
  let crops = 0;
  for (const object_id of input.context.selected_object_ids) {
    if (crops >= max_crops) break;
    const object = document.objects.find((candidate) => candidate.object_id === object_id);
    if (object === undefined) continue;
    requests.push({ kind: 'crop', region: object.geometry, object_id });
    crops += 1;
  }
  return requests;
}

export interface ImageBudget {
  max_bytes: number;
  max_pixels: number;
  pixels_used: number;
}

export interface PreparedImageInput {
  kind: 'full' | 'crop';
  region: BBox | null;
  object_id: Id | null;
  bytes: Uint8Array;
  mime: 'image/png';
  width: number;
  height: number;
  transform_to_canonical: number[];
  pixel_count: number;
  privacy_fingerprint: string;
  data_url: string;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 24) throw new ProviderError('image_invalid', 'image region is not a PNG payload');
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) throw new ProviderError('image_invalid', 'image region is not a PNG payload');
  }
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    throw new ProviderError('image_invalid', 'PNG payload lacks an IHDR chunk');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0) throw new ProviderError('image_invalid', 'PNG dimensions must be positive');
  return { width, height };
}

export function privacyFingerprint(input: {
  kind: string;
  region: BBox | null;
  transform_to_canonical: number[];
  bytes: Uint8Array;
}): string {
  const bytes_sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const material = JSON.stringify({
    kind: input.kind,
    region: input.region,
    transform_to_canonical: input.transform_to_canonical,
    bytes_sha256,
  });
  return createHash('sha256').update(material).digest('hex');
}

export function prepareImage(raw: RuntimeReadRegion, request: ImageInputRequest, budget: ImageBudget): PreparedImageInput {
  if (raw.mime !== 'image/png') throw new ProviderError('image_invalid', 'only image/png regions can leave the process');
  if (!(raw.bytes instanceof Uint8Array) || raw.bytes.length === 0) {
    throw new ProviderError('image_invalid', 'image region has no bytes');
  }
  if (raw.bytes.length > budget.max_bytes) {
    throw new ProviderError('image_budget_exceeded', `image of ${raw.bytes.length} bytes exceeds the ${budget.max_bytes} byte budget`);
  }
  const transform = raw.transform_to_canonical;
  if (!Array.isArray(transform) || transform.length !== 9 || !transform.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    throw new ProviderError('image_invalid', 'transform_to_canonical must be 9 finite numbers');
  }
  const { width, height } = pngDimensions(raw.bytes);
  const pixel_count = width * height;
  if (budget.pixels_used + pixel_count > budget.max_pixels) {
    throw new ProviderError('image_budget_exceeded', `image pixels exceed the ${budget.max_pixels} pixel budget`);
  }
  return {
    kind: request.kind,
    region: request.region,
    object_id: request.object_id,
    bytes: raw.bytes,
    mime: 'image/png',
    width,
    height,
    transform_to_canonical: [...transform],
    pixel_count,
    privacy_fingerprint: privacyFingerprint({
      kind: request.kind,
      region: request.region,
      transform_to_canonical: transform,
      bytes: raw.bytes,
    }),
    data_url: `data:image/png;base64,${Buffer.from(raw.bytes).toString('base64')}`,
  };
}
