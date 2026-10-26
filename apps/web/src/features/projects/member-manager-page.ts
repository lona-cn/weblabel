import type { PageContext } from '../../ui/page-context';
import type { ProjectMember } from '../../../../../packages/contracts/generated/ProjectMember';
import { api, type Project } from '../../lib/t15/api';
import { accountScope, el, button, inputField, selectField, errorSummary, status, table, panel, sessionCanManage, rejected, message } from './account-dom';
import './accounts.css';

type User = { user_id: string; username: string };
const projectRoles = [['reviewer', '审核员'], ['annotator', '标注员'], ['viewer', '只读员'], ['admin', '项目管理员']] as const;
export interface MemberManagerContext extends PageContext { project: Project | null }
export function mountMemberManager(root: HTMLElement, context: MemberManagerContext): () => void {
  const page = el('section', undefined, 'accounts-page accounts-members'); page.dataset.testid = 'member-manager'; root.append(page);
  const scope = accountScope(page, context), entry = context.session.getSnapshot();
  const platformAdmin = entry.kind === 'authenticated' && entry.session.platform_admin === true;
  const projectAdmin = context.project !== null && sessionCanManage(context, context.project.project_id);
  const platformMode = context.project === null;
  page.append(el('h1', platformMode ? '平台账号管理' : `${context.project!.name} · 项目成员`));
  page.append(el('p', platformMode ? '创建普通账号不授予项目或平台管理员权限。项目角色需进入对应项目明确设置。' : '项目管理员不能读取全站用户或创建账号。项目角色不授予平台管理员权限。'));
  if (platformMode ? !platformAdmin : !projectAdmin) { const forbidden = status(); forbidden.textContent = platformMode ? '无权限：仅平台管理员可创建和读取全站账号。' : '无权限：仅项目管理员可设置本项目成员。'; page.append(forbidden); return () => { scope.dispose(); page.remove(); }; }
  let users: User[] = [], members: ProjectMember[] = [], cursor: string | null = null, busy = false, loaded = false;
  let unknown: { kind: 'user' | 'member'; target: string; role: string } | null = null;
  const summary = errorSummary(), notice = status(), columns = el('div', undefined, 'accounts-admin-columns');
  const listing = panel(platformMode ? '平台账号（只读）' : '项目成员');
  const rows = table(platformMode ? ['用户名', 'user_id'] : ['用户名', 'user_id', '项目角色', '操作']);
  const state = status();
  const read = button(platformMode ? '读取平台账号' : '读取项目成员', 'members-read', scope.signal, () => { void run(() => readPage()); });
  const next = button(platformMode ? '下一页账号' : '下一页成员', 'members-next', scope.signal, () => { if (cursor) void run(() => readPage(cursor)); });
  listing.append(read, state, rows.wrap, next);
  const form = el('form', undefined, 'accounts-panel'); form.noValidate = true;
  form.append(el('h2', platformMode ? '创建普通平台账号' : '按真实账号 ID 设置项目角色'));
  const username = inputField('account-username', '新账号用户名'), password = inputField('account-password', '新账号密码', 'password', '12–1024 个 UTF-8 字节；首尾空格保留。'); password.control.autocomplete = 'new-password';
  const target = inputField('member-user-id', '目标 user_id'), role = selectField('member-role', '项目角色', projectRoles);
  form.append(...(platformMode ? [username.element, password.element] : [target.element, role.element]));
  const submit = el('button', platformMode ? '创建普通账号' : '确认设置项目成员', 'accounts-primary'); submit.type = 'submit'; submit.dataset.testid = platformMode ? 'account-create' : 'member-assign'; form.append(submit);
  const reconcile = button('只读核对实际结果', 'members-reconcile', scope.signal, () => { void run(reconcileWrite); });
  columns.append(platformMode ? form : listing, platformMode ? listing : form); page.append(summary.node, notice, reconcile, columns);
  function render() {
    if (!scope.current()) return;
    form.setAttribute('aria-busy', String(busy)); submit.disabled = busy || !!unknown;
    for (const field of [username.control, password.control, target.control]) field.readOnly = busy || !!unknown;
    role.control.disabled = busy || !!unknown; read.disabled = busy; next.disabled = busy; next.hidden = !cursor; reconcile.hidden = !unknown; reconcile.disabled = busy;
    state.textContent = busy ? '正在处理…' : !loaded ? '尚未读取列表。' : !(platformMode ? users.length : members.length) ? '暂无记录。' : '';
    rows.body.replaceChildren();
    for (const user of platformMode ? users : members) {
      const row = el('tr'), userId = el('td', undefined, 'accounts-member-id'); userId.append(el('code', user.user_id)); row.append(el('td', user.username), userId);
      if (!platformMode) {
        const member = user as ProjectMember, cell = el('td');
        const select = button(`选择成员：${member.username}`, `member-select-${member.user_id}`, scope.signal, () => { if (busy || unknown || !scope.current()) return; target.control.value = member.user_id; role.control.value = member.role; target.control.focus(); }); select.disabled = busy || !!unknown;
        const roleCell = el('td', undefined, 'accounts-member-role');
        roleCell.append(el('span', projectRoles.find(([id]) => id === member.role)?.[1] ?? '未知项目角色'), el('code', member.role));
        cell.append(select); row.append(roleCell, cell);
      }
      rows.body.append(row);
    }
  }
  async function run(action: () => Promise<void>) {
    if (busy || !scope.current()) return; busy = true; summary.set(null); render();
    try { await action(); } catch (reason) { if (scope.current()) summary.set(message(reason)); }
    finally { busy = false; render(); }
  }
  async function readPage(after: string | null = null) {
    if (platformMode) {
      const result = await api.request<{ items: User[]; next_cursor: string | null }>(`/api/users?limit=100${after ? `&cursor=${encodeURIComponent(after)}` : ''}`, { signal: scope.signal });
      if (!scope.current()) return; users = after ? [...users, ...result.items] : result.items; cursor = result.next_cursor;
    } else {
      const result = await api.members(context.project!.project_id, after, scope.signal); if (!scope.current()) return; members = after ? [...members, ...result.items] : result.items; cursor = result.next_cursor;
    }
    loaded = true;
  }
  async function write() {
    if (unknown || !scope.current()) return;
    let acknowledged = false;
    const submitted = { target: platformMode ? username.control.value : target.control.value.trim(), role: role.control.value };
    try {
      if (platformMode) {
        const result = await api.request<User>('/api/users', { method: 'POST', body: JSON.stringify({ username: submitted.target, password: password.control.value }) });
        if (!scope.current()) return;
        if (!result?.user_id?.trim() || result.username !== submitted.target) throw new Error('创建确认缺少实际账号身份');
        acknowledged = true; password.control.value = ''; notice.textContent = `账号已创建：${result.username} · ${result.user_id}。尚未赋予任何项目或平台管理员权限。`;
      } else {
        await api.request(`/api/projects/${encodeURIComponent(context.project!.project_id)}/members`, { method: 'POST', body: JSON.stringify({ user_id: submitted.target, role: submitted.role }) });
        if (!scope.current()) return; acknowledged = true; notice.textContent = '服务端已确认成员设置。';
      }
      try { await readPage(); } catch { if (scope.current()) notice.textContent += '仅列表刷新失败；可只读重新读取，不会再次提交。'; }
    } catch (reason) {
      if (!scope.current()) return;
      if (!acknowledged && !rejected(reason)) { unknown = { kind: platformMode ? 'user' : 'member', ...submitted }; notice.textContent = platformMode ? '账号创建结果未知。同名账号不能证明属于原创建请求；不会自动再次创建或添加项目成员。' : '成员设置结果未知，仅可核对实际目标角色，不会自动重发。'; }
      else { summary.set(message(reason)); if (!platformMode) target.setError('服务器拒绝操作，原输入已保留。'); }
    }
  }
  async function reconcileWrite() {
    const pending = unknown; if (!pending) return;
    if (pending.kind === 'user') { await readPage(); if (scope.current()) notice.textContent = '读取实际账号列表；同名账号不能证明属于原创建请求。原请求结果仍未知，不重发。'; }
    else {
      let after: string | null = null, found: ProjectMember | undefined; const seen = new Set<string>();
      do {
        const result = await api.members(context.project!.project_id, after, scope.signal); if (!scope.current()) return;
        found = result.items.find(item => item.user_id === pending.target) ?? found; after = result.next_cursor;
        if (after && seen.has(after)) throw new Error('成员分页游标重复，核对尚未完成。'); if (after) seen.add(after);
      } while (after);
      notice.textContent = `实际目标 ${pending.target}：${found?.role ?? '无成员记录'}；原请求目标 ${pending.role}。实际状态不能归因于原 POST。`;
    }
  }
  form.addEventListener('submit', event => {
    event.preventDefault(); if (busy || unknown || !scope.current()) return;
    username.setError(null); password.setError(null); target.setError(null);
    const bytes = new TextEncoder().encode(password.control.value).byteLength;
    if (platformMode ? !username.control.value.trim() || bytes < 12 || bytes > 1024 : !target.control.value.trim()) {
      if (platformMode) { if (!username.control.value.trim()) username.setError('请输入用户名。'); if (bytes < 12 || bytes > 1024) password.setError('密码必须为 12–1024 个 UTF-8 字节。'); } else target.setError('请输入真实账号 ID。');
      summary.set('请修正下方标记的字段。', true); return;
    }
    void run(write);
  }, { signal: scope.signal });
  render(); return () => { scope.dispose(); page.remove(); };
}
