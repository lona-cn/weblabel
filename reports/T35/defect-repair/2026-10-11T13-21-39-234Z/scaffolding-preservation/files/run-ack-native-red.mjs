import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../../..');
process.env.PLAYWRIGHT_JSON_OUTPUT_NAME=path.join(root,'reports/T35/defect-repair/2026-10-11T13-21-39-234Z/r1-native-red-browser.json');
process.env.WEBLABEL_TEST_REPORT_DIR=path.join(root,'reports/T35/defect-repair/2026-10-11T13-21-39-234Z/r1-native-red-tasks');
process.env.WEBLABEL_T30_TEST_ROOT=path.join(root,'reports/T35/defect-repair/2026-10-11T13-21-39-234Z/r1-native-red-tasks/T30');
process.argv=[process.execPath,path.join(root,'scripts/test-e2e.mjs'),'--require-device','tests/e2e/t30_recovery.spec.ts','--project=chromium-webgpu','--grep','R1 held prior HTTP ACK','--retries=0','--workers=1','--reporter=json','--output=reports/T35/defect-repair/2026-10-11T13-21-39-234Z/r1-native-red-output'];
await import('../../../scripts/test-e2e.mjs');
