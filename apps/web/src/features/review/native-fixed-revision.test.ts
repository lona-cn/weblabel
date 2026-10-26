// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import type { AuthEntry, SessionController } from '../../app/session';
import { readRoute } from '../../app/route-state';
import { api } from '../../lib/t15/api';
import { reviewApi } from './api';
import { mountFixedRevisionPage } from './fixed-revision-page';
const owners: AbortController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.abort()); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const revision: AnnotationRevision = { annotation_revision_id: 'revision-fixed', parent_revision_id: null, revision_no: 1, document: { schema_version: 1, asset_revision_id: 'asset-fixed', ontology_version_id: 'ontology-fixed', coordinate_space: { type: 'canonical_image_pixels', width: 20, height: 20 }, completion: 'in_progress', objects: [] }, created_at: '2026-10-10T00:00:00Z', created_by: 'actor', content_hash: 'a'.repeat(64) };
function mount() {
  const owner = new AbortController(); owners.push(owner); const root = document.createElement('div'); document.body.append(root);
  const onWorkbench = vi.fn(), onProjects = vi.fn(), onReview = vi.fn();
  let entry: AuthEntry = { kind: 'authenticated', session: { user_id: 'actor', username: 'actor', platform_admin: false, project_roles: [{ project_id: 'project', role: 'viewer' }] }, createdUsername: null };
  const listeners = new Set<() => void>();
  const session: SessionController = { getSnapshot: () => entry, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, login: vi.fn(), bootstrap: vi.fn(), recover: vi.fn(), logout: vi.fn(), refresh: vi.fn(), dispose: vi.fn() };
  const dispose = mountFixedRevisionPage(root, { signal: owner.signal, session, navigate: vi.fn(), route: readRoute(new URL('http://localhost')), projectId: 'project', assetId: 'asset-fixed', ontologyId: 'ontology-fixed', revisionId: 'revision-fixed', onWorkbench, onProjects, onReview });
  return { owner, root, dispose, onWorkbench, onProjects, revoke() { entry = { kind: 'login', usernameHint: '' }; listeners.forEach(listener => listener()); } };
}
it('rejects a mismatched fixed target without requesting an image or current head', async () => {
  vi.spyOn(reviewApi, 'revision').mockResolvedValue({ ...revision, document: { ...revision.document, asset_revision_id: 'different-image' } });
  const image = vi.spyOn(api, 'image'), currentHead = vi.spyOn(api, 'annotation'); const view = mount();
  await vi.waitFor(() => expect(view.root.querySelector('[role=alert]')?.textContent).toContain('不会替换'));
  expect(image).not.toHaveBeenCalled(); expect(currentHead).not.toHaveBeenCalled();
  const open = [...view.root.querySelectorAll('button')].find(button => button.textContent === '打开此图片的当前标注')!;
  expect(open.disabled).toBe(true); open.click(); expect(view.onWorkbench).not.toHaveBeenCalled();
});
it('aborts the fixed revision read and ignores a late acknowledgement on disposal', async () => {
  let finish!: (value: AnnotationRevision) => void; let signal: AbortSignal | undefined;
  vi.spyOn(reviewApi, 'revision').mockImplementation((_id, ownedSignal) => { signal = ownedSignal; return new Promise(resolve => { finish = resolve; }); });
  const image = vi.spyOn(api, 'image'); const view = mount(); const projects = [...view.root.querySelectorAll('button')].find(button => button.textContent === '项目')!;
  view.dispose(); expect(signal?.aborted).toBe(true); projects.click(); expect(view.onProjects).not.toHaveBeenCalled();
  finish(revision); await Promise.resolve(); await Promise.resolve(); expect(view.root.childElementCount).toBe(0); expect(image).not.toHaveBeenCalled();
});
it('rejects a mismatched parent rather than using the submitted revision as the before view', async () => {
  vi.spyOn(reviewApi, 'revision').mockImplementation(async id => id === 'revision-fixed' ? { ...revision, parent_revision_id: 'parent-fixed' } : { ...revision, annotation_revision_id: 'parent-fixed', document: { ...revision.document, ontology_version_id: 'other-ontology' } });
  const view = mount(); await vi.waitFor(() => expect(view.root.querySelector('[role=alert]')?.textContent).toContain('不会替换'));
  expect(view.root.querySelector('svg')).toBeNull();
});
it('revokes a pending fixed revision read before a late response can fetch child data', async () => {
  let finish!: (value: AnnotationRevision) => void; let signal: AbortSignal | undefined;
  const revisions = vi.spyOn(reviewApi, 'revision').mockImplementation((_id, ownedSignal) => { signal = ownedSignal; return new Promise(resolve => { finish = resolve; }); });
  const image = vi.spyOn(api, 'image'), ontologies = vi.spyOn(api, 'ontologies'); const view = mount();
  view.revoke(); expect(signal?.aborted).toBe(true); finish({ ...revision, parent_revision_id: 'parent-fixed' });
  await Promise.resolve(); await Promise.resolve();
  expect(revisions).toHaveBeenCalledTimes(1); expect(image).not.toHaveBeenCalled(); expect(ontologies).not.toHaveBeenCalled();
  expect(view.root.querySelector('svg')).toBeNull();
});
it('aborts the fixed image on session revocation and never publishes its late bytes', async () => {
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:fixed'); static revokeObjectURL = vi.fn(); });
  vi.spyOn(reviewApi, 'revision').mockResolvedValue(revision);
  vi.spyOn(api, 'ontologies').mockResolvedValue({ items: [{ project_id: 'project', ontology_version_id: 'ontology-fixed', version_no: 1, labels: [], guidelines_markdown: '', allow_out_of_bounds: false }], next_cursor: null });
  let finish!: (value: Blob) => void; let signal: AbortSignal | undefined;
  const image = vi.spyOn(api, 'image').mockImplementation((_id, ownedSignal) => { signal = ownedSignal; return new Promise(resolve => { finish = resolve; }); });
  const view = mount(); await vi.waitFor(() => expect(image).toHaveBeenCalledTimes(1));
  view.revoke(); expect(signal?.aborted).toBe(true); finish(new Blob(['fixed image bytes'], { type: 'image/png' }));
  await Promise.resolve(); await Promise.resolve();
  expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(view.root.querySelector('svg')).toBeNull();
  expect([...view.root.querySelectorAll('button')].find(button => button.textContent === '打开此图片的当前标注')!.disabled).toBe(true);
});
