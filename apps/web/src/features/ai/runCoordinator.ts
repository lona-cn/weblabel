import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { ModelProfile } from '../../../../../packages/contracts/generated/ModelProfile';
import type { RunContext } from '../../../../../packages/contracts/generated/RunContext';
import type { SaveQueue } from '../../lib/persistence/save-queue';

export interface RunFreezeInput {
  asset_revision_id: string;
  ontology_version_id: string;
  saveQueue: SaveQueue;
  getDocument: () => AnnotationDocument | null;
  getGeneration: () => number | null;
  refreshContext: (snapshot: { document: AnnotationDocument; generation: number; annotation_revision_id: string }) => RunContext | Promise<RunContext>;
}

export interface ConsentBinding {
  profile: ModelProfile;
  context: RunContext;
  intent: string;
  prompt: string;
  grants: { image: boolean; selected_objects: boolean; crop: null | { x_min: number; y_min: number; x_max: number; y_max: number } };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export async function inputFingerprint(binding: ConsentBinding): Promise<string> {
  const { profile, context, intent, prompt, grants } = binding;
  const bytes = new TextEncoder().encode(stable({
    project_id: context.project_id,
    media_sha256: context.canonical_sha256,
    asset_revision_id: context.asset_revision_id,
    draft_generation: context.draft_generation,
    region: grants.crop,
    grants,
    selected_object_ids: [...context.selected_object_ids].sort(),
    object_hashes: context.object_hashes,
    annotation_revision_id: context.annotation_revision_id,
    ontology_version_id: context.ontology_version_id,
    profile: {
      profile_id: profile.profile_id,
      provider_id: profile.provider_id,
      model_id: profile.model_id,
      auth_kind: profile.auth_kind,
      capabilities: profile.capabilities,
      availability: profile.availability,
      verification: profile.verification,
      runtime_version: profile.runtime_version,
      verified_at: profile.verified_at,
    },
    intent,
    prompt,
  }));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function freezeAfterFlush(input: RunFreezeInput): Promise<{ context: RunContext; document: AnnotationDocument; generation: number }> {
  await input.saveQueue.flush(input.asset_revision_id);
  const document = input.getDocument();
  const generation = input.getGeneration();
  if (!document || generation === null || document.asset_revision_id !== input.asset_revision_id ||
    document.ontology_version_id !== input.ontology_version_id) {
    throw new Error('Editor snapshot does not match the active asset and ontology; no run was started.');
  }
  const status = input.saveQueue.getStatus(input.asset_revision_id);
  if (status.dirty || status.writes_paused || status.phase !== 'synced' ||
    status.synced_generation !== generation || !status.base_revision_id) {
    throw new Error('The latest editor generation is not acknowledged by the save queue; no run was started.');
  }
  const context = await input.refreshContext({ document, generation, annotation_revision_id: status.base_revision_id });
  if (context.asset_revision_id !== input.asset_revision_id || context.annotation_revision_id !== status.base_revision_id ||
    context.ontology_version_id !== document.ontology_version_id || context.draft_generation !== generation) {
    throw new Error('Refreshed AI context does not match the acknowledged editor snapshot; no run was started.');
  }
  return { context, document, generation };
}

export function matchesConsent(consent: { approved_fingerprint: string } | null | undefined, context: { input_fingerprint: string }): boolean {
  return consent?.approved_fingerprint === context.input_fingerprint;
}
