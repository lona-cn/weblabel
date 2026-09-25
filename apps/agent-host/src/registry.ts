//! ProviderAdapter registration and probe abstraction (docs/contracts.md C5).
//!
//! Probe results carry two independent dimensions: `availability` (can this
//! channel run at all) and `verification` (what evidence backs it — see
//! docs/provider-compatibility.md). Mock registrations exercise build wiring
//! only; they must never claim real provider identity or live verification.

import type { AnnotationDocument } from '../../../packages/contracts/generated/AnnotationDocument';
import type { BBox } from '../../../packages/contracts/generated/BBox';
import type { Id } from '../../../packages/contracts/generated/Id';
import type { ModelProfile } from '../../../packages/contracts/generated/ModelProfile';
import type { OntologyVersion } from '../../../packages/contracts/generated/OntologyVersion';
import type { RunEvent } from '../../../packages/contracts/generated/RunEvent';
import type { StartRunRequest } from '../../../packages/contracts/generated/StartRunRequest';
import type { SuggestionSet } from '../../../packages/contracts/generated/SuggestionSet';

export class RegistryError extends Error {
  readonly code: string;

  constructor(code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'RegistryError';
    this.code = code;
  }
}

export interface RuntimeReadRegion {
  bytes: Uint8Array;
  mime: 'image/png';
  transform_to_canonical: number[];
}

export interface RuntimeContext {
  run_id: Id;
  read_region(grant_id: Id, region: BBox | null): Promise<RuntimeReadRegion>;
  get_document(): Promise<AnnotationDocument>;
  get_ontology(): Promise<OntologyVersion>;
  submit_candidates(candidate: unknown): Promise<SuggestionSet>;
  report_issues(issues: unknown): Promise<void>;
}

export interface ProviderAdapter {
  probe(): Promise<ModelProfile[]>;
  run(input: StartRunRequest, ctx: RuntimeContext, signal: AbortSignal): AsyncIterable<RunEvent>;
}

const AVAILABILITY: Record<string, true> = {
  ready: true,
  needs_login: true,
  needs_configuration: true,
  unsupported: true,
  blocked: true,
};
const VERIFICATION: Record<string, true> = {
  not_run: true,
  mock_only: true,
  live_passed: true,
  live_failed: true,
};

interface RegistryEntry {
  adapter: ProviderAdapter;
  mock: boolean;
}

function assertProfileShape(key: string, profile: ModelProfile): void {
  if (typeof profile !== 'object' || profile === null) {
    throw new RegistryError('invalid_model_profile', `${key} probe() returned a non-object profile`);
  }
  if (typeof profile.profile_id !== 'string' || profile.profile_id.length === 0) {
    throw new RegistryError('invalid_model_profile', `${key} profile is missing profile_id`);
  }
  if (typeof profile.model_id !== 'string' || profile.model_id.length === 0) {
    throw new RegistryError('invalid_model_profile', `${key} profile is missing model_id`);
  }
  if (AVAILABILITY[profile.availability] !== true) {
    throw new RegistryError('invalid_model_profile', `${key} profile has availability ${JSON.stringify(profile.availability)}`);
  }
  if (VERIFICATION[profile.verification] !== true) {
    throw new RegistryError('invalid_model_profile', `${key} profile has verification ${JSON.stringify(profile.verification)}`);
  }
}

export class ProviderRegistry {
  readonly #adapters = new Map<string, RegistryEntry>();

  register(key: string, adapter: ProviderAdapter, options: { mock?: boolean } = {}): void {
    if (typeof key !== 'string' || key.length === 0) {
      throw new RegistryError('invalid_provider_key', 'registry keys must be non-empty strings');
    }
    if (this.#adapters.has(key)) {
      throw new RegistryError('already_registered', key);
    }
    if (typeof adapter?.probe !== 'function' || typeof adapter?.run !== 'function') {
      throw new RegistryError('invalid_adapter', `${key} must implement probe() and run()`);
    }
    this.#adapters.set(key, { adapter, mock: options.mock === true });
  }

  keys(): string[] {
    return [...this.#adapters.keys()];
  }

  async probeAll(): Promise<ModelProfile[]> {
    const profiles: ModelProfile[] = [];
    for (const [key, entry] of this.#adapters) {
      const produced = await entry.adapter.probe();
      if (!Array.isArray(produced)) {
        throw new RegistryError('invalid_model_profile', `${key} probe() must return an array`);
      }
      for (const profile of produced) {
        assertProfileShape(key, profile);
        if (entry.mock && (profile.provider_id !== 'mock' || profile.verification !== 'mock_only')) {
          throw new RegistryError(
            'mock_registration_misclaim',
            `${key}: mock registrations may only claim provider_id "mock" with verification "mock_only"`,
          );
        }
        profiles.push(profile);
      }
    }
    return profiles;
  }
}
