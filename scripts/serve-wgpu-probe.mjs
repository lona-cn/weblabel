import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'target', 'weblabel-wgpu-probe');
const routes = new Map([
  ['/', [path.join(root, 'tests/e2e/t00-webgpu-probe.html'), 'text/html; charset=utf-8']],
  ['/t00-webgpu-probe.html', [path.join(root, 'tests/e2e/t00-webgpu-probe.html'), 'text/html; charset=utf-8']],
  ['/renderer_wgpu_probe.js', [path.join(artifacts, 'renderer_wgpu_probe.js'), 'text/javascript; charset=utf-8']],
  ['/renderer_wgpu_probe_bg.wasm', [path.join(artifacts, 'renderer_wgpu_probe_bg.wasm'), 'application/wasm']],
]);

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (pathname === '/health') {
    response.writeHead(204).end();
    return;
  }
  const entry = routes.get(pathname);
  if (!entry) {
    response.writeHead(404).end('Not found');
    return;
  }
  const [file, contentType] = entry;
  fs.readFile(file, (error, content) => {
    if (error) {
      response.writeHead(503).end('WASM probe has not been built');
      return;
    }
    response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' }).end(content);
  });
});

server.listen(4174, '127.0.0.1');
