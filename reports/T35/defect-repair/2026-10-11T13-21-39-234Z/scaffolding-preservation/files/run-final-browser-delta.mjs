import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../../..');
process.env.PLAYWRIGHT_JSON_OUTPUT_NAME=path.join(root,'reports/T35/defect-repair/2026-10-11T13-21-39-234Z/final-browser-delta.json');
process.env.WEBLABEL_TEST_REPORT_DIR=path.join(root,'reports/T35/defect-repair/2026-10-11T13-21-39-234Z/final-browser-delta-tasks');
process.env.WEBLABEL_T30_TEST_ROOT=path.join(root,'reports/T35/defect-repair/2026-10-11T13-21-39-234Z/final-browser-delta-tasks/T30');
process.argv=[process.execPath,path.join(root,'scripts/test-e2e.mjs'),'--require-device','tests/e2e/','--project=chromium-webgpu','--grep','T13 two same-context|T15 production listbox','--retries=0','--workers=1','--reporter=json','--output=reports/T35/defect-repair/2026-10-11T13-21-39-234Z/final-browser-delta-output'];
await import('../../../scripts/test-e2e.mjs');
