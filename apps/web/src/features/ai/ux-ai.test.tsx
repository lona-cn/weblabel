// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CandidateList } from './CandidateList';
import type { CandidateEntry } from './useRun';
import type { RejectionState } from './rejections';
import { ModelProfileSettings } from './ModelProfileSettings';
import { Consent } from './Consent';
import { OutcomeSummary } from './OutcomeSummary';
import { api } from '../../lib/t15/api';
afterEach(cleanup);
const context = { project_id: 'project', asset_revision_id: 'asset', annotation_revision_id: 'revision', ontology_version_id: 'ontology', canonical_sha256: 'hash', draft_generation: 1, input_fingerprint: 'input', selected_object_ids: [], object_hashes: {} };
const object = { object_id: 'object', label_id: 'person', geometry: { type: 'bbox_xyxy' as const, x_min: 2, y_min: 3, x_max: 20, y_max: 30 }, attributes: {}, origin: { type: 'prediction' as const, prediction_id: 'prediction', model_run_id: 'run', import_batch_id: null } };
const entry: CandidateEntry = { key: 'entry', asset_revision_id: 'asset', run_id: 'run', run_context: context, candidate: { suggestion_set_id: 'set', model_run_id: 'run', prediction_id: 'prediction', context, changes: [{ kind: 'create', change_id: 'change', object, reason: 'candidate', before_hash: null }], state: 'pending', issues: [], score: null }, schema_error: null, objects: new Map(), fixedDocument: { schema_version: 1, asset_revision_id: 'asset', ontology_version_id: 'ontology', coordinate_space: { type: 'canonical_image_pixels', width: 100, height: 100 }, completion: 'in_progress', objects: [] }, fixedOntology: { ontology_version_id: 'ontology', project_id: 'project', version_no: 1, labels: [{ label_id: 'person', name: '人员', color: '#ffffff', shortcut: null, allowed_geometry_types: ['bbox_xyxy'], attributes: [] }], guidelines_markdown: '', allow_out_of_bounds: false } };
const state = (ids: string[] = []): RejectionState => ({ suggestion_set_id: 'set', rejected_change_ids: ids, operations: [], next_cursor: null });
it('loads persistent per-change rejection state and never offers rejected changes for acceptance', async () => {
  const accept = vi.fn();
  render(<CandidateList entries={[entry]} activeAsset="asset" activeContext={context} busy={false} onAccept={accept} decisionApi={{ read: async () => state(['change']), reject: vi.fn() }} />);
  await screen.findByText('已拒绝（服务器记录）');
  expect(screen.getByLabelText('选择建议 change')).toHaveProperty('disabled', true);
  expect(screen.getByText('人员')).toBeTruthy();
  expect(accept).not.toHaveBeenCalled();
});
it('keeps an unknown rejection operation and checks its receipt using GET without a second write', async () => {
  const read = vi.fn(async (_set: string, op?: string) => op ? { ...state(['change']), operations: [{ operation_id: op, change_ids: ['change'], created_at: 'now' }] } : state());
  const reject = vi.fn(async () => { throw new TypeError('connection lost'); });
  render(<CandidateList entries={[entry]} activeAsset="asset" activeContext={context} busy={false} onAccept={vi.fn()} decisionApi={{ read, reject }} />);
  await waitFor(() => expect(screen.getByLabelText('选择建议 change')).toHaveProperty('disabled', false));
  fireEvent.click(screen.getByRole('button', { name: '拒绝此项' }));
  await screen.findByText(/拒绝结果未知/);
  fireEvent.click(screen.getByRole('button', { name: '只读核对拒绝' }));
  await screen.findByText('已拒绝（服务器记录）');
  expect(reject).toHaveBeenCalledTimes(1);
  expect(read.mock.calls.some(call => Boolean(call[1]))).toBe(true);
});
it('does not fetch platform presets for a non-administrator', () => {
  const request = vi.fn();
  render(<ModelProfileSettings platformAdmin={false} request={request} onProfilesChanged={vi.fn()} />);
  expect(screen.getByText(/仅平台管理员/)).toBeTruthy();
  expect(request).not.toHaveBeenCalled();
});

