import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcessGroup } from '../../scripts/dev.mjs';
import { runArgv, runTask } from '../../scripts/task.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('unknown task exits nonzero and identifies the task', () => {
  const result = spawnSync(process.execPath, ['scripts/task.mjs', 'T99'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown task: T99/);
});

test('doctor exits nonzero when required tools are missing', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'weblabel-t00-path-'));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = temp;
  try {
    const result = spawnSync(process.execPath, ['scripts/doctor.mjs'], { cwd: root, env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /node: unavailable/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('task with no checks is rejected rather than reported successful', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'weblabel-t00-'));
  try {
    fs.writeFileSync(path.join(temp, 'TASKS.json'), JSON.stringify({ tasks: [{ id: 'T01', checks: [] }] }));
    await assert.rejects(runTask(temp, 'T01'), /has no checks/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('failed task subprocess propagates exit and prevents later checks', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'weblabel-t00-'));
  const calls = [];
  try {
    fs.writeFileSync(path.join(temp, 'TASKS.json'), JSON.stringify({ tasks: [{
      id: 'T01', checks: [['first', 'arg'], ['second', 'arg']],
    }] }));
    const status = await runTask(temp, 'T01', (argv) => {
      calls.push(argv);
      return argv[0] === 'first' ? 17 : 0;
    });
    assert.equal(status, 17);
    assert.deepEqual(calls, [['first', 'arg']]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('failed child process exit is preserved', () => {
  const result = spawnSync(process.execPath, ['-e', 'process.exit(23)'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 23);
});

test('Node stdio probe exchanges a versioned request and response', () => {
  const request = JSON.stringify({ protocol_version: 1, id: 'probe', kind: 'request', method: 'probe', payload: null });
  const result = spawnSync(process.execPath, ['tests/bootstrap/stdio-probe.mjs'], {
    cwd: root, input: `${request}\n`, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    protocol_version: 1, id: 'probe', kind: 'response', method: 'probe', payload: { runtime_version: process.version },
  });
});

test('Windows pnpm argv resolves through Node rather than shell execution', { skip: process.platform !== 'win32' }, async () => {
  assert.equal(await runArgv(['pnpm', '--version'], root), 0);
});
test('Node test targets collecting zero tests fail the task runner', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'weblabel t00-'));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    fs.mkdirSync(path.join(temp, 'scripts'));
    fs.copyFileSync(path.join(root, 'scripts/task.mjs'), path.join(temp, 'scripts/task.mjs'));
    fs.writeFileSync(path.join(temp, 'TASKS.json'), JSON.stringify({ tasks: [{
      id: 'T00', checks: [[process.execPath, '--test']],
    }] }));
    const result = spawnSync(process.execPath, ['scripts/task.mjs', 'T00'], { cwd: temp, env, encoding: 'utf8' });
    assert.equal(result.status, 1, `${result.stdout}\\n${result.stderr}`);
    assert.match(result.stderr, /collected zero tests/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Rust test targets collecting zero tests fail and missing targets propagate', async () => {
  assert.equal(await runArgv(['cargo', 'test', '-p', 'annotation-domain', '--lib', '--locked'], root), 1);
  assert.notEqual(await runArgv(['cargo', 'test', '-p', 'annotation-domain', '--test', 'missing_t00_target', '--locked'], root), 0);
});

test('development process group kills siblings after an early exit', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'weblabel dev-'));
  const marker = path.join(temp, 'orphan-marker');
  try {
    const delayedWrite = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'orphan'),350)`;
    const status = await runProcessGroup([
      [process.execPath, '-e', 'process.exit(23)'],
      [process.execPath, '-e', delayedWrite],
    ], temp);
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.equal(status, 23);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});


test('plan verification reports structure only', () => {
  const result = spawnSync(process.execPath, ['scripts/verify-plan.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /plan_structure_only_not_product_verification/);
});
