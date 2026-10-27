import { api, ApiFailure, csrfToken, loginInScope, setCsrfToken, type Session, type BootstrapResult, type AdminRecoveryStatus } from '../lib/t15/api';

export type AuthEntry =
  | { kind: 'checking' }
  | { kind: 'recovery'; status: AdminRecoveryStatus; phase: 'ready' | 'pending' | 'unknown'; checking: boolean }
  | { kind: 'authenticated'; session: Session; createdUsername: string | null }
  | { kind: 'login'; usernameHint: string }
  | { kind: 'bootstrap'; mode: 'initial' | 'restore'; available: boolean }
  | { kind: 'bootstrap_created'; username: string | null; error: string | null }
  | { kind: 'error'; message: string };

export interface SessionController {
  getSnapshot(): AuthEntry;
  subscribe(listener: () => void): () => void;
  login(username: string, password: string): Promise<void>;
  bootstrap(launchCode: string, password: string): Promise<void>;
  recover(code: string, password: string): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
  dispose(): void;
}
const readError = '无法检查本地账户状态。请重新检查，不要重复提交初始化。';
const cookieHelp = '会话已存在但未取得有效 CSRF。请在浏览器中仅清除此本地站点的 weblabel_session Cookie，再使用已设置的密码正常登录；不要清除项目数据或 IndexedDB。';
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function unauthenticated(reason: unknown): boolean { return reason instanceof ApiFailure && reason.status === 401 && reason.code === 'UNAUTHENTICATED'; }

