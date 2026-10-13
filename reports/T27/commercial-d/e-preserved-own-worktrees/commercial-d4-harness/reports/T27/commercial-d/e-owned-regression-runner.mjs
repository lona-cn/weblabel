import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

// Preparation only: Main runs this AFTER D actualcommit and E execution approval.
const sourceRoot = fs.realpathSync('D:/workspace/src/weblabel');
const files = [
  't10_auth', 't11_save', 't15_exports', 't17_jobs', 't25_ai', 't26_review',
  't27_export', 't29_security', 't30_faults', 't33_packaging', 't33_restore_state',
].map(name => `tests/integration/${name}.test.ts`);
function parse(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!['--release', '--e-root', '--commit', '--test-api-binary', '--test-api-receipt'].includes(key) || !value || value.startsWith('--') || key in result) throw new Error('Expected --release PATH --e-root NEW_PATH --commit APPROVED_D_SHA --test-api-binary CURRENT_DEBUG_API --test-api-receipt BUILD_RECEIPT_JSON');
    result[key] = value;
  }
  if (Object.keys(result).length !== 5 || !/^[0-9a-f]{40}$/.test(result['--commit'])) throw new Error('Explicit release, fresh E root, full approved D commit and current debug API/build receipt are required');
  return result;
}
function normalized(value) { return process.platform === 'win32' ? value.toLowerCase() : value; }
function beneath(parent, child) {
  const relative = path.relative(normalized(parent), normalized(child));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function ownedExisting(value) {
  if (!path.isAbsolute(value)) throw new Error('Owned inputs must be absolute');
  const actual = fs.realpathSync(value);
  if (!beneath(sourceRoot, actual)) throw new Error('Physical path escapes source Root');
  return actual;
}
function freshChild(value, allowedParent) {
  if (!path.isAbsolute(value)) throw new Error('Fresh output must be absolute');
  // Refuse even dangling symlinks; parent must already exist and be physically owned.
  try { fs.lstatSync(value); throw new Error('Output already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const parent = ownedExisting(path.dirname(value));
  const actual = path.join(parent, path.basename(value));
  if (!beneath(allowedParent, actual)) throw new Error('Fresh output is outside its approved parent');
  return actual;
}
const args = parse(process.argv.slice(2));
const release = ownedExisting(args['--release']);
const testApi = ownedExisting(args['--test-api-binary']);
const testApiReceipt = ownedExisting(args['--test-api-receipt']);
const evidenceParent = ownedExisting(path.join(sourceRoot, 'reports/T27/commercial-d'));
const eRoot = freshChild(args['--e-root'], evidenceParent);
if (beneath(release, eRoot) || beneath(eRoot, release) || normalized(release) === normalized(eRoot)) throw new Error('Release and evidence must be disjoint');
const cacheParent = ownedExisting(path.join(sourceRoot, 'target/build-cache'));
const cacheRoot = freshChild(path.join(cacheParent, `e-owned-regressions-${randomUUID()}`), cacheParent);

// Only toolchain/OS variables survive. Do not inspect, copy or log account/model secrets.
const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|CARGO_HOME|RUSTUP_HOME|RUSTUP_TOOLCHAIN|RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|PYTHON|PNPM_HOME|LANG|LC_ALL|TZ)$/i;
const env = {};
for (const key of Object.keys(process.env)) if (allowed.test(key)) env[key] = process.env[key];
Object.assign(env, {
  WEBLABEL_API_BINARY: testApi,
  WEBLABEL_T33_RELEASE: release,
  WEBLABEL_T30_HOST_SCRIPT: path.join(release, 'host/runtime.mjs'),
  WEBLABEL_T29_ROUTER_TARGET_DIR: path.join(cacheRoot, 'router'),
  WEBLABEL_T30_TEST_ROOT: path.join(eRoot, 't30'),
  TEMP: path.join(eRoot, 'tmp'), TMP: path.join(eRoot, 'tmp'), TMPDIR: path.join(eRoot, 'tmp'),
  COREPACK_ENABLE_NETWORK: '0', NO_COLOR: '1', FORCE_COLOR: '0',
});
// Set selected inputs before even importing shared CLI helpers; test imports occur in children.
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, env);
process.chdir(sourceRoot);
const { validateRelease } = await import(pathToFileURL(path.join(sourceRoot, 'scripts/start-local.mjs')).href);
const { sha } = await import(pathToFileURL(path.join(sourceRoot, 'scripts/build.mjs')).href);
const { resolveArgv } = await import(pathToFileURL(path.join(sourceRoot, 'scripts/task.mjs')).href);
const { manifest, api } = validateRelease(release);
if (manifest.source_commit !== args['--commit']) throw new Error('Release source_commit does not equal approved D dependency');
if (normalized(testApi) === normalized(api)) throw new Error('Debug regression API must be distinct from packaged release API');
const receipt = JSON.parse(fs.readFileSync(testApiReceipt, 'utf8'));
if (receipt.source_commit !== args['--commit'] || receipt.profile !== 'debug' || receipt.exit_code !== 0 || typeof receipt.binary !== 'string' || normalized(ownedExisting(receipt.binary)) !== normalized(testApi) || receipt.sha256 !== sha(testApi) || !Array.isArray(receipt.argv) || !receipt.argv.includes('build') || !receipt.argv.includes('--bin') || !receipt.argv.includes('weblabel-api') || receipt.argv.includes('--release')) throw new Error('Current-source debug API compile receipt missing or inconsistent');
const host = ownedExisting(env.WEBLABEL_T30_HOST_SCRIPT);
const hostEntry = manifest.files.find(entry => entry.path === 'host/runtime.mjs');
if (!hostEntry || sha(host) !== hostEntry.sha256) throw new Error('Selected T30 Host does not match validated release');
for (const file of files) ownedExisting(path.join(sourceRoot, file));
// Resolve actual installed pnpm via the repository's existing Windows Corepack convention.
const prefix = resolveArgv(['pnpm']);
fs.mkdirSync(eRoot); // exclusive, never recursive; fail on a concurrent reservation
fs.mkdirSync(cacheRoot);
fs.mkdirSync(env.TEMP);
const json = (file, value) => fs.writeFileSync(path.join(eRoot, file), JSON.stringify(value, null, 2), { flag: 'wx' });
json('selection.json', {
  kind: 'E elected integration execution inputs', source_root: sourceRoot,
  approved_D_commit: args['--commit'], release, release_api: api, release_api_sha256: sha(api),
  test_api: testApi, test_api_sha256: sha(testApi), test_api_receipt: testApiReceipt, test_api_receipt_sha256: sha(testApiReceipt),
  api_surface_policy: 'Debug API for full engineering integration fixtures; packaged release API for T33 process launch. Selected release Host remains the real T30 supervised-host input.',
  host, host_sha256: sha(host), release_manifest_sha256: sha(path.join(release, 'release.json')),
  e_root: eRoot, router_cache: cacheRoot, files, pnpm_prefix: prefix,
  selected_environment: Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('WEBLABEL_') || ['TEMP', 'TMP', 'TMPDIR'].includes(key))),
  scope: 'Elected direct integration files only; not full E acceptance or real provider/G4 proof',
});

