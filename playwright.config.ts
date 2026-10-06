import { defineConfig } from '@playwright/test';

export default defineConfig({
  projects: [
    { name: 'e2e', testDir: './tests/e2e' },
    {
      name: 't05-render',
      testDir: './tests/render',
      // Override the global software adapter argument for the real-device probe.
      use: { channel: 'chromium', launchOptions: { args: ['--enable-unsafe-webgpu'] } },
    },
    {
      name: 'chromium-webgpu',
      testDir: './tests',
      testMatch: ['e2e/**/*.spec.ts', 'perf/**/*.spec.ts'],
      // T15 and downstream integration gates require an actual Chromium WebGPU device.
      use: { channel: 'chromium', launchOptions: { args: ['--enable-unsafe-webgpu'] } },
    },
  ],

  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  webServer: [
    {
      command: 'node scripts/serve-wgpu-probe.mjs',
      url: 'http://127.0.0.1:4174/health',
      reuseExistingServer: !process.env.CI,
      timeout: 10_000,
    },
    {
      command: 'node scripts/build-web-bridge.mjs && pnpm --filter @weblabel/web exec vite --host 127.0.0.1 --port 5173 --strictPort --mode test',
      url: 'http://127.0.0.1:5173/',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader'] },
  },
});
