import {defineConfig} from '@playwright/test';
import path from 'node:path';
const report=import.meta.dirname,root=path.resolve(report,'../../../..');
const pnpm=path.join(process.env.APPDATA!,'npm/node_modules/pnpm/bin/pnpm.cjs');
export default defineConfig({
 testDir:report,outputDir:path.join(report,'browser-artifacts',process.env.WEBLABEL_T30_RUN_TAG??'browser'),
 timeout:60000,fullyParallel:false,workers:1,retries:0,
 reporter:[['list'],['json',{outputFile:path.join(report,`${process.env.WEBLABEL_T30_RUN_TAG??'browser'}-results.json`)}]],
 projects:[{name:'chromium-webgpu',testMatch:['t30_recovery.spec.ts','closure.spec.ts'],use:{channel:'chromium',launchOptions:{args:['--enable-unsafe-webgpu']}}},{name:'t05-render',testMatch:'t05.private.spec.ts',use:{channel:'chromium',launchOptions:{args:['--enable-unsafe-webgpu']}}}],
 webServer:[{command:`"${process.execPath}" "${pnpm}" --filter @weblabel/web exec vite --host 127.0.0.1 --port 5193 --strictPort --mode test`,cwd:root,url:'http://127.0.0.1:5193/',reuseExistingServer:false,timeout:30000},{command:`"${process.execPath}" "${path.join(report,'probe-server.mjs')}"`,cwd:root,url:'http://127.0.0.1:4183/health',reuseExistingServer:false,timeout:10000}],
 use:{baseURL:'http://127.0.0.1:5193',viewport:{width:1440,height:1000},trace:'on',screenshot:'only-on-failure',video:'off'},
});
