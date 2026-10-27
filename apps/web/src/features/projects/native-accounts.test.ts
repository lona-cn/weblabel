import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import { afterEach, expect, it, vi } from 'vitest';
import { createSessionController, type SessionController } from '../../app/session';
import { readRoute } from '../../app/route-state';
import { api, ApiFailure, setCsrfToken, type Session } from '../../lib/t15/api';
import type { PageContext } from '../../ui/page-context';
import { mountLoginPage } from './login-page';
import { mountProjectsPage } from './projects-page';
import { mountMemberManager } from './member-manager-page';
import { mountExternalProcessingPolicy } from './external-processing-policy';
import { compareOntologyDraft, formatOntologyDiffValue, fromVersion } from './ontology-draft';

const controllers: SessionController[] = [], disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); controllers.splice(0).forEach(controller => controller.dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals(); setCsrfToken(null); sessionStorage.clear(); document.body.replaceChildren(); });
async function context(session?: Session): Promise<PageContext> {
  vi.spyOn(api, 'adminRecoveryStatus').mockResolvedValue({ state: 'disabled', request_id: null, username: null });
  vi.spyOn(api, 'session').mockImplementation(async () => { if (session) return session; throw new ApiFailure(401, 'UNAUTHENTICATED', 'sign in'); });
  vi.spyOn(api, 'bootstrapStatus').mockResolvedValue({ mode: 'login', bootstrap_available: false });
  if (session) sessionStorage.setItem('weblabel_csrf', 'synthetic-account-csrf');
  const controller = createSessionController(); controllers.push(controller); await controller.refresh();
  return { session: controller, navigate: vi.fn(), signal: new AbortController().signal, route: readRoute(new URL('http://localhost/')) };
}
function field(id: string): HTMLInputElement { const node = document.querySelector<HTMLInputElement>(`[data-testid="${id}"]`); if (!node) throw new Error(`missing field ${id}`); return node; }
function enter(id: string, value: string) { const node = field(id); node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); }
function click(id: string) { const node = document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`); if (!node) throw new Error(`missing action ${id}`); node.click(); }
function host() { const node = document.createElement('div'); document.body.append(node); return node; }
const admin: Session = { user_id: 'actor', username: 'synthetic-admin', platform_admin: true, project_roles: [{ project_id: 'p', role: 'admin' }] };
const project = { project_id: 'p', name: 'Synthetic', description: '', allow_self_review: false, role: 'admin' };

it('retains password and input focus after rejected ordinary login, with associated field error', async () => {
  const ctx = await context();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'INVALID_CREDENTIALS', message: 'rejected' }), { status: 401 })));
  disposers.push(mountLoginPage(host(), ctx)); enter('login-username', 'synthetic'); enter('login-password', 'synthetic-password');
  const password = field('login-password'); password.focus();
  password.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(password.getAttribute('aria-invalid')).toBe('true'));
  expect(field('login-password')).toBe(password); expect(password.value).toBe('synthetic-password'); expect(document.activeElement).toBe(password);
  expect(password.getAttribute('aria-describedby')).toContain('login-password-error');
});

it.each(['lost-bootstrap-ack', 'committed-bootstrap-read-failure'] as const)('re-enables readonly session checking after %s and confirms a new GET before login', async failure => {
  const ctx = await context();
  vi.mocked(api.bootstrapStatus).mockResolvedValue({ mode: 'initial', bootstrap_available: true }); await ctx.session.refresh();
  const write = vi.spyOn(api, 'bootstrap');
  if (failure === 'lost-bootstrap-ack') write.mockRejectedValue(new TypeError('lost ACK'));
  else {
    write.mockResolvedValue({ user_id: 'synthetic-user', username: 'synthetic-admin', csrf_token: 'synthetic-csrf' });
    vi.mocked(api.session).mockRejectedValue(new TypeError('session read unavailable'));
  }
  disposers.push(mountLoginPage(host(), ctx)); enter('bootstrap-launch-code', 'synthetic-code'); enter('bootstrap-password', 'synthetic-password'); enter('bootstrap-password-confirm', 'synthetic-password'); click('bootstrap-submit');
  await vi.waitFor(() => {
    expect(document.querySelector('[data-testid="bootstrap-submit"]')).toBeNull();
    expect((document.querySelector('[data-testid="session-retry"]') as HTMLButtonElement).disabled).toBe(false);
  });
  const sessionReads = vi.mocked(api.session).mock.calls.length;
  vi.mocked(api.session).mockRejectedValue(new ApiFailure(401, 'UNAUTHENTICATED', 'sign in'));
  click('session-retry');
  await vi.waitFor(() => expect(document.querySelector('[data-testid="login-submit"]')).not.toBeNull());
  expect(vi.mocked(api.session).mock.calls.length).toBeGreaterThan(sessionReads);
  expect(ctx.session.getSnapshot()).toMatchObject({ kind: 'login' });
  expect(write).toHaveBeenCalledTimes(1);
});

it('focuses a summary and links local credential errors without submitting invalid setup', async () => {
  const ctx = await context(); vi.mocked(api.bootstrapStatus).mockResolvedValue({ mode: 'initial', bootstrap_available: true }); await ctx.session.refresh();
  const write = vi.spyOn(api, 'bootstrap'); disposers.push(mountLoginPage(host(), ctx)); click('bootstrap-submit');
  expect(document.activeElement?.getAttribute('role')).toBe('alert'); expect(field('bootstrap-password').getAttribute('aria-invalid')).toBe('true'); expect(write).not.toHaveBeenCalled();
});

it('renders exclusive recovery and preserves unknown request fencing through a readonly check', async () => {
  const ctx = await context();
  const status = { state: 'available' as const, request_id: '00000000-0000-4000-8000-000000000001', username: 'synthetic-admin' };
  vi.mocked(api.adminRecoveryStatus).mockResolvedValue(status); await ctx.session.refresh();
  const write = vi.spyOn(api, 'adminRecover').mockRejectedValue(new TypeError('lost ACK'));
  disposers.push(mountLoginPage(host(), ctx)); expect(document.querySelector('[data-testid="login-submit"]')).toBeNull();
  enter('recovery-code', 'synthetic-code'); enter('recovery-password', 'synthetic-password'); enter('recovery-confirm', 'synthetic-password'); click('recovery-submit');
  await vi.waitFor(() => expect(ctx.session.getSnapshot()).toMatchObject({ kind: 'recovery', phase: 'unknown' }));
  expect((document.querySelector('[data-testid="recovery-submit"]') as HTMLButtonElement).disabled).toBe(true);
  vi.mocked(api.adminRecoveryStatus).mockResolvedValue({ ...status, state: 'completed' }); click('recovery-check');
  await vi.waitFor(() => expect(ctx.session.getSnapshot()).toMatchObject({ kind: 'recovery', status: { state: 'completed' } })); expect(write).toHaveBeenCalledTimes(1);
});

it('keeps unknown project creation locked after finding a same-name project, without publishing or reposting', async () => {
  const ctx = await context(admin); const projects = vi.spyOn(api, 'projects').mockResolvedValue({ items: [], next_cursor: null });
  const create = vi.spyOn(api, 'createProject').mockRejectedValue(new TypeError('lost ACK')), publish = vi.spyOn(api, 'publishOntology');
  disposers.push(mountProjectsPage(host(), { ...ctx, onOpen: vi.fn(), createdUsername: null }));
  await vi.waitFor(() => expect((document.querySelector('[data-testid="project-submit"]') as HTMLButtonElement).disabled).toBe(false));
  expect(document.querySelector<HTMLFormElement>('[data-testid="project-create"]')!.hidden).toBe(true);
  click('project-create-toggle');
  enter('project-name', 'Synthetic'); click('project-submit');
  await vi.waitFor(() => expect((document.querySelector('[data-testid="project-reconcile"]') as HTMLButtonElement).hidden).toBe(false));
  projects.mockResolvedValue({ items: [project], next_cursor: null }); click('project-reconcile');
  await vi.waitFor(() => expect(document.body.textContent).toContain('没有服务端 operation 关联'));
  expect(create).toHaveBeenCalledTimes(1); expect(publish).not.toHaveBeenCalled(); expect(field('project-name').value).toBe('Synthetic');
  const back = document.querySelector<HTMLButtonElement>('[data-testid="project-editor-back"]')!;
  expect(back.disabled).toBe(false); back.click();
  const configure = document.querySelector<HTMLButtonElement>('[data-testid="project-p-ontology"]')!;
  expect(configure.closest('table')!.closest('section')!.hidden).toBe(false);
  vi.spyOn(api, 'ontologies').mockResolvedValue({ items: [], next_cursor: null });
  configure.click();
  await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>('[data-testid="ontology-version"]')!.parentElement!.hidden).toBe(false));
  click('project-editor-back'); click('project-create-toggle');
  expect(field('project-name').value).toBe('Synthetic');
  expect((document.querySelector('[data-testid="project-submit"]') as HTMLButtonElement).disabled).toBe(true);
  expect(create).toHaveBeenCalledTimes(1); expect(publish).not.toHaveBeenCalled();
});

it('does not expose platform account creation to a project-only administrator', async () => {
  const ctx = await context({ ...admin, platform_admin: false }), request = vi.spyOn(api, 'request');
  disposers.push(mountMemberManager(host(), { ...ctx, project }));
  expect(document.querySelector('[data-testid="account-create"]')).toBeNull(); expect(document.querySelector('[data-testid="member-assign"]')).not.toBeNull(); expect(request).not.toHaveBeenCalled();
});

it('does not repost unknown member assignment when checking an exact target across pages', async () => {
  const ctx = await context(admin), write = vi.spyOn(api, 'request').mockRejectedValue(new TypeError('lost ACK'));
  const members = vi.spyOn(api, 'members').mockImplementation(async (_id, cursor) => cursor ? { items: [{ user_id: 'target', username: 'synthetic', role: 'viewer' }], next_cursor: null } : { items: [], next_cursor: 'page-two' });
  disposers.push(mountMemberManager(host(), { ...ctx, project })); enter('member-user-id', 'target'); click('member-assign');
  await vi.waitFor(() => expect((document.querySelector('[data-testid="members-reconcile"]') as HTMLButtonElement).hidden).toBe(false)); click('members-reconcile');
  await vi.waitFor(() => expect(document.body.textContent).toContain('实际目标 target：viewer；原请求目标 reviewer'));
  expect(write).toHaveBeenCalledTimes(1); expect(members).toHaveBeenCalledTimes(2); expect((document.querySelector('[data-testid="member-assign"]') as HTMLButtonElement).disabled).toBe(true);
});

it('keeps the server policy denied while an unsaved allow draft is checked, and treats lost ACK as unknown', async () => {
  const ctx = await context(admin); vi.spyOn(api, 'externalProcessingPolicy').mockResolvedValue({ allow_external_processing: false });
  const write = vi.spyOn(api, 'setExternalProcessingPolicy').mockRejectedValue(new TypeError('lost ACK'));
  disposers.push(mountExternalProcessingPolicy(host(), { ...ctx, projectId: 'p', projectName: 'Synthetic' }));
  await vi.waitFor(() => expect(field('external-processing-allow').disabled).toBe(false));
  const allow = field('external-processing-allow'); allow.checked = true; allow.dispatchEvent(new Event('change', { bubbles: true }));
  expect(document.querySelector('.accounts-policy-state')?.getAttribute('data-state')).toBe('denied'); click('external-policy-save');
  await vi.waitFor(() => expect(document.querySelector('.accounts-policy-state')?.getAttribute('data-state')).toBe('unknown'));
  expect((document.querySelector('[data-testid="external-policy-save"]') as HTMLButtonElement).disabled).toBe(true); expect(write).toHaveBeenCalledTimes(1);
});

it('aborts an owned project fetch, fences its late response and disables writes after page cancellation', async () => {
  const ctx = await context(admin), owner = new AbortController(), write = vi.spyOn(api, 'request');
  const pending = Promise.withResolvers<Response>(), aborted = vi.fn();
  let readSignal: AbortSignal | null | undefined;
  vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
    readSignal = init?.signal;
    readSignal?.addEventListener('abort', aborted, { once: true });
    return pending.promise;
  }));
  const projectsRoot = host();
  disposers.push(mountProjectsPage(projectsRoot, { ...ctx, signal: owner.signal, onOpen: vi.fn(), createdUsername: null }));
  disposers.push(mountMemberManager(host(), { ...ctx, signal: owner.signal, project }));
  enter('member-user-id', 'target');
  expect(readSignal).toBeDefined();
  expect(readSignal?.aborted).toBe(false);
  owner.abort();
  expect(aborted).toHaveBeenCalledTimes(1);
  expect(readSignal?.aborted).toBe(true);
  click('member-assign');
  expect(write).not.toHaveBeenCalled();
  // Deliberately return a response even after transport cancellation to exercise the view fence.
  const response = new Response(JSON.stringify({ items: [{ ...project, name: 'Late cancelled project' }], next_cursor: null }), { status: 200 });
  const bodyRead = vi.spyOn(response, 'json');
  pending.resolve(response);
  await vi.waitFor(() => expect(bodyRead).toHaveBeenCalledTimes(1));
  expect(projectsRoot.textContent).not.toContain('Late cancelled project');
  expect(projectsRoot.querySelector('[data-testid="project-p-open"]')).toBeNull();
});

it('publishes all four typed defaults without confusing empty strings, false, zero and null', async () => {
  const ctx = await context(admin);
  vi.spyOn(api, 'projects').mockResolvedValue({ items: [], next_cursor: null });
  vi.spyOn(api, 'createProject').mockResolvedValue(project);
  let published: OntologyVersion | null = null;
  vi.spyOn(api, 'ontologies').mockImplementation(async () => ({ items: published ? [published] : [], next_cursor: null }));
  const publish = vi.spyOn(api, 'publishOntology').mockImplementation(async (_id, body) => {
    published = { ...body, ontology_version_id: 'fixed-o', project_id: 'p', version_no: 1, allow_out_of_bounds: false };
    return published;
  });
  disposers.push(mountProjectsPage(host(), { ...ctx, onOpen: vi.fn(), createdUsername: null }));
  await vi.waitFor(() => expect((document.querySelector('[data-testid="project-submit"]') as HTMLButtonElement).disabled).toBe(false));
  click('project-create-toggle');
  enter('project-name', 'Synthetic');
  const labelName = document.querySelector<HTMLInputElement>('[data-testid^="label-"][data-testid$="-name"]')!;
  const labelId = labelName.id.slice('label-'.length, -'-name'.length);
  for (const [index, kind] of ['enum', 'boolean', 'number', 'text'].entries()) {
    click(`label-${labelId}-add-attribute`);
    const prefix = `attr-${labelId}-${index}`;
    const select = document.querySelector<HTMLSelectElement>(`[data-testid="${prefix}-kind"]`)!;
    select.value = kind; select.dispatchEvent(new Event('change', { bubbles: true }));
    enter(`${prefix}-key`, `attribute-${kind}`);
    if (kind !== 'text') {
      field(`${prefix}-null`).click();
      if (kind === 'number') { enter(`${prefix}-value`, '0'); enter(`${prefix}-min`, '0'); enter(`${prefix}-max`, '1'); }
    }
  }
  click('project-submit');
  await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
  const attributes = publish.mock.calls[0][1].labels[0].attributes;
  expect(attributes.map(attribute => attribute.default_value)).toEqual(['', false, 0, null]);
  expect(attributes[0].enum_values).toEqual(['']);
  expect(attributes[2]).toMatchObject({ min: 0, max: 1 });
});

it.each(['copy-same-baseline', 'reopen-same-project'] as const)('keeps every attribute control, preview and publication consistent after %s', async reset => {
  const ctx = await context(admin);
  const version: OntologyVersion = {
    ontology_version_id: 'baseline-o', project_id: 'p', version_no: 1, allow_out_of_bounds: false, guidelines_markdown: '',
    labels: [{ label_id: 'stable-label', name: 'Equipment', color: '#e2763d', shortcut: 'E', allowed_geometry_types: ['bbox_xyxy'], attributes: [
      { key: 'state', kind: 'enum', required: true, default_value: 'ready', enum_values: ['ready', 'stopped'], min: null, max: null },
      { key: 'blocked', kind: 'boolean', required: false, default_value: false, enum_values: [], min: null, max: null },
      { key: 'quantity', kind: 'number', required: true, default_value: 1, enum_values: [], min: 0, max: 10 },
      { key: 'note', kind: 'text', required: false, default_value: null, enum_values: [], min: null, max: null },
    ] }],
  };
  let published: OntologyVersion | null = null;
  vi.spyOn(api, 'projects').mockResolvedValue({ items: [project], next_cursor: null });
  vi.spyOn(api, 'ontologies').mockImplementation(async () => ({ items: published ? [published, version] : [version], next_cursor: null }));
  const publish = vi.spyOn(api, 'publishOntology').mockImplementation(async (_id, body) => {
    published = { ...version, ...body, ontology_version_id: 'published-o', version_no: 2 }; return published;
  });
  const root = host(); disposers.push(mountProjectsPage(root, { ...ctx, onOpen: vi.fn(), createdUsername: null }));
  await vi.waitFor(() => expect(root.querySelector('[data-testid="project-p-ontology"]')).not.toBeNull());
  click('project-p-ontology');
  await vi.waitFor(() => expect(root.querySelectorAll('[data-testid="ontology-attribute"]').length).toBe(4));
  const retainedKey = field('attr-stable-label-0-key');
  for (let index = 0; index < 4; index++) {
    const prefix = `attr-stable-label-${index}`; enter(`${prefix}-key`, `edited-${index}`); field(`${prefix}-required`).click();
  }
  enter('attr-stable-label-0-value', 'stopped'); enter('attr-stable-label-0-values', 'ready\nstopped\nedited');
  enter('attr-stable-label-1-value', 'true'); field('attr-stable-label-1-null').click();
  enter('attr-stable-label-2-value', '7'); enter('attr-stable-label-2-min', '2'); enter('attr-stable-label-2-max', '8');
  field('attr-stable-label-3-null').click(); enter('attr-stable-label-3-value', 'edited text');
  expect(field('attr-stable-label-0-key')).toBe(retainedKey);
  if (reset === 'copy-same-baseline') {
    const select = root.querySelector<HTMLSelectElement>('[data-testid="ontology-version"]')!;
    select.value = version.ontology_version_id; select.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    click('project-editor-back'); click('project-p-ontology');
    await vi.waitFor(() => expect((root.querySelector('[data-testid="project-submit"]') as HTMLButtonElement).disabled).toBe(false));
  }
  version.labels[0].attributes.forEach((attribute, index) => {
    const prefix = `attr-stable-label-${index}`;
    expect(field(`${prefix}-key`).value).toBe(attribute.key);
    expect(field(`${prefix}-required`).checked).toBe(attribute.required);
    expect(field(`${prefix}-null`).checked).toBe(attribute.default_value === null);
    expect(field(`${prefix}-value`).value).toBe(attribute.default_value === null ? '' : String(attribute.default_value));
  });
  expect(field('attr-stable-label-0-values').value).toBe('ready\nstopped');
  expect(field('attr-stable-label-2-min').value).toBe('0'); expect(field('attr-stable-label-2-max').value).toBe('10');
  const preview = root.querySelector('.accounts-ontology-columns')!.lastElementChild!;
  expect([...preview.querySelectorAll('dd')].map(node => node.textContent)).toEqual(['"ready"', 'false', '1', 'null']);
  click('project-submit');
  await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
  expect(publish.mock.calls[0][1].labels[0].attributes).toEqual(version.labels[0].attributes);
});

it('does not mislabel a rejected username as a password error or clear either input', async () => {
  const ctx = await context(admin);
  vi.spyOn(api, 'request').mockRejectedValue(new ApiFailure(400, 'INVALID_USER', 'Username is invalid'));
  disposers.push(mountMemberManager(host(), { ...ctx, project: null }));
  enter('account-username', 'invalid name'); enter('account-password', 'synthetic-password');
  const password = field('account-password'); click('account-create');
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('Username is invalid'));
  expect(field('account-password')).toBe(password);
  expect(password.value).toBe('synthetic-password'); expect(field('account-username').value).toBe('invalid name');
  expect(password.getAttribute('aria-invalid')).not.toBe('true');
});

const semanticVersion: OntologyVersion = {
  ontology_version_id: 'fixed-semantic-o', project_id: 'p', version_no: 3, allow_out_of_bounds: false, guidelines_markdown: 'Original guidelines',
  labels: [{ label_id: 'machine', name: 'Machine', color: '#e2763d', shortcut: 'M', allowed_geometry_types: ['bbox_xyxy'], attributes: [
    { key: 'flag', kind: 'boolean', required: false, default_value: false, enum_values: [], min: null, max: null },
    { key: 'note', kind: 'text', required: false, default_value: '', enum_values: [], min: null, max: null },
    { key: 'count', kind: 'number', required: true, default_value: 0, enum_values: [], min: 0, max: 10 },
    { key: 'state', kind: 'enum', required: true, default_value: 'ready', enum_values: ['ready', ''], min: null, max: null },
  ] }],
};

it('compares a copied fixed ontology semantically without flagging wire-versus-draft or numeric spelling changes', () => {
  const draft = fromVersion(semanticVersion); draft[0].attributes[2].value = '0.0';
  const comparison = compareOntologyDraft(semanticVersion, draft, semanticVersion.guidelines_markdown);
  expect(comparison.validationError).toBeNull(); expect(comparison.changes).toEqual([]);
});

it('distinguishes false, explicit null and an empty text default in semantic differences', () => {
  const draft = fromVersion(semanticVersion); draft[0].attributes[0].isNull = true;
  let comparison = compareOntologyDraft(semanticVersion, draft, semanticVersion.guidelines_markdown);
  expect(comparison.changes).toHaveLength(1);
  expect(comparison.changes[0]).toMatchObject({ attributeKey: 'flag', field: 'default_value', before: false, after: null });
  expect(comparison.changes.some(change => change.attributeKey === 'note')).toBe(false);
  draft[0].attributes[1].isNull = true;
  comparison = compareOntologyDraft(semanticVersion, draft, semanticVersion.guidelines_markdown);
  expect(comparison.changes.find(change => change.attributeKey === 'note')).toMatchObject({ before: '', after: null });
  expect(formatOntologyDiffValue('')).toBe('""');
  expect(formatOntologyDiffValue(false)).toBe('false'); expect(formatOntologyDiffValue(0)).toBe('0');
});

it('reports exact category fields, attribute constraints, ordered enum options and guidelines changes', () => {
  const draft = fromVersion(semanticVersion), label = draft[0];
  label.name = 'Updated machine'; label.color = '#69d9bb'; label.shortcut = '';
  label.attributes[0].kind = 'text'; label.attributes[0].required = true;
  label.attributes[2].value = '5'; label.attributes[2].min = '2'; label.attributes[2].max = '8';
  label.attributes[3].value = 'stopped'; label.attributes[3].values = 'ready\nstopped\n';
  const comparison = compareOntologyDraft(semanticVersion, draft, 'Updated\nmultiline guidelines');
  expect(comparison.validationError).toBeNull();
  expect(new Set(comparison.changes.map(change => change.field))).toEqual(new Set(['name', 'color', 'shortcut', 'kind', 'required', 'default_value', 'min', 'max', 'enum_values', 'guidelines_markdown']));
  expect(comparison.changes.find(change => change.field === 'shortcut')).toMatchObject({ before: 'M', after: null });
  expect(comparison.changes.find(change => change.field === 'enum_values')).toMatchObject({ before: ['ready', ''], after: ['ready', 'stopped', ''] });
  expect(comparison.changes.find(change => change.field === 'min')).toMatchObject({ before: 0, after: 2 });
  expect(comparison.changes.find(change => change.field === 'max')).toMatchObject({ before: 10, after: 8 });
  expect(comparison.changes.find(change => change.field === 'guidelines_markdown')).toMatchObject({ before: 'Original guidelines', after: 'Updated\nmultiline guidelines' });
});

it('keeps added and removed category and attribute identities explicit in the comparison', () => {
  const baseline: OntologyVersion = { ...semanticVersion, labels: [...semanticVersion.labels, { ...semanticVersion.labels[0], label_id: 'removed-label', name: 'Removed machine', attributes: [] }] };
  const draft = fromVersion(semanticVersion);
  draft[0].attributes = draft[0].attributes.filter(attribute => attribute.key !== 'count');
  draft[0].attributes.push({ key: 'new-note', kind: 'text', required: false, isNull: false, value: '', values: '', min: '', max: '' });
  draft.push({ id: 'added-label', name: 'New machine', color: '#69d9bb', shortcut: '', attributes: [] });
  const comparison = compareOntologyDraft(baseline, draft, baseline.guidelines_markdown);
  expect(comparison.changes.find(change => change.labelId === 'removed-label' && change.field === 'name')).toMatchObject({ kind: 'removed', before: 'Removed machine', after: undefined });
  expect(comparison.changes.find(change => change.labelId === 'added-label' && change.field === 'name')).toMatchObject({ kind: 'added', before: undefined, after: 'New machine' });
  expect(comparison.changes.find(change => change.attributeKey === 'count' && change.field === 'kind')).toMatchObject({ kind: 'removed', before: 'number', after: undefined });
  expect(comparison.changes.find(change => change.attributeKey === 'new-note' && change.field === 'default_value')).toMatchObject({ kind: 'added', before: undefined, after: '' });
});

it.each(['not-finite', ''] as const)('diagnoses an invalid numeric default without replacing its raw %s input by null or zero', value => {
  const draft = fromVersion(semanticVersion); draft[0].attributes[2].value = value;
  const comparison = compareOntologyDraft(semanticVersion, draft, semanticVersion.guidelines_markdown);
  expect(comparison.validationError).not.toBeNull();
  expect(comparison.changes.find(change => change.attributeKey === 'count' && change.field === 'default_value')).toMatchObject({ before: 0, after: value });
  expect(draft[0].attributes[2].value).toBe(value);
});

it('diagnoses duplicate attribute keys while retaining the second occurrence and empty-string enum option', () => {
  const draft = fromVersion(semanticVersion);
  draft[0].attributes.push({ ...draft[0].attributes[1], key: 'flag', value: 'duplicate input' });
  const comparison = compareOntologyDraft(semanticVersion, draft, semanticVersion.guidelines_markdown);
  expect(comparison.validationError).not.toBeNull();
  expect(comparison.changes.find(change => change.attributeKey === 'flag' && change.occurrence === 1 && change.field === 'default_value')).toMatchObject({ kind: 'added', after: 'duplicate input' });
  expect(draft[0].attributes[3].values).toBe('ready\n');
});

it('renders fixed-version semantic values and keeps invalid draft input visible without false changes on initial copy', async () => {
  const ctx = await context(admin);
  vi.spyOn(api, 'projects').mockResolvedValue({ items: [project], next_cursor: null });
  vi.spyOn(api, 'ontologies').mockResolvedValue({ items: [semanticVersion], next_cursor: null });
  const root = host(); disposers.push(mountProjectsPage(root, { ...ctx, onOpen: vi.fn(), createdUsername: null }));
  await vi.waitFor(() => expect(root.querySelector('[data-testid="project-p-ontology"]')).not.toBeNull()); click('project-p-ontology');
  await vi.waitFor(() => expect(root.querySelector('[data-testid="ontology-diff-unchanged"]')).not.toBeNull());
  const flag = field('attr-machine-0-null'); flag.click();
  const flagRow = root.querySelector<HTMLTableRowElement>('[data-testid="ontology-diff-row"][data-attribute-key="flag"][data-field="default_value"]')!;
  expect(flagRow.cells[1].textContent).toBe('false'); expect(flagRow.cells[2].textContent).toContain('null');
  expect(root.querySelector('[data-testid="ontology-diff-row"][data-attribute-key="note"]')).toBeNull();
  enter('attr-machine-2-value', 'invalid number');
  expect(field('attr-machine-2-value').value).toBe('invalid number');
  const countRow = root.querySelector<HTMLTableRowElement>('[data-testid="ontology-diff-row"][data-attribute-key="count"][data-field="default_value"]')!;
  expect(countRow.cells[1].textContent).toBe('0'); expect(countRow.cells[2].textContent).toBe('"invalid number"');
  expect(root.querySelector('[data-testid="ontology-diff-diagnosis"]')?.getAttribute('role')).toBe('status');
  expect(root.querySelector('[data-testid="ontology-differences"]')?.textContent).toContain(semanticVersion.ontology_version_id);
});

it('presents a Chinese member role while preserving its exact wire role and full real user id for selection', async () => {
  const ctx = await context(admin), userId = '11111111-1111-4111-8111-111111111111';
  vi.spyOn(api, 'members').mockResolvedValue({ items: [{ user_id: userId, username: 'Synthetic member', role: 'admin' }], next_cursor: null });
  const root = host(); disposers.push(mountMemberManager(root, { ...ctx, project })); click('members-read');
  await vi.waitFor(() => expect(root.querySelector('tbody tr')).not.toBeNull());
  const row = root.querySelector<HTMLTableRowElement>('tbody tr')!;
  expect(row.cells[1].textContent).toBe(userId);
  expect(row.cells[2].querySelector('span')?.textContent).toBe('项目管理员'); expect(row.cells[2].querySelector('code')?.textContent).toBe('admin');
  click(`member-select-${userId}`); expect(field('member-user-id').value).toBe(userId);
  expect(root.querySelector<HTMLSelectElement>('[data-testid="member-role"]')!.value).toBe('admin');
});

it('keeps the attribute type change keyboard-focused and retains the text control across later input', async () => {
  const ctx = await context(admin); vi.spyOn(api, 'projects').mockResolvedValue({ items: [], next_cursor: null });
  const root = host(); disposers.push(mountProjectsPage(root, { ...ctx, onOpen: vi.fn(), createdUsername: null }));
  await vi.waitFor(() => expect((root.querySelector('[data-testid="project-submit"]') as HTMLButtonElement).disabled).toBe(false));
  click('project-create-toggle');
  const labelName = root.querySelector<HTMLInputElement>('[data-testid^="label-"][data-testid$="-name"]')!;
  const labelId = labelName.id.slice('label-'.length, -'-name'.length);
  click(`label-${labelId}-add-attribute`);
  const id = `attr-${labelId}-0-kind`, kind = root.querySelector<HTMLSelectElement>(`[data-testid="${id}"]`)!;
  kind.focus(); kind.value = 'enum'; kind.dispatchEvent(new Event('change', { bubbles: true }));
  expect(document.activeElement).toBe(root.querySelector(`[data-testid="${id}"]`));
  const key = field(`attr-${labelId}-0-key`); key.focus(); enter(`attr-${labelId}-0-key`, '保留输入');
  expect(field(`attr-${labelId}-0-key`)).toBe(key); expect(document.activeElement).toBe(key); expect(key.value).toBe('保留输入');
});

it('hides revoked project authority while retaining the draft and forbidding writes until a fresh complete list', async () => {
  const ctx = await context(admin), privateProject = { ...project, name: 'Private cached project' };
  const projects = vi.spyOn(api, 'projects').mockResolvedValue({ items: [privateProject], next_cursor: null });
  const create = vi.spyOn(api, 'createProject'), publish = vi.spyOn(api, 'publishOntology');
  const root = host(); disposers.push(mountProjectsPage(root, { ...ctx, onOpen: vi.fn(), createdUsername: null }));
  await vi.waitFor(() => expect(root.querySelector('[data-testid="project-p-open"]')).not.toBeNull());
  click('project-create-toggle'); enter('project-name', 'Retained local draft'); click('project-editor-back');
  projects.mockRejectedValue(new ApiFailure(403, 'FORBIDDEN', 'Synthetic permission revoked')); click('projects-reload');
  await vi.waitFor(() => expect(root.querySelector('form')!.getAttribute('aria-busy')).toBe('false'));
  expect(root.querySelector<HTMLButtonElement>('[data-testid="project-create-toggle"]')!.disabled).toBe(true);
  expect(root.textContent).not.toContain(privateProject.name); expect(field('project-name').value).toBe('Retained local draft');
  click('project-draft-view');
  expect(root.querySelector<HTMLFormElement>('[data-testid="project-create"]')!.hidden).toBe(false);
  expect(field('project-name').value).toBe('Retained local draft');
  expect(root.querySelector<HTMLButtonElement>('[data-testid="project-submit"]')!.disabled).toBe(true);
  click('project-editor-back');
  expect(document.activeElement).toBe(root.querySelector('[data-testid="project-draft-view"]'));
  root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  expect(create).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
  projects.mockResolvedValue({ items: [], next_cursor: null }); click('projects-reload');
  await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('[data-testid="project-create-toggle"]')!.disabled).toBe(false));
  expect(root.querySelector<HTMLFormElement>('[data-testid="project-create"]')!.hidden).toBe(true);
  expect(field('project-name').value).toBe('Retained local draft'); expect(create).not.toHaveBeenCalled();
  click('project-create-toggle'); expect(field('project-name').value).toBe('Retained local draft');
});
