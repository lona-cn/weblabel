import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiFailure, loginInScope, setCsrfToken, type Session, type BootstrapResult } from '../lib/t15/api';

export type AuthEntry =
  | { kind: 'checking' }
  | { kind: 'authenticated'; session: Session; createdUsername: string | null }
  | { kind: 'login'; usernameHint: string }
  | { kind: 'bootstrap'; mode: 'initial' | 'restore'; available: boolean }
  | { kind: 'bootstrap_created'; username: string | null; error: string | null }
  | { kind: 'error'; message: string };
type SessionContextValue = {
  entry: AuthEntry;
  login(username: string, password: string): Promise<void>;
  bootstrap(launchCode: string, password: string): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
};
const SessionContext = createContext<SessionContextValue | null>(null);
const readError = '无法检查本地账户状态。请重新检查，不要重复提交初始化。';
const cookieHelp = '会话已存在但未取得有效 CSRF。请在浏览器中仅清除此本地站点的 weblabel_session Cookie，再使用已设置的密码正常登录；不要清除项目数据或 IndexedDB。';
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function unauthenticated(reason: unknown): boolean { return reason instanceof ApiFailure && reason.status === 401 && reason.code === 'UNAUTHENTICATED'; }

export function AppProviders({ children }: { children: ReactNode }) {
  const [entry, setEntry] = useState<AuthEntry>({ kind: 'checking' });
  const generation = useRef(0);
  const pending = useRef<{ ack: BootstrapResult | null; username: string | null; received: boolean } | null>(null);
  const logoutFlight = useRef<Promise<void> | null>(null);
  const readStatus = useCallback(async (id: number, usernameHint = '') => {
    const status = await api.bootstrapStatus();
    if (id !== generation.current) return;
    setEntry(status.mode === 'login' ? { kind: 'login', usernameHint } : { kind: 'bootstrap', mode: status.mode, available: status.bootstrap_available });
  }, []);
  const check = useCallback(async (id: number) => {
    const creation = pending.current;
    const ack = creation?.ack;
    const validAck = ack && nonempty(ack.user_id) && nonempty(ack.username) && nonempty(ack.csrf_token);
    try {
      if (id !== generation.current) return;
      if (validAck) {
        setCsrfToken(ack.csrf_token);
        globalThis.sessionStorage.setItem('weblabel_csrf', ack.csrf_token);
      } else if (!creation) {
        setCsrfToken(globalThis.sessionStorage.getItem('weblabel_csrf'));
      }
      const session = await api.session();
      if (id !== generation.current) return;
      if (creation && !validAck) {
        pending.current = { ...creation, username: nonempty(session.username) ? session.username : creation.username };
        setEntry(creation.received ? { kind: 'bootstrap_created', username: pending.current.username, error: cookieHelp } : { kind: 'error', message: `本地账户：${pending.current.username ?? '未知'}。${cookieHelp}` });
        return;
      }
      setEntry({ kind: 'authenticated', session, createdUsername: creation?.username ?? null });
    } catch (reason) {
      if (id !== generation.current) return;
      if (unauthenticated(reason)) {
        setCsrfToken(null);
        try { globalThis.sessionStorage.removeItem('weblabel_csrf'); }
        catch { setEntry(creation?.received ? { kind: 'bootstrap_created', username: creation.username, error: readError } : { kind: 'error', message: readError }); return; }
        if (creation) {
          pending.current = null;
          setEntry({ kind: 'login', usernameHint: creation.username ?? '' });
        } else {
          try { await readStatus(id); }
          catch { if (id === generation.current) setEntry({ kind: 'error', message: readError }); }
        }
      } else {
        setEntry(creation?.received ? { kind: 'bootstrap_created', username: creation.username, error: readError } : { kind: 'error', message: readError });
      }
    }
  }, [readStatus]);
  const refresh = useCallback(async () => {
    const id = ++generation.current;
    const creation = pending.current;
    setEntry(creation?.received ? { kind: 'bootstrap_created', username: creation.username, error: null } : { kind: 'checking' });
    await check(id);
  }, [check]);
  useEffect(() => { void refresh(); return () => { ++generation.current; }; }, [refresh]);
  const login = useCallback(async (username: string, password: string) => {
    const id = ++generation.current;
    const identity = await loginInScope(username, password, () => id === generation.current);
    if (id !== generation.current || !identity) return;
    pending.current = null;
    setEntry({ kind: 'authenticated', session: identity, createdUsername: null });
  }, []);
  const bootstrap = useCallback(async (launchCode: string, password: string) => {
    const id = ++generation.current;
    let ack: BootstrapResult;
    try { ack = await api.bootstrap(launchCode, password); }
    catch (reason) {
      if (id !== generation.current) return;
      if (reason instanceof ApiFailure && (reason.status === 400 || reason.status === 401 || reason.code === 'LOGIN_RATE_LIMITED')) throw reason;
      if (reason instanceof ApiFailure && reason.status === 409) {
        try { await readStatus(id); }
        catch { if (id === generation.current) setEntry({ kind: 'error', message: readError }); }
        return;
      }
      pending.current = { ack: null, username: null, received: false };
      setEntry({ kind: 'error', message: '初始化请求结果尚未确认。请先重新检查会话，不要再次提交启动码。' });
      return;
    }
    if (id !== generation.current) return;
    const username = nonempty(ack?.username) ? ack.username : null;
    pending.current = { ack, username, received: true };
    setEntry({ kind: 'bootstrap_created', username, error: null });
    // The acknowledgement commits creation before any storage or identity read.
    await check(id);
  }, [check, readStatus]);
  const logout = useCallback((): Promise<void> => {
    if (logoutFlight.current) return logoutFlight.current;
    const id = ++generation.current;
    const operation = (async () => {
      try {
        await api.logout();
        if (id !== generation.current) return;
        setCsrfToken(null);
        pending.current = null;
        try { globalThis.sessionStorage.removeItem('weblabel_csrf'); }
        catch {
          setEntry({ kind: 'error', message: '已退出本地账户，但浏览器无法清除登录状态缓存。请重新检查。' });
          return;
        }
        setEntry({ kind: 'login', usernameHint: '' });
      } catch {
        if (id === generation.current) setEntry({ kind: 'error', message: '无法确认退出结果。请重新检查会话。' });
      }
    })();
    logoutFlight.current = operation;
    void operation.finally(() => { if (logoutFlight.current === operation) logoutFlight.current = null; });
    return operation;
  }, []);
  const value = useMemo(() => ({ entry, login, bootstrap, logout, refresh }), [entry, login, bootstrap, logout, refresh]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession must be used inside AppProviders');
  return value;
}
export type RuntimeMode = 'api';
export function useRuntimeMode(): RuntimeMode { return 'api'; }
