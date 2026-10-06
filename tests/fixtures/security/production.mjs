import { randomUUID, createHash } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { readdir, readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const report = join(root, 'reports/T29');
const sentinel = `T29-synthetic-build-secret-${randomUUID()}`;
const env = { ...process.env, OPENAI_API_KEY: sentinel, ANTHROPIC_API_KEY: sentinel, MIMO_API_KEY: sentinel, WEBLABEL_RUN_TOKEN: sentinel, T29_SYNTHETIC_KEY: sentinel };
const commands = [];
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
if (revision.status !== 0) throw new Error('Cannot record production source commit');
const sourceCommit = revision.stdout.trim();
function run(argv, cwd = root) {
  if (argv[0] === 'cargo') argv.push('--config', `build.build-dir=${JSON.stringify(join(root, 'target'))}`);
  const resolved = process.platform === 'win32' && argv[0] === 'pnpm' ? [process.execPath, resolve(dirname(process.execPath), 'node_modules/corepack/dist/pnpm.js'), ...argv.slice(1)] : argv;
  console.log('> ' + argv.join(' '));
  const result = spawnSync(resolved[0], resolved.slice(1), { cwd, env, stdio: 'pipe', encoding: 'utf8', shell: false });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  if (output.includes(sentinel)) throw new Error('Synthetic credential leaked in production build log');
  process.stdout.write(output);
  commands.push({ argv, cwd, exit_code: result.status ?? 1 });
  if (result.status !== 0) throw new Error(`Production command failed (${result.status}): ${argv.join(' ')}`);
}
async function files(path) {
  const paths = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const next = join(path, entry.name);
    if (entry.isDirectory()) paths.push(...await files(next)); else paths.push(next);
  }
  return paths;
}
const outputs = [join(report, 'production-web'), join(report, 'production-host')];
await mkdir(report, { recursive: true });
try {
  const safeCargoCwd = process.env.CARGO_HOME ?? root;
  const cargoPaths = ['--manifest-path', join(root, 'Cargo.toml'), '--target-dir', join(root, 'target')];
  run(['cargo', 'build', '--release', '--locked', ...cargoPaths, '-p', 'weblabel-api', '--bin', 'weblabel-api'], safeCargoCwd);
  run(['cargo', 'build', '--release', '--locked', ...cargoPaths, '--target', 'wasm32-unknown-unknown', '-p', 'wasm-bridge'], safeCargoCwd);
  run(['wasm-bindgen', join(root, 'target/wasm32-unknown-unknown/release/wasm_bridge.wasm'), '--target', 'web', '--out-dir', join(root, 'crates/wasm-bridge/target/weblabel-web-public/wasm'), '--out-name', 'wasm_bridge']);
  run(['pnpm', 'exec', 'vite', 'build', '--sourcemap', '--outDir', outputs[0]], join(root, 'apps/web'));
  run([process.execPath, 'scripts/build-agent-host.mjs']);
  const require = createRequire(join(root, 'apps/agent-host/package.json'));
  const { build } = require('esbuild');
  await build({ absWorkingDir: root, entryPoints: { runtime: 'apps/agent-host/src/runtime/main.ts', mcp: 'apps/agent-host/src/mcp/main.ts' }, bundle: true, platform: 'node', target: 'node24', format: 'esm', minify: true, sourcemap: 'external', outdir: outputs[1], outExtension: { '.js': '.mjs' }, logLevel: 'info' });
  const executable = join(root, 'target/release', process.platform === 'win32' ? 'weblabel-api.exe' : 'weblabel-api');
  const productFiles = [executable, ...await files(outputs[0]), ...await files(outputs[1]), ...await files(join(root, 'target/agent-host'))];
  const evidence = [];
  for (const path of productFiles) {
    const bytes = await readFile(path);
    if (bytes.includes(Buffer.from(sentinel))) throw new Error(`Synthetic credential leaked in ${path}`);
    evidence.push({ path: path.slice(root.length + 1).replaceAll('\\', '/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const maps = productFiles.filter(path => path.endsWith('.map'));
  if (maps.length < 3) throw new Error('Production sourcemap outputs were not actually generated');
  const server = createServer(); const listening = Promise.withResolvers(); server.listen(0, '127.0.0.1', listening.resolve); await listening.promise;
  const port = server.address().port; const closePort = Promise.withResolvers(); server.close(closePort.resolve); await closePort.promise;
  const temporary = await mkdtemp(join(tmpdir(), 't29-release-')); const base = `http://127.0.0.1:${port}`;
  const child = spawn(executable, [], { cwd: root, env: { ...env, WEBLABEL_ENV: 'production', WEBLABEL_BIND: `127.0.0.1:${port}`, WEBLABEL_DATABASE_URL: `sqlite:${join(temporary, 'api.sqlite')}`, WEBLABEL_OBJECT_ROOT: join(temporary, 'objects'), WEBLABEL_COOKIE_SECURE: 'false', WEBLABEL_TEST_MANUAL_MODEL_WORKER: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', chunk => { logs += String(chunk); }); child.stderr.on('data', chunk => { logs += String(chunk); });
  const closed = Promise.withResolvers(); child.once('close', closed.resolve);
  try {
    const deadline = Date.now() + 15_000; let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Release API exited (${child.exitCode})`);
      try { ready = (await fetch(base + '/health', { signal: AbortSignal.timeout(500) })).status === 204; if (ready) break; } catch { /* Only readiness retry; no model or billed request. */ }
      const delay = Promise.withResolvers(); setTimeout(delay.resolve, 50); await delay.promise;
    }
    if (!ready) throw new Error('Release API failed readiness');
    const privateTestRoute = await fetch(base + '/internal/test/jobs/drain', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{}' });
    if (privateTestRoute.status !== 404) throw new Error('Release binary exposed development test drain route');
    const unauthenticated = await fetch(base + '/api/projects');
    if (unauthenticated.status !== 401) throw new Error('Release project route failed session gate');
    if (logs.includes(sentinel)) throw new Error('Release API leaked credential in actual logs');
    await writeFile(join(report, 'release-smoke.log'), logs.replace(/^WEBLABEL_BOOTSTRAP_CODE=.*$/gm, 'WEBLABEL_BOOTSTRAP_CODE=[REDACTED_SYNTHETIC_LAUNCH_CODE]'));
    await writeFile(join(report, 'production-scan.json'), JSON.stringify({ status: 'passed', source_commit: sourceCommit, scope: 'Actual release Rust API, release WASM, Vite production assets with sourcemaps, default Host build and additionally minified Host sourcemaps. Synthetic credentials only; no live providers.', sentinel_sha256: createHash('sha256').update(sentinel).digest('hex'), commands, files: evidence, sourcemaps: maps.length, smoke: { health: 204, test_route: privateTestRoute.status, unauthenticated_projects: unauthenticated.status, secret_in_logs: false } }, null, 2) + '\n');
    console.log(`Production scan passed: ${evidence.length} actual product files, ${maps.length} sourcemaps; release HTTP smoke 204/404/401.`);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill(); await closed.promise; } await rm(temporary, { recursive: true, force: true }); }
} finally {
  for (const output of outputs) await rm(output, { recursive: true, force: true });
}
