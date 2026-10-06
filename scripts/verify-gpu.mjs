import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, appendFile, readFile, stat } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function hardwareKind(info) {
  const text = JSON.stringify(info);
  if (/swiftshader|llvmpipe|lavapipe|software|basic render|device_type.?=.?Cpu/i.test(text) || info?.isFallbackAdapter === true) return 'software';
  if (/nvidia|intel|amd|apple|blackwell|DiscreteGpu|IntegratedGpu/i.test(text)) return 'hardware';
  return 'unknown';
}
export function summarize(samples) {
  if (!Array.isArray(samples) || samples.length < 1000 || samples.some(row => !Number.isFinite(row.cpu_ms) || row.cpu_ms < 0 || !Number.isFinite(row.double_raf_ms) || row.double_raf_ms < 0 || row.submissions !== 1)) throw new Error('Invalid workload: require >=1000 finite samples, each with one actual GPU submission; no filtering');
  const p95 = key => samples.map(row => row[key]).sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1];
  return { valid_samples: samples.length, cpu_p95_ms: p95('cpu_ms'), double_raf_p95_ms: p95('double_raf_ms') };
}
export function gate(count, scenarios) {
  const summaries = Object.fromEntries(['pointer_drag', 'pan', 'zoom', 'committed_edit'].map(name => [name, summarize(scenarios[name])]));
  const failures = count === 2000 ? Object.entries(summaries).flatMap(([name, row]) => [row.cpu_p95_ms > 8 ? `${name}: CPU P95 ${row.cpu_p95_ms} > 8ms` : null, row.double_raf_p95_ms > 33 ? `${name}: double-rAF proxy P95 ${row.double_raf_p95_ms} > 33ms` : null].filter(Boolean)) : [];
  return { summaries, failures };
}