it('saves only the selected configuration hash and reconciles an unknown PUT by read only GET', async () => {
  const refreshed = vi.fn();
  const preset = { preset_id: 'preset', profile_id: 'profile', provider_id: 'openai_api', model_id: 'exact-model', auth_kind: 'api_key', configuration_hash: 'hash', configured: false, capabilities: { image_input: true, tools: true, structured_output: true, bbox_output: false, attributes: true }, availability: 'ready', availability_reason: 'Explicit account evidence; live verification not run' };
  const request = vi.fn(async <T,>(url: string, init: RequestInit = {}): Promise<T> => {
    if (init.method === 'PUT') throw new TypeError('connection lost after write');
    if (url.startsWith('/api/model-profile-presets')) return { items: [preset], next_cursor: null } as T;
    if (url === '/api/model-profiles/profile') return { profile: { ...preset, verification: 'not_run', verified_at: null }, configuration_hash: 'hash' } as T;
    throw new Error('Unexpected request');
  });
  render(<ModelProfileSettings platformAdmin request={request as typeof api.request} onProfilesChanged={refreshed} />);
  await screen.findByRole('option', { name: 'profile · openai_api · exact-model' });
  expect(request.mock.calls.every(call => call[1]?.method !== 'PUT')).toBe(true);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'preset' } });
  fireEvent.click(screen.getByRole('button', { name: '明确保存所选预设' }));
  await screen.findByText(/配置写入结果未知/);
  const writes = request.mock.calls.filter(call => call[1]?.method === 'PUT');
  expect(writes).toHaveLength(1);
  expect(JSON.parse(String(writes[0]![1]!.body))).toEqual({ configuration_hash: 'hash' });
  fireEvent.click(screen.getByRole('button', { name: '只读核对配置' }));
  await screen.findByText(/已只读核实同一配置已保存/);
  expect(request.mock.calls.filter(call => call[1]?.method === 'PUT')).toHaveLength(1);
  expect(refreshed).toHaveBeenCalledTimes(1);
});
it('reports partial cross-set rejection success without claiming atomicity', async () => {
  const second = { ...entry, key: 'second', candidate: { ...entry.candidate, suggestion_set_id: 'second-set' } };
  const reject = vi.fn(async (setId: string, payload: { operation_id: string; change_ids: string[] }) => {
    if (setId === 'second-set') throw new TypeError('unknown');
    return { ...payload, created_at: 'now', suggestion_set_id: setId };
  });
  render(<CandidateList entries={[entry, second]} activeAsset="asset" activeContext={context} busy={false} onAccept={vi.fn()} decisionApi={{ read: async setId => ({ ...state(), suggestion_set_id: setId }), reject }} />);
  await waitFor(() => expect(screen.getAllByRole('checkbox').every(input => !(input as HTMLInputElement).disabled)).toBe(true));
  for (const input of screen.getAllByRole('checkbox')) fireEvent.click(input);
  fireEvent.click(screen.getByRole('button', { name: '跨组拒绝所选（独立请求）' }));
  await screen.findByText(/非原子操作：1 组成功，0 组明确失败，1 组结果未知/);
  expect(reject).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: '只读核对拒绝' })).toBeTruthy();
});
it('projects the actual server crop and semantic object scope without changing authorization payload', () => {
  const doc = { ...entry.fixedDocument!, objects: [object] };
  const preview = { preview_id: 'preview', profile: { profile_id: 'profile', provider_id: 'claude_local' as const, model_id: 'unknown', auth_kind: 'official_user_login' as const, capabilities: { image_input: true, tools: true, structured_output: true, bbox_output: false, attributes: true }, availability: 'needs_login' as const, verification: 'not_run' as const, runtime_version: null, verified_at: null }, context, intent: 'audit_attributes' as const, prompt: 'audit', request: { operation_id: 'op', profile_id: 'profile', intent: 'audit_attributes' as const, context, prompt: 'audit', consent_id: null, batch_items: null }, grants: { allow_image: true, allow_object_context: true, preview_crop: { type: 'bbox_xyxy' as const, x_min: 2, y_min: 3, x_max: 20, y_max: 30 } }, input_fingerprint: 'input', execution_configuration_hash: 'hash', expires_at: 'later' };
  const original = structuredClone(preview);
  render(<Consent preview={preview} document={doc} ontology={entry.fixedOntology} confirmed={false} onChange={vi.fn()} />);
  expect(screen.getByRole('img').getAttribute('viewBox')).toBe('2 3 18 27');
  expect(screen.getByText(/人员 #1/)).toBeTruthy();
  expect(screen.getByText(/本地启动不等于模型在本机推理/)).toBeTruthy();
  expect(preview).toEqual(original);
});
it('shows unknown effort and costs and links to exact saved revision and matched review', async () => {
  const request = vi.fn(async <T,>(): Promise<T> => ({ run: { run_id: 'run', project_id: 'project/a?', state: 'succeeded', cost_display: 'unknown' }, candidate_change_count: 2, accepted_change_count: 1, accept_journal_count: 2, revert_journal_count: 1, rejected_change_count: 1, object_observations: [], task_binding: { basis: 'exact_decision_revision_submission', submissions: [{ task_id: 'task', task_state: 'submitted', review_id: 'review/a?', review_state: 'pending', annotation_revision_id: 'revision/a?', asset_revision_id: 'asset/a?', ontology_version_id: 'ontology/a?', decision_kinds: ['accept'], suggestion_set_ids: ['set'] }], truncated: false }, activity_task_bindings: [], recorded_work_seconds: null, work_time_scope: 'current_actor_explicit_run_intervals', work_time_reason: 'no_explicit_run_intervals', usage: null, cost_display: 'unknown' }) as T);
  render(<OutcomeSummary runId="run" request={request as typeof api.request} />);
  await screen.findByText('费用未知，不填零。');
  expect(screen.getByText(/没有可归属于此 run 的工时记录/)).toBeTruthy();
  expect(screen.getByRole('link', { name: /查看匹配的保存版本/ }).getAttribute('href')).toBe('/?project_id=project%2Fa%3F&asset_revision_id=asset%2Fa%3F&ontology_version_id=ontology%2Fa%3F&annotation_revision_id=revision%2Fa%3F');
  expect(screen.getByRole('link', { name: /打开项目审核队列/ }).getAttribute('href')).toBe('/?project_id=project%2Fa%3F&review_queue=all');
});


it('clears cross-set selection only after an unknown rejection is verified by its real receipt', async () => {
  const second = { ...entry, key: 'second', candidate: { ...entry.candidate, suggestion_set_id: 'second-set' } };
  const read = async (setId: string, operationId?: string) => ({ suggestion_set_id: setId, rejected_change_ids: operationId ? ['change'] : [], operations: operationId ? [{ operation_id: operationId, change_ids: ['change'], created_at: 'now' }] : [], next_cursor: null });
  render(<CandidateList entries={[entry, second]} activeAsset="asset" activeContext={context} busy={false} onAccept={vi.fn()} decisionApi={{ read, reject: async () => { throw new TypeError('connection lost'); } }} />);
  await waitFor(() => expect(screen.getAllByRole('checkbox')[0]).toHaveProperty('disabled', false));
  fireEvent.click(screen.getAllByRole('checkbox')[0]!);
  fireEvent.click(screen.getAllByRole('button', { name: '拒绝所选建议' })[0]!);
  await screen.findByText(/拒绝结果未知/);
  fireEvent.click(screen.getByRole('button', { name: '只读核对拒绝' }));
  await screen.findByText('已拒绝（服务器记录）');
  expect(screen.getByRole('button', { name: '跨组拒绝所选（独立请求）' })).toHaveProperty('disabled', true);
});


it.each(['profile_id', 'provider_id', 'model_id', 'auth_kind', 'image_input', 'tools', 'structured_output', 'bbox_output', 'attributes', 'missing_profile', 'missing_capabilities', 'configuration_hash'])('retains unknown write when saved identity differs: %s', async field => {
  const preset = { preset_id: 'preset', profile_id: 'profile', provider_id: 'openai_api', model_id: 'exact-model', auth_kind: 'api_key', configuration_hash: 'hash', configured: false, capabilities: { image_input: true, tools: true, structured_output: true, bbox_output: false, attributes: true }, availability: 'ready', availability_reason: 'not verified' };
  const saved: Record<string, unknown> = { profile: { ...preset, capabilities: { ...preset.capabilities }, verification: 'not_run', verified_at: null }, configuration_hash: 'hash' };
  const profile = saved.profile as Record<string, unknown>;
  if (field === 'missing_profile') delete saved.profile;
  else if (field === 'missing_capabilities') delete profile.capabilities;
  else if (field === 'configuration_hash') saved.configuration_hash = 'other';
  else if (field in preset.capabilities) (profile.capabilities as Record<string, unknown>)[field] = !(preset.capabilities as Record<string, boolean>)[field];
  else profile[field] = 'other';
  const refreshed = vi.fn();
  const request = vi.fn(async <T,>(url: string, init: RequestInit = {}): Promise<T> => {
    if (init.method === 'PUT') throw new TypeError('lost response');
    if (url.startsWith('/api/model-profile-presets')) return { items: [preset], next_cursor: null } as T;
    if (url === '/api/model-profiles/profile') return saved as T;
    throw new Error('Unexpected request');
  });
  render(<ModelProfileSettings platformAdmin request={request as typeof api.request} onProfilesChanged={refreshed} />);
  await screen.findByRole('option', { name: 'profile · openai_api · exact-model' });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'preset' } });
  fireEvent.click(screen.getByRole('button', { name: '明确保存所选预设' }));
  await screen.findByText(/配置写入结果未知/);
  fireEvent.click(screen.getByRole('button', { name: '只读核对配置' }));
  await waitFor(() => expect(request.mock.calls.filter(call => call[0] === '/api/model-profiles/profile' && call[1]?.method !== 'PUT')).toHaveLength(1));
  await waitFor(() => expect(screen.getByRole('button', { name: '只读核对配置' })).toHaveProperty('disabled', false));
  expect(screen.getByRole('button', { name: '明确保存所选预设' })).toHaveProperty('disabled', true);
  expect(refreshed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '只读核对配置' }));
  await waitFor(() => expect(request.mock.calls.filter(call => call[0] === '/api/model-profiles/profile' && call[1]?.method !== 'PUT')).toHaveLength(2));
  expect(request.mock.calls.filter(call => call[1]?.method === 'PUT')).toHaveLength(1);
  expect(request.mock.calls.every(call => call[0].startsWith('/api/model-profile'))).toBe(true);
});


