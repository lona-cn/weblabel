import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, appendFile, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const run = path.join(root, 'reports/T31/pixels', new Date().toISOString().replaceAll(':', '-'));
await mkdir(path.join(run, 'runtime'), { recursive: true });
const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port; await new Promise(resolve => server.close(resolve));
const env = { ...process.env, WEBLABEL_API_BINARY: path.join(root, 'target/t31/debug/weblabel-api.exe'), WEBLABEL_T31_PIXELS_ORIGIN: `http://127.0.0.1:${port}`, WEBLABEL_T31_PIXELS_RUN: run, TEMP: path.join(run, 'runtime'), TMP: path.join(run, 'runtime'), TMPDIR: path.join(run, 'runtime') };
Object.assign(env, { CARGO_HOME: 'D:/cache/cargo/bin', RUSTUP_HOME: 'D:/cache/cargo', RUSTUP_TOOLCHAIN: '1.96.0', RUSTC: 'D:/cache/cargo/toolchains/1.96.0-x86_64-pc-windows-msvc/bin/rustc.exe', CARGO_TARGET_DIR: path.join(root, 'target/t31') });
const builds = [
  ['D:/cache/cargo/bin/bin/cargo.exe', 'build', '--locked', '--release', '--manifest-path', path.join(root, 'Cargo.toml'), '--target-dir', env.CARGO_TARGET_DIR, '-p', 'wasm-bridge', '--target', 'wasm32-unknown-unknown'],
  ['D:/cache/cargo/bin/bin/wasm-bindgen.exe', path.join(env.CARGO_TARGET_DIR, 'wasm32-unknown-unknown/release/wasm_bridge.wasm'), '--target', 'web', '--out-dir', path.join(root, 'crates/wasm-bridge/target/weblabel-web-public/wasm'), '--out-name', 'wasm_bridge'],
  ['D:/cache/cargo/bin/bin/cargo.exe', 'build', '--locked', '--manifest-path', path.join(root, 'Cargo.toml'), '--target-dir', env.CARGO_TARGET_DIR, '-p', 'weblabel-api', '--bin', 'weblabel-api'],
];
for (const [index, build] of builds.entries()) {
  const result = spawnSync(build[0], build.slice(1), { cwd: 'D:/cache/cargo/bin', env, encoding: 'utf8', shell: false });
  await writeFile(path.join(run, `build-${index}.log`), JSON.stringify({ argv: build, cwd: 'D:/cache/cargo/bin', exit_code: result.status, tests: null }) + '\n' + result.stdout + result.stderr);
  if (result.status !== 0) throw new Error(`Fresh pixel-probe build ${index} failed: ${result.error?.message ?? result.status}`);
}
const argv = [process.execPath, path.join(process.env.APPDATA, 'npm/node_modules/pnpm/bin/pnpm.cjs'), 'exec', 'playwright', 'test', '--config=reports/T31/native-pixels.config.ts', '--project=target-hardware-pixels'];
const log = path.join(run, 'pixels.log');
const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
await writeFile(log, JSON.stringify({ argv, cwd: root, source_commit: source, purpose: 'new all-eight native-control pixel path, not a rerun of accepted RED performance measurements', fresh_build_logs: ['build-0.log', 'build-1.log', 'build-2.log'] }) + '\n');
const child = spawn(argv[0], argv.slice(1), { cwd: root, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let writes = Promise.resolve();
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { process.stdout.write(chunk); writes = writes.then(() => appendFile(log, chunk)); });
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 1)); });
await writes;
await appendFile(log, `\nEXIT_CODE=${code}\n`);
const result = JSON.parse(await readFile(path.join(run, 'browser-results.json'), 'utf8'));
await writeFile(path.join(run, 'command.json'), JSON.stringify({ argv, cwd: root, source_commit: source, exit_code: code, tests: { passed: result.stats.expected, failed: result.stats.unexpected, skipped: result.stats.skipped }, log_path: path.relative(root, log).replaceAll('\\', '/') }, null, 2));
await rm(path.join(run, 'runtime'), { recursive: true, force: true });
process.exitCode = code;
