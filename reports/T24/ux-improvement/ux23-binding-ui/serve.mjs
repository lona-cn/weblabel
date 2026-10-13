import { createServer } from '../../../../apps/web/node_modules/vite/dist/node/index.js';
import react from '../../../../apps/web/node_modules/@vitejs/plugin-react/dist/index.js';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const saved = new Map();
const requests = [];
const server = await createServer({ configFile: false, root, cacheDir: 'D:/workspace/src/weblabel/target/build-cache/ux23-ui/vite', resolve: { alias: [{ find: /^react$/, replacement: root + 'apps/web/node_modules/react/index.js' }, { find: /^react\/jsx-runtime$/, replacement: root + 'apps/web/node_modules/react/jsx-runtime.js' }, { find: /^react\/jsx-dev-runtime$/, replacement: root + 'apps/web/node_modules/react/jsx-dev-runtime.js' }, { find: /^react-dom\/client$/, replacement: root + 'apps/web/node_modules/react-dom/client.js' }] }, plugins: [react(), { name: 'controlled-ux23-http-fixture', configureServer(server) { server.middlewares.use(async (req, res, next) => {
  const url = new URL(req.url, 'http://127.0.0.1:5198');
  if (!url.pathname.startsWith('/api/') && url.pathname !== '/fixture-evidence') return next();
  const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
  if (url.pathname === '/fixture-evidence') return json({ evidence_kind: 'controlled_http_fixture_not_live', requests, sessions: [...saved.values()] });
  requests.push({ method: req.method, path: url.pathname });
  if (req.method === 'PUT' && url.pathname.startsWith('/api/projects/fixture-project/activity-sessions/')) {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); const session_id = decodeURIComponent(url.pathname.split('/').at(-1));
    const previous = saved.get(session_id);
    if (body.expected_version !== (previous?.version ?? 0) || previous && JSON.stringify(body.intervals.slice(0, previous.intervals.length)) !== JSON.stringify(previous.intervals)) { res.statusCode = 409; return json({ code: 'ACTIVITY_PREFIX_CONFLICT' }); }
    const session = { session_id, version: body.expected_version + 1, intervals: body.intervals }; saved.set(session_id, session); return json(session);
  }
  if (req.method === 'GET' && url.pathname.endsWith('/outcome-summary')) {
    const run_id = decodeURIComponent(url.pathname.split('/')[4]);
    const intervals = [...saved.values()].flatMap(item => item.intervals).filter(item => item.run_id === run_id && item.kind !== 'model_wait');
    const seconds = intervals.length ? intervals.reduce((sum, item) => sum + item.duration_ms, 0) / 1000 : null;
    const taskTime = intervals.filter(item => item.task_id).reduce((map, item) => map.set(item.task_id, (map.get(item.task_id) ?? 0) + item.duration_ms / 1000), new Map());
    return json({ run: { run_id, project_id: 'fixture-project', state: 'succeeded', cost_display: 'unknown' }, candidate_change_count: 1, accepted_change_count: 1, accept_journal_count: 1, revert_journal_count: 0, rejected_change_count: 0, object_observations: [{ suggestion_set_id: 'fixture-set', change_id: 'fixture-change', object_id: 'fixture-object', accepted_revision_id: 'fixture-saved', current_status: 'changed_since_acceptance', attribution: 'unknown' }], task_binding: { basis: 'exact_decision_revision_submission', submissions: [{ task_id: 'fixture-task', review_id: 'fixture-review', annotation_revision_id: 'fixture-saved', asset_revision_id: 'fixture-asset', ontology_version_id: 'fixture-ontology', task_state: 'submitted', review_state: 'pending', decision_kinds: ['accept'], suggestion_set_ids: ['fixture-set'] }], truncated: false }, activity_task_bindings: [...taskTime].map(([task_id, recorded_work_seconds]) => ({ task_id, recorded_work_seconds, basis: 'explicit_voluntary_run_task_interval' })), recorded_work_seconds: seconds, work_time_scope: 'current_actor_explicit_run_intervals', work_time_reason: intervals.length ? 'explicit_voluntary_run_intervals' : 'no_explicit_run_intervals', usage: null, cost_display: 'unknown' });
  }
  res.statusCode = 404; json({ code: 'CONTROLLED_FIXTURE_UNEXPECTED_HTTP' });
}); } }], server: { host: '127.0.0.1', port: 5198, strictPort: true, fs: { allow: [root, 'D:/workspace/src/weblabel'] } } });
await server.listen(); console.log('UX23 controlled HTTP fixture ready http://127.0.0.1:5198/reports/T24/ux-improvement/ux23-binding-ui/surface.html');
