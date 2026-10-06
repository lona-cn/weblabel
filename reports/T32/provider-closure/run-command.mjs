import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
const [label, executable, ...args] = process.argv.slice(2);
if (!label || !executable) throw new Error('label executable [args] required');
const directory = resolve('reports/T32/provider-closure');
const env = { ...process.env, RUSTUP_TOOLCHAIN: '1.96.0-x86_64-pc-windows-msvc' };
env.RUSTC = execFileSync('rustup', ['which', 'rustc'], { env, encoding: 'utf8' }).trim();
env.CARGO_TARGET_DIR = resolve('target');
env.WEBLABEL_API_BINARY = resolve('target/debug/weblabel-api.exe');
mkdirSync(resolve(directory, 'scratch'), { recursive: true });
env.TMP = env.TEMP = env.TMPDIR = resolve(directory, 'scratch');
// Compile from the cache root to avoid this workstation's unrelated ancestor
// nightly-only Cargo profile; manifest, compiler and all outputs are explicit.
const argv = executable === 'cargo' ? [...args, '--manifest-path', resolve('Cargo.toml'), '--target-dir', resolve('target'), '--config', `build.build-dir=${JSON.stringify(resolve('target'))}`] : args;
const cwd = executable === 'cargo' ? env.CARGO_HOME : process.cwd();
const result = spawnSync(executable === 'node' ? process.execPath : executable, argv, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const output = (result.stdout ?? '') + (result.stderr ?? '') + (result.error ? String(result.error) : '');
const log_path = `reports/T32/provider-closure/${label}.log`;
writeFileSync(log_path, output);
appendFileSync(`${directory}/commands.jsonl`, JSON.stringify({ argv: [executable, ...argv], cwd, exit_code: result.status, signal: result.signal, log_path, node: process.version, rust_toolchain: env.RUSTUP_TOOLCHAIN, rustc: env.RUSTC }) + '\n');
process.stdout.write(output);
process.exitCode = result.status ?? 1;
