import {test,expect} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {EditorWasmBridge,EditorFacade} from '../../../../apps/web/src/lib/editor/types';
import type {EditorHost as HostType} from '../../../../apps/web/src/lib/editor/EditorHost';
const root=path.resolve(import.meta.dirname,'../../../..');
for(const phase of ['adapter','device'] as const)test(`closure ${phase} held request disposes old actual resources before gate release`,async({page},info)=>{
 const [media,ontology,document]=await Promise.all(['media','ontology','document'].map(async name=>JSON.parse(await readFile(path.join(root,`tests/fixtures/golden/${name}.json`),'utf8'))));
 await page.goto('/');
 const observed=await page.evaluate(async({media,ontology,document,phase})=>{
  const url='/wasm/wasm_bridge.js';
  // The served WASM module must load in the browser GPU realm, not the Node test runner.
  const wasm=await import(/* @vite-ignore */url) as EditorWasmBridge&{default():Promise<void>;Renderer:{prototype:object}};await wasm.default();
  const faultAbsent=!('simulate_device_loss' in wasm.Renderer.prototype);
  type Buffer={destroy():void};type Device={destroy():void;lost:Promise<{reason:string}>;createBuffer(...args:unknown[]):Buffer;createTexture(...args:unknown[]):Buffer};type Adapter={requestDevice(...args:unknown[]):Promise<Device>};type GPU={requestAdapter(...args:unknown[]):Promise<Adapter|null>};
  // Named DOM extension boundary: every wrapper awaits and returns actual browser handles.
  const gpuNavigator=navigator as unknown as {gpu:GPU};const gpu=gpuNavigator.gpu;
  const requestAdapter=gpu.requestAdapter.bind(gpu);const devices:Device[]=[];const buffers:{device:number;destroyed:number}[]=[];const textures:{device:number;destroyed:number}[]=[];const destroys:number[]=[];
  let hold=false,enteredResolve!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{enteredResolve=resolve;});const gate=new Promise<void>(resolve=>{release=resolve;});
  gpu.requestAdapter=async(...args)=>{
   const adapter=await requestAdapter(...args);if(!adapter)return null;
   if(hold&&phase==='adapter'){enteredResolve();await gate;}
   const requestDevice=adapter.requestDevice.bind(adapter);
   adapter.requestDevice=async(...deviceArgs)=>{
    const device=await requestDevice(...deviceArgs),index=devices.length;devices.push(device);destroys.push(0);
    const destroy=device.destroy.bind(device);device.destroy=()=>{destroys[index]++;destroy();};
    for(const [method,records] of [['createBuffer',buffers],['createTexture',textures]] as const){const create=device[method].bind(device);device[method]=(...values)=>{const resource=create(...values),record={device:index,destroyed:0};records.push(record);const destroyResource=resource.destroy.bind(resource);resource.destroy=()=>{record.destroyed++;destroyResource();};return resource;};}
    if(hold&&phase==='device'){enteredResolve();await gate;}
    return device;
   };return adapter;
  };
  const canvas=window.document.createElement('canvas');canvas.style.width='640px';canvas.style.height='480px';window.document.body.replaceChildren(canvas);
  type GPUContext={configure(config:unknown):void};
  // DOM lib omits the actual WebGPU context interface.
  const context=canvas.getContext('webgpu') as unknown as GPUContext|null;if(!context)throw new Error('Actual WebGPU canvas unavailable');
  let configurations=0;const configure=context.configure.bind(context);context.configure=(config)=>{configurations++;configure(config);};
  const facade=await wasm.create_editor(canvas,media,ontology,document,new Uint8Array(640*480*4).fill(255),12);
  const diagnostics=facade.get_adapter_diagnostics!();if(!/nvidia|intel|amd|apple|blackwell|DiscreteGpu|IntegratedGpu/i.test(diagnostics)||/software|swiftshader|llvmpipe|lavapipe|Cpu/i.test(diagnostics))throw new Error('Not hardware: '+diagnostics);
  facade.set_viewport({scale:1,tx:0,ty:0,css_width:640,css_height:480,dpr:1});facade.render(1);
  const before={buffers:buffers.filter(x=>x.device===0).length,textures:textures.filter(x=>x.device===0).length};
  const notification=facade.device_lost();devices[0].destroy();await notification;
  hold=true;const pending=facade.recover_renderer();await entered;
  const during={state:facade.get_device_state(),generation:facade.get_generation()};
  facade.dispose();const beforeRelease={state:facade.get_device_state(),stats:facade.get_render_stats!(),buffers:buffers.filter(x=>x.device===0),textures:textures.filter(x=>x.device===0),destroys:[...destroys],configurations};
  facade.free?.();const countBeforeRelease=configurations;release();await pending;
  return {phase,faultAbsent,diagnostics,before,during,beforeRelease,after:{devices:devices.length,destroys,configurations},countBeforeRelease};
 },{media,ontology,document,phase});
 expect(observed.faultAbsent).toBe(true);expect(observed.before.buffers).toBeGreaterThanOrEqual(3);expect(observed.before.textures).toBe(1);
 expect(observed.during).toEqual({state:'recovering',generation:12});expect(observed.beforeRelease.state).toBe('disposed');
 expect(observed.beforeRelease.buffers.filter(x=>x.destroyed===0)).toEqual([]);expect(observed.beforeRelease.textures.every(x=>x.destroyed===1)).toBe(true);
 expect(observed.beforeRelease.stats.live_buffers).toBe(0);expect(observed.beforeRelease.stats.live_textures).toBe(0);
 expect(observed.after.configurations).toBe(observed.countBeforeRelease);
 if(phase==='device'){expect(observed.after.devices).toBe(2);expect(observed.after.destroys[1]).toBe(1);}else expect(observed.after.devices).toBe(1);
 await writeFile(info.outputPath(`held-${phase}-actual-resource-release.json`),JSON.stringify(observed,null,2));
});

