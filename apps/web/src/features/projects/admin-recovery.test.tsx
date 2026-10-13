/// <reference lib="es2024.promise" />
import * as matchers from '@testing-library/jest-dom/matchers';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppProviders, useSession } from '../../app/providers';
import { csrfToken, setCsrfToken } from '../../lib/t15/api';
import { Login } from './Login';
expect.extend(matchers);
const available = { state: 'available', request_id: '12345678-1234-4234-8234-123456789abc', username: 'original-admin' };
const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
let read: () => Promise<Response>;
let post: () => Promise<Response>;
let writes: number;
function Entry() { const { entry } = useSession(); return entry.kind === 'authenticated' ? <p>Workbench</p> : <Login />; }
function mount() { return render(<StrictMode><AppProviders><Entry /></AppProviders></StrictMode>); }
async function fill(password = '  中文密码-2026  ') {
  await screen.findByTestId('recovery-submit');
  fireEvent.change(screen.getByLabelText('终端恢复码'), { target: { value: '  terminal-code  ' } });
  fireEvent.change(screen.getByLabelText('新密码'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: password } });
}
beforeEach(() => {
  writes = 0; sessionStorage.clear(); setCsrfToken(null);
  read = async () => reply(available); post = async () => reply({ ...available, state: 'completed' });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/session/password-recovery') { if (init?.method === 'POST') { writes++; return post(); } return read(); }
    if (url === '/api/session') return reply({ user_id: 'old', username: 'old', platform_admin: true, project_roles: [] });
    throw new Error('Unexpected request: ' + url);
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('maintenance preempts an old authenticated session without deleting drafts', async () => {
  sessionStorage.setItem('weblabel_csrf', 'old'); sessionStorage.setItem('draft', 'keep');
  mount(); await screen.findByText('目标管理员：original-admin');
  expect(screen.queryByText('Workbench')).not.toBeInTheDocument();
  expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/session')).toBe(false);
  expect(sessionStorage.getItem('draft')).toBe('keep'); expect(csrfToken()).toBeNull();
});
it('preserves password bytes, trims code, fences double submit and never logs in', async () => {
  const { promise, resolve } = Promise.withResolvers<Response>(); post = () => promise;
  mount(); await fill(); const form = screen.getByTestId('recovery-submit').closest('form')!;
  fireEvent.submit(form); fireEvent.submit(form); expect(screen.getByTestId('recovery-submit')).toBeDisabled();
  await waitFor(() => expect(writes).toBe(1));
  const init = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'POST')![1]!;
  expect(JSON.parse(init.body as string)).toEqual({ recovery_code: 'terminal-code', password: '  中文密码-2026  ' });
  expect(new Headers(init.headers).has('x-csrf-token')).toBe(false);
  await act(async () => resolve(reply({ ...available, state: 'completed' })));
  await screen.findByText(/移除 WEBLABEL_ADMIN_RECOVERY_REQUEST_ID/);
  expect(screen.queryByText('Workbench')).not.toBeInTheDocument(); expect(csrfToken()).toBeNull();
});
it.each([undefined, { ...available, state: 'completed', request_id: '87654321-1234-4234-8234-123456789abc' }, { ...available, state: 'disabled' }])('locks ambiguous acknowledgements until same-request available is read %#', async ack => {
  post = async () => ack === undefined ? Promise.reject(new Error('lost response')) : reply(ack);
  mount(); await fill(); fireEvent.submit(screen.getByTestId('recovery-submit').closest('form')!);
  await screen.findByText(/结果尚未确认/); expect(screen.getByTestId('recovery-submit')).toBeDisabled();
  read = async () => { throw new Error('offline'); }; fireEvent.click(screen.getByTestId('recovery-check'));
  await waitFor(() => expect(screen.getByTestId('recovery-check')).toBeEnabled()); expect(screen.getByTestId('recovery-submit')).toBeDisabled();
  read = async () => reply({ ...available, request_id: '87654321-1234-4234-8234-123456789abc' });
  fireEvent.click(screen.getByTestId('recovery-check')); await waitFor(() => expect(screen.getByTestId('recovery-check')).toBeEnabled()); expect(screen.getByTestId('recovery-submit')).toBeDisabled();
  read = async () => reply(available); fireEvent.click(screen.getByTestId('recovery-check'));
  await waitFor(() => expect(screen.getByTestId('recovery-submit')).toBeEnabled()); expect(writes).toBe(1);
});
it.each(['中中中aa', '中'.repeat(341) + 'aa'])('rejects invalid UTF8 byte length without POST', async password => {
  mount(); await fill(password); fireEvent.submit(screen.getByTestId('recovery-submit').closest('form')!);
  expect(await screen.findByText('密码必须为 12–1024 个 UTF-8 字节。')).toBeVisible(); expect(writes).toBe(0);
});
it('expired is read-only and points to the original data directory', async () => {
  read = async () => reply({ ...available, state: 'expired' }); mount();
  expect(await screen.findByText(/原数据目录/)).toBeVisible(); expect(screen.queryByTestId('recovery-submit')).not.toBeInTheDocument();
});
it('inconsistent status fails closed instead of entering a session', async () => {
  read = async () => reply({ state: 'disabled', request_id: available.request_id, username: null }); mount();
  await screen.findByRole('alert'); expect(screen.queryByText('Workbench')).not.toBeInTheDocument();
});
it('StrictMode stale status cannot replace the newer maintenance request', async () => {
  const { promise, resolve } = Promise.withResolvers<Response>(); let reads = 0;
  read = () => ++reads === 1 ? promise : Promise.resolve(reply(available));
  mount(); await fill();
  await act(async () => resolve(reply({ state: 'disabled', request_id: null, username: null })));
  expect(screen.getByText('目标管理员：original-admin')).toBeVisible();
  expect(screen.queryByText('Workbench')).not.toBeInTheDocument();
});
it('lost POST can be reconciled as completed only by a same-request read', async () => {
  post = async () => { throw new Error('lost'); };
  mount(); await fill(); fireEvent.submit(screen.getByTestId('recovery-submit').closest('form')!);
  await screen.findByText(/结果尚未确认/);
  read = async () => reply({ ...available, state: 'completed' }); fireEvent.click(screen.getByTestId('recovery-check'));
  await screen.findByText(/密码恢复已完成/); expect(writes).toBe(1);
  expect(screen.queryByTestId('recovery-submit')).not.toBeInTheDocument();
});
it('mismatched confirmation focuses the field without writing', async () => {
  mount(); await fill(); fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'different-password' } });
  fireEvent.submit(screen.getByTestId('recovery-submit').closest('form')!);
  expect(screen.getByLabelText('确认新密码')).toHaveFocus(); expect(writes).toBe(0);
});
it('malformed POST JSON locks resubmission and malformed reconciliation stays unknown', async () => {
  post = async () => new Response('{invalid', { headers: { 'content-type': 'application/json' } });
  mount(); await fill(); fireEvent.submit(screen.getByTestId('recovery-submit').closest('form')!);
  await screen.findByText(/结果尚未确认/);
  read = async () => reply({ state: 'available', request_id: null, username: 'original-admin' });
  fireEvent.click(screen.getByTestId('recovery-check'));
  await waitFor(() => expect(screen.getByTestId('recovery-check')).toBeEnabled());
  expect(screen.getByTestId('recovery-submit')).toBeDisabled(); expect(writes).toBe(1);
});
it.each(['中中中aaa', '中'.repeat(341) + 'a'])('accepts UTF8 byte boundaries without trimming the password', async password => {
  mount(); await fill(password); fireEvent.submit(screen.getByTestId('recovery-submit').closest('form')!);
  await screen.findByText(/密码恢复已完成/); expect(writes).toBe(1);
});
it.each([[400, 'INVALID_PASSWORD', '密码必须为 12–1024 个 UTF-8 字节。'], [401, 'INVALID_RECOVERY_CODE', '恢复码错误或已过期，请核对启动终端的 WEBLABEL_ADMIN_RECOVERY_CODE；可只读核对是否已过期。'], [429, 'RECOVERY_RATE_LIMITED', '恢复请求过于频繁，请稍后再试。']] as const)('explicit rejection %s %s permits correction without leaking server messages', async (status, code, message) => {
  post = async () => new Response(JSON.stringify({ code, message: 'secret server details', request_id: 'trace-id', details: null }), { status, headers: { 'content-type': 'application/json' } });
  mount(); await fill(); fireEvent.submit(screen.getByTestId('recovery-submit').closest('form')!);
  expect(await screen.findByText(message)).toBeVisible();
  expect(screen.queryByText('secret server details')).not.toBeInTheDocument();
  expect(screen.getByTestId('recovery-submit')).toBeEnabled();
  post = async () => reply({ ...available, state: 'completed' });
  fireEvent.submit(screen.getByTestId('recovery-submit').closest('form')!);
  await screen.findByText(/密码恢复已完成/); expect(writes).toBe(2);
});
it.each([[500, 'INVALID_RECOVERY_CODE'], [409, 'RECOVERY_USED'], [401, 'UNRECOGNIZED']])('ambiguous HTTP %s %s remains locked', async (status, code) => {
  post = async () => new Response(JSON.stringify({ code, message: 'hidden' }), { status });
  mount(); await fill(); fireEvent.submit(screen.getByTestId('recovery-submit').closest('form')!);
  await screen.findByText(/结果尚未确认/); expect(screen.getByTestId('recovery-submit')).toBeDisabled();
});
