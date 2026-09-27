import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runArgv, resolveArgv } from './task.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tools = [['wasm-pack', 'wasm-pack 0.15.0'], ['wasm-bindgen', 'wasm-bindgen 0.2.128']];
for (const [name, expected] of tools) {
  const [command, ...args] = resolveArgv([name, '--version']);
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', shell: false, windowsHide: true });
  const actual = result.status === 0 ? (result.stdout ?? '').trim() : 'unavailable';
  if (actual !== expected) {
    process.stderr.write(`${name}: expected ${expected}; found ${actual}\n`);
    process.exitCode = 1;
    break;
  }
}
if (!process.exitCode) {
  process.exitCode = await runArgv([
    'wasm-pack', 'build', 'crates/wasm-bridge', '--target', 'web',
    '--out-dir', 'target/weblabel-web-public/wasm', '--out-name', 'wasm_bridge', '--dev',
  ], root);
}
