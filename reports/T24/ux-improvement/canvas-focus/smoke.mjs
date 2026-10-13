import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../../../..');
const temporary = path.join(root, 'target/build-cache/candidate-focus-browser-temp');
await mkdir(temporary, { recursive: true });
const webRequire = createRequire(path.join(root, 'apps/web/package.json'));
const { createServer } = await import(pathToFileURL(webRequire.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(webRequire.resolve('@vitejs/plugin-react')).href);
const html = '<!doctype html><html><body style="background:#152131;color:#dae6ee;font-family:sans-serif"><h1>Independent candidate / native canvas read-only focus</h1><div id="candidates"></div><canvas style="width:800px;height:600px;display:block"></canvas><script type="module" src="/reports/T24/ux-improvement/canvas-focus/smoke-entry.tsx"></script></body></html>';
const server = await createServer({ root, configFile: false, cacheDir: path.join(root, 'target/build-cache/candidate-focus-vite'), publicDir: false,
  resolve: { alias: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client'].map(name => ({ find: new RegExp(`^${name}$`), replacement: webRequire.resolve(name) })) },
  plugins: [react(), { name: 'candidate-focus-smoke', configureServer(server) { server.middlewares.use(async (req, res, next) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end(await server.transformIndexHtml('/', html)); return; }
    const file = req.url?.split('?')[0];
    if (file === '/wasm/wasm_bridge.js' || file === '/wasm/wasm_bridge_bg.wasm') { res.setHeader('content-type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'); res.end(await readFile(path.join(root, 'crates/wasm-bridge/target/weblabel-web-public', file))); return; }
    next();
  }); } }], server: { host: '127.0.0.1', port: 5199, strictPort: true, fs: { allow: [root, path.resolve(root, '../../..')] } } });
let browser;
const results = [];
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'chromium', headless: false, env: { ...process.env, TMP: temporary, TEMP: temporary }, args: ['--enable-unsafe-webgpu'] });
  for (const dpr of [1, 1.25, 2]) {
    const context = await browser.newContext({ viewport: { width: 1200, height: 1400 }, deviceScaleFactor: dpr });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto('http://127.0.0.1:5199/');
    await page.waitForFunction(() => window.__focusSmoke?.host.status === 'ready');
    const state = () => page.evaluate(() => ({ view: window.__focusSmoke.host.getViewport(), document: window.__focusSmoke.host.getSnapshot(), generation: window.__focusSmoke.host.getGeneration(), adapter: window.__focusSmoke.host.getAdapterDiagnostics(), stats: window.__focusSmoke.host.getRenderStats() }));
    const initial = await state();
    assert(initial.adapter.length > 0 && !/swiftshader|software|llvmpipe|lavapipe|cpu\b/i.test(initial.adapter), initial.adapter);
    await page.getByRole('button', { name: '定位主画布 roi', exact: true }).click();
    await page.waitForFunction(() => Math.abs(window.__focusSmoke.host.getViewport().scale - 0.9 * 600 / 200.25) < 1e-12);
    const focused = await state();
    assert.equal(focused.view.dpr, dpr);
    assert(Math.abs(focused.view.tx + 60.25 * focused.view.scale - 400) < 1e-12);
    assert(Math.abs(focused.view.ty + 120.375 * focused.view.scale - 300) < 1e-12);
    assert.deepEqual(focused.document, initial.document);
    assert.equal(focused.generation, initial.generation);
    assert(await page.getByRole('button', { name: '采纳所选建议' }).isDisabled());
    const invalid = await page.evaluate(() => window.__focusSmoke.host.focusRegion({ type: 'bbox_xyxy', x_min: NaN, y_min: 0, x_max: 10, y_max: 10 }));
    assert.equal(invalid, false);
    assert.deepEqual((await state()).view, focused.view);
    const undo = await page.evaluate(() => window.__focusSmoke.host.dispatch({ kind: 'undo' }));
    assert.equal(undo.document_changed, false);
    assert.equal(undo.can_undo, false); assert.equal(undo.can_redo, false);
    assert.deepEqual(undo.selected_object_ids, []);
    assert(focused.stats.gpu_submissions > 0);
    assert.equal(errors.length, 0, errors.join('\n'));
    await page.screenshot({ path: path.join(directory, `hardware-dpr${dpr}.png`), fullPage: true });
    results.push({ dpr, initial, focused, undo, invalid, errors });
    await page.evaluate(() => window.__focusSmoke.dispose()); await context.close();
  }
  await writeFile(path.join(directory, 'hardware-smoke.json'), JSON.stringify({ status: 'passed', scope: 'Independent CandidateList + real current WASM + hardware WebGPU; synthetic frame, no model, no integrated Workbench claim', results }, null, 2));
  console.log(JSON.stringify({ status: 'passed', dprs: [1, 1.25, 2], adapter: results[0].initial.adapter }));
} finally { await browser?.close(); await server.close(); }
