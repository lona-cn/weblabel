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
  // T31 rebuilds current release WASM and enforces the complete hardware gate.
  gpu: [['node', 'scripts/verify-gpu.mjs']],
};
const postFastBlocker = 'BLOCKED: TypeScript, generated-contract, formatting, and product Rust checks are not registered until their implementation tasks.';
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
    const result = spawnSync(resolved[0], resolved.slice(1), { stdio: 'inherit', shell: false, windowsHide: true, env: process.env });
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
}
