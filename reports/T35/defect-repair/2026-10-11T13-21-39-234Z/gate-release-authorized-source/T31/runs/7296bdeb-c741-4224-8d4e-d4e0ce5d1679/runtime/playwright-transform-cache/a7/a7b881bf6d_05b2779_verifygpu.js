// dfa84eac1f8154baba61b255ba5e00a1774315a4
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
  return {
    valid_samples: samples.length,
    cpu_p95_ms: p95('cpu_ms'),
    double_raf_p95_ms: p95('double_raf_ms')
  };
}
export function gate(count, scenarios) {
  const summaries = Object.fromEntries(['pointer_drag', 'pan', 'zoom', 'committed_edit'].map(name => [name, summarize(scenarios[name])]));
  const failures = count === 2000 ? Object.entries(summaries).flatMap(([name, row]) => [row.cpu_p95_ms > 8 ? `${name}: CPU P95 ${row.cpu_p95_ms} > 8ms` : null, row.double_raf_p95_ms > 33 ? `${name}: double-rAF proxy P95 ${row.double_raf_p95_ms} > 33ms` : null].filter(Boolean)) : [];
  return {
    summaries,
    failures
  };
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const relative = file => path.relative(root, file).replaceAll('\\', '/');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const settleWithin = (done, ms) => new Promise(resolve => {
  const timer = setTimeout(() => resolve(false), ms);
  done.then(() => {
    clearTimeout(timer);
    resolve(true);
  });
});
const portClosed = port => new Promise((resolve, reject) => {
  const socket = createConnection({
    host: '127.0.0.1',
    port
  });
  socket.once('connect', () => {
    socket.destroy();
    resolve(false);
  });
  socket.once('error', error => {
    socket.destroy();
    if (error.code === 'ECONNREFUSED') resolve(true);else reject(error);
  });
  socket.setTimeout(1000, () => {
    socket.destroy();
    reject(new Error('Owned Vite port close observation timed out'));
  });
});
class Prerequisite extends Error {}
export function parseGpuArgs(args) {
  if (!args.length) return null;
  if (args.length !== 2 || args[0] !== '--report-dir' || !args[1] || args[1].startsWith('--') || path.isAbsolute(args[1])) throw new Error('INVALID_ARGUMENTS');
  return args[1];
}
export function parseBrowserReport(text) {
  if (text === null) return {
    tests: null,
    parse_status: 'missing',
    status: 'blocked',
    blocker: 'Current Playwright JSON is missing'
  };
  try {
    const report = JSON.parse(text),
      stats = report.stats;
    const names = ['expected', 'unexpected', 'skipped', 'flaky'];
    if (!stats || names.some(key => !Number.isSafeInteger(stats[key]) || stats[key] < 0) || !Array.isArray(report.suites)) throw new Error('Invalid native Playwright stats/suites');
    const cases = [];
    function visit(suite) {
      if (suite.specs !== undefined && !Array.isArray(suite.specs) || suite.suites !== undefined && !Array.isArray(suite.suites)) throw new Error('Invalid native Playwright suite');
      for (const spec of suite.specs ?? []) {
        if (!Array.isArray(spec.tests)) throw new Error('Invalid native Playwright tests');
        for (const test of spec.tests) cases.push({
          title: spec.title,
          status: test.status
        });
      }
      (suite.suites ?? []).forEach(visit);
    }
    report.suites.forEach(visit);
    const tests = {
      collected: names.reduce((n, key) => n + stats[key], 0),
      passed: stats.expected,
      failed: stats.unexpected,
      skipped: stats.skipped,
      flaky: stats.flaky
    };
    if (cases.length !== tests.collected || names.some(name => cases.filter(test => test.status === name).length !== stats[name])) throw new Error('Playwright stats do not match native test cases');
    const required = [2000, 10000].map(count => count + ' fixed release WASM hardware: four warmed 1000-sample scenarios and lifecycle');
    required.push('software and unknown adapters cannot pass the hardware classifier (not hardware evidence)');
    if (report.errors !== undefined && (!Array.isArray(report.errors) || report.errors.length)) return {
      tests,
      parse_status: 'parsed',
      status: 'failed',
      blocker: 'Playwright reported global errors'
    };
    const passed = tests.collected === 3 && tests.passed === 3 && !tests.failed && !tests.skipped && !tests.flaky && required.every(title => cases.filter(test => test.title === title).length === 1);
    return {
      tests,
      parse_status: 'parsed',
      status: passed ? 'passed' : 'failed',
      blocker: passed ? null : 'Require exactly the three T31 tests, all passed without skips/retries'
    };
  } catch (error) {
    return {
      tests: null,
      parse_status: 'malformed',
      status: 'failed',
      blocker: error.message
    };
  }
}
function safeEnvironment(runtime, target) {
  const env = {};
  for (const key of ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PNPM_HOME', 'COREPACK_HOME', 'CARGO_HOME', 'RUSTUP_HOME', 'RUSTUP_TOOLCHAIN', 'RUSTC', 'RUSTDOC', 'VCINSTALLDIR', 'WindowsSdkDir', 'INCLUDE', 'LIB', 'LIBPATH']) if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, {
    TEMP: runtime,
    TMP: runtime,
    TMPDIR: runtime,
    CARGO_TARGET_DIR: target,
    CARGO_NET_OFFLINE: 'true',
    RUSTUP_AUTO_INSTALL: '0',
    COREPACK_ENABLE_NETWORK: '0',
    WEBLABEL_SKIP_SECURITY: '1'
  });
  return env;
}
function executable(name, env) {
  if (path.isAbsolute(name)) {
    if (fs.existsSync(name)) return name;
    throw new Prerequisite('Installed executable missing: ' + name);
  }
  const extensions = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const directory of (env.PATH ?? '').split(path.delimiter)) for (const extension of ['', ...extensions]) {
    const candidate = path.join(directory, name + extension.toLowerCase());
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Prerequisite('Installed executable unavailable: ' + name);
}
async function optionalText(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
export async function main(args = process.argv.slice(2)) {
  let report;
  try {
    const requested = parseGpuArgs(args);
    report = ownedReportRoot(requested ?? 'reports/T31/verification/' + new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID());
    if (fs.existsSync(path.join(report, 'result.json'))) throw new Error('EXISTING_RESULT_REFUSED');
  } catch (error) {
    console.error(error.message);
    return 1;
  }
  const run = path.join(report, 'runs', randomUUID());
  const runtime = path.join(run, 'runtime');
  await mkdir(runtime, {
    recursive: true
  });
  const configRoot = path.join(root, 'reports/T31');
  const commands = [],
    blockers = [],
    evidence_refs = [];
  let status = 'blocked',
    before = null,
    after = null,
    environment = null,
    browser = {
      tests: null,
      parse_status: 'not_started'
    },
    service = null,
    serviceDone = null,
    serviceRecord = null;
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  let env;
  async function reference(file) {
    const bytes = await readFile(file);
    const ref = {
      path: relative(file),
      sha256: sha(bytes),
      bytes: bytes.length
    };
    evidence_refs.push(ref);
    return ref;
  }
  async function execute(name, input, cwd = root, cleanup = false) {
    if (interrupted && !cleanup) throw new Prerequisite('Cancelled before ' + name);
    const argv = resolveArgv(input);
    argv[0] = executable(argv[0], env);
    const log = path.join(run, name + '.log');
    await writeFile(log, JSON.stringify({
      argv,
      cwd
    }) + '\n');
    let writes = Promise.resolve();
    const tee = chunk => {
      writes = writes.then(() => appendFile(log, chunk));
    };
    const record = {
      argv,
      cwd,
      exit_code: null,
      signal: null,
      signal_observation: 'not_spawned_or_close_unobserved',
      runner_exit_code: null,
      log_path: relative(log),
      tests: null,
      parse_status: 'non_test'
    };
    commands.push(record);
    try {
      record.runner_exit_code = await runArgv(argv, cwd, {
        env,
        onStdout: tee,
        onStderr: tee,
        onClose: (exitCode, signal) => {
          record.exit_code = exitCode;
          record.signal = signal;
          record.signal_observation = 'native_close';
        }
      });
    } finally {
      await writes;
      await reference(log);
    }
    if (record.runner_exit_code !== 0) {
      const output = await readFile(log, 'utf8');
      if (['cargo-version', 'bindgen-version', 'release-wasm', 'release-bindgen', 'api', 'host'].includes(name) && /no matching package named|attempting to make an HTTP request|failed to download|target may not be installed|toolchain[^\n]*not installed|Cannot find (?:module|package)/i.test(output)) throw new Prerequisite(name + ' missing installed/offline prerequisite; see ' + relative(log));
      throw new Error(name + ' exited ' + record.runner_exit_code + ' (native exit=' + record.exit_code + ', signal=' + record.signal + ')');
    }
    return record;
  }
  try {
    env = safeEnvironment(runtime, projectOutputPath(process.env.CARGO_TARGET_DIR ?? path.join(root, 'target/build-cache/defect-repair/gpu', path.basename(run))));
    before = captureEvidenceIdentity({
      env
    });
    await writeFile(path.join(run, 'source-before.json'), JSON.stringify(before, null, 2));
    const supplied = process.env.CARGO_TARGET_DIR;
    const target = projectOutputPath(supplied ?? path.join(root, 'target/build-cache/defect-repair/gpu', path.basename(run)));
    const buildTarget = path.join(target, 't31-' + path.basename(run));
    env = safeEnvironment(runtime, buildTarget);
    const cargoCwd = process.env.WEBLABEL_CARGO_CWD ? fs.realpathSync(process.env.WEBLABEL_CARGO_CWD) : root;
    const cargo = executable('cargo', env),
      bindgen = executable('wasm-bindgen', env);
    resolveArgv(['pnpm', 'exec', 'playwright', '--version']);
    const require = createRequire(path.join(root, 'apps/web/package.json'));
    for (const dependency of ['@playwright/test', 'vite', 'sharp']) {
      try {
        require.resolve(dependency);
      } catch {
        throw new Prerequisite('Installed dependency missing: ' + dependency);
      }
    }
    environment = {
      os: {
        platform: os.platform(),
        release: os.release(),
        version: os.version(),
        arch: os.arch()
      },
      cpu: os.cpus()[0]?.model ?? 'unknown',
      driver: 'unknown',
      browser: 'unknown',
      gpu: 'unknown',
      dpr: 'unknown',
      seed: 17,
      target_dimensions: [2048, 2048],
      wasm_profile: 'release',
      credential_environment: 'not_forwarded',
      account_state: 'not_inspected'
    };
    if (process.platform === 'win32') {
      await execute('driver', ['powershell.exe', '-NoProfile', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,AdapterCompatibility | ConvertTo-Json -Compress']);
      const raw = await readFile(path.join(run, 'driver.log'), 'utf8');
      try {
        environment.driver = JSON.parse(raw.slice(raw.indexOf('\n') + 1));
      } catch (error) {
        environment.driver_error = error.message;
      }
    }
    await writeFile(path.join(run, 'environment.json'), JSON.stringify(environment, null, 2));
    await execute('cargo-version', [cargo, '--version'], cargoCwd);
    await execute('bindgen-version', [bindgen, '--version'], cargoCwd);
    await execute('release-wasm', [cargo, 'build', '--locked', '--offline', '--release', '--manifest-path', path.join(root, 'Cargo.toml'), '--target-dir', buildTarget, '-p', 'wasm-bridge', '--target', 'wasm32-unknown-unknown'], cargoCwd);
    const wasmOutput = path.join(runtime, 'wasm');
    await execute('release-bindgen', [bindgen, path.join(buildTarget, 'wasm32-unknown-unknown/release/wasm_bridge.wasm'), '--target', 'web', '--out-dir', wasmOutput, '--out-name', 'wasm_bridge'], cargoCwd);
    const wasmFile = path.join(wasmOutput, 'wasm_bridge_bg.wasm');
    environment.wasm = {
      ...(await reference(wasmFile)),
      bytes: (await stat(wasmFile)).size
    };
    env.WEBLABEL_WASM_BRIDGE_DIR = wasmOutput;
    await writeFile(path.join(run, 'environment.json'), JSON.stringify(environment, null, 2));
    await execute('api', [cargo, 'build', '--locked', '--offline', '--manifest-path', path.join(root, 'Cargo.toml'), '--target-dir', buildTarget, '-p', 'weblabel-api', '--bin', 'weblabel-api'], cargoCwd);
    env.WEBLABEL_API_BINARY = path.join(buildTarget, 'debug', process.platform === 'win32' ? 'weblabel-api.exe' : 'weblabel-api');
    environment.api = await reference(env.WEBLABEL_API_BINARY);
    const host = path.join(runtime, 'agent-host');
    await execute('host', [process.execPath, path.join(root, 'scripts/build-agent-host.mjs'), '--out-dir', host]);
    env.WEBLABEL_T30_HOST_SCRIPT = path.join(host, 'runtime.mjs');
    environment.host = await reference(env.WEBLABEL_T30_HOST_SCRIPT);
    await writeFile(path.join(run, 'environment.json'), JSON.stringify(environment, null, 2));
    const reserve = createServer();
    await new Promise((resolve, reject) => {
      reserve.once('error', reject);
      reserve.listen(0, '127.0.0.1', resolve);
    });
    const port = reserve.address().port;
    await new Promise(resolve => reserve.close(resolve));
    env.WEBLABEL_T31_ORIGIN = 'http://127.0.0.1:' + port;
    env.WEBLABEL_T31_RUN_DIR = run;
    const viteConfig = path.join(runtime, 'vite.config.mjs');
    await writeFile(viteConfig, 'import config from ' + JSON.stringify(path.join(configRoot, 'vite.config.ts').replaceAll('\\', '/')) + ';\nexport default {...config, cacheDir:' + JSON.stringify(path.join(runtime, 'vite-cache')) + '};\n');
    const argv = [process.execPath, path.join(root, 'scripts/owned-vite-service.mjs'), require.resolve('vite'), viteConfig, path.join(root, 'apps/web'), String(port)];
    const log = path.join(run, 'vite.log');
    await writeFile(log, JSON.stringify({
      argv,
      cwd: root
    }) + '\n');
    let writes = Promise.resolve();
    serviceRecord = {
      argv,
      cwd: root,
      exit_code: null,
      signal: null,
      signal_observation: 'close_unobserved',
      log_path: relative(log),
      tests: null,
      parse_status: 'non_test',
      service: true,
      port,
      cleanup: null
    };
    commands.push(serviceRecord);
    service = spawn(argv[0], argv.slice(1), {
      cwd: root,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    service.stdin.on('error', error => {
      serviceRecord.stdin_error = error.message;
    });
    let spawnError = null;
    service.once('error', error => {
      spawnError = error;
    });
    for (const stream of [service.stdout, service.stderr]) stream.on('data', chunk => {
      process.stdout.write(chunk);
      writes = writes.then(() => appendFile(log, chunk));
    });
    serviceDone = new Promise(resolve => service.once('close', (code, signal) => {
      serviceRecord.exit_code = code;
      serviceRecord.signal = signal;
      serviceRecord.signal_observation = 'native_close';
      resolve();
    })).then(async () => {
      await writes;
      await reference(log);
    });
    const deadline = Date.now() + 30000;
    while (true) {
      if (interrupted) throw new Prerequisite('Cancelled during readiness');
      if (spawnError) throw spawnError;
      if (service.exitCode !== null) throw new Error('Vite exited before readiness: ' + service.exitCode);
      try {
        if ((await fetch(env.WEBLABEL_T31_ORIGIN, {
          signal: AbortSignal.timeout(1000)
        })).ok) break;
      } catch {}
      if (Date.now() > deadline) throw new Error('Vite readiness timed out');
      await pause(100);
    }
    status = 'failed';
    await execute('hardware', ['pnpm', 'exec', 'playwright', 'test', '--config=' + path.join(configRoot, 'playwright.config.ts'), '--project=target-hardware']);
    status = 'passed';
  } catch (error) {
    if (!(error instanceof Prerequisite) && error.code !== 'ENOENT') status = 'failed';
    blockers.push(error.message);
  } finally {
    if (serviceDone) {
      const unexpectedExit = service.exitCode !== null || service.signalCode !== null;
      if (unexpectedExit) {
        status = 'failed';
        blockers.push('Owned Vite exited before cleanup');
      }
      serviceRecord.cleanup = {
        requested: !unexpectedExit,
        unexpected_exit_before_cleanup: unexpectedExit,
        backstop: null
      };
      if (!unexpectedExit) {
        serviceRecord.cleanup.method = 'owned_stdin_eof';
        service.stdin.end();
        const settled = await settleWithin(serviceDone, 5000);
        if (!settled) {
          status = 'failed';
          blockers.push('Owned Vite failed bounded cleanup; forced backstop required');
          serviceRecord.cleanup.backstop = 'forced_owned_tree';
          if (process.platform === 'win32') {
            try {
              await execute('vite-backstop', ['taskkill.exe', '/PID', String(service.pid), '/T', '/F'], root, true);
            } catch (error) {
              blockers.push(error.message);
            }
          } else {
            try {
              process.kill(-service.pid, 'SIGKILL');
            } catch (error) {
              blockers.push(error.message);
            }
          }
        }
      }
      const closed = await settleWithin(serviceDone, 5000);
      serviceRecord.cleanup.close_observed = closed;
      if (!closed) {
        status = 'failed';
        blockers.push('Owned Vite native close unobserved after forced backstop');
      } else if (serviceRecord.exit_code !== 0 || serviceRecord.signal !== null || serviceRecord.stdin_error) {
        status = 'failed';
        blockers.push('Owned Vite cleanup did not close normally: exit=' + serviceRecord.exit_code + ', signal=' + serviceRecord.signal + (serviceRecord.stdin_error ? ', stdin=' + serviceRecord.stdin_error : ''));
      }
      try {
        serviceRecord.cleanup.port_closed = await portClosed(serviceRecord.port);
        if (!serviceRecord.cleanup.port_closed) {
          status = 'failed';
          blockers.push('Owned Vite listener remained open after cleanup');
        }
      } catch (error) {
        status = 'failed';
        blockers.push(error.message);
      }
    }
    try {
      browser = parseBrowserReport(await optionalText(path.join(run, 'browser-results.json')));
      const command = commands.find(command => command.log_path.endsWith('/hardware.log'));
      if (command) {
        command.tests = browser.tests;
        command.parse_status = browser.parse_status;
      }
      if (browser.status === 'failed') {
        status = 'failed';
        blockers.push(browser.blocker);
      } else if (browser.status === 'blocked' && status !== 'failed') {
        status = 'blocked';
        blockers.push(browser.blocker);
      }
      if (browser.parse_status === 'parsed') await reference(path.join(run, 'browser-results.json'));
      for (const count of [2000, 10000]) {
        const file = path.join(run, 'samples-' + count + '.json'),
          text = await optionalText(file);
        if (text === null) {
          if (status !== 'failed') status = 'blocked';
          blockers.push('Missing current raw samples: ' + count);
          continue;
        }
        await reference(file);
        const sample = JSON.parse(text);
        if (browser.status !== 'passed') continue; // Partial failure samples stay preserved, never promoted.
        if (sample.count !== count || sample.seed !== 17 || sample.warmup_per_scenario !== 40 || sample.sample_count_per_scenario !== 1000 || JSON.stringify(sample.canonical_dimensions) !== '[2048,2048]') throw new Error('Invalid fixed workload metadata: ' + count);
        if (!Array.isArray(sample.adapters) || !sample.adapters.length || hardwareKind(sample.adapters.at(-1)) !== 'hardware') throw new Prerequisite('No actual non-software adapter proof: ' + count);
        if (JSON.stringify(sample.loaded_wasm_sha256) !== JSON.stringify([environment?.wasm?.sha256])) throw new Error('Actual loaded WASM hash mismatch: ' + count);
        const performance = gate(count, sample.scenarios);
        for (const rows of Object.values(sample.scenarios)) if (rows.length !== 1000 || rows.some(row => row.native_submissions !== 1)) throw new Error('Invalid actual native submissions: ' + count);
        if (performance.failures.length) throw new Error(performance.failures.join('; '));
      }
      const environmentText = await optionalText(path.join(run, 'environment.json'));
      if (environmentText !== null) {
        environment = JSON.parse(environmentText);
        await reference(path.join(run, 'environment.json'));
      }
      if (status === 'passed' && (!environment?.browser?.version || environment.driver === 'unknown' || !Number.isFinite(environment.dpr))) throw new Prerequisite('Actual browser/driver/DPR provenance unavailable');
      after = captureEvidenceIdentity({
        env: env ?? safeEnvironment(runtime, runtime)
      });
      if (before && ['source_snapshot_sha256', 'manifest_sha256', 'runner_sha256'].some(key => before[key] !== after[key])) throw new Prerequisite('Source changed during GPU collection; current evidence not certifiable');
    } catch (error) {
      if (error instanceof Prerequisite || error.code === 'ENOENT') {
        if (status !== 'failed') status = 'blocked';
      } else status = 'failed';
      blockers.push(error.message);
    }
    if (!after) {
      try {
        after = captureEvidenceIdentity({
          env: env ?? safeEnvironment(runtime, runtime)
        });
      } catch (error) {
        if (status !== 'failed') status = 'blocked';
        blockers.push('Final identity unavailable: ' + error.message);
      }
    }
    if (before && after && ['source_snapshot_sha256', 'manifest_sha256', 'runner_sha256'].some(key => before[key] !== after[key])) {
      if (status !== 'failed') status = 'blocked';
      if (!blockers.includes('Source changed during GPU collection; current evidence not certifiable')) blockers.push('Source changed during GPU collection; current evidence not certifiable');
    }
    if (interrupted) {
      if (status !== 'failed') status = 'blocked';
      blockers.push('Cancelled; hardware gate not certified');
    }
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    const result = {
      schema_version: 1,
      task_id: 'T31',
      gate: 'gpu',
      status,
      base_commit: before?.source_commit ?? null,
      source_hashes: before?.source_hashes ?? null,
      manifest_sha256: before?.manifest_sha256 ?? null,
      identity: before,
      identity_after: after,
      time: {
        finished_at: new Date().toISOString()
      },
      run_dir: relative(run),
      environment,
      commands,
      tests: browser.tests,
      parse_status: browser.parse_status,
      evidence_refs,
      blockers,
      skipped_scope: ['security'],
      thresholds: {
        boxes: 2000,
        cpu_p95_ms: 8,
        pointer_double_raf_proxy_p95_ms: 33
      },
      workload: {
        counts: [2000, 10000],
        seed: 17,
        warmup_per_scenario: 40,
        sample_count_per_scenario: 1000,
        scenarios: ['pointer_drag', 'pan', 'zoom', 'committed_edit']
      },
      baseline_debug: {
        status: 'not_verified',
        available: false,
        certified_hardware_gate: false,
        reason: 'No current-source debug baseline collected; historical T28 reports are not current proof'
      },
      known_limits: ['double-rAF scheduling proxy, not physical photon latency', 'CPU includes measurement instrumentation', 'Logical texture bytes are not physical VRAM', 'GPU timestamps not measured']
    };
    await writeFile(path.join(run, 'result.json'), JSON.stringify(result, null, 2), {
      flag: 'wx'
    });
    await writeFile(path.join(report, 'result.json'), JSON.stringify(result, null, 2), {
      flag: 'wx'
    });
    console.log(JSON.stringify({
      status,
      tests: result.tests,
      run: result.run_dir,
      blockers
    }, null, 2));
  }
  return status === 'passed' ? 0 : status === 'blocked' ? 2 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJzcGF3biIsIm1rZGlyIiwid3JpdGVGaWxlIiwiYXBwZW5kRmlsZSIsInJlYWRGaWxlIiwic3RhdCIsImZzIiwib3MiLCJwYXRoIiwiY3JlYXRlSGFzaCIsInJhbmRvbVVVSUQiLCJjcmVhdGVTZXJ2ZXIiLCJjcmVhdGVDb25uZWN0aW9uIiwiY3JlYXRlUmVxdWlyZSIsImZpbGVVUkxUb1BhdGgiLCJvd25lZFJlcG9ydFJvb3QiLCJwcm9qZWN0T3V0cHV0UGF0aCIsImNhcHR1cmVFdmlkZW5jZUlkZW50aXR5IiwicmVzb2x2ZUFyZ3YiLCJydW5Bcmd2Iiwicm9vdCIsInJlc29sdmUiLCJkaXJuYW1lIiwiaW1wb3J0IiwibWV0YSIsInVybCIsImhhcmR3YXJlS2luZCIsImluZm8iLCJ0ZXh0IiwiSlNPTiIsInN0cmluZ2lmeSIsInRlc3QiLCJpc0ZhbGxiYWNrQWRhcHRlciIsInN1bW1hcml6ZSIsInNhbXBsZXMiLCJBcnJheSIsImlzQXJyYXkiLCJsZW5ndGgiLCJzb21lIiwicm93IiwiTnVtYmVyIiwiaXNGaW5pdGUiLCJjcHVfbXMiLCJkb3VibGVfcmFmX21zIiwic3VibWlzc2lvbnMiLCJFcnJvciIsInA5NSIsImtleSIsIm1hcCIsInNvcnQiLCJhIiwiYiIsIk1hdGgiLCJjZWlsIiwidmFsaWRfc2FtcGxlcyIsImNwdV9wOTVfbXMiLCJkb3VibGVfcmFmX3A5NV9tcyIsImdhdGUiLCJjb3VudCIsInNjZW5hcmlvcyIsInN1bW1hcmllcyIsIk9iamVjdCIsImZyb21FbnRyaWVzIiwibmFtZSIsImZhaWx1cmVzIiwiZW50cmllcyIsImZsYXRNYXAiLCJmaWx0ZXIiLCJCb29sZWFuIiwic2hhIiwiYnl0ZXMiLCJ1cGRhdGUiLCJkaWdlc3QiLCJyZWxhdGl2ZSIsImZpbGUiLCJyZXBsYWNlQWxsIiwicGF1c2UiLCJtcyIsIlByb21pc2UiLCJzZXRUaW1lb3V0Iiwic2V0dGxlV2l0aGluIiwiZG9uZSIsInRpbWVyIiwidGhlbiIsImNsZWFyVGltZW91dCIsInBvcnRDbG9zZWQiLCJwb3J0IiwicmVqZWN0Iiwic29ja2V0IiwiaG9zdCIsIm9uY2UiLCJkZXN0cm95IiwiZXJyb3IiLCJjb2RlIiwiUHJlcmVxdWlzaXRlIiwicGFyc2VHcHVBcmdzIiwiYXJncyIsInN0YXJ0c1dpdGgiLCJpc0Fic29sdXRlIiwicGFyc2VCcm93c2VyUmVwb3J0IiwidGVzdHMiLCJwYXJzZV9zdGF0dXMiLCJzdGF0dXMiLCJibG9ja2VyIiwicmVwb3J0IiwicGFyc2UiLCJzdGF0cyIsIm5hbWVzIiwiaXNTYWZlSW50ZWdlciIsInN1aXRlcyIsImNhc2VzIiwidmlzaXQiLCJzdWl0ZSIsInNwZWNzIiwidW5kZWZpbmVkIiwic3BlYyIsInB1c2giLCJ0aXRsZSIsImZvckVhY2giLCJjb2xsZWN0ZWQiLCJyZWR1Y2UiLCJuIiwicGFzc2VkIiwiZXhwZWN0ZWQiLCJmYWlsZWQiLCJ1bmV4cGVjdGVkIiwic2tpcHBlZCIsImZsYWt5IiwicmVxdWlyZWQiLCJlcnJvcnMiLCJldmVyeSIsIm1lc3NhZ2UiLCJzYWZlRW52aXJvbm1lbnQiLCJydW50aW1lIiwidGFyZ2V0IiwiZW52IiwicHJvY2VzcyIsImFzc2lnbiIsIlRFTVAiLCJUTVAiLCJUTVBESVIiLCJDQVJHT19UQVJHRVRfRElSIiwiQ0FSR09fTkVUX09GRkxJTkUiLCJSVVNUVVBfQVVUT19JTlNUQUxMIiwiQ09SRVBBQ0tfRU5BQkxFX05FVFdPUksiLCJXRUJMQUJFTF9TS0lQX1NFQ1VSSVRZIiwiZXhlY3V0YWJsZSIsImV4aXN0c1N5bmMiLCJleHRlbnNpb25zIiwicGxhdGZvcm0iLCJQQVRIRVhUIiwic3BsaXQiLCJkaXJlY3RvcnkiLCJQQVRIIiwiZGVsaW1pdGVyIiwiZXh0ZW5zaW9uIiwiY2FuZGlkYXRlIiwiam9pbiIsInRvTG93ZXJDYXNlIiwic3RhdFN5bmMiLCJpc0ZpbGUiLCJvcHRpb25hbFRleHQiLCJtYWluIiwiYXJndiIsInNsaWNlIiwicmVxdWVzdGVkIiwiRGF0ZSIsInRvSVNPU3RyaW5nIiwiY29uc29sZSIsInJ1biIsInJlY3Vyc2l2ZSIsImNvbmZpZ1Jvb3QiLCJjb21tYW5kcyIsImJsb2NrZXJzIiwiZXZpZGVuY2VfcmVmcyIsImJlZm9yZSIsImFmdGVyIiwiZW52aXJvbm1lbnQiLCJicm93c2VyIiwic2VydmljZSIsInNlcnZpY2VEb25lIiwic2VydmljZVJlY29yZCIsImludGVycnVwdGVkIiwib25TaWduYWwiLCJvbiIsInJlZmVyZW5jZSIsInJlZiIsInNoYTI1NiIsImV4ZWN1dGUiLCJpbnB1dCIsImN3ZCIsImNsZWFudXAiLCJsb2ciLCJ3cml0ZXMiLCJ0ZWUiLCJjaHVuayIsInJlY29yZCIsImV4aXRfY29kZSIsInNpZ25hbCIsInNpZ25hbF9vYnNlcnZhdGlvbiIsInJ1bm5lcl9leGl0X2NvZGUiLCJsb2dfcGF0aCIsIm9uU3Rkb3V0Iiwib25TdGRlcnIiLCJvbkNsb3NlIiwiZXhpdENvZGUiLCJvdXRwdXQiLCJpbmNsdWRlcyIsImJhc2VuYW1lIiwic3VwcGxpZWQiLCJidWlsZFRhcmdldCIsImNhcmdvQ3dkIiwiV0VCTEFCRUxfQ0FSR09fQ1dEIiwicmVhbHBhdGhTeW5jIiwiY2FyZ28iLCJiaW5kZ2VuIiwicmVxdWlyZSIsImRlcGVuZGVuY3kiLCJyZWxlYXNlIiwidmVyc2lvbiIsImFyY2giLCJjcHUiLCJjcHVzIiwibW9kZWwiLCJkcml2ZXIiLCJncHUiLCJkcHIiLCJzZWVkIiwidGFyZ2V0X2RpbWVuc2lvbnMiLCJ3YXNtX3Byb2ZpbGUiLCJjcmVkZW50aWFsX2Vudmlyb25tZW50IiwiYWNjb3VudF9zdGF0ZSIsInJhdyIsImluZGV4T2YiLCJkcml2ZXJfZXJyb3IiLCJ3YXNtT3V0cHV0Iiwid2FzbUZpbGUiLCJ3YXNtIiwic2l6ZSIsIldFQkxBQkVMX1dBU01fQlJJREdFX0RJUiIsIldFQkxBQkVMX0FQSV9CSU5BUlkiLCJhcGkiLCJleGVjUGF0aCIsIldFQkxBQkVMX1QzMF9IT1NUX1NDUklQVCIsInJlc2VydmUiLCJsaXN0ZW4iLCJhZGRyZXNzIiwiY2xvc2UiLCJXRUJMQUJFTF9UMzFfT1JJR0lOIiwiV0VCTEFCRUxfVDMxX1JVTl9ESVIiLCJ2aXRlQ29uZmlnIiwiU3RyaW5nIiwic2hlbGwiLCJ3aW5kb3dzSGlkZSIsImRldGFjaGVkIiwic3RkaW8iLCJzdGRpbiIsInN0ZGluX2Vycm9yIiwic3Bhd25FcnJvciIsInN0cmVhbSIsInN0ZG91dCIsInN0ZGVyciIsIndyaXRlIiwiZGVhZGxpbmUiLCJub3ciLCJmZXRjaCIsIkFib3J0U2lnbmFsIiwidGltZW91dCIsIm9rIiwidW5leHBlY3RlZEV4aXQiLCJzaWduYWxDb2RlIiwidW5leHBlY3RlZF9leGl0X2JlZm9yZV9jbGVhbnVwIiwiYmFja3N0b3AiLCJtZXRob2QiLCJlbmQiLCJzZXR0bGVkIiwicGlkIiwia2lsbCIsImNsb3NlZCIsImNsb3NlX29ic2VydmVkIiwicG9ydF9jbG9zZWQiLCJjb21tYW5kIiwiZmluZCIsImVuZHNXaXRoIiwic2FtcGxlIiwid2FybXVwX3Blcl9zY2VuYXJpbyIsInNhbXBsZV9jb3VudF9wZXJfc2NlbmFyaW8iLCJjYW5vbmljYWxfZGltZW5zaW9ucyIsImFkYXB0ZXJzIiwiYXQiLCJsb2FkZWRfd2FzbV9zaGEyNTYiLCJwZXJmb3JtYW5jZSIsInJvd3MiLCJ2YWx1ZXMiLCJuYXRpdmVfc3VibWlzc2lvbnMiLCJlbnZpcm9ubWVudFRleHQiLCJyZW1vdmVMaXN0ZW5lciIsInJlc3VsdCIsInNjaGVtYV92ZXJzaW9uIiwidGFza19pZCIsImJhc2VfY29tbWl0Iiwic291cmNlX2NvbW1pdCIsInNvdXJjZV9oYXNoZXMiLCJtYW5pZmVzdF9zaGEyNTYiLCJpZGVudGl0eSIsImlkZW50aXR5X2FmdGVyIiwidGltZSIsImZpbmlzaGVkX2F0IiwicnVuX2RpciIsInNraXBwZWRfc2NvcGUiLCJ0aHJlc2hvbGRzIiwiYm94ZXMiLCJwb2ludGVyX2RvdWJsZV9yYWZfcHJveHlfcDk1X21zIiwid29ya2xvYWQiLCJjb3VudHMiLCJiYXNlbGluZV9kZWJ1ZyIsImF2YWlsYWJsZSIsImNlcnRpZmllZF9oYXJkd2FyZV9nYXRlIiwicmVhc29uIiwia25vd25fbGltaXRzIiwiZmxhZyJdLCJzb3VyY2VzIjpbInZlcmlmeS1ncHUubWpzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHNwYXduIH0gZnJvbSAnbm9kZTpjaGlsZF9wcm9jZXNzJztcbmltcG9ydCB7IG1rZGlyLCB3cml0ZUZpbGUsIGFwcGVuZEZpbGUsIHJlYWRGaWxlLCBzdGF0IH0gZnJvbSAnbm9kZTpmcy9wcm9taXNlcyc7XG5pbXBvcnQgZnMgZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgb3MgZnJvbSAnbm9kZTpvcyc7XG5pbXBvcnQgcGF0aCBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0IHsgY3JlYXRlSGFzaCwgcmFuZG9tVVVJRCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcbmltcG9ydCB7IGNyZWF0ZVNlcnZlciwgY3JlYXRlQ29ubmVjdGlvbiB9IGZyb20gJ25vZGU6bmV0JztcbmltcG9ydCB7IGNyZWF0ZVJlcXVpcmUgfSBmcm9tICdub2RlOm1vZHVsZSc7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSAnbm9kZTp1cmwnO1xuaW1wb3J0IHsgb3duZWRSZXBvcnRSb290LCBwcm9qZWN0T3V0cHV0UGF0aCB9IGZyb20gJy4uL3Rlc3RzL3N1cHBvcnQvcmVwb3J0LXBhdGhzLm1qcyc7XG5pbXBvcnQgeyBjYXB0dXJlRXZpZGVuY2VJZGVudGl0eSB9IGZyb20gJy4vZXZpZGVuY2UtaWRlbnRpdHkubWpzJztcbmltcG9ydCB7IHJlc29sdmVBcmd2LCBydW5Bcmd2IH0gZnJvbSAnLi90YXNrLm1qcyc7XG5cbmNvbnN0IHJvb3QgPSBwYXRoLnJlc29sdmUocGF0aC5kaXJuYW1lKGZpbGVVUkxUb1BhdGgoaW1wb3J0Lm1ldGEudXJsKSksICcuLicpO1xuZXhwb3J0IGZ1bmN0aW9uIGhhcmR3YXJlS2luZChpbmZvKSB7XG4gIGNvbnN0IHRleHQgPSBKU09OLnN0cmluZ2lmeShpbmZvKTtcbiAgaWYgKC9zd2lmdHNoYWRlcnxsbHZtcGlwZXxsYXZhcGlwZXxzb2Z0d2FyZXxiYXNpYyByZW5kZXJ8ZGV2aWNlX3R5cGUuPz0uP0NwdS9pLnRlc3QodGV4dCkgfHwgaW5mbz8uaXNGYWxsYmFja0FkYXB0ZXIgPT09IHRydWUpIHJldHVybiAnc29mdHdhcmUnO1xuICBpZiAoL252aWRpYXxpbnRlbHxhbWR8YXBwbGV8YmxhY2t3ZWxsfERpc2NyZXRlR3B1fEludGVncmF0ZWRHcHUvaS50ZXN0KHRleHQpKSByZXR1cm4gJ2hhcmR3YXJlJztcbiAgcmV0dXJuICd1bmtub3duJztcbn1cbmV4cG9ydCBmdW5jdGlvbiBzdW1tYXJpemUoc2FtcGxlcykge1xuICBpZiAoIUFycmF5LmlzQXJyYXkoc2FtcGxlcykgfHwgc2FtcGxlcy5sZW5ndGggPCAxMDAwIHx8IHNhbXBsZXMuc29tZShyb3cgPT4gIU51bWJlci5pc0Zpbml0ZShyb3cuY3B1X21zKSB8fCByb3cuY3B1X21zIDwgMCB8fCAhTnVtYmVyLmlzRmluaXRlKHJvdy5kb3VibGVfcmFmX21zKSB8fCByb3cuZG91YmxlX3JhZl9tcyA8IDAgfHwgcm93LnN1Ym1pc3Npb25zICE9PSAxKSkgdGhyb3cgbmV3IEVycm9yKCdJbnZhbGlkIHdvcmtsb2FkOiByZXF1aXJlID49MTAwMCBmaW5pdGUgc2FtcGxlcywgZWFjaCB3aXRoIG9uZSBhY3R1YWwgR1BVIHN1Ym1pc3Npb247IG5vIGZpbHRlcmluZycpO1xuICBjb25zdCBwOTUgPSBrZXkgPT4gc2FtcGxlcy5tYXAocm93ID0+IHJvd1trZXldKS5zb3J0KChhLCBiKSA9PiBhIC0gYilbTWF0aC5jZWlsKHNhbXBsZXMubGVuZ3RoICogMC45NSkgLSAxXTtcbiAgcmV0dXJuIHsgdmFsaWRfc2FtcGxlczogc2FtcGxlcy5sZW5ndGgsIGNwdV9wOTVfbXM6IHA5NSgnY3B1X21zJyksIGRvdWJsZV9yYWZfcDk1X21zOiBwOTUoJ2RvdWJsZV9yYWZfbXMnKSB9O1xufVxuZXhwb3J0IGZ1bmN0aW9uIGdhdGUoY291bnQsIHNjZW5hcmlvcykge1xuICBjb25zdCBzdW1tYXJpZXMgPSBPYmplY3QuZnJvbUVudHJpZXMoWydwb2ludGVyX2RyYWcnLCAncGFuJywgJ3pvb20nLCAnY29tbWl0dGVkX2VkaXQnXS5tYXAobmFtZSA9PiBbbmFtZSwgc3VtbWFyaXplKHNjZW5hcmlvc1tuYW1lXSldKSk7XG4gIGNvbnN0IGZhaWx1cmVzID0gY291bnQgPT09IDIwMDAgPyBPYmplY3QuZW50cmllcyhzdW1tYXJpZXMpLmZsYXRNYXAoKFtuYW1lLCByb3ddKSA9PiBbcm93LmNwdV9wOTVfbXMgPiA4ID8gYCR7bmFtZX06IENQVSBQOTUgJHtyb3cuY3B1X3A5NV9tc30gPiA4bXNgIDogbnVsbCwgcm93LmRvdWJsZV9yYWZfcDk1X21zID4gMzMgPyBgJHtuYW1lfTogZG91YmxlLXJBRiBwcm94eSBQOTUgJHtyb3cuZG91YmxlX3JhZl9wOTVfbXN9ID4gMzNtc2AgOiBudWxsXS5maWx0ZXIoQm9vbGVhbikpIDogW107XG4gIHJldHVybiB7IHN1bW1hcmllcywgZmFpbHVyZXMgfTtcbn1cblxuY29uc3Qgc2hhID0gYnl0ZXMgPT4gY3JlYXRlSGFzaCgnc2hhMjU2JykudXBkYXRlKGJ5dGVzKS5kaWdlc3QoJ2hleCcpO1xuY29uc3QgcmVsYXRpdmUgPSBmaWxlID0+IHBhdGgucmVsYXRpdmUocm9vdCwgZmlsZSkucmVwbGFjZUFsbCgnXFxcXCcsICcvJyk7XG5jb25zdCBwYXVzZSA9IG1zID0+IG5ldyBQcm9taXNlKHJlc29sdmUgPT4gc2V0VGltZW91dChyZXNvbHZlLCBtcykpO1xuY29uc3Qgc2V0dGxlV2l0aGluID0gKGRvbmUsIG1zKSA9PiBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcbiAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHJlc29sdmUoZmFsc2UpLCBtcyk7XG4gIGRvbmUudGhlbigoKSA9PiB7IGNsZWFyVGltZW91dCh0aW1lcik7IHJlc29sdmUodHJ1ZSk7IH0pO1xufSk7XG5jb25zdCBwb3J0Q2xvc2VkID0gcG9ydCA9PiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gIGNvbnN0IHNvY2tldCA9IGNyZWF0ZUNvbm5lY3Rpb24oeyBob3N0OiAnMTI3LjAuMC4xJywgcG9ydCB9KTtcbiAgc29ja2V0Lm9uY2UoJ2Nvbm5lY3QnLCAoKSA9PiB7IHNvY2tldC5kZXN0cm95KCk7IHJlc29sdmUoZmFsc2UpOyB9KTtcbiAgc29ja2V0Lm9uY2UoJ2Vycm9yJywgZXJyb3IgPT4geyBzb2NrZXQuZGVzdHJveSgpOyBpZiAoZXJyb3IuY29kZSA9PT0gJ0VDT05OUkVGVVNFRCcpIHJlc29sdmUodHJ1ZSk7IGVsc2UgcmVqZWN0KGVycm9yKTsgfSk7XG4gIHNvY2tldC5zZXRUaW1lb3V0KDEwMDAsICgpID0+IHsgc29ja2V0LmRlc3Ryb3koKTsgcmVqZWN0KG5ldyBFcnJvcignT3duZWQgVml0ZSBwb3J0IGNsb3NlIG9ic2VydmF0aW9uIHRpbWVkIG91dCcpKTsgfSk7XG59KTtcbmNsYXNzIFByZXJlcXVpc2l0ZSBleHRlbmRzIEVycm9yIHt9XG5leHBvcnQgZnVuY3Rpb24gcGFyc2VHcHVBcmdzKGFyZ3MpIHtcbiAgaWYgKCFhcmdzLmxlbmd0aCkgcmV0dXJuIG51bGw7XG4gIGlmIChhcmdzLmxlbmd0aCAhPT0gMiB8fCBhcmdzWzBdICE9PSAnLS1yZXBvcnQtZGlyJyB8fCAhYXJnc1sxXSB8fCBhcmdzWzFdLnN0YXJ0c1dpdGgoJy0tJykgfHwgcGF0aC5pc0Fic29sdXRlKGFyZ3NbMV0pKSB0aHJvdyBuZXcgRXJyb3IoJ0lOVkFMSURfQVJHVU1FTlRTJyk7XG4gIHJldHVybiBhcmdzWzFdO1xufVxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQnJvd3NlclJlcG9ydCh0ZXh0KSB7XG4gIGlmICh0ZXh0ID09PSBudWxsKSByZXR1cm4geyB0ZXN0czogbnVsbCwgcGFyc2Vfc3RhdHVzOiAnbWlzc2luZycsIHN0YXR1czogJ2Jsb2NrZWQnLCBibG9ja2VyOiAnQ3VycmVudCBQbGF5d3JpZ2h0IEpTT04gaXMgbWlzc2luZycgfTtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXBvcnQgPSBKU09OLnBhcnNlKHRleHQpLCBzdGF0cyA9IHJlcG9ydC5zdGF0cztcbiAgICBjb25zdCBuYW1lcyA9IFsnZXhwZWN0ZWQnLCAndW5leHBlY3RlZCcsICdza2lwcGVkJywgJ2ZsYWt5J107XG4gICAgaWYgKCFzdGF0cyB8fCBuYW1lcy5zb21lKGtleSA9PiAhTnVtYmVyLmlzU2FmZUludGVnZXIoc3RhdHNba2V5XSkgfHwgc3RhdHNba2V5XSA8IDApIHx8ICFBcnJheS5pc0FycmF5KHJlcG9ydC5zdWl0ZXMpKSB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgbmF0aXZlIFBsYXl3cmlnaHQgc3RhdHMvc3VpdGVzJyk7XG4gICAgY29uc3QgY2FzZXMgPSBbXTtcbiAgICBmdW5jdGlvbiB2aXNpdChzdWl0ZSkge1xuICAgICAgaWYgKChzdWl0ZS5zcGVjcyAhPT0gdW5kZWZpbmVkICYmICFBcnJheS5pc0FycmF5KHN1aXRlLnNwZWNzKSkgfHwgKHN1aXRlLnN1aXRlcyAhPT0gdW5kZWZpbmVkICYmICFBcnJheS5pc0FycmF5KHN1aXRlLnN1aXRlcykpKSB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgbmF0aXZlIFBsYXl3cmlnaHQgc3VpdGUnKTtcbiAgICAgIGZvciAoY29uc3Qgc3BlYyBvZiBzdWl0ZS5zcGVjcyA/PyBbXSkge1xuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkoc3BlYy50ZXN0cykpIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBuYXRpdmUgUGxheXdyaWdodCB0ZXN0cycpO1xuICAgICAgICBmb3IgKGNvbnN0IHRlc3Qgb2Ygc3BlYy50ZXN0cykgY2FzZXMucHVzaCh7IHRpdGxlOiBzcGVjLnRpdGxlLCBzdGF0dXM6IHRlc3Quc3RhdHVzIH0pO1xuICAgICAgfVxuICAgICAgKHN1aXRlLnN1aXRlcyA/PyBbXSkuZm9yRWFjaCh2aXNpdCk7XG4gICAgfVxuICAgIHJlcG9ydC5zdWl0ZXMuZm9yRWFjaCh2aXNpdCk7XG4gICAgY29uc3QgdGVzdHMgPSB7IGNvbGxlY3RlZDogbmFtZXMucmVkdWNlKChuLCBrZXkpID0+IG4gKyBzdGF0c1trZXldLCAwKSwgcGFzc2VkOiBzdGF0cy5leHBlY3RlZCwgZmFpbGVkOiBzdGF0cy51bmV4cGVjdGVkLCBza2lwcGVkOiBzdGF0cy5za2lwcGVkLCBmbGFreTogc3RhdHMuZmxha3kgfTtcbiAgICBpZiAoY2FzZXMubGVuZ3RoICE9PSB0ZXN0cy5jb2xsZWN0ZWQgfHwgbmFtZXMuc29tZShuYW1lID0+IGNhc2VzLmZpbHRlcih0ZXN0ID0+IHRlc3Quc3RhdHVzID09PSBuYW1lKS5sZW5ndGggIT09IHN0YXRzW25hbWVdKSkgdGhyb3cgbmV3IEVycm9yKCdQbGF5d3JpZ2h0IHN0YXRzIGRvIG5vdCBtYXRjaCBuYXRpdmUgdGVzdCBjYXNlcycpO1xuICAgIGNvbnN0IHJlcXVpcmVkID0gWzIwMDAsIDEwMDAwXS5tYXAoY291bnQgPT4gY291bnQgKyAnIGZpeGVkIHJlbGVhc2UgV0FTTSBoYXJkd2FyZTogZm91ciB3YXJtZWQgMTAwMC1zYW1wbGUgc2NlbmFyaW9zIGFuZCBsaWZlY3ljbGUnKTtcbiAgICByZXF1aXJlZC5wdXNoKCdzb2Z0d2FyZSBhbmQgdW5rbm93biBhZGFwdGVycyBjYW5ub3QgcGFzcyB0aGUgaGFyZHdhcmUgY2xhc3NpZmllciAobm90IGhhcmR3YXJlIGV2aWRlbmNlKScpO1xuICAgIGlmIChyZXBvcnQuZXJyb3JzICE9PSB1bmRlZmluZWQgJiYgKCFBcnJheS5pc0FycmF5KHJlcG9ydC5lcnJvcnMpIHx8IHJlcG9ydC5lcnJvcnMubGVuZ3RoKSkgcmV0dXJuIHsgdGVzdHMsIHBhcnNlX3N0YXR1czogJ3BhcnNlZCcsIHN0YXR1czogJ2ZhaWxlZCcsIGJsb2NrZXI6ICdQbGF5d3JpZ2h0IHJlcG9ydGVkIGdsb2JhbCBlcnJvcnMnIH07XG4gICAgY29uc3QgcGFzc2VkID0gdGVzdHMuY29sbGVjdGVkID09PSAzICYmIHRlc3RzLnBhc3NlZCA9PT0gMyAmJiAhdGVzdHMuZmFpbGVkICYmICF0ZXN0cy5za2lwcGVkICYmICF0ZXN0cy5mbGFreSAmJiByZXF1aXJlZC5ldmVyeSh0aXRsZSA9PiBjYXNlcy5maWx0ZXIodGVzdCA9PiB0ZXN0LnRpdGxlID09PSB0aXRsZSkubGVuZ3RoID09PSAxKTtcbiAgICByZXR1cm4geyB0ZXN0cywgcGFyc2Vfc3RhdHVzOiAncGFyc2VkJywgc3RhdHVzOiBwYXNzZWQgPyAncGFzc2VkJyA6ICdmYWlsZWQnLCBibG9ja2VyOiBwYXNzZWQgPyBudWxsIDogJ1JlcXVpcmUgZXhhY3RseSB0aGUgdGhyZWUgVDMxIHRlc3RzLCBhbGwgcGFzc2VkIHdpdGhvdXQgc2tpcHMvcmV0cmllcycgfTtcbiAgfSBjYXRjaCAoZXJyb3IpIHsgcmV0dXJuIHsgdGVzdHM6IG51bGwsIHBhcnNlX3N0YXR1czogJ21hbGZvcm1lZCcsIHN0YXR1czogJ2ZhaWxlZCcsIGJsb2NrZXI6IGVycm9yLm1lc3NhZ2UgfTsgfVxufVxuZnVuY3Rpb24gc2FmZUVudmlyb25tZW50KHJ1bnRpbWUsIHRhcmdldCkge1xuICBjb25zdCBlbnYgPSB7fTtcbiAgZm9yIChjb25zdCBrZXkgb2YgWydQQVRIJywnUEFUSEVYVCcsJ1N5c3RlbVJvb3QnLCdXSU5ESVInLCdDT01TUEVDJywnVVNFUlBST0ZJTEUnLCdIT01FJywnQVBQREFUQScsJ0xPQ0FMQVBQREFUQScsJ1BOUE1fSE9NRScsJ0NPUkVQQUNLX0hPTUUnLCdDQVJHT19IT01FJywnUlVTVFVQX0hPTUUnLCdSVVNUVVBfVE9PTENIQUlOJywnUlVTVEMnLCdSVVNURE9DJywnVkNJTlNUQUxMRElSJywnV2luZG93c1Nka0RpcicsJ0lOQ0xVREUnLCdMSUInLCdMSUJQQVRIJ10pIGlmIChwcm9jZXNzLmVudltrZXldICE9PSB1bmRlZmluZWQpIGVudltrZXldID0gcHJvY2Vzcy5lbnZba2V5XTtcbiAgT2JqZWN0LmFzc2lnbihlbnYsIHsgVEVNUDogcnVudGltZSwgVE1QOiBydW50aW1lLCBUTVBESVI6IHJ1bnRpbWUsIENBUkdPX1RBUkdFVF9ESVI6IHRhcmdldCwgQ0FSR09fTkVUX09GRkxJTkU6ICd0cnVlJywgUlVTVFVQX0FVVE9fSU5TVEFMTDogJzAnLCBDT1JFUEFDS19FTkFCTEVfTkVUV09SSzogJzAnLCBXRUJMQUJFTF9TS0lQX1NFQ1VSSVRZOiAnMScgfSk7XG4gIHJldHVybiBlbnY7XG59XG5mdW5jdGlvbiBleGVjdXRhYmxlKG5hbWUsIGVudikge1xuICBpZiAocGF0aC5pc0Fic29sdXRlKG5hbWUpKSB7IGlmIChmcy5leGlzdHNTeW5jKG5hbWUpKSByZXR1cm4gbmFtZTsgdGhyb3cgbmV3IFByZXJlcXVpc2l0ZSgnSW5zdGFsbGVkIGV4ZWN1dGFibGUgbWlzc2luZzogJyArIG5hbWUpOyB9XG4gIGNvbnN0IGV4dGVuc2lvbnMgPSBwcm9jZXNzLnBsYXRmb3JtID09PSAnd2luMzInID8gKGVudi5QQVRIRVhUID8/ICcuRVhFOy5DTUQ7LkJBVCcpLnNwbGl0KCc7JykgOiBbJyddO1xuICBmb3IgKGNvbnN0IGRpcmVjdG9yeSBvZiAoZW52LlBBVEggPz8gJycpLnNwbGl0KHBhdGguZGVsaW1pdGVyKSkgZm9yIChjb25zdCBleHRlbnNpb24gb2YgWycnLCAuLi5leHRlbnNpb25zXSkge1xuICAgIGNvbnN0IGNhbmRpZGF0ZSA9IHBhdGguam9pbihkaXJlY3RvcnksIG5hbWUgKyBleHRlbnNpb24udG9Mb3dlckNhc2UoKSk7XG4gICAgaWYgKGZzLmV4aXN0c1N5bmMoY2FuZGlkYXRlKSAmJiBmcy5zdGF0U3luYyhjYW5kaWRhdGUpLmlzRmlsZSgpKSByZXR1cm4gY2FuZGlkYXRlO1xuICB9XG4gIHRocm93IG5ldyBQcmVyZXF1aXNpdGUoJ0luc3RhbGxlZCBleGVjdXRhYmxlIHVuYXZhaWxhYmxlOiAnICsgbmFtZSk7XG59XG5hc3luYyBmdW5jdGlvbiBvcHRpb25hbFRleHQoZmlsZSkge1xuICB0cnkgeyByZXR1cm4gYXdhaXQgcmVhZEZpbGUoZmlsZSwgJ3V0ZjgnKTsgfSBjYXRjaCAoZXJyb3IpIHsgaWYgKGVycm9yLmNvZGUgPT09ICdFTk9FTlQnKSByZXR1cm4gbnVsbDsgdGhyb3cgZXJyb3I7IH1cbn1cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtYWluKGFyZ3MgPSBwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpIHtcbiAgbGV0IHJlcG9ydDtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXF1ZXN0ZWQgPSBwYXJzZUdwdUFyZ3MoYXJncyk7XG4gICAgcmVwb3J0ID0gb3duZWRSZXBvcnRSb290KHJlcXVlc3RlZCA/PyAoJ3JlcG9ydHMvVDMxL3ZlcmlmaWNhdGlvbi8nICsgbmV3IERhdGUoKS50b0lTT1N0cmluZygpLnJlcGxhY2VBbGwoJzonLCctJykgKyAnLScgKyByYW5kb21VVUlEKCkpKTtcbiAgICBpZiAoZnMuZXhpc3RzU3luYyhwYXRoLmpvaW4ocmVwb3J0LCAncmVzdWx0Lmpzb24nKSkpIHRocm93IG5ldyBFcnJvcignRVhJU1RJTkdfUkVTVUxUX1JFRlVTRUQnKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHsgY29uc29sZS5lcnJvcihlcnJvci5tZXNzYWdlKTsgcmV0dXJuIDE7IH1cbiAgY29uc3QgcnVuID0gcGF0aC5qb2luKHJlcG9ydCwgJ3J1bnMnLCByYW5kb21VVUlEKCkpO1xuICBjb25zdCBydW50aW1lID0gcGF0aC5qb2luKHJ1biwgJ3J1bnRpbWUnKTtcbiAgYXdhaXQgbWtkaXIocnVudGltZSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGNvbnN0IGNvbmZpZ1Jvb3QgPSBwYXRoLmpvaW4ocm9vdCwgJ3JlcG9ydHMvVDMxJyk7XG4gIGNvbnN0IGNvbW1hbmRzID0gW10sIGJsb2NrZXJzID0gW10sIGV2aWRlbmNlX3JlZnMgPSBbXTtcbiAgbGV0IHN0YXR1cyA9ICdibG9ja2VkJywgYmVmb3JlID0gbnVsbCwgYWZ0ZXIgPSBudWxsLCBlbnZpcm9ubWVudCA9IG51bGwsIGJyb3dzZXIgPSB7IHRlc3RzOiBudWxsLCBwYXJzZV9zdGF0dXM6ICdub3Rfc3RhcnRlZCcgfSwgc2VydmljZSA9IG51bGwsIHNlcnZpY2VEb25lID0gbnVsbCwgc2VydmljZVJlY29yZCA9IG51bGw7XG4gIGxldCBpbnRlcnJ1cHRlZCA9IGZhbHNlO1xuICBjb25zdCBvblNpZ25hbCA9ICgpID0+IHsgaW50ZXJydXB0ZWQgPSB0cnVlOyB9O1xuICBwcm9jZXNzLm9uKCdTSUdJTlQnLCBvblNpZ25hbCk7IHByb2Nlc3Mub24oJ1NJR1RFUk0nLCBvblNpZ25hbCk7XG4gIGxldCBlbnY7XG4gIGFzeW5jIGZ1bmN0aW9uIHJlZmVyZW5jZShmaWxlKSB7XG4gICAgY29uc3QgYnl0ZXMgPSBhd2FpdCByZWFkRmlsZShmaWxlKTtcbiAgICBjb25zdCByZWYgPSB7IHBhdGg6IHJlbGF0aXZlKGZpbGUpLCBzaGEyNTY6IHNoYShieXRlcyksIGJ5dGVzOiBieXRlcy5sZW5ndGggfTtcbiAgICBldmlkZW5jZV9yZWZzLnB1c2gocmVmKTsgcmV0dXJuIHJlZjtcbiAgfVxuICBhc3luYyBmdW5jdGlvbiBleGVjdXRlKG5hbWUsIGlucHV0LCBjd2QgPSByb290LCBjbGVhbnVwID0gZmFsc2UpIHtcbiAgICBpZiAoaW50ZXJydXB0ZWQgJiYgIWNsZWFudXApIHRocm93IG5ldyBQcmVyZXF1aXNpdGUoJ0NhbmNlbGxlZCBiZWZvcmUgJyArIG5hbWUpO1xuICAgIGNvbnN0IGFyZ3YgPSByZXNvbHZlQXJndihpbnB1dCk7XG4gICAgYXJndlswXSA9IGV4ZWN1dGFibGUoYXJndlswXSwgZW52KTtcbiAgICBjb25zdCBsb2cgPSBwYXRoLmpvaW4ocnVuLCBuYW1lICsgJy5sb2cnKTtcbiAgICBhd2FpdCB3cml0ZUZpbGUobG9nLCBKU09OLnN0cmluZ2lmeSh7IGFyZ3YsIGN3ZCB9KSArICdcXG4nKTtcbiAgICBsZXQgd3JpdGVzID0gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgY29uc3QgdGVlID0gY2h1bmsgPT4geyB3cml0ZXMgPSB3cml0ZXMudGhlbigoKSA9PiBhcHBlbmRGaWxlKGxvZywgY2h1bmspKTsgfTtcbiAgICBjb25zdCByZWNvcmQgPSB7IGFyZ3YsIGN3ZCwgZXhpdF9jb2RlOiBudWxsLCBzaWduYWw6IG51bGwsIHNpZ25hbF9vYnNlcnZhdGlvbjogJ25vdF9zcGF3bmVkX29yX2Nsb3NlX3Vub2JzZXJ2ZWQnLCBydW5uZXJfZXhpdF9jb2RlOiBudWxsLCBsb2dfcGF0aDogcmVsYXRpdmUobG9nKSwgdGVzdHM6IG51bGwsIHBhcnNlX3N0YXR1czogJ25vbl90ZXN0JyB9O1xuICAgIGNvbW1hbmRzLnB1c2gocmVjb3JkKTtcbiAgICB0cnkgeyByZWNvcmQucnVubmVyX2V4aXRfY29kZSA9IGF3YWl0IHJ1bkFyZ3YoYXJndiwgY3dkLCB7IGVudiwgb25TdGRvdXQ6IHRlZSwgb25TdGRlcnI6IHRlZSwgb25DbG9zZTogKGV4aXRDb2RlLCBzaWduYWwpID0+IHsgcmVjb3JkLmV4aXRfY29kZSA9IGV4aXRDb2RlOyByZWNvcmQuc2lnbmFsID0gc2lnbmFsOyByZWNvcmQuc2lnbmFsX29ic2VydmF0aW9uID0gJ25hdGl2ZV9jbG9zZSc7IH0gfSk7IH1cbiAgICBmaW5hbGx5IHsgYXdhaXQgd3JpdGVzOyBhd2FpdCByZWZlcmVuY2UobG9nKTsgfVxuICAgIGlmIChyZWNvcmQucnVubmVyX2V4aXRfY29kZSAhPT0gMCkge1xuICAgICAgY29uc3Qgb3V0cHV0ID0gYXdhaXQgcmVhZEZpbGUobG9nLCd1dGY4Jyk7XG4gICAgICBpZiAoWydjYXJnby12ZXJzaW9uJywnYmluZGdlbi12ZXJzaW9uJywncmVsZWFzZS13YXNtJywncmVsZWFzZS1iaW5kZ2VuJywnYXBpJywnaG9zdCddLmluY2x1ZGVzKG5hbWUpICYmIC9ubyBtYXRjaGluZyBwYWNrYWdlIG5hbWVkfGF0dGVtcHRpbmcgdG8gbWFrZSBhbiBIVFRQIHJlcXVlc3R8ZmFpbGVkIHRvIGRvd25sb2FkfHRhcmdldCBtYXkgbm90IGJlIGluc3RhbGxlZHx0b29sY2hhaW5bXlxcbl0qbm90IGluc3RhbGxlZHxDYW5ub3QgZmluZCAoPzptb2R1bGV8cGFja2FnZSkvaS50ZXN0KG91dHB1dCkpIHRocm93IG5ldyBQcmVyZXF1aXNpdGUobmFtZSArICcgbWlzc2luZyBpbnN0YWxsZWQvb2ZmbGluZSBwcmVyZXF1aXNpdGU7IHNlZSAnICsgcmVsYXRpdmUobG9nKSk7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IobmFtZSArICcgZXhpdGVkICcgKyByZWNvcmQucnVubmVyX2V4aXRfY29kZSArICcgKG5hdGl2ZSBleGl0PScgKyByZWNvcmQuZXhpdF9jb2RlICsgJywgc2lnbmFsPScgKyByZWNvcmQuc2lnbmFsICsgJyknKTtcbiAgICB9XG4gICAgcmV0dXJuIHJlY29yZDtcbiAgfVxuICB0cnkge1xuICAgIGVudiA9IHNhZmVFbnZpcm9ubWVudChydW50aW1lLCBwcm9qZWN0T3V0cHV0UGF0aChwcm9jZXNzLmVudi5DQVJHT19UQVJHRVRfRElSID8/IHBhdGguam9pbihyb290LCd0YXJnZXQvYnVpbGQtY2FjaGUvZGVmZWN0LXJlcGFpci9ncHUnLHBhdGguYmFzZW5hbWUocnVuKSkpKTtcbiAgICBiZWZvcmUgPSBjYXB0dXJlRXZpZGVuY2VJZGVudGl0eSh7IGVudiB9KTtcbiAgICBhd2FpdCB3cml0ZUZpbGUocGF0aC5qb2luKHJ1biwgJ3NvdXJjZS1iZWZvcmUuanNvbicpLCBKU09OLnN0cmluZ2lmeShiZWZvcmUsIG51bGwsIDIpKTtcbiAgICBjb25zdCBzdXBwbGllZCA9IHByb2Nlc3MuZW52LkNBUkdPX1RBUkdFVF9ESVI7XG4gICAgY29uc3QgdGFyZ2V0ID0gcHJvamVjdE91dHB1dFBhdGgoc3VwcGxpZWQgPz8gcGF0aC5qb2luKHJvb3QsICd0YXJnZXQvYnVpbGQtY2FjaGUvZGVmZWN0LXJlcGFpci9ncHUnLCBwYXRoLmJhc2VuYW1lKHJ1bikpKTtcbiAgICBjb25zdCBidWlsZFRhcmdldCA9IHBhdGguam9pbih0YXJnZXQsICd0MzEtJyArIHBhdGguYmFzZW5hbWUocnVuKSk7XG4gICAgZW52ID0gc2FmZUVudmlyb25tZW50KHJ1bnRpbWUsIGJ1aWxkVGFyZ2V0KTtcbiAgICBjb25zdCBjYXJnb0N3ZCA9IHByb2Nlc3MuZW52LldFQkxBQkVMX0NBUkdPX0NXRCA/IGZzLnJlYWxwYXRoU3luYyhwcm9jZXNzLmVudi5XRUJMQUJFTF9DQVJHT19DV0QpIDogcm9vdDtcbiAgICBjb25zdCBjYXJnbyA9IGV4ZWN1dGFibGUoJ2NhcmdvJywgZW52KSwgYmluZGdlbiA9IGV4ZWN1dGFibGUoJ3dhc20tYmluZGdlbicsIGVudik7XG4gICAgcmVzb2x2ZUFyZ3YoWydwbnBtJywnZXhlYycsJ3BsYXl3cmlnaHQnLCctLXZlcnNpb24nXSk7XG4gICAgY29uc3QgcmVxdWlyZSA9IGNyZWF0ZVJlcXVpcmUocGF0aC5qb2luKHJvb3QsICdhcHBzL3dlYi9wYWNrYWdlLmpzb24nKSk7XG4gICAgZm9yIChjb25zdCBkZXBlbmRlbmN5IG9mIFsnQHBsYXl3cmlnaHQvdGVzdCcsJ3ZpdGUnLCdzaGFycCddKSB7IHRyeSB7IHJlcXVpcmUucmVzb2x2ZShkZXBlbmRlbmN5KTsgfSBjYXRjaCB7IHRocm93IG5ldyBQcmVyZXF1aXNpdGUoJ0luc3RhbGxlZCBkZXBlbmRlbmN5IG1pc3Npbmc6ICcgKyBkZXBlbmRlbmN5KTsgfSB9XG4gICAgZW52aXJvbm1lbnQgPSB7IG9zOiB7IHBsYXRmb3JtOiBvcy5wbGF0Zm9ybSgpLCByZWxlYXNlOiBvcy5yZWxlYXNlKCksIHZlcnNpb246IG9zLnZlcnNpb24oKSwgYXJjaDogb3MuYXJjaCgpIH0sIGNwdTogb3MuY3B1cygpWzBdPy5tb2RlbCA/PyAndW5rbm93bicsIGRyaXZlcjogJ3Vua25vd24nLCBicm93c2VyOiAndW5rbm93bicsIGdwdTogJ3Vua25vd24nLCBkcHI6ICd1bmtub3duJywgc2VlZDogMTcsIHRhcmdldF9kaW1lbnNpb25zOiBbMjA0OCwyMDQ4XSwgd2FzbV9wcm9maWxlOiAncmVsZWFzZScsIGNyZWRlbnRpYWxfZW52aXJvbm1lbnQ6ICdub3RfZm9yd2FyZGVkJywgYWNjb3VudF9zdGF0ZTogJ25vdF9pbnNwZWN0ZWQnIH07XG4gICAgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09ICd3aW4zMicpIHtcbiAgICAgIGF3YWl0IGV4ZWN1dGUoJ2RyaXZlcicsIFsncG93ZXJzaGVsbC5leGUnLCctTm9Qcm9maWxlJywnLUNvbW1hbmQnLCdHZXQtQ2ltSW5zdGFuY2UgV2luMzJfVmlkZW9Db250cm9sbGVyIHwgU2VsZWN0LU9iamVjdCBOYW1lLERyaXZlclZlcnNpb24sQWRhcHRlckNvbXBhdGliaWxpdHkgfCBDb252ZXJ0VG8tSnNvbiAtQ29tcHJlc3MnXSk7XG4gICAgICBjb25zdCByYXcgPSBhd2FpdCByZWFkRmlsZShwYXRoLmpvaW4ocnVuLCAnZHJpdmVyLmxvZycpLCAndXRmOCcpO1xuICAgICAgdHJ5IHsgZW52aXJvbm1lbnQuZHJpdmVyID0gSlNPTi5wYXJzZShyYXcuc2xpY2UocmF3LmluZGV4T2YoJ1xcbicpICsgMSkpOyB9IGNhdGNoIChlcnJvcikgeyBlbnZpcm9ubWVudC5kcml2ZXJfZXJyb3IgPSBlcnJvci5tZXNzYWdlOyB9XG4gICAgfVxuICAgIGF3YWl0IHdyaXRlRmlsZShwYXRoLmpvaW4ocnVuLCAnZW52aXJvbm1lbnQuanNvbicpLCBKU09OLnN0cmluZ2lmeShlbnZpcm9ubWVudCwgbnVsbCwgMikpO1xuICAgIGF3YWl0IGV4ZWN1dGUoJ2NhcmdvLXZlcnNpb24nLCBbY2FyZ28sJy0tdmVyc2lvbiddLCBjYXJnb0N3ZCk7XG4gICAgYXdhaXQgZXhlY3V0ZSgnYmluZGdlbi12ZXJzaW9uJywgW2JpbmRnZW4sJy0tdmVyc2lvbiddLCBjYXJnb0N3ZCk7XG4gICAgYXdhaXQgZXhlY3V0ZSgncmVsZWFzZS13YXNtJywgW2NhcmdvLCdidWlsZCcsJy0tbG9ja2VkJywnLS1vZmZsaW5lJywnLS1yZWxlYXNlJywnLS1tYW5pZmVzdC1wYXRoJyxwYXRoLmpvaW4ocm9vdCwnQ2FyZ28udG9tbCcpLCctLXRhcmdldC1kaXInLGJ1aWxkVGFyZ2V0LCctcCcsJ3dhc20tYnJpZGdlJywnLS10YXJnZXQnLCd3YXNtMzItdW5rbm93bi11bmtub3duJ10sIGNhcmdvQ3dkKTtcbiAgICBjb25zdCB3YXNtT3V0cHV0ID0gcGF0aC5qb2luKHJ1bnRpbWUsICd3YXNtJyk7XG4gICAgYXdhaXQgZXhlY3V0ZSgncmVsZWFzZS1iaW5kZ2VuJywgW2JpbmRnZW4scGF0aC5qb2luKGJ1aWxkVGFyZ2V0LCd3YXNtMzItdW5rbm93bi11bmtub3duL3JlbGVhc2Uvd2FzbV9icmlkZ2Uud2FzbScpLCctLXRhcmdldCcsJ3dlYicsJy0tb3V0LWRpcicsd2FzbU91dHB1dCwnLS1vdXQtbmFtZScsJ3dhc21fYnJpZGdlJ10sIGNhcmdvQ3dkKTtcbiAgICBjb25zdCB3YXNtRmlsZSA9IHBhdGguam9pbih3YXNtT3V0cHV0LCAnd2FzbV9icmlkZ2VfYmcud2FzbScpO1xuICAgIGVudmlyb25tZW50Lndhc20gPSB7IC4uLihhd2FpdCByZWZlcmVuY2Uod2FzbUZpbGUpKSwgYnl0ZXM6IChhd2FpdCBzdGF0KHdhc21GaWxlKSkuc2l6ZSB9O1xuICAgIGVudi5XRUJMQUJFTF9XQVNNX0JSSURHRV9ESVIgPSB3YXNtT3V0cHV0O1xuICAgIGF3YWl0IHdyaXRlRmlsZShwYXRoLmpvaW4ocnVuLCAnZW52aXJvbm1lbnQuanNvbicpLCBKU09OLnN0cmluZ2lmeShlbnZpcm9ubWVudCxudWxsLDIpKTtcbiAgICBhd2FpdCBleGVjdXRlKCdhcGknLCBbY2FyZ28sJ2J1aWxkJywnLS1sb2NrZWQnLCctLW9mZmxpbmUnLCctLW1hbmlmZXN0LXBhdGgnLHBhdGguam9pbihyb290LCdDYXJnby50b21sJyksJy0tdGFyZ2V0LWRpcicsYnVpbGRUYXJnZXQsJy1wJywnd2VibGFiZWwtYXBpJywnLS1iaW4nLCd3ZWJsYWJlbC1hcGknXSwgY2FyZ29Dd2QpO1xuICAgIGVudi5XRUJMQUJFTF9BUElfQklOQVJZID0gcGF0aC5qb2luKGJ1aWxkVGFyZ2V0LCdkZWJ1ZycscHJvY2Vzcy5wbGF0Zm9ybSA9PT0gJ3dpbjMyJyA/ICd3ZWJsYWJlbC1hcGkuZXhlJyA6ICd3ZWJsYWJlbC1hcGknKTtcbiAgICBlbnZpcm9ubWVudC5hcGkgPSBhd2FpdCByZWZlcmVuY2UoZW52LldFQkxBQkVMX0FQSV9CSU5BUlkpO1xuICAgIGNvbnN0IGhvc3QgPSBwYXRoLmpvaW4ocnVudGltZSwnYWdlbnQtaG9zdCcpO1xuICAgIGF3YWl0IGV4ZWN1dGUoJ2hvc3QnLCBbcHJvY2Vzcy5leGVjUGF0aCxwYXRoLmpvaW4ocm9vdCwnc2NyaXB0cy9idWlsZC1hZ2VudC1ob3N0Lm1qcycpLCctLW91dC1kaXInLGhvc3RdKTtcbiAgICBlbnYuV0VCTEFCRUxfVDMwX0hPU1RfU0NSSVBUID0gcGF0aC5qb2luKGhvc3QsJ3J1bnRpbWUubWpzJyk7XG4gICAgZW52aXJvbm1lbnQuaG9zdCA9IGF3YWl0IHJlZmVyZW5jZShlbnYuV0VCTEFCRUxfVDMwX0hPU1RfU0NSSVBUKTtcbiAgICBhd2FpdCB3cml0ZUZpbGUocGF0aC5qb2luKHJ1biwnZW52aXJvbm1lbnQuanNvbicpLEpTT04uc3RyaW5naWZ5KGVudmlyb25tZW50LG51bGwsMikpO1xuICAgIGNvbnN0IHJlc2VydmUgPSBjcmVhdGVTZXJ2ZXIoKTtcbiAgICBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZSxyZWplY3QpID0+IHsgcmVzZXJ2ZS5vbmNlKCdlcnJvcicscmVqZWN0KTsgcmVzZXJ2ZS5saXN0ZW4oMCwnMTI3LjAuMC4xJyxyZXNvbHZlKTsgfSk7XG4gICAgY29uc3QgcG9ydCA9IHJlc2VydmUuYWRkcmVzcygpLnBvcnQ7XG4gICAgYXdhaXQgbmV3IFByb21pc2UocmVzb2x2ZSA9PiByZXNlcnZlLmNsb3NlKHJlc29sdmUpKTtcbiAgICBlbnYuV0VCTEFCRUxfVDMxX09SSUdJTiA9ICdodHRwOi8vMTI3LjAuMC4xOicgKyBwb3J0O1xuICAgIGVudi5XRUJMQUJFTF9UMzFfUlVOX0RJUiA9IHJ1bjtcbiAgICBjb25zdCB2aXRlQ29uZmlnID0gcGF0aC5qb2luKHJ1bnRpbWUsJ3ZpdGUuY29uZmlnLm1qcycpO1xuICAgIGF3YWl0IHdyaXRlRmlsZSh2aXRlQ29uZmlnLCAnaW1wb3J0IGNvbmZpZyBmcm9tICcgKyBKU09OLnN0cmluZ2lmeShwYXRoLmpvaW4oY29uZmlnUm9vdCwndml0ZS5jb25maWcudHMnKS5yZXBsYWNlQWxsKCdcXFxcJywnLycpKSArICc7XFxuZXhwb3J0IGRlZmF1bHQgey4uLmNvbmZpZywgY2FjaGVEaXI6JyArIEpTT04uc3RyaW5naWZ5KHBhdGguam9pbihydW50aW1lLCd2aXRlLWNhY2hlJykpICsgJ307XFxuJyk7XG4gICAgY29uc3QgYXJndiA9IFtwcm9jZXNzLmV4ZWNQYXRoLHBhdGguam9pbihyb290LCdzY3JpcHRzL293bmVkLXZpdGUtc2VydmljZS5tanMnKSxyZXF1aXJlLnJlc29sdmUoJ3ZpdGUnKSx2aXRlQ29uZmlnLHBhdGguam9pbihyb290LCdhcHBzL3dlYicpLFN0cmluZyhwb3J0KV07XG4gICAgY29uc3QgbG9nID0gcGF0aC5qb2luKHJ1biwndml0ZS5sb2cnKTtcbiAgICBhd2FpdCB3cml0ZUZpbGUobG9nLCBKU09OLnN0cmluZ2lmeSh7YXJndixjd2Q6cm9vdH0pICsgJ1xcbicpO1xuICAgIGxldCB3cml0ZXMgPSBQcm9taXNlLnJlc29sdmUoKTtcbiAgICBzZXJ2aWNlUmVjb3JkID0geyBhcmd2LGN3ZDpyb290LGV4aXRfY29kZTpudWxsLHNpZ25hbDpudWxsLHNpZ25hbF9vYnNlcnZhdGlvbjonY2xvc2VfdW5vYnNlcnZlZCcsbG9nX3BhdGg6cmVsYXRpdmUobG9nKSx0ZXN0czpudWxsLHBhcnNlX3N0YXR1czonbm9uX3Rlc3QnLHNlcnZpY2U6dHJ1ZSxwb3J0LGNsZWFudXA6bnVsbCB9O1xuICAgIGNvbW1hbmRzLnB1c2goc2VydmljZVJlY29yZCk7XG4gICAgc2VydmljZSA9IHNwYXduKGFyZ3ZbMF0sYXJndi5zbGljZSgxKSx7Y3dkOnJvb3QsZW52LHNoZWxsOmZhbHNlLHdpbmRvd3NIaWRlOnRydWUsZGV0YWNoZWQ6cHJvY2Vzcy5wbGF0Zm9ybSAhPT0gJ3dpbjMyJyxzdGRpbzpbJ3BpcGUnLCdwaXBlJywncGlwZSddfSk7XG4gICAgc2VydmljZS5zdGRpbi5vbignZXJyb3InLGVycm9yID0+IHsgc2VydmljZVJlY29yZC5zdGRpbl9lcnJvcj1lcnJvci5tZXNzYWdlOyB9KTtcbiAgICBsZXQgc3Bhd25FcnJvciA9IG51bGw7XG4gICAgc2VydmljZS5vbmNlKCdlcnJvcicsZXJyb3IgPT4geyBzcGF3bkVycm9yID0gZXJyb3I7IH0pO1xuICAgIGZvciAoY29uc3Qgc3RyZWFtIG9mIFtzZXJ2aWNlLnN0ZG91dCxzZXJ2aWNlLnN0ZGVycl0pIHN0cmVhbS5vbignZGF0YScsY2h1bmsgPT4geyBwcm9jZXNzLnN0ZG91dC53cml0ZShjaHVuayk7IHdyaXRlcyA9IHdyaXRlcy50aGVuKCgpID0+IGFwcGVuZEZpbGUobG9nLGNodW5rKSk7IH0pO1xuICAgIHNlcnZpY2VEb25lID0gbmV3IFByb21pc2UocmVzb2x2ZSA9PiBzZXJ2aWNlLm9uY2UoJ2Nsb3NlJywoY29kZSxzaWduYWwpID0+IHsgc2VydmljZVJlY29yZC5leGl0X2NvZGU9Y29kZTsgc2VydmljZVJlY29yZC5zaWduYWw9c2lnbmFsOyBzZXJ2aWNlUmVjb3JkLnNpZ25hbF9vYnNlcnZhdGlvbj0nbmF0aXZlX2Nsb3NlJzsgcmVzb2x2ZSgpOyB9KSkudGhlbihhc3luYyAoKSA9PiB7IGF3YWl0IHdyaXRlczsgYXdhaXQgcmVmZXJlbmNlKGxvZyk7IH0pO1xuICAgIGNvbnN0IGRlYWRsaW5lID0gRGF0ZS5ub3coKSszMDAwMDtcbiAgICB3aGlsZSAodHJ1ZSkge1xuICAgICAgaWYgKGludGVycnVwdGVkKSB0aHJvdyBuZXcgUHJlcmVxdWlzaXRlKCdDYW5jZWxsZWQgZHVyaW5nIHJlYWRpbmVzcycpO1xuICAgICAgaWYgKHNwYXduRXJyb3IpIHRocm93IHNwYXduRXJyb3I7XG4gICAgICBpZiAoc2VydmljZS5leGl0Q29kZSAhPT0gbnVsbCkgdGhyb3cgbmV3IEVycm9yKCdWaXRlIGV4aXRlZCBiZWZvcmUgcmVhZGluZXNzOiAnK3NlcnZpY2UuZXhpdENvZGUpO1xuICAgICAgdHJ5IHsgaWYgKChhd2FpdCBmZXRjaChlbnYuV0VCTEFCRUxfVDMxX09SSUdJTix7c2lnbmFsOkFib3J0U2lnbmFsLnRpbWVvdXQoMTAwMCl9KSkub2spIGJyZWFrOyB9IGNhdGNoIHt9XG4gICAgICBpZiAoRGF0ZS5ub3coKT5kZWFkbGluZSkgdGhyb3cgbmV3IEVycm9yKCdWaXRlIHJlYWRpbmVzcyB0aW1lZCBvdXQnKTtcbiAgICAgIGF3YWl0IHBhdXNlKDEwMCk7XG4gICAgfVxuICAgIHN0YXR1cz0nZmFpbGVkJztcbiAgICBhd2FpdCBleGVjdXRlKCdoYXJkd2FyZScsWydwbnBtJywnZXhlYycsJ3BsYXl3cmlnaHQnLCd0ZXN0JywnLS1jb25maWc9JytwYXRoLmpvaW4oY29uZmlnUm9vdCwncGxheXdyaWdodC5jb25maWcudHMnKSwnLS1wcm9qZWN0PXRhcmdldC1oYXJkd2FyZSddKTtcbiAgICBzdGF0dXM9J3Bhc3NlZCc7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgaWYgKCEoZXJyb3IgaW5zdGFuY2VvZiBQcmVyZXF1aXNpdGUpICYmIGVycm9yLmNvZGUgIT09ICdFTk9FTlQnKSBzdGF0dXM9J2ZhaWxlZCc7XG4gICAgYmxvY2tlcnMucHVzaChlcnJvci5tZXNzYWdlKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAoc2VydmljZURvbmUpIHtcbiAgICAgIGNvbnN0IHVuZXhwZWN0ZWRFeGl0ID0gc2VydmljZS5leGl0Q29kZSAhPT0gbnVsbCB8fCBzZXJ2aWNlLnNpZ25hbENvZGUgIT09IG51bGw7XG4gICAgICBpZiAodW5leHBlY3RlZEV4aXQpIHsgc3RhdHVzPSdmYWlsZWQnOyBibG9ja2Vycy5wdXNoKCdPd25lZCBWaXRlIGV4aXRlZCBiZWZvcmUgY2xlYW51cCcpOyB9XG4gICAgICBzZXJ2aWNlUmVjb3JkLmNsZWFudXAgPSB7IHJlcXVlc3RlZDogIXVuZXhwZWN0ZWRFeGl0LCB1bmV4cGVjdGVkX2V4aXRfYmVmb3JlX2NsZWFudXA6IHVuZXhwZWN0ZWRFeGl0LCBiYWNrc3RvcDogbnVsbCB9O1xuICAgICAgaWYgKCF1bmV4cGVjdGVkRXhpdCkge1xuICAgICAgICBzZXJ2aWNlUmVjb3JkLmNsZWFudXAubWV0aG9kPSdvd25lZF9zdGRpbl9lb2YnO1xuICAgICAgICBzZXJ2aWNlLnN0ZGluLmVuZCgpO1xuICAgICAgICBjb25zdCBzZXR0bGVkID0gYXdhaXQgc2V0dGxlV2l0aGluKHNlcnZpY2VEb25lLDUwMDApO1xuICAgICAgICBpZiAoIXNldHRsZWQpIHtcbiAgICAgICAgICBzdGF0dXM9J2ZhaWxlZCc7IGJsb2NrZXJzLnB1c2goJ093bmVkIFZpdGUgZmFpbGVkIGJvdW5kZWQgY2xlYW51cDsgZm9yY2VkIGJhY2tzdG9wIHJlcXVpcmVkJyk7XG4gICAgICAgICAgc2VydmljZVJlY29yZC5jbGVhbnVwLmJhY2tzdG9wPSdmb3JjZWRfb3duZWRfdHJlZSc7XG4gICAgICAgICAgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09ICd3aW4zMicpIHsgdHJ5IHsgYXdhaXQgZXhlY3V0ZSgndml0ZS1iYWNrc3RvcCcsWyd0YXNra2lsbC5leGUnLCcvUElEJyxTdHJpbmcoc2VydmljZS5waWQpLCcvVCcsJy9GJ10scm9vdCx0cnVlKTsgfSBjYXRjaChlcnJvcikgeyBibG9ja2Vycy5wdXNoKGVycm9yLm1lc3NhZ2UpOyB9IH1cbiAgICAgICAgICBlbHNlIHsgdHJ5IHsgcHJvY2Vzcy5raWxsKC1zZXJ2aWNlLnBpZCwnU0lHS0lMTCcpOyB9IGNhdGNoKGVycm9yKSB7IGJsb2NrZXJzLnB1c2goZXJyb3IubWVzc2FnZSk7IH0gfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgICBjb25zdCBjbG9zZWQgPSBhd2FpdCBzZXR0bGVXaXRoaW4oc2VydmljZURvbmUsNTAwMCk7XG4gICAgICBzZXJ2aWNlUmVjb3JkLmNsZWFudXAuY2xvc2Vfb2JzZXJ2ZWQ9Y2xvc2VkO1xuICAgICAgaWYgKCFjbG9zZWQpIHsgc3RhdHVzPSdmYWlsZWQnOyBibG9ja2Vycy5wdXNoKCdPd25lZCBWaXRlIG5hdGl2ZSBjbG9zZSB1bm9ic2VydmVkIGFmdGVyIGZvcmNlZCBiYWNrc3RvcCcpOyB9XG4gICAgICBlbHNlIGlmIChzZXJ2aWNlUmVjb3JkLmV4aXRfY29kZSAhPT0gMCB8fCBzZXJ2aWNlUmVjb3JkLnNpZ25hbCAhPT0gbnVsbCB8fCBzZXJ2aWNlUmVjb3JkLnN0ZGluX2Vycm9yKSB7IHN0YXR1cz0nZmFpbGVkJzsgYmxvY2tlcnMucHVzaCgnT3duZWQgVml0ZSBjbGVhbnVwIGRpZCBub3QgY2xvc2Ugbm9ybWFsbHk6IGV4aXQ9JytzZXJ2aWNlUmVjb3JkLmV4aXRfY29kZSsnLCBzaWduYWw9JytzZXJ2aWNlUmVjb3JkLnNpZ25hbCsoc2VydmljZVJlY29yZC5zdGRpbl9lcnJvciA/ICcsIHN0ZGluPScrc2VydmljZVJlY29yZC5zdGRpbl9lcnJvciA6ICcnKSk7IH1cbiAgICAgIHRyeSB7XG4gICAgICAgIHNlcnZpY2VSZWNvcmQuY2xlYW51cC5wb3J0X2Nsb3NlZD1hd2FpdCBwb3J0Q2xvc2VkKHNlcnZpY2VSZWNvcmQucG9ydCk7XG4gICAgICAgIGlmICghc2VydmljZVJlY29yZC5jbGVhbnVwLnBvcnRfY2xvc2VkKSB7IHN0YXR1cz0nZmFpbGVkJzsgYmxvY2tlcnMucHVzaCgnT3duZWQgVml0ZSBsaXN0ZW5lciByZW1haW5lZCBvcGVuIGFmdGVyIGNsZWFudXAnKTsgfVxuICAgICAgfSBjYXRjaCAoZXJyb3IpIHsgc3RhdHVzPSdmYWlsZWQnOyBibG9ja2Vycy5wdXNoKGVycm9yLm1lc3NhZ2UpOyB9XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICBicm93c2VyID0gcGFyc2VCcm93c2VyUmVwb3J0KGF3YWl0IG9wdGlvbmFsVGV4dChwYXRoLmpvaW4ocnVuLCdicm93c2VyLXJlc3VsdHMuanNvbicpKSk7XG4gICAgICBjb25zdCBjb21tYW5kID0gY29tbWFuZHMuZmluZChjb21tYW5kID0+IGNvbW1hbmQubG9nX3BhdGguZW5kc1dpdGgoJy9oYXJkd2FyZS5sb2cnKSk7XG4gICAgICBpZiAoY29tbWFuZCkgeyBjb21tYW5kLnRlc3RzPWJyb3dzZXIudGVzdHM7IGNvbW1hbmQucGFyc2Vfc3RhdHVzPWJyb3dzZXIucGFyc2Vfc3RhdHVzOyB9XG4gICAgICBpZiAoYnJvd3Nlci5zdGF0dXM9PT0nZmFpbGVkJykgeyBzdGF0dXM9J2ZhaWxlZCc7IGJsb2NrZXJzLnB1c2goYnJvd3Nlci5ibG9ja2VyKTsgfVxuICAgICAgZWxzZSBpZiAoYnJvd3Nlci5zdGF0dXM9PT0nYmxvY2tlZCcgJiYgc3RhdHVzIT09J2ZhaWxlZCcpIHsgc3RhdHVzPSdibG9ja2VkJzsgYmxvY2tlcnMucHVzaChicm93c2VyLmJsb2NrZXIpOyB9XG4gICAgICBpZiAoYnJvd3Nlci5wYXJzZV9zdGF0dXM9PT0ncGFyc2VkJykgYXdhaXQgcmVmZXJlbmNlKHBhdGguam9pbihydW4sJ2Jyb3dzZXItcmVzdWx0cy5qc29uJykpO1xuICAgICAgZm9yIChjb25zdCBjb3VudCBvZiBbMjAwMCwxMDAwMF0pIHtcbiAgICAgICAgY29uc3QgZmlsZT1wYXRoLmpvaW4ocnVuLCdzYW1wbGVzLScrY291bnQrJy5qc29uJyksIHRleHQ9YXdhaXQgb3B0aW9uYWxUZXh0KGZpbGUpO1xuICAgICAgICBpZiAodGV4dD09PW51bGwpIHsgaWYoc3RhdHVzIT09J2ZhaWxlZCcpIHN0YXR1cz0nYmxvY2tlZCc7IGJsb2NrZXJzLnB1c2goJ01pc3NpbmcgY3VycmVudCByYXcgc2FtcGxlczogJytjb3VudCk7IGNvbnRpbnVlOyB9XG4gICAgICAgIGF3YWl0IHJlZmVyZW5jZShmaWxlKTtcbiAgICAgICAgY29uc3Qgc2FtcGxlPUpTT04ucGFyc2UodGV4dCk7XG4gICAgICAgIGlmIChicm93c2VyLnN0YXR1cyAhPT0gJ3Bhc3NlZCcpIGNvbnRpbnVlOyAvLyBQYXJ0aWFsIGZhaWx1cmUgc2FtcGxlcyBzdGF5IHByZXNlcnZlZCwgbmV2ZXIgcHJvbW90ZWQuXG4gICAgICAgIGlmKHNhbXBsZS5jb3VudCE9PWNvdW50IHx8IHNhbXBsZS5zZWVkIT09MTcgfHwgc2FtcGxlLndhcm11cF9wZXJfc2NlbmFyaW8hPT00MCB8fCBzYW1wbGUuc2FtcGxlX2NvdW50X3Blcl9zY2VuYXJpbyE9PTEwMDAgfHwgSlNPTi5zdHJpbmdpZnkoc2FtcGxlLmNhbm9uaWNhbF9kaW1lbnNpb25zKSE9PSdbMjA0OCwyMDQ4XScpIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBmaXhlZCB3b3JrbG9hZCBtZXRhZGF0YTogJytjb3VudCk7XG4gICAgICAgIGlmKCFBcnJheS5pc0FycmF5KHNhbXBsZS5hZGFwdGVycykgfHwgIXNhbXBsZS5hZGFwdGVycy5sZW5ndGggfHwgaGFyZHdhcmVLaW5kKHNhbXBsZS5hZGFwdGVycy5hdCgtMSkpIT09J2hhcmR3YXJlJykgdGhyb3cgbmV3IFByZXJlcXVpc2l0ZSgnTm8gYWN0dWFsIG5vbi1zb2Z0d2FyZSBhZGFwdGVyIHByb29mOiAnK2NvdW50KTtcbiAgICAgICAgaWYoSlNPTi5zdHJpbmdpZnkoc2FtcGxlLmxvYWRlZF93YXNtX3NoYTI1NikhPT1KU09OLnN0cmluZ2lmeShbZW52aXJvbm1lbnQ/Lndhc20/LnNoYTI1Nl0pKSB0aHJvdyBuZXcgRXJyb3IoJ0FjdHVhbCBsb2FkZWQgV0FTTSBoYXNoIG1pc21hdGNoOiAnK2NvdW50KTtcbiAgICAgICAgY29uc3QgcGVyZm9ybWFuY2U9Z2F0ZShjb3VudCxzYW1wbGUuc2NlbmFyaW9zKTtcbiAgICAgICAgZm9yKGNvbnN0IHJvd3Mgb2YgT2JqZWN0LnZhbHVlcyhzYW1wbGUuc2NlbmFyaW9zKSkgaWYocm93cy5sZW5ndGghPT0xMDAwIHx8IHJvd3Muc29tZShyb3c9PnJvdy5uYXRpdmVfc3VibWlzc2lvbnMhPT0xKSkgdGhyb3cgbmV3IEVycm9yKCdJbnZhbGlkIGFjdHVhbCBuYXRpdmUgc3VibWlzc2lvbnM6ICcrY291bnQpO1xuICAgICAgICBpZihwZXJmb3JtYW5jZS5mYWlsdXJlcy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcihwZXJmb3JtYW5jZS5mYWlsdXJlcy5qb2luKCc7ICcpKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGVudmlyb25tZW50VGV4dD1hd2FpdCBvcHRpb25hbFRleHQocGF0aC5qb2luKHJ1biwnZW52aXJvbm1lbnQuanNvbicpKTtcbiAgICAgIGlmKGVudmlyb25tZW50VGV4dCE9PW51bGwpIHsgZW52aXJvbm1lbnQ9SlNPTi5wYXJzZShlbnZpcm9ubWVudFRleHQpOyBhd2FpdCByZWZlcmVuY2UocGF0aC5qb2luKHJ1biwnZW52aXJvbm1lbnQuanNvbicpKTsgfVxuICAgICAgaWYoc3RhdHVzPT09J3Bhc3NlZCcgJiYgKCFlbnZpcm9ubWVudD8uYnJvd3Nlcj8udmVyc2lvbiB8fCBlbnZpcm9ubWVudC5kcml2ZXI9PT0ndW5rbm93bicgfHwgIU51bWJlci5pc0Zpbml0ZShlbnZpcm9ubWVudC5kcHIpKSkgdGhyb3cgbmV3IFByZXJlcXVpc2l0ZSgnQWN0dWFsIGJyb3dzZXIvZHJpdmVyL0RQUiBwcm92ZW5hbmNlIHVuYXZhaWxhYmxlJyk7XG4gICAgICBhZnRlcj1jYXB0dXJlRXZpZGVuY2VJZGVudGl0eSh7IGVudjogZW52ID8/IHNhZmVFbnZpcm9ubWVudChydW50aW1lLCBydW50aW1lKSB9KTtcbiAgICAgIGlmKGJlZm9yZSAmJiBbJ3NvdXJjZV9zbmFwc2hvdF9zaGEyNTYnLCdtYW5pZmVzdF9zaGEyNTYnLCdydW5uZXJfc2hhMjU2J10uc29tZShrZXk9PmJlZm9yZVtrZXldIT09YWZ0ZXJba2V5XSkpIHRocm93IG5ldyBQcmVyZXF1aXNpdGUoJ1NvdXJjZSBjaGFuZ2VkIGR1cmluZyBHUFUgY29sbGVjdGlvbjsgY3VycmVudCBldmlkZW5jZSBub3QgY2VydGlmaWFibGUnKTtcbiAgICB9IGNhdGNoKGVycm9yKSB7IGlmKGVycm9yIGluc3RhbmNlb2YgUHJlcmVxdWlzaXRlIHx8IGVycm9yLmNvZGUgPT09ICdFTk9FTlQnKSB7IGlmKHN0YXR1cyE9PSdmYWlsZWQnKSBzdGF0dXM9J2Jsb2NrZWQnOyB9IGVsc2Ugc3RhdHVzPSdmYWlsZWQnOyBibG9ja2Vycy5wdXNoKGVycm9yLm1lc3NhZ2UpOyB9XG4gICAgaWYgKCFhZnRlcikgeyB0cnkgeyBhZnRlcj1jYXB0dXJlRXZpZGVuY2VJZGVudGl0eSh7IGVudjogZW52ID8/IHNhZmVFbnZpcm9ubWVudChydW50aW1lLCBydW50aW1lKSB9KTsgfSBjYXRjaChlcnJvcikgeyBpZihzdGF0dXMhPT0nZmFpbGVkJykgc3RhdHVzPSdibG9ja2VkJzsgYmxvY2tlcnMucHVzaCgnRmluYWwgaWRlbnRpdHkgdW5hdmFpbGFibGU6ICcrZXJyb3IubWVzc2FnZSk7IH0gfVxuICAgIGlmKGJlZm9yZSAmJiBhZnRlciAmJiBbJ3NvdXJjZV9zbmFwc2hvdF9zaGEyNTYnLCdtYW5pZmVzdF9zaGEyNTYnLCdydW5uZXJfc2hhMjU2J10uc29tZShrZXk9PmJlZm9yZVtrZXldIT09YWZ0ZXJba2V5XSkpIHsgaWYoc3RhdHVzIT09J2ZhaWxlZCcpIHN0YXR1cz0nYmxvY2tlZCc7IGlmKCFibG9ja2Vycy5pbmNsdWRlcygnU291cmNlIGNoYW5nZWQgZHVyaW5nIEdQVSBjb2xsZWN0aW9uOyBjdXJyZW50IGV2aWRlbmNlIG5vdCBjZXJ0aWZpYWJsZScpKSBibG9ja2Vycy5wdXNoKCdTb3VyY2UgY2hhbmdlZCBkdXJpbmcgR1BVIGNvbGxlY3Rpb247IGN1cnJlbnQgZXZpZGVuY2Ugbm90IGNlcnRpZmlhYmxlJyk7IH1cbiAgICBpZihpbnRlcnJ1cHRlZCkgeyBpZihzdGF0dXMhPT0nZmFpbGVkJykgc3RhdHVzPSdibG9ja2VkJzsgYmxvY2tlcnMucHVzaCgnQ2FuY2VsbGVkOyBoYXJkd2FyZSBnYXRlIG5vdCBjZXJ0aWZpZWQnKTsgfVxuICAgIHByb2Nlc3MucmVtb3ZlTGlzdGVuZXIoJ1NJR0lOVCcsb25TaWduYWwpOyBwcm9jZXNzLnJlbW92ZUxpc3RlbmVyKCdTSUdURVJNJyxvblNpZ25hbCk7XG4gICAgY29uc3QgcmVzdWx0PXtzY2hlbWFfdmVyc2lvbjoxLHRhc2tfaWQ6J1QzMScsZ2F0ZTonZ3B1JyxzdGF0dXMsYmFzZV9jb21taXQ6YmVmb3JlPy5zb3VyY2VfY29tbWl0Pz9udWxsLHNvdXJjZV9oYXNoZXM6YmVmb3JlPy5zb3VyY2VfaGFzaGVzPz9udWxsLG1hbmlmZXN0X3NoYTI1NjpiZWZvcmU/Lm1hbmlmZXN0X3NoYTI1Nj8/bnVsbCxpZGVudGl0eTpiZWZvcmUsaWRlbnRpdHlfYWZ0ZXI6YWZ0ZXIsdGltZTp7ZmluaXNoZWRfYXQ6bmV3IERhdGUoKS50b0lTT1N0cmluZygpfSxydW5fZGlyOnJlbGF0aXZlKHJ1biksZW52aXJvbm1lbnQsY29tbWFuZHMsdGVzdHM6YnJvd3Nlci50ZXN0cyxwYXJzZV9zdGF0dXM6YnJvd3Nlci5wYXJzZV9zdGF0dXMsZXZpZGVuY2VfcmVmcyxibG9ja2Vycyxza2lwcGVkX3Njb3BlOlsnc2VjdXJpdHknXSx0aHJlc2hvbGRzOntib3hlczoyMDAwLGNwdV9wOTVfbXM6OCxwb2ludGVyX2RvdWJsZV9yYWZfcHJveHlfcDk1X21zOjMzfSx3b3JrbG9hZDp7Y291bnRzOlsyMDAwLDEwMDAwXSxzZWVkOjE3LHdhcm11cF9wZXJfc2NlbmFyaW86NDAsc2FtcGxlX2NvdW50X3Blcl9zY2VuYXJpbzoxMDAwLHNjZW5hcmlvczpbJ3BvaW50ZXJfZHJhZycsJ3BhbicsJ3pvb20nLCdjb21taXR0ZWRfZWRpdCddfSxiYXNlbGluZV9kZWJ1Zzp7c3RhdHVzOidub3RfdmVyaWZpZWQnLGF2YWlsYWJsZTpmYWxzZSxjZXJ0aWZpZWRfaGFyZHdhcmVfZ2F0ZTpmYWxzZSxyZWFzb246J05vIGN1cnJlbnQtc291cmNlIGRlYnVnIGJhc2VsaW5lIGNvbGxlY3RlZDsgaGlzdG9yaWNhbCBUMjggcmVwb3J0cyBhcmUgbm90IGN1cnJlbnQgcHJvb2YnfSxrbm93bl9saW1pdHM6Wydkb3VibGUtckFGIHNjaGVkdWxpbmcgcHJveHksIG5vdCBwaHlzaWNhbCBwaG90b24gbGF0ZW5jeScsJ0NQVSBpbmNsdWRlcyBtZWFzdXJlbWVudCBpbnN0cnVtZW50YXRpb24nLCdMb2dpY2FsIHRleHR1cmUgYnl0ZXMgYXJlIG5vdCBwaHlzaWNhbCBWUkFNJywnR1BVIHRpbWVzdGFtcHMgbm90IG1lYXN1cmVkJ119O1xuICAgIGF3YWl0IHdyaXRlRmlsZShwYXRoLmpvaW4ocnVuLCdyZXN1bHQuanNvbicpLEpTT04uc3RyaW5naWZ5KHJlc3VsdCxudWxsLDIpLHtmbGFnOid3eCd9KTtcbiAgICBhd2FpdCB3cml0ZUZpbGUocGF0aC5qb2luKHJlcG9ydCwncmVzdWx0Lmpzb24nKSxKU09OLnN0cmluZ2lmeShyZXN1bHQsbnVsbCwyKSx7ZmxhZzond3gnfSk7XG4gICAgY29uc29sZS5sb2coSlNPTi5zdHJpbmdpZnkoe3N0YXR1cyx0ZXN0czpyZXN1bHQudGVzdHMscnVuOnJlc3VsdC5ydW5fZGlyLGJsb2NrZXJzfSxudWxsLDIpKTtcbiAgfVxuICByZXR1cm4gc3RhdHVzPT09J3Bhc3NlZCc/MDpzdGF0dXM9PT0nYmxvY2tlZCc/MjoxO1xufVxuaWYocHJvY2Vzcy5hcmd2WzFdICYmIHBhdGgucmVzb2x2ZShwcm9jZXNzLmFyZ3ZbMV0pPT09ZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKSBwcm9jZXNzLmV4aXRDb2RlPWF3YWl0IG1haW4oKTtcbiJdLCJtYXBwaW5ncyI6IkFBQUEsU0FBU0EsS0FBSyxRQUFRLG9CQUFvQjtBQUMxQyxTQUFTQyxLQUFLLEVBQUVDLFNBQVMsRUFBRUMsVUFBVSxFQUFFQyxRQUFRLEVBQUVDLElBQUksUUFBUSxrQkFBa0I7QUFDL0UsT0FBT0MsRUFBRSxNQUFNLFNBQVM7QUFDeEIsT0FBT0MsRUFBRSxNQUFNLFNBQVM7QUFDeEIsT0FBT0MsSUFBSSxNQUFNLFdBQVc7QUFDNUIsU0FBU0MsVUFBVSxFQUFFQyxVQUFVLFFBQVEsYUFBYTtBQUNwRCxTQUFTQyxZQUFZLEVBQUVDLGdCQUFnQixRQUFRLFVBQVU7QUFDekQsU0FBU0MsYUFBYSxRQUFRLGFBQWE7QUFDM0MsU0FBU0MsYUFBYSxRQUFRLFVBQVU7QUFDeEMsU0FBU0MsZUFBZSxFQUFFQyxpQkFBaUIsUUFBUSxtQ0FBbUM7QUFDdEYsU0FBU0MsdUJBQXVCLFFBQVEseUJBQXlCO0FBQ2pFLFNBQVNDLFdBQVcsRUFBRUMsT0FBTyxR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