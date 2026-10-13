import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../../../..');
const webRequire = createRequire(path.join(root, 'apps/web/package.json'));
const { createServer } = await import(pathToFileURL(webRequire.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(webRequire.resolve('@vitejs/plugin-react')).href);
const html = '<!doctype html><html><body style="background:#152131;color:#dae6ee;font-family:sans-serif"><div id="controls"></div><canvas style="width:800px;height:600px;display:block"></canvas><script type="module" src="/reports/T12/ux-improvement/viewport/smoke-entry.tsx"></script></body></html>';
const server = await createServer({ root, configFile: false, cacheDir: path.join(root, 'target/build-cache/viewport-vite-smoke'), publicDir: false,
  resolve: { alias: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client'].map(name => ({ find: new RegExp(`^${name}$`), replacement: webRequire.resolve(name) })) },
  plugins: [react(), { name: 'viewport-native-smoke', configureServer(server) { server.middlewares.use(async (req, res, next) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end(await server.transformIndexHtml('/', html)); return; }
    const file = req.url?.split('?')[0];
    if (file === '/wasm/wasm_bridge.js' || file === '/wasm/wasm_bridge_bg.wasm') { res.setHeader('content-type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'); res.end(await readFile(path.join(root, 'crates/wasm-bridge/target/weblabel-web-public', file))); return; }
    next();
  }); } }], server: { host: '127.0.0.1', port: 5198, strictPort: true, fs: { allow: [root, path.resolve(root, '../../..')] } } });
let browser;
const results = [];
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'chromium', headless: false, args: ['--enable-unsafe-webgpu'] });
  for (const dpr of [1, 2]) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 850 }, deviceScaleFactor: dpr });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto('http://127.0.0.1:5198/');
    await page.waitForFunction(() => window.__viewportSmoke?.host.status === 'ready');
    const state = () => page.evaluate(() => ({ view: window.__viewportSmoke.host.getViewport(), hit: window.__viewportSmoke.host.getHitStackState(), generation: window.__viewportSmoke.host.getGeneration(), adapter: window.__viewportSmoke.host.getAdapterDiagnostics(), stats: window.__viewportSmoke.host.getRenderStats() }));
    const initial = await state();
    assert(!/swiftshader|software|llvmpipe|lavapipe|cpu\b/i.test(initial.adapter), initial.adapter);
    assert(initial.adapter.length > 0, 'Native adapter diagnostics missing');
    await page.getByRole('button', { name: '放大', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="当前倍率"]').textContent === '156.3%');
    const plus = await state(); assert.equal(plus.view.scale, initial.view.scale * 1.25);
    await page.getByRole('button', { name: '缩小', exact: true }).click();
    await page.getByRole('button', { name: '1:1 像素', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="当前倍率"]').textContent === '100%');
    const actual = await state(); assert.equal(actual.view.scale, 1); assert.equal(actual.view.dpr, dpr);
    await page.getByRole('button', { name: '适配图像', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="当前倍率"]').textContent === '125%');
    const canvas = page.locator('canvas'); const box = await canvas.boundingBox();
    await page.mouse.click(box.x + 75, box.y + 125);
    await page.waitForFunction(() => document.querySelector('[aria-label="重叠命中栈"]').textContent.includes('1 / 2'));
    const first = await state(); assert.equal(first.hit.index, 0); assert.equal(first.hit.count, 2);
    await page.mouse.click(box.x + 75, box.y + 125);
    await page.waitForFunction(() => document.querySelector('[aria-label="重叠命中栈"]').textContent.includes('2 / 2'));
    const second = await state(); assert.equal(second.hit.index, 1);
    await page.getByRole('button', { name: '聚焦选中对象', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="当前倍率"]').textContent === '270%');
    const focus = await state(); assert.equal(focus.view.scale, 2.7); assert.equal(focus.hit.count, 0);
    assert.equal(focus.generation, initial.generation);
    assert(focus.stats.gpu_submissions > 0, 'Native renderer submitted no frames');
    assert.equal(errors.length, 0, errors.join('\n'));
    await page.screenshot({ path: path.join(directory, `hardware-dpr${dpr}.png`) });
    results.push({ dpr, initial, plus, actual, first, second, focus, errors });
    await page.evaluate(() => window.__viewportSmoke.dispose()); await context.close();
  }
  await writeFile(path.join(directory, 'hardware-smoke.json'), JSON.stringify({ status: 'passed', scope: 'isolated component + actual current WASM + hardware WebGPU; not integrated Workbench/G4/performance', results }, null, 2));
  console.log(JSON.stringify({ status: 'passed', dprs: [1, 2], adapter: results[0].initial.adapter }));
} finally { await browser?.close(); await server.close(); }
