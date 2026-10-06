import { spawn } from 'node:child_process';
import { appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const [name, mode, binary, ...argv] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(name ?? '') || !['normal', 'cargo', 'fresh-api'].includes(mode) || !binary) throw new Error('name mode binary argv required');
let executable = binary;
let args = argv;
let cwd = root;
const env = { ...process.env };
if (mode === 'cargo') {
  cwd = env.CARGO_HOME;
  env.RUSTUP_TOOLCHAIN = '1.96.0-x86_64-pc-windows-msvc';
  env.CARGO_TARGET_DIR = path.join(root, 'target');
  env.CARGO_BUILD_BUILD_DIR = path.join(root, 'target');
}
if (mode === 'fresh-api') env.WEBLABEL_API_BINARY = path.join(root, 'target/debug/weblabel-api.exe');
if (binary === 'pnpm' && process.platform === 'win32') {
  executable = process.execPath;
  args = [path.join(path.dirname(process.execPath), 'node_modules/corepack/dist/pnpm.js'), ...argv];
}
const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) stream.on('data', bytes => { output += bytes; destination.write(bytes); });
const result = await new Promise(resolve => {
  child.once('error', error => resolve({ exit_code: null, error: error.code }));
  child.once('exit', (exit_code, signal) => resolve({ exit_code, signal }));
});
const log_path = `reports/T32/interactive-closure/${name}.log`;
await writeFile(path.join(root, log_path), `> ${[binary, ...argv].join(' ')}\n${output}\nRESULT ${JSON.stringify(result)}\n`);
await appendFile(new URL('./commands.jsonl', import.meta.url), JSON.stringify({ argv: [binary, ...argv], actual_argv: [executable, ...args], cwd, source_root: root, fresh_api_binary: env.WEBLABEL_API_BINARY ?? null, ...result, log_path }) + '\n');
process.exitCode = result.exit_code ?? 1;
