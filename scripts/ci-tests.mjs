import fs from 'node:fs';
import path from 'node:path';
import { options, root, requireNode, command } from './build.mjs';
import { validateRelease } from './start-local.mjs';
requireNode();
const args = options(process.argv.slice(2), ['--release-dir']);
if (!args['--release-dir']) throw new Error('required_release_dir');
const release = fs.realpathSync(path.resolve(args['--release-dir']));
validateRelease(release);
// Engineering preview hashing uses the same verified Rust-WASM built by this run.
const wasmDirectory = path.join(root, 'crates/wasm-bridge/target/weblabel-web-public/wasm');
fs.mkdirSync(wasmDirectory, { recursive: true });
for (const file of ['wasm_bridge.js', 'wasm_bridge_bg.wasm']) {
  fs.copyFileSync(path.join(release, 'web', 'wasm', file), path.join(wasmDirectory, file));
}
const python = process.env.PYTHON || command(['python', '-c', 'import sys; print(sys.executable)']).trim();
Object.assign(process.env, { WEBLABEL_TEST_NODE: process.execPath, WEBLABEL_NODE_RUNTIME: process.execPath, WEBLABEL_T33_RELEASE: release, WEBLABEL_CARGO_CWD: root, PYTHON: python, UV_PYTHON: python });
command([process.execPath, 'scripts/build-agent-host.mjs']);
command(['cargo', 'build', '--locked', '-p', 'weblabel-api', '--bin', 'weblabel-api']);
process.env.WEBLABEL_API_BINARY = path.join(path.resolve(root, process.env.CARGO_TARGET_DIR ?? 'target'), 'debug', process.platform === 'win32' ? 'weblabel-api.exe' : 'weblabel-api');
command(['cargo', 'test', '--workspace', '--locked']);
command([process.execPath, '--test', 'tests/bootstrap/t00.test.mjs', 'tests/contracts-validation.test.mjs', 'tools/check-plan.test.mjs']);
command([process.execPath, 'scripts/verify-plan.mjs']);
command(['cargo', 'run', '--locked', '-p', 'xtask', '--', 'contracts-check']);
command(['pnpm', '--filter', '@weblabel/web', 'exec', 'tsc', '--noEmit']);
// Bound cold compiler/security fixtures and Argon2/CIM consumers to a realistic runner load; deadlines remain unchanged.
const vitest = ['pnpm', 'exec', 'vitest', 'run', '--maxWorkers=2'];
// ConPTY physical Ctrl+C is exercised in the complete Windows lane, not faked on POSIX.
if (process.platform !== 'win32') vitest.push('--exclude', 'tests/integration/t33_active_host_shutdown.test.ts');
command(vitest);
command(['uv', 'run', '--locked', '--project', 'services/detector', '--python', python, 'python', '-V']);
command(['uv', 'run', '--locked', '--project', 'services/detector', '--python', python, 'python', '-m', 'pytest', 'services/detector/tests', '-q']);
console.log(JSON.stringify({ platform: process.platform, checks: ['rust-workspace', 'bootstrap-contracts-plan', 'generated-contracts', 'typescript', 'vitest-all-platform-supported', 'offline-detector'], conpty: process.platform === 'win32' ? 'exercised-by-suite' : 'windows-lane-only', real_ai: 'not-run', g4: 'not-a-software-ci-claim' }));
