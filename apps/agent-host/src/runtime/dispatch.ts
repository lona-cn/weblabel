import type { RunEvent } from '../../../../packages/contracts/generated/RunEvent';
import type { ModelProfile } from '../../../../packages/contracts/generated/ModelProfile';
import { ProviderRegistry, RegistryError } from '../registry';
import { ServerRuntimeContext, type RuntimeBinding } from './context';
import { createOpenAiApiAdapter, type OpenAiApiAdapterConfig } from '../providers/openai-api';
import { createAnthropicApiAdapter, type AnthropicApiAdapterConfig } from '../providers/anthropic-api';
import { createMiMoApiAdapter, type MiMoApiAdapterConfig } from '../providers/mimo-api';
import { type CodexLocalOptions } from '../providers/codex/adapter';
import { createClaudeLocalAdapter, createStdioClaudeTransport, type ClaudeLocalOptions } from '../providers/claude/adapter';
import { DetectorLocalAdapter, type DetectorLocalOptions } from "../providers/detector-local";
type ProviderConfiguration =
  | { provider: 'openai_api'; config: OpenAiApiAdapterConfig }
  | { provider: 'anthropic_api'; config: AnthropicApiAdapterConfig }
  | { provider: 'mimo_api'; config: MiMoApiAdapterConfig }
  | { provider: 'codex_local'; config: Omit<CodexLocalOptions, 'transport' | 'imageSource' | 'runToken'> }
  | { provider: 'claude_local'; config: Omit<ClaudeLocalOptions, 'transport' | 'imageSource' | 'runToken'> }
  | { provider: 'detector_local'; config: Omit<DetectorLocalOptions, 'imageSource'> };
export interface HostConfiguration { apiBase: string; providers: ProviderConfiguration[]; timeoutMs: number }

/** Config is service-owned, never part of the browser StartRunRequest. */
export function providerDispatch(config: HostConfiguration, token: string): (payload: unknown, signal: AbortSignal) => AsyncIterable<RunEvent> {
  return async function* (raw, signal) {
    const payload = raw as Omit<RuntimeBinding, 'apiBase' | 'token'> & { profile: ModelProfile; execution_profile_config: Record<string, unknown>; profile_configuration_hash: string };
    if (!payload?.request || !payload.profile || payload.profile.profile_id !== payload.request.profile_id) throw new RegistryError('invalid_payload');
    if (!payload.execution_profile_config || Array.isArray(payload.execution_profile_config) || typeof payload.execution_profile_config !== 'object' || typeof payload.profile_configuration_hash !== 'string') throw new RegistryError('invalid_payload');
    const binding = { apiBase: config.apiBase, token, run_id: payload.run_id, request: payload.request };
    const ctx = await ServerRuntimeContext.open(binding, signal);
    // The trusted Rust parent authorizes this exact persisted snapshot and sends
    // it only over its private host pipe, never the bearer agent-tools surface.
    // Host JSON must mirror that exact approved configuration; it cannot supply
    // unapproved model, endpoint, budgets, mappings, or launch parameters.
    const matches = config.providers.filter(entry => entry.provider === payload.profile.provider_id && canonical(entry.config) === canonical(payload.execution_profile_config));
    if (matches.length !== 1 || hasPrivateValues(payload.execution_profile_config)) throw new RegistryError('profile_configuration_changed');
    const selected = { provider: matches[0].provider, config: payload.execution_profile_config } as ProviderConfiguration;
    const registry = new ProviderRegistry();
    const imageSource = () => {
      if (!ctx.allow_image || ctx.approved_grant_ids.length !== 1) throw new RegistryError('image_grant_missing');
      return { grant_id: ctx.approved_grant_ids[0], region: ctx.approved_image_region };
    };
    for (const [index, entry] of [selected].entries()) {
      switch (entry.provider) {
        case "openai_api": registry.register(String(index), createOpenAiApiAdapter({ ...entry.config, secret_env: process.env })); break;
        case "anthropic_api": registry.register(String(index), createAnthropicApiAdapter({ ...entry.config, secret_env: process.env })); break;
        case "mimo_api": registry.register(String(index), createMiMoApiAdapter({ ...entry.config, secret_env: process.env })); break;
        case "codex_local": throw new RegistryError('UNSUPPORTED_RUNTIME', 'verified native tool confinement is unavailable for this Codex runtime');
        case "claude_local": registry.register(String(index), createClaudeLocalAdapter({ ...entry.config, permissions: { ...entry.config.permissions, apiBase: config.apiBase, source_env: process.env }, transport: createStdioClaudeTransport, imageSource, runToken: () => token })); break;
        case "detector_local": registry.register(String(index), new DetectorLocalAdapter({ ...entry.config, imageSource })); break;
        default: throw new RegistryError("unknown_provider");
      }
    }
    const resolved = await registry.resolve(payload.request.profile_id);
    if (resolved.profile.provider_id !== payload.profile.provider_id || resolved.profile.model_id !== payload.profile.model_id || resolved.profile.auth_kind !== payload.profile.auth_kind) throw new RegistryError('profile_configuration_changed');
    const input = ctx.allow_object_context ? payload.request : { ...payload.request, context: { ...payload.request.context, selected_object_ids: [], object_hashes: {} } };
    let lastSeq = -1;
    let terminal = false;
    let events = 0;
    for await (const event of resolved.adapter.run(input, ctx, signal)) {
      if (signal.aborted) return;
      if (++events > 4096 || terminal || event.run_id !== payload.run_id || !Number.isSafeInteger(event.seq) || event.seq <= lastSeq) throw new RegistryError('invalid_provider_protocol');
      lastSeq = event.seq;
      terminal = ['succeeded', 'failed', 'cancelled'].includes(event.type);
      yield event;
    }
    if (!terminal && !signal.aborted) throw new RegistryError('missing_terminal_response');
  };
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
function hasPrivateValues(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => ['secret_env', 'source_env', 'fetch_impl', 'transport', 'runToken', 'imageSource'].includes(key) || hasPrivateValues(item));
}
