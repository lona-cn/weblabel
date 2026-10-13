import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcessGroup } from '../../scripts/dev.mjs';
import { runTask } from '../../scripts/task.mjs';
import { taskReportPath } from '../support/report-paths.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const env = Object.fromEntries(['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'SystemDrive', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'CARGO_HOME', 'RUSTUP_HOME', 'RUSTUP_TOOLCHAIN', 'RUSTC', 'RUSTDOC'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
const temporary = () => fs.mkdtempSync(taskReportPath('T00', 'bootstrap-'));

test('an unknown task fails the actual task CLI', () => {
  const result = spawnSync(process.execPath, ['scripts/task.mjs', 'T99'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 1);
});

test('doctor reports missing tools without attempting an installation', () => {
  const directory = temporary();
  try {
    const absent = Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== 'path')); absent.PATH = directory;
    const result = spawnSync(process.execPath, ['scripts/doctor.mjs', '--build-dir', path.join(directory, 'missing-release'), '--cargo-cwd', directory], { cwd: root, env: absent, encoding: 'utf8' });
    assert.equal(result.status, 2);
    const diagnostic = JSON.parse(result.stdout);
    assert.equal(diagnostic.readonly, true);
    assert.equal(diagnostic.tools.find(tool => tool.name === 'rustc').status, 'missing');
    assert.equal(diagnostic.release.status, 'missing');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a manifest task without checks is refused before a child is launched', async () => {
  const directory = temporary();
  try {
    fs.writeFileSync(path.join(directory, 'TASKS.json'), JSON.stringify({ tasks: [{ id: 'T00', checks: [] }] }));
    await assert.rejects(runTask(directory, 'T00'));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('actual empty-directory Node collection makes the task CLI fail', () => {
  const directory = temporary();
  try {
    fs.mkdirSync(path.join(directory, 'scripts'));
    fs.copyFileSync(path.join(root, 'scripts/task.mjs'), path.join(directory, 'scripts/task.mjs'));
    fs.writeFileSync(path.join(directory, 'TASKS.json'), JSON.stringify({ tasks: [{ id: 'T00', checks: [[process.execPath, '--test', '--test-reporter=spec']] }] }));
    const result = spawnSync(process.execPath, ['scripts/task.mjs', 'T00'], { cwd: directory, env, encoding: 'utf8' });
    assert.equal(result.status, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('development process group reclaims siblings after an early exit', async () => {
  const directory = temporary(), marker = path.join(directory, 'orphan-marker');
  try {
    const delayedWrite = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'orphan'),350)`;
    const status = await runProcessGroup([[process.execPath, '-e', 'process.exit(23)'], [process.execPath, '-e', delayedWrite]], directory);
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(status, 23);
    assert.equal(fs.existsSync(marker), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('plan CLI identifies structural checking rather than product acceptance', () => {
  const result = spawnSync(process.execPath, ['scripts/verify-plan.mjs'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).scope, 'plan_structure_only_not_product_verification');
});
