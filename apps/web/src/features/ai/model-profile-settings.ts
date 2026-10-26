import type { ModelProfile } from '../../../../../packages/contracts/generated/ModelProfile';
import type { PageContext } from '../../ui/page-context';
import { api, ApiFailure } from '../../lib/t15/api';
import { accountScope, el, button, selectField, errorSummary, status, panel, rejected } from '../projects/account-dom';
import '../projects/accounts.css';

export interface ModelProfilePreset {
  preset_id: string; profile_id: string; provider_id: string; model_id: string; auth_kind: string;
  capabilities: ModelProfile['capabilities']; configuration_hash: string; configured: boolean;
  availability: ModelProfile['availability']; availability_reason: string;
}
interface ModelProfilePresetPage { items: ModelProfilePreset[]; next_cursor: string | null }
export interface ModelProfileSettingsContext extends PageContext { onProfilesChanged: () => void | Promise<void>; request?: typeof api.request }
export function mountModelProfileSettings(root: HTMLElement, context: ModelProfileSettingsContext): () => void {
  const page = el('section', undefined, 'accounts-page accounts-models'); page.dataset.testid = 'model-profile-settings'; root.append(page);
  const scope = accountScope(page, context), request = context.request ?? api.request;
  const canManage = () => { const entry = context.session.getSnapshot(); return entry.kind === 'authenticated' && entry.session.platform_admin === true; };
  page.append(el('h1', '本机模型预设管理'), el('p', '只选择本机操作者已准备的固定预设。'));
  if (!canManage()) { const forbidden = status(); forbidden.textContent = '仅平台管理员可以配置模型。人工标注不依赖 AI，可以继续。'; page.append(forbidden); return () => { scope.dispose(); page.remove(); }; }
  let items: ModelProfilePreset[] = [], busy = false, readValid = false, unknown: Readonly<ModelProfilePreset> | null = null;
  const summary = errorSummary(), notice = status(), state = status(), columns = el('div', undefined, 'accounts-preset-columns');
  const choices = panel('固定预设'), detail = panel('固定预设身份与配置');
  const select = selectField('model-preset', '固定预设', [['', '请选择，不会自动保存']]); choices.append(state, select.element, el('p', '没有预设时由本机操作者准备私有配置；读取失败仅只读重查。'));
  const details = el('dl'); detail.append(details);
  const save = button('明确保存所选预设', 'model-preset-save', scope.signal, () => { void savePreset(); }, true);
  const read = button('只读重新检查预设', 'model-preset-read', scope.signal, () => { if (unknown) void reconcile(); else void load(); });
  const actions = el('div', undefined, 'accounts-actions'); actions.append(save, read); columns.append(choices, detail);
  page.append(summary.node, notice, columns, el('p', '本页不接收密钥、路径或启动参数；不登录、不下载权重、不调用模型。人工标注不依赖 AI 配置。'), actions);
  function render() {
    if (!scope.current()) return;
    const preset = unknown ?? items.find(item => item.preset_id === select.control.value);
    select.control.disabled = busy || !!unknown || !readValid; save.disabled = busy || !readValid || !preset || !!unknown || !canManage(); read.disabled = busy;
    read.textContent = unknown ? '只读核对配置' : '只读重新检查预设'; page.setAttribute('aria-busy', String(busy));
    state.textContent = busy ? '正在处理…' : unknown ? '配置写入结果未知：选择已冻结，仅可核对原配置。' : !readValid ? '预设读取尚未核实，仅可只读重新检查；原身份仅作对照。' : items.length ? `${items.length} 个固定预设 · 不会自动保存。` : '尚无固定预设，人工标注仍可继续。';
    details.replaceChildren();
    if (!preset) { details.append(el('dt', '配置状态'), el('dd', '尚未选择固定预设。')); return; }
    const values: [string, string][] = [
      ['preset_id', preset.preset_id], ['profile_id', preset.profile_id], ['provider_id', preset.provider_id], ['model_id', preset.model_id], ['认证', `${preset.auth_kind}（本页不接收凭证）`],
      ['能力', Object.entries(preset.capabilities).map(([key, value]) => `${key}: ${value}`).join(' · ')], ['配置状态', unknown ? '结果未知 · 已冻结选择' : preset.configured ? '已配置相同哈希' : '未配置此预设'],
      ['运行时状态', `${preset.availability} · ${preset.availability_reason}`], ['配置哈希 · SHA-256', preset.configuration_hash], ['真实验收', '配置就绪不等于真实运行验收通过。本次没有调用模型。'], ['策略与数据授权', '仍受项目权限和每次运行的实际服务器授权预览约束。'],
    ];
    for (const [key, text] of values) details.append(el('dt', key), el('dd', text));
  }
  async function load() {
    if (busy || unknown || !scope.current() || !canManage()) return; busy = true; readValid = false; summary.set(null); render();
    try {
      const found: ModelProfilePreset[] = [], seen = new Set<string>(); let after: string | null = null;
      do {
        const page: ModelProfilePresetPage = await request<ModelProfilePresetPage>(`/api/model-profile-presets?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`, { signal: scope.signal });
        if (!scope.current()) return;
        if (!Array.isArray(page.items) || (page.next_cursor !== null && (typeof page.next_cursor !== 'string' || seen.has(page.next_cursor)))) throw new Error('预设分页格式不正确');
        found.push(...page.items); after = page.next_cursor; if (after) seen.add(after);
      } while (after !== null);
      const prior = select.control.value; items = found;
      select.control.replaceChildren(new Option('请选择，不会自动保存', ''), ...items.map(item => new Option(`${item.profile_id} · ${item.provider_id} · ${item.model_id}`, item.preset_id)));
      select.control.value = items.some(item => item.preset_id === prior) ? prior : '';
      readValid = true;
    } catch (reason) {
      if (scope.current()) summary.set(reason instanceof ApiFailure && reason.status === 403 ? '仅平台管理员可以配置模型。人工标注仍可继续。' : '无法读取服务端固定预设。请让本机操作者准备私有配置，然后只读重新检查；无需上交 token 或订阅代理。');
    } finally { busy = false; render(); }
  }
  async function changed() {
    try { await context.onProfilesChanged(); }
    catch { if (scope.current()) notice.textContent += '模型列表刷新失败，可只读重新检查。'; }
  }
  async function savePreset() {
    const preset = items.find(item => item.preset_id === select.control.value);
    if (!preset || !readValid || busy || unknown || !scope.current() || !canManage()) return;
    const submitted = Object.freeze({ ...preset, capabilities: Object.freeze({ ...preset.capabilities }) });
    busy = true; summary.set(null); notice.textContent = ''; render();
    try {
      await request<ModelProfile>(`/api/model-profiles/${encodeURIComponent(submitted.profile_id)}`, { method: 'PUT', body: JSON.stringify({ configuration_hash: submitted.configuration_hash }) });
      if (!scope.current()) return; notice.textContent = '模型配置已保存。配置就绪不等于真实运行验收通过；本次没有调用模型。'; await changed();
    } catch (reason) {
      if (!scope.current()) return;
      if (rejected(reason)) summary.set(reason instanceof ApiFailure && reason.status === 409 ? '此 profile 已绑定另一份配置，不能覆盖历史记录。请由本机操作者准备不同 profile 的预设。' : '服务器明确拒绝配置；检查平台权限与现有固定预设。');
      else { unknown = submitted; summary.set('配置写入结果未知。不要再次写入；仅核对原 profile 的完整身份和配置哈希。'); }
    } finally { busy = false; render(); }
  }
  async function reconcile() {
    const pending = unknown; if (!pending || busy || !scope.current() || !canManage()) return;
    busy = true; render();
    try {
      const saved = await request<{ profile: ModelProfile; configuration_hash: string }>(`/api/model-profiles/${encodeURIComponent(pending.profile_id)}`, { signal: scope.signal });
      if (!scope.current()) return; const profile = saved.profile;
      const capabilities = ['image_input', 'tools', 'structured_output', 'bbox_output', 'attributes'] as const;
      if (saved.configuration_hash !== pending.configuration_hash || !profile || profile.profile_id !== pending.profile_id || profile.provider_id !== pending.provider_id || profile.model_id !== pending.model_id || profile.auth_kind !== pending.auth_kind || capabilities.some(key => typeof profile.capabilities?.[key] !== 'boolean' || profile.capabilities[key] !== pending.capabilities[key])) {
        summary.set('服务器 profile 身份或配置不匹配；保留未知状态，不重复写入。'); return;
      }
      unknown = null; summary.set(null); notice.textContent = '已只读核实同一配置已保存；此 GET 仅确认当前状态，不证明原写入的唯一归属。没有重复写入或调用模型。'; await changed();
    } catch (reason) { if (scope.current()) summary.set(reason instanceof ApiFailure && reason.status === 404 ? '服务器尚无此 profile；原写入仍可能在途，请稍后再次只读核对。' : '只读核对失败；保留原配置选择，不重复写入。'); }
    finally { busy = false; render(); }
  }
  select.control.addEventListener('change', render, { signal: scope.signal }); render(); void load();
  return () => { scope.dispose(); page.remove(); };
}
