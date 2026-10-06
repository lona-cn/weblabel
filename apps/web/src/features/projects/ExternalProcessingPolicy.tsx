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
      <h2 id={headingId}>项目外发策略</h2>
      <p role="status">{policy === null ? '策略未确认，不能据此授权外发。' : policy.allow_external_processing ? '服务端已允许外部处理。' : '服务端已禁止外部处理。'}</p>
      <p id={helpId}>API 与 Codex / Claude 官方运行时均可能外发。项目策略不替代每次运行对图像、裁剪范围和对象上下文的明确授权。关闭后服务端拒绝后续读取并请求异步停止已有外发运行；已传输数据无法撤回，费用不保证退回。</p>
    </div>
    {canManage ? <form onSubmit={event => { event.preventDefault(); void save(); }} aria-busy={saving}>
      <label className="external-policy-toggle"><input type="checkbox" checked={draft} disabled={policy === null || saving} aria-describedby={helpId} onChange={event => setDraft(event.currentTarget.checked)} />允许本项目外部处理</label>
      <button type="submit" disabled={policy === null || saving || draft === policy.allow_external_processing}>{saving ? '保存中…' : '保存外发策略'}</button>
      <small>修改后需保存；以上方服务端确认状态为准。</small>
    </form> : <p className="external-policy-role">仅项目管理员可修改此策略。</p>}
    {error ? <p className="api-error" role="alert">{error}</p> : null}
  </section>;
}