async function main() {
  const report = path.join(root, 'reports/T31');
  const run = path.join(report, 'runs', new Date().toISOString().replaceAll(':', '-'));
  await mkdir(run, { recursive: true });
  const commands = [];
  const env = { ...process.env, WEBLABEL_T31_RUN_DIR: run };
  const target = path.join(root, 'target/t31');
  const win = process.platform === 'win32';
  const neutral = win ? 'D:/cache/cargo/bin' : root;
  const cargo = win ? path.join(neutral, 'bin/cargo.exe') : 'cargo';
  const rustc = win ? 'D:/cache/cargo/toolchains/1.96.0-x86_64-pc-windows-msvc/bin/rustc.exe' : 'rustc';
  Object.assign(env, { RUSTUP_TOOLCHAIN: '1.96.0', RUSTC: rustc, CARGO_TARGET_DIR: target });
  if (win) Object.assign(env, { CARGO_HOME: neutral, RUSTUP_HOME: 'D:/cache/cargo' });
  env.WEBLABEL_API_BINARY = path.join(target, 'debug', win ? 'weblabel-api.exe' : 'weblabel-api');
  const pnpm = win ? path.join(process.env.APPDATA ?? '', 'npm/node_modules/pnpm/bin/pnpm.cjs') : null;
  let service;
  let serviceClosed;
  let serviceCommand;
  let status = 'blocked';
  let blocker = null;
  let source;
  async function execute(name, argv, cwd = root) {
    const log = path.join(run, `${name}.log`);
    await writeFile(log, JSON.stringify({ argv, cwd }) + '\n');
    const child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let writes = Promise.resolve();
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { process.stdout.write(chunk); writes = writes.then(() => appendFile(log, chunk)); });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 1)); });
    await writes;
    await appendFile(log, `\nEXIT_CODE=${code}\n`);
    commands.push({ argv, cwd, exit_code: code, tests: null, log_path: path.relative(root, log).replaceAll('\\', '/') });
    if (code !== 0) throw new Error(`${name} exited ${code}; see ${log}`);
  }
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const files = execFileSync('git', ['ls-files', 'apps/web/src', 'crates', 'Cargo.toml', 'Cargo.lock', 'scripts/verify-gpu.mjs', 'tests/perf/t31_hardware.spec.ts'], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/);
    const sourceFiles = [...new Set([...files.filter(Boolean), 'scripts/verify-gpu.mjs', 'tests/perf/t31_hardware.spec.ts', 'reports/T31/playwright.config.ts'])];
    source = { commit, files: Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])) };
    await writeFile(path.join(run, 'source.json'), JSON.stringify(source, null, 2));
    let driver = 'unknown';
    if (win) {
      try { driver = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,AdapterCompatibility | ConvertTo-Json -Compress'], { encoding: 'utf8', timeout: 20_000 })); } catch { /* Unreadable hardware fields remain unknown. */ }
    }
    const environment = { os: { platform: os.platform(), release: os.release(), version: os.version(), arch: os.arch() }, cpu: os.cpus()[0]?.model ?? 'unknown', driver, source_commit: commit, rust: '1.96.0', wgpu: '30.0.1', wasm_profile: 'release', browser: 'unknown', gpu: 'unknown', dpr: 'unknown', target_dimensions: [2048, 2048], seed: 17 };
    await writeFile(path.join(run, 'environment.json'), JSON.stringify(environment, null, 2));
    // Build from the checked-out source, never consume the historical debug bridge.
    await execute('release-wasm', [cargo, 'build', '--locked', '--release', '--manifest-path', path.join(root, 'Cargo.toml'), '--target-dir', target, '-p', 'wasm-bridge', '--target', 'wasm32-unknown-unknown'], neutral);
    const wasm = path.join(target, 'wasm32-unknown-unknown/release/wasm_bridge.wasm');
    const output = path.join(root, 'crates/wasm-bridge/target/weblabel-web-public/wasm');
    await execute('release-bindgen', [win ? path.join(neutral, 'bin/wasm-bindgen.exe') : 'wasm-bindgen', wasm, '--target', 'web', '--out-dir', output, '--out-name', 'wasm_bridge'], neutral);
    const outputWasm = path.join(output, 'wasm_bridge_bg.wasm');
    environment.wasm = { path: path.relative(root, outputWasm), sha256: createHash('sha256').update(await readFile(outputWasm)).digest('hex'), bytes: (await stat(outputWasm)).size };
    await writeFile(path.join(run, 'environment.json'), JSON.stringify(environment, null, 2));
    await execute('api', [cargo, 'build', '--locked', '--manifest-path', path.join(root, 'Cargo.toml'), '--target-dir', target, '-p', 'weblabel-api', '--bin', 'weblabel-api'], neutral);
    const reserve = createServer();
    await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
    const port = reserve.address().port;
    await new Promise(resolve => reserve.close(resolve));
    env.WEBLABEL_T31_ORIGIN = `http://127.0.0.1:${port}`;
    const viteArgs = ['--filter', '@weblabel/web', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--mode', 'test'];
    const argv = win ? [process.execPath, pnpm, ...viteArgs] : ['pnpm', ...viteArgs];
    const serviceLog = fs.openSync(path.join(run, 'vite.log'), 'w');
    service = spawn(argv[0], argv.slice(1), { cwd: root, env, shell: false, windowsHide: true, stdio: ['ignore', serviceLog, serviceLog] });
    serviceCommand = { argv, cwd: root, exit_code: null, tests: null, service: true, log_path: path.relative(root, path.join(run, 'vite.log')).replaceAll('\\', '/') };
    commands.push(serviceCommand);
    serviceClosed = new Promise(resolve => service.once('close', code => resolve(code)));
    fs.closeSync(serviceLog);
    let serviceError;
    service.once('error', error => { serviceError = error; });
    const deadline = Date.now() + 30_000;
    while (true) {
      if (serviceError) throw serviceError;
      if (service.exitCode !== null) throw new Error(`Vite exited ${service.exitCode}`);
      try { if ((await fetch(env.WEBLABEL_T31_ORIGIN)).ok) break; } catch { /* Bounded readiness, not a test retry. */ }
      if (Date.now() >= deadline) throw new Error('Vite readiness timed out');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    status = 'failed';
    const testArgs = ['exec', 'playwright', 'test', '--config=reports/T31/playwright.config.ts', '--project=target-hardware'];
    await execute('hardware', win ? [process.execPath, pnpm, ...testArgs] : ['pnpm', ...testArgs]);
    status = 'passed';
  } catch (error) {
    blocker = error.message;
    console.error(blocker);
  } finally {
    if (service?.pid) {
      if (win) { try { execFileSync('taskkill.exe', ['/PID', String(service.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* Already exited. */ } }
      else if (service.exitCode === null) service.kill('SIGTERM');
      serviceCommand.exit_code = await serviceClosed;
    }
    let browserResults;
    try { browserResults = JSON.parse(await readFile(path.join(run, 'browser-results.json'), 'utf8')); } catch { /* Build/launch failure has zero exercised tests. */ }
    const tests = browserResults ? { passed: browserResults.stats.expected, failed: browserResults.stats.unexpected, skipped: browserResults.stats.skipped, flaky: browserResults.stats.flaky } : { passed: 0, failed: 0, skipped: 0, flaky: 0 };
    if (status === 'passed' && (tests.passed !== 3 || tests.failed || tests.skipped || tests.flaky)) { status = 'failed'; blocker = 'Require exactly three hardware tests without skips/retries'; }
    const hardwareCommand = commands.find(command => command.log_path.endsWith('/hardware.log'));
    if (hardwareCommand) hardwareCommand.tests = tests;
    const samples = {};
    for (const count of [2000, 10000]) { try { samples[count] = JSON.parse(await readFile(path.join(run, `samples-${count}.json`), 'utf8')); } catch { /* Never fabricate missing samples. */ } }
    const baseline = JSON.parse(await readFile(path.join(root, 'reports/T28/main-final-metrics.json'), 'utf8'));
    await writeFile(path.join(run, 'baseline-debug-T28.json'), JSON.stringify(baseline, null, 2));
    const result = { task_id: 'T31', status, base_commit: source?.commit ?? 'unknown', run_dir: path.relative(root, run).replaceAll('\\', '/'), commands, tests, blocker, thresholds: { boxes: 2000, cpu_p95_ms: 8, pointer_double_raf_proxy_p95_ms: 33 }, baseline_debug: { path: 'reports/T28/main-final-metrics.json', committed_edit_p95_ms: { 2000: 28.3, 10000: 110.8 }, certified_hardware_gate: false }, known_limits: ['double-rAF scheduling proxy, not physical photon latency', 'CPU = conservative max of CDP main-thread TaskDuration and synchronous+rAF; includes measurement instrumentation', 'Logical texture bytes are application estimates, not physical VRAM', 'GPU timestamps not measured: renderer does not expose timestamp query results'] };
    await writeFile(path.join(run, 'result.json'), JSON.stringify(result, null, 2));
    await writeFile(path.join(report, 'result.json'), JSON.stringify(result, null, 2));
    await writeFile(path.join(report, 'samples.json'), JSON.stringify({ run: result.run_dir, samples }, null, 2));
    await writeFile(path.join(report, 'environment.json'), await readFile(path.join(run, 'environment.json')).catch(() => Buffer.from('{"unavailable":true}')));
    await appendFile(path.join(report, 'tests.log'), JSON.stringify(result) + '\n');
    console.log(JSON.stringify({ status, tests, run: result.run_dir, blocker }, null, 2));
    process.exitCode = status === 'passed' ? 0 : status === 'blocked' ? 2 : 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
