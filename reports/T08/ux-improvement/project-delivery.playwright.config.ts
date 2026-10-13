import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
const origin = process.env.WEBLABEL_UX_BROWSER_ORIGIN ?? 'http://127.0.0.1:5198';
const url = new URL(origin);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || ['5173', '48100', '48101'].includes(url.port)) throw new Error('Use a private loopback browser origin');
export default defineConfig({
  testDir: `${root}/tests/e2e`, testMatch: 'ux18_members.spec.ts', workers: 1, timeout: 60000,
  outputDir: `${root}/reports/T08/ux-improvement/browser-results`,
  use: { baseURL: origin, channel: 'chromium', trace: 'off', screenshot: 'off', video: 'off' },
  webServer: {
    command: '"' + process.execPath + '" node_modules/vite/bin/vite.js --host 127.0.0.1 --port ' + url.port + ' --strictPort --mode test',
    cwd: root + '/apps/web', url: origin, reuseExistingServer: false,
  },
});
