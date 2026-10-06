import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import { bootstrap_admin_for_test, start_test_app } from '../../tests/support/app';
import { isProcessAlive, reclaimProcessTree } from '../../apps/agent-host/src/security/spawn';
import { writeEvidence } from '../../tests/support/faults';

it('actual optimized release API omits the authenticated test fault endpoint',async()=>{
  if(!process.env.WEBLABEL_API_BINARY?.includes('release'))throw new Error('Explicit freshly compiled release binary required');
  const app=await start_test_app('false','background');
  try{
    const admin=await bootstrap_admin_for_test(app);
    const result=await admin.request('POST','/internal/test/jobs/drain',{});
    expect(result.status).toBe(404);
    expect((await admin.request('GET','/api/session')).status).toBe(200);
    await writeEvidence('release-api-channel',{api_port:new URL(app.base_url).port,authenticated_fault_endpoint_status:result.status,binary:process.env.WEBLABEL_API_BINARY});
  }finally{await app.stop();}
},30000);

it('actual production bundle exposes no T30 control and renders the real login surface',async()=>{
  const pnpm=path.join(process.env.APPDATA!,'npm/node_modules/pnpm/bin/pnpm.cjs');
  const started=Date.now();
  const child=spawn(process.execPath,[pnpm,'--filter','@weblabel/web','exec','vite','preview','--host','127.0.0.1','--port','4181','--strictPort'],{cwd:process.cwd(),env:process.env,stdio:'pipe'});
  let output='';child.stdout.on('data',data=>{output+=String(data);});child.stderr.on('data',data=>{output+=String(data);});
  const browser=await chromium.launch({channel:'chromium'});
  try{
    const origin='http://127.0.0.1:4181';let ready=false;
    for(let attempt=0;attempt<200;attempt+=1){if(child.exitCode!==null)throw new Error(`Owned preview exited: ${output}`);try{if((await fetch(origin)).status===200){ready=true;break;}}catch{}await delay(50);}
    expect(ready).toBe(true);
    const page=await browser.newPage();await page.goto(origin);
    await expect.poll(()=>page.getByTestId('login-submit').isVisible()).toBe(true);
    const present=await page.evaluate(()=>Object.hasOwn(window,'__t30Faults'));
    expect(present).toBe(false);
    await page.screenshot({path:'reports/T30/production-login.png',fullPage:true});
    await writeEvidence('production-page-channel',{origin,control_present:present,normal_login_visible:await page.getByTestId('login-submit').isVisible(),verification:'production Vite bundle; no addInitScript; no credentials entered'});
  }finally{await browser.close();if(child.pid){const report=await reclaimProcessTree({root_pid:child.pid,spawned_at_ms:started},'T30 owned preview teardown');expect([child.pid,...report.descendants_found].every(pid=>!isProcessAlive(pid))).toBe(true);}}
},30000);