it('reconciles against the submitted immutable preset rather than later mutated discovery data', async () => {
  const preset = { preset_id: 'preset', profile_id: 'profile', provider_id: 'openai_api', model_id: 'original', auth_kind: 'api_key', configuration_hash: 'hash', configured: false, capabilities: { image_input: true, tools: true, structured_output: true, bbox_output: false, attributes: true }, availability: 'ready', availability_reason: 'not verified' };
  const original = { ...preset, capabilities: { ...preset.capabilities } };
  const refreshed = vi.fn();
  const request = vi.fn(async <T,>(url: string, init: RequestInit = {}): Promise<T> => {
    if (init.method === 'PUT') { preset.model_id = 'mutated'; preset.capabilities.tools = false; throw new TypeError('lost response'); }
    if (url.startsWith('/api/model-profile-presets')) return { items: [preset], next_cursor: null } as T;
    if (url === '/api/model-profiles/profile') return { profile: original, configuration_hash: 'hash' } as T;
    throw new Error('Unexpected request');
  });
  render(<ModelProfileSettings platformAdmin request={request as typeof api.request} onProfilesChanged={refreshed} />);
  await screen.findByRole('option', { name: 'profile · openai_api · original' });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'preset' } });
  fireEvent.click(screen.getByRole('button', { name: '明确保存所选预设' }));
  await screen.findByText(/配置写入结果未知/);
  fireEvent.click(screen.getByRole('button', { name: '只读核对配置' }));
  await waitFor(() => expect(refreshed).toHaveBeenCalledTimes(1));
  expect(request.mock.calls.filter(call => call[1]?.method === 'PUT')).toHaveLength(1);
});


