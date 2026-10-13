import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, pins, options, mainGuard } from './build.mjs';
import { resolveArgv } from './task.mjs';
import { validateRelease, taskkillPath } from './start-local.mjs';
import { storageDiagnostics, probeReady } from './ops-diagnostics.mjs';
import { upgradePreflight, supportReceipt } from './upgrade-preflight.mjs';
export async function diagnose(argv = process.argv.slice(2)) {
  const args = options(argv, ['--build-dir', '--cargo-cwd', '--mode', '--data-dir', '--api-url', '--target-release', '--support-receipt']);
  const mode = args['--mode'] ?? 'build';
  if (!['build', 'runtime', 'ai'].includes(mode)) throw new Error('invalid_mode');
  const cwd = path.resolve(args['--cargo-cwd'] ?? root);
  const result = { format: 'weblabel-doctor', version: 1, readonly: true, tools: [], release: { status: 'missing' }, configuration: {}, capabilities: { webgpu: 'browser-device-probe-required', models: 'live-not-run', manual_editor: 'requires-release-and-real-WebGPU; no-Python-or-official-CLI-required' } };
  const allowed = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PNPM_HOME', 'COREPACK_HOME', 'CARGO_HOME', 'RUSTUP_HOME', 'RUSTC', 'RUSTDOC', 'VCINSTALLDIR', 'WindowsSdkDir', 'INCLUDE', 'LIB', 'LIBPATH', 'TEMP', 'TMP', 'TMPDIR'];
  const env = Object.fromEntries(allowed.filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { RUSTUP_TOOLCHAIN: pins.rust, RUSTUP_AUTO_INSTALL: '0', COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_AUTO_PIN: '0', COREPACK_DEFAULT_TO_LATEST: '0' });
  result.capabilities.process_tree = taskkillPath ? (fs.existsSync(taskkillPath) ? 'windows-taskkill-available' : 'missing') : 'posix-process-group';
  const tools = mode === 'build' ? [['node', `v${pins.node}`], ['pnpm', pins.pnpm], ['rustc', `rustc ${pins.rust} `], ['cargo', `cargo ${pins.rust} `], ['wasm-pack', `wasm-pack ${pins.wasm_pack}`], ['wasm-bindgen', `wasm-bindgen ${pins.wasm_bindgen}`]] : [['node', `v${pins.node}`]];
  for (const [name, expected] of tools) {
    let actual = 'unavailable', status = 'missing';
    try {
      const [command, ...commandArgs] = resolveArgv([name === 'node' ? process.execPath : name, '--version']);
      const r = spawnSync(command, commandArgs, { cwd, env, shell: false, windowsHide: true, timeout: 15000, encoding: 'utf8' });
      if (r.status === 0) { actual = r.stdout.trim(); status = (name === 'rustc' || name === 'cargo' ? actual.startsWith(expected) : actual === expected) ? 'pinned' : 'version_mismatch'; }
    } catch {}
    result.tools.push({ name, expected: expected.trim(), actual, status });
  }
  const build = path.resolve(args['--build-dir'] ?? path.join(root, 'target/local-release'));
  if (fs.existsSync(path.join(build, 'release.json'))) {
    try { validateRelease(build); result.release.status = 'hashes_valid'; } catch (error) { result.release.status = 'invalid'; result.release.code = error.message.split(':')[0]; }
  }
  result.mode = mode;
  result.configuration = { credential_environment: "not_forwarded", account_state: "not_inspected" };
  if (args['--data-dir']) result.storage = await storageDiagnostics(args['--data-dir']);
  if (args['--api-url']) result.api = await probeReady(args['--api-url']);
  if (mode === 'ai') {
    result.ai = { configured: 'not-inspected', live: 'not-run', components: [] };
    for (const name of ['claude', 'python']) {
      let status = 'unavailable';
      try {
        const [command, ...commandArgs] = resolveArgv([name, '--version']);
        const probe = spawnSync(command, commandArgs, { cwd, env, shell: false, windowsHide: true, timeout: 5000, encoding: 'utf8' });
        if (probe.status === 0) status = 'installed-version-probe-only';
      } catch {}
      result.ai.components.push({ name, status, required_for_manual: false });
    }
  }
  if (args['--target-release']) {
    if (!args['--data-dir']) throw new Error('required: --data-dir');
    result.upgrade = await upgradePreflight(args['--data-dir'], args['--target-release']);
  }
  result.blockers = result.tools.filter(tool => tool.status !== 'pinned').map(tool => `TOOL_${tool.name}_${tool.status}`);
  if (result.release.status !== 'hashes_valid') result.blockers.push(`RELEASE_${result.release.status}`);
  if (result.capabilities.process_tree === 'missing') result.blockers.push('PROCESS_TREE_TOOL_MISSING');
  if (result.api && result.api.status !== 'ready') result.blockers.push('API_' + result.api.status);
  if (result.upgrade && result.upgrade.status !== 'compatible') result.blockers.push('UPGRADE_' + result.upgrade.status);
  result.status = result.release.status === 'invalid' ? 'failed' : result.blockers.length ? 'blocked' : 'passed';
  if (args['--support-receipt']) fs.writeFileSync(path.resolve(args['--support-receipt']), JSON.stringify(supportReceipt(result), null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'failed' ? 1 : result.status === 'blocked' ? 2 : 0;
  return result;
}
mainGuard(import.meta.url, () => diagnose());
