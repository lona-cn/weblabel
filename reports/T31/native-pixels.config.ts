import { defineConfig } from '@playwright/test';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const run = process.env.WEBLABEL_T31_PIXELS_RUN!;
const origin = process.env.WEBLABEL_T31_PIXELS_ORIGIN!;
const pnpm = path.join(process.env.APPDATA!, 'npm/node_modules/pnpm/bin/pnpm.cjs');
export default defineConfig({
  testDir: import.meta.dirname, testMatch: 'native-pixels.spec.ts', workers: 1, retries: 0, timeout: 120_000,
  outputDir: path.join(run, 'browser'),
  reporter: [['list'], ['json', { outputFile: path.join(run, 'browser-results.json') }]],
  projects: [{ name: 'target-hardware-pixels', use: { channel: 'chromium', launchOptions: { args: ['--enable-unsafe-webgpu'] } } }],
  webServer: { command: `"${process.execPath}" "${pnpm}" --filter @weblabel/web exec vite --config "${path.join(root, 'reports/T31/vite.config.ts')}" --host 127.0.0.1 --port ${new URL(origin).port} --strictPort --mode test`, cwd: root, url: origin, reuseExistingServer: false, timeout: 30_000 },
  use: { baseURL: origin, viewport: { width: 1440, height: 1000 }, trace: 'on', screenshot: 'on' },
});
