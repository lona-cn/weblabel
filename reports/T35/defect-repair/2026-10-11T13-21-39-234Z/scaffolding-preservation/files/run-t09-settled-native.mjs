import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../../..');
process.env.PLAYWRIGHT_JSON_OUTPUT_NAME=path.join(root,'reports/T35/defect-repair/2026-10-11T13-21-39-234Z/t09-settled-native-browser.json');
process.argv=[process.execPath,path.join(root,'scripts/test-e2e.mjs'),'--require-device','tests/e2e/t09_canvas.spec.ts','--project=chromium-webgpu','--grep','T09-E','--retries=0','--workers=1','--reporter=json','--output=reports/T35/defect-repair/2026-10-11T13-21-39-234Z/t09-settled-native-output'];
await import('../../../scripts/test-e2e.mjs');
