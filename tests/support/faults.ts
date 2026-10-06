import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { backup, DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page, Route } from '@playwright/test';
import { database_path_for_test, prepare_test_api } from './app';
import type { ApiClient, TestApp } from './app';
import type { AnnotationDocument } from '../../packages/contracts/generated/AnnotationDocument';
import type { AnnotationRevision } from '../../packages/contracts/generated/AnnotationRevision';
import type { Viewport } from '../../apps/web/src/lib/editor/types';

export const privateOrigin = process.env.WEBLABEL_T30_ORIGIN ?? 'http://127.0.0.1:5191';
const originUrl = new URL(privateOrigin);
if (originUrl.hostname !== '127.0.0.1' || ['5173', '4174', '48100'].includes(originUrl.port) || !originUrl.port) throw new Error('T30 requires an explicit private loopback browser port');
export const jsonObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object');
  return value as Record<string, unknown>;
};
export const id = (value: unknown, key: string): string => {
  const field = jsonObject(value)[key];
  if (typeof field !== 'string' || !field) throw new Error(`Missing ${key}`);
  return field;
};
export async function head(api: ApiClient, asset: string, ontology: string): Promise<AnnotationRevision> {
  const result = await api.request<AnnotationRevision>('GET', `/api/assets/${asset}/annotation?ontology_version_id=${ontology}`);
  if (result.status !== 200) throw new Error(`Head failed ${result.status}: ${JSON.stringify(result.json)}`);
  return result.json;
}
export async function loginClient(base: string, username: string, password: string): Promise<{api: ApiClient; cookie: string}> {
  const response = await fetch(`${base}/api/session/login`, {method:'POST', headers:{origin:base,'content-type':'application/json'}, body:JSON.stringify({username,password})});
  if(response.status!==200) throw new Error(`Login failed ${response.status}`);
  const cookie=(response.headers.get('set-cookie')??'').split(';',1)[0]!;
  const csrf=id(await response.json(),'csrf_token');
  return {cookie, api:{
    async request<T>(method: string, url: string, body?: unknown) {
      const result=await fetch(new URL(url,base), {method, headers:{cookie,origin:base,'x-csrf-token':csrf,'content-type':'application/json'}, ...(body===undefined?{}:{body:JSON.stringify(body)})});
      return {status:result.status,json:await result.json() as T,headers:result.headers};
    },
    async upload<T>(url: string, bytes: Uint8Array, filename: string, operation=crypto.randomUUID(), mime='application/octet-stream') {
      const form=new FormData();form.append('images',new Blob([Uint8Array.from(bytes)],{type:mime}),filename);
      const result=await fetch(new URL(url,base), {method:'POST',headers:{cookie,origin:base,'x-csrf-token':csrf,'idempotency-key':operation},body:form});
      return {status:result.status,json:await result.json() as T,headers:result.headers};
    },
  }};
}
export async function addMember(api:ApiClient, base:string, project:string, role:'admin'|'annotator'|'reviewer') {
  const username=`t30-${crypto.randomUUID()}`, password=`${crypto.randomUUID()}-synthetic-only`;
  const created=await api.request('POST','/api/users',{username,password});
  if(created.status!==201) throw new Error(`Create user ${created.status}`);
  const userId=id(created.json,'user_id');
  const membership=await api.request('POST',`/api/projects/${project}/members`,{user_id:userId,role});
  if(membership.status!==200) throw new Error(`Membership ${membership.status}`);
  return {userId,username,password,...await loginClient(base,username,password)};
}
export async function proxyPage(page:Page, base:string):Promise<void> {
  await page.route(`${privateOrigin}/api/**`, async route => {
    const request=route.request(), incoming=new URL(request.url());
    const headers:Record<string,string>={...request.headers(),origin:base}; delete headers.host;delete headers['content-length'];
    try{await route.fulfill({response:await route.fetch({url:new URL(incoming.pathname+incoming.search,base).href,headers,method:request.method(),postData:request.postDataBuffer()??undefined})});}
    catch{await route.abort('connectionrefused');}
  });
}
export async function actualResponse(route:Route, base:string) {
  const incoming=new URL(route.request().url());
  const headers:Record<string,string>={...route.request().headers(),origin:base};delete headers.host;delete headers['content-length'];
  return route.fetch({url:new URL(incoming.pathname+incoming.search,base).href,headers,method:route.request().method(),postData:route.request().postDataBuffer()??undefined});
}
interface Device { destroy():void; lost:Promise<{reason:string;message:string}> }
interface Adapter { requestDevice(...args:unknown[]):Promise<Device> }
interface GPU { requestAdapter(...args:unknown[]):Promise<Adapter|null> }
interface ReadOnlyHost {getSnapshot():AnnotationDocument|null;getGeneration():number|null;getViewport():Viewport|null;getObjectHashes():Record<string,string>|null}
export interface BrowserFaultControl {
  quota:boolean;
  devices:Device[];
  losses:{reason:string;message:string}[];
  hosts:ReadOnlyHost[];
  destroyDevice():Promise<{reason:string;message:string}>;
}
declare global { interface Window {__t30Faults:BrowserFaultControl} }
/** Installed only by Playwright into its page. Production modules contain no hook or injected success path. */
export async function installBrowserFaults(page:Page):Promise<void> {
  await page.addInitScript(() => {
    const devices:Device[]=[], losses:{reason:string;message:string}[]=[];
    const control:BrowserFaultControl={quota:false,devices,losses,hosts:[],async destroyDevice(){const device=devices.at(-1);if(!device)throw new Error('No actual GPU device');device.destroy();const info=await device.lost;return {reason:info.reason,message:info.message};}};
    window.__t30Faults=control;
    const put=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(...args:Parameters<IDBObjectStore['put']>){
      if(control.quota && this.name==='drafts') throw new DOMException('T30 injected browser storage quota failure','QuotaExceededError');
      return Reflect.apply(put,this,args);
    };
    // DOM typings omit WebGPU; this named binding describes the platform extension, not an external payload.
    const gpuNavigator = navigator as unknown as {gpu?:GPU};
    const gpu=gpuNavigator.gpu;
    if(!gpu)return;
    const request=gpu.requestAdapter.bind(gpu);
    gpu.requestAdapter=async(...args)=>{
      const adapter=await request(...args);if(!adapter)return null;
      const requestDevice=adapter.requestDevice.bind(adapter);
      adapter.requestDevice=async(...deviceArgs)=>{const device=await requestDevice(...deviceArgs);devices.push(device);void device.lost.then(info=>losses.push({reason:info.reason,message:info.message}));return device;};
      return adapter;
    };
  });
}
/** Observe the actual host instantiated by the normal workbench; no alternate editor or command bypass. */
export async function observeEditor(page:Page):Promise<void> {
  await page.evaluate(async()=>{
    const moduleUrl='/src/lib/editor/EditorHost.ts';
    // Runs in the browser realm; a Node static import would instantiate a different module, not the page's Vite module.
    const {EditorHost}=await import(/* @vite-ignore */ moduleUrl) as {EditorHost:{prototype:{mount(this:ReadOnlyHost,canvas:HTMLCanvasElement):void}}};
    const mount=EditorHost.prototype.mount;
    EditorHost.prototype.mount=function(canvas){window.__t30Faults.hosts.push(this);return Reflect.apply(mount,this,[canvas]);};
  });
}
export async function cpuSnapshot(page:Page):Promise<AnnotationDocument> {
  const document=await page.evaluate(()=>window.__t30Faults.hosts.at(-1)?.getSnapshot());
  if(!document)throw new Error('Actual CPU document missing');return document;
}
export async function viewport(page:Page):Promise<Viewport> {
  const view=await page.evaluate(()=>window.__t30Faults.hosts.at(-1)?.getViewport());
  if(!view)throw new Error('Actual Rust viewport missing');return view;
}
export function seededRandom(seed:number):()=>number {
  let state=seed>>>0;
  return ()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/0x100000000;};
}
export interface ProviderRequestEvidence {sha256:string;bytes:number}
export interface SilentProvider {base:string;calls():number;inputs():readonly ProviderRequestEvidence[];stop():Promise<void>}
/** Real writable socket, never a successful fake provider. */
export async function silentProvider():Promise<SilentProvider> {
  let calls=0;const inputs:ProviderRequestEvidence[]=[];
  const server=createServer((request,response)=>{if(request.url==='/chat/completions'&&request.method==='POST'){calls+=1;const hash=createHash('sha256');let bytes=0;request.on('data',chunk=>{hash.update(chunk);bytes+=chunk.length;});request.on('end',()=>{inputs.push({sha256:hash.digest('hex'),bytes});response.writeHead(200,{'content-type':'text/event-stream'});response.flushHeaders();});}else{response.writeHead(404);response.end();}});
  const listening=Promise.withResolvers<void>();server.listen(0,'127.0.0.1',listening.resolve);await listening.promise;
  const address=server.address();if(!address||typeof address==='string')throw new Error('No provider port');
  return {base:`http://127.0.0.1:${address.port}`,calls:()=>calls,inputs:()=>inputs,async stop(){server.closeAllConnections();const closed=Promise.withResolvers<void>();server.close(error=>error?closed.reject(error):closed.resolve());await closed.promise;}};
}
export type ApiEnvironment = Record<string,string> | ((base:string)=>Promise<Record<string,string>>);
export interface PersistentApi {
  database:string;
  readonly base:string;
  start(extra?:ApiEnvironment):Promise<void>;
  crash():Promise<void>;
  stop():Promise<void>;
}
/** Copy a consistent native SQLite backup and actual immutable store, then own restart/crash of that isolated service. */
export async function persistentCopy(app:TestApp, directory:string):Promise<PersistentApi> {
  const binary = prepare_test_api();
  await mkdir(directory,{recursive:true});
  const source=database_path_for_test(app), database=path.join(directory,'api.sqlite');
  const db=new DatabaseSync(source);try{await backup(db,database);}finally{db.close();}
  await cp(path.join(path.dirname(source),'objects'),path.join(directory,'objects'),{recursive:true});
  let child:ChildProcess|null=null;
  let base='';
  return {
    database,
    get base(){return base;},
    async start(extra:ApiEnvironment={}) {
      if(child)throw new Error('Persistent child already started');
      const listener=createServer();const listening=Promise.withResolvers<void>();listener.listen(0,'127.0.0.1',listening.resolve);await listening.promise;
      const address=listener.address();if(!address||typeof address==='string')throw new Error('No API port');
      const closed=Promise.withResolvers<void>();listener.close(()=>closed.resolve());await closed.promise;base=`http://127.0.0.1:${address.port}`;
      const configured=typeof extra==='function'?await extra(base):extra;
      child=spawn(binary,[],{cwd:process.cwd(),env:{...process.env,...configured,WEBLABEL_BIND:`127.0.0.1:${address.port}`,WEBLABEL_DATABASE_URL:`sqlite:${database}`,WEBLABEL_OBJECT_ROOT:path.join(directory,'objects'),WEBLABEL_ENV:'development',WEBLABEL_COOKIE_SECURE:'false',WEBLABEL_TEST_MANUAL_MODEL_WORKER:'0'},stdio:['ignore','pipe','pipe']});
      let output='';child.stdout?.on('data',chunk=>{output+=String(chunk);});child.stderr?.on('data',chunk=>{output+=String(chunk);});
      const deadline=Date.now()+20000;
      while(Date.now()<deadline){if(child.exitCode!==null)throw new Error(`Restart exited: ${output}`);try{if((await fetch(`${base}/health`)).status===204)return;}catch{}await delay(50);}
      throw new Error(`Persistent API failed startup ${output}`);
    },
    async crash() {if(!child)throw new Error('No owned child');const active=child;if(active.exitCode!==null||active.signalCode!==null){child=null;throw new Error('Owned API already exited: requested crash was not exercised');}const exit=Promise.withResolvers<void>();active.once('exit',()=>exit.resolve());active.kill('SIGKILL');await exit.promise;child=null;},
    async stop(){if(child){const active=child;if(active.exitCode===null&&active.signalCode===null){const exit=Promise.withResolvers<void>();active.once('exit',()=>exit.resolve());active.kill('SIGTERM');await exit.promise;}child=null;}await rm(directory,{recursive:true,force:true});},
  };
}
export async function writeEvidence(name:string, value:unknown):Promise<void>{await mkdir('reports/T30/observations',{recursive:true});await writeFile(`reports/T30/observations/${name}.json`,JSON.stringify(value,null,2));}
