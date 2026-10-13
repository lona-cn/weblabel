//! Hardened child-process spawning and process-tree reclamation.
//!
//! Policy: shell:false always, only trusted executable paths, argv as a string
//! array (never concatenated shell commands), environment built from an explicit
//! allowlist (never the whole process.env), and a restricted working directory.
//!
//! Windows tree reclamation (exercised on the Windows workstation):
//!   1. snapshot the process table (PowerShell `Get-CimInstance Win32_Process`),
//!      keeping stale parent pids so orphans of a crashed child are still found;
//!   2. `taskkill /pid <root> /T /F` reclaims the live tree, including children
//!      spawned in new process groups (detached);
//!   3. `taskkill /pid <orphan> /F` per surviving descendant from the snapshot;
//!   4. bounded liveness polling for the root and every known descendant.
//! Discovery, helpers, descendant sweep and identity verification share one
//! five-second deadline; failed/partial observations never prove reclamation.
//! Linux reuses the API binary's private per-child subreaper broker. READY/GO
//! gates launch; pinned parent identity and a private ECHILD acknowledgement
//! gate completion. Other POSIX platforms retain the snapshot/signal sweep.

import { execFile, spawn as spawnProcess, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import { redactText } from './redaction';

export class SpawnPolicyError extends Error {
  readonly code: string;

  constructor(code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'SpawnPolicyError';
    this.code = code;
  }
}

export interface SpawnPolicy {
  /** Absolute directories whose executables may be launched. */
  trusted_executable_roots: string[];
  /** Environment variable names allowed to reach the child. */
  allowed_env: string[];
  /** Absolute directory the child's cwd must stay inside. */
  cwd_root: string;
  /** Where allowlisted variable values are read from (defaults to process.env). */
  source_env?: Record<string, string | undefined>;
}

export interface ChildSpec {
  executable: string;
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  /** Never allowed; accepted only so misuse becomes a controlled error. */
  shell?: boolean;
}

export interface ReclaimReport {
  root_pid: number;
  mechanism: string;
  descendants_found: number[];
  killed: number[];
}

export interface ReclaimRoot {
  root_pid: number;
  /** Date.now() taken right after the root process was spawned. */
  spawned_at_ms: number;
  /**
   * Date.now() taken when the root's exit was observed. Descendants created
   * after this point cannot belong to the tree (pid reuse), so they are never
   * killed: leaking a stale edge is safer than killing an unrelated process.
   */
  exited_at_ms?: number;
}

export interface SpawnedChild {
  pid: number;
  started_at_ms: number;
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  wait(): Promise<{ code: number | null; signal: string | null }>;
  killTree(reason: string): Promise<ReclaimReport>;
}

export interface SuperviseResult {
  outcome: 'exited' | 'crashed' | 'timeout' | 'cancelled';
  exit_code: number | null;
  reclaimed: ReclaimReport;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RECLAIM_DEADLINE_MS = 5000;

function canonicalExisting(target: string, label: string): string {
  if (typeof target !== 'string' || target.length === 0 || !isAbsolute(target)) {
    throw new SpawnPolicyError(`${label}_untrusted`, 'must be an absolute path');
  }
  if (target.includes('\0')) throw new SpawnPolicyError(`${label}_invalid`, 'NUL byte in path');
  let canonical: string;
  try {
    canonical = realpathSync(target);
  } catch {
    throw new SpawnPolicyError(`${label}_missing`, target);
  }
  return canonical;
}

function isUnderAny(target: string, roots: string[]): boolean {
  return roots.some((root) => {
    let canonicalRoot: string;
    try {
      canonicalRoot = realpathSync(root);
    } catch {
      throw new SpawnPolicyError('trusted_root_missing', root);
    }
    const rel = relative(canonicalRoot, target);
    return (
      rel === '' ||
      (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
    );
  });
}

function buildChildEnv(overrides: Record<string, string> | undefined, policy: SpawnPolicy): Record<string, string> {
  const source = policy.source_env ?? process.env;
  // Windows environment names are case-insensitive: an allowlisted SystemRoot
  // must still find a SYSTEMROOT-shaped source entry.
  const sourceKeys = new Map<string, string>();
  for (const key of Object.keys(source)) sourceKeys.set(key.toLowerCase(), key);
  const env: Record<string, string> = {};
  for (const key of policy.allowed_env) {
    if (!ENV_NAME.test(key)) throw new SpawnPolicyError('env_name_invalid', key);
    const sourceKey = sourceKeys.get(key.toLowerCase());
    const value = sourceKey === undefined ? undefined : source[sourceKey];
    if (typeof value === 'string') env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!ENV_NAME.test(key)) throw new SpawnPolicyError('env_name_invalid', key);
    if (!policy.allowed_env.includes(key)) throw new SpawnPolicyError('env_not_allowlisted', key);
    if (typeof value !== 'string') throw new SpawnPolicyError('env_value_invalid', key);
    env[key] = value;
  }
  return env;
}

function exitPromise(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number | null; signal: string | null }>();
  if (child.exitCode !== null || child.signalCode !== null) {
    resolve({ code: child.exitCode, signal: child.signalCode });
  } else {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  }
  return promise;
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function systemTool(name: string): string {
  if (process.platform !== 'win32') return name;
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const candidates = [
    resolve(systemRoot, 'System32', name),
    resolve(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', name),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  return found ?? name;
}

function remainingBudget(deadline: number, stage: string): number {
  const remaining = Math.ceil(deadline - performance.now());
  if (remaining <= 0) throw new SpawnPolicyError('reclaim_incomplete', `${stage}: reclaim deadline exceeded`);
  return remaining;
}

function runTool(executable: string, argv: string[], deadline: number, allowNonzeroExit = false): Promise<string> {
  const timeout = remainingBudget(deadline, executable);
  return new Promise((resolve, reject) => {
    // execFile kills its own helper on timeout/buffer overflow and waits for
    // close before invoking the callback; no raced, abandoned helper remains.
    execFile(executable, argv, {
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout,
      killSignal: 'SIGKILL',
    }, (error, stdout, stderr) => {
      try {
        remainingBudget(deadline, executable);
        // A completed taskkill may return nonzero when a target already exited.
        // Only identity verification can declare success, never helper failure.
        if (error && !(allowNonzeroExit && typeof error.code === 'number' && !error.killed && error.signal === null)) {
          throw error;
        }
        if (!allowNonzeroExit && stderr.trim() !== '') throw new Error(stderr.trim());
        resolve(stdout);
      } catch (cause) {
        const failure = new SpawnPolicyError('reclaim_incomplete', `${executable}: reclaim helper failed`);
        failure.cause = cause;
        reject(failure);
      }
    });
  });
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface ProcessRecord {
  ppid: number;
  /** Process creation time in epoch ms; null when the platform does not report it. */
  created_ms: number | null;
}

function parseProcessTable(output: string): Map<number, ProcessRecord> {
  const records = new Map<number, ProcessRecord>();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*(\S*)\s*$/.exec(line);
    if (line.trim() === '') continue;
    if (!match) throw new SpawnPolicyError('reclaim_incomplete', 'invalid process table row');
    const pid = Number(match[1]);
    const created = match[3] === '' ? null : Date.parse(match[3]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(Number(match[2])) || records.has(pid) ||
        (process.platform === 'win32' && (created === null || Number.isNaN(created)))) {
      throw new SpawnPolicyError('reclaim_incomplete', 'invalid process identity in table');
    }
    records.set(pid, {
      ppid: Number(match[2]),
      created_ms: Number.isNaN(created) ? null : created,
    });
  }
  if (records.size === 0) throw new SpawnPolicyError('reclaim_incomplete', 'empty process table');
  return records;
}

async function snapshotProcessTable(deadline: number): Promise<Map<number, ProcessRecord>> {
  const result =
    process.platform === 'win32'
      ? await runTool(
          systemTool('powershell.exe'),
          [
            '-NoProfile',
            '-Command',
            '$ErrorActionPreference = "Stop"; Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToUniversalTime().ToString(\'o\'))" }',
          ],
          deadline,
        )
      : await runTool('ps', ['-A', '-o', 'pid=,ppid='], deadline);
  const table = parseProcessTable(result);
  remainingBudget(deadline, 'process table validation');
  return table;
}

function findDescendants(rootPid: number, table: Map<number, ProcessRecord>): number[] {
  const found: number[] = [];
  const queue = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const [pid, record] of table) {
      if (record.ppid !== current || seen.has(pid)) continue;
      seen.add(pid);
      found.push(pid);
      queue.push(pid);
    }
  }
  return found;
}

/** A target counts as reclaimed when its pid is gone or the pid now names a different process. */
function stillSameProcess(target: { pid: number; created_ms: number | null }, table: Map<number, ProcessRecord>): boolean {
  const record = table.get(target.pid);
  if (!record) return false;
  if (record.created_ms === null || target.created_ms === null) return true;
  return record.created_ms === target.created_ms;
}

export async function reclaimProcessTree(root: ReclaimRoot, reason: string): Promise<ReclaimReport> {
  if (process.platform === 'linux') {
    throw new SpawnPolicyError('reclaim_requires_owned_broker', 'Linux reclamation requires the spawned child capability');
  }
  const cutoffMs = Date.now();
  const deadline = performance.now() + RECLAIM_DEADLINE_MS;
  const table = await snapshotProcessTable(deadline);
  const rootRecord = table.get(root.root_pid);
  // Pid reuse guard: if the root pid now names a process newer than ours, the
  // pid was recycled and killing "its tree" would kill unrelated processes.
  const rootIsOurs =
    rootRecord === undefined ||
    rootRecord.created_ms === null ||
    rootRecord.created_ms <= root.spawned_at_ms;
  // Lineage bound: a genuine descendant was created after the root spawned and
  // before the root exited. Anything newer belongs to a recycled root pid and
  // is leaked rather than killed.
  const lineageUpperMs = root.exited_at_ms ?? cutoffMs;
  const descendants = findDescendants(root.root_pid, table).filter((pid) => {
    const record = table.get(pid);
    if (record?.created_ms == null) return true;
    return record.created_ms >= root.spawned_at_ms && record.created_ms <= lineageUpperMs;
  });
  const targets = [
    ...(rootIsOurs ? [root.root_pid] : []),
    ...descendants,
  ].map((pid) => ({ pid, created_ms: table.get(pid)?.created_ms ?? null }));
  const mechanism =
    process.platform === 'win32'
      ? 'windows taskkill /T + CIM descendant sweep (creation-time identity checked)'
      : 'posix signal sweep (ps snapshot + SIGKILL; ps exposes no creation time, so creation identity is unavailable on POSIX)';
  if (process.platform === 'win32') {
    if (rootIsOurs && rootRecord !== undefined) {
      await runTool(systemTool('taskkill.exe'), ['/pid', String(root.root_pid), '/T', '/F'], deadline, true);
    }
  } else {
    for (const target of targets) {
      remainingBudget(deadline, 'signal sweep');
      try {
        process.kill(target.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  let descendantsSwept = process.platform !== 'win32';
  // With an absent root no tool ran after discovery, so this is also the
  // first fresh orphan identity query. Never carry it across an await.
  let discoveryTable = process.platform === 'win32' && rootRecord === undefined ? table : undefined;
  for (;;) {
    if (targets.length === 0) break;
    const verificationTable = discoveryTable ?? await snapshotProcessTable(deadline);
    discoveryTable = undefined;
    const alive = targets.filter((target) => stillSameProcess(target, verificationTable));
    if (alive.length === 0) break;
    if (!descendantsSwept) {
      descendantsSwept = true;
      let firstDescendant = true;
      // The successful table already proves absent identities reclaimed. Only
      // survivors need the fresh pre-kill identity query and orphan sweep.
      for (const target of alive) {
        if (target.pid === root.root_pid) continue;
        const identityTable = firstDescendant ? verificationTable : await snapshotProcessTable(deadline);
        firstDescendant = false;
        if (stillSameProcess(target, identityTable)) {
          await runTool(systemTool('taskkill.exe'), ['/pid', String(target.pid), '/F'], deadline, true);
        }
      }
      continue;
    }
    await delay(Math.min(250, remainingBudget(deadline, reason + ': identity verification')));
  }
  return {
    root_pid: root.root_pid,
    mechanism,
    descendants_found: descendants,
    killed: targets.map((target) => target.pid),
  };
}

export function spawnChild(spec: ChildSpec, policy: SpawnPolicy): SpawnedChild {
  if (spec.shell) {
    throw new SpawnPolicyError('shell_forbidden', 'shell:true is never allowed; launch executables with argv arrays');
  }
  if (!Array.isArray(spec.argv) || spec.argv.some((argument) => typeof argument !== 'string')) {
    throw new SpawnPolicyError('argv_must_be_array', 'argv must be a string array; shell string concatenation is forbidden');
  }
  if (spec.argv.some((argument) => argument.includes('\0'))) {
    throw new SpawnPolicyError('argv_invalid', 'argv must not contain NUL bytes');
  }
  const executable = canonicalExisting(spec.executable, 'executable');
  if (statSync(executable).isDirectory() || !isUnderAny(executable, policy.trusted_executable_roots)) {
    throw new SpawnPolicyError('executable_untrusted', `${spec.executable} is outside the trusted executable roots`);
  }
  const cwd = canonicalExisting(spec.cwd, 'cwd');
  if (!statSync(cwd).isDirectory() || !isUnderAny(cwd, [policy.cwd_root])) {
    throw new SpawnPolicyError('cwd_untrusted', `${spec.cwd} is outside the restricted cwd root`);
  }
  const env = buildChildEnv(spec.env, policy);
  if (process.platform === 'linux') {
    const broker = canonicalExisting(process.env.WEBLABEL_API_BINARY ?? '', 'runtime_broker');
    if (!statSync(broker).isFile()) throw new SpawnPolicyError('runtime_broker_untrusted');
    const stat = readFileSync('/proc/self/stat', 'utf8');
    const startTicks = stat.slice(stat.lastIndexOf(') ') + 2).split(/\s+/)[19];
    if (!/^\d+$/.test(startTicks ?? '')) throw new SpawnPolicyError('runtime_broker_identity_unavailable');
    const child = spawnProcess(broker, [
      '--weblabel-node-runtime-broker', '3', String(process.pid), startTicks, executable, ...spec.argv,
    ], { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    let spawnFailure: SpawnPolicyError | undefined;
    let onSpawnError = (error: Error) => {
      spawnFailure ??= new SpawnPolicyError('spawn_failed', `could not launch owned Linux broker ${broker}`);
      spawnFailure.cause = error;
      spawnFailure.message = `spawn_failed: ${error.message}`;
      // The synchronous no-PID response has already been emitted by its caller.
      // Preserve the later errno/cause as a redacted stderr diagnostic as well.
      process.stderr.write(`[spawn] ${redactText(spawnFailure.message)}\n`);
    };
    child.once('error', (error: Error) => onSpawnError(error));
    if (child.pid === undefined) {
      spawnFailure = new SpawnPolicyError('spawn_failed', `could not launch owned Linux broker ${broker}`);
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      (child.stdio[3] as Duplex | null)?.destroy();
      throw spawnFailure;
    }
    const pid = child.pid;
    const started_at_ms = Date.now();
    const control = child.stdio[3] as Duplex;
    const completion = Promise.withResolvers<void>();
    // Adapters may not await wait() until after reading stdout. Keep the original
    // rejection observable then, without an interim unhandled rejection.
    void completion.promise.catch(() => {});
    const exited = exitPromise(child);
    let ready = false;
    let acknowledged = false;
    let stopping = false;
    let reclaim: Promise<ReclaimReport> | undefined;
    const fail = (detail: string) => {
      completion.reject(new SpawnPolicyError('reclaim_incomplete', detail));
      control.destroy();
    };
    const startupTimer = setTimeout(() => fail('Linux broker startup deadline exceeded'), RECLAIM_DEADLINE_MS);
    control.on('data', (bytes: Buffer) => {
      for (const status of bytes) {
        if (!ready) {
          if (status !== 0) { fail('Linux broker initialization failed'); return; }
          ready = true;
          clearTimeout(startupTimer);
          control.write(Buffer.from([stopping ? 1 : 0]));
          if (stopping) control.end();
        } else if (!acknowledged) {
          if (status !== 0) { fail('Linux broker did not confirm owned-child cleanup'); return; }
          acknowledged = true;
        } else {
          fail('Linux broker sent an unexpected completion byte');
          return;
        }
      }
    });
    control.on('error', (error: Error) => fail(`Linux broker control failed: ${error.message}`));
    control.on('end', () => {
      clearTimeout(startupTimer);
      if (acknowledged) completion.resolve();
      else fail('Linux broker closed without cleanup acknowledgement');
    });
    control.on('close', () => {
      clearTimeout(startupTimer);
      if (acknowledged) completion.resolve();
      else fail('Linux broker closed without cleanup acknowledgement');
    });
    onSpawnError = (error: Error) => {
      clearTimeout(startupTimer);
      const failure = new SpawnPolicyError('spawn_failed', `Linux broker spawn failed: ${error.message}`);
      failure.cause = error;
      completion.reject(failure);
      control.destroy();
    };
    const waited = Promise.all([exited, completion.promise]).then(([status]) => status);
    void waited.catch(() => {});
    return {
      pid,
      started_at_ms,
      stdin: child.stdin!,
      stdout: child.stdout!,
      stderr: child.stderr!,
      wait: () => waited,
      killTree: (reason: string) => {
        if (reclaim) return reclaim;
        stopping = true;
        clearTimeout(startupTimer);
        // EOF on this private peer requests cleanup of this broker's kernel
        // children only; never signal a bare PID or infer reparented ownership.
        if (ready) control.end();
        reclaim = (async () => {
          const deadline = Promise.withResolvers<never>();
          const timer = setTimeout(() => deadline.reject(
            new SpawnPolicyError('reclaim_incomplete', `${reason}: Linux broker cleanup deadline exceeded`),
          ), RECLAIM_DEADLINE_MS);
          try {
            await Promise.race([waited, deadline.promise]);
            // ACK proves owned children stopped/reaped, not which PIDs received
            // SIGKILL. The broker can exit voluntarily after a normal CLI exit.
            return { root_pid: pid, mechanism: 'linux per-child subreaper broker + pidfd + ECHILD acknowledgement', descendants_found: [], killed: [] };
          } catch (error) {
            completion.reject(error);
            throw error;
          } finally {
            clearTimeout(timer);
            control.destroy();
          }
        })();
        return reclaim;
      },
    };
  }
  const child = spawnProcess(executable, spec.argv, {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (child.pid === undefined) {
    throw new SpawnPolicyError('spawn_failed', `could not launch ${spec.executable}`);
  }
  const pid = child.pid;
  const started_at_ms = Date.now();
  const exited = exitPromise(child);
  return {
    pid,
    started_at_ms,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    wait: () => exited,
    killTree: (reason: string) => reclaimProcessTree({ root_pid: pid, spawned_at_ms: started_at_ms }, reason),
  };
}

export async function superviseChild(
  child: SpawnedChild,
  options: { timeoutMs?: number | null; signal?: AbortSignal } = {},
): Promise<SuperviseResult> {
  const exited = child.wait();
  const { promise: stopped, resolve: stop } = Promise.withResolvers<'timeout' | 'cancelled'>();
  const timeoutMs = options.timeoutMs ?? null;
  const timer = timeoutMs !== null && timeoutMs > 0 ? setTimeout(() => stop('timeout'), timeoutMs) : null;
  const onAbort = () => stop('cancelled');
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const winner = await Promise.race([exited.then(() => 'exit' as const), stopped]);
    if (winner === 'exit') {
      // Captured before the reclaim snapshot: descendants born after the root
      // died cannot belong to its tree (pid reuse) and must not be killed.
      const exited_at_ms = Date.now();
      const { code, signal } = await exited;
      const reclaimed = process.platform === 'linux'
        ? await child.killTree('exit cleanup')
        : await reclaimProcessTree(
            { root_pid: child.pid, spawned_at_ms: child.started_at_ms, exited_at_ms },
            'exit cleanup',
          );
      return { outcome: code === 0 && signal === null ? 'exited' : 'crashed', exit_code: code, reclaimed };
    }
    const reclaimed = await child.killTree(winner);
    await exited;
    return { outcome: winner, exit_code: null, reclaimed };
  } finally {
    if (timer !== null) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
