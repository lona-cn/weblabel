import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
const root=fs.realpathSync(process.cwd());
const profile=path.join(root,'target/build-cache/commercial-d/playwright-hardware-profile');
const server=http.createServer((req,res)=>res.writeHead(200,{'content-type':'text/html'}).end('<h1>Owned hardware prerequisite</h1>'));
await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
let context;
try {
  context=await chromium.launchPersistentContext(profile,{headless:true,args:['--enable-unsafe-webgpu','--use-angle=d3d11','--disable-software-rasterizer']});
  const page=context.pages()[0]??await context.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
  const result=await page.evaluate(async()=>{if(!navigator.gpu)return{available:false,reason:'navigator.gpu absent',secureContext:isSecureContext};const a=await navigator.gpu.requestAdapter({powerPreference:'high-performance',forceFallbackAdapter:false});if(!a)return{available:false,reason:'hardware adapter absent',secureContext:isSecureContext};const d=await a.requestDevice();const result={available:true,secureContext:isSecureContext,device_created:true,info:{vendor:a.info.vendor,architecture:a.info.architecture,device:a.info.device,description:a.info.description,isFallbackAdapter:a.info.isFallbackAdapter},maxTextureDimension2D:d.limits.maxTextureDimension2D};d.destroy();return result;});
  console.log(JSON.stringify(result));if(!result.available||result.info.isFallbackAdapter)process.exitCode=1;
} finally {if(context)await context.close();server.closeAllConnections();await new Promise(yes=>server.close(yes));}
