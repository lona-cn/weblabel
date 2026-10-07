import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { root, requireNode, sha as fileSha, options } from './build.mjs';
import { validateReleaseVersion } from './release-version.mjs';
requireNode();
const repository = process.env.GITHUB_REPOSITORY;
const commit = process.env.GITHUB_SHA;
const tag = process.env.RELEASE_TAG;
const version = tag?.startsWith('v') ? tag.slice(1) : '';
assert.match(repository ?? '', /^[\w.-]+\/[\w.-]+$/);
assert.match(commit ?? '', /^[a-f0-9]{40}$/);
const prerelease = validateReleaseVersion(version);
function run(argv) {
  const result = spawnSync(argv[0], argv.slice(1), { cwd: root, shell: false, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('release_command_failed: ' + argv[0] + ' exit=' + result.status + ' ' + (result.stderr || result.error?.message || ''));
  return result.stdout.trim();
}
function monitor(args) { return run([process.execPath, path.join(root, 'scripts/ci_monitor.cjs'), ...args]); }
function api(endpoint) { return JSON.parse(monitor(['api', endpoint])); }
async function main() {
  const refs = api('repos/' + repository + '/git/matching-refs/tags/' + tag);
  const existing = refs.find(item => item.ref === 'refs/tags/' + tag);
  if (existing) assert.equal(api('repos/' + repository + '/commits/' + tag).sha, commit, 'tag must not be moved');
  if (process.argv[2] === '--preflight') {
    assert.equal(process.argv.length, 3);
    assert.ok(process.env.GITHUB_REF === 'refs/tags/' + tag || (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && process.env.GITHUB_REF === 'refs/heads/main'), 'release only from tag or manual main');
    run(['git', 'merge-base', '--is-ancestor', commit, 'origin/main']);
    assert.equal(JSON.parse(monitor(['api-status', 'repos/' + repository + '/releases/tags/' + tag])).status, 404, 'existing release is immutable; use a new version');
    assert.ok(process.env.GITHUB_OUTPUT);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, ['version=' + version, 'tag=' + tag, ''].join(String.fromCharCode(10)));
    console.log(JSON.stringify({ tag, commit, prerelease, branch_ancestry: 'main', product_acceptance: prerelease ? 'not-certified' : 'T35-gated' }));
    return;
  }
  const args = options(process.argv.slice(2), ['--assets-dir']);
  assert.ok(args['--assets-dir']);
  const directory = fs.realpathSync(path.resolve(args['--assets-dir']));
  const assets = [];
  for (const platform of ['win32', 'linux']) {
    const name = 'weblabel-' + version + '-' + platform + '-x64.tar.gz';
    const archive = path.join(directory, name);
    assert.equal(fs.readFileSync(archive + '.sha256', 'utf8').trim(), fileSha(archive) + '  ' + name);
    const bundle = JSON.parse(run(['tar', '-xOf', archive, 'bundle/bundle.json']));
    assert.equal(bundle.source_commit, commit);
    assert.equal(bundle.release_version, version);
    assert.equal(bundle.platform, platform);
    assert.equal(bundle.arch, 'x64');
    assets.push(archive, archive + '.sha256');
  }
  const distribution = path.join(directory, 'ghcr-distribution.json');
  const image = JSON.parse(fs.readFileSync(distribution, 'utf8'));
  assert.equal(image.source_commit, commit);
  assert.equal(image.version, version);
  assert.match(image.image, /^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+@sha256:[a-f0-9]{64}$/);
  assets.push(distribution);
  assert.equal(JSON.parse(monitor(['api-status', 'repos/' + repository + '/releases/tags/' + tag])).status, 404, 'existing release is immutable; use a new version');
  const notes = path.join(root, 'target/release-notes.md');
  fs.writeFileSync(notes, ['# WebLabel ' + version, '', 'Source commit: ' + commit, '', 'Windows and Linux x64 portable archives include pinned Node 24.16.0, API, canonical Rust Core WASM, Web UI and Host. Both archives are tested after download/extraction; SHA256 sidecars cover the exact assets.', '', 'GHCR: ' + image.image, '', 'Linux image: native Linux Docker --network host, persistent /data volume; loopback remains enforced. Browser editing requires a real WebGPU device.', '', 'Engineering prerelease. Hosted software-GPU checks are not hardware/G4 acceptance. No real model, subscription account, weight download or T32/T35 acceptance is claimed.', ''].join(String.fromCharCode(10)));
  monitor(['release', 'create', tag, ...assets, '--target', commit, '--title', 'WebLabel ' + version, '--notes-file', notes, '--latest=' + (prerelease ? 'false' : 'true'), ...(prerelease ? ['--prerelease'] : [])]);
  const published = api('repos/' + repository + '/releases/tags/' + tag);
  assert.equal(published.prerelease, prerelease);
  assert.equal(published.draft, false);
  for (const file of assets) {
    const asset = published.assets.find(item => item.name === path.basename(file));
    assert.ok(asset && asset.size === fs.statSync(file).size, 'missing or truncated release asset');
    assert.equal(asset.digest, 'sha256:' + fileSha(file), 'GitHub stored asset digest differs');
  }
  console.log(JSON.stringify({ release: published.html_url, commit, prerelease, assets: published.assets.map(item => ({ name: item.name, size: item.size, digest: item.digest })), image: image.image }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
