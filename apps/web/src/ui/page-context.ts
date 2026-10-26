import type { SessionController } from '../app/session';
import type { RouteState } from '../app/route-state';

export interface PageContext {
  session: SessionController;
  navigate: (url: URL) => void;
  signal: AbortSignal;
  route: Readonly<RouteState>;
}
