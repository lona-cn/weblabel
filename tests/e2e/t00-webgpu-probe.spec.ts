import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('T00 calls browser wgpu initialization and reports capability @software-gpu', async ({ page }, testInfo) => {
  await page.goto('http://127.0.0.1:4174/t00-webgpu-probe.html');
  const status = page.locator('#gpu-status');
  await expect(status).toHaveAttribute('data-state', /^(ready|blocked)$/, { timeout: 30_000 });
  const state = await status.getAttribute('data-state');
  const capability = {
    state,
    backend: await status.getAttribute('data-backend'),
    device_type: await status.getAttribute('data-device-type'),
    error: await status.getAttribute('data-error'),
  };
  console.info(`WEBGPU_CAPABILITY ${JSON.stringify(capability)}`);
  const diagnosticPath = testInfo.outputPath('t00-webgpu-capability.json');
  await writeFile(diagnosticPath, `${JSON.stringify(capability, null, 2)}\n`);
  await testInfo.attach('t00-webgpu-capability', { path: diagnosticPath, contentType: 'application/json' });
  await status.screenshot({ path: testInfo.outputPath('t00-webgpu-capability.png') });
  if (process.env.REQUIRE_WGPU_DEVICE === '1') expect(state).toBe('ready');
  if (state === 'ready') {
    const backend = await status.getAttribute('data-backend');
    const deviceType = await status.getAttribute('data-device-type');
    expect(backend).toBe('BrowserWebGpu');
    if (testInfo.project.name === 'e2e') expect(deviceType).toBe('Cpu');
    else expect(deviceType).not.toBe('Cpu');
    console.info(`WEBGPU_DEVICE backend=${backend} device_type=${deviceType}`);
  } else {
    const diagnostic = await status.getAttribute('data-error');
    expect(diagnostic).toBeTruthy();
    console.warn(`WEBGPU_DEVICE blocked: ${diagnostic}`);
  }
});
