import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { resolveArgv } from './task.mjs';

const scriptPath = fileURLToPath(import.meta.url);

function stopTree(child, signal) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.on('error', () => {});
    child.kill(signal);
  } else {
    try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
  }
}

export function runProcessGroup(commands, cwd = process.cwd()) {
  if (commands.length === 0) return Promise.reject(new Error('No development processes were configured.'));
  let resolved;
  try {
    resolved = commands.map(resolveArgv);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve) => {
    const children = [];
    let remaining = resolved.length;
    let stopping = false;
    let requestedStatus = 0;
    const finish = () => {
      remaining -= 1;
      if (remaining === 0) {
        process.removeListener('SIGINT', onInterrupt);
        process.removeListener('SIGTERM', onTerminate);
        resolve(requestedStatus);
      }
    };
    const stopAll = (signal, status) => {
      if (stopping) return;
      stopping = true;
      requestedStatus = status;
      for (const child of children) stopTree(child, signal);
    };
    const onInterrupt = () => stopAll('SIGINT', 130);
    const onTerminate = () => stopAll('SIGTERM', 143);
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    for (const [command, ...args] of resolved) {
      const child = spawn(command, args, {
        cwd,
        stdio: 'inherit',
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      children.push(child);
      child.once('error', (error) => {
        process.stderr.write(`${command}: ${error.message}\n`);
        stopAll('SIGTERM', 1);
      });
      child.once('close', (code, signal) => {
        if (!stopping) stopAll(signal ?? 'SIGTERM', code === 0 ? 1 : (code ?? 1));
        finish();
      });
    }
  });
}

function main() {
  const root = path.resolve(path.dirname(scriptPath), '..');
  process.env.WEBLABEL_COOKIE_SECURE ??= 'false';
  if (process.argv.includes('--start-local')) {
    const binary = path.join(root, 'target', 'release', process.platform === 'win32' ? 'weblabel-api.exe' : 'weblabel-api');
    if (!fs.existsSync(binary)) {
      console.error('Built local API is missing; run the production build first.');
      return 1;
    }
    return runProcessGroup([[binary]], root);
  }
  const webManifestPath = path.join(root, 'apps', 'web', 'package.json');
  const webManifest = JSON.parse(fs.readFileSync(webManifestPath, 'utf8'));
  if (!webManifest.scripts?.dev) {
    console.error('Web dev server is not configured; the Vite app is supplied by T08.');
    return 1;
  }
  return runProcessGroup([
    ['cargo', 'run', '-p', 'weblabel-api'],
    ['pnpm', '--filter', '@weblabel/web', 'run', 'dev'],
  ], root);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  Promise.resolve(main()).then((status) => { process.exitCode = status; }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
