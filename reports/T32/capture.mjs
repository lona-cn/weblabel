import { spawn, spawnSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const [name, binary, ...argv] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(name ?? '') || !binary) throw new Error('capture requires a safe log name and real argv');
await mkdir(new URL('./', import.meta.url), { recursive: true });
let executable = binary;
let args = argv;
const freshApi = args[0] === '--fresh-api';
if (freshApi) args = args.slice(1);
const env = { ...process.env };
let cwd = root;
if (binary === 'cargo') {
  const active = spawnSync('rustup', ['show', 'active-toolchain'], { cwd: root, encoding: 'utf8', shell: false });
  if (active.status !== 0) throw new Error('Cannot resolve repository toolchain');
  env.RUSTUP_TOOLCHAIN = active.stdout.trim().split(' ')[0];
  env.CARGO_TARGET_DIR = path.join(root, 'target');
  env.CARGO_BUILD_BUILD_DIR = path.join(root, 'target');
  cwd = env.CARGO_HOME;
  if (!cwd || !path.isAbsolute(cwd)) throw new Error('Neutral existing CARGO_HOME required; no global config changes');
}
if (freshApi) env.WEBLABEL_API_BINARY = path.join(root, 'target/debug', process.platform === 'win32' ? 'weblabel-api.exe' : 'weblabel-api');
if (binary === 'pnpm' && process.platform === 'win32') {
  executable = process.execPath;
  args = [path.join(path.dirname(process.execPath), 'node_modules/corepack/dist/pnpm.js'), ...args];
}
const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) stream.on('data', chunk => { output += chunk; destination.write(chunk); });
const outcome = await new Promise(resolve => {
  child.once('error', error => resolve({ exit_code: null, error: error.code }));
  child.once('exit', (code, signal) => resolve({ exit_code: code, signal }));
});
const log = `reports/T32/${name}.log`;
await writeFile(path.join(root, log), `> ${[binary, ...argv].join(' ')}\n${output}\nCAPTURE ${JSON.stringify(outcome)}\n`);
let commands = [];
try { commands = JSON.parse(await readFile(new URL('./commands.json', import.meta.url), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
commands.push({ argv: [binary, ...argv], actual_argv: [executable, ...args], cwd, toolchain: env.RUSTUP_TOOLCHAIN ?? null, fresh_api_binary: freshApi ? env.WEBLABEL_API_BINARY : null, ...outcome, log_path: log });
await writeFile(new URL('./commands.json', import.meta.url), JSON.stringify(commands, null, 2));
await appendFile(new URL('./tests.log', import.meta.url), `> ${[binary, ...argv].join(' ')}\n${output}\nCAPTURE ${JSON.stringify(outcome)}\n`);
process.exitCode = outcome.exit_code ?? 1;
