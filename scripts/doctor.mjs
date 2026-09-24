import { spawnSync } from 'node:child_process';
import { resolveArgv } from './task.mjs';

const probes = [['node', ['--version']], ['pnpm', ['--version']], ['rustc', ['--version']], ['cargo', ['--version']], ['wasm-pack', ['--version']], ['wasm-bindgen', ['--version']]];
let missingTool = false;
for (const [name, args] of probes) {
  const [command, ...resolvedArgs] = resolveArgv([name, ...args]);
  const result = spawnSync(command, resolvedArgs, { encoding: 'utf8', shell: false, windowsHide: true });
  const value = result.status === 0 ? (result.stdout ?? '').trim() : 'unavailable';
  console.log(`${name}: ${value}`);
  if (result.status !== 0) missingTool = true;
}
if (missingTool) process.exitCode = 1;
console.log('WebGPU: requires browser runtime probe; not inferred by this Node diagnostic.');
console.log('Model providers: credentials are not inspected or printed.');
