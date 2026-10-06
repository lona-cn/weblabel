import { execFileSync, spawn } from 'node:child_process';
import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const report = path.join(root, 'reports/T30');
const target = path.join(root, 'target/t30');
const cargo = 'D:/cache/cargo/bin/bin/cargo.exe';
const neutral = 'D:/cache/cargo/bin';
const toolchain=execFileSync('D:/cache/cargo/bin/bin/rustup.exe',['show','active-toolchain'],{cwd:root,encoding:'utf8'}).trim().split(' ')[0];
const stamp=new Date().toISOString().replaceAll(':','-');
await mkdir(path.join(report, 'runtime'), {recursive:true});
const env = {...process.env, RUSTUP_TOOLCHAIN:toolchain, CARGO_HOME:neutral, RUSTUP_HOME:'D:/cache/cargo', CARGO_TARGET_DIR:target, WEBLABEL_API_BINARY:path.join(target,'debug/weblabel-api.exe'), TEMP:path.join(report,'runtime'), TMP:path.join(report,'runtime'), WEBLABEL_T30_ORIGIN:'http://127.0.0.1:5191',WEBLABEL_T30_RUN_TAG:stamp};
const pnpm = path.join(process.env.APPDATA, 'npm/node_modules/pnpm/bin/pnpm.cjs');
const manifest = path.join(root, 'Cargo.toml');
const mode=process.argv[2];
const extras=process.argv.slice(3);
const commands = {
 api:[cargo,['build','--locked','--manifest-path',manifest,'--target-dir',target,'-p','weblabel-api','--bin','weblabel-api'],neutral],
 wasm:[cargo,['build','--locked','--manifest-path',manifest,'--target-dir',target,'-p','wasm-bridge','--target','wasm32-unknown-unknown'],neutral],
 bindgen:['D:/cache/cargo/bin/bin/wasm-bindgen.exe',[path.join(target,'wasm32-unknown-unknown/debug/wasm_bridge.wasm'),'--target','web','--out-dir',path.join(root,'crates/wasm-bridge/target/weblabel-web-public/wasm'),'--out-name','wasm_bridge'],neutral],
 host:[process.execPath,['scripts/build-agent-host.mjs'],root],
 integration:[process.execPath,[pnpm,'exec','vitest','run','tests/integration/t30_faults.test.ts',...extras],root],
 browser:[process.execPath,[pnpm,'exec','playwright','test','tests/e2e/t30_recovery.spec.ts','--config=reports/T30/playwright.config.ts','--project=chromium-webgpu',...extras],root],
 baseline:[process.execPath,[pnpm,'exec','vitest','run','tests/integration/t25_ai.test.ts','tests/integration/t26_review.test.ts','tests/integration/t27_export.test.ts',...extras],root],
 types:[process.execPath,[pnpm,'exec','tsc','--noEmit','--target','ES2024','--module','ESNext','--moduleResolution','Bundler','--skipLibCheck','--lib','ES2024,DOM','--typeRoots','apps/web/node_modules/@types','--types','node','tests/support/faults.ts','tests/integration/t30_faults.test.ts','tests/e2e/t30_recovery.spec.ts',...extras],root],
 contracts:[path.join(target,'debug/xtask.exe'),['contracts-check'],root],
 release:[cargo,['build','--locked','--release','--manifest-path',manifest,'--target-dir',target,'-p','weblabel-api','--bin','weblabel-api'],neutral],
 web:[process.execPath,[pnpm,'--filter','@weblabel/web','exec','vite','build'],root],
 production:[process.execPath,[pnpm,'exec','vitest','run','--config=reports/T30/vitest.config.ts'],root],
};
if(!commands[mode]) throw new Error(`Unknown command ${mode}`);
const [exe,args,cwd]=commands[mode];
if(mode==='production')env.WEBLABEL_API_BINARY=path.join(target,'release/weblabel-api.exe');
const log=path.join(report,`${mode}-${stamp}.log`);
await writeFile(log,JSON.stringify({exe,args,cwd,toolchain,private_browser_origin:env.WEBLABEL_T30_ORIGIN,explicit_current_source_binary:env.WEBLABEL_API_BINARY})+'\n');
const child=spawn(exe,args,{cwd,env,stdio:['ignore','pipe','pipe'],shell:false});
let writes=Promise.resolve();
for(const stream of [child.stdout,child.stderr]) stream.on('data',chunk=>{process.stdout.write(chunk); writes=writes.then(()=>appendFile(log,chunk));});
const closed=Promise.withResolvers();child.once('error',closed.reject);child.once('close',code=>closed.resolve(code??1));const code=await closed.promise;
await writes;
await appendFile(log,`\nEXIT_CODE=${code}\n`);
await appendFile(path.join(report,'commands.jsonl'),JSON.stringify({mode,argv:[exe,...args],cwd,exit_code:code,log_path:path.relative(root,log).replaceAll('\\','/'),private_browser_origin:env.WEBLABEL_T30_ORIGIN})+'\n');
process.exitCode=code;
