import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolveArgv } from './task.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const pins = Object.freeze({ node: '24.16.0', pnpm: '10.34.5', rust: '1.96.0', wasm_bindgen: '0.2.128', wasm_pack: '0.15.0' });
export function options(argv, allowed) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!allowed.includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--') || argv[i] in out) throw new Error('invalid_arguments');
    out[argv[i]] = argv[i + 1];
  }
  return out;
}
export function requireNode() {
  if (process.versions.node !== pins.node) throw new Error(`node_version: required ${pins.node}; actual ${process.versions.node}`);
}
export function command(argv, cwd = root, env = process.env) {
  let exe, args;
  try { [exe, ...args] = resolveArgv(argv); } catch (error) {
    if (argv[1] === '--version' && error.message === 'Installed pnpm entrypoint unavailable') error.prerequisite = true;
    throw error;
  }
  console.log(`> ${JSON.stringify(argv)}`);
  const r = spawnSync(exe, args, { cwd, env, shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    const error = new Error(`command_failed: ${JSON.stringify(argv)} exit=${r.status} ${r.error?.message ?? ''}\n${r.stdout ?? ''}${r.stderr ?? ''}`);
    if (argv[1] === '--version') { error.prerequisite = true; error.blocker = `PINNED_TOOL_UNAVAILABLE:${argv[0]}`; }
    throw error;
  }
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return (r.stdout ?? '').trim();
}
export function sha(file) {
  const fd = fs.openSync(file, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try { let n; while ((n = fs.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, n)); } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
export function files(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) throw new Error('symlink_refused');
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return files(path.join(directory, entry.name), relative);
    if (!entry.isFile()) throw new Error('nonregular_file_refused');
    return [relative];
  }).sort();
}
export function checkedPath(directory, relative) {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..') || /^[A-Za-z]:/.test(relative) || relative.startsWith('/')) throw new Error('manifest_path_invalid');
  const resolvedRoot = fs.realpathSync(directory);
  const resolved = fs.realpathSync(path.join(directory, relative));
  if (!resolved.startsWith(resolvedRoot + path.sep) || !fs.lstatSync(path.join(directory, relative)).isFile()) throw new Error('manifest_path_escape');
  return resolved;
}
export function entries(directory) {
  return files(directory).map(file => ({ path: file, sha256: sha(path.join(directory, file)), size: fs.statSync(path.join(directory, file)).size }));
}
export function validateEntries(directory, list) {
  if (!Array.isArray(list) || list.length === 0) throw new Error('manifest_files_missing');
  const seen = new Set();
  for (const item of list) {
    if (!item || seen.has(item.path) || !/^[0-9a-f]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0) throw new Error('manifest_entry_invalid');
    seen.add(item.path);
    const file = checkedPath(directory, item.path);
    if (fs.statSync(file).size !== item.size || sha(file) !== item.sha256) throw new Error(`hash_mismatch: ${item.path}`);
  }
}
export function mainGuard(url, action) {
  if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(url)) Promise.resolve().then(action).catch(error => {
    console.error(error.message);
    if (error.prerequisite === true) console.log(JSON.stringify({ format: 'weblabel-release-build', version: 1, status: 'blocked', blockers: [error.blocker ?? error.message.split(':')[0]] }));
    process.exitCode = error.prerequisite === true ? 2 : 1;
  });
}
function physicalPath(directory) {
  let parent = directory;
  const missing = [];
  for (;;) {
    try { fs.lstatSync(parent); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const next = path.dirname(parent);
      if (next === parent) throw error;
      missing.unshift(path.basename(parent));
      parent = next;
      continue;
    }
    // realpath failures (including dangling links) must not become fresh paths.
    const resolved = path.resolve(fs.realpathSync.native(parent), ...missing);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
}
function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}
export async function buildRelease(argv = process.argv.slice(2)) {
  const args = options(argv, ['--build-dir', '--cargo-cwd', '--target-dir', '--intermediate-dir']);
  try { requireNode(); } catch (error) { error.prerequisite = true; throw error; }
  const cwd = path.resolve(args['--cargo-cwd'] ?? root);
  const target = path.resolve(args['--target-dir'] ?? path.join(root, 'target'));
  const output = path.resolve(args['--build-dir'] ?? path.join(root, 'target/local-release'));
  const intermediate = path.resolve(args['--intermediate-dir'] ?? path.join(root, 'target/build-cache', randomUUID()));
  const physicalOutput = physicalPath(output);
  const physicalIntermediate = physicalPath(intermediate);
  if (containsPath(physicalOutput, physicalIntermediate) || containsPath(physicalIntermediate, physicalOutput)) throw new Error('build_directories_overlap: release and intermediate must be separate');
  if (fs.existsSync(output)) throw new Error('build_directory_exists: choose a new output directory');
  // Only parent creation may be recursive: reserve the leaf exclusively.
  try {
    fs.lstatSync(intermediate);
    throw new Error('intermediate_directory_exists: choose a new intermediate directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.mkdirSync(path.dirname(intermediate), { recursive: true });
  try { fs.mkdirSync(intermediate); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('intermediate_directory_exists: choose a new intermediate directory');
    throw error;
  }
  const env = { ...process.env, RUSTUP_TOOLCHAIN: pins.rust, CARGO_TARGET_DIR: target };
  for (const [name, expected, toolCwd] of [['pnpm', pins.pnpm, root], [env.RUSTC ?? 'rustc', `rustc ${pins.rust} `, cwd], ['cargo', `cargo ${pins.rust} `, cwd], ['wasm-bindgen', `wasm-bindgen ${pins.wasm_bindgen}`, cwd], ['wasm-pack', `wasm-pack ${pins.wasm_pack}`, cwd]]) {
    const actual = command([name, '--version'], toolCwd, env);
    if (expected.endsWith(' ') ? !actual.startsWith(expected) : actual !== expected) throw Object.assign(new Error(`PINNED_TOOL_VERSION_MISMATCH: ${name}: expected ${expected.trim()}; found ${actual}`), { prerequisite: true, blocker: `PINNED_TOOL_VERSION_MISMATCH:${name}` });
  }
  const manifest = path.join(root, 'Cargo.toml');
  command(['cargo', 'build', '--locked', '--manifest-path', manifest, '-p', 'xtask'], cwd, env);
  command([path.join(target, 'debug', process.platform === 'win32' ? 'xtask.exe' : 'xtask'), 'contracts-check'], root, env);
  command(['cargo', 'build', '--locked', '--release', '--manifest-path', manifest, '-p', 'weblabel-api', '--bin', 'weblabel-api'], cwd, env);
  command(['cargo', 'build', '--locked', '--release', '--manifest-path', manifest, '-p', 'wasm-bridge', '--target', 'wasm32-unknown-unknown'], cwd, env);
  const wasmOutput = path.join(intermediate, 'wasm');
  const hostOutput = path.join(intermediate, 'host');
  fs.mkdirSync(wasmOutput);
  command(['wasm-bindgen', path.join(target, 'wasm32-unknown-unknown/release/wasm_bridge.wasm'), '--target', 'web', '--out-dir', wasmOutput, '--out-name', 'wasm_bridge'], cwd, env);
  command(['pnpm', '--filter', '@weblabel/web', 'exec', 'tsc', '--noEmit']);
  command(['pnpm', '--filter', '@weblabel/web', 'exec', 'vite', 'build', '--outDir', path.join(output, 'web')], root, { ...process.env, WEBLABEL_WASM_BRIDGE_DIR: wasmOutput });
  command([process.execPath, path.join(root, 'scripts/build-agent-host.mjs'), '--out-dir', hostOutput]);
  fs.mkdirSync(path.join(output, 'api'), { recursive: true });
  const apiName = process.platform === 'win32' ? 'weblabel-api.exe' : 'weblabel-api';
  fs.copyFileSync(path.join(target, 'release', apiName), path.join(output, 'api', apiName));
  fs.mkdirSync(path.join(output, 'host'));
  for (const name of ['runtime.mjs', 'mcp.mjs']) fs.copyFileSync(path.join(hostOutput, name), path.join(output, 'host', name));
  fs.mkdirSync(path.join(output, 'migrations'));
  const migrationSource = path.join(root, 'crates/weblabel-api/migrations');
  for (const name of fs.readdirSync(migrationSource).filter(name => /^\d+_.+\.sql$/.test(name)).sort()) fs.copyFileSync(checkedPath(migrationSource, name), path.join(output, 'migrations', name));
  const manifestData = { format: 'weblabel-local-release', version: 1, platform: process.platform, arch: process.arch, pins, source_commit: command(['git', 'rev-parse', 'HEAD']), files: entries(output) };
  for (const required of [`api/${apiName}`, 'host/runtime.mjs', 'host/mcp.mjs', 'web/index.html', 'web/wasm/wasm_bridge.js', 'web/wasm/wasm_bridge_bg.wasm']) if (!manifestData.files.some(item => item.path === required && item.size > 0)) throw new Error(`build_missing: ${required}`);
  fs.writeFileSync(path.join(output, 'release.json'), JSON.stringify(manifestData, null, 2));
  console.log(`release_built: ${output}`);
  return output;
}
mainGuard(import.meta.url, () => buildRelease());
