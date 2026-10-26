import type { AuthEntry } from '../../app/session';
import type { PageContext } from '../../ui/page-context';
import { ApiFailure } from '../../lib/t15/api';
import { el, button, inputField, errorSummary, status } from './account-dom';
import './accounts.css';

export interface LoginPageContext extends PageContext {}
/** Owns only the view. Session state and unknown-write fencing belong to SessionController. */
export function mountLoginPage(root: HTMLElement, context: LoginPageContext): () => void {
  const owner = new AbortController();
  let key = '', busy = false, updateForm: (() => void) | null = null;
  const page = el('main', undefined, 'accounts-page accounts-auth');
  const brand = el('header', undefined, 'accounts-brand'); brand.append(el('strong', 'WL'), el('span', 'WebLabel'));
  const content = el('div', undefined, 'accounts-auth-content'); page.append(brand, content); root.append(page);
  const current = () => !owner.signal.aborted;
  function render() {
    if (!current()) return;
    const entry = context.session.getSnapshot();
    const nextKey = entry.kind === 'recovery' ? `recovery:${entry.status.request_id}` : entry.kind === 'bootstrap' ? `bootstrap:${entry.mode}` : entry.kind;
    if (key === nextKey && updateForm) { updateForm(); return; }
    key = nextKey; updateForm = null; content.replaceChildren();
    if (entry.kind === 'login' || entry.kind === 'bootstrap' || entry.kind === 'recovery') { credentials(entry); return; }
    const card = el('section', undefined, 'accounts-auth-card');
    card.append(el('h1', entry.kind === 'error' ? '暂时无法确认账户状态' : entry.kind === 'bootstrap_created' ? '核实本地账户会话' : entry.kind === 'authenticated' ? '已登录本地账户' : '正在检查登录状态…'));
    const notice = status();
    notice.textContent = entry.kind === 'error' ? entry.message : entry.kind === 'bootstrap_created' ? `已收到初始化成功响应。本地账户：${entry.username ?? '未知'}。${entry.error ?? '正在核实会话…'}` : entry.kind === 'authenticated' ? entry.session.username : '正在只读检查本地服务。';
    card.append(notice);
    if (entry.kind === 'error' || entry.kind === 'bootstrap_created') {
      card.append(el('p', '当前仅可只读核对。不重复初始化，不清除项目或本地草稿。'));
      const retry = button('重新检查会话', 'session-retry', owner.signal, () => { void refresh(retry); });
      retry.disabled = busy || (entry.kind === 'bootstrap_created' && entry.error === null); card.append(retry);
    }
    content.append(card);
  }
  async function refresh(control: HTMLButtonElement) {
    if (busy || !current()) return; busy = true; control.disabled = true;
    try { await context.session.refresh(); } finally { busy = false; if (current()) { control.disabled = false; render(); } }
  }
  function credentials(initial: Extract<AuthEntry, { kind: 'login' | 'bootstrap' | 'recovery' }>) {
    const recovery = initial.kind === 'recovery', setup = initial.kind !== 'login';
    const form = el('form', undefined, `accounts-auth-card${setup ? ' accounts-auth-wide' : ''}`); form.noValidate = true;
    const heading = el('h1', recovery ? '管理员密码恢复维护' : initial.kind === 'bootstrap' ? initial.mode === 'restore' ? '设置恢复后的本地账户' : '首次设置本地账户' : '登录');
    const help = el('p', recovery ? '维护模式：普通登录与业务不可用。保留历史身份、角色与项目数据。' : setup ? '从启动终端复制启动码，十分钟有效，仅能使用一次。' : '使用本地服务账户。');
    const summary = errorSummary(), state = status(), columns = el('div', undefined, 'accounts-auth-columns'), fields = el('div');
    const prefix = recovery ? 'recovery' : setup ? 'bootstrap' : 'login';
    const credential = inputField(recovery ? 'recovery-code' : setup ? 'bootstrap-launch-code' : 'login-username', recovery ? '终端恢复码' : setup ? '启动码' : '用户名', setup ? 'password' : 'text');
    credential.control.autocomplete = setup ? 'off' : 'username';
    if (initial.kind === 'login') credential.control.value = initial.usernameHint;
    const password = inputField(`${prefix}-password`, recovery ? '新密码' : '密码', 'password', setup ? '12–1024 个 UTF-8 字节；首尾空格保留。' : undefined);
    password.control.autocomplete = setup ? 'new-password' : 'current-password';
    const confirm = inputField(recovery ? 'recovery-confirm' : 'bootstrap-password-confirm', recovery ? '确认新密码' : '确认密码', 'password'); confirm.control.autocomplete = 'new-password';
    fields.append(credential.element, password.element); if (setup) fields.append(confirm.element);
    const submit = el('button', recovery ? '恢复管理员密码' : setup ? '设置并进入' : '登录', 'accounts-primary'); submit.dataset.testid = `${prefix}-submit`; submit.type = 'submit';
    const actions = el('div', undefined, 'accounts-actions'); actions.append(submit);
    const retry = button(recovery ? '只读核对恢复状态' : '重新检查', recovery ? 'recovery-check' : 'session-retry', owner.signal, () => { void refresh(retry); });
    if (setup) actions.append(retry);
    fields.append(actions); columns.append(fields);
    if (setup) {
      const aside = el('aside', undefined, 'accounts-auth-aside'); aside.append(el('h2', recovery ? '恢复说明' : '启动码说明'), el('p', recovery ? '恢复完成不会自动登录。恢复码仅用于当前终端请求，不重建账户。' : '设置后显示本地用户名，无需自行输入用户名。'));
      if (initial.kind === 'bootstrap' && initial.mode === 'restore') aside.append(el('p', '将创建新的恢复管理员，不覆盖历史账号。'));
      aside.append(el('p', '凭证只提交给本地服务，请勿分享。')); columns.append(aside);
    }
    form.append(heading, help, summary.node, state, columns); content.append(form);
    const locked = () => { const e = context.session.getSnapshot(); return busy || (e.kind === 'bootstrap' && !e.available) || (e.kind === 'recovery' && (e.phase !== 'ready' || e.checking || e.status.state !== 'available')) || !['login', 'bootstrap', 'recovery'].includes(e.kind); };
    updateForm = () => {
      const e = context.session.getSnapshot(); const frozen = locked();
      submit.disabled = frozen; credential.control.readOnly = frozen; password.control.readOnly = frozen; confirm.control.readOnly = frozen;
      retry.disabled = busy || (e.kind === 'recovery' && (e.phase === 'pending' || e.checking));
      form.setAttribute('aria-busy', String(busy || (e.kind === 'recovery' && (e.phase === 'pending' || e.checking))));
      if (e.kind === 'recovery') {
        state.textContent = `目标管理员：${e.status.username} · 请求：${e.status.request_id} · 状态：${e.status.state}${e.phase === 'unknown' ? '。结果未知，禁止重复提交；只能只读核对同一恢复请求。' : ''}`;
        columns.hidden = e.status.state === 'completed' || e.status.state === 'expired';
        if (e.status.state === 'completed') state.textContent += '。密码恢复已完成，不会自动登录。移除恢复请求环境变量，以原数据目录正常重启后使用新密码登录。';
        if (e.status.state === 'expired') { state.textContent += '。请以原数据目录重启服务获取新恢复码，不要重建账户或删除数据。'; form.append(retry); }
      } else if (e.kind === 'bootstrap') state.textContent = e.available ? '' : '启动码当前不可用，请先重新检查账户状态。';
    };
    form.addEventListener('submit', event => { event.preventDefault(); void submitCredentials(); }, { signal: owner.signal });
    async function submitCredentials() {
      if (locked() || !current()) return;
      credential.setError(null); password.setError(null); confirm.setError(null); summary.set(null);
      let invalid = false;
      if (!credential.control.value.trim()) { credential.setError(setup ? '请输入终端凭证。' : '请输入用户名。'); invalid = true; }
      const bytes = new TextEncoder().encode(password.control.value).byteLength;
      if (setup ? bytes < 12 || bytes > 1024 : bytes === 0) { password.setError(setup ? '密码必须为 12–1024 个 UTF-8 字节。' : '请输入密码。'); invalid = true; }
      if (setup && password.control.value !== confirm.control.value) { confirm.setError('两次密码必须完全一致。'); invalid = true; }
      if (invalid) { summary.set('请修正下方标记的字段，原输入已保留。', true); return; }
      busy = true; updateForm?.();
      try {
        if (recovery) await context.session.recover(credential.control.value.trim(), password.control.value);
        else if (setup) await context.session.bootstrap(credential.control.value.trim(), password.control.value);
        else await context.session.login(credential.control.value, password.control.value);
      } catch (reason) {
        if (!current()) return;
        const code = reason instanceof ApiFailure ? reason.code : '';
        if (code === 'INVALID_PASSWORD') password.setError('密码必须为 12–1024 个 UTF-8 字节。');
        else if (code === 'INVALID_BOOTSTRAP_CODE' || code === 'INVALID_RECOVERY_CODE') credential.setError('凭证错误或已过期，请核对本机启动终端。');
        else if (code.includes('RATE_LIMITED')) summary.set('请求过于频繁，请稍后再试。');
        else { password.setError('请核对凭证或稍后再试。'); summary.set(setup ? '无法完成设置；输入已保留，请核对凭证或只读重新检查。' : '登录失败，请核对用户名和密码。'); }
      } finally { busy = false; if (current()) render(); }
    }
    updateForm();
  }
  const unsubscribe = context.session.subscribe(render);
  const dispose = () => { if (owner.signal.aborted) return; owner.abort(); unsubscribe(); context.signal.removeEventListener('abort', dispose); page.remove(); };
  context.signal.addEventListener('abort', dispose, { once: true }); render(); if (context.signal.aborted) dispose();
  return dispose;
}
