import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelProfile } from '../../../../../packages/contracts/generated/ModelProfile';
import { api, ApiFailure } from '../../lib/t15/api';
export interface ModelProfilePreset {
  preset_id: string; profile_id: string; provider_id: string; model_id: string; auth_kind: string;
  capabilities: ModelProfile['capabilities']; configuration_hash: string; configured: boolean;
  availability: ModelProfile['availability']; availability_reason: string;
}
export function ModelProfileSettings({ platformAdmin, onProfilesChanged, request = api.request }: {
  platformAdmin: boolean; onProfilesChanged: () => void | Promise<void>; request?: typeof api.request;
}) {
  const [items, setItems] = useState<ModelProfilePreset[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState<Readonly<ModelProfilePreset> | null>(null);
  const mutation = useRef(false);
  const epoch = useRef(0);
  const load = useCallback(async () => {
    if (!platformAdmin || mutation.current) return;
    const current = ++epoch.current;
    setBusy(true); setError(null);
    try {
      const found: ModelProfilePreset[] = [];
      const seen = new Set<string>();
      let after: string | null = null;
      do {
        const page: { items: ModelProfilePreset[]; next_cursor: string | null } = await request(`/api/model-profile-presets?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`);
        if (!Array.isArray(page.items) || (page.next_cursor !== null && (typeof page.next_cursor !== 'string' || seen.has(page.next_cursor)))) throw new Error('预设分页格式不正确');
        found.push(...page.items);
        after = page.next_cursor;
        if (after) seen.add(after);
      } while (after !== null);
      if (epoch.current !== current) return;
      setItems(found);
      setSelected(prior => found.some(item => item.preset_id === prior) ? prior : '');
    } catch (cause) {
      if (epoch.current === current) { setItems([]); setSelected(''); }
      if (epoch.current === current) setError(cause instanceof ApiFailure && cause.status === 403 ? '仅平台管理员可以配置模型。人工标注仍可继续。' : '无法读取服务端固定预设。请让本机操作者准备 Host 私有配置，然后只读重新检查；无需上交 token 或订阅代理。');
    } finally { if (epoch.current === current) setBusy(false); }
  }, [platformAdmin, request]);
  useEffect(() => { void load(); return () => { epoch.current += 1; }; }, [load]);
  const preset = items.find(item => item.preset_id === selected);
  const save = async () => {
    if (!platformAdmin || !preset || mutation.current || unknown) return;
    // Freeze the exact selected identity before the asynchronous mutation.
    const submitted = Object.freeze({ ...preset, capabilities: Object.freeze({ ...preset.capabilities }) });
    mutation.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      await request<ModelProfile>(`/api/model-profiles/${encodeURIComponent(submitted.profile_id)}`, { method: 'PUT', body: JSON.stringify({ configuration_hash: submitted.configuration_hash }) });
      setNotice('模型配置已保存。配置就绪不等于真实运行验收通过；本次没有调用模型。');
      try { await onProfilesChanged(); } catch { setNotice('配置已保存，但模型列表刷新失败。请只读重新检查。'); }
    } catch (cause) {
      if (cause instanceof ApiFailure && cause.status >= 400 && cause.status < 500) setError(cause.status === 409 ? '此 profile 已绑定另一份配置，不能覆盖历史记录。请由本机操作者准备不同 profile 的预设。' : '服务器明确拒绝配置；检查平台权限与现有 Host 预设。');
      else { setUnknown(submitted); setError('配置写入结果未知。不要再次写入；仅核对原 profile 的完整身份和配置哈希。'); }
    } finally { mutation.current = false; setBusy(false); }
  };
  const reconcile = async () => {
    if (!unknown || mutation.current) return;
    mutation.current = true; setBusy(true);
    try {
      const saved = await request<{ profile: ModelProfile; configuration_hash: string }>(`/api/model-profiles/${encodeURIComponent(unknown.profile_id)}`);
      const profile = saved.profile;
      const capabilities = ['image_input', 'tools', 'structured_output', 'bbox_output', 'attributes'] as const;
      if (saved.configuration_hash !== unknown.configuration_hash || !profile ||
        profile.profile_id !== unknown.profile_id || profile.provider_id !== unknown.provider_id ||
        profile.model_id !== unknown.model_id || profile.auth_kind !== unknown.auth_kind ||
        capabilities.some(key => typeof profile.capabilities?.[key] !== 'boolean' || profile.capabilities[key] !== unknown.capabilities[key])) {
        setError('服务器 profile 身份或配置不匹配；保留未知状态，不重复写入。'); return;
      }
      setUnknown(null); setError(null); setNotice('已只读核实同一配置已保存；此 GET 仅确认当前状态，不证明原写入的唯一归属。没有重复写入或调用模型。');
      try { await onProfilesChanged(); } catch { setNotice('配置已核实，模型列表刷新失败。可只读重新检查。'); }
    } catch (cause) { setError(cause instanceof ApiFailure && cause.status === 404 ? '服务器尚无此 profile；原写入仍可能在途，请稍后再次只读核对。' : '只读核对失败；保留原配置选择，不重复写入。'); }
    finally { mutation.current = false; setBusy(false); }
  };
  if (!platformAdmin) return <section aria-label="模型配置"><p role="status">仅平台管理员可以配置模型。人工标注不依赖 AI，可以继续。</p></section>;
  return <section className="ai-profile-settings" aria-labelledby="model-profile-settings-heading">
    <h2 id="model-profile-settings-heading">服务端模型配置</h2>
    <p>只选择本机操作者已准备的固定预设。此页面不接收密钥、路径或启动参数，不登录、不下载权重、不调用模型。</p>
    {error ? <p role="alert">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
    {!busy && !items.length && !error ? <p role="status">尚无 Host 预设；让本机操作者准备配置。人工标注仍可继续。</p> : null}
    <label>固定预设<select value={selected} disabled={busy || unknown !== null} onChange={event => setSelected(event.currentTarget.value)}><option value="">请选择，不会自动保存</option>{items.map(item => <option key={item.preset_id} value={item.preset_id}>{item.profile_id} · {item.provider_id} · {item.model_id}</option>)}</select></label>
    {preset ? <dl><dt>配置状态</dt><dd>{preset.configured ? '已配置相同哈希' : '未配置此预设'}</dd><dt>运行时与凭证</dt><dd>{preset.availability_reason}</dd><dt>配置哈希</dt><dd><code>{preset.configuration_hash}</code></dd><dt>真实验收</dt><dd>静态配置不授予 live_passed；保存后仍需明确的真实验收。</dd><dt>策略与数据授权</dt><dd>仍受项目权限和每次运行的实际服务器授权预览约束。</dd></dl> : null}
    <button type="button" disabled={busy || !preset || unknown !== null} onClick={() => void save()}>明确保存所选预设</button>
    {unknown ? <button type="button" disabled={busy} onClick={() => void reconcile()}>只读核对配置</button> : <button type="button" disabled={busy} onClick={() => void load()}>只读重新检查预设</button>}
  </section>;
}
