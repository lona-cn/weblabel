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
console.log(JSON.stringify({ node: process.version, wasm_bindgen: pins.wasm_bindgen, wasm_pack: pins.wasm_pack }));
