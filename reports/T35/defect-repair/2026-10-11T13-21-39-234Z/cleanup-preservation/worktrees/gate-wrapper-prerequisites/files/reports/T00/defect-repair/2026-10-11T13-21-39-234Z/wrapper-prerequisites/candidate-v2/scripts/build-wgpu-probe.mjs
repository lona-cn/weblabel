import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runArgv, resolveArgv } from './task.mjs';
import { options, mainGuard } from './build.mjs';

mainGuard(import.meta.url, async () => {
  options(process.argv.slice(2), []);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const output = path.join(root, 'target', 'weblabel-wgpu-probe');
  const tools = [['wasm-pack', 'wasm-pack 0.15.0'], ['wasm-bindgen', 'wasm-bindgen 0.2.128']];
  for (const [name, expected] of tools) {
    const [command, ...args] = resolveArgv([name, '--version']);
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', shell: false, windowsHide: true });
    const actual = result.status === 0 ? (result.stdout ?? '').trim() : 'unavailable';
    if (actual !== expected) {
      console.log(JSON.stringify({ format: 'weblabel-wgpu-probe', version: 1, status: 'blocked', blockers: ['PINNED_TOOL_UNAVAILABLE'], tool: { name, expected, actual } }));
      process.exitCode = 2;
      return;
    }
  }
  const status = await runArgv([
    'wasm-pack', 'build', 'crates/renderer-wgpu', '--target', 'web', '--out-dir', output,
    '--out-name', 'renderer_wgpu_probe', '--dev',
  ], root);
  process.exitCode = [0, 130, 143].includes(status) ? status : 1;
});
