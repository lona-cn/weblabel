import { readFile, writeFile } from 'node:fs/promises';
import { expect, test as fixtureTest } from '../../tests/e2e/fixtures';
const origin = 'http://127.0.0.1:5274';
const test = fixtureTest.extend({
  adminPage: async ({ page, seededProject }, use) => {
    await page.route(`${origin}/api/**`, async (route) => {
      const incoming = new URL(route.request().url());
      const headers = { ...route.request().headers(), origin: seededProject.apiBaseUrl };
      delete headers.host; delete headers['content-length'];
      await route.fulfill({ response: await route.fetch({ url: new URL(`${incoming.pathname}${incoming.search}`, seededProject.apiBaseUrl).href, headers, method: route.request().method(), postData: route.request().postDataBuffer() ?? undefined }) });
    });
    await page.goto(origin);
    await page.getByTestId('login-username').fill(seededProject.login.username);
    await page.getByTestId('login-password').fill(seededProject.login.password);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('login-submit')).toHaveCount(0);
    await page.goto(`${origin}/?project_id=${seededProject.project_id}`);
    await expect(page.getByTestId('asset-grid')).toBeVisible();
    await use(page);
  },
});

test('T34 actual Workbench voluntary recording, real tab blur, explicit project checkpoint and corrupt journal isolation', async ({ adminPage: page, seededProject, context }) => {
  test.setTimeout(90_000);
  // Playwright's default focus emulation keeps background pages focused. Disable
  // that harness behavior so the browser delivers real tab focus/blur events.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await page.bringToFront();
  const requests: string[] = [];
  const externalHttpRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/activity-sessions')) requests.push(request.method());
    if (/^https?:/.test(request.url()) && !request.url().startsWith(`${origin}/`) && !request.url().startsWith(`${seededProject.apiBaseUrl}/`)) externalHttpRequests.push(request.url());
  });
  const diagnostics = page.getByTestId('gpu-status');
  await expect(diagnostics).toHaveAttribute('data-actual-backend', 'webgpu', { timeout: 30_000 });
  await expect(diagnostics).toHaveAttribute('data-device-state', 'ready');
  const optIn = page.getByTestId('activity-opt-in');
  await expect(optIn).not.toBeChecked();
  expect(requests).toEqual([]);
  await page.getByTestId('activity-panel').screenshot({ path: 'reports/T34/activity-default.png' });
  await optIn.focus(); await page.keyboard.press('Space'); await expect(optIn).toBeChecked();
  await page.getByTestId('activity-kind').selectOption('annotation');
  const asset = seededProject.assets.find((item) => item.width === 320)!;
  await page.getByTestId(`asset-item-${asset.asset_revision_id}`).click();
  await expect(diagnostics).toHaveAttribute('data-device-state', 'ready');
  await page.getByTestId('tool-box').click();
  const rect = await page.getByTestId('annotation-canvas').boundingBox();
  if (!rect) throw new Error('Missing real canvas');
  await page.mouse.move(rect.x + rect.width * 0.4, rect.y + rect.height * 0.4); await page.mouse.down();
  await page.mouse.move(rect.x + rect.width * 0.6, rect.y + rect.height * 0.6, { steps: 5 }); await page.mouse.up();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-phase', 'synced');
  const firstDownload = page.waitForEvent('download'); await page.getByTestId('activity-download').click();
  await (await firstDownload).saveAs('reports/T34/ui-local.json');
  const local = JSON.parse(await readFile('reports/T34/ui-local.json', 'utf8'));
  expect(local.fees_usd).toBeNull(); expect(local.sessions.some((session: { intervals: { kind: string; duration_ms: number }[] }) => session.intervals.some((interval) => interval.kind === 'annotation' && interval.duration_ms > 0))).toBe(true);
  expect(requests).toEqual([]);
  const otherTab = await context.newPage(); await otherTab.goto('about:blank');
  const otherCdp = await context.newCDPSession(otherTab);
  await otherCdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await otherTab.bringToFront();
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
  const atBlur = await page.getByTestId('activity-totals').innerText();
  await page.waitForTimeout(1200);
  expect(await page.getByTestId('activity-totals').innerText()).toBe(atBlur);
  await page.bringToFront(); await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
  await optIn.uncheck();
  const put = page.waitForResponse((response) => response.url().includes('/activity-sessions/') && response.request().method() === 'PUT');
  await page.getByTestId('activity-publish').click();
  const response = await put; expect(response.status()).toBe(200);
  const published = await response.json();
  await expect(page.getByTestId('activity-publish')).toBeEnabled();
  const stored = await page.evaluate(async (projectId) => { const response = await fetch(`/api/projects/${projectId}/activity-sessions`); return { status: response.status, body: await response.json() }; }, seededProject.project_id);
  expect(stored.status).toBe(200); expect(stored.body.items).toEqual([published]);
  const retained = await page.getByTestId('activity-totals').innerText();
  await page.reload(); await expect(optIn).not.toBeChecked();
  await page.getByTestId('activity-details').locator('summary').click();
  expect(await page.getByTestId('activity-totals').innerText()).toBe(retained);
  await page.getByTestId('activity-panel').screenshot({ path: 'reports/T34/activity-panel.png' });
  await page.evaluate((projectId) => { const key = Object.keys(localStorage).find((key) => key.startsWith('weblabel:activity:v1:') && key.includes(encodeURIComponent(projectId))); if (!key) throw new Error('Missing own activity journal'); localStorage.setItem(key, '{corrupt-public-test-journal'); }, seededProject.project_id);
  await page.reload(); await expect(optIn).toBeDisabled();
  await expect(page.getByTestId('activity-panel').getByRole('alert')).toBeVisible();
  await expect(diagnostics).toHaveAttribute('data-device-state', 'ready'); await expect(page.getByTestId('tool-box')).toBeEnabled();
  await page.getByTestId('activity-panel').screenshot({ path: 'reports/T34/corrupt-journal-panel.png' });
  await page.getByTestId('activity-clear').click(); await expect(optIn).toBeEnabled(); await expect(optIn).not.toBeChecked();
  const persistedAfterClear = await page.evaluate(async (projectId) => (await fetch(`/api/projects/${projectId}/activity-sessions`)).json(), seededProject.project_id);
  expect(persistedAfterClear.items).toEqual([published]);
  const quota = await page.evaluate(() => {
    let lower = 0, upper = 8 * 1024 * 1024, observedQuota = false;
    while (lower + 1 < upper) {
      const length = Math.floor((lower + upper) / 2);
      try { localStorage.setItem('t34-public-quota-proof', 'q'.repeat(length)); lower = length; }
      catch (error) {
        if (!(error instanceof DOMException) || error.name !== 'QuotaExceededError') throw error;
        observedQuota = true; upper = length;
      }
    }
    return { observedQuota, filler_characters: lower };
  });
  expect(quota.observedQuota).toBe(true);
  const requestsBeforeQuota = requests.length;
  await optIn.check(); await page.waitForTimeout(200);
  await page.getByTestId('activity-publish').click();
  await expect(page.getByTestId('activity-panel').getByRole('alert')).toContainText('Local activity write failed');
  await expect(optIn).not.toBeChecked(); await expect(page.getByTestId('activity-publish')).toBeDisabled();
  expect(requests.length).toBe(requestsBeforeQuota);
  await expect(diagnostics).toHaveAttribute('data-device-state', 'ready'); await expect(page.getByTestId('tool-box')).toBeEnabled();
  const quotaDownload = page.waitForEvent('download'); await page.getByTestId('activity-download').click();
  await (await quotaDownload).saveAs('reports/T34/ui-quota-memory.json');
  await page.getByTestId('activity-panel').screenshot({ path: 'reports/T34/quota-journal-panel.png' });
  await page.evaluate(() => localStorage.removeItem('t34-public-quota-proof'));
  await page.getByTestId('activity-clear').click(); await expect(optIn).toBeEnabled(); await expect(optIn).not.toBeChecked();
  expect(externalHttpRequests).toEqual([]);
  await writeFile('reports/T34/browser-observation.json', JSON.stringify({ test: 'actual_workbench_optin_blur_publish_reload_corrupt_and_quota_journal', actual_backend: await diagnostics.getAttribute('data-actual-backend'), adapter_kind: await diagnostics.getAttribute('data-adapter-kind'), default_disabled: true, physical_tab_focus_loss_observed: true, background_totals_unchanged: true, explicit_put_status: response.status(), persisted_session: published, default_disabled_after_reload: true, corrupt_journal_editor_ready: true, saved_metrics_retained_after_local_clear: true, actual_storage_quota: quota, quota_failure_does_not_publish: true, quota_memory_download: 'ui-quota-memory.json', observed_browser_external_http_requests: externalHttpRequests, network_observation_scope: 'before_opt_in_through_quota_clear', human_pilot_samples: 0 }, null, 2));
  await otherTab.close();
});
