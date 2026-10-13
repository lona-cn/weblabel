import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
const base = 'http://127.0.0.1:5207';
const browser = await chromium.launch({ headless: true });
const cases = [], errors = [];
try {
  for (const change of ['unmount', 'actor', 'actor-return', 'project', 'collector', 'authorization', 'authorization-return', 'normal-double-click']) {
    const context = await browser.newContext();
    const page = await context.newPage(); page.on('pageerror', reason => errors.push(reason.message));
    await page.request.post(base + '/fixture/reset');
    await page.goto(base + '/reports/T24/ux-improvement/ux23-publish-fence/surface.html');
    await expect(page.getByTestId('activity-opt-in')).not.toBeChecked();
    const evidence = () => page.request.get(base + '/fixture/evidence').then(response => response.json());
    expect((await evidence()).requests).toHaveLength(0);
    const before = await page.evaluate(() => ({ sessions: window.publishFixture.snapshot(), raw: window.publishFixture.raw() }));
    await page.evaluate(() => { const button = document.querySelector('[data-testid="activity-publish"]'); button.click(); button.click(); });
    await expect.poll(async () => (await evidence()).held).toBe(true);
    expect((await evidence()).requests).toHaveLength(1);
    if (change !== 'normal-double-click') await page.evaluate(kind => window.publishFixture.change(kind), change);
    await page.request.post(base + '/fixture/release');
    if (change === 'normal-double-click') {
      await expect(page.getByText('本人工时已保存到项目服务器。')).toBeVisible();
      await expect.poll(async () => (await evidence()).requests.length).toBe(2);
    } else {
      // Drain the actual browser fetch continuation after controlled late HTTP ACK.
      await page.waitForTimeout(250);
      expect((await evidence()).requests).toHaveLength(1);
      await expect(page.getByText('本人工时已保存到项目服务器。')).toHaveCount(0);
    }
    const after = await page.evaluate(() => ({ sessions: window.publishFixture.snapshot(), raw: window.publishFixture.raw() }));
    if (change !== 'normal-double-click') expect(after).toEqual(before);
    else expect(after.sessions).toEqual(before.sessions.map(session => ({ ...session, version: session.version + 1 })));
    const http = await evidence();
    expect(http.requests[0].csrf).toBe('synthetic-actor-a');
    expect(http.requests[0].cookie).toContain('synthetic_actor=A');
    expect(http.requests[0].body.intervals).toEqual(before.sessions[0].intervals);
    if (change === 'normal-double-click') expect(http.requests[1].body.intervals).toEqual(before.sessions[1].intervals);
    cases.push({ change, before, after, http });
    await context.close();
  }
  expect(errors).toEqual([]);
  await writeFile(new URL('./browser-evidence.json', import.meta.url), JSON.stringify({ evidence_kind: 'synthetic_controlled_http_not_live', browser: browser.version(), cases, errors }, null, 2));
  console.log('PASS Chromium synthetic controlled HTTP: 7 stale identity cases retain raw journal and versions with only 1 PUT; normal duplicate click has 1 flight, 2 ACKs. Not live service integration.');
} finally { await browser.close(); }
