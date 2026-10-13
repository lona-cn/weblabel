import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const root="D:/workspace/src/weblabel", cache="D:/workspace/src/weblabel/target/build-cache/readme-first-use-1791687392168", release="D:/workspace/src/weblabel/target/build-cache/commercial-d/release-e-1791659608526-focus-fixed-1791662552385";
const require=createRequire(root+'/package.json'); const {chromium}=require('@playwright/test');
await fs.mkdir(cache+'/os-temp',{recursive:true});
for(const k of ['TEMP','TMP','TMPDIR'])process.env[k]=cache+'/os-temp';
for(const k of Object.keys(process.env))if(k.startsWith('WEBLABEL_'))delete process.env[k];
async function freePort(){const s=net.createServer();await new Promise((ok,no)=>{s.once('error',no);s.listen(0,'127.0.0.1',ok)});const p=s.address().port;await new Promise(ok=>s.close(ok));return p;}
const port=await freePort(), apiPort=await freePort(), origin='http://127.0.0.1:'+port;
const data=cache+'/fresh-data'; let code='',raw='';
const child=spawn(process.execPath,[root+'/scripts/start-local.mjs','--build-dir',release,'--data-dir',data,'--port',String(port),'--api-port',String(apiPort)],{cwd:root,env:process.env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
const closed=new Promise(ok=>child.once('close',(exit,signal)=>ok({exit,signal})));
for(const stream of[child.stdout,child.stderr])stream.on('data',c=>{raw+=c.toString();const p=raw.indexOf('WEBLABEL_BOOTSTRAP_CODE=');if(p>=0)code=raw.slice(p+'WEBLABEL_BOOTSTRAP_CODE='.length).split(String.fromCharCode(10))[0].trim();});
let healthy=false;for(let i=0;i<400;i++){try{if((await fetch('http://127.0.0.1:'+apiPort+'/health')).status===204&&code&&(await fetch(origin)).status===200){healthy=true;break;}}catch{}await new Promise(ok=>setTimeout(ok,100));}
if(!healthy)throw Error('Normal CLI not healthy; raw output withheld to protect code');
const context=await chromium.launchPersistentContext(cache+'/chrome-profile',{channel:'chromium',headless:true,viewport:{width:1440,height:1000},args:['--enable-unsafe-webgpu','--use-angle=d3d11','--disable-software-rasterizer','--remote-debugging-port=0']});
const active=await fs.readFile(cache+'/chrome-profile/DevToolsActivePort','utf8');const cdp='http://127.0.0.1:'+Number(active.split(String.fromCharCode(10))[0]);
const password=randomUUID()+randomUUID();
console.log(JSON.stringify({ready:true,pid:child.pid,origin,apiPort,data,release,cdp,bootstrap:await(await fetch(origin+'/api/session/bootstrap')).json(),secret_recording:false}));
const input=createInterface({input:process.stdin});
let q=Promise.resolve();
for await(const line of input){q=q.then(async()=>{const cmd=JSON.parse(line);const page=context.pages().find(p=>p.url().startsWith(origin));if(cmd.command==='fill-bootstrap'){await page.locator('[data-testid=bootstrap-launch-code]').fill(code);await page.locator('[data-testid=bootstrap-password]').fill(password);await page.locator('[data-testid=bootstrap-password-confirm]').fill(password);console.log(JSON.stringify({command:cmd.command,filled:true,no_manual_HTTP:true}));}else if(cmd.command==='fill-login'){await page.locator('[data-testid=login-username]').fill('local-admin');await page.locator('[data-testid=login-password]').fill(password);console.log(JSON.stringify({command:cmd.command,filled:true}));}else if(cmd.command==='stop'){await context.close();const {stopTree}=await import(root+'/scripts/start-local.mjs');await stopTree(child);await closed;await freePort();let lock=JSON.parse(await fs.readFile(data+'/runtime.lock','utf8'));if(lock.pid!==child.pid)throw Error('Not our lock');for(const p of [port,apiPort]){const s=net.createServer();await new Promise((ok,no)=>{s.once('error',no);s.listen(p,'127.0.0.1',ok)});await new Promise(ok=>s.close(ok));}await fs.unlink(data+'/runtime.lock');console.log(JSON.stringify({command:cmd.command,stopped:true,pid:child.pid,ports_closed:true,own_lock_removed_after_closed:true}));input.close();}else throw Error('Unknown verification command');}).catch(e=>{console.log(JSON.stringify({error:e.message}));process.exitCode=1;});}
await q;
