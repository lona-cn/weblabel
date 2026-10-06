import { defineConfig } from '@playwright/test';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../../..');
const pnpm=path.join(process.env.APPDATA!, 'npm/node_modules/pnpm/bin/pnpm.cjs');
export default defineConfig({
 testDir:root,testMatch:['tests/e2e/t30_recovery.spec.ts','reports/T30/gpu-recovery-fix/dense.spec.ts'],
 outputDir:path.join(root,'reports/T30/gpu-recovery-fix/browser-artifacts',process.env.WEBLABEL_T30_RUN_TAG??'browser'),
 timeout:60000,fullyParallel:false,workers:1,retries:0,
 reporter:[['list'],['json',{outputFile:path.join(root,`reports/T30/gpu-recovery-fix/${process.env.WEBLABEL_T30_RUN_TAG??'browser'}-results.json`)}]],
 projects:[{name:'chromium-webgpu',use:{channel:'chromium',launchOptions:{args:['--enable-unsafe-webgpu']}}}],
 webServer:{command:`"${process.execPath}" "${pnpm}" --filter @weblabel/web exec vite --host 127.0.0.1 --port 5192 --strictPort --mode test`,cwd:root,url:'http://127.0.0.1:5192/',reuseExistingServer:false,timeout:30000},
 use:{baseURL:'http://127.0.0.1:5192',viewport:{width:1440,height:1000},trace:'on',screenshot:'on',video:'off'},
});
