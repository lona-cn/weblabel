import { randomUUID, createHash } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolveArgv } from '../../../scripts/task.mjs';
import { captureEvidenceIdentity } from '../../../scripts/evidence-identity.mjs';
import { projectOutputPath, taskReportPath } from '../../support/report-paths.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const nonce = randomUUID(), report = taskReportPath('T29', 'html-rust-rebuild', 'native-production-' + nonce);
const temporary = projectOutputPath(join(root, 'target/test-artifacts/T29-native-production', nonce)); await mkdir(temporary, { recursive: true });
const target = projectOutputPath(resolve(root, process.env.CARGO_TARGET_DIR ?? 'target/build-cache/html-rust-rebuild/cargo'));
const sentinel = 'T29-synthetic-build-secret-' + randomUUID();
const allowed = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'WINDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'CARGO_HOME', 'RUSTUP_HOME', 'RUSTC', 'RUSTDOC', 'VCINSTALLDIR', 'WindowsSdkDir', 'INCLUDE', 'LIB', 'LIBPATH'];
const compilerEnv = Object.fromEntries(allowed.filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(compilerEnv, { RUSTC_WRAPPER: '', RUSTUP_TOOLCHAIN: '1.96.0', RUSTUP_AUTO_INSTALL: '0', TEMP: temporary, TMP: temporary, TMPDIR: temporary, CARGO_TARGET_DIR: target });
const identity = captureEvidenceIdentity({ env: compilerEnv });
const env = { ...compilerEnv, OPENAI_API_KEY: sentinel, ANTHROPIC_API_KEY: sentinel, MIMO_API_KEY: sentinel, WEBLABEL_RUN_TOKEN: sentinel, T29_SYNTHETIC_KEY: sentinel };
const commands = [];
function run(input, cwd = root) {
  const argv = resolveArgv(input);
  const result = spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  if (output.includes(sentinel)) throw new Error('Synthetic credential leaked in native production build output');
  process.stdout.write(output);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Native production build command failed (${result.status})`);
  commands.push({ argv: input, cwd, exit_code: result.status });
}
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(file)); else result.push(file);
  }
  return result;
}
const web = join(temporary, 'production-web'), wasm = join(temporary, 'release-wasm');
await mkdir(report, { recursive: true });
let child, closed;
try {
  const cargoPaths = ['--manifest-path', join(root, 'Cargo.toml'), '--target-dir', target];
  run(['cargo', 'build', '--release', '--offline', '--locked', ...cargoPaths, '-p', 'weblabel-api', '--bin', 'weblabel']);
  run(['cargo', 'build', '--release', '--offline', '--locked', ...cargoPaths, '--target', 'wasm32-unknown-unknown', '-p', 'wasm-bridge']);
  run(['wasm-bindgen', join(target, 'wasm32-unknown-unknown/release/wasm_bridge.wasm'), '--target', 'web', '--out-dir', wasm, '--out-name', 'wasm_bridge']);
  env.WEBLABEL_WASM_BRIDGE_DIR = wasm;
  run(['pnpm', 'exec', 'vite', 'build', '--sourcemap', '--outDir', web], join(root, 'apps/web'));
  const executable = join(target, 'release', process.platform === 'win32' ? 'weblabel.exe' : 'weblabel');
  const productFiles = [executable, ...await files(wasm), ...await files(web)];
  const evidence = [];
  for (const file of productFiles) {
    const bytes = await readFile(file);
    if (bytes.includes(Buffer.from(sentinel))) throw new Error('Synthetic credential leaked in native product artifact');
    evidence.push({ path: relative(root, file).replaceAll('\\', '/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const maps = productFiles.filter(file => file.endsWith('.map'));
  // Generated wasm-bindgen glue is scanned above but has no Vite sourcemap.
  // Require each actual compiled Vite chunk's declared map, not an old Host count.
  for (const file of productFiles.filter(file => file.startsWith(join(web, 'assets') + sep) && file.endsWith('.js'))) {
    const source = await readFile(file, 'utf8'); const map = /sourceMappingURL=([^\s]+)/.exec(source)?.[1];
    if (!map || !productFiles.includes(resolve(dirname(file), map))) throw new Error('Production JavaScript sourcemap missing');
  }
  const listener = createServer(); await new Promise(resolveListen => listener.listen(0, '127.0.0.1', resolveListen));
  const port = listener.address().port; await new Promise(resolveClose => listener.close(resolveClose));
  const data = join(temporary, 'data'); await mkdir(data);
  const base = `http://127.0.0.1:${port}`;
  const runtimeEnv = Object.fromEntries(['SystemRoot', 'SystemDrive', 'WINDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(runtimeEnv, { PATH: '', TEMP: temporary, TMP: temporary, TMPDIR: temporary, WEBLABEL_ENV: 'production', WEBLABEL_BIND: `127.0.0.1:${port}`, WEBLABEL_DATABASE_URL: `sqlite:${join(data, 'api.sqlite')}`, WEBLABEL_OBJECT_ROOT: join(data, 'objects'), WEBLABEL_COOKIE_SECURE: 'false', WEBLABEL_TEST_MANUAL_MODEL_WORKER: '1', OPENAI_API_KEY: sentinel, ANTHROPIC_API_KEY: sentinel, MIMO_API_KEY: sentinel });
  child = spawn(executable, ['serve-api'], { cwd: root, env: runtimeEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
  closed = new Promise(resolveClose => child.once('close', resolveClose));
  const deadline = Date.now() + 15000; let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Native release API exited before readiness');
    try { ready = (await fetch(base + '/health', { signal: AbortSignal.timeout(500) })).status === 204; if (ready) break; } catch {}
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
  }
  if (!ready) throw new Error('Native release API readiness failed');
  const privateRoute = await fetch(base + '/internal/test/jobs/drain', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}' });
  if (privateRoute.status !== 404) throw new Error('Native release exposed development drain route');
  const denied = await fetch(base + '/api/projects'); if (denied.status !== 401) throw new Error('Native release bypassed session gate');
  if (logs.includes(sentinel)) throw new Error('Synthetic credential leaked in native release logs');
  await writeFile(join(report, 'release-smoke.log'), logs.replace(/^WEBLABEL_BOOTSTRAP_CODE=.*$/gm, 'WEBLABEL_BOOTSTRAP_CODE=[REDACTED_SYNTHETIC_LAUNCH_CODE]'));
  await writeFile(join(report, 'production-scan.json'), JSON.stringify({ status: 'passed', identity, source_commit: identity.source_commit, scope: 'Actual optimized native Rust service, release WASM and Vite production JavaScript with its sourcemaps; no Node/Python product or live provider.', sentinel_sha256: createHash('sha256').update(sentinel).digest('hex'), commands, files: evidence, sourcemaps: maps.length, smoke: { health: 204, test_route: 404, unauthenticated_projects: 401, secret_in_logs: false, product_PATH: 'empty', model_calls: 0 } }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', product_files: evidence.length, model_calls: 0, report: relative(root, report) }));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await closed; }
  await rm(temporary, { recursive: true, force: true });
}
