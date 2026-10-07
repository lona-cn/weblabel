import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pins, requireNode, command } from './build.mjs';
requireNode();
if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.GITHUB_ENV) throw new Error('ci_setup_requires_github_runner');
const corepack = path.resolve(path.dirname(process.execPath), process.platform === 'win32' ? 'node_modules/corepack/dist/pnpm.js' : '../lib/node_modules/corepack/dist/pnpm.js');
if (!fs.existsSync(corepack)) throw new Error('selected_node_distribution_missing_corepack');
command([process.execPath, corepack, '--version']);
for (const [binary, crate, version] of [['wasm-bindgen', 'wasm-bindgen-cli', pins.wasm_bindgen], ['wasm-pack', 'wasm-pack', pins.wasm_pack]]) {
  const probe = spawnSync(binary, ['--version'], { encoding: 'utf8', shell: false });
  if (probe.status !== 0 || probe.stdout.trim() !== binary + ' ' + version) command(['cargo', 'install', crate, '--version', version, '--locked', '--force']);
  if (command([binary, '--version']).trim() !== binary + ' ' + version) throw new Error('cli_pin_mismatch:' + binary);
}
const python = command(['python', '-c', 'import sys; print(sys.executable)']).trim();
const pythonVersion = command([python, '-c', 'import platform; print(platform.python_version())']).trim();
if (pythonVersion !== '3.13.16') throw new Error('python_pin_mismatch');
const uvVersion = command(['uv', '--version']).trim();
if (!/^uv 0\.12\.17(?: \([^()\r\n]+\))?$/.test(uvVersion)) throw new Error('uv_pin_mismatch');
fs.appendFileSync(process.env.GITHUB_ENV, ['WEBLABEL_TEST_NODE=' + process.execPath, 'WEBLABEL_NODE_RUNTIME=' + process.execPath, 'PYTHON=' + python, 'UV_PYTHON=' + python, ''].join(String.fromCharCode(10)));
console.log(JSON.stringify({ node: process.version, python, python_version: pythonVersion, uv_version: uvVersion, wasm_bindgen: pins.wasm_bindgen, wasm_pack: pins.wasm_pack }));
