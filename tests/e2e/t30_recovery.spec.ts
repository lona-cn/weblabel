import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { expect, test as fixtureTest } from './fixtures';
import type { SeededAsset } from './fixtures';
import type { Page, TestInfo } from '@playwright/test';
import { database_path_for_test, start_test_app } from '../support/app';
import { actualResponse, cpuSnapshot, head, installBrowserFaults, loginClient, observeEditor, persistentCopy, privateOrigin, proxyPage, seededRandom, viewport } from '../support/faults';
import type { AnnotationDocument } from '../../packages/contracts/generated/AnnotationDocument';
import type { AnnotationObject } from '../../packages/contracts/generated/AnnotationObject';
import type { SaveResponse } from '../../packages/contracts/generated/SaveResponse';
import type { SuggestionSet } from '../../packages/contracts/generated/SuggestionSet';
import type { NativeDraftExport } from '../../apps/web/src/lib/persistence/types';

const test=fixtureTest.extend({
  app:async({},use)=>{const app=await start_test_app('false','background');try{await use(app);}finally{await app.stop();}},
  adminPage:async({page,seededProject},use)=>{
    await installBrowserFaults(page);
    await proxyPage(page,seededProject.apiBaseUrl);
    await page.goto(privateOrigin);
    await page.getByTestId('login-username').fill(seededProject.login.username);
    await page.getByTestId('login-password').fill(seededProject.login.password);
    await page.getByTestId('login-submit').click();await expect(page.getByTestId('login-submit')).toHaveCount(0);
    await page.goto(`${privateOrigin}/?project_id=${seededProject.project_id}`);await expect(page.getByTestId('asset-grid')).toBeVisible();
    await observeEditor(page);await use(page);
  },
});

async function openAsset(page:Page,asset:SeededAsset){
  await page.getByTestId(`asset-item-${asset.asset_revision_id}`).click();
  await expect(page.getByTestId('gpu-status')).toHaveAttribute('data-actual-backend','webgpu',{timeout:30000});
  await expect(page.getByTestId('gpu-status')).toHaveAttribute('data-device-state','ready',{timeout:30000});
}
async function point(page:Page,x:number,y:number):Promise<[number,number]>{
  const box=await page.getByTestId('annotation-canvas').boundingBox();if(!box)throw new Error('No actual canvas');
  const view=await viewport(page);return [Math.fround(box.x+view.tx+x*view.scale),Math.fround(box.y+view.ty+y*view.scale)];
}
// Independent reference uses the browser's delivered float32 CSS input, never native geometry output.
async function canonicalPointer(page:Page,x:number,y:number):Promise<[number,number]>{
  const input=await point(page,x,y),box=await page.getByTestId('annotation-canvas').boundingBox();if(!box)throw new Error('No reference canvas');
  const view=await viewport(page);return [(input[0]-box.x-view.tx)/view.scale,(input[1]-box.y-view.ty)/view.scale];
}
async function createBox(page:Page,x1=30,y1=40,x2=90,y2=110){
  await page.getByTestId('tool-box').click();await page.mouse.move(...await point(page,x1,y1));await page.mouse.down();await page.mouse.move(...await point(page,x2,y2),{steps:5});await page.mouse.up();
}
async function synced(page:Page){await expect(page.getByTestId('save-status')).toHaveAttribute('data-phase','synced');await expect(page.getByTestId('save-status')).toHaveAttribute('data-dirty','false');}
async function draft(page:Page,info:TestInfo):Promise<NativeDraftExport>{
  const downloaded=page.waitForEvent('download');await page.getByTestId('export-local-draft').click();const download=await downloaded;
  const file=info.outputPath(`draft-${crypto.randomUUID()}.json`);await download.saveAs(file);
  const value:NativeDraftExport=JSON.parse(await readFile(file,'utf8'));expect(value.format).toBe('weblabel-native-draft');expect(value.unsynced).toBe(true);return value;
}
async function evidence(page:Page,info:TestInfo,name:string,value:unknown){
  await page.screenshot({path:info.outputPath(`${name}.png`),fullPage:true});
  const file=info.outputPath(`${name}.json`);await writeFile(file,JSON.stringify({private_origin:privateOrigin,gpu:await page.getByTestId('gpu-status').evaluate(element=>({backend:element.getAttribute('data-actual-backend'),adapter:element.getAttribute('data-adapter-kind'),state:element.getAttribute('data-device-state')})),observation:value},null,2));
  await info.attach(name,{path:file,contentType:'application/json'});
}

