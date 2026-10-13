import { expect, it } from 'vitest';
import { bootstrap_admin_for_test, login_at_origin_for_test, start_test_app } from '../support/app';
type Page = { items: { user_id: string; username: string; role?: string }[]; next_cursor: string | null };
it('creates independent identities and traverses actual account/member pages without granting platform privileges', async () => {
  const app = await start_test_app();
  try {
    const platform = await bootstrap_admin_for_test(app);
    const created: string[] = [];
    for (const username of ['ux18_owner', 'ux18_reviewer', 'ux18_reader']) {
      const user = await platform.request<{ user_id: string }>('POST', '/api/users', { username, password: 'synthetic-ux18-password' });
      expect(user.status).toBe(201); created.push(user.json.user_id);
    }
    const owner = await login_at_origin_for_test(app.base_url, { username: 'ux18_owner', password: 'synthetic-ux18-password' });
    const project = await owner.request<{ project_id: string; allow_self_review: boolean }>('POST', '/api/projects', { name: 'UX18 synthetic', description: '', allow_self_review: false });
    expect(project.status).toBe(201); expect(project.json.allow_self_review).toBe(false);
    expect((await owner.request('GET', '/api/users?limit=1')).status).toBe(403);
    expect((await owner.request('POST', '/api/users', { username: 'forbidden', password: 'synthetic-ux18-password' })).status).toBe(403);
    for (const user_id of created.slice(1)) expect((await owner.request('POST', `/api/projects/${project.json.project_id}/members`, { user_id, role: 'reviewer' })).status).toBe(200);
    for (const endpoint of ['/api/users', `/api/projects/${project.json.project_id}/members`]) {
      const client = endpoint === '/api/users' ? platform : owner;
      let cursor: string | null = null; const ids: string[] = [];
      do { const page = await client.request<Page>('GET', `${endpoint}?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); expect(page.status).toBe(200); expect(page.json.items).toHaveLength(1); ids.push(page.json.items[0].user_id); cursor = page.json.next_cursor; } while (cursor);
      expect(new Set(ids).size).toBe(ids.length); expect(ids).toEqual(expect.arrayContaining(created));
    }
    const reviewer = await login_at_origin_for_test(app.base_url, { username: 'ux18_reviewer', password: 'synthetic-ux18-password' });
    expect((await reviewer.request<{ platform_admin: boolean }>('GET', '/api/session')).json.platform_admin).toBe(false);
    expect((await reviewer.request('GET', `/api/projects/${project.json.project_id}/members`)).status).toBe(403);
  } finally { await app.stop(); }
}, 30000);
