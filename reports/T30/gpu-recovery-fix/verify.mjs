import {execFileSync, spawn} from 'node:child_process';
import {cp, mkdir, readFile, writeFile, appendFile, rm} from 'node:fs/promises';
import path from 'node:path';
const report=import.meta.dirname;
const root=path.resolve(report,'../../..');
const mirror=path.join(report,'runtime/workspace');
const target=path.join(root,'target/t30-recovery');
const cargo='D:/cache/cargo/bin/bin/cargo.exe';
const neutral='D:/cache/cargo/bin';
const toolchain=execFileSync('D:/cache/cargo/bin/bin/rustup.exe',['show','active-toolchain'],{cwd:root,encoding:'utf8'}).trim().split(/\s+/)[0];
const env={...process.env,RUSTUP_TOOLCHAIN:toolchain,RUSTUP_HOME:'D:/cache/cargo',CARGO_HOME:neutral,CARGO_TARGET_DIR:target,WEBLABEL_API_BINARY:path.join(target,'debug/weblabel-api.exe'),WEBLABEL_T30_ORIGIN:'http://127.0.0.1:5192',WEBLABEL_T30_RUN_TAG:'recovery-fix',TEMP:path.join(report,'runtime'),TMP:path.join(report,'runtime')};
const pnpm=path.join(process.env.APPDATA,'npm/node_modules/pnpm/bin/pnpm.cjs');
async function run(exe,args,cwd=root){
 const mode=process.argv[2];const logfile=path.join(report,`${mode}.log`);
 env.WEBLABEL_T30_RUN_TAG=mode;
 await appendFile(logfile,JSON.stringify({exe,args,cwd,toolchain})+'\n');
 const child=spawn(exe,args,{cwd,env,stdio:['ignore','pipe','pipe'],shell:false});let writes=Promise.resolve();
 for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{process.stdout.write(chunk);writes=writes.then(()=>appendFile(logfile,chunk));});
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});await writes;
 await appendFile(logfile,`\nEXIT_CODE=${code}\n`);await appendFile(path.join(report,'commands.jsonl'),JSON.stringify({argv:[exe,...args],cwd,exit_code:code,log_path:path.relative(root,logfile)})+'\n');
 if(code!==0)process.exitCode=code;return code;
}
await mkdir(path.join(report,'runtime'),{recursive:true});
const mode=process.argv[2];
if(mode==='prepare'){
 // Build an exact source mirror so the shared root lockfile remains untouched.
 await cp(path.join(root,'crates'),path.join(mirror,'crates'),{recursive:true,filter:source=>!source.split(path.sep).includes('target')});
 await cp(path.join(root,'tests/fixtures'),path.join(mirror,'tests/fixtures'),{recursive:true});
 await cp(path.join(root,'Cargo.toml'),path.join(mirror,'Cargo.toml'));
 await cp(path.join(root,'Cargo.lock'),path.join(mirror,'Cargo.lock'));
 await run(cargo,['check','--offline','--manifest-path',path.join(mirror,'Cargo.toml'),'-p','wasm-bridge','--target','wasm32-unknown-unknown'],neutral);
 // Only direct dependency edges are proposed for integration, never root writes.
 const before=(await readFile(path.join(root,'Cargo.lock'),'utf8')).replaceAll('\r\n','\n');const after=(await readFile(path.join(mirror,'Cargo.lock'),'utf8')).replaceAll('\r\n','\n');
 const oldBlocks=before.split('\n[[package]]');const newBlocks=after.split('\n[[package]]');
 const affected=['renderer-wgpu','wasm-bridge'];
 for(const block of oldBlocks){if(!affected.some(name=>block.includes(`name = "${name}"\n`))&&!newBlocks.includes(block))throw new Error('Unrelated lock resolution changed');}
 let patch='';
 for(const name of affected){const old=oldBlocks.find(b=>b.includes(`name = "${name}"\n`));const next=newBlocks.find(b=>b.includes(`name = "${name}"\n`));if(!old||!next)throw new Error('Missing lock entry');
 const oldLines=old.trim().split('\n'),newLines=next.trim().split('\n');
 patch+=`--- a/Cargo.lock\n+++ b/Cargo.lock\n@@ -${before.split('\n').findIndex(line=>line===`name = "${name}"`)+1},${oldLines.length} +${after.split('\n').findIndex(line=>line===`name = "${name}"`)+1},${newLines.length} @@\n`;
 let j=0;for(const line of newLines){if(line===oldLines[j]){patch+=' '+line+'\n';j++;}else patch+='+'+line+'\n';}if(j!==oldLines.length)throw new Error('Unexpected dependency deletion');
 }
 await writeFile(path.join(report,'integration.patch'),patch+await readFile(path.join(report,'contracts.integration.patch'),'utf8'));
 await writeFile(path.join(report,'lock.integration.patch'),patch);
}else if(mode==='native')await run(cargo,['test','--locked','--manifest-path',path.join(mirror,'Cargo.toml'),'-p','annotation-domain','-p','geometry','-p','editor-core','-p','renderer-wgpu','-p','wasm-bridge'],neutral);
else if(mode==='wasm')await run(cargo,['build','--locked','--manifest-path',path.join(mirror,'Cargo.toml'),'-p','wasm-bridge','--target','wasm32-unknown-unknown'],neutral);
else if(mode==='api')await run(cargo,['build','--locked','--manifest-path',path.join(mirror,'Cargo.toml'),'-p','weblabel-api','--bin','weblabel-api'],neutral);
else if(mode==='bindgen')await run('D:/cache/cargo/bin/bin/wasm-bindgen.exe',[path.join(target,'wasm32-unknown-unknown/debug/wasm_bridge.wasm'),'--target','web','--out-dir',path.join(root,'crates/wasm-bridge/target/weblabel-web-public/wasm'),'--out-name','wasm_bridge'],neutral);
else if(mode==='lifecycle')await run(process.execPath,[pnpm,'exec','vitest','run','apps/web/src/lib/editor/t09_lifecycle.test.ts']);
else if(mode==='types')await run(process.execPath,[pnpm,'--filter','@weblabel/web','typecheck']);
else if(mode==='smoke-types')await run(process.execPath,[pnpm,'--filter','@weblabel/web','exec','tsc','--noEmit','--target','ES2024','--module','ESNext','--moduleResolution','Bundler','--skipLibCheck','--lib','ES2024,DOM','--types','node,vite/client','--jsx','react-jsx',path.join(report,'dense.spec.ts')]);
else if(mode==='patches')await run('git',['apply','--check','reports/T30/gpu-recovery-fix/integration.patch']);
else if(mode==='dense')await run(process.execPath,[pnpm,'exec','playwright','test','reports/T30/gpu-recovery-fix/dense.spec.ts','--config=reports/T30/gpu-recovery-fix/playwright.config.ts','--project=chromium-webgpu']);
else if(mode==='browser'){
 // Exact committed consumer baseline, copied only for a private run and always removed.
 const baselineRepo='C:/Users/admin/.omp/wt/tcdfc858cd/m';
 const baseline=execFileSync('git',['show','6eb06eca:tests/e2e/t30_recovery.spec.ts'],{cwd:baselineRepo,encoding:'utf8'});
 const faults=execFileSync('git',['show','6eb06eca:tests/support/faults.ts'],{cwd:baselineRepo});
 const beforeAnchor='  const devicesBefore=await page.evaluate(()=>window.__t30Faults.devices.length);';
 const afterAnchor="  expect(await cpuSnapshot(page)).toEqual(before);await expect(page.getByTestId('undo')).toBeEnabled();";
 if(!baseline.includes(beforeAnchor)||!baseline.includes(afterAnchor))throw new Error('Committed consumer anchors changed');
 const instrumented=baseline.replace(beforeAnchor,`  const nativeBefore=await page.evaluate(()=>({hashes:window.__t30Faults.hosts.at(-1)!.getObjectHashes(),generation:window.__t30Faults.hosts.at(-1)!.getGeneration(),sessions:window.__t30Faults.hosts.length}));\n${beforeAnchor}`).replace(afterAnchor,`  const nativeAfter=await page.evaluate(()=>({hashes:window.__t30Faults.hosts.at(-1)!.getObjectHashes(),generation:window.__t30Faults.hosts.at(-1)!.getGeneration(),sessions:window.__t30Faults.hosts.length}));\n  expect(nativeAfter).toEqual(nativeBefore);\n  await evidence(page,info,'native-session-preserved',{nativeBefore,nativeAfter,devicesBefore,devicesAfter:await page.evaluate(()=>window.__t30Faults.devices.length),undoEnabled:await page.getByTestId('undo').isEnabled(),navigations});\n${afterAnchor}`);
 await writeFile(path.join(root,'tests/e2e/t30_recovery.spec.ts'),instrumented);await writeFile(path.join(root,'tests/support/faults.ts'),faults);
 try{await run(process.execPath,[pnpm,'exec','playwright','test','tests/e2e/t30_recovery.spec.ts','--config=reports/T30/gpu-recovery-fix/playwright.config.ts','--project=chromium-webgpu','--grep','F14']);}
 finally{await rm(path.join(root,'tests/e2e/t30_recovery.spec.ts'));await rm(path.join(root,'tests/support/faults.ts'));}
}else if(mode==='cleanup')await rm(path.join(report,'runtime'),{recursive:true,force:true});
else throw new Error(`Unknown mode ${mode}`);