test('F03 pointercancel, blur and asset switch never commit a partial real WASM gesture',async({adminPage:page,seededProject},info)=>{
  const [asset,other]=seededProject.assets.filter(item=>item.width===320).slice(0,2);
  await openAsset(page,asset);const original=await cpuSnapshot(page);
  for(const cancellation of ['pointercancel','blur','switch']){
    await page.getByTestId('tool-box').click();await page.mouse.move(...await point(page,30,40));await page.mouse.down();await page.mouse.move(...await point(page,90,110));
    if(cancellation==='pointercancel')await page.getByTestId('annotation-canvas').dispatchEvent('pointercancel',{pointerId:1,pointerType:'mouse',button:0,buttons:0});
    if(cancellation==='blur')await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
    if(cancellation==='switch'){await page.getByTestId(`asset-item-${other.asset_revision_id}`).focus();await page.keyboard.press('Enter');await page.mouse.up();await openAsset(page,asset);}else await page.mouse.up();
    expect(await cpuSnapshot(page)).toEqual(original);
    expect((await head(seededProject.api,asset.asset_revision_id,seededProject.ontology_version_id)).document).toEqual(original);
    await expect(page.getByTestId('undo')).toBeDisabled();
  }
  await createBox(page);await synced(page);
  const saved=await head(seededProject.api,asset.asset_revision_id,seededProject.ontology_version_id);expect(saved.document.objects).toHaveLength(1);
  await evidence(page,info,'cancel-recovery',{original,saved});
});

test('F08/F09 generation8 late ACK cannot synchronize generation9; failed network draft survives reload',async({adminPage:page,seededProject},info)=>{
  const asset=seededProject.assets.find(item=>item.width===320)!;await openAsset(page,asset);await createBox(page);await synced(page);
  const objectId=(await cpuSnapshot(page)).objects[0].object_id;await page.getByTestId(`object-item-${objectId}`).click();
  for(let generation=2;generation<=7;generation+=1){await page.getByTestId('attribute-helmet_state').selectOption(generation%2===0?'wearing':'not_wearing');await synced(page);}
  const released=Promise.withResolvers<void>(),held=Promise.withResolvers<SaveResponse>();let count=0;let fail=true;
  await page.route(`**/api/assets/${asset.asset_revision_id}/annotation`,async route=>{
    if(route.request().method()!=='PUT'){await route.fallback();return;}
    count+=1;
    if(count===1){const response=await actualResponse(route,seededProject.apiBaseUrl);expect(response.status()).toBe(200);held.resolve(await response.json());await released.promise;await route.fulfill({response});}
    else if(fail)await route.abort('failed');else await route.fallback();
  });
  await page.getByTestId('attribute-helmet_state').selectOption('wearing');const ack8=await held.promise;
  expect(await page.evaluate(()=>window.__t30Faults.hosts.at(-1)?.getGeneration())).toBe(8);
  await page.getByTestId('attribute-helmet_state').selectOption('not_wearing');const local9=await cpuSnapshot(page);
  expect(await page.evaluate(()=>window.__t30Faults.hosts.at(-1)?.getGeneration())).toBe(9);
  expect(ack8.revision.document.objects[0].attributes.helmet_state).toBe('wearing');
  released.resolve();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-phase','save_failed');await expect(page.getByTestId('save-status')).toHaveAttribute('data-dirty','true');
  expect((await head(seededProject.api,asset.asset_revision_id,seededProject.ontology_version_id)).document).toEqual(ack8.revision.document);
  const rescue=await draft(page,info);expect(rescue.generation).toBe(9);expect(rescue.document).toEqual(local9);
  await evidence(page,info,'late-ack-network',{ack8,rescue,requests:count});
  await page.reload();await observeEditor(page);await openAsset(page,asset);
  await expect(page.getByTestId('recovery-banner')).toBeVisible();expect(await cpuSnapshot(page)).toEqual(local9);
  await expect(page.getByTestId('save-status')).not.toHaveAttribute('data-phase','synced');
  fail=false;await page.getByTestId(`object-item-${objectId}`).click();await page.getByTestId('attribute-helmet_state').selectOption('unknown');await synced(page);
  const recovered=await head(seededProject.api,asset.asset_revision_id,seededProject.ontology_version_id);expect(recovered.document.objects[0].attributes.helmet_state).toBe('unknown');
  await evidence(page,info,'late-ack-recovered',{rescue,recovered});
});

