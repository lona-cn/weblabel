import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
createServer(async(request,response)=>{
 const pathname=new URL(request.url,'http://127.0.0.1').pathname;
 if(pathname==='/health'){response.writeHead(204).end();return;}
 if(pathname==='/'){response.writeHead(200,{'content-type':'text/html'}).end('<!doctype html><title>Owned real renderer release probe</title>');return;}
 const type=pathname==='/renderer_wgpu_probe.js'?'text/javascript':pathname==='/renderer_wgpu_probe_bg.wasm'?'application/wasm':null;
 if(!type){response.writeHead(404).end();return;}
 try{response.writeHead(200,{'content-type':type,'cache-control':'no-store'}).end(await readFile(path.join(import.meta.dirname,'runtime/probe',pathname.slice(1))));}catch(error){response.writeHead(503).end(String(error));}
}).listen(4183,'127.0.0.1');
