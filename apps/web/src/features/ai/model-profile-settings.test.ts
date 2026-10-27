import { afterEach, expect, it, vi } from 'vitest';
import type { AuthEntry, SessionController } from '../../app/session';
import { readRoute } from '../../app/route-state';
import { api, ApiFailure } from '../../lib/t15/api';
import { mountModelProfileSettings, type ModelProfilePreset } from './model-profile-settings';

const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); vi.restoreAllMocks(); document.body.replaceChildren(); });
function mount(request: typeof api.request, platformAdmin = true) {
  const entry: AuthEntry = { kind: 'authenticated', session: { user_id: 'actor', username: 'synthetic', platform_admin: platformAdmin, project_roles: [] }, createdUsername: null };
  const session: SessionController = { getSnapshot: () => entry, subscribe: () => () => {}, login: vi.fn(), bootstrap: vi.fn(), recover: vi.fn(), logout: vi.fn(), refresh: vi.fn(), dispose: vi.fn() };
  const root = document.createElement('div'); document.body.append(root);
  disposers.push(mountModelProfileSettings(root, { session, route: readRoute(new URL('http://localhost/')), navigate: vi.fn(), signal: new AbortController().signal, request, onProfilesChanged: vi.fn() }));
  return root;
}
const preset: ModelProfilePreset = { preset_id: 'synthetic-preset', profile_id: 'synthetic-profile', provider_id: 'openai_api', model_id: 'complete-synthetic-model', auth_kind: 'api_key', capabilities: { image_input: true, tools: true, structured_output: true, bbox_output: false, attributes: true }, configuration_hash: 'a'.repeat(64), configured: false, availability: 'needs_configuration', availability_reason: 'Synthetic only; no model invocation' };

it('keeps unknown preset writes frozen when readback model identity differs despite equal configuration hash', async () => {
  const request = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') throw new TypeError('lost ACK');
    if (_url.startsWith('/api/model-profile-presets')) return { items: [preset], next_cursor: null };
    return { configuration_hash: preset.configuration_hash, profile: { ...preset, model_id: 'different-model' } };
  });
  const root = mount(request as typeof api.request);
  const select = root.querySelector<HTMLSelectElement>('select')!;
  await vi.waitFor(() => expect(select.options.length).toBe(2)); select.value = preset.preset_id; select.dispatchEvent(new Event('change'));
  const save = root.querySelector<HTMLButtonElement>('[data-testid="model-preset-save"]')!; save.click();
  await vi.waitFor(() => expect(select.disabled).toBe(true));
  await vi.waitFor(() => expect(root.textContent).toContain('配置写入结果未知'));
  root.querySelector<HTMLButtonElement>('[data-testid="model-preset-read"]')!.click();
  await vi.waitFor(() => expect(root.textContent).toContain('身份或配置不匹配'));
  expect(save.disabled).toBe(true); expect(request.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
  expect(root.querySelector('input[type=password],input[type=file]')).toBeNull();
});

it('shows the confirmed preset as configured after reconciling a lost save response', async () => {
  const request = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') throw new TypeError('lost ACK');
    if (_url.startsWith('/api/model-profile-presets')) return { items: [preset], next_cursor: null };
    return { configuration_hash: preset.configuration_hash, profile: { ...preset } };
  });
  const root = mount(request as typeof api.request), select = root.querySelector<HTMLSelectElement>('select')!;
  await vi.waitFor(() => expect(select.options.length).toBe(2));
  select.value = preset.preset_id; select.dispatchEvent(new Event('change'));
  const save = root.querySelector<HTMLButtonElement>('[data-testid="model-preset-save"]')!;
  save.click();
  await vi.waitFor(() => expect(root.textContent).toContain('配置写入结果未知'));
  root.querySelector<HTMLButtonElement>('[data-testid="model-preset-read"]')!.click();
  await vi.waitFor(() => expect(root.textContent).toContain('已只读核实同一配置已保存'));
  expect(root.textContent).toContain('已配置相同哈希');
  expect(save.disabled).toBe(true);
  expect(request.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
});

it('leaves manual annotation available with an empty preset list and never auto-saves', async () => {
  const request = vi.fn(async () => ({ items: [], next_cursor: null }));
  const root = mount(request as typeof api.request);
  await vi.waitFor(() => expect(root.textContent).toContain('尚无固定预设'));
  expect(root.querySelector<HTMLButtonElement>('[data-testid="model-preset-save"]')!.disabled).toBe(true);
  expect(request).toHaveBeenCalledTimes(1); expect(root.textContent).toContain('人工标注仍可继续');
});

it('does not read private presets for a non-platform administrator', () => {
  const request = vi.fn(); const root = mount(request as typeof api.request, false);
  expect(request).not.toHaveBeenCalled(); expect(root.querySelector('select')).toBeNull(); expect(root.textContent).toContain('人工标注不依赖 AI');
});

it.each(['forbidden', 'network'] as const)('keeps stale preset identity readonly after a %s refresh failure until a complete successful reload', async failure => {
  let reads = 0;
  const request = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') return { ...preset };
    reads++;
    if (reads === 2) throw failure === 'forbidden' ? new ApiFailure(403, 'FORBIDDEN', 'forbidden') : new TypeError('network unavailable');
    return { items: [preset], next_cursor: null };
  });
  const root = mount(request as typeof api.request), select = root.querySelector<HTMLSelectElement>('select')!;
  await vi.waitFor(() => expect(select.options.length).toBe(2));
  select.value = preset.preset_id; select.dispatchEvent(new Event('change'));
  const save = root.querySelector<HTMLButtonElement>('[data-testid="model-preset-save"]')!, read = root.querySelector<HTMLButtonElement>('[data-testid="model-preset-read"]')!;
  expect(save.disabled).toBe(false); read.click();
  await vi.waitFor(() => expect(root.querySelector('[role="alert"]')!.textContent).not.toBe(''));
  expect(save.disabled).toBe(true); save.click();
  expect(request.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
  read.click();
  await vi.waitFor(() => expect(save.disabled).toBe(false)); save.click();
  await vi.waitFor(() => expect(request.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1));
});