async function run(file, index) {
  const label = `${String(index + 1).padStart(2, '0')}-${path.basename(file, '.test.ts')}`;
  const argv = [...prefix.slice(1), 'exec', 'vitest', 'run', '--project', 'integration', file, '--reporter', 'verbose'];
  const stdoutFile = path.join(eRoot, `${label}.stdout.log`), stderrFile = path.join(eRoot, `${label}.stderr.log`);
  const out = fs.openSync(stdoutFile, 'wx');
  let err;
  try { err = fs.openSync(stderrFile, 'wx'); } catch (error) { fs.closeSync(out); throw error; }
  const start = new Date().toISOString();
  let outcome;
  try {
    outcome = await new Promise(resolve => {
      const child = spawn(prefix[0], argv, { cwd: sourceRoot, env, shell: false, windowsHide: true, stdio: ['ignore', out, err] });
      let spawnError;
      child.once('error', error => { spawnError = error.message; });
      child.once('close', (code, signal) => resolve({ exit_code: code, signal, ...(spawnError ? { spawn_error: spawnError } : {}) }));
    });
  } finally { fs.closeSync(out); fs.closeSync(err); }
  const result = { file, command: [prefix[0], ...argv], start, end: new Date().toISOString(), stdout: stdoutFile, stderr: stderrFile, ...outcome };
  json(`${label}.result.json`, result);
  return result;
}
const results = [];
// Sequential whole files preserve fixture timing and avoid concurrent T30 fixed host-config writes.
for (let index = 0; index < files.length; index += 1) results.push(await run(files[index], index));
json('integration-results.json', { source_commit: args['--commit'], results, all_children_exit_zero: results.every(result => result.exit_code === 0 && !result.spawn_error), proof_limit: 'Exit records retain failures; read verbose logs/test counts. Not E full-scope or model capability acceptance.' });
process.exitCode = results.every(result => result.exit_code === 0 && !result.spawn_error) ? 0 : 1;
