import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { EditorFacade, EditorWasmBridge, AnnotationDocument } from '../../../apps/web/src/lib/editor/types';
import type { EditorHost as HostType } from '../../../apps/web/src/lib/editor/EditorHost';
const root=path.resolve(import.meta.dirname,'../../..');
test('dense hardware renderer recovery preserves native history and preview, then 10000 idle calls submit zero work',async({page},info)=>{
 const [media,ontology,document]=await Promise.all(['media','ontology','document'].map(async name=>JSON.parse(await readFile(path.join(root,`tests/fixtures/golden/${name}.json`),'utf8'))));
 const template=document.objects[0];
 document.objects=Array.from({length:10000},(_,i)=>({...template,object_id:`dense_${i}`,geometry:{type:'bbox_xyxy',x_min:(i%100)*6,y_min:Math.floor(i/100)*4,x_max:(i%100)*6+4,y_max:Math.floor(i/100)*4+3}}));
 await page.goto('http://127.0.0.1:5192/');
 const observed=await page.evaluate(async({media,ontology,document})=>{
  const moduleUrl='/wasm/wasm_bridge.js';
  // Browser WASM loader boundary: static Node imports cannot instantiate the
  // page's GPU/canvas realm or load this served WASM URL.
  const bridge=await import(/* @vite-ignore */ moduleUrl) as EditorWasmBridge&{default():Promise<void>};await bridge.default();
  const canvas=window.document.createElement('canvas');canvas.style.width='640px';canvas.style.height='480px';window.document.body.replaceChildren(canvas);
  type Device={destroy():void;lost:Promise<{reason:string;message:string}>};type Adapter={requestDevice():Promise<Device>};
  // DOM lib lacks WebGPU; this named binding describes the browser extension.
  const gpuNavigator=navigator as unknown as {gpu:{requestAdapter():Promise<Adapter>}};
  const gpu=gpuNavigator.gpu;
  const original=gpu.requestAdapter.bind(gpu);const devices:Device[]=[];
  gpu.requestAdapter=async()=>{const adapter=await original();const request=adapter.requestDevice.bind(adapter);adapter.requestDevice=async()=>{const device=await request();devices.push(device);return device;};return adapter;};
  const facade:EditorFacade=await bridge.create_editor(canvas,media,ontology,document,new Uint8Array(640*480*4).fill(255),12);
  if(!/DiscreteGpu|IntegratedGpu|nvidia|intel|amd|apple|blackwell/i.test(facade.get_adapter_diagnostics!())||/software|swiftshader|llvmpipe|lavapipe|Cpu/i.test(facade.get_adapter_diagnostics!()))throw new Error('Not a real hardware adapter');
  facade.set_viewport({scale:1,tx:0,ty:0,css_width:640,css_height:480,dpr:1});
  facade.set_selection(['dense_0']);facade.set_local_flags(['dense_1'],{hidden:true});facade.set_local_flags(['dense_2'],{locked:true});
  const edit=facade.dispatch({kind:'set_attributes',object_ids:['dense_0'],values:{helmet_state:'wearing'}});if(edit.error||!edit.can_undo)throw new Error('History setup failed');
  facade.set_tool('box');facade.set_active_label('label_person');
  const pointer={pointer_id:7,button:0,buttons:1,shift:false,ctrl:false,alt:false,meta:false};
  facade.pointer({...pointer,phase:'down',x_css:610,y_css:420});facade.pointer({...pointer,phase:'move',x_css:630,y_css:450});facade.render(1);
  const before={document:facade.get_snapshot(),generation:facade.get_generation(),hashes:facade.get_object_hashes(),labels:facade.get_canvas_labels!()};
  const loss=facade.device_lost();devices[0].destroy();const actualLost=await devices[0].lost;const notification=await loss;
  if(facade.get_device_state()!=='lost')throw new Error('Real loss was not detected');
  const pending=facade.recover_renderer();
  // These synchronous calls prove the pending future holds no WASM borrow.
  const during=facade.get_generation();await pending;facade.render(2);
  const after={document:facade.get_snapshot(),generation:facade.get_generation(),hashes:facade.get_object_hashes(),labels:facade.get_canvas_labels!()};
  const idleBefore=facade.get_render_stats!();for(let i=0;i<10000;i++)facade.render(i+3);const idleAfter=facade.get_render_stats!();
  // Continuing the same pre-loss gesture proves its preview/tool state survived.
  const committed=facade.pointer({...pointer,phase:'up',buttons:0,x_css:630,y_css:450});
  const locked=facade.dispatch({kind:'delete',object_ids:['dense_2']});
  const undoPreview=facade.dispatch({kind:'undo'});const undoEdit=facade.dispatch({kind:'undo'});
  const final=facade.get_snapshot();
  const paused=facade.get_viewport();facade.set_viewport({...paused,css_width:0,css_height:0});
  const pausedLoss=facade.device_lost();devices.at(-1)!.destroy();await pausedLoss;await facade.recover_renderer();
  const zeroBefore=facade.get_render_stats!();facade.render(20000);const zeroAfter=facade.get_render_stats!();
  const diagnostics=facade.get_adapter_diagnostics!();facade.dispose();facade.free?.();
  return {actualLost:{reason:actualLost.reason,message:actualLost.message},notification,devices:devices.length,diagnostics,before,after,during,idleBefore,idleAfter,locked,committed,undoPreview,undoEdit,final,zeroBefore,zeroAfter};
 },{media,ontology,document});
 expect(observed.actualLost.reason).toBe('destroyed');expect(observed.devices).toBe(3);
 expect(observed.after).toEqual(observed.before);expect(observed.during).toBe(observed.before.generation);
 expect(observed.idleAfter).toEqual(observed.idleBefore);
 expect(observed.locked.error).not.toBeNull();expect(observed.locked.document_changed).toBe(false);
 expect(observed.committed.error).toBeNull();expect(observed.committed.document_changed).toBe(true);expect(observed.committed.changed_objects).toHaveLength(1);
 expect(observed.undoPreview.error).toBeNull();expect(observed.undoEdit.error).toBeNull();expect(observed.final).toEqual(document as AnnotationDocument);
 expect(observed.zeroAfter.gpu_submissions).toBe(observed.zeroBefore.gpu_submissions);
 const nativeSummary=(state:typeof observed.before)=>({
  generation:state.generation,objects:state.document.objects.length,
  documentSnapshotSha256:createHash('sha256').update(JSON.stringify(state.document)).digest('hex'),
  nativeObjectHashesSha256:createHash('sha256').update(JSON.stringify(Object.entries(state.hashes).sort(([a],[b])=>a.localeCompare(b)))).digest('hex'),
  labels:state.labels,
 });
 await writeFile(info.outputPath('dense-hardware-recovery.json'),JSON.stringify({
  actualLost:observed.actualLost,notification:observed.notification,devices:observed.devices,diagnostics:observed.diagnostics,
  before:nativeSummary(observed.before),after:nativeSummary(observed.after),during:observed.during,
  idleCalls:10000,idleBefore:observed.idleBefore,idleAfter:observed.idleAfter,
  locked:observed.locked,committed:observed.committed,undoPreview:observed.undoPreview,undoEdit:observed.undoEdit,
  final:{objects:observed.final.objects.length,documentSnapshotSha256:createHash('sha256').update(JSON.stringify(observed.final)).digest('hex')},
  zeroBefore:observed.zeroBefore,zeroAfter:observed.zeroAfter,
 },null,2));
 await page.screenshot({path:info.outputPath('dense-hardware-recovery.png')});
});

