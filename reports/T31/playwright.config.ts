import { defineConfig } from '@playwright/test';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const run = process.env.WEBLABEL_T31_RUN_DIR;
if (!run) throw new Error('Run node scripts/verify-gpu.mjs to build current release WASM and collect hardware evidence');
export default defineConfig({
  testDir: path.join(root, 'tests/perf'), testMatch: 't31_hardware.spec.ts',
  outputDir: path.join(run, 'browser'), timeout: 600_000, workers: 1, retries: 0,
  fullyParallel: false,
  reporter: [['list'], ['json', { outputFile: path.join(run, 'browser-results.json') }]],
  projects: [{ name: 'target-hardware', use: { channel: 'chromium', launchOptions: { args: ['--enable-unsafe-webgpu'] } } }],
  use: { baseURL: process.env.WEBLABEL_T31_ORIGIN, viewport: { width: 1440, height: 1000 }, trace: 'on', screenshot: 'on', video: 'off' },
});
