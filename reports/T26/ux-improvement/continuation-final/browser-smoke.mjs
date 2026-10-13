import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.launch({headless:true});
try {
  const page = await browser.newPage();
  page.on('pageerror',error=>console.error('PAGEERROR',error));
  page.on('console',msg=>{if(msg.type()==='error')console.error('CONSOLE',msg.text());});
  await page.route('**/api/**', route => route.fulfill({status:503,contentType:'application/json',body:'{"code":"CONTROLLED_SMOKE","message":"Controlled browser boundary"}'}));
  await page.goto('http://127.0.0.1:5194');
  console.log('Chromium', await browser.version());
  await page.evaluate(async () => {
    const resources=performance.getEntriesByType('resource').map(entry=>entry.name);
    const React = await import(resources.find(url=>url.includes('/deps/react.js?')));
    const ReactDOM = await import(resources.find(url=>url.includes('/deps/react-dom_client.js?')));
    const {ReviewPanel} = await import('/src/features/review/ReviewPanel.tsx');
    const task={task_id:'smoke-task',project_id:'smoke-project',asset_revision_id:'image',ontology_version_id:'fixed',assignee_id:'smoke-actor',state:'open',created_at:'2026-10-13',review_id:null,revision_ids:null,review_decision:null,review_reason:null};
    window.__leaseSmoke=[];
    window.fetch=async(input,init={})=>{
      const url=String(input), body=init.body?JSON.parse(init.body):null;
      window.__leaseSmoke.push({url,method:init.method??'GET',body});
      if(url.endsWith('/lease')) throw new TypeError('controlled lost acquire response');
      const data=url.includes('/tasks?')?{items:[task,{...task,task_id:'other'}],next_cursor:null}:url.includes('/members')?{items:[{user_id:'smoke-actor',username:'actor',role:'admin'}],next_cursor:null}:{items:[],next_cursor:null};
      return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
    };
    const el=document.createElement('div');el.id='smoke-panel';document.body.append(el);
    const prep=async()=>({token:Symbol(),isCurrent:()=>true,validateCurrent:async()=>true,onTaskOpen:()=>{},release:()=>{}});
    ReactDOM.default.createRoot(el).render(React.default.createElement(ReviewPanel,{projectId:'smoke-project',session:{user_id:'smoke-actor',username:'actor',platform_admin:false,project_roles:[{project_id:'smoke-project',role:'admin'}]},onPrepareTaskCreate:prep,onPrepareTaskOpen:prep,onLeaseChange:()=>{},onSubmitTask:async()=>{}}));
  });
  const panel=page.locator('#smoke-panel');
  await page.waitForTimeout(500); console.log('PANEL',await panel.innerText());
  await panel.getByTestId('review-task-smoke-task').getByRole('button',{name:'领取任务'}).click();
  await panel.getByTestId('task-claim-unknown').waitFor();
  for (const button of await panel.getByRole('button',{name:'领取任务'}).all()) assert.equal(await button.isDisabled(),true);
  for (const button of await panel.getByRole('button',{name:'转交任务'}).all()) assert.equal(await button.isDisabled(),true);
  await panel.getByTestId('task-claim-unknown').getByRole('button',{name:'重新检查'}).click();
  await page.waitForFunction(()=>window.__leaseSmoke.filter(c=>c.method==='GET'&&c.url.includes('/tasks?')).length>=2);
  const calls=await page.evaluate(()=>window.__leaseSmoke);
  assert.equal(calls.filter(c=>c.method==='POST').length,1);
  assert.match(await panel.getByTestId('task-claim-unknown').innerText(),/smoke-task/);
  assert.match(await panel.getByTestId('task-claim-unknown').innerText(),/smoke-actor/);
  assert.equal(await panel.getByTestId('task-transfer-other').isDisabled(),true);
  console.log(JSON.stringify({result:'passed',realBrowser:true,controlledHTTP:true,realNative:false,realIndexedDB:false,calls},null,2));
} finally {await browser.close();}
