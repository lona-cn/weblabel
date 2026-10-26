import type { PageContext } from '../../ui/page-context';
import { createButton } from '../../ui/button';
import { createFormField } from '../../ui/form-field';
import { ApiFailure, saveAuthorizationEpoch, subscribeSaveAuthorization } from '../../lib/t15/api';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
export function accountScope(root: HTMLElement, context: PageContext) {
  const owner = new AbortController();
  const epoch = saveAuthorizationEpoch();
  const identity = () => { const s = context.session.getSnapshot(); return s.kind === 'authenticated' ? JSON.stringify(s.session) : s.kind; };
  const initialIdentity = identity();
  const stop = () => owner.abort();
  const unsubscribe = context.session.subscribe(() => { if (identity() !== initialIdentity) stop(); });
  const unauthorize = subscribeSaveAuthorization(() => { if (saveAuthorizationEpoch() !== epoch) stop(); });
  context.signal.addEventListener('abort', stop, { once: true });
  owner.signal.addEventListener('abort', () => {
    unsubscribe(); unauthorize(); context.signal.removeEventListener('abort', stop);
    root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('input,button,select,textarea').forEach(node => { node.disabled = true; });
  }, { once: true });
  if (context.signal.aborted) stop();
  return { signal: owner.signal, current: () => !owner.signal.aborted, dispose: stop };
}
export function button(text: string, testId: string, signal: AbortSignal, action: () => void, primary = false) {
  const node = createButton({ text, testId, signal, onClick: action });
  if (primary) node.className = 'accounts-primary';
  return node;
}
export function inputField(id: string, label: string, type = 'text', hint?: string) {
  const control = el('input'); control.type = type; control.dataset.testid = id;
  const field = createFormField({ id, label, testId: `${id}-field`, control, hint });
  field.element.className = 'accounts-field';
  return { ...field, control };
}
export function selectField(id: string, label: string, options: readonly (readonly [string, string])[]) {
  const control = el('select'); control.dataset.testid = id;
  for (const [value, text] of options) { const option = el('option', text); option.value = value; control.append(option); }
  const field = createFormField({ id, label, testId: `${id}-field`, control }); field.element.className = 'accounts-field';
  return { ...field, control };
}
export function textareaField(id: string, label: string, hint?: string) {
  const control = el('textarea'); control.rows = 3; control.dataset.testid = id;
  const field = createFormField({ id, label, testId: `${id}-field`, control, hint }); field.element.className = 'accounts-field';
  return { ...field, control };
}
export function checkField(id: string, label: string) {
  const field = inputField(id, label, 'checkbox'); field.element.classList.add('accounts-check'); return field;
}
export function errorSummary() {
  const node = el('div', '', 'accounts-error'); node.setAttribute('role', 'alert'); node.tabIndex = -1; node.hidden = true;
  return { node, set(message: string | null, focus = false) { node.textContent = message ?? ''; node.hidden = !message; if (message && focus) node.focus(); } };
}
export function status() { const node = el('p', '', 'accounts-status'); node.setAttribute('role', 'status'); return node; }
export function rejected(reason: unknown) { return reason instanceof ApiFailure && reason.status >= 400 && reason.status < 500; }
export function message(reason: unknown) { return reason instanceof Error ? reason.message : '操作失败，请重新读取状态。'; }
export function table(headers: string[]) {
  const wrap = el('div', undefined, 'accounts-table-scroll'), node = el('table'), head = el('thead'), row = el('tr'), body = el('tbody');
  for (const text of headers) { const th = el('th', text); th.scope = 'col'; row.append(th); }
  head.append(row); node.append(head, body); wrap.append(node); return { wrap, node, body };
}
export function panel(title: string) { const node = el('section', undefined, 'accounts-panel'); node.append(el('h2', title)); return node; }
export function sessionCanManage(context: PageContext, projectId: string) {
  const entry = context.session.getSnapshot();
  return entry.kind === 'authenticated' && entry.session.project_roles.some(role => role.project_id === projectId && role.role === 'admin');
}
