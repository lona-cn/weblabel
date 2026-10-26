import type { PageContext } from '../../ui/page-context';
import type { ExternalProcessingPolicy } from '../../../../../packages/contracts/generated/ExternalProcessingPolicy';
import { api } from '../../lib/t15/api';
import { accountScope, el, button, checkField, errorSummary, status, panel, sessionCanManage, rejected, message } from './account-dom';
import './accounts.css';

export interface ExternalProcessingPolicyContext extends PageContext { projectId: string; projectName: string }
export function mountExternalProcessingPolicy(root: HTMLElement, context: ExternalProcessingPolicyContext): () => void {
  const page = el('section', undefined, 'accounts-page accounts-policy'); page.dataset.testid = 'external-policy'; root.append(page);
  const scope = accountScope(page, context);
  let policy: ExternalProcessingPolicy | null = null, busy = false, unknown = false, loaded = false;
  const heading = el('h1', '外部处理策略'), server = status(), summary = errorSummary();
  server.classList.add('accounts-policy-state');
  const form = el('form', undefined, 'accounts-panel'), toggle = checkField('external-processing-allow', '允许本项目外部处理'), draft = status();
  const submit = el('button', '保存外发策略', 'accounts-primary'); submit.type = 'submit'; submit.dataset.testid = 'external-policy-save';
  const discard = button('放弃更改', 'external-policy-discard', scope.signal, () => { if (policy && !unknown && !busy && scope.current()) { toggle.control.checked = policy.allow_external_processing; render(); } });
  const read = button('只读重新检查策略', 'external-policy-read', scope.signal, () => { void load(); });
  const actions = el('div', undefined, 'accounts-actions'); actions.append(discard, submit, read);
  form.append(el('h2', '策略设置'), toggle.element, draft, actions);
  const info = panel('角色与授权范围'); info.append(el('p', `策略范围：${context.projectName}`), el('p', '仅项目管理员可修改此策略。非管理员仅可查看，策略未知时不能授权外发。本机人工标注不依赖外部处理。'));
  const impact = panel('数据流与关闭后的影响'); impact.append(el('p', 'API 和 Claude 官方运行均可能外发数据；本地启动不等于本地推理。每次运行仍需确认图片、裁剪范围和对象详情。'), el('p', '关闭后服务器拒绝后续读取，并请求停止已开始的外发运行。已传输数据无法撤回，费用不保证退回。'));
  const columns = el('div', undefined, 'accounts-admin-columns'); columns.append(form, info); page.append(heading, server, summary.node, columns, impact);
  function render() {
    if (!scope.current()) return;
    const canManage = sessionCanManage(context, context.projectId), dirty = policy !== null && toggle.control.checked !== policy.allow_external_processing;
    server.textContent = unknown || !policy ? '策略未知：尚未确认服务器策略，不能授权外发。' : policy.allow_external_processing ? '服务器已允许外部处理 · 每次运行仍需授权。' : '服务器已禁止外部处理 · DENIED';
    server.dataset.state = unknown || !policy ? 'unknown' : policy.allow_external_processing ? 'allowed' : 'denied';
    toggle.control.disabled = !canManage || !policy || busy || unknown;
    submit.disabled = !canManage || !policy || busy || unknown || !dirty;
    discard.disabled = !canManage || !policy || busy || unknown || !dirty; read.disabled = busy;
    read.textContent = unknown ? '只读核对实际策略' : '只读重新检查策略';
    form.setAttribute('aria-busy', String(busy));
    draft.textContent = busy ? '正在处理…' : unknown ? '写入结果未知，暂停再次保存。只读读取当前状态，不代表原写入的唯一归属。' : !loaded ? '正在读取策略…' : !canManage ? '仅可查看，不能修改或保存策略。' : dirty ? '尚未保存；以上方服务器状态为准。当前勾选为草稿。' : '服务器状态已读取。';
  }
  async function load() {
    if (busy || !scope.current()) return; busy = true; summary.set(null); render();
    try {
      const result = await api.externalProcessingPolicy(context.projectId, scope.signal); if (!scope.current()) return;
      policy = result; toggle.control.checked = result.allow_external_processing; loaded = true; unknown = false;
    } catch (reason) { if (scope.current()) { policy = null; summary.set(message(reason)); } }
    finally { busy = false; render(); }
  }
  async function save() {
    if (busy || unknown || !policy || !scope.current() || !sessionCanManage(context, context.projectId) || toggle.control.checked === policy.allow_external_processing) return;
    const submitted = toggle.control.checked; busy = true; summary.set(null); render();
    try {
      const result = await api.setExternalProcessingPolicy(context.projectId, submitted); if (!scope.current()) return;
      policy = result; toggle.control.checked = result.allow_external_processing;
    } catch (reason) { if (scope.current()) { if (!rejected(reason)) unknown = true; summary.set(unknown ? '策略写入结果未知，不再次保存，请只读核对。' : message(reason)); } }
    finally { busy = false; render(); }
  }
  toggle.control.addEventListener('change', render, { signal: scope.signal }); form.addEventListener('submit', event => { event.preventDefault(); void save(); }, { signal: scope.signal });
  render(); void load(); return () => { scope.dispose(); page.remove(); };
}
