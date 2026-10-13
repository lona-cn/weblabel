import { beforeAll, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildRelease } from '../../scripts/build.mjs';
import { activeHostShutdown, prepareTerminalAssembly, type PreparedTerminalAssembly } from '../support/active-host-shutdown.mjs';
import { taskReportPath } from '../support/report-paths.mjs';

let release: string;
let preparedTerminal: PreparedTerminalAssembly;
beforeAll(async () => {
  if (process.platform !== 'win32') throw new Error('T33 physical console acceptance requires Windows ConPTY; not a POSIX/mocked signal substitute');
  release = process.env.WEBLABEL_T33_RELEASE ?? taskReportPath('T33', 'runtime', `release-${crypto.randomUUID()}`);
  if (!process.env.WEBLABEL_T33_RELEASE) {
    const cwd = process.env.WEBLABEL_CARGO_CWD ?? 'D:/cache/cargo/bin';
    const compiler = spawnSync('rustup', ['which', 'rustc'], { cwd, env: { ...process.env, RUSTUP_TOOLCHAIN: '1.96.0' }, encoding: 'utf8', shell: false });
    if (compiler.status !== 0) throw new Error(compiler.stderr);
    const original = process.env.RUSTC;
    process.env.RUSTC = compiler.stdout.trim();
    try { await buildRelease(['--build-dir', release, '--cargo-cwd', cwd, '--target-dir', process.env.CARGO_TARGET_DIR ?? taskReportPath('T33', 'runtime', 'build-cache')]); }
    finally { if (original === undefined) delete process.env.RUSTC; else process.env.RUSTC = original; }
  }
  expect(fs.existsSync(path.join(release, 'api/weblabel-api.exe'))).toBe(true);
  preparedTerminal = await prepareTerminalAssembly({ reportDir: taskReportPath('T33') });
}, 600000);

it.each(['direct-api', 'packaged'])('physical Ctrl+C during an authorized %s run reclaims the stubborn owned tree before API termination', async mode => {
  const observed = await activeHostShutdown(mode, preparedTerminal, release, { reportDir: taskReportPath('T33'), skipSecurity: process.env.WEBLABEL_SKIP_SECURITY === '1' });
  expect(observed.pre_signal.model_state).toBe('running');
  expect(observed.host_marker.actual_run_token_context_status).toBe(200);
  expect(observed.physical.signal_count).toBe(1);
  expect(observed.physical.root_exit_at_api).not.toBe(259);
  expect(observed.physical.descendant_exit_at_api).not.toBe(259);
  expect(observed.cleanup).toMatchObject({ host_listener_closed: true, api_listener_closed: true, runtime_lock_absent: true, sqlite_integrity: 'ok', foreign_key_errors: [], backstop_used_before_observation: false });
}, 120000);