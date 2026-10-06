import { spawn } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const target = path.join(root, 'target/t31-mirror');
const report = path.join(root, 'reports/T31/producer');
const cargo = 'D:/cache/cargo/bin/bin/cargo.exe';
const pnpm = path.join(process.env.APPDATA, 'npm/node_modules/pnpm/bin/pnpm.cjs');
const env = { ...process.env, CARGO_BUILD_JOBS: '1', CARGO_HOME: 'D:/cache/cargo/bin', RUSTUP_HOME: 'D:/cache/cargo', RUSTUP_TOOLCHAIN: '1.96.0', RUSTC: 'D:/cache/cargo/toolchains/1.96.0-x86_64-pc-windows-msvc/bin/rustc.exe', CARGO_TARGET_DIR: target };
const modes = {
  native: [cargo, 'test', '--locked', '--manifest-path', path.join(root, 'Cargo.toml'), '-p', 'wasm-bridge', '--lib', 'facade::tests'],
  wasm: [cargo, 'build', '--locked', '--release', '--manifest-path', path.join(root, 'Cargo.toml'), '-p', 'wasm-bridge', '--target', 'wasm32-unknown-unknown'],
  api: [cargo, 'build', '--locked', '--manifest-path', path.join(root, 'Cargo.toml'), '-p', 'weblabel-api', '--bin', 'weblabel-api'],
  bindgen: ['D:/cache/cargo/bin/bin/wasm-bindgen.exe', path.join(target, 'wasm32-unknown-unknown/release/wasm_bridge.wasm'), '--target', 'web', '--out-dir', path.join(root, 'crates/wasm-bridge/target/weblabel-web-public/wasm'), '--out-name', 'wasm_bridge'],
  unit: [process.execPath, pnpm, 'exec', 'vitest', 'run', 'apps/web/src/lib/persistence/t13_queue.test.ts', 'apps/web/src/lib/editor/t09_lifecycle.test.ts', 'apps/web/src/features/ai/t24_ui.test.tsx', 'apps/web/src/features/workbench/t34_activity.test.tsx', 'apps/web/src/features/review/submission.test.tsx'],
  types: [process.execPath, pnpm, '--filter', '@weblabel/web', 'exec', 'tsc', '--noEmit'],
  smoketypes: [process.execPath, pnpm, 'exec', 'tsc', '--noEmit', '--strict', '--target', 'ES2024', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--skipLibCheck', '--lib', 'ES2024,DOM', '--typeRoots', 'apps/web/node_modules/@types', '--types', 'node', '--allowJs', '--jsx', 'react-jsx', 'reports/T31/producer-smoke.spec.ts', 'reports/T31/producer-smoke.config.ts', 'apps/web/node_modules/vite/client.d.ts'],
  contracts: [process.execPath, '--test', 'tests/contracts-validation.test.mjs'],
  wire: [path.join(target, 'debug/xtask.exe'), 'contracts-check'],
};
const mode = process.argv[2];
const argv = modes[mode];
if (!argv) throw new Error(`Unknown scoped check ${mode}`);
await mkdir(report, { recursive: true });
const cwd = ['native', 'wasm', 'api'].includes(mode) ? 'D:/cache/cargo/bin' : root;
const log = path.join(report, `${mode}-${new Date().toISOString().replaceAll(':', '-')}.log`);
await writeFile(log, JSON.stringify({ argv, cwd }) + '\n');
const child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let writes = Promise.resolve();
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { process.stdout.write(chunk); writes = writes.then(() => appendFile(log, chunk)); });
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 1)); });
await writes;
await appendFile(log, `\nEXIT_CODE=${code}\n`);
await appendFile(path.join(report, 'commands.jsonl'), JSON.stringify({ mode, argv, cwd, exit_code: code, log_path: path.relative(root, log).replaceAll('\\', '/') }) + '\n');
process.exitCode = code;
