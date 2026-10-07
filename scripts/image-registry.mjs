import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { root, requireNode, command } from './build.mjs';
import { validateReleaseVersion } from './release-version.mjs';
requireNode();
assert.equal(process.argv.length, 3);
assert.match(process.env.GITHUB_REPOSITORY ?? '', /^[\w.-]+\/[\w.-]+$/);
assert.match(process.env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/);
const repository = process.env.GITHUB_REPOSITORY;
const image = 'ghcr.io/' + repository.toLowerCase();
const shaTag = image + ':sha-' + process.env.GITHUB_SHA;
function monitor(args) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/ci_monitor.cjs'), ...args], { cwd: root, shell: false, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('registry_github_query_failed: ' + (result.stderr || result.error?.message || result.status));
  return JSON.parse(result.stdout);
}
function inspect(reference) {
  const result = spawnSync('docker', ['buildx', 'imagetools', 'inspect', reference, '--format', '{{.Manifest.Digest}}'], { cwd: root, shell: false, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status === 0) {
    const digest = result.stdout.trim();
    assert.match(digest, /^sha256:[a-f0-9]{64}$/);
    return digest;
  }
  const escaped = reference.replace(/[.*+?^{}$()|[\]\\]/g, '\\$&');
  if (new RegExp('(?:^|\\n)(?:ERROR: )?' + escaped + ': not found(?:\\r?\\n|$)').test(result.stderr)) return null;
  throw new Error('registry_inspect_failed: ' + result.stderr.trim());
}
if (process.argv[2] === '--lookup') {
  assert.ok(process.env.GITHUB_OUTPUT);
  const owner = monitor(['api', 'repos/' + repository]).owner;
  assert.ok(owner.type === 'User' || owner.type === 'Organization');
  const [namespace, name] = repository.toLowerCase().split('/');
  const endpoint = (owner.type === 'Organization' ? 'orgs/' : 'users/') + namespace + '/packages/container/' + name;
  const status = monitor(['api-status', endpoint]).status;
  assert.ok(status === 200 || status === 404, 'package metadata lookup must be authorized');
  const digest = status === 404 ? null : inspect(shaTag);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, 'digest=' + (digest || '') + String.fromCharCode(10));
  console.log(JSON.stringify({ source_commit: process.env.GITHUB_SHA, reused_digest: digest, package_exists: status === 200 }));
} else if (process.argv[2] === '--promote') {
  const reference = process.env.IMAGE;
  assert.ok(reference?.startsWith(image + '@'));
  const digest = reference.slice(image.length + 1);
  assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  const version = process.env.VERSION || '';
  if (version) validateReleaseVersion(version);
  const tags = [shaTag, ...(version ? [image + ':' + version] : [])];
  // Every destination is checked before any promotion; never overwrite another digest.
  const existing = tags.map(tag => inspect(tag));
  for (let i = 0; i < tags.length; i++) assert.ok(!existing[i] || existing[i] === digest, 'immutable image tag already names a different digest: ' + tags[i]);
  for (let i = 0; i < tags.length; i++) {
    if (!existing[i]) command(['docker', 'buildx', 'imagetools', 'create', '--prefer-index=false', '--tag', tags[i], reference]);
    assert.equal(inspect(tags[i]), digest, 'promotion changed registry digest');
  }
  console.log(JSON.stringify({ source_commit: process.env.GITHUB_SHA, digest, immutable_tags: tags }));
} else throw new Error('expected_registry_lookup_or_promote');
