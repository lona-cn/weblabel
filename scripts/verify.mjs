import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const gate = process.argv[2];

// Windows: pnpm is a .cmd shim and cannot be spawned with shell:false. Resolve
// it to the Corepack JS entrypoint (same approach as scripts/task.mjs).
function resolveArgv(argv) {
  if (process.platform !== 'win32' || path.basename(argv[0]).toLowerCase() !== 'pnpm') return argv;
  const corepackEntry = path.resolve(path.dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'pnpm.js');
  if (!fs.existsSync(corepackEntry)) throw new Error(`Cannot resolve Corepack pnpm entrypoint: ${corepackEntry}`);
  return [process.execPath, corepackEntry, ...argv.slice(1)];
}
const commands = {
  fast: [['cargo', 'test', '--workspace', '--locked'], ['node', '--test', 'tests/bootstrap/t00.test.mjs'], ['node', 'scripts/verify-plan.mjs']],
  build: [['cargo', 'build', '--workspace', '--locked'], ['cargo', 'build', '-p', 'renderer-wgpu', '--target', 'wasm32-unknown-unknown', '--locked'], ['cargo', 'build', '-p', 'wasm-bridge', '--target', 'wasm32-unknown-unknown', '--locked']],
  // Real WebGPU visual gate (T05): rebuild the probe from the current renderer
  // sources, then run the screenshot pixel/device-loss checks. The REQUIRE_*_
  // flags force a real, non-software adapter and a ready device — a software
  // GPU or a missing adapter must never pass this gate.
  gpu: [['pnpm', 'wasm:probe-build'], ['pnpm', 'exec', 'playwright', 'test', 'tests/render/t05.spec.ts', '--project=t05-render']],
};
const postFastBlocker = 'BLOCKED: TypeScript, generated-contract, formatting, and product Rust checks are not registered until their implementation tasks.';
const postBuildBlocker = 'BLOCKED: Web, Node Host, generated-contract checks, and product release composition are implemented by downstream tasks; no app build is claimed.';
const blockers = {
  integration: 'Integration test application does not exist until T06/T10.',
  browser: 'Playwright application and fixtures do not exist until T08/T15.',
  live: 'No live provider run is configured. Explicit user authorization and provider setup are required.',
  release: 'Release acceptance requires G1–G5 evidence; this workspace is not an application release.',
};
if (blockers[gate]) {
  console.error(`BLOCKED: ${blockers[gate]}`);
  process.exitCode = 1;
} else if (!commands[gate]) {
  console.error(`Unknown verification gate: ${gate ?? '<missing>'}`);
  process.exitCode = 1;
} else {
  for (const argv of commands[gate]) {
    const resolved = resolveArgv(argv);
    console.log(`> ${argv.join(' ')}`);
    const env =
      gate === 'gpu'
        ? { ...process.env, REQUIRE_WGPU_DEVICE: '1', REQUIRE_HARDWARE_GPU: '1' }
        : process.env;
    const result = spawnSync(resolved[0], resolved.slice(1), { stdio: 'inherit', shell: false, windowsHide: true, env });
    if (result.error) {
      console.error(`${argv[0]}: ${result.error.message}`);
      process.exitCode = 1;
      break;
    }
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
  if (gate === 'fast' && process.exitCode === undefined) {
    console.error(postFastBlocker);
    process.exitCode = 1;
  }
  if (gate === 'build' && process.exitCode === undefined) {
    console.error(postBuildBlocker);
    process.exitCode = 1;
  }
}
