import {execFileSync,spawn} from 'node:child_process';
import {cp,mkdir,readFile,writeFile,appendFile,rm} from 'node:fs/promises';
import path from 'node:path';
const report=import.meta.dirname,root=path.resolve(report,'../../../..');
const mirror=path.join(report,'runtime/workspace'),target=path.join(root,'target/t30-closure');
const cargo='D:/cache/cargo/bin/bin/cargo.exe',neutral='D:/cache/cargo/bin';
const toolchain=execFileSync('D:/cache/cargo/bin/bin/rustup.exe',['show','active-toolchain'],{cwd:root,encoding:'utf8'}).trim().split(/\s+/)[0];
const pnpm=path.join(process.env.APPDATA,'npm/node_modules/pnpm/bin/pnpm.cjs');
const env={...process.env,RUSTUP_TOOLCHAIN:toolchain,RUSTUP_HOME:'D:/cache/cargo',CARGO_HOME:neutral,CARGO_TARGET_DIR:target,WEBLABEL_API_BINARY:path.join(target,'debug/weblabel-api.exe'),WEBLABEL_T30_ORIGIN:'http://127.0.0.1:5193',TEMP:path.join(report,'runtime'),TMP:path.join(report,'runtime'),REQUIRE_HARDWARE_GPU:'1',REQUIRE_WGPU_DEVICE:'1'};
const mode=process.argv[2];env.WEBLABEL_T30_RUN_TAG=mode;
async function run(exe,args,cwd=root){
 const log=path.join(report,`${mode}.log`);await appendFile(log,JSON.stringify({exe,args,cwd,toolchain})+'\n');
 const child=spawn(exe,args,{cwd,env,stdio:['ignore','pipe','pipe'],shell:false});let writes=Promise.resolve();
 for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{process.stdout.write(chunk);writes=writes.then(()=>appendFile(log,chunk));});
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});await writes;
 await appendFile(log,`\nEXIT_CODE=${code}\n`);await appendFile(path.join(report,'commands.jsonl'),JSON.stringify({argv:[exe,...args],cwd,exit_code:code,log_path:path.relative(root,log)})+'\n');if(code!==0)process.exitCode=code;return code;
}
await mkdir(path.join(report,'runtime'),{recursive:true});
if(mode==='prepare'){
 await cp(path.join(root,'crates'),path.join(mirror,'crates'),{recursive:true,filter:source=>!source.split(path.sep).includes('target')});
 await cp(path.join(root,'tests/fixtures'),path.join(mirror,'tests/fixtures'),{recursive:true});
 await cp(path.join(root,'Cargo.toml'),path.join(mirror,'Cargo.toml'));await cp(path.join(root,'Cargo.lock'),path.join(mirror,'Cargo.lock'));
 await run(cargo,['check','--offline','--manifest-path',path.join(mirror,'Cargo.toml'),'-p','wasm-bridge','--target','wasm32-unknown-unknown'],neutral);
}else if(mode==='format')await run('D:/cache/cargo/bin/bin/rustfmt.exe',['--edition','2021','crates/renderer-wgpu/src/renderer.rs','crates/wasm-bridge/src/facade.rs']);
else if(mode==='native')await run(cargo,['test','--locked','--manifest-path',path.join(mirror,'Cargo.toml'),'-p','annotation-domain','-p','geometry','-p','editor-core','-p','renderer-wgpu','-p','wasm-bridge'],neutral);
else if(mode==='wasm')await run(cargo,['build','--release','--locked','--manifest-path',path.join(mirror,'Cargo.toml'),'-p','wasm-bridge','-p','renderer-wgpu','--target','wasm32-unknown-unknown'],neutral);
else if(mode==='api')await run(cargo,['build','--locked','--manifest-path',path.join(mirror,'Cargo.toml'),'-p','weblabel-api','--bin','weblabel-api'],neutral);
else if(mode==='bindgen'){
 for(const [name,out] of [['wasm_bridge','crates/wasm-bridge/target/weblabel-web-public/wasm'],['renderer_wgpu','reports/T30/gpu-recovery-fix/revision-closure/runtime/probe']]){
 await run('D:/cache/cargo/bin/bin/wasm-bindgen.exe',[path.join(target,`wasm32-unknown-unknown/release/${name}.wasm`),'--target','web','--out-dir',path.join(root,out),'--out-name',name==='renderer_wgpu'?'renderer_wgpu_probe':name],neutral);
 }
}else if(mode==='types')await run(process.execPath,[pnpm,'--filter','@weblabel/web','typecheck']);
else if(mode==='consumer'){
 const peer='C:/Users/admin/.omp/wt/tcdfc858cd/m',commit='483cb620275d38ff87d34d9b14602ed06d7ed71d';
 for(const file of ['tests/e2e/t30_recovery.spec.ts','tests/support/faults.ts']){
 let content=execFileSync('git',['show',`${commit}:${file}`],{cwd:peer,encoding:'utf8'});
 const base=path.dirname(file);
 content=content.replace(/(from\s+['"])(\.\.?\/[^'"]+)(['"])/g,(all,prefix,relative,suffix)=>{
 const dest=path.posix.normalize(path.posix.join(base,relative));
 if(dest==='tests/support/faults')return prefix+'./faults'+suffix;
 return prefix+path.relative(report,path.join(root,dest)).replaceAll('\\','/')+suffix;
 });
 if(file.endsWith('t30_recovery.spec.ts')){
  content=content.replace('  const surfaceBefore=await canvasObservation(page);',`  const surfaceBefore=await canvasObservation(page);\n  const nativeBefore=await page.evaluate(()=>({hashes:window.__t30Faults.hosts.at(-1)!.getObjectHashes(),generation:window.__t30Faults.hosts.at(-1)!.getGeneration(),sessions:window.__t30Faults.hosts.length}));`);
  const anchor="  expect(createHash('sha256').update(canvasAfter).digest('hex')).toBe(createHash('sha256').update(canvasBefore).digest('hex'));";
  content=content.replace(anchor,anchor+`\n  expect(surfaceAfter).toEqual(surfaceBefore);\n  const nativeAfter=await page.evaluate(()=>({hashes:window.__t30Faults.hosts.at(-1)!.getObjectHashes(),generation:window.__t30Faults.hosts.at(-1)!.getGeneration(),sessions:window.__t30Faults.hosts.length}));\n  expect(nativeAfter).toEqual(nativeBefore);\n  await info.attach('native-session-parity',{body:JSON.stringify({nativeBefore,nativeAfter}),contentType:'application/json'});`);
  content+='\n'+await readFile(path.join(report,'app-smoke.fragment.txt'),'utf8');
 }
 await writeFile(path.join(report,path.basename(file)),content);
 }
 await writeFile(path.join(report,'consumer-provenance.json'),JSON.stringify({commit,files:['tests/e2e/t30_recovery.spec.ts','tests/support/faults.ts']},null,2));
}else if(mode==='browser'||mode==='held')await run(process.execPath,[pnpm,'exec','playwright','test','--config='+path.relative(root,path.join(report,'playwright.config.ts')),'--project=chromium-webgpu',...(mode==='browser'?['--grep','F14 actual hardware']:['--grep','closure'])]);
else if(mode==='t05'){
 let content=await readFile(path.join(root,'tests/render/t05.spec.ts'),'utf8');content=content.replaceAll('http://127.0.0.1:4174/','http://127.0.0.1:4183/').replaceAll('reports/T05/',path.relative(root,report).replaceAll('\\','/')+'/t05/');await writeFile(path.join(report,'t05.private.spec.ts'),content);
 await run(process.execPath,[pnpm,'exec','playwright','test','--config='+path.relative(root,path.join(report,'playwright.config.ts')),'--project=t05-render']);
}else if(mode==='record-red'){
 await cp(path.join(report,'browser-artifacts/t05'),path.join(report,'browser-artifacts/t05-red'),{recursive:true});
 for(const file of ['t05.log','t05-results.json'])await cp(path.join(report,file),path.join(report,file.replace('t05','t05-red')));
}else if(mode==='smoke-types')await run(process.execPath,[pnpm,'--filter','@weblabel/web','exec','tsc','--noEmit','--target','ES2024','--module','ESNext','--moduleResolution','Bundler','--skipLibCheck','--lib','ES2024,DOM','--types','node,vite/client','--jsx','react-jsx',path.join(report,'closure.spec.ts'),path.join(report,'t30_recovery.spec.ts')]);
else if(mode==='cleanup'){
 const executed=await readFile(path.join(report,'t30_recovery.spec.ts'),'utf8');
 await writeFile(path.join(report,'app-smoke.fragment.txt'),executed.slice(executed.indexOf('declare global {interface Window {__closureGate:')));
 for(const file of ['t30_recovery.spec.ts','faults.ts','t05.private.spec.ts'])await rm(path.join(report,file),{force:true});
 await rm(path.join(report,'runtime'),{recursive:true,force:true});
}else throw new Error('Unknown mode '+mode);