test('F09 actual IndexedDB quota rejection remains visible and exact unsaved CPU draft exports before retry',async({adminPage:page,seededProject},info)=>{
  const asset=seededProject.assets.find(item=>item.width===320)!;await openAsset(page,asset);await createBox(page);await synced(page);
  const original=(await head(seededProject.api,asset.asset_revision_id,seededProject.ontology_version_id)).document,objectId=original.objects[0].object_id;
  await page.route(`**/api/assets/${asset.asset_revision_id}/annotation`,async route=>{if(route.request().method()==='PUT')await route.abort('failed');else await route.fallback();});
  await page.evaluate(()=>{window.__t30Faults.quota=true;});await page.getByTestId(`object-item-${objectId}`).click();await page.getByTestId('attribute-helmet_state').selectOption('wearing');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-phase','storage_error');await expect(page.getByTestId('save-status')).toHaveAttribute('data-dirty','true');
  const local=await cpuSnapshot(page),rescue=await draft(page,info);expect(rescue.document).toEqual(local);expect(rescue.generation).toBe(2);
  expect((await head(seededProject.api,asset.asset_revision_id,seededProject.ontology_version_id)).document).toEqual(original);
  await evidence(page,info,'quota-draft',{original,rescue});
  await page.evaluate(()=>{window.__t30Faults.quota=false;});await page.unroute(`**/api/assets/${asset.asset_revision_id}/annotation`);
  await page.getByTestId('attribute-helmet_state').selectOption('not_wearing');await synced(page);
  expect((await head(seededProject.api,asset.asset_revision_id,seededProject.ontology_version_id)).document.objects[0].attributes.helmet_state).toBe('not_wearing');
});

test('F07 late runA at assetB cannot overwrite either asset or newer before_hash attributes',async({adminPage:page,seededProject,app},info)=>{
  const db=new DatabaseSync(database_path_for_test(app));try{db.prepare("INSERT INTO model_profiles(profile_id,provider_id,model_id,auth_kind,capabilities_json,availability,verification,runtime_version,verified_at,config_json,secret_ref,created_at) VALUES('profile_mock_local','mock','weblabel-mock-source-v1','none',?,'ready','mock_only','builtin-mock-1',NULL,'{}',NULL,'2026-10-06T00:00:00Z')").run(JSON.stringify({image_input:true,tools:false,structured_output:true,bbox_output:true,attributes:true}));}finally{db.close();}
  await page.reload();await observeEditor(page);
  const [asset,other]=seededProject.assets.filter(item=>item.width===320).slice(0,2);await openAsset(page,asset);await createBox(page);await synced(page);
  const original=await head(seededProject.api,asset.asset_revision_id,seededProject.ontology_version_id),objectId=original.document.objects[0].object_id;
  const otherBefore=await head(seededProject.api,other.asset_revision_id,seededProject.ontology_version_id);
  await page.getByTestId(`object-item-${objectId}`).click();await page.getByLabel('Run intent').selectOption('audit_attributes');await page.getByTestId('ai-prompt').fill('Engineering Mock attribute boundary; no live inference');
  const release=Promise.withResolvers<void>(),held=Promise.withResolvers<{items:SuggestionSet[];run:{run_id:string}}>();
  await page.route('**/api/ai/runs/*/suggestions*',async route=>{const response=await actualResponse(route,seededProject.apiBaseUrl);const body=await response.json();if(body.items.length){held.resolve(body);await release.promise;}await route.fulfill({response});});
  const previewResponse=page.waitForResponse(response=>response.url().includes('/api/ai/previews')&&response.request().method()==='POST');
  await page.getByTestId('ai-run').click();const preview=await previewResponse;
  await evidence(page,info,'audit-preview-boundary',{cpu:await cpuSnapshot(page),saved:original,request:preview.request().postDataJSON(),status:preview.status(),preview:await preview.json()});
  expect(preview.status()).toBe(201);
  await page.getByTestId('ai-consent').getByRole('checkbox').check();await page.getByRole('button',{name:'Authorize and run now'}).click();
  const result=await held.promise;expect(result.items[0].context.asset_revision_id).toBe(asset.asset_revision_id);expect(result.items[0].changes[0].kind).toBe('set_attributes');
  await openAsset(page,other);release.resolve();
  await expect(page.getByTestId('object-list').getByRole('option')).toHaveCount(0);
  for(const button of await page.getByTestId('accept-selected').all())await expect(button).toBeDisabled();
  expect(await head(seededProject.api,other.asset_revision_id,seededProject.ontology_version_id)).toEqual(otherBefore);
  await openAsset(page,asset);await page.getByTestId(`object-item-${objectId}`).click();await page.getByTestId('attribute-helmet_state').selectOption('wearing');await synced(page);
  const newer=await head(seededProject.api,asset.asset_revision_id,seededProject.ontology_version_id);
  for(const button of await page.getByTestId('accept-selected').all())await expect(button).toBeDisabled();
  const stale=await seededProject.api.request('PUT',`/api/assets/${asset.asset_revision_id}/annotation`,{operation_id:crypto.randomUUID(),base_revision_id:newer.annotation_revision_id,document:newer.document,lease:null,suggestion_decisions:[{suggestion_set_id:result.items[0].suggestion_set_id,change_ids:result.items[0].changes.map(change=>change.change_id),decision:'accept'}]});
  expect(stale.status).toBe(409);expect(await head(seededProject.api,asset.asset_revision_id,seededProject.ontology_version_id)).toEqual(newer);
  const retained=await seededProject.api.request<{items:SuggestionSet[]}>('GET',`/api/ai/runs/${result.items[0].model_run_id}/suggestions`);expect(retained.json.items[0].changes).toEqual(result.items[0].changes);expect(newer.document.objects[0].attributes.helmet_state).toBe('wearing');
  await evidence(page,info,'late-ai-stale',{run_id:result.items[0].model_run_id,original,newer,otherBefore,stale:stale.json,retained:retained.json});
});