test('closure held recovery retains native edit history preview flags idle and zero-size behavior',async({page},info)=>{
 const [media,ontology,document,prediction]=await Promise.all(['media','ontology','document','prediction'].map(async name=>JSON.parse(await readFile(path.join(root,`tests/fixtures/golden/${name}.json`),'utf8'))));
 await page.goto('/');
 const observed=await page.evaluate(async({media,ontology,document,prediction})=>{
  const url='/wasm/wasm_bridge.js';
  // Only a browser-realm import can instantiate the served WASM with real GPU handles.
  const wasm=await import(/* @vite-ignore */url) as EditorWasmBridge&{default():Promise<void>};await wasm.default();
  type Device={destroy():void};type Adapter={requestDevice(...args:unknown[]):Promise<Device>};type GPU={requestAdapter(...args:unknown[]):Promise<Adapter|null>};
  const gpuNavigator=navigator as unknown as {gpu:GPU},gpu=gpuNavigator.gpu,original=gpu.requestAdapter.bind(gpu),devices:Device[]=[];
  let hold=false,release!:()=>void,enter!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{enter=resolve;});
  gpu.requestAdapter=async(...args)=>{const adapter=await original(...args);if(!adapter)return null;if(hold){hold=false;enter();await gate;}const request=adapter.requestDevice.bind(adapter);adapter.requestDevice=async(...values)=>{const device=await request(...values);devices.push(device);return device;};return adapter;};
  const canvas=window.document.createElement('canvas');canvas.style.width='640px';canvas.style.height='480px';window.document.body.replaceChildren(canvas);
  const facade=await wasm.create_editor(canvas,media,ontology,document,new Uint8Array(640*480*4).fill(255),12);
  const diagnostics=facade.get_adapter_diagnostics!();if(!/nvidia|intel|amd|apple|blackwell|DiscreteGpu|IntegratedGpu/i.test(diagnostics)||/software|swiftshader|llvmpipe|lavapipe|Cpu/i.test(diagnostics))throw new Error('Not hardware');
  facade.set_viewport({scale:1,tx:0,ty:0,css_width:640,css_height:480,dpr:1});facade.set_selection(['object_person_001']);
  const edit=facade.dispatch({kind:'set_attributes',object_ids:['object_person_001'],values:{helmet_state:'not_wearing'}});
  facade.set_local_flags(['object_person_001'],{locked:true});facade.set_predictions([prediction]);
  facade.set_tool('box');facade.set_active_label('label_person');
  const pointer={pointer_id:7,button:0,buttons:1,shift:false,ctrl:false,alt:false,meta:false};
  facade.pointer({...pointer,phase:'down',x_css:400,y_css:300});facade.pointer({...pointer,phase:'move',x_css:450,y_css:350});facade.render(1);
  const before={document:facade.get_snapshot(),hashes:facade.get_object_hashes(),generation:facade.get_generation(),labels:facade.get_canvas_labels!()};
  const notification=facade.device_lost();devices[0].destroy();await notification;hold=true;const pending=facade.recover_renderer();await entered;
  const during={document:facade.get_snapshot(),hashes:facade.get_object_hashes(),generation:facade.get_generation(),labels:facade.get_canvas_labels!()};
  release();await pending;facade.render(2);
  const after={document:facade.get_snapshot(),hashes:facade.get_object_hashes(),generation:facade.get_generation(),labels:facade.get_canvas_labels!()};
  const idleBefore=facade.get_render_stats!();for(let i=0;i<10000;i++)facade.render(3+i);const idleAfter=facade.get_render_stats!();
  const committed=facade.pointer({...pointer,phase:'up',buttons:0,x_css:450,y_css:350});
  const locked=facade.dispatch({kind:'delete',object_ids:['object_person_001']});
  const undoPreview=facade.dispatch({kind:'undo'}),undoEdit=facade.dispatch({kind:'undo'}),final=facade.get_snapshot();
  facade.set_viewport({...facade.get_viewport(),css_width:0,css_height:0});const zeroBacking=[canvas.width,canvas.height];
  const pausedLoss=facade.device_lost();devices.at(-1)!.destroy();await pausedLoss;await facade.recover_renderer();
  const zeroBefore=facade.get_render_stats!();facade.render(20000);const zeroAfter=facade.get_render_stats!();
  facade.set_viewport({scale:1,tx:0,ty:0,css_width:480,css_height:360,dpr:1});facade.render(20001);const resumedBacking=[canvas.width,canvas.height];facade.dispose();facade.free?.();
  return {diagnostics,edit,before,during,after,idleBefore,idleAfter,committed,locked,undoPreview,undoEdit,final,zeroBacking,zeroBefore,zeroAfter,resumedBacking,devices:devices.length};
 },{media,ontology,document,prediction});
 expect(observed.edit.can_undo).toBe(true);expect(observed.before.document.objects).toHaveLength(1);
 expect(observed.during).toEqual(observed.before);expect(observed.after).toEqual(observed.before);expect(observed.idleAfter).toEqual(observed.idleBefore);
 expect(observed.committed.document_changed).toBe(true);expect(observed.committed.changed_objects).toHaveLength(1);expect(observed.locked.document_changed).toBe(false);expect(observed.locked.error).not.toBeNull();
 expect(observed.undoPreview.error).toBeNull();expect(observed.undoEdit.error).toBeNull();expect(observed.final).toEqual(document);
 expect(observed.zeroBacking).toEqual([0,0]);expect(observed.zeroAfter.gpu_submissions).toBe(observed.zeroBefore.gpu_submissions);expect(observed.resumedBacking).toEqual([480,360]);expect(observed.devices).toBe(3);
 await writeFile(info.outputPath('held-retained-native-session.json'),JSON.stringify(observed,null,2));
});

