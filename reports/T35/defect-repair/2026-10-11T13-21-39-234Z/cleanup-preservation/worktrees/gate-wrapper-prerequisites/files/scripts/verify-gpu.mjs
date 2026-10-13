import { spawn } from 'node:child_process';
import { mkdir, writeFile, appendFile, readFile, stat } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, createConnection } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ownedReportRoot, projectOutputPath } from '../tests/support/report-paths.mjs';
import { captureEvidenceIdentity } from './evidence-identity.mjs';
import { resolveArgv, runArgv } from './task.mjs';

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

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const relative = file => path.relative(root, file).replaceAll('\\', '/');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const settleWithin = (done, ms) => new Promise(resolve => {
  const timer = setTimeout(() => resolve(false), ms);
  done.then(() => { clearTimeout(timer); resolve(true); });
});
const portClosed = port => new Promise((resolve, reject) => {
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(false); });
  socket.once('error', error => { socket.destroy(); if (error.code === 'ECONNREFUSED') resolve(true); else reject(error); });
  socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Owned Vite port close observation timed out')); });
});
class Prerequisite extends Error {}
export function parseGpuArgs(args) {
  if (!args.length) return null;
  if (args.length !== 2 || args[0] !== '--report-dir' || !args[1] || args[1].startsWith('--') || path.isAbsolute(args[1])) throw new Error('INVALID_ARGUMENTS');
  return args[1];
}
export function parseBrowserReport(text) {
  if (text === null) return { tests: null, parse_status: 'missing', status: 'blocked', blocker: 'Current Playwright JSON is missing' };
  try {
    const report = JSON.parse(text), stats = report.stats;
    const names = ['expected', 'unexpected', 'skipped', 'flaky'];
    if (!stats || names.some(key => !Number.isSafeInteger(stats[key]) || stats[key] < 0) || !Array.isArray(report.suites)) throw new Error('Invalid native Playwright stats/suites');
    const cases = [];
    function visit(suite) {
      if ((suite.specs !== undefined && !Array.isArray(suite.specs)) || (suite.suites !== undefined && !Array.isArray(suite.suites))) throw new Error('Invalid native Playwright suite');
      for (const spec of suite.specs ?? []) {
        if (!Array.isArray(spec.tests)) throw new Error('Invalid native Playwright tests');
        for (const test of spec.tests) cases.push({ title: spec.title, status: test.status });
      }
      (suite.suites ?? []).forEach(visit);
    }
    report.suites.forEach(visit);
    const tests = { collected: names.reduce((n, key) => n + stats[key], 0), passed: stats.expected, failed: stats.unexpected, skipped: stats.skipped, flaky: stats.flaky };
    if (cases.length !== tests.collected || names.some(name => cases.filter(test => test.status === name).length !== stats[name])) throw new Error('Playwright stats do not match native test cases');
    const required = [2000, 10000].map(count => count + ' fixed release WASM hardware: four warmed 1000-sample scenarios and lifecycle');
    required.push('software and unknown adapters cannot pass the hardware classifier (not hardware evidence)');
    if (report.errors !== undefined && (!Array.isArray(report.errors) || report.errors.length)) return { tests, parse_status: 'parsed', status: 'failed', blocker: 'Playwright reported global errors' };
    const passed = tests.collected === 3 && tests.passed === 3 && !tests.failed && !tests.skipped && !tests.flaky && required.every(title => cases.filter(test => test.title === title).length === 1);
    return { tests, parse_status: 'parsed', status: passed ? 'passed' : 'failed', blocker: passed ? null : 'Require exactly the three T31 tests, all passed without skips/retries' };
  } catch (error) { return { tests: null, parse_status: 'malformed', status: 'failed', blocker: error.message }; }
}
function safeEnvironment(runtime, target) {
  const env = {};
  for (const key of ['PATH','PATHEXT','SystemRoot','WINDIR','COMSPEC','USERPROFILE','HOME','APPDATA','LOCALAPPDATA','PNPM_HOME','COREPACK_HOME','CARGO_HOME','RUSTUP_HOME','RUSTUP_TOOLCHAIN','RUSTC','RUSTDOC','VCINSTALLDIR','WindowsSdkDir','INCLUDE','LIB','LIBPATH']) if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, { TEMP: runtime, TMP: runtime, TMPDIR: runtime, CARGO_TARGET_DIR: target, CARGO_NET_OFFLINE: 'true', RUSTUP_AUTO_INSTALL: '0', COREPACK_ENABLE_NETWORK: '0', WEBLABEL_SKIP_SECURITY: '1' });
  return env;
}
function executable(name, env) {
  if (path.isAbsolute(name)) { if (fs.existsSync(name)) return name; throw new Prerequisite('Installed executable missing: ' + name); }
  const extensions = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const directory of (env.PATH ?? '').split(path.delimiter)) for (const extension of ['', ...extensions]) {
    const candidate = path.join(directory, name + extension.toLowerCase());
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Prerequisite('Installed executable unavailable: ' + name);
}
async function optionalText(file) {
  try { return await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function main(args = process.argv.slice(2)) {
  let report;
  try {
    const requested = parseGpuArgs(args);
    report = ownedReportRoot(requested ?? ('reports/T31/verification/' + new Date().toISOString().replaceAll(':','-') + '-' + randomUUID()));
    if (fs.existsSync(path.join(report, 'result.json'))) throw new Error('EXISTING_RESULT_REFUSED');
  } catch (error) { console.error(error.message); return 1; }
  const run = path.join(report, 'runs', randomUUID());
  const runtime = path.join(run, 'runtime');
  await mkdir(runtime, { recursive: true });
  const configRoot = path.join(root, 'reports/T31');
  const commands = [], blockers = [], evidence_refs = [];
  let status = 'blocked', before = null, after = null, environment = null, browser = { tests: null, parse_status: 'not_started' }, service = null, serviceDone = null, serviceRecord = null;
  let interrupted = false;
  const onSignal = () => { interrupted = true; };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  let env;
  async function reference(file) {
    const bytes = await readFile(file);
    const ref = { path: relative(file), sha256: sha(bytes), bytes: bytes.length };
    evidence_refs.push(ref); return ref;
  }
  async function execute(name, input, cwd = root, cleanup = false) {
    if (interrupted && !cleanup) throw new Prerequisite('Cancelled before ' + name);
    const argv = resolveArgv(input);
    argv[0] = executable(argv[0], env);
    const log = path.join(run, name + '.log');
    await writeFile(log, JSON.stringify({ argv, cwd }) + '\n');
    let writes = Promise.resolve();
    const tee = chunk => { writes = writes.then(() => appendFile(log, chunk)); };
    const record = { argv, cwd, exit_code: null, signal: null, signal_observation: 'not_spawned_or_close_unobserved', runner_exit_code: null, log_path: relative(log), tests: null, parse_status: 'non_test' };
    commands.push(record);
    try { record.runner_exit_code = await runArgv(argv, cwd, { env, onStdout: tee, onStderr: tee, onClose: (exitCode, signal) => { record.exit_code = exitCode; record.signal = signal; record.signal_observation = 'native_close'; } }); }
    finally { await writes; await reference(log); }
    if (record.runner_exit_code !== 0) {
      const output = await readFile(log,'utf8');
      if (['cargo-version','bindgen-version','release-wasm','release-bindgen','api','host'].includes(name) && /no matching package named|attempting to make an HTTP request|failed to download|target may not be installed|toolchain[^\n]*not installed|Cannot find (?:module|package)/i.test(output)) throw new Prerequisite(name + ' missing installed/offline prerequisite; see ' + relative(log));
      throw new Error(name + ' exited ' + record.runner_exit_code + ' (native exit=' + record.exit_code + ', signal=' + record.signal + ')');
    }
    return record;
  }
  try {
    env = safeEnvironment(runtime, projectOutputPath(process.env.CARGO_TARGET_DIR ?? path.join(root,'target/build-cache/defect-repair/gpu',path.basename(run))));
    before = captureEvidenceIdentity({ env });
    await writeFile(path.join(run, 'source-before.json'), JSON.stringify(before, null, 2));
    const supplied = process.env.CARGO_TARGET_DIR;
    const target = projectOutputPath(supplied ?? path.join(root, 'target/build-cache/defect-repair/gpu', path.basename(run)));
    const buildTarget = path.join(target, 't31-' + path.basename(run));
    env = safeEnvironment(runtime, buildTarget);
    const cargoCwd = process.env.WEBLABEL_CARGO_CWD ? fs.realpathSync(process.env.WEBLABEL_CARGO_CWD) : root;
    const cargo = executable('cargo', env), bindgen = executable('wasm-bindgen', env);
    resolveArgv(['pnpm','exec','playwright','--version']);
    const require = createRequire(path.join(root, 'apps/web/package.json'));
    for (const dependency of ['@playwright/test','vite','sharp']) { try { require.resolve(dependency); } catch { throw new Prerequisite('Installed dependency missing: ' + dependency); } }
    environment = { os: { platform: os.platform(), release: os.release(), version: os.version(), arch: os.arch() }, cpu: os.cpus()[0]?.model ?? 'unknown', driver: 'unknown', browser: 'unknown', gpu: 'unknown', dpr: 'unknown', seed: 17, target_dimensions: [2048,2048], wasm_profile: 'release', credential_environment: 'not_forwarded', account_state: 'not_inspected' };
    if (process.platform === 'win32') {
      await execute('driver', ['powershell.exe','-NoProfile','-Command','Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,AdapterCompatibility | ConvertTo-Json -Compress']);
      const raw = await readFile(path.join(run, 'driver.log'), 'utf8');
      try { environment.driver = JSON.parse(raw.slice(raw.indexOf('\n') + 1)); } catch (error) { environment.driver_error = error.message; }
    }
    await writeFile(path.join(run, 'environment.json'), JSON.stringify(environment, null, 2));
    await execute('cargo-version', [cargo,'--version'], cargoCwd);
    await execute('bindgen-version', [bindgen,'--version'], cargoCwd);
    await execute('release-wasm', [cargo,'build','--locked','--offline','--release','--manifest-path',path.join(root,'Cargo.toml'),'--target-dir',buildTarget,'-p','wasm-bridge','--target','wasm32-unknown-unknown'], cargoCwd);
    const wasmOutput = path.join(runtime, 'wasm');
    await execute('release-bindgen', [bindgen,path.join(buildTarget,'wasm32-unknown-unknown/release/wasm_bridge.wasm'),'--target','web','--out-dir',wasmOutput,'--out-name','wasm_bridge'], cargoCwd);
    const wasmFile = path.join(wasmOutput, 'wasm_bridge_bg.wasm');
    environment.wasm = { ...(await reference(wasmFile)), bytes: (await stat(wasmFile)).size };
    env.WEBLABEL_WASM_BRIDGE_DIR = wasmOutput;
    await writeFile(path.join(run, 'environment.json'), JSON.stringify(environment,null,2));
    await execute('api', [cargo,'build','--locked','--offline','--manifest-path',path.join(root,'Cargo.toml'),'--target-dir',buildTarget,'-p','weblabel-api','--bin','weblabel-api'], cargoCwd);
    env.WEBLABEL_API_BINARY = path.join(buildTarget,'debug',process.platform === 'win32' ? 'weblabel-api.exe' : 'weblabel-api');
    environment.api = await reference(env.WEBLABEL_API_BINARY);
    const host = path.join(runtime,'agent-host');
    await execute('host', [process.execPath,path.join(root,'scripts/build-agent-host.mjs'),'--out-dir',host]);
    env.WEBLABEL_T30_HOST_SCRIPT = path.join(host,'runtime.mjs');
    environment.host = await reference(env.WEBLABEL_T30_HOST_SCRIPT);
    await writeFile(path.join(run,'environment.json'),JSON.stringify(environment,null,2));
    const reserve = createServer();
    await new Promise((resolve,reject) => { reserve.once('error',reject); reserve.listen(0,'127.0.0.1',resolve); });
    const port = reserve.address().port;
    await new Promise(resolve => reserve.close(resolve));
    env.WEBLABEL_T31_ORIGIN = 'http://127.0.0.1:' + port;
    env.WEBLABEL_T31_RUN_DIR = run;
    const viteConfig = path.join(runtime,'vite.config.mjs');
    await writeFile(viteConfig, 'import config from ' + JSON.stringify(path.join(configRoot,'vite.config.ts').replaceAll('\\','/')) + ';\nexport default {...config, cacheDir:' + JSON.stringify(path.join(runtime,'vite-cache')) + '};\n');
    const argv = [process.execPath,path.join(root,'scripts/owned-vite-service.mjs'),require.resolve('vite'),viteConfig,path.join(root,'apps/web'),String(port)];
    const log = path.join(run,'vite.log');
    await writeFile(log, JSON.stringify({argv,cwd:root}) + '\n');
    let writes = Promise.resolve();
    serviceRecord = { argv,cwd:root,exit_code:null,signal:null,signal_observation:'close_unobserved',log_path:relative(log),tests:null,parse_status:'non_test',service:true,port,cleanup:null };
    commands.push(serviceRecord);
    service = spawn(argv[0],argv.slice(1),{cwd:root,env,shell:false,windowsHide:true,detached:process.platform !== 'win32',stdio:['pipe','pipe','pipe']});
    service.stdin.on('error',error => { serviceRecord.stdin_error=error.message; });
    let spawnError = null;
    service.once('error',error => { spawnError = error; });
    for (const stream of [service.stdout,service.stderr]) stream.on('data',chunk => { process.stdout.write(chunk); writes = writes.then(() => appendFile(log,chunk)); });
    serviceDone = new Promise(resolve => service.once('close',(code,signal) => { serviceRecord.exit_code=code; serviceRecord.signal=signal; serviceRecord.signal_observation='native_close'; resolve(); })).then(async () => { await writes; await reference(log); });
    const deadline = Date.now()+30000;
    while (true) {
      if (interrupted) throw new Prerequisite('Cancelled during readiness');
      if (spawnError) throw spawnError;
      if (service.exitCode !== null) throw new Error('Vite exited before readiness: '+service.exitCode);
      try { if ((await fetch(env.WEBLABEL_T31_ORIGIN,{signal:AbortSignal.timeout(1000)})).ok) break; } catch {}
      if (Date.now()>deadline) throw new Error('Vite readiness timed out');
      await pause(100);
    }
    status='failed';
    await execute('hardware',['pnpm','exec','playwright','test','--config='+path.join(configRoot,'playwright.config.ts'),'--project=target-hardware']);
    status='passed';
  } catch (error) {
    if (!(error instanceof Prerequisite) && error.code !== 'ENOENT') status='failed';
    blockers.push(error.message);
  } finally {
    if (serviceDone) {
      const unexpectedExit = service.exitCode !== null || service.signalCode !== null;
      if (unexpectedExit) { status='failed'; blockers.push('Owned Vite exited before cleanup'); }
      serviceRecord.cleanup = { requested: !unexpectedExit, unexpected_exit_before_cleanup: unexpectedExit, backstop: null };
      if (!unexpectedExit) {
        serviceRecord.cleanup.method='owned_stdin_eof';
        service.stdin.end();
        const settled = await settleWithin(serviceDone,5000);
        if (!settled) {
          status='failed'; blockers.push('Owned Vite failed bounded cleanup; forced backstop required');
          serviceRecord.cleanup.backstop='forced_owned_tree';
          if (process.platform === 'win32') { try { await execute('vite-backstop',['taskkill.exe','/PID',String(service.pid),'/T','/F'],root,true); } catch(error) { blockers.push(error.message); } }
          else { try { process.kill(-service.pid,'SIGKILL'); } catch(error) { blockers.push(error.message); } }
        }
      }
      const closed = await settleWithin(serviceDone,5000);
      serviceRecord.cleanup.close_observed=closed;
      if (!closed) { status='failed'; blockers.push('Owned Vite native close unobserved after forced backstop'); }
      else if (serviceRecord.exit_code !== 0 || serviceRecord.signal !== null || serviceRecord.stdin_error) { status='failed'; blockers.push('Owned Vite cleanup did not close normally: exit='+serviceRecord.exit_code+', signal='+serviceRecord.signal+(serviceRecord.stdin_error ? ', stdin='+serviceRecord.stdin_error : '')); }
      try {
        serviceRecord.cleanup.port_closed=await portClosed(serviceRecord.port);
        if (!serviceRecord.cleanup.port_closed) { status='failed'; blockers.push('Owned Vite listener remained open after cleanup'); }
      } catch (error) { status='failed'; blockers.push(error.message); }
    }
    try {
      browser = parseBrowserReport(await optionalText(path.join(run,'browser-results.json')));
      const command = commands.find(command => command.log_path.endsWith('/hardware.log'));
      if (command) { command.tests=browser.tests; command.parse_status=browser.parse_status; }
      if (browser.status==='failed') { status='failed'; blockers.push(browser.blocker); }
      else if (browser.status==='blocked' && status!=='failed') { status='blocked'; blockers.push(browser.blocker); }
      if (browser.parse_status==='parsed') await reference(path.join(run,'browser-results.json'));
      for (const count of [2000,10000]) {
        const file=path.join(run,'samples-'+count+'.json'), text=await optionalText(file);
        if (text===null) { if(status!=='failed') status='blocked'; blockers.push('Missing current raw samples: '+count); continue; }
        await reference(file);
        const sample=JSON.parse(text);
        if (browser.status !== 'passed') continue; // Partial failure samples stay preserved, never promoted.
        if(sample.count!==count || sample.seed!==17 || sample.warmup_per_scenario!==40 || sample.sample_count_per_scenario!==1000 || JSON.stringify(sample.canonical_dimensions)!=='[2048,2048]') throw new Error('Invalid fixed workload metadata: '+count);
        if(!Array.isArray(sample.adapters) || !sample.adapters.length || hardwareKind(sample.adapters.at(-1))!=='hardware') throw new Prerequisite('No actual non-software adapter proof: '+count);
        if(JSON.stringify(sample.loaded_wasm_sha256)!==JSON.stringify([environment?.wasm?.sha256])) throw new Error('Actual loaded WASM hash mismatch: '+count);
        const performance=gate(count,sample.scenarios);
        for(const rows of Object.values(sample.scenarios)) if(rows.length!==1000 || rows.some(row=>row.native_submissions!==1)) throw new Error('Invalid actual native submissions: '+count);
        if(performance.failures.length) throw new Error(performance.failures.join('; '));
      }
      const environmentText=await optionalText(path.join(run,'environment.json'));
      if(environmentText!==null) { environment=JSON.parse(environmentText); await reference(path.join(run,'environment.json')); }
      if(status==='passed' && (!environment?.browser?.version || environment.driver==='unknown' || !Number.isFinite(environment.dpr))) throw new Prerequisite('Actual browser/driver/DPR provenance unavailable');
      after=captureEvidenceIdentity({ env: env ?? safeEnvironment(runtime, runtime) });
      if(before && ['source_snapshot_sha256','manifest_sha256','runner_sha256'].some(key=>before[key]!==after[key])) throw new Prerequisite('Source changed during GPU collection; current evidence not certifiable');
    } catch(error) { if(error instanceof Prerequisite || error.code === 'ENOENT') { if(status!=='failed') status='blocked'; } else status='failed'; blockers.push(error.message); }
    if (!after) { try { after=captureEvidenceIdentity({ env: env ?? safeEnvironment(runtime, runtime) }); } catch(error) { if(status!=='failed') status='blocked'; blockers.push('Final identity unavailable: '+error.message); } }
    if(before && after && ['source_snapshot_sha256','manifest_sha256','runner_sha256'].some(key=>before[key]!==after[key])) { if(status!=='failed') status='blocked'; if(!blockers.includes('Source changed during GPU collection; current evidence not certifiable')) blockers.push('Source changed during GPU collection; current evidence not certifiable'); }
    if(interrupted) { if(status!=='failed') status='blocked'; blockers.push('Cancelled; hardware gate not certified'); }
    process.removeListener('SIGINT',onSignal); process.removeListener('SIGTERM',onSignal);
    const result={schema_version:1,task_id:'T31',gate:'gpu',status,base_commit:before?.source_commit??null,source_hashes:before?.source_hashes??null,manifest_sha256:before?.manifest_sha256??null,identity:before,identity_after:after,time:{finished_at:new Date().toISOString()},run_dir:relative(run),environment,commands,tests:browser.tests,parse_status:browser.parse_status,evidence_refs,blockers,skipped_scope:['security'],thresholds:{boxes:2000,cpu_p95_ms:8,pointer_double_raf_proxy_p95_ms:33},workload:{counts:[2000,10000],seed:17,warmup_per_scenario:40,sample_count_per_scenario:1000,scenarios:['pointer_drag','pan','zoom','committed_edit']},baseline_debug:{status:'not_verified',available:false,certified_hardware_gate:false,reason:'No current-source debug baseline collected; historical T28 reports are not current proof'},known_limits:['double-rAF scheduling proxy, not physical photon latency','CPU includes measurement instrumentation','Logical texture bytes are not physical VRAM','GPU timestamps not measured']};
    await writeFile(path.join(run,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});
    await writeFile(path.join(report,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});
    console.log(JSON.stringify({status,tests:result.tests,run:result.run_dir,blockers},null,2));
  }
  return status==='passed'?0:status==='blocked'?2:1;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) process.exitCode=await main();
