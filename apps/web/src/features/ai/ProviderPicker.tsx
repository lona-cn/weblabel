import type { ModelProfile } from '../../../../../packages/contracts/generated/ModelProfile';

const PROVIDERS: Record<ModelProfile['provider_id'], string> = {
  codex_local: 'Codex local', claude_local: 'Claude local', openai_api: 'OpenAI API',
  anthropic_api: 'Anthropic API', mimo_api: 'MiMo API', detector_local: 'Local detector', mock: 'Mock source',
};
const AUTH: Record<ModelProfile['auth_kind'], string> = {
  official_user_login: 'Official user login', api_key: 'API key', local_weights: 'Local weights', none: 'No authentication',
};
const VERIFICATION: Record<ModelProfile['verification'], string> = {
  not_run: 'Not verified', mock_only: 'Mock only', live_passed: 'Live verified', live_failed: 'Live verification failed',
};
const AVAILABILITY: Record<ModelProfile['availability'], string> = {
  ready: 'Ready', needs_login: 'Needs login', needs_configuration: 'Needs configuration', unsupported: 'Unsupported', blocked: 'Blocked',
};

export function ProviderPicker({ profiles, selected, onSelect, disabled = false }: {
  profiles: readonly ModelProfile[];
  selected: string | null;
  onSelect: (profile: ModelProfile) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset data-testid="ai-provider" disabled={disabled}>
      <legend>Model profile</legend>
      <div role="radiogroup" aria-label="Available model profiles">
        {profiles.map((profile) => (
          <label key={profile.profile_id}>
            <input type="radio" name="ai-profile" value={profile.profile_id} checked={selected === profile.profile_id} onChange={() => onSelect(profile)} />
            <span>{PROVIDERS[profile.provider_id]} · {profile.model_id}</span>
            <span>{AUTH[profile.auth_kind]}</span>
            <span>{AVAILABILITY[profile.availability]}</span>
            <span>{VERIFICATION[profile.verification]}</span>
            {profile.runtime_version ? <span>Runtime {profile.runtime_version}</span> : null}
          </label>
        ))}
        {profiles.length === 0 ? <p role="status">No model profiles are available from the server.</p> : null}
      </div>
    </fieldset>
  );
}
