import { useRef, useState, type FormEvent } from 'react';
import { useSession, type AuthEntry } from '../../app/providers';
import { ApiFailure } from '../../lib/t15/api';

export function AdminRecoveryForm({ entry }: { entry: Extract<AuthEntry, { kind: 'recovery' }> }) {
  const { recover, refresh } = useSession();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const guard = useRef(false);
  const locked = entry.phase !== 'ready' || entry.checking;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (guard.current || locked || entry.status.state !== 'available') return;
    const fields: Record<string, string> = {};
    if (!code.trim()) fields['recovery-code'] = '请输入启动终端显示的 WEBLABEL_ADMIN_RECOVERY_CODE。';
    const bytes = new TextEncoder().encode(password).byteLength;
    if (bytes < 12 || bytes > 1024) fields['recovery-password'] = '密码必须为 12–1024 个 UTF-8 字节。';
    if (password !== confirm) fields['recovery-confirm'] = '两次密码必须完全一致。';
    setErrors(fields); setError(null);
    const first = Object.keys(fields)[0];
    if (first) { event.currentTarget.querySelector<HTMLInputElement>(`#${first}`)?.focus(); return; }
    guard.current = true;
    try { await recover(code.trim(), password); }
    catch (reason) {
      const code = reason instanceof ApiFailure ? reason.code : '';
      if (code === 'INVALID_PASSWORD') {
        setErrors({ 'recovery-password': '密码必须为 12–1024 个 UTF-8 字节。' });
        document.getElementById('recovery-password')?.focus();
      } else setError(code === 'INVALID_RECOVERY_CODE' ? '恢复码错误或已过期，请核对启动终端的 WEBLABEL_ADMIN_RECOVERY_CODE；可只读核对是否已过期。' : code === 'RECOVERY_RATE_LIMITED' ? '恢复请求过于频繁，请稍后再试。' : '恢复请求结果尚未确认，请只读核对恢复状态。');
    } finally { guard.current = false; }
  }
  function field(id: string, label: string, value: string, update: (value: string) => void) {
    return <><label htmlFor={id}>{label}</label><input id={id} type="password" autoComplete={id === 'recovery-code' ? 'off' : 'new-password'} value={value} onChange={event => update(event.target.value)} disabled={locked} aria-invalid={Boolean(errors[id])} aria-describedby={errors[id] ? `${id}-error` : undefined} />{errors[id] ? <p id={`${id}-error`} className="field-error">{errors[id]}</p> : null}</>;
  }
  return <form className="login-card" onSubmit={submit} aria-labelledby="recovery-title" aria-busy={entry.phase === 'pending' || entry.checking}>
    <h1 id="recovery-title">管理员密码恢复维护</h1>
    <p className="bootstrap-username">目标管理员：{entry.status.username}</p>
    <p className="login-help">请求：{entry.status.request_id}。维护期间普通登录与业务不可用；保留历史身份、角色与项目数据。</p>
    {entry.status.state === 'completed' ? <><p role="status">密码恢复已完成（completed）。不会自动登录。</p><p>移除 WEBLABEL_ADMIN_RECOVERY_REQUEST_ID、WEBLABEL_ADMIN_RECOVERY_USERNAME 环境变量，再以原数据目录正常重启，然后使用新密码登录。</p></> : entry.status.state === 'expired' ? <p role="status">恢复码已过期。请使用原数据目录重启本地服务，从启动终端获取新恢复码；不要重建账号或删除数据。</p> : <>
      <p className="login-help">复制启动终端的随机 WEBLABEL_ADMIN_RECOVERY_CODE；十分钟有效，仅能使用一次。新密码为 12–1024 个 UTF-8 字节，首尾空格保留。</p>
      {field('recovery-code', '终端恢复码', code, setCode)}
      {field('recovery-password', '新密码', password, setPassword)}
      {field('recovery-confirm', '确认新密码', confirm, setConfirm)}
      {error && entry.phase !== 'unknown' ? <p role="alert">{error}</p> : null}
      {entry.phase === 'unknown' ? <p role="alert">恢复请求结果尚未确认。禁止重复提交；只能只读核对同一请求状态。仅核对 available 确认未提交后才允许人工再次提交。</p> : null}
      <button type="submit" data-testid="recovery-submit" disabled={locked}>{entry.phase === 'pending' ? '正在恢复…' : '恢复管理员密码'}</button>
    </>}
    {entry.status.state !== 'completed' ? <button type="button" className="session-retry" data-testid="recovery-check" disabled={entry.phase === 'pending' || entry.checking} onClick={() => void refresh()}>{entry.checking ? '正在核对…' : '只读核对恢复状态'}</button> : null}
  </form>;
}
