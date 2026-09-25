import { createContext, useContext, type ReactNode } from 'react';

export type RuntimeMode = 'fixture';
const RuntimeContext = createContext<RuntimeMode>('fixture');

export function AppProviders({ children }: { children: ReactNode }) {
  return <RuntimeContext.Provider value="fixture">{children}</RuntimeContext.Provider>;
}

export function useRuntimeMode() {
  return useContext(RuntimeContext);
}
