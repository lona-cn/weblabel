import { useState, type FormEvent } from 'react';
import { useSession } from '../../app/providers';

export function Login() {
  const { login } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try { await login(username, password); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <main className="login-page"><form className="login-card" onSubmit={submit} aria-labelledby="login-title">
    <p className="eyebrow">本地标注工作台</p><h1 id="login-title">登录 WebLabel</h1>
    <label htmlFor="login-username">用户名</label><input id="login-username" data-testid="login-username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required />
    <label htmlFor="login-password">密码</label><input id="login-password" data-testid="login-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
    {error ? <p role="alert">{error}</p> : null}
    <button type="submit" data-testid="login-submit" disabled={busy}>{busy ? '正在验证…' : '登录'}</button>
  </form></main>;
}