test('real pending recovery is fenced across asset switch and unmount, failure preserves CPU and explicit retry works',async({page},info)=>{
 const [media,ontology,document]=await Promise.all(['media','ontology','document'].map(async name=>JSON.parse(await readFile(path.join(root,`tests/fixtures/golden/${name}.json`),'utf8'))));
 await page.goto('http://127.0.0.1:5192/');
 const observation=await page.evaluate(async({media,ontology,document})=>{
  // Imports must execute in the page realm to exercise its actual WASM and Host.
  const wasmUrl='/wasm/wasm_bridge.js',hostUrl='/src/lib/editor/EditorHost.ts';
  const wasm=await import(/* @vite-ignore */ wasmUrl) as EditorWasmBridge&{default():Promise<void>;EditorFacade:{prototype:EditorFacade}};
  await wasm.default();
  const {EditorHost}=await import(/* @vite-ignore */ hostUrl) as {EditorHost:typeof HostType};
  const canvas=window.document.createElement('canvas');canvas.style.width='640px';canvas.style.height='480px';window.document.body.replaceChildren(canvas);
  type Device={destroy():void;lost:Promise<{reason:string}>};type Adapter={requestDevice():Promise<Device>};
  // The DOM lib does not declare WebGPU. Each wrapped call returns a real device.
  const gpuNavigator=navigator as unknown as {gpu:{requestAdapter():Promise<Adapter>}};
  const gpu=gpuNavigator.gpu,original=gpu.requestAdapter.bind(gpu),devices:Device[]=[];
  let gate:Promise<void>|null=null,failNext=false;
  gpu.requestAdapter=async()=>{
   const adapter=await original();
   if(failNext){failNext=false;throw new Error('T30 controlled adapter request rejection');}
   if(gate){const pending=gate;gate=null;await pending;}
   const request=adapter.requestDevice.bind(adapter);
   adapter.requestDevice=async()=>{const device=await request();devices.push(device);return device;};
   return adapter;
  };
  const recoveryPromises:Promise<void>[]=[];
  const recover=wasm.EditorFacade.prototype.recover_renderer;
  wasm.EditorFacade.prototype.recover_renderer=function(){const pending=Reflect.apply(recover,this,[]);recoveryPromises.push(pending);return pending;};
  const host=new EditorHost();host.mount(canvas);
  const request={media,ontology,document,initial_generation:8,frame:{width:640,height:480,rgba:new Uint8Array(640*480*4).fill(255)}};
  await host.loadAsset(request);
  const diagnostics=host.getAdapterDiagnostics();
  if(!/DiscreteGpu|IntegratedGpu|nvidia|intel|amd|apple|blackwell/i.test(diagnostics)||/software|swiftshader|llvmpipe|lavapipe|Cpu/i.test(diagnostics))throw new Error('Not a hardware adapter');
  function status(target:string){return new Promise<void>(resolve=>{const unsubscribe=host.subscribeStatus(()=>{if(host.status===target){unsubscribe();resolve();}});});}
  let release!:()=>void;gate=new Promise<void>(resolve=>{release=resolve;});
  const recovering=status('recovering');devices.at(-1)!.destroy();await recovering;
  const retiredRecovery=recoveryPromises.at(-1)!;
  const switchedDocument={...document,asset_revision_id:'rapid-next-asset'};
  await host.loadAsset({...request,media:{...media,asset_revision_id:'rapid-next-asset'},document:switchedDocument});
  release();await retiredRecovery;
  const afterSwitch={state:host.status,document:host.getSnapshot(),devices:devices.length};
  gate=new Promise<void>(resolve=>{release=resolve;});const recoveringAgain=status('recovering');devices.at(-1)!.destroy();await recoveringAgain;
  const disposedRecovery=recoveryPromises.at(-1)!;host.dispose();release();await disposedRecovery;
  const afterDispose={state:host.status,devices:devices.length};
  const retryHost=new EditorHost();retryHost.mount(canvas);await retryHost.loadAsset(request);
  const edit=retryHost.dispatch({kind:'set_attributes',object_ids:['object_person_001'],values:{helmet_state:'wearing'}});
  const beforeFailure={document:retryHost.getSnapshot(),generation:retryHost.getGeneration()};
  failNext=true;
  const failed=new Promise<void>(resolve=>{const unsubscribe=retryHost.subscribeStatus(()=>{if(retryHost.status==='lost'&&retryHost.error?.code==='GPU_RECOVERY_FAILED'){unsubscribe();resolve();}});});
  devices.at(-1)!.destroy();await failed;
  const failedState={state:retryHost.status,error:retryHost.error,document:retryHost.getSnapshot(),generation:retryHost.getGeneration()};
  await retryHost.retryRenderer();
  const retryState={state:retryHost.status,document:retryHost.getSnapshot(),generation:retryHost.getGeneration()};
  const undo=retryHost.dispatch({kind:'undo'}),final=retryHost.getSnapshot();retryHost.dispose();
  return {diagnostics,afterSwitch,afterDispose,beforeFailure,failedState,retryState,edit,undo,final};
 },{media,ontology,document});
 expect(observation.afterSwitch).toEqual({state:'ready',document:{...document,asset_revision_id:'rapid-next-asset'},devices:2});
 expect(observation.afterDispose).toEqual({state:'disposed',devices:2});
 expect(observation.edit?.can_undo).toBe(true);
 expect(observation.failedState.state).toBe('lost');expect(observation.failedState.error?.code).toBe('GPU_RECOVERY_FAILED');
 expect(observation.failedState.error?.details).toBeNull();
 expect({document:observation.failedState.document,generation:observation.failedState.generation}).toEqual(observation.beforeFailure);
 expect(observation.retryState).toEqual({state:'ready',...observation.beforeFailure});
 expect(observation.undo?.error).toBeNull();expect(observation.final).toEqual(document);
 await writeFile(info.outputPath('real-lifecycle-fences-and-retry.json'),JSON.stringify(observation,null,2));
});
