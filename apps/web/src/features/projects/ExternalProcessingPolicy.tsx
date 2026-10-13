import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../../lib/t15/api';
import type { ExternalProcessingPolicy as Policy } from '../../../../../packages/contracts/generated/ExternalProcessingPolicy';

type Props = { projectId: string; canManage: boolean };

export function ExternalProcessingPolicy({ projectId, canManage }: Props) {
  const headingId = useId();
  const helpId = useId();
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [draft, setDraft] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationScope = useRef({ active: false });

  useEffect(() => {
    const scope = { active: true };
    operationScope.current = scope;
    setPolicy(null);
    setSaving(false);
    setError(null);
    void api.externalProcessingPolicy(projectId).then(result => {
      if (!scope.active) return;
      setPolicy(result);
      setDraft(result.allow_external_processing);
    }).catch(reason => {
      if (scope.active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { scope.active = false; };
  }, [projectId]);

  async function save() {
    if (!canManage || !policy || saving || draft === policy.allow_external_processing) return;
    const scope = operationScope.current;
    setSaving(true);
    setError(null);
    try {
      const result = await api.setExternalProcessingPolicy(projectId, draft);
      if (!scope.active) return;
      setPolicy(result);
      setDraft(result.allow_external_processing);
    } catch (reason) {
      if (scope.active) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (scope.active) setSaving(false);
    }
  }

  return <section className="external-policy" aria-labelledby={headingId}>
    <div className="external-policy-summary">
      <h2 id={headingId}>数据外发</h2>
      <p role="status">{policy === null ? '尚未确认服务器策略，不能授权外发。' : policy.allow_external_processing ? '服务器已允许外部处理。' : '服务器已禁止外部处理。'}</p>
      <p id={helpId}>API 和 Claude 官方运行均可能外发数据。每次运行仍需确认图片、裁剪范围和对象详情。关闭后，服务器会拒绝后续读取并请求停止已开始的外发运行；已传输数据无法撤回，费用不保证退回。</p>
    </div>
    {canManage ? <form onSubmit={event => { event.preventDefault(); void save(); }} aria-busy={saving}>
      <label className="external-policy-toggle"><input type="checkbox" checked={draft} disabled={policy === null || saving} aria-describedby={helpId} onChange={event => setDraft(event.currentTarget.checked)} />允许本项目外部处理</label>
      <button type="submit" disabled={policy === null || saving || draft === policy.allow_external_processing}>{saving ? '保存中…' : '保存外发策略'}</button>
      <small>修改后请保存，以上方服务器状态为准。</small>
    </form> : <p className="external-policy-role">仅项目管理员可修改此策略。</p>}
    {error ? <p className="api-error" role="alert">{error}</p> : null}
  </section>;
}
