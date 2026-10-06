import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, appendFile, writeFile, rm, copyFile, readFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const report = path.join(root, 'reports/T31/producer');
const runtime = path.join(root, 'target/t31-mirror-smoke-runtime');
await mkdir(runtime, { recursive: true });
await mkdir(report, { recursive: true });
const reserve = createServer();
const archive = path.join(report, `prior-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(archive);
for (const file of ['smoke.log', 'browser-results.json', 'dense-observation.json', 'actual-dense-100.cpuprofile']) {
  try { await copyFile(path.join(report, file), path.join(archive, file)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const env = { ...process.env, WEBLABEL_T31_ORIGIN: origin, WEBLABEL_API_BINARY: process.env.WEBLABEL_API_BINARY ?? path.join(root, 'target/t31/debug/weblabel-api.exe'), TEMP: runtime, TMP: runtime, TMPDIR: runtime };
const pnpm = path.join(process.env.APPDATA, 'npm/node_modules/pnpm/bin/pnpm.cjs');
const viteArgv = [process.execPath, pnpm, '--filter', '@weblabel/web', 'exec', 'vite', '--config', path.join(root, 'reports/T31/vite.config.ts'), '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--mode', 'test'];
const logfd = fs.openSync(path.join(report, 'vite.log'), 'w');
const vite = spawn(viteArgv[0], viteArgv.slice(1), { cwd: root, env, shell: false, windowsHide: true, stdio: ['ignore', logfd, logfd] });
fs.closeSync(logfd);
const closed = new Promise(resolve => vite.once('close', resolve));
let exit = 1;
try {
  const files = ['crates/wasm-bridge/src/facade.rs', 'crates/wasm-bridge/src/lib.rs', 'apps/web/src/lib/editor/EditorHost.ts', 'apps/web/src/lib/editor/types.ts', 'apps/web/src/lib/persistence/draft-store.ts', 'apps/web/src/lib/persistence/save-queue.ts', 'apps/web/src/features/workbench/DenseHarness.tsx', 'apps/web/src/features/workbench/Workbench.tsx', 'apps/web/src/features/workbench/ObjectList.tsx'];
  const source = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')])));
  await writeFile(path.join(report, 'source.json'), JSON.stringify({ base_commit: 'c2e873389e0f1d07ddfb33b75646b926306321c4', source_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), files: source }, null, 2));
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(origin)).ok) break; } catch {}
    if (Date.now() > deadline || vite.exitCode !== null) throw new Error('Private Vite readiness failed');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  let driver = 'unknown';
  try { driver = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,AdapterCompatibility | ConvertTo-Json -Compress'], { encoding: 'utf8' })); } catch {}
  await writeFile(path.join(report, 'environment.json'), JSON.stringify({ origin, api_binary: env.WEBLABEL_API_BINARY, os: { platform: os.platform(), release: os.release(), arch: os.arch() }, cpu: os.cpus()[0]?.model ?? 'unknown', driver, formal_gate_rerun: false }, null, 2));
  const argv = [process.execPath, pnpm, 'exec', 'playwright', 'test', '--config=reports/T31/producer-smoke.config.ts'];
  const log = path.join(report, 'smoke.log');
  await writeFile(log, JSON.stringify({ argv, cwd: root }) + '\n');
  const child = spawn(argv[0], argv.slice(1), { cwd: root, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let writes = Promise.resolve();
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { process.stdout.write(chunk); writes = writes.then(() => appendFile(log, chunk)); });
  exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 1)); });
  await writes;
  await appendFile(log, `\nEXIT_CODE=${exit}\n`);
  await appendFile(path.join(report, 'commands.jsonl'), JSON.stringify({ mode: 'actual-browser-smoke', argv, cwd: root, exit_code: exit, log_path: 'reports/T31/producer/smoke.log' }) + '\n');
} finally {
  if (vite.exitCode === null) { try { execFileSync('taskkill.exe', ['/PID', String(vite.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
  const code = await closed;
  await appendFile(path.join(report, 'commands.jsonl'), JSON.stringify({ mode: 'private-vite', argv: viteArgv, cwd: root, exit_code: code, pid: vite.pid, service: true }) + '\n');
  await rm(runtime, { recursive: true, force: true });
}
process.exitCode = exit;
