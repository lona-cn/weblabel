import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { options, requireNode } from './build.mjs';

const build = '/opt/weblabel/release';
const base = 'http://127.0.0.1:48100';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function checkData() {
  assert.equal(fs.existsSync('/data/runtime.lock'), false, 'runtime_lock_survived_stop');
  assert.ok(fs.statSync('/data/api.sqlite').isFile(), 'database_missing');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync('/data/api.sqlite', { readOnly: true });
  try {
    assert.deepEqual(db.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check), ['ok'], 'sqlite_integrity');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'sqlite_foreign_keys');
  } finally { db.close(); }
  return { runtime_lock_absent: true, sqlite_integrity: true, sqlite_foreign_keys: true };
}

function checkRunning(expectedCommit) {
  requireNode();
  assert.equal(process.getuid(), 1000, 'actual_nonroot_uid');
  assert.equal(fs.readFileSync('/proc/1/comm', 'utf8').trim(), 'tini', 'actual_init_pid1');
  const init = fs.readFileSync('/proc/1/cmdline', 'utf8').split('\0').filter(Boolean);
  assert.deepEqual(init, ['/usr/bin/tini', '--', 'node', '/opt/weblabel/scripts/start-local.mjs', '--build-dir', build, '--data-dir', '/data'], 'actual_init_command');
  const manifest = JSON.parse(fs.readFileSync(path.join(build, 'release.json'), 'utf8'));
  assert.equal(manifest.source_commit, expectedCommit, 'release_commit');
  for (const file of [path.join(build, 'api/weblabel-api'), '/opt/weblabel/scripts/start-local.mjs']) {
    const stat = fs.statSync(file);
    assert.equal(stat.uid, 0, 'program_root_owned');
    assert.equal(stat.mode & 0o222, 0, 'program_readonly');
  }
  fs.accessSync('/data', fs.constants.W_OK);
  assert.ok(fs.existsSync('/data/runtime.lock'), 'running_lock_missing');
  assert.equal(spawnSync('ps', ['-e', '-o', 'pid=,ppid='], { stdio: 'ignore' }).status, 0, 'owned_host_ps_required');
  assert.ok(fs.statSync('/bin/kill').mode & 0o111, 'owned_host_kill_required');
  return { source_commit: manifest.source_commit, node: process.versions.node, actual_uid: process.getuid(), init_pid1: true, program_readonly: true, data_writable: true, owned_host_tools: true };
}

// These checks are sent over Docker exec to the real runtime, not shipped in it.
// Only public commit IDs are serialized; authentication state stays on the runner.
function nodeProgram(check, ...args) {
  return `import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import {spawnSync} from 'node:child_process'; import {requireNode} from '/opt/weblabel/scripts/build.mjs'; const build='/opt/weblabel/release'; console.log(JSON.stringify(await (${check.toString()})(...${JSON.stringify(args)})));`;
}