test('F11 two actual pages sharing head and lease have exactly one complete save and unsynced loser draft',async({adminPage:page,browser,seededProject},info)=>{
  const asset=seededProject.assets.find(item=>item.width===320)!;
  const actor=(await seededProject.api.request<{user_id:string}>('GET','/api/session')).json.user_id;
  // Workbench browser user, not platform bootstrap identity, owns the task.
  const session=await page.evaluate(async()=>await(await fetch('/api/session')).json());
  const task=await seededProject.api.request<{task_id:string}>('POST',`/api/projects/${seededProject.project_id}/tasks`,{asset_revision_id:asset.asset_revision_id,ontology_version_id:seededProject.ontology_version_id,assignee_id:session.user_id});expect(task.status).toBe(200);
  await page.reload();await observeEditor(page);await openAsset(page,asset);
  await page.getByTestId(`review-task-${task.json.task_id}`).getByRole('button',{name:'领取 60 秒任务'}).click();
  const secondContext=await browser.newContext({viewport:{width:1440,height:1000}}),second=await secondContext.newPage();try{
    await installBrowserFaults(second);await proxyPage(second,seededProject.apiBaseUrl);await second.goto(privateOrigin);
    await second.getByTestId('login-username').fill(seededProject.login.username);await second.getByTestId('login-password').fill(seededProject.login.password);await second.getByTestId('login-submit').click();await expect(second.getByTestId('login-submit')).toHaveCount(0);
    await second.goto(`${privateOrigin}/?project_id=${seededProject.project_id}`);await observeEditor(second);await openAsset(second,asset);
    await second.getByTestId(`review-task-${task.json.task_id}`).getByRole('button',{name:'领取 60 秒任务'}).click();
    const gate=Promise.withResolvers<void>();let ready=0;const bodies:unknown[]=[];
    for(const tab of [page,second])await tab.route(`**/api/assets/${asset.asset_revision_id}/annotation`,async route=>{if(route.request().method()!=='PUT'){await route.fallback();return;}bodies.push(route.request().postDataJSON());ready+=1;await gate.promise;await route.fallback();});
    await createBox(page,30,40,90,110);await createBox(second,120,60,180,140);await expect.poll(()=>ready).toBe(2);gate.resolve();
    await expect.poll(async()=>[await page.getByTestId('save-status').getAttribute('data-phase'),await second.getByTestId('save-status').getAttribute('data-phase')].sort()).toEqual(['conflict','synced']);
    const winner=(await page.getByTestId('save-status').getAttribute('data-phase'))==='synced'?page:second,loser=winner===page?second:page;
    const saved=await head(seededProject.api,asset.asset_revision_id,seededProject.ontology_version_id);expect(saved.document).toEqual(await cpuSnapshot(winner));expect(saved.revision_no).toBe(2);
    await expect(loser.getByTestId('save-status')).toHaveAttribute('data-dirty','true');const rescue=await draft(loser,info);expect(rescue.document).toEqual(await cpuSnapshot(loser));expect(rescue.document).not.toEqual(saved.document);
    await evidence(loser,info,'two-page-cas',{task_id:task.json.task_id,bootstrap_actor:actor,operations:bodies,saved,loser_draft:rescue});
  }finally{await secondContext.close();}
});

