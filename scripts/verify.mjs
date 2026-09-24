import { spawnSync } from 'node:child_process';

const gate = process.argv[2];
const commands = {
  fast: [['cargo', 'test', '--workspace', '--locked'], ['node', '--test', 'tests/bootstrap/t00.test.mjs'], ['node', 'scripts/verify-plan.mjs']],
  build: [['cargo', 'build', '--workspace', '--locked'], ['cargo', 'build', '-p', 'renderer-wgpu', '--target', 'wasm32-unknown-unknown', '--locked'], ['cargo', 'build', '-p', 'wasm-bridge', '--target', 'wasm32-unknown-unknown', '--locked']],
};
const postFastBlocker = 'BLOCKED: TypeScript, generated-contract, formatting, and product Rust checks are not registered until their implementation tasks.';
const postBuildBlocker = 'BLOCKED: Web, Node Host, generated-contract checks, and product release composition are implemented by downstream tasks; no app build is claimed.';
const blockers = {
  integration: 'Integration test application does not exist until T06/T10.',
  browser: 'Playwright application and fixtures do not exist until T08/T15.',
  gpu: 'A browser WebGPU device probe does not exist until T05/T09; hardware acceptance is not inferred.',
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
    console.log(`> ${argv.join(' ')}`);
    const result = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit', shell: false, windowsHide: true });
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
