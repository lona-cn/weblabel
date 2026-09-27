import { defineConfig } from '@playwright/test';

// The T24 harness bundles its own React test surface and does not use Vite's
// application server. Keeping only the probe server avoids an unrelated app
// predev/WebAssembly build from obscuring this real-editor regression.
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 't24_acceptance.spec.ts',
  fullyParallel: false,
  reporter: process.env.CI ? 'github' : 'list',
  projects: [{
    name: 'chromium-webgpu',
    testDir: './tests/e2e',
    use: { channel: 'chromium', launchOptions: { args: ['--enable-unsafe-webgpu'] } },
  }],
  webServer: [{
    command: 'node scripts/serve-wgpu-probe.mjs',
    url: 'http://127.0.0.1:4174/health',
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  }],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader'] },
  },
});