test('F14 actual hardware device loss keeps CPU hash and unsaved history, rebuilds without application reload',async({adminPage:page,seededProject},info)=>{
  const asset=seededProject.assets.find(item=>item.width===320)!;await openAsset(page,asset);await expect(page.getByTestId('gpu-status')).toHaveAttribute('data-adapter-kind','hardware');
  await page.route(`**/api/assets/${asset.asset_revision_id}/annotation`,async route=>{if(route.request().method()==='PUT')await route.abort('failed');else await route.fallback();});
  await createBox(page);const before=await cpuSnapshot(page);expect(before.objects).toHaveLength(1);await expect(page.getByTestId('undo')).toBeEnabled();await expect(page.getByTestId('save-status')).toHaveAttribute('data-phase','save_failed');await expect(page.getByTestId('save-status')).toHaveAttribute('data-dirty','true');
  const canvasBefore=await page.getByTestId('annotation-canvas').screenshot();await info.attach('device-loss-canvas-before',{body:canvasBefore,contentType:'image/png'});
  const beforeHash=createHash('sha256').update(JSON.stringify(before)).digest('hex');let navigations=0;page.on('framenavigated',frame=>{if(frame===page.mainFrame())navigations+=1;});
  const devicesBefore=await page.evaluate(()=>window.__t30Faults.devices.length);
  const lost=await page.evaluate(()=>window.__t30Faults.destroyDevice());expect(lost.reason).toBe('destroyed');
  const after=await cpuSnapshot(page);expect(createHash('sha256').update(JSON.stringify(after)).digest('hex')).toBe(beforeHash);
  await evidence(page,info,'device-loss-baseline',{beforeHash,before,after,lost,devicesBefore});
  // Renderer rebuild must be real (a new GPUDevice), not a ready label on the destroyed device.
  await expect.poll(()=>page.evaluate(()=>window.__t30Faults.devices.length),{timeout:15000}).toBeGreaterThan(devicesBefore);
  await expect(page.getByTestId('gpu-status')).toHaveAttribute('data-device-state','ready');expect(navigations).toBe(0);
  const canvasAfter=await page.getByTestId('annotation-canvas').screenshot();await info.attach('device-loss-canvas-after',{body:canvasAfter,contentType:'image/png'});
  expect(createHash('sha256').update(canvasAfter).digest('hex')).toBe(createHash('sha256').update(canvasBefore).digest('hex'));
  expect(await cpuSnapshot(page)).toEqual(before);await expect(page.getByTestId('undo')).toBeEnabled();await page.getByTestId('undo').click();expect(await cpuSnapshot(page)).toEqual({...before,objects:[]});
  await createBox(page,100,60,180,140);expect((await cpuSnapshot(page)).objects).toHaveLength(1);expect(navigations).toBe(0);
  const rescue=await draft(page,info);expect(rescue.document).toEqual(await cpuSnapshot(page));await evidence(page,info,'device-rebuilt-history',{beforeHash,rescue,lost,navigations});
});

