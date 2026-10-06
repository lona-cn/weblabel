import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const [label, ...argv] = process.argv.slice(2);
const standard = argv[0] === '--standard-toolchain';
if (standard) argv.shift();
const root = process.cwd();
if (argv[0] === 'cargo' && ['build', 'run', 'check', 'metadata'].includes(argv[1])) {
  const delimiter = argv.indexOf('--');
  argv.splice(delimiter < 0 ? argv.length : delimiter, 0, '--config', `build.build-dir=${JSON.stringify(resolve(root, 'target'))}`);
}
const command = process.platform === 'win32' && argv[0] === 'pnpm' ? [process.execPath, resolve(dirname(process.execPath), 'node_modules/corepack/dist/pnpm.js'), ...argv.slice(1)] : argv;
const logPath = `reports/T29/${label}.log`;
const stream = createWriteStream(logPath);
const startedAt = new Date().toISOString();
const env = { ...process.env, CARGO_HOME: 'D:/cache/cargo/bin', RUSTUP_HOME: 'D:/cache/cargo', RUSTC: 'D:/cache/cargo/toolchains/1.96.0-x86_64-pc-windows-msvc/bin/rustc.exe', CARGO_BUILD_BUILD_DIR: resolve(root, 'target'), CARGO_TARGET_DIR: resolve(root, 'target') };
if (argv[0] === 'pnpm') env.WEBLABEL_API_BINARY = resolve(root, 'target/debug/weblabel-api.exe');
if (standard) {
  delete env.RUSTC;
  delete env.RUSTUP_TOOLCHAIN;
}
const cwd = argv[0] === 'cargo' ? 'D:/cache/cargo/bin' : root;
stream.write(`COMMAND ${JSON.stringify(argv)}\nSTART ${startedAt}\nCWD ${cwd}\nENV ${JSON.stringify({ CARGO_HOME: env.CARGO_HOME, RUSTUP_HOME: env.RUSTUP_HOME, RUSTC: env.RUSTC ?? null, RUSTUP_TOOLCHAIN: env.RUSTUP_TOOLCHAIN ?? null, CARGO_BUILD_BUILD_DIR: env.CARGO_BUILD_BUILD_DIR, CARGO_TARGET_DIR: env.CARGO_TARGET_DIR, WEBLABEL_API_BINARY: env.WEBLABEL_API_BINARY ?? null })}\n`);
const child = spawn(command[0], command.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
let output = '';
for (const channel of ['stdout', 'stderr']) child[channel].on('data', bytes => { output += bytes; stream.write(bytes); process[channel].write(bytes); });
child.on('error', error => { output += error.message; stream.write(error.message + '\n'); });
child.on('close', code => {
  const exit_code = code ?? 1;
  stream.end(`\nEXIT_CODE ${exit_code}\nEND ${new Date().toISOString()}\n`);
  const path = 'reports/T29/commands.json';
  const records = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
  const counts = [...output.matchAll(/^\s*Tests\s+([^\r\n]+)\s+\(\d+\)/gm)];
  const count = kind => counts.length ? counts.reduce((sum, match) => sum + Number(match[1].match(new RegExp(`(\\d+)\\s+${kind}`))?.[1] ?? 0), 0) : null;
  records.push({ argv, exit_code, started_at: startedAt, log_path: logPath, tests_passed: count('passed'), tests_failed: count('failed'), tests_filtered: count('skipped') });
  writeFileSync(path, JSON.stringify(records, null, 2) + '\n');
  process.exitCode = exit_code;
});
