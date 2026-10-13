import * as matchers from '@testing-library/jest-dom/matchers';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { MemberManager } from './MemberManager';
import { api, ApiFailure } from '../../lib/t15/api';
expect.extend(matchers);
const auth = vi.hoisted(() => ({ platform_admin: true }));
vi.mock('../../app/providers', () => ({ useSession: () => ({ entry: { kind: 'authenticated', session: { user_id: 'actor', username: 'actor', platform_admin: auth.platform_admin, project_roles: [{ project_id: 'p', role: 'admin' }] } } }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); auth.platform_admin = true; });
const project = { project_id: 'p', name: 'Synthetic', role: 'admin', description: '', allow_self_review: false };
it('does not let a project administrator read platform accounts', async () => {
  auth.platform_admin = false; const request = vi.spyOn(api, 'request'); render(<MemberManager project={project} />);
  await userEvent.click(screen.getByText('Synthetic · 项目成员'));
  expect(screen.queryByRole('button', { name: '读取平台账号' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '创建普通账号' })).not.toBeInTheDocument(); expect(request).not.toHaveBeenCalled();
});
it('unknown account creation reads candidates without claiming or reposting, selecting existing is explicit', async () => {
  const requests = vi.spyOn(api, 'request').mockImplementation(async (_url, init) => {
    if (init?.method === 'POST') throw new TypeError('lost ACK');
    return { items: [{ user_id: 'actual-existing', username: 'same-name' }], next_cursor: null } as never;
  });
  render(<MemberManager project={project} />); const user = userEvent.setup(); await user.click(screen.getByText('Synthetic · 项目成员'));
  await user.type(screen.getByLabelText('新账号用户名'), 'same-name'); await user.type(screen.getByLabelText('新账号密码'), 'synthetic-password');
  await user.click(screen.getByRole('button', { name: '创建普通账号' }));
  await user.click(screen.getByRole('button', { name: '只读核对实际结果' }));
  expect(requests.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  expect(screen.getByLabelText('目标 user_id')).toHaveValue('');
  await user.click(screen.getByRole('button', { name: '选择已存在账号：same-name' })); expect(screen.getByLabelText('目标 user_id')).toHaveValue('actual-existing');
});
it('a confirmed membership write followed by read failure is not an unknown POST', async () => {
  vi.spyOn(api, 'request').mockResolvedValue({}); vi.spyOn(api, 'members').mockRejectedValue(new ApiFailure(500, 'READ_FAILED', 'read failed'));
  render(<MemberManager project={project} />); const user = userEvent.setup(); await user.click(screen.getByText('Synthetic · 项目成员'));
  await user.type(screen.getByLabelText('目标 user_id'), 'actual-reviewer'); await user.click(screen.getByRole('button', { name: '确认设置项目成员' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('成员设置已确认'));
  expect(screen.queryByRole('button', { name: '只读核对实际结果' })).not.toBeInTheDocument();
});
it('unknown member POST inspects exact target role across pages without attributing or replaying it', async () => {
  const request = vi.spyOn(api, 'request').mockRejectedValue(new TypeError('lost ACK'));
  const members = vi.spyOn(api, 'members').mockImplementation(async (_project, cursor) => cursor ? { items: [{ user_id: 'target', username: 'reviewer', role: 'viewer' }], next_cursor: null } : { items: [{ user_id: 'other', username: 'other', role: 'reviewer' }], next_cursor: 'other' });
  render(<MemberManager project={project} />); const user = userEvent.setup(); await user.click(screen.getByText('Synthetic · 项目成员'));
  await user.type(screen.getByLabelText('目标 user_id'), 'target'); await user.click(screen.getByRole('button', { name: '确认设置项目成员' }));
  await user.click(screen.getByRole('button', { name: '只读核对实际结果' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('实际目标 target：viewer；原请求目标 reviewer'));
  expect(request).toHaveBeenCalledTimes(1); expect(members).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: '确认设置项目成员' })).toBeDisabled();
});
