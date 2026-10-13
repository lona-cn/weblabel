import type { ModelProfile } from '../../../../../packages/contracts/generated/ModelProfile';

const PROVIDERS: Record<Exclude<ModelProfile['provider_id'], 'codex_local'>, string> = {
  claude_local: 'Claude 本地运行', openai_api: 'OpenAI API',
  anthropic_api: 'Anthropic API', mimo_api: 'MiMo API', detector_local: '本地检测器', mock: '模拟结果（非真实模型）',
};
const AUTH: Record<ModelProfile['auth_kind'], string> = {
  official_user_login: '官方账户登录', api_key: 'API 密钥', local_weights: '本地模型权重', none: '无需登录',
};
const VERIFICATION: Record<ModelProfile['verification'], string> = {
  not_run: '未验证', mock_only: '仅模拟验证', live_passed: '真实运行已验证', live_failed: '真实运行验证失败',
};
const AVAILABILITY: Record<ModelProfile['availability'], string> = {
  ready: '可用', needs_login: '需要登录', needs_configuration: '需要配置', unsupported: '暂不支持', blocked: '已阻止',
};

export function ProviderPicker({ profiles, selected, onSelect, disabled = false }: {
  profiles: readonly ModelProfile[];
  selected: string | null;
  onSelect: (profile: ModelProfile) => void;
  disabled?: boolean;
}) {
  const activeProfiles = profiles.filter((profile): profile is ModelProfile & { provider_id: Exclude<ModelProfile['provider_id'], 'codex_local'> } => profile.provider_id !== 'codex_local');
  return (
    <fieldset data-testid="ai-provider" disabled={disabled}>
      <legend>模型</legend>
      <div role="radiogroup" aria-label="可选模型">
        {activeProfiles.map((profile) => (
          <div key={profile.profile_id}><label>
            <input type="radio" name="ai-profile" value={profile.profile_id} checked={selected === profile.profile_id} onChange={() => onSelect(profile)} />
            <span>{PROVIDERS[profile.provider_id]} · {profile.model_id}</span>
            <span>{AUTH[profile.auth_kind]}</span>
            <span>{AVAILABILITY[profile.availability]}</span>
            <span>{VERIFICATION[profile.verification]}</span>
          </label>
          {profile.verification === 'not_run' ? <p>尚未验收；配置就绪不代表真实运行已验证。</p> : null}
          {profile.availability !== 'ready' ? <p>{profile.availability === 'needs_login' ? '请本机操作者确认官方客户端本人登录；此页面不代登录。' : profile.availability === 'blocked' ? '缺少明确能力或策略证据；先由管理员核对固定配置。' : '请本机操作者核对运行时、私有配置与本地权重。重新检查不会执行模型。'}人工流程仍可继续。</p> : null}
          {profile.runtime_version ? <details><summary>运行版本</summary>{profile.runtime_version}</details> : null}</div>
        ))}
        {activeProfiles.length === 0 ? <p role="status">服务器尚无可用模型配置。人工标注可继续；平台管理员可选择服务端已准备的固定预设，不需要提交 token。</p> : null}
      </div>
    </fieldset>
  );
}
