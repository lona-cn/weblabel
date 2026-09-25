// Fake provider runtime used by apps/agent-host/test/t16_host.test.ts.
//
// It is a network-free child process speaking the private NDJSON protocol from
// docs/contracts.md C5. It is NOT a provider: the only profile it emits uses
// provider_id 'mock' with verification 'mock_only', and it is never enumerated
// by the production registry.
//
// Environment:
//   TEST_SCENARIO           normal | malformed | oversized | crash | slow | spawn_child
//   FAKE_RUNTIME_LEDGER     optional file; appends one JSON line per received request
//   FAKE_RUNTIME_PID_FILE   optional file; writes {pid, grandchild_pid} when a child is spawned
//   FAKE_RUNTIME_SPAWN_CHILD=1  also spawn a detached grandchild in crash/slow scenarios
//
// stdout carries protocol envelopes only. All logs go to stderr (and carry a
// deliberate secret-looking line so host redaction can be proven).
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';

const VALID_SCENARIOS = ['normal', 'malformed', 'oversized', 'crash', 'slow', 'spawn_child'];
const scenario = process.env.TEST_SCENARIO ?? 'normal';
const ledgerPath = process.env.FAKE_RUNTIME_LEDGER ?? null;
const pidFilePath = process.env.FAKE_RUNTIME_PID_FILE ?? null;

function log(message) {
  process.stderr.write(`[fake-runtime] ${message}\n`);
}

if (!VALID_SCENARIOS.includes(scenario)) {
  log(`unknown scenario ${scenario}`);
  process.exit(2);
}

log(`scenario=${scenario} pid=${process.pid}`);
// Deliberate secret-looking stderr line: the host must redact this before
// forwarding logs anywhere.
log('authorization: Bearer sk-fake-runtime-secret-0001 cookie: session=fake-cookie-value');

const grandchildScript = `
const fs = require('fs');
const target = process.argv[1];
fs.writeFileSync(target + '.grandchild', String(process.pid));
setInterval(() => { fs.appendFileSync(target + '.heartbeat', Date.now() + '\\n'); }, 200);
`;

let grandchildPid = null;
const wantGrandchild = scenario === 'spawn_child' || process.env.FAKE_RUNTIME_SPAWN_CHILD === '1';
if (wantGrandchild) {
  const grandchild = spawn(process.execPath, ['-e', grandchildScript, pidFilePath ?? 't16-grandchild'], {
    stdio: 'ignore',
    detached: true,
  });
  grandchild.unref();
  grandchildPid = grandchild.pid;
  if (pidFilePath) {
    writeFileSync(pidFilePath, `${JSON.stringify({ pid: process.pid, grandchild_pid: grandchildPid })}\n`);
  }
  log(`spawned detached grandchild pid=${grandchildPid}`);
}

function record(method, id) {
  if (ledgerPath) {
    appendFileSync(ledgerPath, `${JSON.stringify({ method, id, at: Date.now() })}\n`);
  }
}

function send(envelope) {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function respond(request, payload) {
  send({ protocol_version: 1, id: request.id, kind: 'response', method: request.method, payload });
}

// Deterministic synthetic bytes that must never leak through the host.
const imageBytes = [137, 80, 78, 71, 13, 10, 26, 10, ...Array.from({ length: 40 }, (_, i) => i + 1)];
const imageDataUrl = `data:image/png;base64,${'QUJDRUZHSElKS0xNTk9QUVJTVFVWV1hZWjE'.repeat(24)}`;

let eventSeq = 0;
let startedRuns = 0;

function handleStartRun(request) {
  startedRuns += 1;
  if (scenario === 'crash') {
    log('crashing on start_run');
    process.exit(7);
  }
  if (scenario === 'slow' || scenario === 'spawn_child') {
    log('staying silent on start_run');
    return;
  }
  if (scenario === 'malformed') {
    process.stdout.write('{"protocol_version":1,"id":"trunc","kind":"event","method":"run_e');
    process.stdout.write('\n');
    return;
  }
  if (scenario === 'oversized') {
    process.stdout.write(`${'x'.repeat(4 * 1024 * 1024 + 8)}\n`);
    return;
  }
  eventSeq += 1;
  send({
    protocol_version: 1,
    id: `ev-${eventSeq}`,
    kind: 'event',
    method: 'run_event',
    payload: {
      run_id: request.payload?.run_id ?? null,
      seq: eventSeq,
      type: 'progress',
      message: 'fake progress',
      token: 'sk-event-secret-9999',
      cookie: 'session=fake-event-cookie',
      authorization: 'Bearer sk-event-auth-secret',
      image_bytes: imageBytes,
      image_data_url: imageDataUrl,
    },
  });
  respond(request, {
    ok: true,
    run_id: request.payload?.run_id ?? null,
    status: 'succeeded',
    echo_token: 'sk-should-never-leak-123456',
    image_bytes: imageBytes,
  });
}

function handleProbe(request) {
  respond(request, {
    ok: true,
    profiles: [
      {
        profile_id: 'fake_mock_profile',
        provider_id: 'mock',
        model_id: 'fake-mock-echo',
        auth_kind: 'none',
        capabilities: { image_input: true, tools: false, structured_output: true, bbox_output: false, attributes: true },
        availability: 'ready',
        verification: 'mock_only',
        runtime_version: 'fake-runtime-0',
        verified_at: null,
      },
    ],
    env_keys: Object.keys(process.env).sort(),
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    grandchild_pid: grandchildPid,
  });
}

let sawStartRun = false;
process.stdin.setEncoding('utf8');
let pending = '';
process.stdin.on('data', (chunk) => {
  pending += chunk;
  for (;;) {
    const index = pending.indexOf('\n');
    if (index < 0) break;
    const line = pending.slice(0, index);
    pending = pending.slice(index + 1);
    if (line.trim() === '') continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      log('received unparseable line');
      continue;
    }
    record(request.method ?? 'unknown', request.id ?? 'no-id');
    if (request.kind !== 'request') continue;
    switch (request.method) {
      case 'probe':
        handleProbe(request);
        break;
      case 'start_run':
        sawStartRun = true;
        handleStartRun(request);
        break;
      case 'cancel_run':
        respond(request, { ok: true, status: 'cancelled' });
        break;
      case 'shutdown':
        respond(request, { ok: true, status: 'shutdown' });
        process.exit(0);
        break;
      default:
        log(`unknown method ${request.method}`);
        respond(request, { ok: false, error: { code: 'unknown_method' } });
    }
  }
});

process.stdin.on('end', () => {
  log(`stdin closed after ${startedRuns} start_run(s)`);
  process.exit(0);
});

setInterval(() => {}, 1 << 30); // keep alive until killed or stdin closes
