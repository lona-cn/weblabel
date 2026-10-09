import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useSession, type AuthEntry } from '../../app/providers';
import { ApiFailure } from '../../lib/t15/api';

function Frame({ children }: { children: ReactNode }) {
  return <main className="login-page"><section className="login-introduction" aria-label="WebLabel"><h2>WebLabel</h2></section>{children}</main>;
}
export function Login() {
  const { entry, refresh } = useSession();
  const [checking, setChecking] = useState(false);
  const retrying = useRef(false);
  async function retry() {
    if (retrying.current) return;
    retrying.current = true; setChecking(true);
    try { await refresh(); } finally { retrying.current = false; setChecking(false); }
  }
  if (entry.kind === 'bootstrap' || entry.kind === 'login') {
    return <Frame><CredentialForm key={entry.kind === 'bootstrap' ? `bootstrap-${entry.mode}` : `login-${entry.usernameHint}`} entry={entry} /></Frame>;
  }
  if (entry.kind === 'error' || entry.kind === 'bootstrap_created') return <Frame><section className="login-card" aria-labelledby="login-title">
    <h1 id="login-title">{entry.kind === 'error' ? '暂时无法确认账户状态' : '核实本地账户会话'}</h1>
    {entry.kind === 'bootstrap_created' ? <><p>已收到初始化成功响应；会话仍待核实。</p>{entry.username ? <p className="bootstrap-username">本地账户：{entry.username}</p> : null}</> : null}
    {entry.kind === 'error' ? <p role="alert">{entry.message}</p> : entry.error ? <p role="alert">{entry.error}</p> : <p role="status">正在检查会话…</p>}
    <button type="button" className="session-retry" data-testid="session-retry" onClick={() => void retry()} disabled={checking || (entry.kind === 'bootstrap_created' && entry.error === null)}>{checking ? '正在检查…' : '重新检查会话'}</button>
  </section></Frame>;
  return <main className="session-loading" role="status">正在检查登录状态…</main>;
}
function CredentialForm({ entry }: { entry: Extract<AuthEntry, { kind: 'login' | 'bootstrap' }> }) {
  const { login, bootstrap, refresh } = useSession();
  const setup = entry.kind === 'bootstrap';
  const [username, setUsername] = useState(entry.kind === 'login' ? entry.usernameHint : '');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const unavailable = entry.kind === 'bootstrap' && !entry.available;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (guard.current || unavailable) return;
    const errors: Record<string, string> = {};
    if (setup) {
      if (!code.trim()) errors['bootstrap-launch-code'] = '请输入启动终端显示的启动码。';
      const bytes = new TextEncoder().encode(password).byteLength;
      if (bytes < 12 || bytes > 1024) errors['bootstrap-password'] = '密码必须为 12–1024 个 UTF-8 字节。';
      if (password !== confirm) errors['bootstrap-password-confirm'] = '两次密码必须完全一致。';
    }
    setFields(errors); setError(null);
    const first = Object.keys(errors)[0];
    if (first) { event.currentTarget.querySelector<HTMLInputElement>(`#${first}`)?.focus(); return; }
    guard.current = true; setBusy(true);
    try { if (setup) await bootstrap(code.trim(), password); else await login(username, password); }
    catch (reason) {
      const failure = reason instanceof ApiFailure ? reason.code : '';
      if (failure === 'INVALID_PASSWORD' && setup) {
        setFields({ 'bootstrap-password': '密码必须为 12–1024 个 UTF-8 字节。' });
        document.getElementById('bootstrap-password')?.focus();
      } else {
        setError(failure === 'INVALID_BOOTSTRAP_CODE' ? '启动码错误或已过期，请核对启动终端的 WEBLABEL_BOOTSTRAP_CODE。' :
          failure === 'BOOTSTRAP_USED' || failure === 'BOOTSTRAP_UNAVAILABLE' ? '启动码已使用或当前不可用，请重新检查账户状态后使用普通登录。' :
          failure === 'LOGIN_RATE_LIMITED' ? '请求过于频繁，请稍后再试。' : setup ? '无法完成设置，请核对凭证或重新检查账户状态。' : '登录失败，请核对用户名和密码或稍后再试。');
      }
    } finally { guard.current = false; setBusy(false); }
  }
  async function retry() {
    if (guard.current) return;
    guard.current = true; setBusy(true);
    try { await refresh(); } finally { guard.current = false; setBusy(false); }
  }
  function field(id: string, label: string, value: string, update: (value: string) => void, autocomplete: string, type = 'password') {
    return <><label htmlFor={id}>{label}</label><input id={id} data-testid={id} type={type} autoComplete={autocomplete} value={value} onChange={(event) => update(event.target.value)} disabled={busy || unavailable} aria-invalid={Boolean(fields[id])} aria-describedby={fields[id] ? `${id}-error` : undefined} required={!setup} />{fields[id] ? <p id={`${id}-error`} className="field-error">{fields[id]}</p> : null}</>;
  }
  return <form className="login-card" onSubmit={submit} aria-labelledby="login-title" aria-busy={busy}>
    <h1 id="login-title">{entry.kind === 'bootstrap' ? entry.mode === 'initial' ? '首次设置本地账户' : '设置恢复后的本地账户' : '登录'}</h1>
    <p className="login-help">{setup ? '从启动终端复制 WEBLABEL_BOOTSTRAP_CODE；启动码十分钟有效，仅能使用一次。设置密码后直接进入项目页，无需输入用户名。' : '使用本地服务账户。'}</p>
    {entry.kind === 'bootstrap' && entry.mode === 'restore' ? <p className="login-help">将创建新的恢复管理员，不覆盖历史账号。</p> : null}
    {unavailable ? <p role="alert">启动码当前不可用。请先重新检查；若仍需设置且没有其他窗口正在提交，请在启动终端重启本地服务并使用新码。</p> : null}
    {setup ? field('bootstrap-launch-code', '启动码', code, setCode, 'off') : field('login-username', '用户名', username, setUsername, 'username', 'text')}
    {field(setup ? 'bootstrap-password' : 'login-password', '密码', password, setPassword, setup ? 'new-password' : 'current-password')}
    {setup ? field('bootstrap-password-confirm', '确认密码', confirm, setConfirm, 'new-password') : null}
    {error ? <p role="alert">{error}</p> : null}
    <button type="submit" data-testid={setup ? 'bootstrap-submit' : 'login-submit'} disabled={busy || unavailable}>{setup ? busy ? '正在设置…' : '设置并进入' : busy ? '正在验证…' : '登录'}</button>
    {setup ? <button type="button" className="session-retry" data-testid="session-retry" onClick={() => void retry()} disabled={busy}>重新检查</button> : null}
  </form>;
}
