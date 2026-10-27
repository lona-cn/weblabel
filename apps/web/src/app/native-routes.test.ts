// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { mountRoutes } from './routes';
import { readRoute } from './route-state';
import type { AuthEntry, SessionController } from './session';
import { api, setCsrfToken, type Session } from '../lib/t15/api';
import { reviewApi } from '../features/review/api';
import type { AnnotationRevision } from '../../../../packages/contracts/generated/AnnotationRevision';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanups.splice(0).reverse()) dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setCsrfToken(null); document.body.replaceChildren(); history.replaceState(null, '', '/'); });
function fixture(query: string) {
  history.replaceState(null, '', '/' + query);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  const projectId = 'route-' + crypto.randomUUID();
  const identity: Session = { user_id: 'actor', username: 'Synthetic actor', platform_admin: false, project_roles: [{ project_id: projectId, role: 'admin' }] };
  let entry: AuthEntry = { kind: 'authenticated', session: identity, createdUsername: null };
  const listeners = new Set<() => void>();
  const session: SessionController = { getSnapshot: () => entry, subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }, refresh: vi.fn(async () => {}), login: vi.fn(), bootstrap: vi.fn(), recover: vi.fn(), logout: vi.fn(), dispose: vi.fn() };
  const project = { project_id: projectId, name: 'Synthetic route project', description: '', allow_self_review: false, role: 'admin' };
  vi.spyOn(api, 'projects').mockResolvedValue({ items: [project], next_cursor: null });
  vi.spyOn(api, 'assets').mockResolvedValue([]); vi.spyOn(api, 'ontologies').mockResolvedValue({ items: [], next_cursor: null }); vi.spyOn(api, 'members').mockResolvedValue({ items: [], next_cursor: null });
  vi.spyOn(reviewApi, 'tasks').mockResolvedValue({ items: [], next_cursor: null });
  const root = document.createElement('div'); document.body.append(root);
  const setRoute = (query: string) => { history.replaceState(null, '', '/?' + query.replaceAll('PROJECT', projectId)); window.dispatchEvent(new PopStateEvent('popstate')); };
  if (query.includes('PROJECT')) history.replaceState(null, '', '/' + query.replaceAll('PROJECT', projectId));
  cleanups.push(mountRoutes(root, session));
  return { root, session, projectId, project, identity, setRoute, change(next: AuthEntry) { entry = next; for (const listener of listeners) listener(); } };
}
function action(root: HTMLElement, name: string) {
  const button = [...root.querySelectorAll('button')].find(node => node.textContent === name);
  if (!button) throw new Error('Missing native action: ' + name);
  return button;
}
it('parses encoded fixed ids, every queue and task identity without normalizing away an empty revision', () => {
  for (const queue of ['all', 'mine', 'pending', 'returned', 'closed']) {
    const url = new URL('http://localhost/?project_id=p%2Fa&asset_revision_id=a%3F&ontology_version_id=o%26&annotation_revision_id=&task_id=t%2F1&review_queue=' + queue);
    expect(readRoute(url)).toMatchObject({ projectId: 'p/a', assetId: 'a?', ontologyId: 'o&', revisionId: '', taskId: 't/1', queue });
  }
  expect(readRoute(new URL('http://localhost/?review_queue=invalid')).queue).toBeUndefined();
});
it.each(['?annotation_revision_id=fixed', '?project_id=PROJECT&annotation_revision_id=', '?project_id=PROJECT&annotation_revision_id=fixed&asset_revision_id=a', '?project_id=PROJECT&task_id=task'])('fails closed for incomplete fixed target %s without requesting current head', query => {
  const head = vi.spyOn(api, 'annotation'), revision = vi.spyOn(reviewApi, 'revision');
  const f = fixture(query);
  expect(f.root.querySelector('[role=alert]')?.textContent).toContain('不会');
  expect(f.root.querySelector('[data-testid=workbench]')).toBeNull(); expect(head).not.toHaveBeenCalled(); expect(revision).not.toHaveBeenCalled();
});
it('navigates real project, workbench and dataset pages and restores the query through popstate', async () => {
  const f = fixture('?asset_revision_id=old&ontology_version_id=old&review_queue=returned');
  await vi.waitFor(() => expect(f.root.textContent).toContain(f.project.name));
  const open = f.root.querySelector<HTMLButtonElement>('[data-testid="project-' + f.projectId + '-open"]');
  if (!open) throw new Error('Project open action missing'); open.click();
  await vi.waitFor(() => expect(f.root.querySelector('[data-testid=workbench]')).not.toBeNull());
  expect(new URL(location.href).searchParams.get('project_id')).toBe(f.projectId); expect(new URL(location.href).searchParams.has('review_queue')).toBe(false);
  action(f.root, '交付').click(); await vi.waitFor(() => expect(f.root.querySelector('[data-testid=datasets-page]')).not.toBeNull());
  expect(new URL(location.href).searchParams.get('dataset_view')).toBe('1');
  f.setRoute('project_id=PROJECT&review_queue=returned'); await vi.waitFor(() => expect(f.root.querySelector('[data-testid=workbench]')).not.toBeNull());
  expect([...f.root.querySelectorAll('details')].find(node => node.querySelector(':scope > summary')?.textContent === '任务与审核')?.open).toBe(true);
  action(f.root, '项目').click(); await vi.waitFor(() => expect(f.root.querySelector('[data-testid=projects-page]')).not.toBeNull());
  expect(new URL(location.href).searchParams.has('project_id')).toBe(false);
});
it('keeps delivery navigation ahead of stale fixed revision and task query fields', () => {
  const f = fixture('?project_id=PROJECT&dataset_view=1&annotation_revision_id=&task_id=');
  expect(f.root.querySelector('[data-testid=datasets-page]')).not.toBeNull();
  expect(f.root.querySelector('[data-testid=fixed-revision-page]')).toBeNull();
  expect(f.root.querySelector('[data-testid=workbench]')).toBeNull();
});
it('aborts a real fixed revision read on navigation and does not let its late response replace the new page', async () => {
  const pending = Promise.withResolvers<AnnotationRevision>(); let ownedSignal: AbortSignal | undefined;
  vi.spyOn(reviewApi, 'revision').mockImplementation((_id, signal) => { ownedSignal = signal; return pending.promise; });
  const f = fixture('?project_id=PROJECT&asset_revision_id=asset&ontology_version_id=ontology&annotation_revision_id=fixed');
  expect(ownedSignal?.aborted).toBe(false); action(f.root, '项目').click(); expect(ownedSignal?.aborted).toBe(true);
  pending.resolve({ annotation_revision_id: 'fixed', parent_revision_id: null, revision_no: 1, content_hash: 'hash', created_at: 'now', created_by: 'actor', document: { schema_version: 1, asset_revision_id: 'asset', ontology_version_id: 'ontology', coordinate_space: { type: 'canonical_image_pixels', width: 10, height: 10 }, completion: 'complete', objects: [] } });
  await vi.waitFor(() => expect(f.root.querySelector('[data-testid=projects-page]')).not.toBeNull());
  expect(f.root.querySelector('[data-testid=fixed-revision-page]')).toBeNull(); expect(f.root.querySelector('svg')).toBeNull();
});
it('revokes the old page read on actor/role replacement, even for the same project URL', async () => {
  const pending = Promise.withResolvers<AnnotationRevision>(); const signals: AbortSignal[] = [];
  vi.spyOn(reviewApi, 'revision').mockImplementation((_id, signal) => { if (signal) signals.push(signal); return pending.promise; });
  const f = fixture('?project_id=PROJECT&asset_revision_id=asset&ontology_version_id=ontology&annotation_revision_id=fixed');
  expect(signals).toHaveLength(1);
  f.change({ kind: 'authenticated', createdUsername: null, session: { ...f.identity, user_id: 'other', project_roles: [] } });
  expect(signals[0].aborted).toBe(true); expect(signals).toHaveLength(1);
  pending.resolve({} as AnnotationRevision); await Promise.resolve();
  expect(f.root.querySelector('svg')).toBeNull(); expect(f.root.textContent).toContain('当前身份');
});
