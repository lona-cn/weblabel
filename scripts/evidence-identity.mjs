import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const sha = value => createHash('sha256').update(value).digest('hex');
const files = ["package.json", "TASKS.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "vitest.config.ts", "playwright.config.ts", ".node-version", ".github/workflows/ci.yml", "tools/check-plan.mjs", "tools/check-plan.test.mjs", "apps/web/index.html", "reports/T31/playwright.config.ts", "reports/T31/vite.config.ts", "reports/T31/native-controls.ts"];
const trees = ['scripts', 'crates', 'apps/web/src', 'apps/agent-host/src', 'apps/agent-host/test', 'packages/contracts/src', 'packages/contracts/generated', 'tests', 'services/detector/src'];
const ignored = new Set(['node_modules', 'target', 'dist', '.git', 'data', 'weights', '__pycache__']);
const extensions = /\.(?:rs|sql|ts|tsx|mts|mjs|js|json|toml|yaml|yml|css|html|py|ps1|wgsl|lock)$/;

export function captureEvidenceIdentity({ env } = {}) {
  const childEnv = env ?? Object.fromEntries(["PATH", "Path", "PATHEXT", "SystemRoot", "SystemDrive", "WINDIR", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const inputs = new Set();
  function add(relative) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) return;
    const actual = fs.realpathSync(absolute);
    const confined = path.relative(root, actual);
    if (confined === '..' || confined.startsWith(`..${path.sep}`) || path.isAbsolute(confined)) throw new Error('IDENTITY_INPUT_OUTSIDE_PROJECT');
    const stat = fs.statSync(actual);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(actual, { withFileTypes: true })) {
        if (!ignored.has(entry.name) && !entry.name.startsWith('.env')) add(path.join(relative, entry.name));
      }
    } else if (extensions.test(relative) || files.includes(relative)) inputs.add(relative.replaceAll('\\', '/'));
  }
  for (const relative of files) add(relative);
  for (const relative of trees) add(relative);
  for (const entry of fs.readdirSync(path.join(root, 'apps/web'))) if (/^(?:vite\.config|tsconfig|package\.)/.test(entry)) add(`apps/web/${entry}`);
  for (const entry of fs.readdirSync(path.join(root, 'apps/agent-host'))) if (/^(?:tsconfig|package\.)/.test(entry)) add(`apps/agent-host/${entry}`);
  for (const relative of ['services/detector/pyproject.toml', 'services/detector/uv.lock', 'services/detector/models.lock.json']) add(relative);
  const controls = path.join(root, 'reports/T31/native-controls');
  if (fs.existsSync(controls)) add('reports/T31/native-controls');
  const source_hashes = Object.fromEntries([...inputs].sort().map(relative => [relative, sha(fs.readFileSync(path.join(root, relative)))]));
  return {
    source_commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true, env: childEnv }).trim(),
    source_snapshot_sha256: sha(JSON.stringify(source_hashes)),
    source_hashes,
    manifest_sha256: sha(fs.readFileSync(path.join(root, 'tests/live/manifest.json'))),
    runner_sha256: sha(fs.readFileSync(path.join(root, 'scripts/verify-live.mjs'))),
  };
}
