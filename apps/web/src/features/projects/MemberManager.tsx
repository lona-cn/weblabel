import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useSession } from '../../app/providers';
import { api, ApiFailure, saveAuthorizationEpoch, subscribeSaveAuthorization, type Project } from '../../lib/t15/api';
import type { ProjectMember } from '../../../../../packages/contracts/generated/ProjectMember';
type User = { user_id: string; username: string };
type UserPage = { items: User[]; next_cursor: string | null };
export function MemberManager({ project }: { project: Project | null }) {
  const { entry } = useSession();
  const epoch = useSyncExternalStore(subscribeSaveAuthorization, saveAuthorizationEpoch, saveAuthorizationEpoch);
  const session = entry.kind === 'authenticated' ? entry.session : null;
  return <MemberScope key={JSON.stringify([session?.user_id, epoch, project?.project_id, session?.platform_admin, session?.project_roles])} project={project} platformAdmin={session?.platform_admin === true} projectAdmin={session?.project_roles.some(r => r.project_id === project?.project_id && r.role === 'admin') === true} epoch={epoch} />;
}
function MemberScope({ project, platformAdmin, projectAdmin, epoch }: { project: Project | null; platformAdmin: boolean; projectAdmin: boolean; epoch: number }) {
  const [users, setUsers] = useState<User[]>([]), [members, setMembers] = useState<ProjectMember[]>([]);
  const [cursor, setCursor] = useState<string | null>(null), [memberCursor, setMemberCursor] = useState<string | null>(null);
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [target, setTarget] = useState(''), [role, setRole] = useState('reviewer');
  const [unknown, setUnknown] = useState<{ kind: 'user' | 'member'; target: string; role: string } | null>(null);
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const alive = useRef(true), flight = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const current = () => alive.current && saveAuthorizationEpoch() === epoch;
  async function run(action: () => Promise<void>) { if (flight.current || !current()) return; flight.current = true; setBusy(true); try { await action(); } catch (e) { if (current()) setMessage(e instanceof Error ? e.message : '读取失败'); } finally { flight.current = false; if (current()) setBusy(false); } }
  async function readUsers(next: string | null = null) {
    if (!platformAdmin) return;
    const result = await api.request<UserPage>(`/api/users?limit=100${next ? `&cursor=${encodeURIComponent(next)}` : ''}`);
    if (!current()) return;
    setUsers(old => next ? [...old, ...result.items] : result.items); setCursor(result.next_cursor);
  }
  async function readMembers(next: string | null = null) {
    if (!project || !projectAdmin) return;
    const result = await api.members(project.project_id, next); if (!current()) return;
    setMembers(old => next ? [...old, ...result.items] : result.items); setMemberCursor(result.next_cursor);
  }
  async function create() {
    if (!platformAdmin || unknown) return;
    let acknowledged = false;
    try { const result = await api.request<User>('/api/users', { method: 'POST', body: JSON.stringify({ username, password }) }); if (!current()) return; if (!result || typeof result.user_id !== 'string' || !result.user_id.trim() || result.username !== username) throw new Error('创建确认缺少实际账号身份'); acknowledged = true; setPassword(''); setMessage('账号已创建：' + result.username + ' · ' + result.user_id + '。尚未赋予任何项目或平台管理员权限。'); await readUsers(); }
    catch (e) { if (!current()) return; if (acknowledged) { setMessage('账号创建已确认，仅列表刷新失败；可只读重新读取，不会再次创建。'); return; } if (!(e instanceof ApiFailure && e.status >= 400 && e.status < 500)) { setUnknown({ kind: 'user', target: username, role: '' }); setMessage('账号创建结果未知。只读核对不会认领同名账号，也不会自动再次创建。'); } else setMessage(e.message); }
  }
  async function assign() {
    if (!projectAdmin || !project || unknown || !target.trim()) return;
    let acknowledged = false;
    try { await api.request('/api/projects/' + encodeURIComponent(project.project_id) + '/members', { method: 'POST', body: JSON.stringify({ user_id: target.trim(), role }) }); if (!current()) return; acknowledged = true; setMessage('服务端已确认成员设置。'); await readMembers(); }
    catch (e) { if (!current()) return; if (acknowledged) { setMessage('成员设置已确认，仅列表刷新失败；可只读重新读取，不会再次设置。'); return; } if (!(e instanceof ApiFailure && e.status >= 400 && e.status < 500)) { setUnknown({ kind: 'member', target: target.trim(), role }); setMessage('成员设置结果未知，仅可核对实际目标角色，不会自动重发。'); } else setMessage(e.message); }
  }
  async function reconcile() {
    if (!unknown) return;
    if (unknown.kind === 'user') { await readUsers(); if (current()) setMessage('读取实际账号列表；同名账号不能证明属于原创建请求。可明确选择已存在账号作为另一动作。'); }
    else if (project && projectAdmin) {
      let next: string | null = null; let found: ProjectMember | undefined;
      do { const result = await api.members(project.project_id, next); if (!current()) return; found = result.items.find(m => m.user_id === unknown.target) ?? found; next = result.next_cursor; } while (next);
      setMessage(`实际目标 ${unknown.target}：${found?.role ?? '无成员记录'}；原请求目标 ${unknown.role}。实际状态不能归因于原 POST。`);
    }
  }
  return <details className="member-manager"><summary>{project ? `${project.name} · 项目成员` : '平台账号管理 / 准备独立审核身份'}</summary>
    <p>仅平台管理员能创建和读取全站账号；项目管理员不能据此读取全站用户。项目角色不授予平台管理员权限。</p>
    {message && <p role="status">{message}</p>}
    {platformAdmin && <fieldset disabled={busy || Boolean(unknown)}><legend>创建普通平台账号</legend><label>新账号用户名<input value={username} onChange={e => setUsername(e.target.value)} /></label><label>新账号密码<input type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /></label><button type="button" onClick={() => void run(create)}>创建普通账号</button></fieldset>}
    {platformAdmin && <><button type="button" disabled={busy} onClick={() => void run(() => readUsers())}>读取平台账号</button><ul>{users.map(u => <li key={u.user_id}>{u.username} · {u.user_id}{projectAdmin && <button type="button" disabled={busy} onClick={() => { setTarget(u.user_id); setMessage('已明确选择现有账号；不是原创建请求确认。'); if (unknown?.kind === 'user') setUnknown(null); }}>选择已存在账号：{u.username}</button>}</li>)}</ul>{cursor && <button type="button" disabled={busy} onClick={() => void run(() => readUsers(cursor))}>下一页账号</button>}</>}
    {projectAdmin && <><button type="button" disabled={busy} onClick={() => void run(() => readMembers())}>读取项目成员</button><ul>{members.map(m => <li key={m.user_id}>{m.username} · {m.role} · {m.user_id}<button type="button" disabled={busy || Boolean(unknown)} onClick={() => { setTarget(m.user_id); setRole(m.role); }}>选择成员：{m.username}</button></li>)}</ul>{memberCursor && <button type="button" disabled={busy} onClick={() => void run(() => readMembers(memberCursor))}>下一页成员</button>}<fieldset disabled={busy || Boolean(unknown)}><legend>按真实账号 ID 设置项目角色</legend><label>目标 user_id<input value={target} onChange={e => setTarget(e.target.value)} /></label><label>项目角色<select value={role} onChange={e => setRole(e.target.value)}><option value="reviewer">审核员</option><option value="annotator">标注员</option><option value="viewer">只读成员</option><option value="admin">项目管理员</option></select></label><button type="button" disabled={!target.trim()} onClick={() => void run(assign)}>确认设置项目成员</button></fieldset></>}
    {unknown && <button type="button" disabled={busy} onClick={() => void run(reconcile)}>只读核对实际结果</button>}
  </details>;
}
