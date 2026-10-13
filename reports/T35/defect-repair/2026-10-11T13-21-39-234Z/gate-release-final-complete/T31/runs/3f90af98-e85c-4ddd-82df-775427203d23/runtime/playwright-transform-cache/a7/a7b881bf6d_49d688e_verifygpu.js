// d0ba019f2359a4aa7c7b45862ed4ca4c75479fa7
import { spawn } from 'node:child_process';
import { mkdir, writeFile, appendFile, readFile, stat } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
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
    const argv = resolveArgv(['pnpm', '--filter', '@weblabel/web', 'exec', 'vite', '--config', viteConfig, '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--mode', 'test']);
    argv[0] = executable(argv[0], env);
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
      log_path: relative(log),
      tests: null,
      parse_status: 'non_test',
      service: true,
      cleanup: null
    };
    commands.push(serviceRecord);
    service = spawn(argv[0], argv.slice(1), {
      cwd: root,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
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
        if (process.platform === 'win32') {
          // Windows has no POSIX process-group SIGTERM. Record tree termination honestly.
          try {
            await execute('vite-owned-tree-stop', ['taskkill.exe', '/PID', String(service.pid), '/T'], root, true);
          } catch (error) {
            serviceRecord.cleanup.initial_error = error.message;
            status = 'failed';
            blockers.push('Owned Vite stop failed: ' + error.message);
          }
        } else {
          try {
            process.kill(-service.pid, 'SIGTERM');
          } catch (error) {
            serviceRecord.cleanup.initial_error = error.message;
          }
        }
        const settled = await Promise.race([serviceDone.then(() => true), pause(5000).then(() => false)]);
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
      await serviceDone;
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJzcGF3biIsIm1rZGlyIiwid3JpdGVGaWxlIiwiYXBwZW5kRmlsZSIsInJlYWRGaWxlIiwic3RhdCIsImZzIiwib3MiLCJwYXRoIiwiY3JlYXRlSGFzaCIsInJhbmRvbVVVSUQiLCJjcmVhdGVTZXJ2ZXIiLCJjcmVhdGVSZXF1aXJlIiwiZmlsZVVSTFRvUGF0aCIsIm93bmVkUmVwb3J0Um9vdCIsInByb2plY3RPdXRwdXRQYXRoIiwiY2FwdHVyZUV2aWRlbmNlSWRlbnRpdHkiLCJyZXNvbHZlQXJndiIsInJ1bkFyZ3YiLCJyb290IiwicmVzb2x2ZSIsImRpcm5hbWUiLCJpbXBvcnQiLCJtZXRhIiwidXJsIiwiaGFyZHdhcmVLaW5kIiwiaW5mbyIsInRleHQiLCJKU09OIiwic3RyaW5naWZ5IiwidGVzdCIsImlzRmFsbGJhY2tBZGFwdGVyIiwic3VtbWFyaXplIiwic2FtcGxlcyIsIkFycmF5IiwiaXNBcnJheSIsImxlbmd0aCIsInNvbWUiLCJyb3ciLCJOdW1iZXIiLCJpc0Zpbml0ZSIsImNwdV9tcyIsImRvdWJsZV9yYWZfbXMiLCJzdWJtaXNzaW9ucyIsIkVycm9yIiwicDk1Iiwia2V5IiwibWFwIiwic29ydCIsImEiLCJiIiwiTWF0aCIsImNlaWwiLCJ2YWxpZF9zYW1wbGVzIiwiY3B1X3A5NV9tcyIsImRvdWJsZV9yYWZfcDk1X21zIiwiZ2F0ZSIsImNvdW50Iiwic2NlbmFyaW9zIiwic3VtbWFyaWVzIiwiT2JqZWN0IiwiZnJvbUVudHJpZXMiLCJuYW1lIiwiZmFpbHVyZXMiLCJlbnRyaWVzIiwiZmxhdE1hcCIsImZpbHRlciIsIkJvb2xlYW4iLCJzaGEiLCJieXRlcyIsInVwZGF0ZSIsImRpZ2VzdCIsInJlbGF0aXZlIiwiZmlsZSIsInJlcGxhY2VBbGwiLCJwYXVzZSIsIm1zIiwiUHJvbWlzZSIsInNldFRpbWVvdXQiLCJQcmVyZXF1aXNpdGUiLCJwYXJzZUdwdUFyZ3MiLCJhcmdzIiwic3RhcnRzV2l0aCIsImlzQWJzb2x1dGUiLCJwYXJzZUJyb3dzZXJSZXBvcnQiLCJ0ZXN0cyIsInBhcnNlX3N0YXR1cyIsInN0YXR1cyIsImJsb2NrZXIiLCJyZXBvcnQiLCJwYXJzZSIsInN0YXRzIiwibmFtZXMiLCJpc1NhZmVJbnRlZ2VyIiwic3VpdGVzIiwiY2FzZXMiLCJ2aXNpdCIsInN1aXRlIiwic3BlY3MiLCJ1bmRlZmluZWQiLCJzcGVjIiwicHVzaCIsInRpdGxlIiwiZm9yRWFjaCIsImNvbGxlY3RlZCIsInJlZHVjZSIsIm4iLCJwYXNzZWQiLCJleHBlY3RlZCIsImZhaWxlZCIsInVuZXhwZWN0ZWQiLCJza2lwcGVkIiwiZmxha3kiLCJyZXF1aXJlZCIsImVycm9ycyIsImV2ZXJ5IiwiZXJyb3IiLCJtZXNzYWdlIiwic2FmZUVudmlyb25tZW50IiwicnVudGltZSIsInRhcmdldCIsImVudiIsInByb2Nlc3MiLCJhc3NpZ24iLCJURU1QIiwiVE1QIiwiVE1QRElSIiwiQ0FSR09fVEFSR0VUX0RJUiIsIkNBUkdPX05FVF9PRkZMSU5FIiwiUlVTVFVQX0FVVE9fSU5TVEFMTCIsIkNPUkVQQUNLX0VOQUJMRV9ORVRXT1JLIiwiV0VCTEFCRUxfU0tJUF9TRUNVUklUWSIsImV4ZWN1dGFibGUiLCJleGlzdHNTeW5jIiwiZXh0ZW5zaW9ucyIsInBsYXRmb3JtIiwiUEFUSEVYVCIsInNwbGl0IiwiZGlyZWN0b3J5IiwiUEFUSCIsImRlbGltaXRlciIsImV4dGVuc2lvbiIsImNhbmRpZGF0ZSIsImpvaW4iLCJ0b0xvd2VyQ2FzZSIsInN0YXRTeW5jIiwiaXNGaWxlIiwib3B0aW9uYWxUZXh0IiwiY29kZSIsIm1haW4iLCJhcmd2Iiwic2xpY2UiLCJyZXF1ZXN0ZWQiLCJEYXRlIiwidG9JU09TdHJpbmciLCJjb25zb2xlIiwicnVuIiwicmVjdXJzaXZlIiwiY29uZmlnUm9vdCIsImNvbW1hbmRzIiwiYmxvY2tlcnMiLCJldmlkZW5jZV9yZWZzIiwiYmVmb3JlIiwiYWZ0ZXIiLCJlbnZpcm9ubWVudCIsImJyb3dzZXIiLCJzZXJ2aWNlIiwic2VydmljZURvbmUiLCJzZXJ2aWNlUmVjb3JkIiwiaW50ZXJydXB0ZWQiLCJvblNpZ25hbCIsIm9uIiwicmVmZXJlbmNlIiwicmVmIiwic2hhMjU2IiwiZXhlY3V0ZSIsImlucHV0IiwiY3dkIiwiY2xlYW51cCIsImxvZyIsIndyaXRlcyIsInRlZSIsImNodW5rIiwidGhlbiIsInJlY29yZCIsImV4aXRfY29kZSIsInNpZ25hbCIsInNpZ25hbF9vYnNlcnZhdGlvbiIsInJ1bm5lcl9leGl0X2NvZGUiLCJsb2dfcGF0aCIsIm9uU3Rkb3V0Iiwib25TdGRlcnIiLCJvbkNsb3NlIiwiZXhpdENvZGUiLCJvdXRwdXQiLCJpbmNsdWRlcyIsImJhc2VuYW1lIiwic3VwcGxpZWQiLCJidWlsZFRhcmdldCIsImNhcmdvQ3dkIiwiV0VCTEFCRUxfQ0FSR09fQ1dEIiwicmVhbHBhdGhTeW5jIiwiY2FyZ28iLCJiaW5kZ2VuIiwicmVxdWlyZSIsImRlcGVuZGVuY3kiLCJyZWxlYXNlIiwidmVyc2lvbiIsImFyY2giLCJjcHUiLCJjcHVzIiwibW9kZWwiLCJkcml2ZXIiLCJncHUiLCJkcHIiLCJzZWVkIiwidGFyZ2V0X2RpbWVuc2lvbnMiLCJ3YXNtX3Byb2ZpbGUiLCJjcmVkZW50aWFsX2Vudmlyb25tZW50IiwiYWNjb3VudF9zdGF0ZSIsInJhdyIsImluZGV4T2YiLCJkcml2ZXJfZXJyb3IiLCJ3YXNtT3V0cHV0Iiwid2FzbUZpbGUiLCJ3YXNtIiwic2l6ZSIsIldFQkxBQkVMX1dBU01fQlJJREdFX0RJUiIsIldFQkxBQkVMX0FQSV9CSU5BUlkiLCJhcGkiLCJob3N0IiwiZXhlY1BhdGgiLCJXRUJMQUJFTF9UMzBfSE9TVF9TQ1JJUFQiLCJyZXNlcnZlIiwicmVqZWN0Iiwib25jZSIsImxpc3RlbiIsInBvcnQiLCJhZGRyZXNzIiwiY2xvc2UiLCJXRUJMQUJFTF9UMzFfT1JJR0lOIiwiV0VCTEFCRUxfVDMxX1JVTl9ESVIiLCJ2aXRlQ29uZmlnIiwiU3RyaW5nIiwic2hlbGwiLCJ3aW5kb3dzSGlkZSIsImRldGFjaGVkIiwic3RkaW8iLCJzcGF3bkVycm9yIiwic3RyZWFtIiwic3Rkb3V0Iiwic3RkZXJyIiwid3JpdGUiLCJkZWFkbGluZSIsIm5vdyIsImZldGNoIiwiQWJvcnRTaWduYWwiLCJ0aW1lb3V0Iiwib2siLCJ1bmV4cGVjdGVkRXhpdCIsInNpZ25hbENvZGUiLCJ1bmV4cGVjdGVkX2V4aXRfYmVmb3JlX2NsZWFudXAiLCJiYWNrc3RvcCIsInBpZCIsImluaXRpYWxfZXJyb3IiLCJraWxsIiwic2V0dGxlZCIsInJhY2UiLCJjb21tYW5kIiwiZmluZCIsImVuZHNXaXRoIiwic2FtcGxlIiwid2FybXVwX3Blcl9zY2VuYXJpbyIsInNhbXBsZV9jb3VudF9wZXJfc2NlbmFyaW8iLCJjYW5vbmljYWxfZGltZW5zaW9ucyIsImFkYXB0ZXJzIiwiYXQiLCJsb2FkZWRfd2FzbV9zaGEyNTYiLCJwZXJmb3JtYW5jZSIsInJvd3MiLCJ2YWx1ZXMiLCJuYXRpdmVfc3VibWlzc2lvbnMiLCJlbnZpcm9ubWVudFRleHQiLCJyZW1vdmVMaXN0ZW5lciIsInJlc3VsdCIsInNjaGVtYV92ZXJzaW9uIiwidGFza19pZCIsImJhc2VfY29tbWl0Iiwic291cmNlX2NvbW1pdCIsInNvdXJjZV9oYXNoZXMiLCJtYW5pZmVzdF9zaGEyNTYiLCJpZGVudGl0eSIsImlkZW50aXR5X2FmdGVyIiwidGltZSIsImZpbmlzaGVkX2F0IiwicnVuX2RpciIsInNraXBwZWRfc2NvcGUiLCJ0aHJlc2hvbGRzIiwiYm94ZXMiLCJwb2ludGVyX2RvdWJsZV9yYWZfcHJveHlfcDk1X21zIiwid29ya2xvYWQiLCJjb3VudHMiLCJiYXNlbGluZV9kZWJ1ZyIsImF2YWlsYWJsZSIsImNlcnRpZmllZF9oYXJkd2FyZV9nYXRlIiwicmVhc29uIiwia25vd25fbGltaXRzIiwiZmxhZyJdLCJzb3VyY2VzIjpbInZlcmlmeS1ncHUubWpzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHNwYXduIH0gZnJvbSAnbm9kZTpjaGlsZF9wcm9jZXNzJztcbmltcG9ydCB7IG1rZGlyLCB3cml0ZUZpbGUsIGFwcGVuZEZpbGUsIHJlYWRGaWxlLCBzdGF0IH0gZnJvbSAnbm9kZTpmcy9wcm9taXNlcyc7XG5pbXBvcnQgZnMgZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgb3MgZnJvbSAnbm9kZTpvcyc7XG5pbXBvcnQgcGF0aCBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0IHsgY3JlYXRlSGFzaCwgcmFuZG9tVVVJRCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcbmltcG9ydCB7IGNyZWF0ZVNlcnZlciB9IGZyb20gJ25vZGU6bmV0JztcbmltcG9ydCB7IGNyZWF0ZVJlcXVpcmUgfSBmcm9tICdub2RlOm1vZHVsZSc7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSAnbm9kZTp1cmwnO1xuaW1wb3J0IHsgb3duZWRSZXBvcnRSb290LCBwcm9qZWN0T3V0cHV0UGF0aCB9IGZyb20gJy4uL3Rlc3RzL3N1cHBvcnQvcmVwb3J0LXBhdGhzLm1qcyc7XG5pbXBvcnQgeyBjYXB0dXJlRXZpZGVuY2VJZGVudGl0eSB9IGZyb20gJy4vZXZpZGVuY2UtaWRlbnRpdHkubWpzJztcbmltcG9ydCB7IHJlc29sdmVBcmd2LCBydW5Bcmd2IH0gZnJvbSAnLi90YXNrLm1qcyc7XG5cbmNvbnN0IHJvb3QgPSBwYXRoLnJlc29sdmUocGF0aC5kaXJuYW1lKGZpbGVVUkxUb1BhdGgoaW1wb3J0Lm1ldGEudXJsKSksICcuLicpO1xyXG5leHBvcnQgZnVuY3Rpb24gaGFyZHdhcmVLaW5kKGluZm8pIHtcclxuICBjb25zdCB0ZXh0ID0gSlNPTi5zdHJpbmdpZnkoaW5mbyk7XHJcbiAgaWYgKC9zd2lmdHNoYWRlcnxsbHZtcGlwZXxsYXZhcGlwZXxzb2Z0d2FyZXxiYXNpYyByZW5kZXJ8ZGV2aWNlX3R5cGUuPz0uP0NwdS9pLnRlc3QodGV4dCkgfHwgaW5mbz8uaXNGYWxsYmFja0FkYXB0ZXIgPT09IHRydWUpIHJldHVybiAnc29mdHdhcmUnO1xyXG4gIGlmICgvbnZpZGlhfGludGVsfGFtZHxhcHBsZXxibGFja3dlbGx8RGlzY3JldGVHcHV8SW50ZWdyYXRlZEdwdS9pLnRlc3QodGV4dCkpIHJldHVybiAnaGFyZHdhcmUnO1xyXG4gIHJldHVybiAndW5rbm93bic7XHJcbn1cclxuZXhwb3J0IGZ1bmN0aW9uIHN1bW1hcml6ZShzYW1wbGVzKSB7XHJcbiAgaWYgKCFBcnJheS5pc0FycmF5KHNhbXBsZXMpIHx8IHNhbXBsZXMubGVuZ3RoIDwgMTAwMCB8fCBzYW1wbGVzLnNvbWUocm93ID0+ICFOdW1iZXIuaXNGaW5pdGUocm93LmNwdV9tcykgfHwgcm93LmNwdV9tcyA8IDAgfHwgIU51bWJlci5pc0Zpbml0ZShyb3cuZG91YmxlX3JhZl9tcykgfHwgcm93LmRvdWJsZV9yYWZfbXMgPCAwIHx8IHJvdy5zdWJtaXNzaW9ucyAhPT0gMSkpIHRocm93IG5ldyBFcnJvcignSW52YWxpZCB3b3JrbG9hZDogcmVxdWlyZSA+PTEwMDAgZmluaXRlIHNhbXBsZXMsIGVhY2ggd2l0aCBvbmUgYWN0dWFsIEdQVSBzdWJtaXNzaW9uOyBubyBmaWx0ZXJpbmcnKTtcclxuICBjb25zdCBwOTUgPSBrZXkgPT4gc2FtcGxlcy5tYXAocm93ID0+IHJvd1trZXldKS5zb3J0KChhLCBiKSA9PiBhIC0gYilbTWF0aC5jZWlsKHNhbXBsZXMubGVuZ3RoICogMC45NSkgLSAxXTtcclxuICByZXR1cm4geyB2YWxpZF9zYW1wbGVzOiBzYW1wbGVzLmxlbmd0aCwgY3B1X3A5NV9tczogcDk1KCdjcHVfbXMnKSwgZG91YmxlX3JhZl9wOTVfbXM6IHA5NSgnZG91YmxlX3JhZl9tcycpIH07XHJcbn1cclxuZXhwb3J0IGZ1bmN0aW9uIGdhdGUoY291bnQsIHNjZW5hcmlvcykge1xyXG4gIGNvbnN0IHN1bW1hcmllcyA9IE9iamVjdC5mcm9tRW50cmllcyhbJ3BvaW50ZXJfZHJhZycsICdwYW4nLCAnem9vbScsICdjb21taXR0ZWRfZWRpdCddLm1hcChuYW1lID0+IFtuYW1lLCBzdW1tYXJpemUoc2NlbmFyaW9zW25hbWVdKV0pKTtcclxuICBjb25zdCBmYWlsdXJlcyA9IGNvdW50ID09PSAyMDAwID8gT2JqZWN0LmVudHJpZXMoc3VtbWFyaWVzKS5mbGF0TWFwKChbbmFtZSwgcm93XSkgPT4gW3Jvdy5jcHVfcDk1X21zID4gOCA/IGAke25hbWV9OiBDUFUgUDk1ICR7cm93LmNwdV9wOTVfbXN9ID4gOG1zYCA6IG51bGwsIHJvdy5kb3VibGVfcmFmX3A5NV9tcyA+IDMzID8gYCR7bmFtZX06IGRvdWJsZS1yQUYgcHJveHkgUDk1ICR7cm93LmRvdWJsZV9yYWZfcDk1X21zfSA+IDMzbXNgIDogbnVsbF0uZmlsdGVyKEJvb2xlYW4pKSA6IFtdO1xyXG4gIHJldHVybiB7IHN1bW1hcmllcywgZmFpbHVyZXMgfTtcclxufVxyXG5cclxuY29uc3Qgc2hhID0gYnl0ZXMgPT4gY3JlYXRlSGFzaCgnc2hhMjU2JykudXBkYXRlKGJ5dGVzKS5kaWdlc3QoJ2hleCcpO1xuY29uc3QgcmVsYXRpdmUgPSBmaWxlID0+IHBhdGgucmVsYXRpdmUocm9vdCwgZmlsZSkucmVwbGFjZUFsbCgnXFxcXCcsICcvJyk7XG5jb25zdCBwYXVzZSA9IG1zID0+IG5ldyBQcm9taXNlKHJlc29sdmUgPT4gc2V0VGltZW91dChyZXNvbHZlLCBtcykpO1xuY2xhc3MgUHJlcmVxdWlzaXRlIGV4dGVuZHMgRXJyb3Ige31cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUdwdUFyZ3MoYXJncykge1xuICBpZiAoIWFyZ3MubGVuZ3RoKSByZXR1cm4gbnVsbDtcbiAgaWYgKGFyZ3MubGVuZ3RoICE9PSAyIHx8IGFyZ3NbMF0gIT09ICctLXJlcG9ydC1kaXInIHx8ICFhcmdzWzFdIHx8IGFyZ3NbMV0uc3RhcnRzV2l0aCgnLS0nKSB8fCBwYXRoLmlzQWJzb2x1dGUoYXJnc1sxXSkpIHRocm93IG5ldyBFcnJvcignSU5WQUxJRF9BUkdVTUVOVFMnKTtcbiAgcmV0dXJuIGFyZ3NbMV07XG59XG5leHBvcnQgZnVuY3Rpb24gcGFyc2VCcm93c2VyUmVwb3J0KHRleHQpIHtcbiAgaWYgKHRleHQgPT09IG51bGwpIHJldHVybiB7IHRlc3RzOiBudWxsLCBwYXJzZV9zdGF0dXM6ICdtaXNzaW5nJywgc3RhdHVzOiAnYmxvY2tlZCcsIGJsb2NrZXI6ICdDdXJyZW50IFBsYXl3cmlnaHQgSlNPTiBpcyBtaXNzaW5nJyB9O1xuICB0cnkge1xuICAgIGNvbnN0IHJlcG9ydCA9IEpTT04ucGFyc2UodGV4dCksIHN0YXRzID0gcmVwb3J0LnN0YXRzO1xuICAgIGNvbnN0IG5hbWVzID0gWydleHBlY3RlZCcsICd1bmV4cGVjdGVkJywgJ3NraXBwZWQnLCAnZmxha3knXTtcbiAgICBpZiAoIXN0YXRzIHx8IG5hbWVzLnNvbWUoa2V5ID0+ICFOdW1iZXIuaXNTYWZlSW50ZWdlcihzdGF0c1trZXldKSB8fCBzdGF0c1trZXldIDwgMCkgfHwgIUFycmF5LmlzQXJyYXkocmVwb3J0LnN1aXRlcykpIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBuYXRpdmUgUGxheXdyaWdodCBzdGF0cy9zdWl0ZXMnKTtcbiAgICBjb25zdCBjYXNlcyA9IFtdO1xuICAgIGZ1bmN0aW9uIHZpc2l0KHN1aXRlKSB7XG4gICAgICBpZiAoKHN1aXRlLnNwZWNzICE9PSB1bmRlZmluZWQgJiYgIUFycmF5LmlzQXJyYXkoc3VpdGUuc3BlY3MpKSB8fCAoc3VpdGUuc3VpdGVzICE9PSB1bmRlZmluZWQgJiYgIUFycmF5LmlzQXJyYXkoc3VpdGUuc3VpdGVzKSkpIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBuYXRpdmUgUGxheXdyaWdodCBzdWl0ZScpO1xuICAgICAgZm9yIChjb25zdCBzcGVjIG9mIHN1aXRlLnNwZWNzID8/IFtdKSB7XG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShzcGVjLnRlc3RzKSkgdGhyb3cgbmV3IEVycm9yKCdJbnZhbGlkIG5hdGl2ZSBQbGF5d3JpZ2h0IHRlc3RzJyk7XG4gICAgICAgIGZvciAoY29uc3QgdGVzdCBvZiBzcGVjLnRlc3RzKSBjYXNlcy5wdXNoKHsgdGl0bGU6IHNwZWMudGl0bGUsIHN0YXR1czogdGVzdC5zdGF0dXMgfSk7XG4gICAgICB9XG4gICAgICAoc3VpdGUuc3VpdGVzID8/IFtdKS5mb3JFYWNoKHZpc2l0KTtcbiAgICB9XG4gICAgcmVwb3J0LnN1aXRlcy5mb3JFYWNoKHZpc2l0KTtcbiAgICBjb25zdCB0ZXN0cyA9IHsgY29sbGVjdGVkOiBuYW1lcy5yZWR1Y2UoKG4sIGtleSkgPT4gbiArIHN0YXRzW2tleV0sIDApLCBwYXNzZWQ6IHN0YXRzLmV4cGVjdGVkLCBmYWlsZWQ6IHN0YXRzLnVuZXhwZWN0ZWQsIHNraXBwZWQ6IHN0YXRzLnNraXBwZWQsIGZsYWt5OiBzdGF0cy5mbGFreSB9O1xuICAgIGlmIChjYXNlcy5sZW5ndGggIT09IHRlc3RzLmNvbGxlY3RlZCB8fCBuYW1lcy5zb21lKG5hbWUgPT4gY2FzZXMuZmlsdGVyKHRlc3QgPT4gdGVzdC5zdGF0dXMgPT09IG5hbWUpLmxlbmd0aCAhPT0gc3RhdHNbbmFtZV0pKSB0aHJvdyBuZXcgRXJyb3IoJ1BsYXl3cmlnaHQgc3RhdHMgZG8gbm90IG1hdGNoIG5hdGl2ZSB0ZXN0IGNhc2VzJyk7XG4gICAgY29uc3QgcmVxdWlyZWQgPSBbMjAwMCwgMTAwMDBdLm1hcChjb3VudCA9PiBjb3VudCArICcgZml4ZWQgcmVsZWFzZSBXQVNNIGhhcmR3YXJlOiBmb3VyIHdhcm1lZCAxMDAwLXNhbXBsZSBzY2VuYXJpb3MgYW5kIGxpZmVjeWNsZScpO1xuICAgIHJlcXVpcmVkLnB1c2goJ3NvZnR3YXJlIGFuZCB1bmtub3duIGFkYXB0ZXJzIGNhbm5vdCBwYXNzIHRoZSBoYXJkd2FyZSBjbGFzc2lmaWVyIChub3QgaGFyZHdhcmUgZXZpZGVuY2UpJyk7XG4gICAgaWYgKHJlcG9ydC5lcnJvcnMgIT09IHVuZGVmaW5lZCAmJiAoIUFycmF5LmlzQXJyYXkocmVwb3J0LmVycm9ycykgfHwgcmVwb3J0LmVycm9ycy5sZW5ndGgpKSByZXR1cm4geyB0ZXN0cywgcGFyc2Vfc3RhdHVzOiAncGFyc2VkJywgc3RhdHVzOiAnZmFpbGVkJywgYmxvY2tlcjogJ1BsYXl3cmlnaHQgcmVwb3J0ZWQgZ2xvYmFsIGVycm9ycycgfTtcbiAgICBjb25zdCBwYXNzZWQgPSB0ZXN0cy5jb2xsZWN0ZWQgPT09IDMgJiYgdGVzdHMucGFzc2VkID09PSAzICYmICF0ZXN0cy5mYWlsZWQgJiYgIXRlc3RzLnNraXBwZWQgJiYgIXRlc3RzLmZsYWt5ICYmIHJlcXVpcmVkLmV2ZXJ5KHRpdGxlID0+IGNhc2VzLmZpbHRlcih0ZXN0ID0+IHRlc3QudGl0bGUgPT09IHRpdGxlKS5sZW5ndGggPT09IDEpO1xuICAgIHJldHVybiB7IHRlc3RzLCBwYXJzZV9zdGF0dXM6ICdwYXJzZWQnLCBzdGF0dXM6IHBhc3NlZCA/ICdwYXNzZWQnIDogJ2ZhaWxlZCcsIGJsb2NrZXI6IHBhc3NlZCA/IG51bGwgOiAnUmVxdWlyZSBleGFjdGx5IHRoZSB0aHJlZSBUMzEgdGVzdHMsIGFsbCBwYXNzZWQgd2l0aG91dCBza2lwcy9yZXRyaWVzJyB9O1xuICB9IGNhdGNoIChlcnJvcikgeyByZXR1cm4geyB0ZXN0czogbnVsbCwgcGFyc2Vfc3RhdHVzOiAnbWFsZm9ybWVkJywgc3RhdHVzOiAnZmFpbGVkJywgYmxvY2tlcjogZXJyb3IubWVzc2FnZSB9OyB9XG59XG5mdW5jdGlvbiBzYWZlRW52aXJvbm1lbnQocnVudGltZSwgdGFyZ2V0KSB7XG4gIGNvbnN0IGVudiA9IHt9O1xuICBmb3IgKGNvbnN0IGtleSBvZiBbJ1BBVEgnLCdQQVRIRVhUJywnU3lzdGVtUm9vdCcsJ1dJTkRJUicsJ0NPTVNQRUMnLCdVU0VSUFJPRklMRScsJ0hPTUUnLCdBUFBEQVRBJywnTE9DQUxBUFBEQVRBJywnUE5QTV9IT01FJywnQ09SRVBBQ0tfSE9NRScsJ0NBUkdPX0hPTUUnLCdSVVNUVVBfSE9NRScsJ1JVU1RVUF9UT09MQ0hBSU4nLCdSVVNUQycsJ1JVU1RET0MnLCdWQ0lOU1RBTExESVInLCdXaW5kb3dzU2RrRGlyJywnSU5DTFVERScsJ0xJQicsJ0xJQlBBVEgnXSkgaWYgKHByb2Nlc3MuZW52W2tleV0gIT09IHVuZGVmaW5lZCkgZW52W2tleV0gPSBwcm9jZXNzLmVudltrZXldO1xuICBPYmplY3QuYXNzaWduKGVudiwgeyBURU1QOiBydW50aW1lLCBUTVA6IHJ1bnRpbWUsIFRNUERJUjogcnVudGltZSwgQ0FSR09fVEFSR0VUX0RJUjogdGFyZ2V0LCBDQVJHT19ORVRfT0ZGTElORTogJ3RydWUnLCBSVVNUVVBfQVVUT19JTlNUQUxMOiAnMCcsIENPUkVQQUNLX0VOQUJMRV9ORVRXT1JLOiAnMCcsIFdFQkxBQkVMX1NLSVBfU0VDVVJJVFk6ICcxJyB9KTtcbiAgcmV0dXJuIGVudjtcbn1cbmZ1bmN0aW9uIGV4ZWN1dGFibGUobmFtZSwgZW52KSB7XG4gIGlmIChwYXRoLmlzQWJzb2x1dGUobmFtZSkpIHsgaWYgKGZzLmV4aXN0c1N5bmMobmFtZSkpIHJldHVybiBuYW1lOyB0aHJvdyBuZXcgUHJlcmVxdWlzaXRlKCdJbnN0YWxsZWQgZXhlY3V0YWJsZSBtaXNzaW5nOiAnICsgbmFtZSk7IH1cbiAgY29uc3QgZXh0ZW5zaW9ucyA9IHByb2Nlc3MucGxhdGZvcm0gPT09ICd3aW4zMicgPyAoZW52LlBBVEhFWFQgPz8gJy5FWEU7LkNNRDsuQkFUJykuc3BsaXQoJzsnKSA6IFsnJ107XG4gIGZvciAoY29uc3QgZGlyZWN0b3J5IG9mIChlbnYuUEFUSCA/PyAnJykuc3BsaXQocGF0aC5kZWxpbWl0ZXIpKSBmb3IgKGNvbnN0IGV4dGVuc2lvbiBvZiBbJycsIC4uLmV4dGVuc2lvbnNdKSB7XG4gICAgY29uc3QgY2FuZGlkYXRlID0gcGF0aC5qb2luKGRpcmVjdG9yeSwgbmFtZSArIGV4dGVuc2lvbi50b0xvd2VyQ2FzZSgpKTtcbiAgICBpZiAoZnMuZXhpc3RzU3luYyhjYW5kaWRhdGUpICYmIGZzLnN0YXRTeW5jKGNhbmRpZGF0ZSkuaXNGaWxlKCkpIHJldHVybiBjYW5kaWRhdGU7XG4gIH1cbiAgdGhyb3cgbmV3IFByZXJlcXVpc2l0ZSgnSW5zdGFsbGVkIGV4ZWN1dGFibGUgdW5hdmFpbGFibGU6ICcgKyBuYW1lKTtcbn1cbmFzeW5jIGZ1bmN0aW9uIG9wdGlvbmFsVGV4dChmaWxlKSB7XG4gIHRyeSB7IHJldHVybiBhd2FpdCByZWFkRmlsZShmaWxlLCAndXRmOCcpOyB9IGNhdGNoIChlcnJvcikgeyBpZiAoZXJyb3IuY29kZSA9PT0gJ0VOT0VOVCcpIHJldHVybiBudWxsOyB0aHJvdyBlcnJvcjsgfVxufVxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1haW4oYXJncyA9IHByb2Nlc3MuYXJndi5zbGljZSgyKSkge1xuICBsZXQgcmVwb3J0O1xuICB0cnkge1xuICAgIGNvbnN0IHJlcXVlc3RlZCA9IHBhcnNlR3B1QXJncyhhcmdzKTtcbiAgICByZXBvcnQgPSBvd25lZFJlcG9ydFJvb3QocmVxdWVzdGVkID8/ICgncmVwb3J0cy9UMzEvdmVyaWZpY2F0aW9uLycgKyBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkucmVwbGFjZUFsbCgnOicsJy0nKSArICctJyArIHJhbmRvbVVVSUQoKSkpO1xuICAgIGlmIChmcy5leGlzdHNTeW5jKHBhdGguam9pbihyZXBvcnQsICdyZXN1bHQuanNvbicpKSkgdGhyb3cgbmV3IEVycm9yKCdFWElTVElOR19SRVNVTFRfUkVGVVNFRCcpO1xuICB9IGNhdGNoIChlcnJvcikgeyBjb25zb2xlLmVycm9yKGVycm9yLm1lc3NhZ2UpOyByZXR1cm4gMTsgfVxuICBjb25zdCBydW4gPSBwYXRoLmpvaW4ocmVwb3J0LCAncnVucycsIHJhbmRvbVVVSUQoKSk7XG4gIGNvbnN0IHJ1bnRpbWUgPSBwYXRoLmpvaW4ocnVuLCAncnVudGltZScpO1xuICBhd2FpdCBta2RpcihydW50aW1lLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgY29uc3QgY29uZmlnUm9vdCA9IHBhdGguam9pbihyb290LCAncmVwb3J0cy9UMzEnKTtcbiAgY29uc3QgY29tbWFuZHMgPSBbXSwgYmxvY2tlcnMgPSBbXSwgZXZpZGVuY2VfcmVmcyA9IFtdO1xuICBsZXQgc3RhdHVzID0gJ2Jsb2NrZWQnLCBiZWZvcmUgPSBudWxsLCBhZnRlciA9IG51bGwsIGVudmlyb25tZW50ID0gbnVsbCwgYnJvd3NlciA9IHsgdGVzdHM6IG51bGwsIHBhcnNlX3N0YXR1czogJ25vdF9zdGFydGVkJyB9LCBzZXJ2aWNlID0gbnVsbCwgc2VydmljZURvbmUgPSBudWxsLCBzZXJ2aWNlUmVjb3JkID0gbnVsbDtcbiAgbGV0IGludGVycnVwdGVkID0gZmFsc2U7XG4gIGNvbnN0IG9uU2lnbmFsID0gKCkgPT4geyBpbnRlcnJ1cHRlZCA9IHRydWU7IH07XG4gIHByb2Nlc3Mub24oJ1NJR0lOVCcsIG9uU2lnbmFsKTsgcHJvY2Vzcy5vbignU0lHVEVSTScsIG9uU2lnbmFsKTtcbiAgbGV0IGVudjtcbiAgYXN5bmMgZnVuY3Rpb24gcmVmZXJlbmNlKGZpbGUpIHtcbiAgICBjb25zdCBieXRlcyA9IGF3YWl0IHJlYWRGaWxlKGZpbGUpO1xuICAgIGNvbnN0IHJlZiA9IHsgcGF0aDogcmVsYXRpdmUoZmlsZSksIHNoYTI1Njogc2hhKGJ5dGVzKSwgYnl0ZXM6IGJ5dGVzLmxlbmd0aCB9O1xuICAgIGV2aWRlbmNlX3JlZnMucHVzaChyZWYpOyByZXR1cm4gcmVmO1xuICB9XG4gIGFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGUobmFtZSwgaW5wdXQsIGN3ZCA9IHJvb3QsIGNsZWFudXAgPSBmYWxzZSkge1xuICAgIGlmIChpbnRlcnJ1cHRlZCAmJiAhY2xlYW51cCkgdGhyb3cgbmV3IFByZXJlcXVpc2l0ZSgnQ2FuY2VsbGVkIGJlZm9yZSAnICsgbmFtZSk7XG4gICAgY29uc3QgYXJndiA9IHJlc29sdmVBcmd2KGlucHV0KTtcbiAgICBhcmd2WzBdID0gZXhlY3V0YWJsZShhcmd2WzBdLCBlbnYpO1xuICAgIGNvbnN0IGxvZyA9IHBhdGguam9pbihydW4sIG5hbWUgKyAnLmxvZycpO1xuICAgIGF3YWl0IHdyaXRlRmlsZShsb2csIEpTT04uc3RyaW5naWZ5KHsgYXJndiwgY3dkIH0pICsgJ1xcbicpO1xuICAgIGxldCB3cml0ZXMgPSBQcm9taXNlLnJlc29sdmUoKTtcbiAgICBjb25zdCB0ZWUgPSBjaHVuayA9PiB7IHdyaXRlcyA9IHdyaXRlcy50aGVuKCgpID0+IGFwcGVuZEZpbGUobG9nLCBjaHVuaykpOyB9O1xuICAgIGNvbnN0IHJlY29yZCA9IHsgYXJndiwgY3dkLCBleGl0X2NvZGU6IG51bGwsIHNpZ25hbDogbnVsbCwgc2lnbmFsX29ic2VydmF0aW9uOiAnbm90X3NwYXduZWRfb3JfY2xvc2VfdW5vYnNlcnZlZCcsIHJ1bm5lcl9leGl0X2NvZGU6IG51bGwsIGxvZ19wYXRoOiByZWxhdGl2ZShsb2cpLCB0ZXN0czogbnVsbCwgcGFyc2Vfc3RhdHVzOiAnbm9uX3Rlc3QnIH07XG4gICAgY29tbWFuZHMucHVzaChyZWNvcmQpO1xuICAgIHRyeSB7IHJlY29yZC5ydW5uZXJfZXhpdF9jb2RlID0gYXdhaXQgcnVuQXJndihhcmd2LCBjd2QsIHsgZW52LCBvblN0ZG91dDogdGVlLCBvblN0ZGVycjogdGVlLCBvbkNsb3NlOiAoZXhpdENvZGUsIHNpZ25hbCkgPT4geyByZWNvcmQuZXhpdF9jb2RlID0gZXhpdENvZGU7IHJlY29yZC5zaWduYWwgPSBzaWduYWw7IHJlY29yZC5zaWduYWxfb2JzZXJ2YXRpb24gPSAnbmF0aXZlX2Nsb3NlJzsgfSB9KTsgfVxuICAgIGZpbmFsbHkgeyBhd2FpdCB3cml0ZXM7IGF3YWl0IHJlZmVyZW5jZShsb2cpOyB9XG4gICAgaWYgKHJlY29yZC5ydW5uZXJfZXhpdF9jb2RlICE9PSAwKSB7XG4gICAgICBjb25zdCBvdXRwdXQgPSBhd2FpdCByZWFkRmlsZShsb2csJ3V0ZjgnKTtcbiAgICAgIGlmIChbJ2NhcmdvLXZlcnNpb24nLCdiaW5kZ2VuLXZlcnNpb24nLCdyZWxlYXNlLXdhc20nLCdyZWxlYXNlLWJpbmRnZW4nLCdhcGknLCdob3N0J10uaW5jbHVkZXMobmFtZSkgJiYgL25vIG1hdGNoaW5nIHBhY2thZ2UgbmFtZWR8YXR0ZW1wdGluZyB0byBtYWtlIGFuIEhUVFAgcmVxdWVzdHxmYWlsZWQgdG8gZG93bmxvYWR8dGFyZ2V0IG1heSBub3QgYmUgaW5zdGFsbGVkfHRvb2xjaGFpblteXFxuXSpub3QgaW5zdGFsbGVkfENhbm5vdCBmaW5kICg/Om1vZHVsZXxwYWNrYWdlKS9pLnRlc3Qob3V0cHV0KSkgdGhyb3cgbmV3IFByZXJlcXVpc2l0ZShuYW1lICsgJyBtaXNzaW5nIGluc3RhbGxlZC9vZmZsaW5lIHByZXJlcXVpc2l0ZTsgc2VlICcgKyByZWxhdGl2ZShsb2cpKTtcbiAgICAgIHRocm93IG5ldyBFcnJvcihuYW1lICsgJyBleGl0ZWQgJyArIHJlY29yZC5ydW5uZXJfZXhpdF9jb2RlICsgJyAobmF0aXZlIGV4aXQ9JyArIHJlY29yZC5leGl0X2NvZGUgKyAnLCBzaWduYWw9JyArIHJlY29yZC5zaWduYWwgKyAnKScpO1xuICAgIH1cbiAgICByZXR1cm4gcmVjb3JkO1xuICB9XG4gIHRyeSB7XG4gICAgZW52ID0gc2FmZUVudmlyb25tZW50KHJ1bnRpbWUsIHByb2plY3RPdXRwdXRQYXRoKHByb2Nlc3MuZW52LkNBUkdPX1RBUkdFVF9ESVIgPz8gcGF0aC5qb2luKHJvb3QsJ3RhcmdldC9idWlsZC1jYWNoZS9kZWZlY3QtcmVwYWlyL2dwdScscGF0aC5iYXNlbmFtZShydW4pKSkpO1xuICAgIGJlZm9yZSA9IGNhcHR1cmVFdmlkZW5jZUlkZW50aXR5KHsgZW52IH0pO1xuICAgIGF3YWl0IHdyaXRlRmlsZShwYXRoLmpvaW4ocnVuLCAnc291cmNlLWJlZm9yZS5qc29uJyksIEpTT04uc3RyaW5naWZ5KGJlZm9yZSwgbnVsbCwgMikpO1xuICAgIGNvbnN0IHN1cHBsaWVkID0gcHJvY2Vzcy5lbnYuQ0FSR09fVEFSR0VUX0RJUjtcbiAgICBjb25zdCB0YXJnZXQgPSBwcm9qZWN0T3V0cHV0UGF0aChzdXBwbGllZCA/PyBwYXRoLmpvaW4ocm9vdCwgJ3RhcmdldC9idWlsZC1jYWNoZS9kZWZlY3QtcmVwYWlyL2dwdScsIHBhdGguYmFzZW5hbWUocnVuKSkpO1xuICAgIGNvbnN0IGJ1aWxkVGFyZ2V0ID0gcGF0aC5qb2luKHRhcmdldCwgJ3QzMS0nICsgcGF0aC5iYXNlbmFtZShydW4pKTtcbiAgICBlbnYgPSBzYWZlRW52aXJvbm1lbnQocnVudGltZSwgYnVpbGRUYXJnZXQpO1xuICAgIGNvbnN0IGNhcmdvQ3dkID0gcHJvY2Vzcy5lbnYuV0VCTEFCRUxfQ0FSR09fQ1dEID8gZnMucmVhbHBhdGhTeW5jKHByb2Nlc3MuZW52LldFQkxBQkVMX0NBUkdPX0NXRCkgOiByb290O1xuICAgIGNvbnN0IGNhcmdvID0gZXhlY3V0YWJsZSgnY2FyZ28nLCBlbnYpLCBiaW5kZ2VuID0gZXhlY3V0YWJsZSgnd2FzbS1iaW5kZ2VuJywgZW52KTtcbiAgICByZXNvbHZlQXJndihbJ3BucG0nLCdleGVjJywncGxheXdyaWdodCcsJy0tdmVyc2lvbiddKTtcbiAgICBjb25zdCByZXF1aXJlID0gY3JlYXRlUmVxdWlyZShwYXRoLmpvaW4ocm9vdCwgJ2FwcHMvd2ViL3BhY2thZ2UuanNvbicpKTtcbiAgICBmb3IgKGNvbnN0IGRlcGVuZGVuY3kgb2YgWydAcGxheXdyaWdodC90ZXN0Jywndml0ZScsJ3NoYXJwJ10pIHsgdHJ5IHsgcmVxdWlyZS5yZXNvbHZlKGRlcGVuZGVuY3kpOyB9IGNhdGNoIHsgdGhyb3cgbmV3IFByZXJlcXVpc2l0ZSgnSW5zdGFsbGVkIGRlcGVuZGVuY3kgbWlzc2luZzogJyArIGRlcGVuZGVuY3kpOyB9IH1cbiAgICBlbnZpcm9ubWVudCA9IHsgb3M6IHsgcGxhdGZvcm06IG9zLnBsYXRmb3JtKCksIHJlbGVhc2U6IG9zLnJlbGVhc2UoKSwgdmVyc2lvbjogb3MudmVyc2lvbigpLCBhcmNoOiBvcy5hcmNoKCkgfSwgY3B1OiBvcy5jcHVzKClbMF0/Lm1vZGVsID8/ICd1bmtub3duJywgZHJpdmVyOiAndW5rbm93bicsIGJyb3dzZXI6ICd1bmtub3duJywgZ3B1OiAndW5rbm93bicsIGRwcjogJ3Vua25vd24nLCBzZWVkOiAxNywgdGFyZ2V0X2RpbWVuc2lvbnM6IFsyMDQ4LDIwNDhdLCB3YXNtX3Byb2ZpbGU6ICdyZWxlYXNlJywgY3JlZGVudGlhbF9lbnZpcm9ubWVudDogJ25vdF9mb3J3YXJkZWQnLCBhY2NvdW50X3N0YXRlOiAnbm90X2luc3BlY3RlZCcgfTtcbiAgICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gJ3dpbjMyJykge1xuICAgICAgYXdhaXQgZXhlY3V0ZSgnZHJpdmVyJywgWydwb3dlcnNoZWxsLmV4ZScsJy1Ob1Byb2ZpbGUnLCctQ29tbWFuZCcsJ0dldC1DaW1JbnN0YW5jZSBXaW4zMl9WaWRlb0NvbnRyb2xsZXIgfCBTZWxlY3QtT2JqZWN0IE5hbWUsRHJpdmVyVmVyc2lvbixBZGFwdGVyQ29tcGF0aWJpbGl0eSB8IENvbnZlcnRUby1Kc29uIC1Db21wcmVzcyddKTtcbiAgICAgIGNvbnN0IHJhdyA9IGF3YWl0IHJlYWRGaWxlKHBhdGguam9pbihydW4sICdkcml2ZXIubG9nJyksICd1dGY4Jyk7XG4gICAgICB0cnkgeyBlbnZpcm9ubWVudC5kcml2ZXIgPSBKU09OLnBhcnNlKHJhdy5zbGljZShyYXcuaW5kZXhPZignXFxuJykgKyAxKSk7IH0gY2F0Y2ggKGVycm9yKSB7IGVudmlyb25tZW50LmRyaXZlcl9lcnJvciA9IGVycm9yLm1lc3NhZ2U7IH1cbiAgICB9XG4gICAgYXdhaXQgd3JpdGVGaWxlKHBhdGguam9pbihydW4sICdlbnZpcm9ubWVudC5qc29uJyksIEpTT04uc3RyaW5naWZ5KGVudmlyb25tZW50LCBudWxsLCAyKSk7XG4gICAgYXdhaXQgZXhlY3V0ZSgnY2FyZ28tdmVyc2lvbicsIFtjYXJnbywnLS12ZXJzaW9uJ10sIGNhcmdvQ3dkKTtcbiAgICBhd2FpdCBleGVjdXRlKCdiaW5kZ2VuLXZlcnNpb24nLCBbYmluZGdlbiwnLS12ZXJzaW9uJ10sIGNhcmdvQ3dkKTtcbiAgICBhd2FpdCBleGVjdXRlKCdyZWxlYXNlLXdhc20nLCBbY2FyZ28sJ2J1aWxkJywnLS1sb2NrZWQnLCctLW9mZmxpbmUnLCctLXJlbGVhc2UnLCctLW1hbmlmZXN0LXBhdGgnLHBhdGguam9pbihyb290LCdDYXJnby50b21sJyksJy0tdGFyZ2V0LWRpcicsYnVpbGRUYXJnZXQsJy1wJywnd2FzbS1icmlkZ2UnLCctLXRhcmdldCcsJ3dhc20zMi11bmtub3duLXVua25vd24nXSwgY2FyZ29Dd2QpO1xuICAgIGNvbnN0IHdhc21PdXRwdXQgPSBwYXRoLmpvaW4ocnVudGltZSwgJ3dhc20nKTtcbiAgICBhd2FpdCBleGVjdXRlKCdyZWxlYXNlLWJpbmRnZW4nLCBbYmluZGdlbixwYXRoLmpvaW4oYnVpbGRUYXJnZXQsJ3dhc20zMi11bmtub3duLXVua25vd24vcmVsZWFzZS93YXNtX2JyaWRnZS53YXNtJyksJy0tdGFyZ2V0Jywnd2ViJywnLS1vdXQtZGlyJyx3YXNtT3V0cHV0LCctLW91dC1uYW1lJywnd2FzbV9icmlkZ2UnXSwgY2FyZ29Dd2QpO1xuICAgIGNvbnN0IHdhc21GaWxlID0gcGF0aC5qb2luKHdhc21PdXRwdXQsICd3YXNtX2JyaWRnZV9iZy53YXNtJyk7XG4gICAgZW52aXJvbm1lbnQud2FzbSA9IHsgLi4uKGF3YWl0IHJlZmVyZW5jZSh3YXNtRmlsZSkpLCBieXRlczogKGF3YWl0IHN0YXQod2FzbUZpbGUpKS5zaXplIH07XG4gICAgZW52LldFQkxBQkVMX1dBU01fQlJJREdFX0RJUiA9IHdhc21PdXRwdXQ7XG4gICAgYXdhaXQgd3JpdGVGaWxlKHBhdGguam9pbihydW4sICdlbnZpcm9ubWVudC5qc29uJyksIEpTT04uc3RyaW5naWZ5KGVudmlyb25tZW50LG51bGwsMikpO1xuICAgIGF3YWl0IGV4ZWN1dGUoJ2FwaScsIFtjYXJnbywnYnVpbGQnLCctLWxvY2tlZCcsJy0tb2ZmbGluZScsJy0tbWFuaWZlc3QtcGF0aCcscGF0aC5qb2luKHJvb3QsJ0NhcmdvLnRvbWwnKSwnLS10YXJnZXQtZGlyJyxidWlsZFRhcmdldCwnLXAnLCd3ZWJsYWJlbC1hcGknLCctLWJpbicsJ3dlYmxhYmVsLWFwaSddLCBjYXJnb0N3ZCk7XG4gICAgZW52LldFQkxBQkVMX0FQSV9CSU5BUlkgPSBwYXRoLmpvaW4oYnVpbGRUYXJnZXQsJ2RlYnVnJyxwcm9jZXNzLnBsYXRmb3JtID09PSAnd2luMzInID8gJ3dlYmxhYmVsLWFwaS5leGUnIDogJ3dlYmxhYmVsLWFwaScpO1xuICAgIGVudmlyb25tZW50LmFwaSA9IGF3YWl0IHJlZmVyZW5jZShlbnYuV0VCTEFCRUxfQVBJX0JJTkFSWSk7XG4gICAgY29uc3QgaG9zdCA9IHBhdGguam9pbihydW50aW1lLCdhZ2VudC1ob3N0Jyk7XG4gICAgYXdhaXQgZXhlY3V0ZSgnaG9zdCcsIFtwcm9jZXNzLmV4ZWNQYXRoLHBhdGguam9pbihyb290LCdzY3JpcHRzL2J1aWxkLWFnZW50LWhvc3QubWpzJyksJy0tb3V0LWRpcicsaG9zdF0pO1xuICAgIGVudi5XRUJMQUJFTF9UMzBfSE9TVF9TQ1JJUFQgPSBwYXRoLmpvaW4oaG9zdCwncnVudGltZS5tanMnKTtcbiAgICBlbnZpcm9ubWVudC5ob3N0ID0gYXdhaXQgcmVmZXJlbmNlKGVudi5XRUJMQUJFTF9UMzBfSE9TVF9TQ1JJUFQpO1xuICAgIGF3YWl0IHdyaXRlRmlsZShwYXRoLmpvaW4ocnVuLCdlbnZpcm9ubWVudC5qc29uJyksSlNPTi5zdHJpbmdpZnkoZW52aXJvbm1lbnQsbnVsbCwyKSk7XG4gICAgY29uc3QgcmVzZXJ2ZSA9IGNyZWF0ZVNlcnZlcigpO1xuICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlLHJlamVjdCkgPT4geyByZXNlcnZlLm9uY2UoJ2Vycm9yJyxyZWplY3QpOyByZXNlcnZlLmxpc3RlbigwLCcxMjcuMC4wLjEnLHJlc29sdmUpOyB9KTtcbiAgICBjb25zdCBwb3J0ID0gcmVzZXJ2ZS5hZGRyZXNzKCkucG9ydDtcbiAgICBhd2FpdCBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHJlc2VydmUuY2xvc2UocmVzb2x2ZSkpO1xuICAgIGVudi5XRUJMQUJFTF9UMzFfT1JJR0lOID0gJ2h0dHA6Ly8xMjcuMC4wLjE6JyArIHBvcnQ7XG4gICAgZW52LldFQkxBQkVMX1QzMV9SVU5fRElSID0gcnVuO1xuICAgIGNvbnN0IHZpdGVDb25maWcgPSBwYXRoLmpvaW4ocnVudGltZSwndml0ZS5jb25maWcubWpzJyk7XG4gICAgYXdhaXQgd3JpdGVGaWxlKHZpdGVDb25maWcsICdpbXBvcnQgY29uZmlnIGZyb20gJyArIEpTT04uc3RyaW5naWZ5KHBhdGguam9pbihjb25maWdSb290LCd2aXRlLmNvbmZpZy50cycpLnJlcGxhY2VBbGwoJ1xcXFwnLCcvJykpICsgJztcXG5leHBvcnQgZGVmYXVsdCB7Li4uY29uZmlnLCBjYWNoZURpcjonICsgSlNPTi5zdHJpbmdpZnkocGF0aC5qb2luKHJ1bnRpbWUsJ3ZpdGUtY2FjaGUnKSkgKyAnfTtcXG4nKTtcbiAgICBjb25zdCBhcmd2ID0gcmVzb2x2ZUFyZ3YoWydwbnBtJywnLS1maWx0ZXInLCdAd2VibGFiZWwvd2ViJywnZXhlYycsJ3ZpdGUnLCctLWNvbmZpZycsdml0ZUNvbmZpZywnLS1ob3N0JywnMTI3LjAuMC4xJywnLS1wb3J0JyxTdHJpbmcocG9ydCksJy0tc3RyaWN0UG9ydCcsJy0tbW9kZScsJ3Rlc3QnXSk7XG4gICAgYXJndlswXSA9IGV4ZWN1dGFibGUoYXJndlswXSxlbnYpO1xuICAgIGNvbnN0IGxvZyA9IHBhdGguam9pbihydW4sJ3ZpdGUubG9nJyk7XG4gICAgYXdhaXQgd3JpdGVGaWxlKGxvZywgSlNPTi5zdHJpbmdpZnkoe2FyZ3YsY3dkOnJvb3R9KSArICdcXG4nKTtcbiAgICBsZXQgd3JpdGVzID0gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgc2VydmljZVJlY29yZCA9IHsgYXJndixjd2Q6cm9vdCxleGl0X2NvZGU6bnVsbCxzaWduYWw6bnVsbCxsb2dfcGF0aDpyZWxhdGl2ZShsb2cpLHRlc3RzOm51bGwscGFyc2Vfc3RhdHVzOidub25fdGVzdCcsc2VydmljZTp0cnVlLGNsZWFudXA6bnVsbCB9O1xuICAgIGNvbW1hbmRzLnB1c2goc2VydmljZVJlY29yZCk7XG4gICAgc2VydmljZSA9IHNwYXduKGFyZ3ZbMF0sYXJndi5zbGljZSgxKSx7Y3dkOnJvb3QsZW52LHNoZWxsOmZhbHNlLHdpbmRvd3NIaWRlOnRydWUsZGV0YWNoZWQ6cHJvY2Vzcy5wbGF0Zm9ybSAhPT0gJ3dpbjMyJyxzdGRpbzpbJ2lnbm9yZScsJ3BpcGUnLCdwaXBlJ119KTtcbiAgICBsZXQgc3Bhd25FcnJvciA9IG51bGw7XG4gICAgc2VydmljZS5vbmNlKCdlcnJvcicsZXJyb3IgPT4geyBzcGF3bkVycm9yID0gZXJyb3I7IH0pO1xuICAgIGZvciAoY29uc3Qgc3RyZWFtIG9mIFtzZXJ2aWNlLnN0ZG91dCxzZXJ2aWNlLnN0ZGVycl0pIHN0cmVhbS5vbignZGF0YScsY2h1bmsgPT4geyBwcm9jZXNzLnN0ZG91dC53cml0ZShjaHVuayk7IHdyaXRlcyA9IHdyaXRlcy50aGVuKCgpID0+IGFwcGVuZEZpbGUobG9nLGNodW5rKSk7IH0pO1xuICAgIHNlcnZpY2VEb25lID0gbmV3IFByb21pc2UocmVzb2x2ZSA9PiBzZXJ2aWNlLm9uY2UoJ2Nsb3NlJywoY29kZSxzaWduYWwpID0+IHsgc2VydmljZVJlY29yZC5leGl0X2NvZGU9Y29kZTsgc2VydmljZVJlY29yZC5zaWduYWw9c2lnbmFsOyByZXNvbHZlKCk7IH0pKS50aGVuKGFzeW5jICgpID0+IHsgYXdhaXQgd3JpdGVzOyBhd2FpdCByZWZlcmVuY2UobG9nKTsgfSk7XG4gICAgY29uc3QgZGVhZGxpbmUgPSBEYXRlLm5vdygpKzMwMDAwO1xuICAgIHdoaWxlICh0cnVlKSB7XG4gICAgICBpZiAoaW50ZXJydXB0ZWQpIHRocm93IG5ldyBQcmVyZXF1aXNpdGUoJ0NhbmNlbGxlZCBkdXJpbmcgcmVhZGluZXNzJyk7XG4gICAgICBpZiAoc3Bhd25FcnJvcikgdGhyb3cgc3Bhd25FcnJvcjtcbiAgICAgIGlmIChzZXJ2aWNlLmV4aXRDb2RlICE9PSBudWxsKSB0aHJvdyBuZXcgRXJyb3IoJ1ZpdGUgZXhpdGVkIGJlZm9yZSByZWFkaW5lc3M6ICcrc2VydmljZS5leGl0Q29kZSk7XG4gICAgICB0cnkgeyBpZiAoKGF3YWl0IGZldGNoKGVudi5XRUJMQUJFTF9UMzFfT1JJR0lOLHtzaWduYWw6QWJvcnRTaWduYWwudGltZW91dCgxMDAwKX0pKS5vaykgYnJlYWs7IH0gY2F0Y2gge31cbiAgICAgIGlmIChEYXRlLm5vdygpPmRlYWRsaW5lKSB0aHJvdyBuZXcgRXJyb3IoJ1ZpdGUgcmVhZGluZXNzIHRpbWVkIG91dCcpO1xuICAgICAgYXdhaXQgcGF1c2UoMTAwKTtcbiAgICB9XG4gICAgc3RhdHVzPSdmYWlsZWQnO1xuICAgIGF3YWl0IGV4ZWN1dGUoJ2hhcmR3YXJlJyxbJ3BucG0nLCdleGVjJywncGxheXdyaWdodCcsJ3Rlc3QnLCctLWNvbmZpZz0nK3BhdGguam9pbihjb25maWdSb290LCdwbGF5d3JpZ2h0LmNvbmZpZy50cycpLCctLXByb2plY3Q9dGFyZ2V0LWhhcmR3YXJlJ10pO1xuICAgIHN0YXR1cz0ncGFzc2VkJztcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBpZiAoIShlcnJvciBpbnN0YW5jZW9mIFByZXJlcXVpc2l0ZSkgJiYgZXJyb3IuY29kZSAhPT0gJ0VOT0VOVCcpIHN0YXR1cz0nZmFpbGVkJztcbiAgICBibG9ja2Vycy5wdXNoKGVycm9yLm1lc3NhZ2UpO1xuICB9IGZpbmFsbHkge1xuICAgIGlmIChzZXJ2aWNlRG9uZSkge1xuICAgICAgY29uc3QgdW5leHBlY3RlZEV4aXQgPSBzZXJ2aWNlLmV4aXRDb2RlICE9PSBudWxsIHx8IHNlcnZpY2Uuc2lnbmFsQ29kZSAhPT0gbnVsbDtcbiAgICAgIGlmICh1bmV4cGVjdGVkRXhpdCkgeyBzdGF0dXM9J2ZhaWxlZCc7IGJsb2NrZXJzLnB1c2goJ093bmVkIFZpdGUgZXhpdGVkIGJlZm9yZSBjbGVhbnVwJyk7IH1cbiAgICAgIHNlcnZpY2VSZWNvcmQuY2xlYW51cCA9IHsgcmVxdWVzdGVkOiAhdW5leHBlY3RlZEV4aXQsIHVuZXhwZWN0ZWRfZXhpdF9iZWZvcmVfY2xlYW51cDogdW5leHBlY3RlZEV4aXQsIGJhY2tzdG9wOiBudWxsIH07XG4gICAgICBpZiAoIXVuZXhwZWN0ZWRFeGl0KSB7XG4gICAgICAgIGlmIChwcm9jZXNzLnBsYXRmb3JtID09PSAnd2luMzInKSB7XG4gICAgICAgICAgLy8gV2luZG93cyBoYXMgbm8gUE9TSVggcHJvY2Vzcy1ncm91cCBTSUdURVJNLiBSZWNvcmQgdHJlZSB0ZXJtaW5hdGlvbiBob25lc3RseS5cbiAgICAgICAgICB0cnkgeyBhd2FpdCBleGVjdXRlKCd2aXRlLW93bmVkLXRyZWUtc3RvcCcsWyd0YXNra2lsbC5leGUnLCcvUElEJyxTdHJpbmcoc2VydmljZS5waWQpLCcvVCddLHJvb3QsdHJ1ZSk7IH0gY2F0Y2ggKGVycm9yKSB7IHNlcnZpY2VSZWNvcmQuY2xlYW51cC5pbml0aWFsX2Vycm9yPWVycm9yLm1lc3NhZ2U7IHN0YXR1cz0nZmFpbGVkJzsgYmxvY2tlcnMucHVzaCgnT3duZWQgVml0ZSBzdG9wIGZhaWxlZDogJytlcnJvci5tZXNzYWdlKTsgfVxuICAgICAgICB9IGVsc2UgeyB0cnkgeyBwcm9jZXNzLmtpbGwoLXNlcnZpY2UucGlkLCdTSUdURVJNJyk7IH0gY2F0Y2ggKGVycm9yKSB7IHNlcnZpY2VSZWNvcmQuY2xlYW51cC5pbml0aWFsX2Vycm9yPWVycm9yLm1lc3NhZ2U7IH0gfVxuICAgICAgICBjb25zdCBzZXR0bGVkID0gYXdhaXQgUHJvbWlzZS5yYWNlKFtzZXJ2aWNlRG9uZS50aGVuKCgpPT50cnVlKSxwYXVzZSg1MDAwKS50aGVuKCgpPT5mYWxzZSldKTtcbiAgICAgICAgaWYgKCFzZXR0bGVkKSB7XG4gICAgICAgICAgc3RhdHVzPSdmYWlsZWQnOyBibG9ja2Vycy5wdXNoKCdPd25lZCBWaXRlIGZhaWxlZCBib3VuZGVkIGNsZWFudXA7IGZvcmNlZCBiYWNrc3RvcCByZXF1aXJlZCcpO1xuICAgICAgICAgIHNlcnZpY2VSZWNvcmQuY2xlYW51cC5iYWNrc3RvcD0nZm9yY2VkX293bmVkX3RyZWUnO1xuICAgICAgICAgIGlmIChwcm9jZXNzLnBsYXRmb3JtID09PSAnd2luMzInKSB7IHRyeSB7IGF3YWl0IGV4ZWN1dGUoJ3ZpdGUtYmFja3N0b3AnLFsndGFza2tpbGwuZXhlJywnL1BJRCcsU3RyaW5nKHNlcnZpY2UucGlkKSwnL1QnLCcvRiddLHJvb3QsdHJ1ZSk7IH0gY2F0Y2goZXJyb3IpIHsgYmxvY2tlcnMucHVzaChlcnJvci5tZXNzYWdlKTsgfSB9XG4gICAgICAgICAgZWxzZSB7IHRyeSB7IHByb2Nlc3Mua2lsbCgtc2VydmljZS5waWQsJ1NJR0tJTEwnKTsgfSBjYXRjaChlcnJvcikgeyBibG9ja2Vycy5wdXNoKGVycm9yLm1lc3NhZ2UpOyB9IH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgYXdhaXQgc2VydmljZURvbmU7XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICBicm93c2VyID0gcGFyc2VCcm93c2VyUmVwb3J0KGF3YWl0IG9wdGlvbmFsVGV4dChwYXRoLmpvaW4ocnVuLCdicm93c2VyLXJlc3VsdHMuanNvbicpKSk7XG4gICAgICBjb25zdCBjb21tYW5kID0gY29tbWFuZHMuZmluZChjb21tYW5kID0+IGNvbW1hbmQubG9nX3BhdGguZW5kc1dpdGgoJy9oYXJkd2FyZS5sb2cnKSk7XG4gICAgICBpZiAoY29tbWFuZCkgeyBjb21tYW5kLnRlc3RzPWJyb3dzZXIudGVzdHM7IGNvbW1hbmQucGFyc2Vfc3RhdHVzPWJyb3dzZXIucGFyc2Vfc3RhdHVzOyB9XG4gICAgICBpZiAoYnJvd3Nlci5zdGF0dXM9PT0nZmFpbGVkJykgeyBzdGF0dXM9J2ZhaWxlZCc7IGJsb2NrZXJzLnB1c2goYnJvd3Nlci5ibG9ja2VyKTsgfVxuICAgICAgZWxzZSBpZiAoYnJvd3Nlci5zdGF0dXM9PT0nYmxvY2tlZCcgJiYgc3RhdHVzIT09J2ZhaWxlZCcpIHsgc3RhdHVzPSdibG9ja2VkJzsgYmxvY2tlcnMucHVzaChicm93c2VyLmJsb2NrZXIpOyB9XG4gICAgICBpZiAoYnJvd3Nlci5wYXJzZV9zdGF0dXM9PT0ncGFyc2VkJykgYXdhaXQgcmVmZXJlbmNlKHBhdGguam9pbihydW4sJ2Jyb3dzZXItcmVzdWx0cy5qc29uJykpO1xuICAgICAgZm9yIChjb25zdCBjb3VudCBvZiBbMjAwMCwxMDAwMF0pIHtcbiAgICAgICAgY29uc3QgZmlsZT1wYXRoLmpvaW4ocnVuLCdzYW1wbGVzLScrY291bnQrJy5qc29uJyksIHRleHQ9YXdhaXQgb3B0aW9uYWxUZXh0KGZpbGUpO1xuICAgICAgICBpZiAodGV4dD09PW51bGwpIHsgaWYoc3RhdHVzIT09J2ZhaWxlZCcpIHN0YXR1cz0nYmxvY2tlZCc7IGJsb2NrZXJzLnB1c2goJ01pc3NpbmcgY3VycmVudCByYXcgc2FtcGxlczogJytjb3VudCk7IGNvbnRpbnVlOyB9XG4gICAgICAgIGF3YWl0IHJlZmVyZW5jZShmaWxlKTtcbiAgICAgICAgY29uc3Qgc2FtcGxlPUpTT04ucGFyc2UodGV4dCk7XG4gICAgICAgIGlmIChicm93c2VyLnN0YXR1cyAhPT0gJ3Bhc3NlZCcpIGNvbnRpbnVlOyAvLyBQYXJ0aWFsIGZhaWx1cmUgc2FtcGxlcyBzdGF5IHByZXNlcnZlZCwgbmV2ZXIgcHJvbW90ZWQuXG4gICAgICAgIGlmKHNhbXBsZS5jb3VudCE9PWNvdW50IHx8IHNhbXBsZS5zZWVkIT09MTcgfHwgc2FtcGxlLndhcm11cF9wZXJfc2NlbmFyaW8hPT00MCB8fCBzYW1wbGUuc2FtcGxlX2NvdW50X3Blcl9zY2VuYXJpbyE9PTEwMDAgfHwgSlNPTi5zdHJpbmdpZnkoc2FtcGxlLmNhbm9uaWNhbF9kaW1lbnNpb25zKSE9PSdbMjA0OCwyMDQ4XScpIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBmaXhlZCB3b3JrbG9hZCBtZXRhZGF0YTogJytjb3VudCk7XG4gICAgICAgIGlmKCFBcnJheS5pc0FycmF5KHNhbXBsZS5hZGFwdGVycykgfHwgIXNhbXBsZS5hZGFwdGVycy5sZW5ndGggfHwgaGFyZHdhcmVLaW5kKHNhbXBsZS5hZGFwdGVycy5hdCgtMSkpIT09J2hhcmR3YXJlJykgdGhyb3cgbmV3IFByZXJlcXVpc2l0ZSgnTm8gYWN0dWFsIG5vbi1zb2Z0d2FyZSBhZGFwdGVyIHByb29mOiAnK2NvdW50KTtcbiAgICAgICAgaWYoSlNPTi5zdHJpbmdpZnkoc2FtcGxlLmxvYWRlZF93YXNtX3NoYTI1NikhPT1KU09OLnN0cmluZ2lmeShbZW52aXJvbm1lbnQ/Lndhc20/LnNoYTI1Nl0pKSB0aHJvdyBuZXcgRXJyb3IoJ0FjdHVhbCBsb2FkZWQgV0FTTSBoYXNoIG1pc21hdGNoOiAnK2NvdW50KTtcbiAgICAgICAgY29uc3QgcGVyZm9ybWFuY2U9Z2F0ZShjb3VudCxzYW1wbGUuc2NlbmFyaW9zKTtcbiAgICAgICAgZm9yKGNvbnN0IHJvd3Mgb2YgT2JqZWN0LnZhbHVlcyhzYW1wbGUuc2NlbmFyaW9zKSkgaWYocm93cy5sZW5ndGghPT0xMDAwIHx8IHJvd3Muc29tZShyb3c9PnJvdy5uYXRpdmVfc3VibWlzc2lvbnMhPT0xKSkgdGhyb3cgbmV3IEVycm9yKCdJbnZhbGlkIGFjdHVhbCBuYXRpdmUgc3VibWlzc2lvbnM6ICcrY291bnQpO1xuICAgICAgICBpZihwZXJmb3JtYW5jZS5mYWlsdXJlcy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcihwZXJmb3JtYW5jZS5mYWlsdXJlcy5qb2luKCc7ICcpKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGVudmlyb25tZW50VGV4dD1hd2FpdCBvcHRpb25hbFRleHQocGF0aC5qb2luKHJ1biwnZW52aXJvbm1lbnQuanNvbicpKTtcbiAgICAgIGlmKGVudmlyb25tZW50VGV4dCE9PW51bGwpIHsgZW52aXJvbm1lbnQ9SlNPTi5wYXJzZShlbnZpcm9ubWVudFRleHQpOyBhd2FpdCByZWZlcmVuY2UocGF0aC5qb2luKHJ1biwnZW52aXJvbm1lbnQuanNvbicpKTsgfVxuICAgICAgaWYoc3RhdHVzPT09J3Bhc3NlZCcgJiYgKCFlbnZpcm9ubWVudD8uYnJvd3Nlcj8udmVyc2lvbiB8fCBlbnZpcm9ubWVudC5kcml2ZXI9PT0ndW5rbm93bicgfHwgIU51bWJlci5pc0Zpbml0ZShlbnZpcm9ubWVudC5kcHIpKSkgdGhyb3cgbmV3IFByZXJlcXVpc2l0ZSgnQWN0dWFsIGJyb3dzZXIvZHJpdmVyL0RQUiBwcm92ZW5hbmNlIHVuYXZhaWxhYmxlJyk7XG4gICAgICBhZnRlcj1jYXB0dXJlRXZpZGVuY2VJZGVudGl0eSh7IGVudjogZW52ID8/IHNhZmVFbnZpcm9ubWVudChydW50aW1lLCBydW50aW1lKSB9KTtcbiAgICAgIGlmKGJlZm9yZSAmJiBbJ3NvdXJjZV9zbmFwc2hvdF9zaGEyNTYnLCdtYW5pZmVzdF9zaGEyNTYnLCdydW5uZXJfc2hhMjU2J10uc29tZShrZXk9PmJlZm9yZVtrZXldIT09YWZ0ZXJba2V5XSkpIHRocm93IG5ldyBQcmVyZXF1aXNpdGUoJ1NvdXJjZSBjaGFuZ2VkIGR1cmluZyBHUFUgY29sbGVjdGlvbjsgY3VycmVudCBldmlkZW5jZSBub3QgY2VydGlmaWFibGUnKTtcbiAgICB9IGNhdGNoKGVycm9yKSB7IGlmKGVycm9yIGluc3RhbmNlb2YgUHJlcmVxdWlzaXRlIHx8IGVycm9yLmNvZGUgPT09ICdFTk9FTlQnKSB7IGlmKHN0YXR1cyE9PSdmYWlsZWQnKSBzdGF0dXM9J2Jsb2NrZWQnOyB9IGVsc2Ugc3RhdHVzPSdmYWlsZWQnOyBibG9ja2Vycy5wdXNoKGVycm9yLm1lc3NhZ2UpOyB9XG4gICAgaWYgKCFhZnRlcikgeyB0cnkgeyBhZnRlcj1jYXB0dXJlRXZpZGVuY2VJZGVudGl0eSh7IGVudjogZW52ID8/IHNhZmVFbnZpcm9ubWVudChydW50aW1lLCBydW50aW1lKSB9KTsgfSBjYXRjaChlcnJvcikgeyBpZihzdGF0dXMhPT0nZmFpbGVkJykgc3RhdHVzPSdibG9ja2VkJzsgYmxvY2tlcnMucHVzaCgnRmluYWwgaWRlbnRpdHkgdW5hdmFpbGFibGU6ICcrZXJyb3IubWVzc2FnZSk7IH0gfVxuICAgIGlmKGJlZm9yZSAmJiBhZnRlciAmJiBbJ3NvdXJjZV9zbmFwc2hvdF9zaGEyNTYnLCdtYW5pZmVzdF9zaGEyNTYnLCdydW5uZXJfc2hhMjU2J10uc29tZShrZXk9PmJlZm9yZVtrZXldIT09YWZ0ZXJba2V5XSkpIHsgaWYoc3RhdHVzIT09J2ZhaWxlZCcpIHN0YXR1cz0nYmxvY2tlZCc7IGlmKCFibG9ja2Vycy5pbmNsdWRlcygnU291cmNlIGNoYW5nZWQgZHVyaW5nIEdQVSBjb2xsZWN0aW9uOyBjdXJyZW50IGV2aWRlbmNlIG5vdCBjZXJ0aWZpYWJsZScpKSBibG9ja2Vycy5wdXNoKCdTb3VyY2UgY2hhbmdlZCBkdXJpbmcgR1BVIGNvbGxlY3Rpb247IGN1cnJlbnQgZXZpZGVuY2Ugbm90IGNlcnRpZmlhYmxlJyk7IH1cbiAgICBpZihpbnRlcnJ1cHRlZCkgeyBpZihzdGF0dXMhPT0nZmFpbGVkJykgc3RhdHVzPSdibG9ja2VkJzsgYmxvY2tlcnMucHVzaCgnQ2FuY2VsbGVkOyBoYXJkd2FyZSBnYXRlIG5vdCBjZXJ0aWZpZWQnKTsgfVxuICAgIHByb2Nlc3MucmVtb3ZlTGlzdGVuZXIoJ1NJR0lOVCcsb25TaWduYWwpOyBwcm9jZXNzLnJlbW92ZUxpc3RlbmVyKCdTSUdURVJNJyxvblNpZ25hbCk7XG4gICAgY29uc3QgcmVzdWx0PXtzY2hlbWFfdmVyc2lvbjoxLHRhc2tfaWQ6J1QzMScsZ2F0ZTonZ3B1JyxzdGF0dXMsYmFzZV9jb21taXQ6YmVmb3JlPy5zb3VyY2VfY29tbWl0Pz9udWxsLHNvdXJjZV9oYXNoZXM6YmVmb3JlPy5zb3VyY2VfaGFzaGVzPz9udWxsLG1hbmlmZXN0X3NoYTI1NjpiZWZvcmU/Lm1hbmlmZXN0X3NoYTI1Nj8/bnVsbCxpZGVudGl0eTpiZWZvcmUsaWRlbnRpdHlfYWZ0ZXI6YWZ0ZXIsdGltZTp7ZmluaXNoZWRfYXQ6bmV3IERhdGUoKS50b0lTT1N0cmluZygpfSxydW5fZGlyOnJlbGF0aXZlKHJ1biksZW52aXJvbm1lbnQsY29tbWFuZHMsdGVzdHM6YnJvd3Nlci50ZXN0cyxwYXJzZV9zdGF0dXM6YnJvd3Nlci5wYXJzZV9zdGF0dXMsZXZpZGVuY2VfcmVmcyxibG9ja2Vycyxza2lwcGVkX3Njb3BlOlsnc2VjdXJpdHknXSx0aHJlc2hvbGRzOntib3hlczoyMDAwLGNwdV9wOTVfbXM6OCxwb2ludGVyX2RvdWJsZV9yYWZfcHJveHlfcDk1X21zOjMzfSx3b3JrbG9hZDp7Y291bnRzOlsyMDAwLDEwMDAwXSxzZWVkOjE3LHdhcm11cF9wZXJfc2NlbmFyaW86NDAsc2FtcGxlX2NvdW50X3Blcl9zY2VuYXJpbzoxMDAwLHNjZW5hcmlvczpbJ3BvaW50ZXJfZHJhZycsJ3BhbicsJ3pvb20nLCdjb21taXR0ZWRfZWRpdCddfSxiYXNlbGluZV9kZWJ1Zzp7c3RhdHVzOidub3RfdmVyaWZpZWQnLGF2YWlsYWJsZTpmYWxzZSxjZXJ0aWZpZWRfaGFyZHdhcmVfZ2F0ZTpmYWxzZSxyZWFzb246J05vIGN1cnJlbnQtc291cmNlIGRlYnVnIGJhc2VsaW5lIGNvbGxlY3RlZDsgaGlzdG9yaWNhbCBUMjggcmVwb3J0cyBhcmUgbm90IGN1cnJlbnQgcHJvb2YnfSxrbm93bl9saW1pdHM6Wydkb3VibGUtckFGIHNjaGVkdWxpbmcgcHJveHksIG5vdCBwaHlzaWNhbCBwaG90b24gbGF0ZW5jeScsJ0NQVSBpbmNsdWRlcyBtZWFzdXJlbWVudCBpbnN0cnVtZW50YXRpb24nLCdMb2dpY2FsIHRleHR1cmUgYnl0ZXMgYXJlIG5vdCBwaHlzaWNhbCBWUkFNJywnR1BVIHRpbWVzdGFtcHMgbm90IG1lYXN1cmVkJ119O1xuICAgIGF3YWl0IHdyaXRlRmlsZShwYXRoLmpvaW4ocnVuLCdyZXN1bHQuanNvbicpLEpTT04uc3RyaW5naWZ5KHJlc3VsdCxudWxsLDIpLHtmbGFnOid3eCd9KTtcbiAgICBhd2FpdCB3cml0ZUZpbGUocGF0aC5qb2luKHJlcG9ydCwncmVzdWx0Lmpzb24nKSxKU09OLnN0cmluZ2lmeShyZXN1bHQsbnVsbCwyKSx7ZmxhZzond3gnfSk7XG4gICAgY29uc29sZS5sb2coSlNPTi5zdHJpbmdpZnkoe3N0YXR1cyx0ZXN0czpyZXN1bHQudGVzdHMscnVuOnJlc3VsdC5ydW5fZGlyLGJsb2NrZXJzfSxudWxsLDIpKTtcbiAgfVxuICByZXR1cm4gc3RhdHVzPT09J3Bhc3NlZCc/MDpzdGF0dXM9PT0nYmxvY2tlZCc/MjoxO1xufVxuaWYocHJvY2Vzcy5hcmd2WzFdICYmIHBhdGgucmVzb2x2ZShwcm9jZXNzLmFyZ3ZbMV0pPT09ZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKSBwcm9jZXNzLmV4aXRDb2RlPWF3YWl0IG1haW4oKTtcbiJdLCJtYXBwaW5ncyI6IkFBQUEsU0FBU0EsS0FBSyxRQUFRLG9CQUFvQjtBQUMxQyxTQUFTQyxLQUFLLEVBQUVDLFNBQVMsRUFBRUMsVUFBVSxFQUFFQyxRQUFRLEVBQUVDLElBQUksUUFBUSxrQkFBa0I7QUFDL0UsT0FBT0MsRUFBRSxNQUFNLFNBQVM7QUFDeEIsT0FBT0MsRUFBRSxNQUFNLFNBQVM7QUFDeEIsT0FBT0MsSUFBSSxNQUFNLFdBQVc7QUFDNUIsU0FBU0MsVUFBVSxFQUFFQyxVQUFVLFFBQVEsYUFBYTtBQUNwRCxTQUFTQyxZQUFZLFFBQVEsVUFBVTtBQUN2QyxTQUFTQyxhQUFhLFFBQVEsYUFBYTtBQUMzQyxTQUFTQyxhQUFhLFFBQVEsVUFBVTtBQUN4QyxTQUFTQyxlQUFlLEVBQUVDLGlCQUFpQixRQUFRLG1DQUFtQztBQUN0RixTQUFTQyx1QkFBdUIsUUFBUSx5QkFBeUI7QUFDakUsU0FBU0MsV0FBVyxFQUFFQyxPQUFPLFFBQVEsWUFBWTtBQUVqRCxNQUFNQyxJQUFJLEdBQUdYLElBQUksQ0FBQ1ksT0FBTyxDQUFDWixJQUFJLENBQUNhLE9BQU8sQ0FBQ1IsYUFBYSxDQUFDUyxNQUFNLENBQUNDLElBQUksQ0FBQ0MsR0FBRyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUM7QUFDN0UsT0FBTyxTQUFTQyxZQUFZQSxDQUFDQyxJQUFJLEVBQUU7RUFDakMsTUFBTUMsSUFBSSxHQUFHQyxJQUFJLENBQUNDLFNBQVMsQ0FBQ0gsSUFBSSxDQUFDO0VBQ2pDLElBQUksMEVBQTBFLENBQUNJLElBQUksQ0FBQ0gsSUFBSSxDQUFDLElBQUlELElBQUksRUFBRUssaUJBQWlCLEtBQUssSUFBSSxFQUFFLE9BQU8sVUFBVTtFQUNoSixJQUFJLDZEQUE2RCxDQUFD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