it('focuses a stale same-scope candidate without accepting or recording a decision', async () => {
  const focus = vi.fn(() => true), accept = vi.fn(), reject = vi.fn();
  const stale: CandidateEntry = { ...entry, candidate: { ...entry.candidate, state: 'stale' } };
  render(<CandidateList entries={[stale]} activeAsset="asset" activeContext={context} busy={false} onAccept={accept} onFocusRegion={focus} decisionApi={{ read: async () => state(), reject }} />);
  fireEvent.click(screen.getByRole('button', { name: '定位主画布 change' }));
  expect(focus).toHaveBeenCalledWith(object.geometry);
  expect(screen.getByRole('button', { name: '采纳所选建议' })).toHaveProperty('disabled', true);
  expect(accept).not.toHaveBeenCalled();
  expect(reject).not.toHaveBeenCalled();
});


it.each(['project_id', 'asset_revision_id', 'ontology_version_id', 'canonical_sha256'] as const)('prevents foreign %s from focusing the current canvas', field => {
  const focus = vi.fn(() => true);
  const active = { ...context, [field]: 'foreign' };
  render(<CandidateList entries={[entry]} activeAsset={active.asset_revision_id} activeContext={active} busy={false} onAccept={vi.fn()} onFocusRegion={focus} decisionApi={{ read: async () => state(), reject: vi.fn() }} />);
  const button = screen.getByRole('button', { name: '定位主画布 change' });
  expect(button).toHaveProperty('disabled', true);
  fireEvent.click(button);
  expect(focus).not.toHaveBeenCalled();
});
it('does not focus schema failures and hides canvas controls when standalone', () => {
  const focus = vi.fn(() => true);
  const props = { entries: [{ ...entry, schema_error: 'invalid geometry' }], activeAsset: 'asset', activeContext: context, busy: false, onAccept: vi.fn(), decisionApi: { read: async () => state(), reject: vi.fn() } };
  const view = render(<CandidateList {...props} onFocusRegion={focus} />);
  fireEvent.click(screen.getByRole('button', { name: '定位主画布 change' }));
  expect(focus).not.toHaveBeenCalled();
  view.rerender(<CandidateList {...props} />);
  expect(screen.queryByRole('button', { name: '定位主画布 change' })).toBeNull();
});
it('uses frozen original object geometry for attribute suggestions and reports native no-op', () => {
  const focus = vi.fn(() => false);
  const attributes: CandidateEntry = { ...entry, objects: new Map([[object.object_id, object]]), candidate: { ...entry.candidate, changes: [{ kind: 'set_attributes', change_id: 'attr', object_id: object.object_id, values: {}, before_hash: 'hash', reason: 'compare' }] } };
  render(<CandidateList entries={[attributes]} activeAsset="asset" activeContext={context} busy={false} onAccept={vi.fn()} onFocusRegion={focus} decisionApi={{ read: async () => state(), reject: vi.fn() }} />);
  fireEvent.click(screen.getByRole('button', { name: '定位主画布 attr' }));
  expect(focus).toHaveBeenCalledWith(object.geometry);
  expect(screen.getByText('当前主画布或建议区域不可用，未改变视图。')).toBeTruthy();
});

