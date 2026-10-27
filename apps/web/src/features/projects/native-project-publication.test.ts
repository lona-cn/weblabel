import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionController } from '../../app/session';
import { readRoute } from '../../app/route-state';
import { api, type Project, type Session } from '../../lib/t15/api';
import { mountProjectsPage } from './projects-page';

const project: Project = { project_id: 'p', name: 'Synthetic', description: '', allow_self_review: false, role: 'admin' };
const user: Session = { user_id: 'u', username: 'synthetic', platform_admin: true, project_roles: [{ project_id: 'p', role: 'admin' }] };
const baseline: OntologyVersion = {
  ontology_version_id: 'v1', project_id: 'p', version_no: 1, allow_out_of_bounds: false, guidelines_markdown: '',
  labels: [{ label_id: 'label', name: 'Equipment', color: '#e2763d', shortcut: 'E', allowed_geometry_types: ['bbox_xyxy'], attributes: [
    { key: 'quantity', kind: 'number', required: false, default_value: 1, enum_values: [], min: 0, max: 10 },
  ] }],
};
const published: OntologyVersion = {
  ...baseline, ontology_version_id: 'v2', version_no: 2,
  labels: [{ ...baseline.labels[0], attributes: [{ ...baseline.labels[0].attributes[0], max: 20 }] }],
};
const session: SessionController = {
  getSnapshot: () => ({ kind: 'authenticated', session: user, createdUsername: null }),
  subscribe: () => () => {}, login: async () => {}, bootstrap: async () => {}, recover: async () => {},
  logout: async () => {}, refresh: async () => {}, dispose: () => {},
};
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; vi.restoreAllMocks(); document.body.replaceChildren(); });

async function openDraft() {
  const root = document.createElement('div'); document.body.append(root);
  dispose = mountProjectsPage(root, {
    session, navigate: vi.fn(), signal: new AbortController().signal, route: readRoute(new URL('http://localhost/')),
    onOpen: vi.fn(), createdUsername: null,
  });
  const button = (testId: string) => root.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!;
  await vi.waitFor(() => expect(button('project-p-ontology')).not.toBeNull());
  button('project-p-ontology').click();
  await vi.waitFor(() => expect(root.querySelector('[data-testid="attr-label-0-max"]')).not.toBeNull());
  const max = root.querySelector<HTMLInputElement>('[data-testid="attr-label-0-max"]')!;
  max.value = '20'; max.dispatchEvent(new Event('input', { bubbles: true }));
  return { root, button };
}

it('keeps an unacknowledged publication on the fixed diff and never claims a matching version on readback', async () => {
  vi.spyOn(api, 'projects').mockResolvedValue({ items: [project], next_cursor: null });
  const versions = vi.spyOn(api, 'ontologies').mockResolvedValueOnce({ items: [baseline], next_cursor: null })
    .mockResolvedValue({ items: [published, baseline], next_cursor: null });
  const publish = vi.spyOn(api, 'publishOntology').mockRejectedValue(new TypeError('lost response'));
  const { root, button } = await openDraft();
  button('project-submit').click();
  await vi.waitFor(() => { expect(button('project-reconcile').hidden).toBe(false); expect(button('project-reconcile').disabled).toBe(false); });
  const columns = root.querySelector<HTMLElement>('.accounts-ontology-columns')!;
  const version = root.querySelector<HTMLSelectElement>('[data-testid="ontology-version"]')!;
  const row = root.querySelector<HTMLElement>('[data-testid="ontology-diff-row"][data-field="max"]')!;
  expect(columns.hidden).toBe(true); expect(version.disabled).toBe(true); expect(button('project-submit').disabled).toBe(true);
  expect([...row.querySelectorAll('td')].map(cell => cell.textContent)).toEqual(['10', '20']);
  button('project-reconcile').click();
  await vi.waitFor(() => { expect(versions).toHaveBeenCalledTimes(2); expect(button('project-reconcile').disabled).toBe(false); });
  expect(publish).toHaveBeenCalledTimes(1); expect(columns.hidden).toBe(true); expect(version.disabled).toBe(true);
  const retainedRow = root.querySelector<HTMLElement>('[data-testid="ontology-diff-row"][data-field="max"]')!;
  expect([...retainedRow.querySelectorAll('td')].map(cell => cell.textContent)).toEqual(['10', '20']);
});

it('keeps a confirmed publication available for read-only reconciliation after a read failure', async () => {
  vi.spyOn(api, 'projects').mockResolvedValue({ items: [project], next_cursor: null });
  const versions = vi.spyOn(api, 'ontologies').mockResolvedValueOnce({ items: [baseline], next_cursor: null })
    .mockRejectedValueOnce(new TypeError('read unavailable'))
    .mockResolvedValue({ items: [published, baseline], next_cursor: null });
  const publish = vi.spyOn(api, 'publishOntology').mockResolvedValue(published);
  const { root, button } = await openDraft();
  button('project-submit').click();
  await vi.waitFor(() => { expect(button('project-reconcile').hidden).toBe(false); expect(button('project-reconcile').disabled).toBe(false); });
  const columns = root.querySelector<HTMLElement>('.accounts-ontology-columns')!;
  const version = root.querySelector<HTMLSelectElement>('[data-testid="ontology-version"]')!;
  expect(columns.hidden).toBe(false); expect(version.disabled).toBe(true);
  button('project-reconcile').click();
  await vi.waitFor(() => { expect(versions).toHaveBeenCalledTimes(3); expect(version.disabled).toBe(false); });
  expect(publish).toHaveBeenCalledTimes(1); expect(columns.hidden).toBe(false); expect(version.disabled).toBe(false);
});
