import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runArgv } from './task.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv.slice(2);
const requireDevice = input.includes('--require-device');
const args = input.filter((value) => value !== '--require-device');
if (requireDevice) process.env.REQUIRE_WGPU_DEVICE = '1';

const buildStatus = await runArgv([process.execPath, 'scripts/build-wgpu-probe.mjs'], root);
if (buildStatus !== 0) {
  process.exitCode = buildStatus;
} else {
  const status = await runArgv(['pnpm', 'exec', 'playwright', 'test', ...args], root);
  process.exitCode = [0, 130, 143].includes(status) ? status : 1;
}
