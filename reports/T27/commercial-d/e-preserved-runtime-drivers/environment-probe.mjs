import {execFileSync} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
const versions=Object.fromEntries([['node',process.execPath,['--version']],['pnpm',process.execPath,['D:/workspace/src/weblabel/target/t31-node-runtime-v24.16.0/node-v24.16.0-win-x64/node_modules/corepack/dist/pnpm.js','--version']],['rustc','rustc.exe',['--version']],['cargo','cargo.exe',['--version']],['wasm-bindgen','wasm-bindgen.exe',['--version']],['wasm-pack','wasm-pack.exe',['--version']]].map(([name,exe,args])=>[name,execFileSync(exe,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()]));
const root=realpathSync('D:/workspace/src/weblabel'),temp=realpathSync(tmpdir());
if(!temp.startsWith(root+'\\'))throw Error('Temporary directory escapes project root');
const values=Object.values(versions),expected=['24.16.0','10.34.5','1.96.0','1.96.0','0.2.128','0.15.0'];
expected.forEach((v,i)=>{if(!values[i].includes(v))throw Error('Wrong fixed tool version '+values[i]);});
console.log(JSON.stringify({versions,physical_root:root,physical_tmp:temp,api_override:process.env.WEBLABEL_API_BINARY??null,release_override:process.env.WEBLABEL_T33_RELEASE??null},null,2));
