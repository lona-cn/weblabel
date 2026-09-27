import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setCsrfToken, type Session } from '../lib/t15/api';

type SessionContextValue = {
  session: Session | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};
const SessionContext = createContext<SessionContextValue | null>(null);

export function AppProviders({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    const savedCsrf = globalThis.sessionStorage?.getItem('weblabel_csrf') ?? null;
    setCsrfToken(savedCsrf);
    try {
      setSession(await api.session());
    } catch {
      setSession(null);
      setCsrfToken(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const login = useCallback(async (username: string, password: string) => {
    const identity = await api.login(username, password);
    const token = globalThis.sessionStorage?.getItem('weblabel_csrf');
    if (!token) throw new Error('登录响应未提供 CSRF token');
    setSession(identity);
  }, []);
  const logout = useCallback(async () => {
    await api.logout();
    globalThis.sessionStorage?.removeItem('weblabel_csrf');
    setCsrfToken(null);
    setSession(null);
  }, []);
  const value = useMemo(() => ({ session, loading, login, logout, refresh }), [session, loading, login, logout, refresh]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession must be used inside AppProviders');
  return value;
}

export type RuntimeMode = 'api';
export function useRuntimeMode(): RuntimeMode { return 'api'; }