test('fixed seed create/move/undo/save/reload matches independent document reference on actual WASM',async({adminPage:page,seededProject},info)=>{
  test.setTimeout(120000);
  const asset=seededProject.assets.find(item=>item.width===320)!;await openAsset(page,asset);
  const random=seededRandom(0x30fa17);let model:AnnotationDocument=await cpuSnapshot(page);let history:AnnotationDocument[]=[];
  const transcript:unknown[]=[];
  try{
  for(let step=0;step<48;step+=1){
    const action=step%8===7?'reload':step%8===6?'save':model.objects.length&&step%4===2?'undo':model.objects.length&&step%4===1?'move':'create';
    if(action==='create'){
      const x=20+Math.floor(random()*200),y=20+Math.floor(random()*130),width=12+Math.floor(random()*35),height=12+Math.floor(random()*35);history.push(structuredClone(model));
      const [xMin,yMin]=await canonicalPointer(page,x,y),[xMax,yMax]=await canonicalPointer(page,x+width,y+height);
      await createBox(page,x,y,x+width,y+height);const actual=await cpuSnapshot(page);const added=actual.objects.find(object=>!model.objects.some(existing=>existing.object_id===object.object_id));if(!added)throw new Error('Committed create missing');
      const expected:AnnotationObject={object_id:added.object_id,label_id:'label_person',geometry:{type:'bbox_xyxy',x_min:xMin,y_min:yMin,x_max:xMax,y_max:yMax},attributes:{helmet_state:'unknown'},origin:{type:'manual',prediction_id:null,model_run_id:null,import_batch_id:null}};model={...model,objects:[...model.objects,expected]};
    }else if(action==='move'){
      const object=model.objects.at(-1)!;history.push(structuredClone(model));const dx=3+Math.floor(random()*9),dy=2+Math.floor(random()*8);await page.getByTestId('tool-select').click();await page.getByTestId(`object-item-${object.object_id}`).click();
      const x=(object.geometry.x_min+object.geometry.x_max)/2,y=(object.geometry.y_min+object.geometry.y_max)/2;
      const start=await canonicalPointer(page,x,y),end=await canonicalPointer(page,x+dx,y+dy),deliveredDx=end[0]-start[0],deliveredDy=end[1]-start[1];
      await page.mouse.move(...await point(page,x,y));await page.mouse.down();await page.mouse.move(...await point(page,x+dx,y+dy),{steps:5});await page.mouse.up();
      model={...model,objects:model.objects.map(existing=>existing.object_id===object.object_id?{...existing,geometry:{...existing.geometry,x_min:existing.geometry.x_min+deliveredDx,x_max:existing.geometry.x_max+deliveredDx,y_min:existing.geometry.y_min+deliveredDy,y_max:existing.geometry.y_max+deliveredDy}}:existing)};
    }else if(action==='undo'){
      const previous=history.pop();if(!previous)throw new Error('Reference undo missing');await page.getByTestId('undo').click();model=previous;
    }else if(action==='save'){
      await synced(page);expect((await head(seededProject.api,asset.asset_revision_id,seededProject.ontology_version_id)).document).toEqual(await cpuSnapshot(page));
    }else{
      await synced(page);await page.reload();await observeEditor(page);await openAsset(page,asset);history=[];await expect(page.getByTestId('undo')).toBeDisabled();
    }
    const actual=await cpuSnapshot(page);expect(actual.objects.map(object=>object.object_id)).toEqual(model.objects.map(object=>object.object_id));
    for(let index=0;index<model.objects.length;index+=1){const expected=model.objects[index],observed=actual.objects[index];expect({...observed,geometry:expected.geometry}).toEqual(expected);for(const key of ['x_min','y_min','x_max','y_max'] as const)expect(Math.abs(observed.geometry[key]-expected.geometry[key])).toBeLessThanOrEqual(1e-6);}
    expect({...actual,objects:model.objects}).toEqual(model);transcript.push({step,action,expected:model,actual});
  }
  }catch(cause){await evidence(page,info,'seeded-session-blocked',{seed:0x30fa17,requested_steps:48,completed_steps:transcript.length,transcript,reference:model,actual:await cpuSnapshot(page)});throw cause;}
  await synced(page);expect((await head(seededProject.api,asset.asset_revision_id,seededProject.ontology_version_id)).document).toEqual(await cpuSnapshot(page));await evidence(page,info,'seeded-session',{seed:0x30fa17,steps:48,transcript});
});

