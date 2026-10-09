import { test, expect, forward_api_for_test } from './fixtures';
import { launch_code_for_test } from '../support/app';

// Authentication bodies and field values must never be retained in a trace.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('T10 first browser setup connects the real session and CSRF and permits password relogin', async ({ app, page }, testInfo) => {
  test.setTimeout(60_000);
  await forward_api_for_test(page, app.base_url);
  const code = await launch_code_for_test(app);
  const password = '  首次登录-2026  ';
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '首次设置本地账户' })).toBeVisible();
  await expect(page.getByTestId('login-username')).toHaveCount(0);
  await page.getByTestId('bootstrap-launch-code').fill('incorrect-code');
  await page.getByTestId('bootstrap-password').fill(password);
  await page.getByTestId('bootstrap-password-confirm').fill(password);
  const rejected = page.waitForResponse(r => r.url().endsWith('/api/session/bootstrap') && r.request().method() === 'POST');
  await page.getByTestId('bootstrap-submit').click();
  expect((await rejected).status()).toBe(401);
  await expect(page.getByRole('alert')).toContainText('启动码错误');
  await page.getByTestId('bootstrap-launch-code').fill(code);
  const initialized = page.waitForResponse(r => r.url().endsWith('/api/session/bootstrap') && r.request().method() === 'POST');
  await page.getByTestId('bootstrap-password-confirm').press('Enter');
  expect((await initialized).status()).toBe(200);
  await expect(page.getByTestId('bootstrap-account')).toContainText('local-admin');
  await expect(page.getByTestId('bootstrap-password')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('first-login-created.png') });

  await page.getByTestId('project-name').fill('首次登录浏览器回归');
  const created = page.waitForResponse(r => r.url().endsWith('/api/projects') && r.request().method() === 'POST');
  await page.getByTestId('project-submit').click();
  const projectResponse = await created;
  expect(projectResponse.status()).toBe(201);
  const project = await projectResponse.json() as { project_id: string };
  await expect(page).toHaveURL(new RegExp(`project_id=${project.project_id}`));
  const session = await page.evaluate(async () => {
    const r = await fetch('/api/session');
    const body = await r.json();
    return { status: r.status, user_id: body.user_id as string, username: body.username as string };
  });
  expect(session.status).toBe(200);
  expect(session.username).toBe('local-admin');
  const logout = await page.evaluate(async () => {
    const csrf = sessionStorage.getItem('weblabel_csrf');
    const r = await fetch('/api/session/logout', { method: 'POST', headers: { 'x-csrf-token': csrf ?? '' } });
    if (r.ok) sessionStorage.removeItem('weblabel_csrf');
    return r.status;
  });
  expect(logout).toBe(204);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
  await expect(page.getByTestId('bootstrap-submit')).toHaveCount(0);
  await page.getByTestId('login-username').fill('local-admin');
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByRole('button', { name: /首次登录浏览器回归/ })).toBeVisible();
  await testInfo.attach('first-login-sanitized-result', { body: Buffer.from(JSON.stringify({ fixture: 'real_empty_app_native_page', bootstrap_wrong_code: 401, bootstrap: 200, projects_post: 201, logout: 204, username: session.username, user_id: session.user_id, project_id: project.project_id, relogin: true })), contentType: 'application/json' });
});
