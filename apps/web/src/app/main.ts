import { createSessionController } from './session';
import { mountRoutes } from './routes';
import '../styles/tokens.css';
import '../styles/forms.css';
import '../styles/shell.css';
import '../features/review/native-review.css';
import '../features/datasets/native-datasets.css';

const root = document.getElementById('root');
if (!root) throw new Error('WebLabel application root is missing');
const session = createSessionController();
const unmount = mountRoutes(root, session);
let disposed = false;
function dispose() {
  if (disposed) return;
  disposed = true; unmount(); session.dispose();
  window.removeEventListener('pagehide', pagehide);
  window.removeEventListener('pageshow', pageshow);
}
function pagehide(event: PageTransitionEvent) {
  // A bfcache entry retains its owner; an actual document departure releases it.
  if (!event.persisted) dispose();
}
function pageshow(event: PageTransitionEvent) {
  if (event.persisted && !disposed) void session.refresh();
}
window.addEventListener('pagehide', pagehide);
window.addEventListener('pageshow', pageshow);
void session.refresh();
if (import.meta.hot) import.meta.hot.dispose(dispose);
