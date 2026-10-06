import { defineConfig } from '@playwright/test';
import path from 'node:path';
export default defineConfig({
  testDir: import.meta.dirname, testMatch: 'producer-smoke.spec.ts',
  outputDir: path.join(import.meta.dirname, 'producer/browser'),
  timeout: 180_000, workers: 1, retries: 0, fullyParallel: false,
  reporter: [['list'], ['json', { outputFile: path.join(import.meta.dirname, 'producer/browser-results.json') }]],
  projects: [{ name: 'actual-hardware-producer', use: { channel: 'chromium', launchOptions: { args: ['--enable-unsafe-webgpu'] } } }],
  use: { baseURL: process.env.WEBLABEL_T31_ORIGIN, viewport: { width: 1440, height: 1000 }, trace: 'off', screenshot: 'on', video: 'off' },
});
