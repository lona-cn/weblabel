import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createSessionController, type AuthEntry, type SessionController } from './session';

type SessionContextValue = Pick<SessionController, 'login' | 'bootstrap' | 'recover' | 'logout' | 'refresh'> & { entry: AuthEntry };
const SessionContext = createContext<SessionContextValue | null>(null);

export function AppProviders({ children }: { children: ReactNode }) {
  const controller = useRef<SessionController | null>(null);
  const [entry, setEntry] = useState<AuthEntry>({ kind: 'checking' });
  useEffect(() => {
    const owned = createSessionController();
    controller.current = owned;
    const unsubscribe = owned.subscribe(() => setEntry(owned.getSnapshot()));
    setEntry(owned.getSnapshot());
    void owned.refresh();
    return () => {
      unsubscribe();
      owned.dispose();
      if (controller.current === owned) controller.current = null;
    };
  }, []);
  const login = useCallback((username: string, password: string) => controller.current?.login(username, password) ?? Promise.resolve(), []);
  const bootstrap = useCallback((code: string, password: string) => controller.current?.bootstrap(code, password) ?? Promise.resolve(), []);
  const recover = useCallback((code: string, password: string) => controller.current?.recover(code, password) ?? Promise.resolve(), []);
  const logout = useCallback(() => controller.current?.logout() ?? Promise.resolve(), []);
  const refresh = useCallback(() => controller.current?.refresh() ?? Promise.resolve(), []);
  const value = useMemo(() => ({ entry, login, bootstrap, recover, logout, refresh }), [entry, login, bootstrap, recover, logout, refresh]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession must be used inside AppProviders');
  return value;
}
export type RuntimeMode = 'api';
export function useRuntimeMode(): RuntimeMode { return 'api'; }
