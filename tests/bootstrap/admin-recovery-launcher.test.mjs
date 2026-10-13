import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { entries, pins } from '../../scripts/build.mjs';
import * as launcher from '../../scripts/start-local.mjs';
import * as dev from '../../scripts/dev.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const report = path.join(root, 'target/ux-ops-launcher');
const id = 'b7e0be4d-3c42-45d8-9137-c7af4d01e5fc';
const requestKey = 'WEBLABEL_ADMIN_RECOVERY_REQUEST_ID';
const usernameKey = 'WEBLABEL_ADMIN_RECOVERY_USERNAME';
const valid = { [requestKey]: id, [usernameKey]: 'platform-admin' };
const safeEnv = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT'].filter(key => process.env[key]).map(key => [key, process.env[key]]));

for (const [name, env, error] of [
  ['missing username', { [requestKey]: id }, /WEBLABEL_ADMIN_RECOVERY_USERNAME.*required/],
  ['missing request id', { [usernameKey]: 'admin' }, /WEBLABEL_ADMIN_RECOVERY_REQUEST_ID.*required/],
  ['empty id', { ...valid, [requestKey]: '' }, /WEBLABEL_ADMIN_RECOVERY_REQUEST_ID.*empty/],
  ['empty username', { ...valid, [usernameKey]: '' }, /WEBLABEL_ADMIN_RECOVERY_USERNAME.*empty/],
  ['blank username', { ...valid, [usernameKey]: ' \t' }, /WEBLABEL_ADMIN_RECOVERY_USERNAME.*empty/],
  ['boolean is not UUID', { ...valid, [requestKey]: '1' }, /WEBLABEL_ADMIN_RECOVERY_REQUEST_ID.*UUID/],
  ['UUID whitespace', { ...valid, [requestKey]: ' ' + id }, /WEBLABEL_ADMIN_RECOVERY_REQUEST_ID.*UUID/],
  ['nil UUID', { ...valid, [requestKey]: '00000000-0000-0000-0000-000000000000' }, /WEBLABEL_ADMIN_RECOVERY_REQUEST_ID.*UUID/],
  ['username whitespace', { ...valid, [usernameKey]: ' admin ' }, /WEBLABEL_ADMIN_RECOVERY_USERNAME.*ASCII/],
  ['short username', { ...valid, [usernameKey]: 'ab' }, /WEBLABEL_ADMIN_RECOVERY_USERNAME.*ASCII/],
  ['long username', { ...valid, [usernameKey]: 'a'.repeat(65) }, /WEBLABEL_ADMIN_RECOVERY_USERNAME.*ASCII/],
  ['non ASCII username', { ...valid, [usernameKey]: '管理员' }, /WEBLABEL_ADMIN_RECOVERY_USERNAME.*ASCII/],
  ['restore conflict', { ...valid, WEBLABEL_RESTORE_AUTH: '1' }, /admin_recovery_restore_conflict/],
  ['invalid restore flag', { ...valid, WEBLABEL_RESTORE_AUTH: 'true' }, /WEBLABEL_RESTORE_AUTH.*0 or 1/],
]) {
  test(`both actual entrypoints fail closed: ${name}`, () => {
    for (const script of ['start-local.mjs', 'dev.mjs']) {
      const result = spawnSync(process.execPath, [path.join(root, 'scripts', script)], { cwd: root, env: { ...safeEnv, ...env }, encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 1);
      assert.match(result.stderr, error);
      assert.equal(result.stdout.includes('WEBLABEL_LOCAL_URL='), false);
    }
  });
}

test('unconfigured recovery stays disabled and valid configuration preserves exact username', () => {
  assert.equal(launcher.validateAdminRecoveryEnvironment({}), false);
  assert.equal(launcher.validateAdminRecoveryEnvironment({ ...valid, [usernameKey]: 'Abc._-123', WEBLABEL_RESTORE_AUTH: '0' }), true);
  assert.equal(launcher.validateAdminRecoveryEnvironment({ ...valid, [usernameKey]: 'a'.repeat(64) }), true);
});

test('recovery and restore bootstrap cannot be mixed', () => {
  assert.throws(() => launcher.localApiEnvironment(valid, { data: report, build: report, apiPort: 48101, restoreAuth: true }), /admin_recovery_restore_conflict.*restore/);
});

test('actual launcher holds exclusive lock, disables Host and shuts down cleanly with a harmless Node API', async () => {
  fs.mkdirSync(report, { recursive: true });
  const directory = fs.mkdtempSync(path.join(report, 'launcher-'));
  const build = path.join(directory, 'release'), data = path.join(directory, 'data');
  fs.mkdirSync(data); fs.mkdirSync(build);
  const capture = path.join(data, 'child.json'), stop = path.join(data, 'stop');
  const hook = path.join(directory, 'fake-api.mjs');
  fs.writeFileSync(hook, `import fs from 'node:fs';import http from 'node:http';if(!process.argv[1]){fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith('WEBLABEL_')))));const server=http.createServer((req,res)=>{res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({ready:false,mode:'password_recovery'}));});const [host,port]=process.env.WEBLABEL_BIND.split(':');server.listen(Number(port),host);setInterval(()=>{if(fs.existsSync(${JSON.stringify(stop)}))process.exit(0)},20);}`);
  const apiName = 'api/' + (process.platform === 'win32' ? 'weblabel-api.exe' : 'weblabel-api');
  for (const name of [apiName, 'host/runtime.mjs', 'host/mcp.mjs', 'web/index.html', 'web/wasm/wasm_bridge.js', 'web/wasm/wasm_bridge_bg.wasm']) {
    const file = path.join(build, name); fs.mkdirSync(path.dirname(file), { recursive: true });
    if (name === apiName) fs.copyFileSync(process.execPath, file); else fs.writeFileSync(file, 'harmless-fixture');
  }
  fs.writeFileSync(path.join(build, 'release.json'), JSON.stringify({ format: 'weblabel-local-release', version: 1, platform: process.platform, arch: process.arch, pins, files: entries(build) }));
  // Invalid restore marker proves recovery leaves restore/DB qualification to Rust.
  fs.writeFileSync(path.join(data, 'restore.json'), 'not-a-database-or-marker');
  const portServer = net.createServer();
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const argv = [path.join(root, 'scripts/start-local.mjs'), '--build-dir', build, '--data-dir', data, '--port', String(port), '--api-port', String(port === 65535 ? port - 1 : port + 1)];
  const env = { ...safeEnv, ...valid, WEBLABEL_HOST_CONFIG: 'not-read', WEBLABEL_HOST_EXECUTABLE: 'not-run', NODE_OPTIONS: '--import=' + pathToFileURL(hook).href };
  const child = spawn(process.execPath, argv, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  const closed = once(child, 'close');
  try {
    const deadline = Date.now() + 10000;
    while ((!fs.existsSync(capture) || !stdout.includes('WEBLABEL_API_STATE=maintenance')) && Date.now() < deadline && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(child.exitCode, null, stderr);
    const maintenance = await fetch('http://127.0.0.1:' + (port === 65535 ? port - 1 : port + 1) + '/ready');
    assert.equal(maintenance.status, 503);
    assert.deepEqual(await maintenance.json(), { ready: false, mode: 'password_recovery' });
    const actual = JSON.parse(fs.readFileSync(capture, 'utf8'));
    assert.equal(actual[requestKey], id); assert.equal(actual[usernameKey], 'platform-admin');
    for (const key of ['WEBLABEL_HOST_CONFIG', 'WEBLABEL_HOST_EXECUTABLE', 'WEBLABEL_HOST_SCRIPT', 'WEBLABEL_HOST_CWD', 'WEBLABEL_HOST_ALLOWED_ENV']) assert.equal(actual[key], undefined);
    const duplicate = spawnSync(process.execPath, argv, { cwd: root, env: { ...env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 10000 });
    assert.equal(duplicate.status, 1);
    assert.equal(fs.existsSync(path.join(data, 'runtime.lock')), true);
    const response = await fetch('http://127.0.0.1:' + port);
    assert.equal(response.status, 200); assert.equal(await response.text(), 'harmless-fixture');
    fs.writeFileSync(stop, 'stop');
    const [code] = await closed; assert.equal(code, 0, stderr);
    const receipt = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).find(item => item.format === 'weblabel-shutdown-receipt');
    assert.equal(receipt.lock, 'owned-runtime-lock-released');
    assert.equal(receipt.cost, 'unknown');
    assert.equal(receipt.owned_processes[0].status, 'stopped');
    assert.equal(fs.existsSync(path.join(data, 'runtime.lock')), false);
    assert.equal(fs.existsSync(path.join(data, 'api.sqlite')), false);
  } finally {
    if (child.exitCode === null) { fs.writeFileSync(stop, 'stop'); await closed; }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('real development children isolate recovery configuration from web tooling', async () => {
  fs.mkdirSync(report, { recursive: true });
  const directory = fs.mkdtempSync(path.join(report, 'children-'));
  try {
    const files = ['api.json', 'web.json'].map(name => path.join(directory, name));
    const source = `const fs=require('node:fs');const path=require('node:path');fs.writeFileSync(process.argv[1],JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith('WEBLABEL_')))));const files=${JSON.stringify(files)};const timer=setInterval(()=>{if(files.every(p=>fs.existsSync(p))){clearInterval(timer);setTimeout(()=>process.exit(23),100)}},10);`;
    const environments = dev.developmentEnvironments({ ...safeEnv, ...valid, WEBLABEL_ADMIN_RECOVERY_CODE: 'must-not-reach-web', WEBLABEL_COOKIE_SECURE: 'false' });
    const status = await dev.runProcessGroup(files.map(file => [process.execPath, '-e', source, file]), directory, environments);
    assert.equal(status, 23);
    const [api, web] = files.map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
    assert.equal(api[requestKey], id);
    assert.equal(api[usernameKey], 'platform-admin');
    assert.equal(web[requestKey], undefined);
    assert.equal(web[usernameKey], undefined);
    assert.equal(web.WEBLABEL_ADMIN_RECOVERY_CODE, undefined);
    assert.equal(web.WEBLABEL_COOKIE_SECURE, 'false');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