test('closure real host asset switch and unmount retire held recoveries before release',async({page},info)=>{
 const [media,ontology,document]=await Promise.all(['media','ontology','document'].map(async name=>JSON.parse(await readFile(path.join(root,`tests/fixtures/golden/${name}.json`),'utf8'))));
 await page.goto('/');
 const observed=await page.evaluate(async({media,ontology,document})=>{
  const wasmUrl='/wasm/wasm_bridge.js',hostUrl='/src/lib/editor/EditorHost.ts';
  // Both imports execute in the actual page realm; Node imports cannot own its GPU/DOM.
  const wasm=await import(/* @vite-ignore */wasmUrl) as EditorWasmBridge&{default():Promise<void>;EditorFacade:{prototype:EditorFacade}};await wasm.default();
  const {EditorHost}=await import(/* @vite-ignore */hostUrl) as {EditorHost:typeof HostType};
  type Buffer={destroy():void};type Device={destroy():void;createBuffer(...args:unknown[]):Buffer};type Adapter={requestDevice(...args:unknown[]):Promise<Device>};type GPU={requestAdapter(...args:unknown[]):Promise<Adapter|null>};
  const gpuNavigator=navigator as unknown as {gpu:GPU},gpu=gpuNavigator.gpu,original=gpu.requestAdapter.bind(gpu),devices:Device[]=[],buffers:{device:number;destroyed:number}[]=[];
  let gate:Promise<void>|null=null,enter!:()=>void,release!:()=>void;
  gpu.requestAdapter=async(...args)=>{const adapter=await original(...args);if(!adapter)return null;if(gate){const pending=gate;gate=null;enter();await pending;}const request=adapter.requestDevice.bind(adapter);adapter.requestDevice=async(...values)=>{const device=await request(...values),index=devices.length;devices.push(device);const create=device.createBuffer.bind(device);device.createBuffer=(...args)=>{const buffer=create(...args),record={device:index,destroyed:0};buffers.push(record);const destroy=buffer.destroy.bind(buffer);buffer.destroy=()=>{record.destroyed++;destroy();};return buffer;};return device;};return adapter;};
  const promises:Promise<void>[]=[];const recover=wasm.EditorFacade.prototype.recover_renderer;wasm.EditorFacade.prototype.recover_renderer=function(){const pending=Reflect.apply(recover,this,[]);promises.push(pending);return pending;};
  const canvas=window.document.createElement('canvas');canvas.style.width='640px';canvas.style.height='480px';window.document.body.replaceChildren(canvas);
  const host=new EditorHost();host.mount(canvas);const request={media,ontology,document,initial_generation:8,frame:{width:640,height:480,rgba:new Uint8Array(640*480*4).fill(255)}};await host.loadAsset(request);
  const diagnostics=host.getAdapterDiagnostics();if(!/nvidia|intel|amd|apple|blackwell|DiscreteGpu|IntegratedGpu/i.test(diagnostics)||/software|swiftshader|llvmpipe|lavapipe|Cpu/i.test(diagnostics))throw new Error('Not hardware');
  function hold(){const entered=new Promise<void>(resolve=>{enter=resolve;});gate=new Promise<void>(resolve=>{release=resolve;});devices.at(-1)!.destroy();return entered;}
  await hold();const switchedDocument={...document,asset_revision_id:'closure-next-asset'};await host.loadAsset({...request,document:switchedDocument,media:{...media,asset_revision_id:'closure-next-asset'}});
  const beforeSwitchRelease={state:host.status,document:host.getSnapshot(),destroyed:buffers.filter(x=>x.device===0).map(x=>x.destroyed)};release();await promises[0];
  const afterSwitch={state:host.status,document:host.getSnapshot(),devices:devices.length};
  await hold();host.dispose();const beforeUnmountRelease={state:host.status,destroyed:buffers.filter(x=>x.device===1).map(x=>x.destroyed)};release();await promises[1];
  return {diagnostics,beforeSwitchRelease,afterSwitch,beforeUnmountRelease,afterUnmount:{state:host.status,devices:devices.length}};
 },{media,ontology,document});
 expect(observed.beforeSwitchRelease.state).toBe('ready');expect(observed.beforeSwitchRelease.destroyed).toEqual([1,1,1]);
 expect(observed.afterSwitch).toEqual({state:'ready',document:{...document,asset_revision_id:'closure-next-asset'},devices:2});
 expect(observed.beforeUnmountRelease).toEqual({state:'disposed',destroyed:[1,1,1]});expect(observed.afterUnmount).toEqual({state:'disposed',devices:2});
 await writeFile(info.outputPath('held-real-host-switch-unmount.json'),JSON.stringify(observed,null,2));
});
