import { spawn } from 'node:child_process';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const report = path.join(root, 'reports/T31');
const mode = process.argv[2];
const pnpm = path.join(process.env.APPDATA, 'npm/node_modules/pnpm/bin/pnpm.cjs');
const env = { ...process.env, CARGO_HOME: 'D:/cache/cargo/bin', RUSTUP_HOME: 'D:/cache/cargo', RUSTUP_TOOLCHAIN: '1.96.0', RUSTC: 'D:/cache/cargo/toolchains/1.96.0-x86_64-pc-windows-msvc/bin/rustc.exe', CARGO_TARGET_DIR: path.join(root, 'target/t31') };
const commands = {
  types: [process.execPath, pnpm, 'exec', 'tsc', '--noEmit', '--strict', '--target', 'ES2024', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--skipLibCheck', '--lib', 'ES2024,DOM', '--typeRoots', 'apps/web/node_modules/@types', '--types', 'node', '--allowJs', '--jsx', 'react-jsx', 'tests/perf/t31_hardware.spec.ts', 'reports/T31/playwright.config.ts', 'reports/T31/vite.config.ts', 'apps/web/node_modules/vite/client.d.ts'],
  unit: [process.execPath, '--test', 'reports/T31/gate.test.mjs'],
  contractbuild: ['D:/cache/cargo/bin/bin/cargo.exe', 'build', '--locked', '--manifest-path', path.join(root, 'Cargo.toml'), '--target-dir', env.CARGO_TARGET_DIR, '-p', 'xtask'],
  contracts: [path.join(env.CARGO_TARGET_DIR, 'debug/xtask.exe'), 'contracts-check'],
  syntax: [process.execPath, '--check', 'scripts/verify-gpu.mjs'],
  integration: ['git', 'apply', '--check', 'reports/T31/integration.patch'],
};
const argv = commands[mode];
if (!argv) throw new Error(`Unknown check ${mode}`);
const cwd = mode === 'contractbuild' ? 'D:/cache/cargo/bin' : root;
await mkdir(report, { recursive: true });
const log = path.join(report, `${mode}-${new Date().toISOString().replaceAll(':', '-')}.log`);
await writeFile(log, JSON.stringify({ argv, cwd, rust: env.RUSTUP_TOOLCHAIN }) + '\n');
const child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
let writes = Promise.resolve();
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; process.stdout.write(chunk); writes = writes.then(() => appendFile(log, chunk)); });
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 1)); });
await writes;
const matches = output.match(/ℹ tests (\d+)/);
const tests = mode === 'unit' ? { collected: matches ? Number(matches[1]) : 0, passed: Number(output.match(/ℹ pass (\d+)/)?.[1] ?? 0), failed: Number(output.match(/ℹ fail (\d+)/)?.[1] ?? 0) } : null;
const exit = code === 0 && tests?.collected === 0 ? 1 : code;
await appendFile(log, `\nEXIT_CODE=${exit}\n`);
await appendFile(path.join(report, 'checks.jsonl'), JSON.stringify({ argv, cwd, exit_code: exit, tests, log_path: path.relative(root, log).replaceAll('\\', '/') }) + '\n');
process.exitCode = exit;
