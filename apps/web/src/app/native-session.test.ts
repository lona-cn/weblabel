// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createSessionController } from './session';
import { mountRoutes } from './routes';
import { csrfToken, setCsrfToken } from '../lib/t15/api';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanups.splice(0).reverse()) dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setCsrfToken(null); sessionStorage.clear(); document.body.replaceChildren(); history.replaceState(null, '', '/'); });
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
it.each(['session-401', 'recovery-status'] as const)('keeps the new bootstrap identity and token after a delayed old %s response', async delayed => {
  history.replaceState(null, '', '/');
  const pending = Promise.withResolvers<Response>(); let sessionReads = 0, recoveryReads = 0, created = false, posts = 0;
  const identity = { user_id: 'synthetic-actor', username: 'synthetic-local-admin', platform_admin: true, project_roles: [] };
  const ack = { user_id: identity.user_id, username: identity.username, csrf_token: 'synthetic-new-csrf' };
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const path = String(input);
    if (path === '/api/session/password-recovery') {
      recoveryReads++;
      if (delayed === 'recovery-status' && recoveryReads === 1) return pending.promise;
      return reply({ state: 'disabled', request_id: null, username: null });
    }
    if (path === '/api/session') {
      sessionReads++;
      if (delayed === 'session-401' && sessionReads === 1) return pending.promise;
      return created ? reply(identity) : reply({ code: 'UNAUTHENTICATED', message: 'Sign in' }, 401);
    }
    if (path === '/api/session/bootstrap' && init.method === 'POST') { created = true; posts++; return reply(ack); }
    if (path === '/api/session/bootstrap') return reply({ mode: 'initial', bootstrap_available: true });
    if (path === '/api/projects') return reply({ items: [], next_cursor: null });
    throw new Error('Unexpected synthetic HTTP request: ' + path);
  }));
  const session = createSessionController(), root = document.createElement('div'); document.body.append(root);
  cleanups.push(() => session.dispose(), mountRoutes(root, session));
  const oldRead = session.refresh();
  await vi.waitFor(() => expect(delayed === 'session-401' ? sessionReads : recoveryReads).toBe(1));
  await session.refresh();
  for (const [id, value] of [['bootstrap-launch-code', 'synthetic-code'], ['bootstrap-password', 'synthetic-password'], ['bootstrap-password-confirm', 'synthetic-password']]) {
    const input = root.querySelector<HTMLInputElement>('[data-testid=' + id + ']')!;
    input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  root.querySelector<HTMLButtonElement>('[data-testid=bootstrap-submit]')!.click();
  await vi.waitFor(() => expect(root.querySelector('[data-testid=bootstrap-account]')?.textContent).toContain(identity.username));
  pending.resolve(delayed === 'session-401' ? reply({ code: 'UNAUTHENTICATED', message: 'Old session' }, 401) : reply({ state: 'available', request_id: '00000000-0000-4000-8000-000000000001', username: 'obsolete-admin' }));
  await oldRead;
  expect(root.querySelector('[data-testid=bootstrap-account]')?.textContent).toContain(identity.username);
  expect(session.getSnapshot()).toMatchObject({ kind: 'authenticated', session: identity });
  expect(csrfToken()).toBe(ack.csrf_token); expect(sessionStorage.getItem('weblabel_csrf')).toBe(ack.csrf_token); expect(posts).toBe(1);
});

it('does not expose writable authenticated routes when the session cookie has no tab-local CSRF capability', async () => {
  const methods: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    methods.push(init.method ?? 'GET');
    if (String(input) === '/api/session/password-recovery') return reply({ state: 'disabled', request_id: null, username: null });
    if (String(input) === '/api/session') return reply({ user_id: 'synthetic-existing-actor', username: 'synthetic-existing-admin', platform_admin: true, project_roles: [] });
    if (String(input) === '/api/projects') return reply({ items: [], next_cursor: null });
    throw new Error('Unexpected synthetic HTTP request: ' + String(input));
  }));
  const session = createSessionController(), root = document.createElement('div'); document.body.append(root);
  cleanups.push(() => session.dispose(), mountRoutes(root, session));
  await session.refresh();
  expect(session.getSnapshot().kind).toBe('error');
  expect(root.querySelector('[data-testid="project-create-toggle"]')).toBeNull();
  expect(csrfToken()).toBeNull();
  expect(methods.every(method => method === 'GET')).toBe(true);
});
