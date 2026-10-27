import fs from 'node:fs';
import path from 'node:path';
import { options, root, requireNode, command } from './build.mjs';
import { validateRelease } from './release-manifest.mjs';
requireNode();
const args = options(process.argv.slice(2), ['--release-dir']);
if (!args['--release-dir']) throw new Error('required_release_dir');
const release = fs.realpathSync(path.resolve(args['--release-dir']));
validateRelease(release);
// Tests consume this run's verified bridge without overwriting an older source-tree build.
Object.assign(process.env, { WEBLABEL_T33_RELEASE: release, WEBLABEL_CARGO_CWD: root, WEBLABEL_WASM_BRIDGE_DIR: path.join(release, 'web/wasm') });
command(['cargo', 'build', '--locked', '-p', 'weblabel-api', '--bin', 'weblabel']);
process.env.WEBLABEL_API_BINARY = path.join(path.resolve(root, process.env.CARGO_TARGET_DIR ?? 'target'), 'debug', process.platform === 'win32' ? 'weblabel.exe' : 'weblabel');
command(['cargo', 'test', '--workspace', '--locked', '--', '--test-threads=2']);
command([process.execPath, '--test', 'tests/bootstrap/*.test.mjs', 'tests/contracts-validation.test.mjs', 'tools/check-plan.test.mjs', 'tools/check-docs.test.mjs']);
command([process.execPath, 'scripts/verify-plan.mjs']);
command([process.execPath, 'tools/check-docs.mjs']);
command(['cargo', 'run', '--locked', '-p', 'xtask', '--', 'contracts-check']);
command(['pnpm', '--filter', '@weblabel/web', 'exec', 'tsc', '--noEmit']);
command(['pnpm', '--filter', '@weblabel/web', 'exec', 'tsc', '--noEmit', '-p', '../../tests/tsconfig.json']);
// Bound cold compiler/security fixtures and Argon2/CIM consumers to a realistic runner load; deadlines remain unchanged.
const vitest = ['pnpm', 'exec', 'vitest', 'run', '--maxWorkers=2'];
// ConPTY physical Ctrl+C is exercised in the complete Windows lane, not faked on POSIX.
if (process.platform !== 'win32') vitest.push('--exclude', 'tests/integration/t33_active_host_shutdown.test.ts');
command(vitest);
console.log(JSON.stringify({ platform: process.platform, checks: ['rust-workspace', 'bootstrap-contracts-plan', 'generated-contracts', 'typescript', 'vitest-all-platform-supported', 'native-detector-controls-no-model-forward'], conpty: process.platform === 'win32' ? 'exercised-by-suite' : 'windows-lane-only', real_ai: 'not-run', g4: 'not-a-software-ci-claim' }));
