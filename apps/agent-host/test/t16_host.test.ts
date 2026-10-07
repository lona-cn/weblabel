import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { HostSession, type HostSessionOptions } from '../src/index';
import { ProviderRegistry, type ProviderAdapter } from '../src/registry';
import { NdjsonFramer, PROTOCOL_VERSION, RequestIdTracker, parseEnvelope, serializeEnvelope, type RuntimeEnvelope } from '../src/protocol';
import { GrantStore, type ImageGrant } from '../src/security/grants';
import { IMAGE_REDACTED, REDACTED, redactText, redactValue } from '../src/security/redaction';
import {
  isProcessAlive,
  spawnChild,
  superviseChild,
  type ChildSpec,
  type SpawnPolicy,
  type SpawnedChild,
} from '../src/security/spawn';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '..', '..', '..');
const fakeRuntime = resolve(repoRoot, 'tests', 'support', 'fake-runtime.mjs');

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function makeWorkDir(prefix: string): string {
  const dir = join(tmpdir(), `t16-${prefix}-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => resolve(p).replace(/\//g, '\\').toLowerCase();
  return norm(a) === norm(b);
}

class LineCollector {
  readonly lines: string[] = [];
  private buffer = '';
  attach(stream: NodeJS.ReadableStream): void {
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string | Buffer) => this.pushText(typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
  }
  write(chunk: string): unknown {
    this.pushText(chunk);
    return true;
  }
  readAll(): string[] {
    return this.lines;
  }
  private pushText(text: string): void {
    this.buffer += text;
    for (;;) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) break;
      this.lines.push(this.buffer.slice(0, index));
      this.buffer = this.buffer.slice(index + 1);
    }
  }
}

interface FakeRuntimeHandles {
  stdout: LineCollector;
  stderr: LineCollector;
  ledger: string[];
  readLedger(): string[];
}

function policyFor(workDir: string, extraAllowed: string[] = [], sourceEnv?: Record<string, string | undefined>): SpawnPolicy {
  return {
    trusted_executable_roots: [dirname(realpathSync(process.execPath))],
    cwd_root: workDir,
    allowed_env: [
      'TEST_SCENARIO',
      'FAKE_RUNTIME_LEDGER',
      'FAKE_RUNTIME_PID_FILE',
      'FAKE_RUNTIME_SPAWN_CHILD',
      'T16_CHILD_VISIBLE',
      'SystemRoot',
      'SystemDrive',
      'TEMP',
      'TMP',
      ...extraAllowed,
    ],
    source_env: sourceEnv ?? { ...process.env },
  };
}

function readLedgerFile(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

// ---------------------------------------------------------------------------
// Behavior 1: NDJSON envelope limits and controlled protocol failures
// ---------------------------------------------------------------------------

it('rejects oversized messages before JSON decode', () => {
  expect(() => parseEnvelope('x'.repeat(4 * 1024 * 1024 + 1))).toThrow(/message_too_large/);
});

it('rejects a mismatched protocol', () => {
  expect(() => parseEnvelope(JSON.stringify({ protocol_version: 99, id: 'x', kind: 'request', method: 'probe', payload: {} }))).toThrow(
    /protocol_version/,
  );
});

it('rejects multi-line input and truncated single lines with controlled errors', () => {
  expect(() => parseEnvelope('{"protocol_version":1}\n{"protocol_version":1}')).toThrow(/multi_line/);
  expect(() => parseEnvelope('{"protocol_version":1,"id":"x","kind":"request","method":"probe"')).toThrow(/invalid_json/);
  const framer = new NdjsonFramer();
  framer.push('{"protocol_version":1,"id":"x"');
  expect(() => framer.flush()).toThrow(/truncated_message/);
});

it('caps streamed lines before decode and rejects unknown methods and duplicate request ids', () => {
  const framer = new NdjsonFramer();
  expect(() => framer.push('x'.repeat(4 * 1024 * 1024 + 1))).toThrow(/message_too_large/);
  expect(() =>
    parseEnvelope(JSON.stringify({ protocol_version: 1, id: 'x', kind: 'request', method: 'shell_exec', payload: {} })),
  ).toThrow(/unknown_method/);
  const tracker = new RequestIdTracker();
  tracker.track('req-1');
  expect(() => tracker.track('req-1')).toThrow(/duplicate_request_id/);
});

// ---------------------------------------------------------------------------
// Behavior 2: crash / timeout / cancel reclaim detached descendants
// ---------------------------------------------------------------------------

it('reclaims detached descendants on cancel and leaves hand-edited state untouched', { timeout: 30000 }, async () => {
  const workDir = makeWorkDir('cancel 目录');
  const ledgerFile = join(workDir, 'ledger.ndjson');
  const markerFile = join(workDir, '手工编辑 state.json');
  const markerBefore = 'HAND EDITED v2\n{"user":"kept"}\n';
  writeFileSync(markerFile, markerBefore);

  const registry = new ProviderRegistry();
  registry.register('mock', mockAdapter(), { mock: true });
  const output = new LineCollector();
  const logs = new LineCollector();
  const options: HostSessionOptions = {
    registry,
    input: new PassThrough(),
    output,
    logs,
    spawnPolicy: policyFor(workDir),
    childSpec: (runId) => fakeChildSpec(workDir, {
      TEST_SCENARIO: 'spawn_child',
      FAKE_RUNTIME_PID_FILE: join(workDir, `${runId}-pids`),
      FAKE_RUNTIME_LEDGER: ledgerFile,
    }),
    runTimeoutMs: 20000,
  };
  const session = new HostSession(options);
  await session.handleParentLine(requestLine('req-h', 'probe', {}));
  await session.handleParentLine(requestLine('req-1', 'start_run', { run_id: 'run-cancel' }));
  const runPidFile = join(workDir, 'run-cancel-pids');
  await waitFor('grandchild pid file', () => existsSync(`${runPidFile}.grandchild`));
  const { grandchild_pid: grandchildPid } = JSON.parse(readFileSync(runPidFile, 'utf8'));
  await session.handleParentLine(requestLine('req-2', 'cancel_run', { run_id: 'run-cancel' }));
  await session.waitForRuns();

  const deadline = Date.now() + 8000;
  while (isProcessAlive(grandchildPid) && Date.now() < deadline) await sleep(100);
  expect(isProcessAlive(grandchildPid)).toBe(false);
  const state = session.getRunState('run-cancel');
  expect(state?.status).toBe('cancelled');
  expect(readFileSync(markerFile, 'utf8')).toBe(markerBefore);
  await session.close();
});

it('keeps the Host usable after a Linux exec denial and cancels before provider launch', { timeout: 30000 }, async () => {
  const workDir = makeWorkDir('immediate cancel 目录');
  const ledger = join(workDir, 'billed-requests');
  const pids = join(workDir, 'immediate-pids');
  const session = new HostSession({
    registry: new ProviderRegistry(),
    input: new PassThrough(),
    output: new LineCollector(),
    logs: new LineCollector(),
    spawnPolicy: policyFor(workDir),
    childSpec: (runId) => fakeChildSpec(workDir, {
      TEST_SCENARIO: runId === 'recovered' ? 'normal' : 'slow',
      FAKE_RUNTIME_LEDGER: runId === 'recovered' ? join(workDir, 'recovered-requests') : ledger,
      FAKE_RUNTIME_PID_FILE: runId === 'recovered' ? join(workDir, 'recovered-pids') : pids,
      FAKE_RUNTIME_SPAWN_CHILD: runId === 'recovered' ? '0' : '1',
    }),
    runTimeoutMs: 20000,
  });
  try {
    await session.handleParentLine(requestLine('immediate-probe', 'probe', {}));
    if (process.platform === 'linux') {
      const executableBroker = process.env.WEBLABEL_API_BINARY;
      const deniedBroker = join(workDir, 'existing broker without execute permission');
      writeFileSync(deniedBroker, 'must fail with real exec EACCES', { mode: 0o600 });
      try {
        process.env.WEBLABEL_API_BINARY = deniedBroker;
        await session.handleParentLine(requestLine('denied-start', 'start_run', { run_id: 'denied' }));
        // Node emits exec errors on nextTick. Yield through the check phase,
        // rather than guessing how many milliseconds emission will take.
        const emitted = Promise.withResolvers<void>();
        setImmediate(emitted.resolve);
        await emitted.promise;
        expect(session.getRunState('denied')?.status).toBe('failed');
        expect(session.getRunState('denied')?.error_code).toBe('spawn_failed');
      } finally {
        if (executableBroker === undefined) delete process.env.WEBLABEL_API_BINARY;
        else process.env.WEBLABEL_API_BINARY = executableBroker;
      }
      await session.handleParentLine(requestLine('recovered-start', 'start_run', { run_id: 'recovered' }));
      await session.waitForRuns();
      expect(session.getRunState('recovered')?.status).toBe('succeeded');
      expect(session.getRunState('recovered')?.error_code).toBeNull();
    }
    await session.handleParentLine(requestLine('immediate-start', 'start_run', { run_id: 'immediate' }));
    await session.handleParentLine(requestLine('immediate-stop', 'cancel_run', { run_id: 'immediate' }));
    await session.waitForRuns();
    expect(session.getRunState('immediate')?.status).toBe('cancelled');
    expect(session.getRunState('immediate')?.error_code).toBeNull();
    if (process.platform === 'linux') {
      expect(existsSync(pids)).toBe(false);
      expect(readLedgerFile(ledger)).toEqual([]);
    }
  } finally {
    await session.close();
  }
});

it('reclaims detached descendants when a run times out', { timeout: 30000 }, async () => {
  const workDir = makeWorkDir('timeout 目录');
  const registry = new ProviderRegistry();
  registry.register('mock', mockAdapter(), { mock: true });
  const output = new LineCollector();
  const logs = new LineCollector();
  const session = new HostSession({
    registry,
    input: new PassThrough(),
    output,
    logs,
    spawnPolicy: policyFor(workDir),
    childSpec: () => fakeChildSpec(workDir, {
      TEST_SCENARIO: 'slow',
      FAKE_RUNTIME_SPAWN_CHILD: '1',
      FAKE_RUNTIME_PID_FILE: join(workDir, 'slow-pids'),
    }),
    runTimeoutMs: 700,
  });
  await session.handleParentLine(requestLine('req-h', 'probe', {}));
  await session.handleParentLine(requestLine('req-1', 'start_run', { run_id: 'run-timeout' }));
  await waitFor('grandchild pid file', () => existsSync(join(workDir, 'slow-pids.grandchild')));
  await session.waitForRuns();

  const { grandchild_pid: grandchildPid } = JSON.parse(readFileSync(join(workDir, 'slow-pids'), 'utf8'));
  const deadline = Date.now() + 8000;
  while (isProcessAlive(grandchildPid) && Date.now() < deadline) await sleep(100);
  expect(isProcessAlive(grandchildPid)).toBe(false);
  const state = session.getRunState('run-timeout');
  expect(state?.status).toBe('timeout');
  expect(state?.error_code).toBe('run_timeout');
  await session.close();
});

it('reclaims detached descendants left behind by a crashing child', { timeout: 30000 }, async () => {
  const workDir = makeWorkDir('crash 目录');
  const registry = new ProviderRegistry();
  registry.register('mock', mockAdapter(), { mock: true });
  const output = new LineCollector();
  const logs = new LineCollector();
  const session = new HostSession({
    registry,
    input: new PassThrough(),
    output,
    logs,
    spawnPolicy: policyFor(workDir),
    childSpec: () => fakeChildSpec(workDir, {
      TEST_SCENARIO: 'crash',
      FAKE_RUNTIME_SPAWN_CHILD: '1',
      FAKE_RUNTIME_PID_FILE: join(workDir, 'crash-pids'),
    }),
    runTimeoutMs: 20000,
  });
  await session.handleParentLine(requestLine('req-h', 'probe', {}));
  await session.handleParentLine(requestLine('req-1', 'start_run', { run_id: 'run-crash' }));
  await waitFor('grandchild pid file', () => existsSync(join(workDir, 'crash-pids.grandchild')));
  await session.waitForRuns();

  const { grandchild_pid: grandchildPid, pid: childPid } = JSON.parse(readFileSync(join(workDir, 'crash-pids'), 'utf8'));
  expect(isProcessAlive(childPid)).toBe(false);
  const deadline = Date.now() + 8000;
  while (isProcessAlive(grandchildPid) && Date.now() < deadline) await sleep(100);
  expect(isProcessAlive(grandchildPid)).toBe(false);
  const state = session.getRunState('run-crash');
  expect(state?.status).toBe('failed');
  expect(state?.error_code).toBe('child_crashed');
  await session.close();
});

it('stops a crash orphan heartbeat, preserves exit 7, and leaves another owned run alive', { timeout: 30000 }, async () => {
  const workDir = makeWorkDir('owned crash 目录');
  const crashedFile = join(workDir, 'crashed-pids');
  const foreignFile = join(workDir, 'foreign-pids');
  const policy = policyFor(workDir);
  const crashed = spawnChild(fakeChildSpec(workDir, {
    TEST_SCENARIO: 'crash', FAKE_RUNTIME_SPAWN_CHILD: '1', FAKE_RUNTIME_PID_FILE: crashedFile,
  }), policy);
  let foreign: SpawnedChild | undefined;
  let reclaimed = false;
  try {
    crashed.stdout.resume();
    crashed.stderr.resume();
    foreign = spawnChild(fakeChildSpec(workDir, {
      TEST_SCENARIO: 'slow', FAKE_RUNTIME_SPAWN_CHILD: '1', FAKE_RUNTIME_PID_FILE: foreignFile,
    }), policy);
    foreign.stdout.resume();
    foreign.stderr.resume();
    await waitFor('both live descendant heartbeats', () =>
      readLedgerFile(`${crashedFile}.heartbeat`).length > 0 && readLedgerFile(`${foreignFile}.heartbeat`).length > 0);
    const crashedPids = JSON.parse(readFileSync(crashedFile, 'utf8'));
    const foreignPids = JSON.parse(readFileSync(foreignFile, 'utf8'));
    const supervised = superviseChild(crashed, { timeoutMs: 20000 });
    crashed.stdin.write(`${requestLine('owned-crash', 'start_run', { run_id: 'owned-crash' })}\n`);
    const result = await supervised;
    reclaimed = true;
    expect(result.outcome).toBe('crashed');
    expect(result.exit_code).toBe(7);
    expect(await crashed.wait()).toEqual({ code: 7, signal: null });
    expect(isProcessAlive(crashedPids.pid)).toBe(false);
    expect(isProcessAlive(crashedPids.grandchild_pid)).toBe(false);
    const stoppedHeartbeat = readFileSync(`${crashedFile}.heartbeat`, 'utf8');
    const foreignHeartbeat = readLedgerFile(`${foreignFile}.heartbeat`).length;
    await sleep(600);
    expect(readFileSync(`${crashedFile}.heartbeat`, 'utf8')).toBe(stoppedHeartbeat);
    expect(isProcessAlive(foreignPids.pid)).toBe(true);
    expect(isProcessAlive(foreignPids.grandchild_pid)).toBe(true);
    expect(readLedgerFile(`${foreignFile}.heartbeat`).length).toBeGreaterThan(foreignHeartbeat);
  } finally {
    await cleanupTestRuns(crashed, foreign, reclaimed);
  }
  if (process.platform === 'linux') {
    const faultMarker = join(workDir, 'self exiting fault CLI');
    const releaseFaultCli = join(workDir, 'release fault CLI');
    // Hold the real CLI until cleanup's backstop releases it. Its broker cannot
    // naturally exit/recycle before fault injection, even under a loaded runner.
    // Fake timers cannot drive this external process's release-file observation.
    const faulted = spawnChild({
      executable: process.execPath,
      argv: ['-e', `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(faultMarker)}, String(process.pid)); setInterval(() => { if (fs.existsSync(${JSON.stringify(releaseFaultCli)})) process.exit(7); }, 20)`],
      cwd: workDir,
    }, policy);
    const faultForeignFile = join(workDir, 'fault foreign pids');
    let faultForeign: SpawnedChild | undefined;
    let faultInjected = false;
    try {
      faulted.stdout.resume();
      faulted.stderr.resume();
      faultForeign = spawnChild(fakeChildSpec(workDir, {
        TEST_SCENARIO: 'slow', FAKE_RUNTIME_SPAWN_CHILD: '1', FAKE_RUNTIME_PID_FILE: faultForeignFile,
      }), policy);
      faultForeign.stdout.resume();
      faultForeign.stderr.resume();
      await waitFor('fault CLI and independent heartbeat', () =>
        existsSync(faultMarker) && readLedgerFile(`${faultForeignFile}.heartbeat`).length > 0);
      const foreignPids = JSON.parse(readFileSync(faultForeignFile, 'utf8'));
      // Fault only this owned broker. The fixture CLI's backstop releases it;
      // no stale PID or guessed lineage recovers the failed capability.
      process.kill(faulted.pid, 'SIGKILL');
      faultInjected = true;
      await expect(faulted.wait()).rejects.toMatchObject({ code: 'reclaim_incomplete' });
      const failedCleanup = faulted.killTree('initial fault cleanup');
      await expect(failedCleanup).rejects.toMatchObject({ code: 'reclaim_incomplete' });
      expect(faulted.killTree('same failed cleanup')).toBe(failedCleanup);
      await expect(cleanupTestRuns(faulted, faultForeign, false)).rejects.toMatchObject({ code: 'reclaim_incomplete' });
      expect(isProcessAlive(foreignPids.pid)).toBe(false);
      expect(isProcessAlive(foreignPids.grandchild_pid)).toBe(false);
      const stopped = readFileSync(`${faultForeignFile}.heartbeat`, 'utf8');
      // A non-event in another OS process needs a real heartbeat observation
      // window; test-process fake timers cannot prove its writes have stopped.
      await sleep(300);
      expect(readFileSync(`${faultForeignFile}.heartbeat`, 'utf8')).toBe(stopped);
    } finally {
      writeFileSync(releaseFaultCli, 'exit');
      try {
        if (!faultInjected) await faulted.killTree('fault setup backstop');
      } finally {
        if (faultForeign) await faultForeign.killTree('fault regression backstop');
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Behavior 3: hardened spawning
// ---------------------------------------------------------------------------

it('rejects shell usage, string argv, untrusted paths and non-allowlisted env keys', () => {
  const workDir = makeWorkDir('hardening 目录');
  const policy = policyFor(workDir);
  const base: ChildSpec = { executable: process.execPath, argv: [fakeRuntime], cwd: workDir };
  expect(() => spawnChild({ ...base, shell: true }, policy)).toThrow(/shell_forbidden/);
  // Deliberate misuse: a shell-style command string instead of an argv array.
  const shellStyleArgv = `${process.execPath} ${fakeRuntime}` as unknown as string[];
  expect(() => spawnChild({ ...base, argv: shellStyleArgv }, policy)).toThrow(/argv_must_be_array/);
  expect(() => spawnChild({ ...base, executable: 'C:\\Windows\\System32\\where.exe' }, policy)).toThrow(/executable_untrusted/);
  expect(() => spawnChild({ ...base, executable: fakeRuntime }, policy)).toThrow(/executable_untrusted/);
  expect(() => spawnChild({ ...base, cwd: tmpdir() }, policy)).toThrow(/cwd_untrusted/);
  expect(() => spawnChild({ ...base, env: { T16_CANARY_SECRET: 'nope' } }, policy)).toThrow(/env_not_allowlisted/);
  expect(() => spawnChild({ ...base, argv: [fakeRuntime, 'a\0b'] }, policy)).toThrow(/argv_invalid/);
});

it('spawns with an env allowlist only and round-trips spaces and CJK in cwd and argv', { timeout: 20000 }, async () => {
  const workDir = makeWorkDir('env 目录 with space');
  const argvEcho = ['参数 with space', 'plain', '值 值'];
  const sourceEnv: Record<string, string | undefined> = {
    ...process.env,
    T16_CANARY_SECRET: 'canary-must-not-appear',
    T16_CHILD_VISIBLE: 'visible-value',
    NODE_OPTIONS: '--require=t16-canary-must-not-load',
    NODE_PATH: 't16-canary-module-path',
    LD_PRELOAD: 't16-canary-must-not-load',
    DYLD_INSERT_LIBRARIES: 't16-canary-must-not-load',
  };
  const policy = policyFor(workDir, [], sourceEnv);
  const childProbe = `
    console.log(JSON.stringify({
      env_keys: Object.keys(process.env).sort(),
      system_root: process.env.SystemRoot ?? null,
      visible_value: process.env.T16_CHILD_VISIBLE,
      argv: process.argv.slice(1),
      cwd: process.cwd(),
    }));
  `;
  const child = spawnChild(
    { executable: process.execPath, argv: ['-e', childProbe, '--', ...argvEcho], cwd: workDir, env: { TEST_SCENARIO: 'normal' } },
    policy,
  );
  try {
    const stdout = new LineCollector();
    stdout.attach(child.stdout);
    await waitFor('child process state', () => stdout.readAll().length > 0);
    const payload: unknown = JSON.parse(stdout.readAll()[0]);
    if (typeof payload !== 'object' || payload === null || !('env_keys' in payload) || !('argv' in payload) || !('cwd' in payload)) {
      throw new Error('probe response payload is missing env_keys/argv/cwd');
    }
    const envKeys: string[] = Array.isArray(payload.env_keys) ? payload.env_keys : [];
    const echoedArgv: string[] = Array.isArray(payload.argv) ? payload.argv : [];
    for (const key of ['T16_CANARY_SECRET', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES']) {
      expect(envKeys.map((candidate) => candidate.toUpperCase())).not.toContain(key);
    }
    expect(envKeys).toContain('T16_CHILD_VISIBLE');
    expect('visible_value' in payload ? payload.visible_value : undefined).toBe('visible-value');
    const sourceValues = new Map(Object.entries(sourceEnv).map(([key, value]) => [key.toLowerCase(), value]));
    const sourceSystemRoot = sourceValues.get('systemroot');
    if (process.platform === 'win32') expect(sourceSystemRoot).toEqual(expect.any(String));
    if (sourceSystemRoot !== undefined) {
      expect(envKeys).toContain('SystemRoot');
    } else {
      expect(envKeys).not.toContain('SystemRoot');
    }
    expect('system_root' in payload ? payload.system_root : undefined).toBe(sourceSystemRoot ?? null);
    // Only Windows injects this mandatory baseline into a minimal environment block.
    const platformBaseline = process.platform === 'win32'
      ? ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR']
      : [];
    const expectedAllowed = policy.allowed_env.filter(
      (key) => key === 'TEST_SCENARIO' || typeof sourceValues.get(key.toLowerCase()) === 'string',
    );
    for (const key of expectedAllowed) expect(envKeys).toContain(key);
    expect(envKeys.every((key) => expectedAllowed.includes(key) || platformBaseline.includes(key))).toBe(true);
    expect(echoedArgv).toEqual(argvEcho);
    expect(samePath(typeof payload.cwd === 'string' ? payload.cwd : '', workDir)).toBe(true);
  } finally {
    await child.killTree('test cleanup');
  }
});

// ---------------------------------------------------------------------------
// Behavior 4: redaction of secrets, cookies, authorization and image bytes
// ---------------------------------------------------------------------------

it('redacts secrets, cookies, authorization headers and image bytes from text and values', () => {
  const text = redactText(
    'authorization: Bearer sk-live-secret-123\ncookie: session=abc123; token=tp-plan-987654321\ntoken: sk-abcdefghijklmnop\njwt: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U\nimg: data:image/png;base64,QUJDREVGR0g=',
  );
  expect(text).not.toContain('sk-live-secret-123');
  expect(text).not.toContain('session=abc123');
  expect(text).not.toContain('tp-plan-987654321');
  expect(text).not.toContain('sk-abcdefghijklmnop');
  expect(text).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  expect(text).not.toContain('QUJDREVGR0g=');
  expect(text).toContain(REDACTED);
  expect(text).toContain(IMAGE_REDACTED);

  const redacted = redactValue({
    api_key: 'sk-super-secret-key-000',
    nested: { authorization: 'Bearer sk-nested-secret', cookie: 'session=nested', secret_ref: 'env:MY_TOKEN', token_ref: 'keyring:alias' },
    image_bytes: [137, 80, 78, 71, ...Array.from({ length: 40 }, (_, i) => i)],
    image_data_url: `data:image/jpeg;base64,${'QUJD'.repeat(200)}`,
    big_blob: 'A'.repeat(400),
    safe: 'hello',
  });
  const serialized = JSON.stringify(redacted);
  expect(serialized).not.toContain('sk-super-secret-key-000');
  expect(serialized).not.toContain('sk-nested-secret');
  expect(serialized).not.toContain('session=nested');
  expect(serialized).not.toContain('137,80,78,71');
  expect(serialized).not.toContain('QUJDQUJD');
  expect(serialized).not.toContain('AAAA');
  if (typeof redacted !== 'object' || redacted === null) throw new Error('redactValue must return an object');
  if (!('api_key' in redacted) || !('image_bytes' in redacted) || !('safe' in redacted) || !('nested' in redacted)) {
    throw new Error('redactValue dropped required keys');
  }
  expect(redacted.api_key).toBe(REDACTED);
  expect(redacted.image_bytes).toBe(IMAGE_REDACTED);
  expect(redacted.safe).toBe('hello');
  const nested = redacted.nested;
  if (typeof nested !== 'object' || nested === null || !('secret_ref' in nested) || !('token_ref' in nested)) {
    throw new Error('redactValue must keep secret references');
  }
  expect(nested.secret_ref).toBe('env:MY_TOKEN');
  expect(nested.token_ref).toBe('keyring:alias');
});

it('keeps host protocol output and logs free of secrets and image bytes', { timeout: 30000 }, async () => {
  const workDir = makeWorkDir('redact 目录');
  const ledgerFile = join(workDir, 'ledger.ndjson');
  const registry = new ProviderRegistry();
  registry.register('mock', mockAdapter(), { mock: true });
  const output = new LineCollector();
  const logs = new LineCollector();
  const session = new HostSession({
    registry,
    input: new PassThrough(),
    output,
    logs,
    spawnPolicy: policyFor(workDir),
    childSpec: () => fakeChildSpec(workDir, { TEST_SCENARIO: 'normal', FAKE_RUNTIME_LEDGER: ledgerFile }),
    runTimeoutMs: 20000,
  });
  await session.handleParentLine(requestLine('req-h', 'probe', {}));
  await session.handleParentLine(requestLine('req-1', 'start_run', { run_id: 'run-redact' }));
  await session.waitForRuns();

  const forwarded = output.readAll().join('\n');
  const logged = logs.readAll().join('\n');
  const combined = `${forwarded}\n${logged}`;
  for (const secret of [
    'sk-should-never-leak-123456',
    'sk-event-secret-9999',
    'sk-event-auth-secret',
    'sk-fake-runtime-secret-0001',
    'fake-cookie-value',
    'fake-event-cookie',
    'QUJDRUZHSElKS0xNTk9QUVJTVFVWV1hZWjE',
    '137,80,78,71',
  ]) {
    expect(combined).not.toContain(secret);
  }
  expect(forwarded).toContain(REDACTED);
  expect(forwarded).toContain(IMAGE_REDACTED);
  await session.close();
});

// ---------------------------------------------------------------------------
// Behavior 5: protocol-only stdout, stderr logs, handshake, probe dimensions
// ---------------------------------------------------------------------------

it('carries protocol only on stdout, logs only on stderr, and handshakes with protocol_version=1', { timeout: 20000 }, async () => {
  const workDir = makeWorkDir('stdio 目录');
  const registry = new ProviderRegistry();
  registry.register('mock', mockAdapter(), { mock: true });
  const output = new LineCollector();
  const logs = new LineCollector();
  const input = new PassThrough();
  const session = new HostSession({
    registry,
    input,
    output,
    logs,
    spawnPolicy: policyFor(workDir),
    childSpec: () => fakeChildSpec(workDir, { TEST_SCENARIO: 'normal' }),
    runTimeoutMs: 20000,
  });
  const running = session.run();
  input.write(`${requestLine('req-h', 'probe', {})}\n`);
  input.write(`${requestLine('req-s', 'shutdown', {})}\n`);
  input.end();
  await running;

  expect(output.readAll().length).toBeGreaterThan(0);
  for (const line of output.readAll()) {
    expect(() => parseEnvelope(line)).not.toThrow();
    expect(line).not.toContain('[host]');
  }
  expect(logs.readAll().join('\n')).toContain('[host]');

  const badVersion = new HostSession({
    registry,
    input: new PassThrough(),
    output: new LineCollector(),
    logs: new LineCollector(),
    spawnPolicy: policyFor(workDir),
    childSpec: () => fakeChildSpec(workDir, { TEST_SCENARIO: 'normal' }),
    runTimeoutMs: 20000,
  });
  await expect(badVersion.handleParentLine(JSON.stringify({ protocol_version: 2, id: 'x', kind: 'request', method: 'probe', payload: {} }))).rejects.toThrow(
    /protocol_version/,
  );
  const wrongFirst = new HostSession({
    registry,
    input: new PassThrough(),
    output: new LineCollector(),
    logs: new LineCollector(),
    spawnPolicy: policyFor(workDir),
    childSpec: () => fakeChildSpec(workDir, { TEST_SCENARIO: 'normal' }),
    runTimeoutMs: 20000,
  });
  await expect(wrongFirst.handleParentLine(requestLine('req-0', 'shutdown', {}))).rejects.toThrow(/handshake/);
  await session.close();
});

// ---------------------------------------------------------------------------
// Behavior 6: run/project/media-hash grants with canonical containment
// ---------------------------------------------------------------------------

it('binds grants to run, project and media hash and contains canonicalized paths under the granted root', () => {
  const workDir = makeWorkDir('grants 根目录');
  const outsideDir = makeWorkDir('grants 外部');
  writeFileSync(join(workDir, 'img 样本 01.png'), 'image-bytes');
  writeFileSync(join(outsideDir, 'secret.txt'), 'outside-secret');
  const mediaHash = createHash('sha256').update('image-bytes').digest('hex');
  const store = new GrantStore();
  const grant: ImageGrant = store.issue({
    run_id: 'run-1',
    project_id: 'project-1',
    media_hash: mediaHash,
    root: workDir,
  });
  const request = { run_id: 'run-1', project_id: 'project-1', media_hash: mediaHash, relative_path: 'img 样本 01.png' };
  expect(samePath(store.resolve(grant.grant_id, request), join(workDir, 'img 样本 01.png'))).toBe(true);
  expect(() => store.resolve(grant.grant_id, { ...request, run_id: 'run-2' })).toThrow(/grant_binding_mismatch/);
  expect(() => store.resolve(grant.grant_id, { ...request, project_id: 'project-2' })).toThrow(/grant_binding_mismatch/);
  expect(() => store.resolve(grant.grant_id, { ...request, media_hash: 'e'.repeat(64) })).toThrow(/grant_binding_mismatch/);
  expect(() => store.resolve(grant.grant_id, { ...request, relative_path: '..\\outside\\x.txt' })).toThrow(/traversal/);
  expect(() => store.resolve(grant.grant_id, { ...request, relative_path: 'C:\\Windows\\win.ini' })).toThrow(/absolute/);
  expect(() => store.resolve(grant.grant_id, { ...request, relative_path: '\\\\server\\share\\x' })).toThrow(/absolute/);
  expect(() => store.resolve(grant.grant_id, { ...request, relative_path: 'missing.png' })).toThrow(/grant_path_missing/);

  symlinkSync(outsideDir, join(workDir, 'junction 逃逸'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => store.resolve(grant.grant_id, { ...request, relative_path: join('junction 逃逸', 'secret.txt') })).toThrow(/grant_path_escape/);
});

// ---------------------------------------------------------------------------
// Provider registry: probe dimensions, mock honesty, no billed auto-retry
// ---------------------------------------------------------------------------

it('exposes availability and verification dimensions and forbids mock registrations claiming real support', async () => {
  const registry = new ProviderRegistry();
  registry.register('mock', mockAdapter(), { mock: true });
  registry.register('local-detector', adapterWithProfile({ availability: 'needs_configuration', verification: 'not_run' }));
  const profiles = await registry.probeAll();
  expect(profiles.length).toBe(2);
  for (const profile of profiles) {
    expect(typeof profile.availability).toBe('string');
    expect(typeof profile.verification).toBe('string');
    expect(['ready', 'needs_login', 'needs_configuration', 'unsupported', 'blocked']).toContain(profile.availability);
    expect(['not_run', 'mock_only', 'live_passed', 'live_failed']).toContain(profile.verification);
  }
  expect(() => registry.register('mock', mockAdapter(), { mock: true })).toThrow(/already_registered/);

  const lier = new ProviderRegistry();
  lier.register('mock', adapterWithProfile({ availability: 'ready', verification: 'live_passed' }), { mock: true });
  await expect(lier.probeAll()).rejects.toThrow(/mock/);
  const imposter = new ProviderRegistry();
  imposter.register('mock', adapterWithProfile({ availability: 'ready', verification: 'mock_only', provider_id: 'openai_api' }), { mock: true });
  await expect(imposter.probeAll()).rejects.toThrow(/mock/);
});

it('never automatically resends a possibly billed run request after a protocol failure', { timeout: 20000 }, async () => {
  const workDir = makeWorkDir('retry 目录');
  const ledgerFile = join(workDir, 'ledger.ndjson');
  const registry = new ProviderRegistry();
  registry.register('mock', mockAdapter(), { mock: true });
  const output = new LineCollector();
  const logs = new LineCollector();
  const session = new HostSession({
    registry,
    input: new PassThrough(),
    output,
    logs,
    spawnPolicy: policyFor(workDir),
    childSpec: () => fakeChildSpec(workDir, { TEST_SCENARIO: 'malformed', FAKE_RUNTIME_LEDGER: ledgerFile }),
    runTimeoutMs: 20000,
  });
  await session.handleParentLine(requestLine('req-h', 'probe', {}));
  await session.handleParentLine(requestLine('req-1', 'start_run', { run_id: 'run-billed' }));
  await session.waitForRuns();
  const state = session.getRunState('run-billed');
  expect(state?.status).toBe('failed');
  expect(state?.error_code).toBe('invalid_json');
  // Real wall-clock settle window: proving a *non-event* (no automatic resend) against a
  // live child process cannot use fake timers; we observe the child's own ledger.
  await sleep(800);
  const ledger = readLedgerFile(ledgerFile);
  expect(ledger.length).toBe(1);
  expect(JSON.parse(ledger[0]).method).toBe('start_run');
  expect(state?.attempts).toBe(1);
  await session.close();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function cleanupTestRuns(crashed: SpawnedChild, foreign: SpawnedChild | undefined, reclaimed: boolean): Promise<void> {
  try {
    if (!reclaimed) await crashed.killTree('failed crash test cleanup');
  } finally {
    if (foreign) await foreign.killTree('foreign run cleanup');
  }
}

function requestLine(id: string, method: 'probe' | 'start_run' | 'cancel_run' | 'shutdown', payload: unknown): string {
  return serializeEnvelope({ protocol_version: PROTOCOL_VERSION, id, kind: 'request', method, payload });
}

function fakeChildSpec(workDir: string, env: Record<string, string>): ChildSpec {
  return {
    executable: process.execPath,
    argv: [fakeRuntime],
    cwd: workDir,
    env,
  };
}

function mockAdapter(): ProviderAdapter {
  return adapterWithProfile({ availability: 'ready', verification: 'mock_only', provider_id: 'mock' });
}

function adapterWithProfile(overrides: {
  availability?: 'ready' | 'needs_login' | 'needs_configuration' | 'unsupported' | 'blocked';
  verification?: 'not_run' | 'mock_only' | 'live_passed' | 'live_failed';
  provider_id?: 'codex_local' | 'claude_local' | 'openai_api' | 'anthropic_api' | 'mimo_api' | 'detector_local' | 'mock';
}): ProviderAdapter {
  return {
    probe: async () => [
      {
        profile_id: 'fake_profile',
        provider_id: overrides.provider_id ?? 'detector_local',
        model_id: 'fake-model',
        auth_kind: 'none',
        capabilities: { image_input: false, tools: false, structured_output: true, bbox_output: true, attributes: false },
        availability: overrides.availability ?? 'needs_configuration',
        verification: overrides.verification ?? 'not_run',
        runtime_version: null,
        verified_at: null,
      },
    ],
    run: async function* () {
      // Registry-level adapters in these tests never execute model work.
    },
  };
}
