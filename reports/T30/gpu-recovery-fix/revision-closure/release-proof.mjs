import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const report=import.meta.dirname,root=path.resolve(report,'../../../..'),results=[];
for(const [name,folder] of [['wasm_bridge','crates/wasm-bridge/target/weblabel-web-public/wasm'],['renderer_wgpu_probe','reports/T30/gpu-recovery-fix/revision-closure/runtime/probe']]){
 const directory=path.join(root,folder),bytes=await readFile(path.join(directory,`${name}_bg.wasm`));
 const module=new WebAssembly.Module(bytes),exports=WebAssembly.Module.exports(module).map(x=>x.name);
 const js=await readFile(path.join(directory,`${name}.js`),'utf8'),dts=await readFile(path.join(directory,`${name}.d.ts`),'utf8');
 if(exports.some(x=>/simulate_device_loss/i.test(x))||/simulate_device_loss/.test(js+dts))throw new Error('Release still exports the fault hook');
 if(!exports.includes('renderer_dispose')||!exports.includes('renderer_recover'))throw new Error('Legitimate Renderer lifecycle capability missing');
 results.push({name,build:'cargo build --release --target wasm32-unknown-unknown',wasm_sha256:createHash('sha256').update(bytes).digest('hex'),js_sha256:createHash('sha256').update(js).digest('hex'),fault_exports:exports.filter(x=>/simulate_device_loss/.test(x)),fault_js:false,fault_types:false,lifecycle_exports:exports.filter(x=>/^(renderer|editorfacade)_(dispose|recover|recover_renderer|device_lost)$/.test(x))});
}
await writeFile(path.join(report,'release-export-proof.json'),JSON.stringify(results,null,2));
await appendFile(path.join(report,'commands.jsonl'),JSON.stringify({argv:[process.execPath,path.relative(root,import.meta.filename)],cwd:root,exit_code:0,tests_passed:0,artifact_ref:path.relative(root,path.join(report,'release-export-proof.json'))})+'\n');
console.log(JSON.stringify(results,null,2));
