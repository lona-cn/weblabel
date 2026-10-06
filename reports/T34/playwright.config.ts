import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: 'browser-smoke.spec.ts', workers: 1, retries: 0,
  timeout: 90_000, reporter: 'list', outputDir: 'browser-artifacts',
  use: { baseURL: 'http://127.0.0.1:5274', channel: 'chromium', headless: false, viewport: { width: 1440, height: 1100 }, launchOptions: { args: ['--enable-unsafe-webgpu'] }, trace: 'off' },
});