test('F09/F17 actual API crash never claims a dirty native edit saved; same database restart keeps prior head and manual work continues',async({adminPage:page,seededProject,app},info)=>{
  const service=await persistentCopy(app,path.resolve(`reports/T30/runtime/browser-crash-${crypto.randomUUID()}`));
  try{
    await service.start();let client=(await loginClient(service.base,seededProject.login.username,seededProject.login.password)).api;
    await page.unroute(`${privateOrigin}/api/**`);await proxyPage(page,service.base);await page.reload();await observeEditor(page);
    const asset=seededProject.assets.find(item=>item.width===320)!;await openAsset(page,asset);await createBox(page);await synced(page);
    const original=await head(client,asset.asset_revision_id,seededProject.ontology_version_id),objectId=original.document.objects[0].object_id;
    await service.crash();
    await page.getByTestId(`object-item-${objectId}`).click();await page.getByTestId('attribute-helmet_state').selectOption('wearing');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-phase','save_failed');await expect(page.getByTestId('save-status')).toHaveAttribute('data-dirty','true');
    await expect(page.getByTestId('save-status')).not.toContainText('已同步到服务器');const rescue=await draft(page,info);expect(rescue.document).toEqual(await cpuSnapshot(page));expect(rescue.document.objects[0].attributes).toEqual({helmet_state:'wearing'});
    await evidence(page,info,'killed-api-unsynced',{original,rescue,api_port:new URL(service.base).port});
    await service.start();client=(await loginClient(service.base,seededProject.login.username,seededProject.login.password)).api;
    expect(await head(client,asset.asset_revision_id,seededProject.ontology_version_id)).toEqual(original);
    await page.unroute(`${privateOrigin}/api/**`);await proxyPage(page,service.base);
    await page.getByTestId('attribute-helmet_state').selectOption('not_wearing');await synced(page);
    const recovered=await head(client,asset.asset_revision_id,seededProject.ontology_version_id);
    expect(recovered.parent_revision_id).toBe(original.annotation_revision_id);expect(recovered.revision_no).toBe(3);
    expect(recovered.document).toEqual({...original.document,objects:original.document.objects.map(object=>({...object,attributes:{helmet_state:'not_wearing'}}))});
    await evidence(page,info,'restarted-api-manual',{original,recovered,rescue,api_port:new URL(service.base).port});
  }finally{await service.stop();}
});

test('F07 late actual engineering Mock detect result is scoped to A while B is open',async({adminPage:page,seededProject,app},info)=>{
  const db=new DatabaseSync(database_path_for_test(app));try{db.prepare("INSERT INTO model_profiles(profile_id,provider_id,model_id,auth_kind,capabilities_json,availability,verification,runtime_version,verified_at,config_json,secret_ref,created_at) VALUES('profile_mock_local','mock','weblabel-mock-source-v1','none',?,'ready','mock_only','builtin-mock-1',NULL,'{}',NULL,'2026-10-06T00:00:00Z')").run(JSON.stringify({image_input:true,tools:false,structured_output:true,bbox_output:true,attributes:true}));}finally{db.close();}
  await page.reload();await observeEditor(page);const [asset,other]=seededProject.assets.filter(item=>item.width===320).slice(0,2);await openAsset(page,asset);
  const first=await head(seededProject.api,asset.asset_revision_id,seededProject.ontology_version_id),second=await head(seededProject.api,other.asset_revision_id,seededProject.ontology_version_id);
  await page.getByLabel('Run intent').selectOption('detect');await page.getByTestId('ai-prompt').fill('Explicit engineering Mock late result; no live inference');
  const gate=Promise.withResolvers<void>(),held=Promise.withResolvers<{items:SuggestionSet[]}>();
  await page.route('**/api/ai/runs/*/suggestions*',async route=>{const response=await actualResponse(route,seededProject.apiBaseUrl),body=await response.json();if(body.items.length){held.resolve(body);await gate.promise;}await route.fulfill({response});});
  await page.getByTestId('ai-run').click();await page.getByTestId('ai-consent').getByRole('checkbox').check();await page.getByRole('button',{name:'Authorize and run now'}).click();
  const result=await held.promise;expect(result.items[0].context.asset_revision_id).toBe(asset.asset_revision_id);expect(result.items[0].changes[0].kind).toBe('create');
  await openAsset(page,other);gate.resolve();await expect(page.getByTestId('object-list').getByRole('option')).toHaveCount(0);
  for(const button of await page.getByTestId('accept-selected').all())await expect(button).toBeDisabled();
  expect(await head(seededProject.api,other.asset_revision_id,seededProject.ontology_version_id)).toEqual(second);
  await openAsset(page,asset);await expect(page.getByTestId(`candidate-${result.items[0].changes[0].change_id}`)).toBeVisible();
  expect(await head(seededProject.api,asset.asset_revision_id,seededProject.ontology_version_id)).toEqual(first);
  await evidence(page,info,'late-detect-scope',{first,second,result,verification:'builtin engineering Mock result; not live provider or model correctness'});
});
