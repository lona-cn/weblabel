import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const captureLimit = 64 * 1024;

export function resolveArgv(argv) {
  if (process.platform !== 'win32' || path.basename(argv[0]).toLowerCase() !== 'pnpm') return argv;
  const entries = [
    process.env.APPDATA && path.resolve(process.env.APPDATA, "npm", "node_modules", "pnpm", "bin", "pnpm.cjs"),
    path.resolve(path.dirname(process.execPath), "node_modules", "corepack", "dist", "pnpm.js"),
  ].filter(Boolean);
  const entry = entries.find((candidate) => fs.existsSync(candidate));
  if (!entry) throw new Error("Installed pnpm entrypoint unavailable");
  return [process.execPath, entry, ...argv.slice(1)];
}

export function isZeroTestRun(argv, output) {
  const executable = path.basename(argv[0]).toLowerCase().replace(/\.exe$/, '');
  if (executable === 'node' && argv.includes('--test')) {
    const counts = [...output.matchAll(/ℹ tests (\d+)/g)].map((match) => Number(match[1]));
    return counts.length === 0 || counts.at(-1) === 0;
  }
  if (executable === 'cargo' && argv[1] === 'test') {
    const counts = [...output.matchAll(/running (\d+) tests?/g)].map((match) => Number(match[1]));
    return counts.length === 0 || counts.reduce((sum, count) => sum + count, 0) === 0;
  }
  return /no test files found|no tests found|no tests ran|collected 0 items/i.test(output);
}

/** Numeric completion stays compatible; onClose observes the native exit before normalization.
 * @param {string[]} argv
 * @param {string} cwd
 * @param {{env?: NodeJS.ProcessEnv, onStdout?: (chunk:string)=>void, onStderr?: (chunk:string)=>void, signal?: AbortSignal, onSpawnError?: (error:Error)=>void, onClose?: (code:number|null, signal:NodeJS.Signals|null)=>void}} options
 * @returns {Promise<number>}
 */
export function runArgv(argv, cwd = process.cwd(), options = {}) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((part) => typeof part !== 'string' || part.length === 0)) {
    return Promise.reject(new TypeError('check argv must be a non-empty string array'));
  }
  let command;
  let args;
  try {
    [command, ...args] = resolveArgv(argv);
  } catch (error) {
    return Promise.reject(error);
  }
  if (options.signal?.aborted) return Promise.resolve(options.signal.reason === 'SIGTERM' ? 143 : 130);
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let interrupted = null;
    let settled = false;
    let child;
    let spawnError = false;
    let killerDone = Promise.resolve();
    const reportError = error => {
      const text = `${command}: ${error.message}\n`;
      process.stderr.write(text); options.onStderr?.(text); options.onSpawnError?.(error);
    };
    const complete = (status) => {
      if (settled) return;
      settled = true;
      resolve(status);
    };
    try {
      child = spawn(command, args, {
        cwd,
        stdio: ['inherit', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: options.env,
      });
    } catch (error) {
      reportError(error);
      complete(1);
      return;
    }
    const retain = (current, chunk, stream) => {
      const text = chunk.toString();
      stream.write(text);
      return (current + text).slice(-captureLimit);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { options.onStdout?.(chunk); stdout = retain(stdout, chunk, process.stdout); });
    child.stderr.on('data', (chunk) => { options.onStderr?.(chunk); stderr = retain(stderr, chunk, process.stderr); });
    const onSignal = (signal) => {
      if (interrupted || !child.pid) return;
      interrupted = signal;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killerDone = new Promise(resolve => { killer.once('error', () => { child.kill(signal); resolve(); }); killer.once('close', resolve); });
      } else {
        try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
      }
    };
    const onInterrupt = () => onSignal('SIGINT');
    const onTerminate = () => onSignal('SIGTERM');
    const onAbort = () => onSignal(options.signal.reason === 'SIGTERM' ? 'SIGTERM' : 'SIGINT');
    if (options.signal) { options.signal.addEventListener('abort', onAbort, { once: true }); if (options.signal.aborted) onAbort(); }
    else { process.once('SIGINT', onInterrupt); process.once('SIGTERM', onTerminate); }
    child.once('error', (error) => {
      reportError(error);
      spawnError = true;
    });
    child.once('close', async (code, signal) => {
      await killerDone;
      options.signal?.removeEventListener('abort', onAbort);
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
      options.onClose?.(code, signal);
      let status = spawnError ? 1 : interrupted ? (interrupted === "SIGTERM" ? 143 : 130) : (code ?? (signal === "SIGINT" ? 130 : 1));
      if (status === 0 && isZeroTestRun(argv, `${stdout}\n${stderr}`)) {
        process.stderr.write('Test command collected zero tests.\n');
        status = 1;
      }
      complete(status);
    });
  });
}

export async function runTask(root, taskId, runner = runArgv) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'TASKS.json'), 'utf8'));
  const matches = [...manifest.tasks, ...(manifest.refactor_tasks ?? [])].filter(({ id }) => id === taskId);
  if (matches.length === 0) throw new Error(`unknown task: ${taskId}`);
  if (matches.length !== 1) throw new Error(`duplicate task: ${taskId}`);
  const [task] = matches;
  if (!Array.isArray(task.checks) || task.checks.length === 0) throw new Error(`${taskId} has no checks`);
  for (const argv of task.checks) {
    const status = await runner(argv, root);
    if (status !== 0) return status;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  runTask(root, process.argv[2])
    .then((status) => { process.exitCode = status; })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
