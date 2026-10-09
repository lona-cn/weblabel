import * as matchers from '@testing-library/jest-dom/matchers';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders, useSession } from '../../app/providers';
import { csrfToken, setCsrfToken } from '../../lib/t15/api';
import { Login } from './Login';
import { Projects } from './Projects';
expect.extend(matchers);
function Entry() {
  const { entry } = useSession();
  if (entry?.kind === 'checking') return <p role="status">检查中</p>;
  if (entry?.kind === 'authenticated') return <Projects createdUsername={entry.createdUsername} onOpen={() => {}} />;
  return <Login key={entry?.kind === 'bootstrap' ? `bootstrap-${entry.mode}` : entry?.kind} />;
}
const identity = { user_id: 'u1', username: 'restore-admin-real', platform_admin: true, project_roles: [] };
const ack = { user_id: identity.user_id, username: identity.username, csrf_token: 'synthetic-token' };
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const unauth = () => reply({ code: 'UNAUTHENTICATED' }, 401);
let sessionRead: () => Promise<Response>;
let post: () => Promise<Response>;
let statusRead: () => Promise<Response>;
let writes: number;
beforeEach(() => {
  writes = 0; sessionStorage.clear(); setCsrfToken(null);
  sessionRead = async () => unauth();
  post = async () => reply(ack);
  statusRead = async () => reply({ mode: 'initial', bootstrap_available: true });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/session') return sessionRead();
    if (url === '/api/session/bootstrap' && init?.method === 'POST') { writes++; return post(); }
    if (url === '/api/session/bootstrap') return statusRead();
    if (url === '/api/projects') return reply({ items: [], next_cursor: null });
    throw new Error('Unexpected request');
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function mount(strict = false) { return render(strict ? <StrictMode><AppProviders><Entry /></AppProviders></StrictMode> : <AppProviders><Entry /></AppProviders>); }
async function fill(password = '  中文密码-2026  ', confirm = password) {
  await screen.findByTestId('bootstrap-submit');
  fireEvent.change(screen.getByTestId('bootstrap-launch-code'), { target: { value: '  synthetic-code  ' } });
  fireEvent.change(screen.getByTestId('bootstrap-password'), { target: { value: password } });
  fireEvent.change(screen.getByTestId('bootstrap-password-confirm'), { target: { value: confirm } });
}
describe('first local login', () => {
  it('detects initial setup instead of pretending the user can log in', async () => {
    mount(); expect(await screen.findByRole('heading', { name: '首次设置本地账户' })).toBeVisible();
    expect(screen.queryByTestId('login-username')).not.toBeInTheDocument();
  });
  it.each([['中中中aa', false], ['中中中aaa', true], ['中'.repeat(341) + 'a', true], ['中'.repeat(341) + 'aa', false]])('enforces UTF-8 bytes at boundary %#', async (password, valid) => {
    post = async () => reply({ code: 'INVALID_BOOTSTRAP_CODE' }, 401);
    mount(); await fill(password); fireEvent.submit(screen.getByTestId('bootstrap-submit').closest('form')!);
    if (valid) { await screen.findByRole('alert'); expect(writes).toBe(1); }
    else { expect(screen.getByTestId('bootstrap-password')).toHaveFocus(); expect(screen.getByTestId('bootstrap-password')).toHaveAttribute('aria-invalid', 'true'); expect(writes).toBe(0); }
  });
  it('focuses empty code then mismatched confirmation without sending credentials', async () => {
    mount(); await fill('123456789012', 'different');
    fireEvent.change(screen.getByTestId('bootstrap-launch-code'), { target: { value: ' ' } });
    fireEvent.submit(screen.getByTestId('bootstrap-submit').closest('form')!);
    expect(screen.getByTestId('bootstrap-launch-code')).toHaveFocus(); expect(writes).toBe(0);
    fireEvent.change(screen.getByTestId('bootstrap-launch-code'), { target: { value: 'not-hex' } });
    fireEvent.submit(screen.getByTestId('bootstrap-submit').closest('form')!);
    expect(screen.getByTestId('bootstrap-password-confirm')).toHaveFocus(); expect(writes).toBe(0);
  });
  it.each(['network', '500', '403', 'wrong401', 'schema'])('shows read failures rather than a false login: %s', async (failure) => {
    if (failure === 'schema') statusRead = async () => reply({ mode: 'invented', bootstrap_available: true });
    else sessionRead = async () => { if (failure === 'network') throw new TypeError('network'); return reply({ code: failure === 'wrong401' ? 'OTHER' : 'FAILED' }, failure === 'wrong401' ? 401 : Number(failure)); };
    mount(); expect(await screen.findByRole('alert')).toBeVisible(); expect(screen.queryByTestId('login-password')).not.toBeInTheDocument(); expect(screen.queryByTestId('bootstrap-password')).not.toBeInTheDocument();
  });
  it('preserves spaces, trims only code, and recovers an acknowledged account without another POST', async () => {
    let sent: Record<string, string> = {};
    post = async () => { const call = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'POST')!; sent = JSON.parse(call[1]!.body as string); sessionRead = async () => reply({ code: 'FAILED' }, 500); return reply(ack); };
    mount(); await fill(); await userEvent.click(screen.getByTestId('bootstrap-submit'));
    expect(await screen.findByText(/已收到初始化成功响应/)).toBeVisible(); expect(screen.queryByTestId('bootstrap-password')).not.toBeInTheDocument();
    expect(sent).toEqual({ launch_code: 'synthetic-code', password: '  中文密码-2026  ' });
    sessionRead = async () => reply(identity);
    await userEvent.click(screen.getByTestId('session-retry'));
    expect(await screen.findByTestId('bootstrap-account')).toHaveTextContent(identity.username); expect(writes).toBe(1); expect(csrfToken()).toBe(ack.csrf_token);
  });
  it('recovers storage failure after acknowledgement without replaying the write', async () => {
    post = async () => { sessionRead = async () => reply(identity); return reply(ack); };
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    mount(); await fill(); await userEvent.click(screen.getByTestId('bootstrap-submit')); await screen.findByRole('alert');
    expect(screen.queryByTestId('bootstrap-submit')).not.toBeInTheDocument(); storage.mockRestore();
    await userEvent.click(screen.getByTestId('session-retry')); expect(await screen.findByTestId('bootstrap-account')).toHaveTextContent(identity.username); expect(writes).toBe(1);
  });
  it.each(['csrf_token', 'user_id', 'username'])('does not claim a writable identity when ack lacks %s', async (field) => {
    post = async () => { sessionRead = async () => reply(identity); return reply({ ...ack, [field]: '' }); };
    mount(); await fill(); await userEvent.click(screen.getByTestId('bootstrap-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent('weblabel_session Cookie'); expect(screen.getByText('本地账户：' + identity.username)).toBeVisible(); expect(screen.queryByTestId('project-submit')).not.toBeInTheDocument(); expect(csrfToken()).toBeNull(); expect(writes).toBe(1);
  });
  it('checks unknown POST outcomes and requires ordinary login after a confirmed 401', async () => {
    post = async () => { throw new TypeError('network'); };
    mount(); await fill(); await userEvent.click(screen.getByTestId('bootstrap-submit')); expect(await screen.findByRole('alert')).toHaveTextContent('尚未确认');
    expect(screen.queryByTestId('bootstrap-password')).not.toBeInTheDocument(); await userEvent.click(screen.getByTestId('session-retry'));
    expect(await screen.findByTestId('login-password')).toBeVisible(); expect(writes).toBe(1);
  });
  it('projects a real known username into ordinary login after acknowledged session 401', async () => {
    mount(); await fill(); await userEvent.click(screen.getByTestId('bootstrap-submit'));
    expect(await screen.findByTestId('login-username')).toHaveValue(identity.username); expect(csrfToken()).toBeNull();
  });
  it('rechecks a 409 using GET only', async () => {
    post = async () => { statusRead = async () => reply({ mode: 'login', bootstrap_available: false }); return reply({ code: 'BOOTSTRAP_USED' }, 409); };
    mount(); await fill(); await userEvent.click(screen.getByTestId('bootstrap-submit')); expect(await screen.findByTestId('login-submit')).toBeVisible(); expect(writes).toBe(1);
  });
  it('disables unavailable setup and reports restore identity rules', async () => {
    statusRead = async () => reply({ mode: 'restore', bootstrap_available: false }); mount();
    expect(await screen.findByRole('heading', { name: '设置恢复后的本地账户' })).toBeVisible(); expect(screen.getByTestId('bootstrap-submit')).toBeDisabled(); expect(screen.getByTestId('session-retry')).toBeEnabled(); expect(screen.getByText(/不覆盖历史账号/)).toBeVisible();
  });
  it('single-flights Enter submissions and disables all controls while writing', async () => {
    let resolve!: (response: Response) => void;
    post = () => new Promise((done) => { resolve = done; });
    mount(); await fill(); const form = screen.getByTestId('bootstrap-submit').closest('form')!;
    fireEvent.submit(form); fireEvent.submit(form);
    expect(screen.getByTestId('bootstrap-launch-code')).toBeDisabled(); expect(screen.getByTestId('session-retry')).toBeDisabled(); expect(form).toHaveAttribute('aria-busy', 'true'); expect(writes).toBe(1);
    await act(async () => { resolve(reply({ code: 'INVALID_BOOTSTRAP_CODE' }, 401)); }); expect(await screen.findByRole('alert')).toHaveTextContent('启动码错误');
  });
  it('ignores a StrictMode delayed old 401 after a newer bootstrap identity and token', async () => {
    let resolve!: (response: Response) => void; let reads = 0;
    sessionRead = () => ++reads === 1 ? new Promise((done) => { resolve = done; }) : Promise.resolve(unauth());
    post = async () => { sessionRead = async () => reply(identity); return reply(ack); };
    mount(true); await fill(); await userEvent.click(screen.getByTestId('bootstrap-submit')); await screen.findByTestId('bootstrap-account');
    await act(async () => { resolve(unauth()); });
    expect(screen.getByTestId('bootstrap-account')).toHaveTextContent(identity.username); expect(csrfToken()).toBe(ack.csrf_token); expect(sessionStorage.getItem('weblabel_csrf')).toBe(ack.csrf_token);
  });

  it('does not describe an unknown write as created when a cookie identity is found without CSRF', async () => {
    post = async () => { sessionRead = async () => reply(identity); throw new TypeError('network'); };
    mount(); await fill(); await userEvent.click(screen.getByTestId('bootstrap-submit')); await screen.findByRole('alert');
    await userEvent.click(screen.getByTestId('session-retry'));
    expect(await screen.findByRole('alert')).toHaveTextContent(identity.username); expect(screen.getByRole('alert')).toHaveTextContent('weblabel_session Cookie'); expect(screen.queryByText(/已收到初始化成功响应/)).not.toBeInTheDocument(); expect(screen.queryByTestId('project-submit')).not.toBeInTheDocument(); expect(writes).toBe(1);
  });
  it('invalidates a login acknowledgement on unmount before token persistence', async () => {
    let scope!: ReturnType<typeof useSession>; let resolve!: (response: Response) => void;
    function Controls() { scope = useSession(); return null; }
    const view = render(<AppProviders><Controls /><Entry /></AppProviders>);
    await screen.findByTestId('bootstrap-submit');
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    let pending!: Promise<void>;
    act(() => { pending = scope.login('synthetic-user', 'synthetic-password'); });
    view.unmount();
    await act(async () => { resolve(reply({ csrf_token: 'stale-token' })); await pending; });
    expect(csrfToken()).toBeNull(); expect(sessionStorage.getItem('weblabel_csrf')).toBeNull();
  });
  it('fences an older login token when a newer login completes first', async () => {
    let scope!: ReturnType<typeof useSession>; let resolve!: (response: Response) => void;
    function Controls() { scope = useSession(); return null; }
    render(<AppProviders><Controls /><Entry /></AppProviders>); await screen.findByTestId('bootstrap-submit');
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    let older!: Promise<void>;
    act(() => { older = scope.login('older-user', 'synthetic-password'); });
    vi.mocked(fetch).mockImplementationOnce(async () => reply({ csrf_token: 'newer-token' })); sessionRead = async () => reply(identity);
    await act(async () => { await scope.login('newer-user', 'synthetic-password'); });
    await screen.findByTestId('project-submit');
    await act(async () => { resolve(reply({ csrf_token: 'older-token' })); await older; });
    expect(csrfToken()).toBe('newer-token'); expect(sessionStorage.getItem('weblabel_csrf')).toBe('newer-token'); expect(screen.getByTestId('project-submit')).toBeVisible(); expect(screen.queryByTestId('bootstrap-account')).not.toBeInTheDocument();
  });

  it.each(['INVALID_PASSWORD', 'LOGIN_RATE_LIMITED']) ('retains the setup form for known credential failure %s', async (code) => {
    post = async () => reply({ code, message: 'must not echo this server message' }, code === 'LOGIN_RATE_LIMITED' ? 429 : 400);
    mount(); await fill(); await userEvent.click(screen.getByTestId('bootstrap-submit'));
    if (code === 'INVALID_PASSWORD') expect(await screen.findByText('密码必须为 12–1024 个 UTF-8 字节。')).toBeVisible();
    else expect(await screen.findByRole('alert')).toHaveTextContent('稍后再试');
    expect(screen.getByTestId('bootstrap-submit')).toBeEnabled(); expect(screen.queryByText('must not echo this server message')).not.toBeInTheDocument(); expect(writes).toBe(1);
  });
  it.each(['500', 'invalid-json']) ('never replays an unconfirmed POST response %s', async (failure) => {
    post = async () => failure === '500' ? reply({ code: 'FAILED' }, 500) : new Response('not json', { status: 200 });
    mount(); await fill(); await userEvent.click(screen.getByTestId('bootstrap-submit')); expect(await screen.findByRole('alert')).toHaveTextContent('尚未确认');
    await userEvent.click(screen.getByTestId('session-retry')); expect(await screen.findByTestId('login-submit')).toBeVisible(); expect(writes).toBe(1);
  });
  it('clears the creation acknowledgement when logging out', async () => {
    let scope!: ReturnType<typeof useSession>;
    function Controls() { scope = useSession(); return null; }
    post = async () => { sessionRead = async () => reply(identity); return reply(ack); };
    render(<AppProviders><Controls /><Entry /></AppProviders>); await fill(); await userEvent.click(screen.getByTestId('bootstrap-submit')); await screen.findByTestId('bootstrap-account');
    vi.mocked(fetch).mockImplementationOnce(async () => new Response(null, { status: 204 }));
    await act(async () => { await scope.logout(); });
    expect(screen.getByTestId('login-username')).toHaveValue(''); expect(csrfToken()).toBeNull(); expect(sessionStorage.getItem('weblabel_csrf')).toBeNull();
    sessionRead = async () => unauth(); statusRead = async () => reply({ mode: 'login', bootstrap_available: false });
    await act(async () => { await scope.refresh(); }); expect(screen.getByTestId('login-submit')).toBeVisible(); expect(screen.queryByTestId('bootstrap-account')).not.toBeInTheDocument();
  });
  it('does not leave a revoked identity authenticated when browser storage cleanup fails', async () => {
    let scope!: ReturnType<typeof useSession>;
    function Controls() { scope = useSession(); return null; }
    post = async () => { sessionRead = async () => reply(identity); return reply(ack); };
    render(<AppProviders><Controls /><Entry /></AppProviders>); await fill(); await userEvent.click(screen.getByTestId('bootstrap-submit')); await screen.findByTestId('bootstrap-account');
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    vi.mocked(fetch).mockImplementationOnce(async () => new Response(null, { status: 204 }));
    await act(async () => { await scope.logout().catch(() => {}); });
    expect(screen.queryByTestId('project-submit')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('已退出'); expect(csrfToken()).toBeNull();
  });
  it('single-flights repeated logout so a rejected second request cannot invalidate a successful revocation', async () => {
    let scope!: ReturnType<typeof useSession>; let resolve!: (response: Response) => void;
    function Controls() { scope = useSession(); return null; }
    post = async () => { sessionRead = async () => reply(identity); return reply(ack); };
    render(<AppProviders><Controls /><Entry /></AppProviders>); await fill(); await userEvent.click(screen.getByTestId('bootstrap-submit')); await screen.findByTestId('bootstrap-account');
    let requests = 0;
    vi.mocked(fetch).mockImplementation(async () => { requests++; if (requests === 1) return new Promise(done => { resolve = done; }); return reply({ code: 'CSRF_INVALID' }, 403); });
    let pending!: Promise<PromiseSettledResult<void>[]>;
    act(() => { pending = Promise.allSettled([scope.logout(), scope.logout()]); });
    await act(async () => { resolve(new Response(null, { status: 204 })); await pending; });
    expect(screen.getByTestId('login-submit')).toBeVisible(); expect(csrfToken()).toBeNull(); expect(requests).toBe(1);
  });

});
