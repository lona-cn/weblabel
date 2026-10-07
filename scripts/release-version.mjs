import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { root } from './build.mjs';

export function validateReleaseVersion(version) {
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?$/;
  assert.match(version, semver);
  const packageBase = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version.split(/[+-]/, 1)[0];
  assert.equal(version.split('-', 1)[0], packageBase, 'release base must match package.json');
  const prerelease = version.includes('-');
  if (!prerelease) {
    const status = JSON.parse(fs.readFileSync(path.join(root, 'STATUS.json'), 'utf8'));
    assert.equal(status.tasks.T35.status, 'done', 'stable release requires actual T35 acceptance');
    assert.equal(status.release.state, 'ready');
    for (const gate of ['G0', 'G1', 'G2', 'G3', 'G4', 'G5']) assert.equal(status.release.gates[gate], 'pass');
  }
  return prerelease;
}
