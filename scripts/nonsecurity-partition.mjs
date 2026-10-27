import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const inputs = [
  '.node-version', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'crates/geometry',
  'crates/annotation-domain', 'crates/editor-core', 'tests/fixtures/golden', 'package.json', 'pnpm-lock.yaml',
  'pnpm-workspace.yaml', 'vitest.config.ts', 'apps/web/package.json', 'apps/web/tsconfig.json',
  'apps/web/src', 'packages/contracts/generated',
];
// Reviewed: geometry t03, editor t04/t12/commercial projection, and the six named Web test files in verify.mjs.
// Other tests, their fixtures, live/model work and GPU performance remain unreviewed.
const reviewedFingerprint = '1afc78aac2d595615a1cbac0efba2d1c5b85e52210e28b6ab0e913b53f8f5c87';
const sha = value => createHash('sha256').update(value).digest('hex');

export function checkNonsecurityPartition() {
  try {
    const files = new Map();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    function visit(relative) {
      const absolute = path.join(root, relative), stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error('NONSECURITY_AUDIT_LINK_REFUSED');
      const actual = fs.realpathSync(absolute), confined = path.relative(root, actual);
      if (confined === '..' || confined.startsWith(`..${path.sep}`) || path.isAbsolute(confined)) throw new Error('NONSECURITY_AUDIT_OUTSIDE_PROJECT');
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(absolute).sort()) visit(path.join(relative, entry));
      } else if (stat.isFile()) {
        const text = decoder.decode(fs.readFileSync(absolute)).replaceAll('\r\n', '\n');
        files.set(relative.replaceAll('\\', '/'), sha(text));
      } else throw new Error('NONSECURITY_AUDIT_INPUT_UNSUPPORTED');
    }
    for (const input of inputs) visit(input);
    const fingerprint = sha(JSON.stringify(Object.fromEntries([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))));
    return fingerprint === reviewedFingerprint
      ? { status: 'passed', fingerprint, fingerprinted_files: files.size, blockers: [] }
      : { status: 'blocked', fingerprint, fingerprinted_files: files.size, blockers: ['NONSECURITY_AUDIT_STALE'] };
  } catch (error) {
    return { status: 'blocked', fingerprint: null, fingerprinted_files: 0, blockers: [error.code ?? error.message] };
  }
}
