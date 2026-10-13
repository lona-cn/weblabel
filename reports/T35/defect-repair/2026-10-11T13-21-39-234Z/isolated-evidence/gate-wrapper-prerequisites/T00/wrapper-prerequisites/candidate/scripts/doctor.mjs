import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, pins, options, mainGuard } from './build.mjs';
import { resolveArgv } from './task.mjs';
import { validateRelease, taskkillPath } from './start-local.mjs';

export function diagnose(argv = process.argv.slice(2)) {
  const args = options(argv, ['--build-dir', '--cargo-cwd']);
  const cwd = path.resolve(args['--cargo-cwd'] ?? root);
  const result = { format: 'weblabel-doctor', version: 1, readonly: true, tools: [], release: { status: 'missing' }, configuration: {}, capabilities: { webgpu: 'browser-device-probe-required', models: 'live-not-run', manual_editor: 'requires-release-and-real-WebGPU; no-Python-or-official-CLI-required' } };
  const allowed = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PNPM_HOME', 'COREPACK_HOME', 'CARGO_HOME', 'RUSTUP_HOME', 'RUSTC', 'RUSTDOC', 'VCINSTALLDIR', 'WindowsSdkDir', 'INCLUDE', 'LIB', 'LIBPATH', 'TEMP', 'TMP', 'TMPDIR'];
  const env = Object.fromEntries(allowed.filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { RUSTUP_TOOLCHAIN: pins.rust, RUSTUP_AUTO_INSTALL: '0', COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_AUTO_PIN: '0', COREPACK_DEFAULT_TO_LATEST: '0' });
  result.capabilities.process_tree = taskkillPath ? (fs.existsSync(taskkillPath) ? 'windows-taskkill-available' : 'missing') : 'posix-process-group';
  for (const [name, expected] of [['node', `v${pins.node}`], ['pnpm', pins.pnpm], ['rustc', `rustc ${pins.rust} `], ['cargo', `cargo ${pins.rust} `], ['wasm-pack', `wasm-pack ${pins.wasm_pack}`], ['wasm-bindgen', `wasm-bindgen ${pins.wasm_bindgen}`]]) {
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
  result.configuration = { credential_environment: "not_forwarded", account_state: "not_inspected" };
  result.blockers = result.tools.filter(tool => tool.status !== 'pinned').map(tool => `TOOL_${tool.name}_${tool.status}`);
  if (result.release.status !== 'hashes_valid') result.blockers.push(`RELEASE_${result.release.status}`);
  if (result.capabilities.process_tree === 'missing') result.blockers.push('PROCESS_TREE_TOOL_MISSING');
  result.status = result.release.status === 'invalid' ? 'failed' : result.blockers.length ? 'blocked' : 'passed';
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'failed' ? 1 : result.status === 'blocked' ? 2 : 0;
  return result;
}
mainGuard(import.meta.url, () => diagnose());