// Construction is inert. The owner starts the initial read with refresh().
export function createSessionController(): SessionController {
  let entry: AuthEntry = { kind: 'checking' };
  let generation = 0;
  let disposed = false;
  let pending: { ack: BootstrapResult | null; username: string | null; received: boolean } | null = null;
  let logoutFlight: Promise<void> | null = null;
  let bootstrapFlight: Promise<void> | null = null;
  let recovery: Extract<AuthEntry, { kind: 'recovery' }> | null = null;
  let recoveryFlight = false;
  const listeners = new Set<() => void>();
  const reads = new Set<AbortController>();
  async function read<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    reads.add(controller);
    try { return await request(controller.signal); }
    finally { reads.delete(controller); }
  }
  const current = (id: number) => !disposed && id === generation;
  function setEntry(next: AuthEntry) {
    if (disposed) return;
    entry = next;
    for (const listener of listeners) listener();
  }
  async function inspectRecovery(id: number): Promise<boolean> {
    const previous = recovery;
    try {
      const status = await read(signal => api.adminRecoveryStatus(signal));
      if (!current(id)) return true;
      if (previous && (status.request_id !== previous.status.request_id || status.username !== previous.status.username)) throw new Error('恢复请求已改变');
      if (status.state === 'disabled') return false;
      setCsrfToken(null);
      const next: Extract<AuthEntry, { kind: 'recovery' }> = { kind: 'recovery', status, phase: 'ready', checking: false };
      recovery = next; setEntry(next); return true;
    } catch {
      if (current(id)) {
        if (previous) { const next = { ...previous, phase: 'unknown' as const, checking: false }; recovery = next; setEntry(next); }
        else setEntry({ kind: 'error', message: '无法确认管理员恢复状态。请只读重新检查；不要提交密码。' });
      }
      return true;
    }
  }
  async function readStatus(id: number, usernameHint = '') {
    const status = await read(signal => api.bootstrapStatus(signal));
    if (!current(id)) return;
    setEntry(status.mode === 'login' ? { kind: 'login', usernameHint } : { kind: 'bootstrap', mode: status.mode, available: status.bootstrap_available });
  }
  async function check(id: number) {
    const creation = pending;
    const ack = creation?.ack;
    const validAck = ack && nonempty(ack.user_id) && nonempty(ack.username) && nonempty(ack.csrf_token);
    try {
      if (!current(id) || await inspectRecovery(id)) return;
      if (validAck) {
        setCsrfToken(ack.csrf_token);
        globalThis.sessionStorage.setItem('weblabel_csrf', ack.csrf_token);
      } else if (!creation) setCsrfToken(globalThis.sessionStorage.getItem('weblabel_csrf'));
      const session = await read(signal => api.session(signal));
      if (!current(id)) return;
      if (creation && !validAck) {
        pending = { ...creation, username: nonempty(session.username) ? session.username : creation.username };
        setEntry(creation.received ? { kind: 'bootstrap_created', username: pending.username, error: cookieHelp } : { kind: 'error', message: `本地账户：${pending.username ?? '未知'}。${cookieHelp}` });
        return;
      }
      if (!nonempty(csrfToken())) { setEntry({ kind: 'error', message: cookieHelp }); return; }
      setEntry({ kind: 'authenticated', session, createdUsername: creation?.username ?? null });
    } catch (reason) {
      if (!current(id)) return;
      if (unauthenticated(reason)) {
        setCsrfToken(null);
        try { globalThis.sessionStorage.removeItem('weblabel_csrf'); }
        catch { setEntry(creation?.received ? { kind: 'bootstrap_created', username: creation.username, error: readError } : { kind: 'error', message: readError }); return; }
        if (creation) {
          pending = null;
          setEntry({ kind: 'login', usernameHint: creation.username ?? '' });
        } else {
          try { await readStatus(id); }
          catch { if (current(id)) setEntry({ kind: 'error', message: readError }); }
        }
      } else setEntry(creation?.received ? { kind: 'bootstrap_created', username: creation.username, error: readError } : { kind: 'error', message: readError });
    }
  }
  async function refresh() {
    if (disposed || recoveryFlight) return;
    const id = ++generation;
    if (recovery) { setEntry({ ...recovery, checking: true }); await inspectRecovery(id); return; }
    const creation = pending;
    setEntry(creation?.received ? { kind: 'bootstrap_created', username: creation.username, error: null } : { kind: 'checking' });
    await check(id);
  }
  async function login(username: string, password: string) {
    if (disposed) return;
    // Every new login intent advances the fence, even while an older POST waits.
    const id = ++generation;
    if (await inspectRecovery(id)) return;
    const identity = await read(signal => loginInScope(username, password, () => current(id), signal));
    if (!current(id) || !identity) return;
    pending = null;
    setEntry({ kind: 'authenticated', session: identity, createdUsername: null });
  }
  function bootstrap(launchCode: string, password: string) {
    if (disposed || pending) return Promise.resolve();
    if (bootstrapFlight) return bootstrapFlight;
    const operation = (async () => {
      const id = ++generation;
      let ack: BootstrapResult;
      if (await inspectRecovery(id)) return;
      try { ack = await api.bootstrap(launchCode, password); }
      catch (reason) {
        if (!current(id)) return;
        if (reason instanceof ApiFailure && (reason.status === 400 || reason.status === 401 || reason.code === 'LOGIN_RATE_LIMITED')) throw reason;
        if (reason instanceof ApiFailure && reason.status === 409) {
          try { await readStatus(id); }
          catch { if (current(id)) setEntry({ kind: 'error', message: readError }); }
          return;
        }
        pending = { ack: null, username: null, received: false };
        setEntry({ kind: 'error', message: '初始化请求结果尚未确认。请先重新检查会话，不要再次提交启动码。' });
        return;
      }
      if (!current(id)) return;
      const username = nonempty(ack?.username) ? ack.username : null;
      pending = { ack, username, received: true };
      setEntry({ kind: 'bootstrap_created', username, error: null });
      // Creation is committed before storage or identity reads can fail.
      await check(id);
    })();
    bootstrapFlight = operation;
    void operation.then(() => { if (bootstrapFlight === operation) bootstrapFlight = null; }, () => { if (bootstrapFlight === operation) bootstrapFlight = null; });
    return operation;
  }
  async function recover(code: string, password: string) {
    const captured = recovery;
    if (disposed || !captured || captured.phase !== 'ready' || captured.status.state !== 'available' || recoveryFlight) return;
    recoveryFlight = true;
    const id = ++generation;
    const submitting = { ...captured, phase: 'pending' as const, checking: false };
    recovery = submitting; setEntry(submitting);
    try {
      const status = await api.adminRecover({ recovery_code: code.trim(), password });
      if (!current(id)) return;
      if (status.request_id !== captured.status.request_id || status.username !== captured.status.username) throw new Error('恢复响应请求不一致');
      const next = { ...captured, status, phase: 'ready' as const, checking: false };
      recovery = next; setEntry(next);
    } catch (reason) {
      if (!current(id)) return;
      if (reason instanceof ApiFailure && ((reason.status === 400 && reason.code === 'INVALID_PASSWORD') || (reason.status === 401 && reason.code === 'INVALID_RECOVERY_CODE') || (reason.status === 429 && reason.code === 'RECOVERY_RATE_LIMITED'))) {
        const next = { ...captured, phase: 'ready' as const, checking: false };
        recovery = next; setEntry(next); throw reason;
      }
      const next = { ...captured, phase: 'unknown' as const, checking: false }; recovery = next; setEntry(next);
    } finally { recoveryFlight = false; }
  }
  function logout(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (logoutFlight) return logoutFlight;
    const id = ++generation;
    const operation = (async () => {
      try {
        await api.logout();
        if (!current(id)) return;
        setCsrfToken(null); pending = null;
        try { globalThis.sessionStorage.removeItem('weblabel_csrf'); }
        catch { setEntry({ kind: 'error', message: '已退出本地账户，但浏览器无法清除登录状态缓存。请重新检查。' }); return; }
        setEntry({ kind: 'login', usernameHint: '' });
      } catch { if (current(id)) setEntry({ kind: 'error', message: '无法确认退出结果。请重新检查会话。' }); }
    })();
    logoutFlight = operation;
    void operation.finally(() => { if (logoutFlight === operation) logoutFlight = null; });
    return operation;
  }
  return {
    getSnapshot: () => entry,
    subscribe(listener) { if (disposed) return () => {}; listeners.add(listener); return () => { listeners.delete(listener); }; },
    login, bootstrap, recover, logout, refresh,
    dispose() { disposed = true; ++generation; for (const controller of reads) controller.abort(); reads.clear(); listeners.clear(); },
  };
}