function docker(args) {
  // Never relay Docker output: container logs include a ten-minute bootstrap secret.
  const result = spawnSync('docker', args, { encoding: 'utf8', shell: false, timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const error = new Error('docker_command_failed');
    error.code = result.error?.code ?? 'DOCKER_EXIT';
    error.docker_exit = result.status;
    error.docker_operation = args[0];
    throw error;
  }
  return result.stdout.trim();
}
const inspect = name => JSON.parse(docker(['inspect', name]))[0];
async function freePort(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
function assertRunning(container, imageId, volume) {
  assert.equal(container.Image, imageId, 'running_image_id');
  assert.equal(container.State.Running, true, 'container_exited');
  assert.equal(container.Config.User, 'node', 'configured_nonroot');
  assert.equal(container.HostConfig.NetworkMode, 'host', 'native_host_network');
  assert.equal(container.HostConfig.ReadonlyRootfs, true, 'readonly_rootfs');
  assert.equal(container.HostConfig.Privileged, false, 'not_privileged');
  assert.ok(!container.HostConfig.PortBindings || Object.keys(container.HostConfig.PortBindings).length === 0, 'no_published_ports');
  assert.equal(container.Mounts.length, 1, 'exclusive_data_mount');
  assert.equal(container.Mounts[0].Name, volume, 'dedicated_volume');
  assert.equal(container.Mounts[0].Destination, '/data', 'data_mount');
  assert.equal(container.Mounts[0].RW, true, 'data_volume_writable');
}

export async function smokeContainer(argv = process.argv.slice(2)) {
  const args = options(argv, ['--image', '--expected-commit']);
  assert.ok(args['--image'] && !args['--image'].startsWith('-'), 'image_required');
  assert.match(args['--expected-commit'] ?? '', /^[0-9a-f]{40}$/, 'expected_commit_required');
  requireNode();
  assert.equal(process.platform, 'linux', 'native_linux_runner_required');
  assert.equal(process.arch, 'x64', 'amd64_runner_required');
  const endpoint = process.env.DOCKER_HOST || JSON.parse(docker(['context', 'inspect']))[0].Endpoints.docker.Host;
  assert.match(endpoint, /^unix:\/\//, 'local_native_docker_required');
  const info = JSON.parse(docker(['info', '--format', '{{json .}}']));
  assert.equal(info.OSType, 'linux', 'linux_engine_required');
  assert.match(info.Architecture, /^(x86_64|amd64)$/, 'amd64_engine_required');
  assert.doesNotMatch(info.OperatingSystem, /docker desktop/i, 'native_linux_engine_required');
  await freePort(48100); await freePort(48101);
  const image = args['--image'];
  if (image.includes('@')) assert.match(image, /@sha256:[0-9a-f]{64}$/, 'immutable_digest_required');
  const metadata = JSON.parse(docker(['image', 'inspect', image]))[0];
  assert.equal(metadata.Os, 'linux', 'image_linux');
  assert.equal(metadata.Architecture, 'amd64', 'image_amd64');
  assert.equal(metadata.Config.User, 'node', 'image_nonroot');
  assert.equal(metadata.Config.StopSignal, 'SIGTERM', 'image_stop_signal');
  assert.ok(metadata.Config.Healthcheck?.Test?.length, 'image_healthcheck_required');
  assert.match(metadata.Id, /^sha256:[0-9a-f]{64}$/);
  if (image.includes('@')) assert.ok(metadata.RepoDigests.includes(image), 'requested_registry_digest');
  const digest = image.includes('@') ? image.slice(image.indexOf('@') + 1) : (metadata.RepoDigests?.[0]?.split('@')[1] ?? metadata.Id);
  const digestKind = image.includes('@') || metadata.RepoDigests?.length ? 'registry_manifest' : 'local_image_config';
  const token = randomUUID();
  const volume = `weblabel-smoke-${token}`;
  const names = [`weblabel-smoke-${token}-first`, `weblabel-smoke-${token}-second`];
  const labelKey = 'io.weblabel.container-smoke';
  const owned = [];
  let volumeCreated = false;
  let phase = 'create_volume';
  let state;
  let result;
  let failure;
  const checks = [];
  const stopExitCodes = [];
  const ownership = name => assert.equal(inspect(name).Config.Labels[labelKey], token, 'cleanup_ownership');
  async function start(name, bootstrap) {
    phase = bootstrap ? 'first_start' : 'restart';
    // No --init dependency: the image's actual tini entrypoint must be exercised.
    owned.push(name);
    docker(['run', '--detach', '--name', name, '--label', `${labelKey}=${token}`, '--network', 'host', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--mount', `type=volume,source=${volume},target=/data`, image]);
    const deadline = Date.now() + 90000;
    let launchCode;
    for (;;) {
      const container = inspect(name);
      assertRunning(container, metadata.Id, volume);
      if (bootstrap && !launchCode) {
        const logs = docker(['logs', name]);
        launchCode = /WEBLABEL_BOOTSTRAP_CODE=([0-9a-f]+)/.exec(logs)?.[1];
      }
      if (container.State.Health?.Status === 'healthy' && (!bootstrap || launchCode)) break;
      assert.ok(Date.now() < deadline, 'container_readiness_timeout');
      await delay(500);
    }
    assert.equal(inspect(name).State.Health.Status, 'healthy', 'inspected_healthy');
    const running = JSON.parse(docker(['exec', name, 'node', '--input-type=module', '-e', nodeProgram(checkRunning, args['--expected-commit'])]));
    assert.equal(running.source_commit, args['--expected-commit']);
    checks.push(`${bootstrap ? 'first' : 'restart'}_inspected_nonroot_init_readonly_healthy_exact_image`);
    return launchCode;
  }
  function stop(name) {
    phase = 'graceful_stop';
    ownership(name);
    docker(['stop', '--time', '30', name]);
    const stopped = inspect(name);
    assert.equal(stopped.State.Running, false, 'stop_still_running');
    assert.equal(stopped.State.OOMKilled, false, 'stop_oom');
    assert.equal(stopped.State.Error, '', 'stop_engine_error');
    assert.equal(stopped.State.ExitCode, 130, 'real_launcher_signal_exit');
    stopExitCodes.push(stopped.State.ExitCode);
    phase = 'stopped_database';
    const checker = `${name}-data`;
    owned.push(checker);
    const data = JSON.parse(docker(['run', '--name', checker, '--label', `${labelKey}=${token}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--mount', `type=volume,source=${volume},target=/data,readonly`, '--entrypoint', 'node', image, '--input-type=module', '-e', nodeProgram(checkData)]));
    assert.deepEqual(data, { runtime_lock_absent: true, sqlite_integrity: true, sqlite_foreign_keys: true });
    checks.push('docker_stop_exit_130', 'runtime_lock_removed', 'sqlite_integrity_and_foreign_keys');
  }
  try {
    docker(['volume', 'create', '--label', `${labelKey}=${token}`, volume]);
    volumeCreated = true;
    const launchCode = await start(names[0], true);
    phase = 'authenticated_runtime_exercise';
    const { exerciseRuntime, verifyPersisted } = await import('./release-smoke.mjs');
    state = await exerciseRuntime(base, launchCode);
    stop(names[0]);
    await start(names[1], false);
    phase = 'persisted_revision_readback';
    const persisted = await verifyPersisted(base, state);
    checks.push(...persisted.checks);
    checks.push('same_volume_restart_authenticated_revision_document_media_readback');
    stop(names[1]);
    result = {
      status: 'passed', source_commit: args['--expected-commit'],
      image_digest: digest, image_digest_kind: digestKind, image_id: metadata.Id,
      stop_exit_codes: stopExitCodes,
      public_ids: { project_id: state.projectId, ontology_id: state.ontologyId, asset_id: state.assetId, revision_id: state.revisionId, revision_no: state.revisionNo },
      checks: [...new Set([...checks, ...state.checks])],
      limits: ['No browser GPU, official CLI, live model or active provider lifecycle acceptance is claimed.'],
    };
  } catch (error) {
    failure = error;
    failure.phase = phase;
  } finally {
    const cleanupFailures = [];
    for (const name of owned.reverse()) {
      try {
        // A failed docker run can still create a container; inspect by exact name.
        const all = docker(['container', 'ls', '--all', '--filter', `label=${labelKey}=${token}`, '--format', '{{.Names}}']).split('\n');
        if (!all.includes(name)) continue;
        ownership(name);
        docker(['rm', '--force', name]);
      } catch { cleanupFailures.push('owned_container_cleanup_failed'); }
    }
    if (volumeCreated) {
      try {
        const v = JSON.parse(docker(['volume', 'inspect', volume]))[0];
        assert.equal(v.Labels[labelKey], token, 'volume_cleanup_ownership');
        docker(['volume', 'rm', volume]);
      } catch { cleanupFailures.push('owned_volume_cleanup_failed'); }
    }
    if (cleanupFailures.length) {
      const error = failure ?? new Error('cleanup_failed');
      error.cleanup_failures = cleanupFailures;
      error.phase ??= 'cleanup';
      failure = error;
    }
  }
  if (failure) throw failure;
  result.checks.push('exclusive_container_and_volume_cleanup');
  return result;
}

async function main(argv) {
  console.log(JSON.stringify(await smokeContainer(argv)));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    // Never print error.message, assertion values, state, cookies or raw logs.
    console.error(JSON.stringify({ status: 'failed', phase: error.phase ?? 'prerequisites', code: /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'CONTAINER_CHECK_FAILED', docker_operation: error.docker_operation ?? null, docker_exit: error.docker_exit ?? null, cleanup_failures: error.cleanup_failures ?? [] }));
    process.exitCode = 1;
  });
}
