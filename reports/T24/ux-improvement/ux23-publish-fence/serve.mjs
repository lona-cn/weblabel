import { createServer } from '../../../../apps/web/node_modules/vite/dist/node/index.js';
import react from '../../../../apps/web/node_modules/@vitejs/plugin-react/dist/index.js';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
let requests = [], held = null;
const server = await createServer({ configFile: false, root, cacheDir: 'D:/workspace/src/weblabel/target/ux23-publish-fence/vite', resolve: { alias: [{ find: /^react$/, replacement: root + 'apps/web/node_modules/react/index.js' }, { find: /^react\/jsx-runtime$/, replacement: root + 'apps/web/node_modules/react/jsx-runtime.js' }, { find: /^react\/jsx-dev-runtime$/, replacement: root + 'apps/web/node_modules/react/jsx-dev-runtime.js' }, { find: /^react-dom$/, replacement: root + 'apps/web/node_modules/react-dom/index.js' }, { find: /^react-dom\/client$/, replacement: root + 'apps/web/node_modules/react-dom/client.js' }] }, optimizeDeps: { entries: ['reports/T24/ux-improvement/ux23-publish-fence/surface.html'] }, plugins: [react(), { name: 'synthetic-publish-fence-http', configureServer(server) { server.middlewares.use(async (req, res, next) => {
  const path = new URL(req.url, 'http://127.0.0.1:5207').pathname;
  const json = (response, value) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
  if (path === '/fixture/reset') { if (held) throw new Error('Unreleased fixture response'); requests = []; return json(res, { reset: true }); }
  if (path === '/fixture/evidence') return json(res, { evidence_kind: 'synthetic_controlled_http_not_live', requests, held: held !== null });
  if (path === '/fixture/release') { if (!held) { res.statusCode = 409; return json(res, { error: 'No delayed response' }); } const value = held; held = null; json(value.res, value.session); return json(res, { released: true }); }
  if (!path.startsWith('/api/')) return next();
  if (req.method !== 'PUT' || !path.startsWith('/api/projects/project/activity-sessions/')) { res.statusCode = 404; return json(res, { error: 'Unexpected synthetic request' }); }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push({ method: req.method, path, body, csrf: req.headers['x-csrf-token'], cookie: req.headers.cookie });
  const session = { session_id: decodeURIComponent(path.split('/').at(-1)), version: body.expected_version + 1, intervals: body.intervals };
  if (requests.length === 1) { held = { res, session }; return; }
  json(res, session);
}); } }], server: { host: '127.0.0.1', port: 5207, strictPort: true, watch: { ignored: ['**/target/**'] }, fs: { allow: [root, 'D:/workspace/src/weblabel'] } } });
await server.listen(); console.log('Publish fence synthetic HTTP ready on 5207');
