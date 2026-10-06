import {spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
const dir = 'reports/T28';
const files = ['crates/renderer-wgpu/src/culling.rs', 'crates/wasm-bridge/src/facade.rs', 'crates/editor-core/src/editor.rs'];
const privateRoot = 'C:/Users/admin/.omp/wt/t20921279e/m';
const [mode, label, ...args] = process.argv.slice(2);
if (mode === 'baseline') {
  const hashes = files.map(path => {
    const local = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
    const upstream = readFileSync(`${privateRoot}/${path}`, 'utf8').replaceAll('\r\n', '\n');
    if (local !== upstream) throw new Error(`Baseline differs: ${path}`);
    return {path, normalized_lf_sha256: createHash('sha256').update(local).digest('hex')};
  });
  writeFileSync(`${dir}/reviewfix-baseline.json`, JSON.stringify({checkout_base: '732a2b48feaa8dcc0af8de1a88b47b5835e60dc3', source_base: 'c97c58aed1be7b5097c49d368149ca2925db65b4', source_parent: '787c0116eb14d68084ad3ce4b1784ea7467384a7', files: hashes}, null, 2)+'\n');
  console.log(hashes);
} else if (mode === 'run') {
  const [bin, ...argv] = args;
  const env = bin === 'cargo' ? {...process.env, CARGO_HOME: 'D:/cache/cargo/bin', RUSTUP_HOME: 'D:/cache/cargo', CARGO_TARGET_DIR: `${process.cwd()}/target-reviewfix`} : process.env;
  const cargoArgs = argv.includes('--manifest-path') ? [] : ['--manifest-path', `${process.cwd()}/Cargo.toml`];
  const actualArgs = bin === 'cargo' ? [argv[0], ...cargoArgs, ...argv.slice(1)] : argv;
  const cwd = bin === 'cargo' ? 'D:/workspace/src/weblabel' : process.cwd();
  const result = spawnSync(bin === 'cargo' ? 'D:/cache/cargo/bin/bin/cargo.exe' : bin, actualArgs, {cwd, encoding: 'utf8', env, maxBuffer: 128*1024*1024});
  const output = (result.stdout ?? '') + (result.stderr ?? '') + (result.error ? String(result.error)+'\n' : '');
  const log = `${dir}/reviewfix-${label}.log`;
  writeFileSync(log, output);
  const recordsPath = `${dir}/reviewfix-commands.json`;
  const records = existsSync(recordsPath) ? JSON.parse(readFileSync(recordsPath, 'utf8')) : [];
  const results = [...output.matchAll(/test result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) ignored;/g)].map(m => ({status: m[1], passed: +m[2], failed: +m[3], ignored: +m[4]}));
  records.push({label, argv: [bin === 'cargo' ? 'D:/cache/cargo/bin/bin/cargo.exe' : bin, ...actualArgs], cwd, exit_code: result.status, tests: results, log_path: log, ...(bin === 'cargo' ? {env: {CARGO_HOME: env.CARGO_HOME, RUSTUP_HOME: env.RUSTUP_HOME, CARGO_TARGET_DIR: env.CARGO_TARGET_DIR}} : {})});
  writeFileSync(recordsPath, JSON.stringify(records, null, 2)+'\n');
  console.log(output);
  console.log(`RECORDED exit_code=${result.status} log=${log}`);
  process.exitCode = result.status ?? 1;
} else if (mode === 'patch') {
  let patch = '';
  for (const path of files) {
    const result = spawnSync('git', ['diff', '--no-index', '--ignore-space-at-eol', '--', `${privateRoot}/${path}`, path], {encoding: 'utf8'});
    if (result.status !== 1) throw new Error(`Expected changed file ${path}: ${result.stderr}`);
    const lines = result.stdout.split('\n');
    lines[0] = `diff --git a/${path} b/${path}`;
    const old = lines.findIndex(line => line.startsWith('--- '));
    const next = lines.findIndex(line => line.startsWith('+++ '));
    lines[old] = `--- a/${path}`;
    lines[next] = `+++ b/${path}`;
    patch += lines.join('\n');
    if (path === files[2]) writeFileSync(`${dir}/reviewfix-readonly-accessor.patch`, lines.join('\n'));
  }
  writeFileSync(`${dir}/reviewfix-source.patch`, patch);
  writeFileSync(`${dir}/reviewfix-twofile.patch`, patch.slice(0, patch.indexOf(`diff --git a/${files[2]}`)));
  console.log(`Wrote private C patches: two original repair files plus authorized readonly accessor (${Buffer.byteLength(patch)} bytes total)`);
} else if (mode === 'verify-artifacts') {
  const result = JSON.parse(readFileSync(`${dir}/reviewfix-results.json`, 'utf8'));
  const commands = JSON.parse(readFileSync(`${dir}/reviewfix-commands.json`, 'utf8'));
  JSON.parse(readFileSync(`${dir}/reviewfix-baseline.json`, 'utf8'));
  for (const record of commands) {
    if (record.log_path && !existsSync(record.log_path)) throw new Error(`Missing log: ${record.log_path}`);
  }
  const final = commands.find(record => record.label === 'final-native');
  const passed = final.tests.reduce((total, test) => total + test.passed, 0);
  if (passed !== 97 || final.exit_code !== 0 || final.tests.some(test => test.failed || test.ignored)) throw new Error('Native result mismatch');
  const patches = [
    ['reviewfix-source.patch', files],
    ['reviewfix-twofile.patch', files.slice(0, 2)],
    ['reviewfix-readonly-accessor.patch', files.slice(2)],
  ].map(([name, expected]) => {
    const patch = readFileSync(`${dir}/${name}`, 'utf8');
    const paths = [...patch.matchAll(/^diff --git a\/(.+) b\/.+$/gm)].map(match => match[1]);
    if (JSON.stringify(paths) !== JSON.stringify(expected)) throw new Error(`Unexpected paths: ${name}`);
    return {path: `${dir}/${name}`, files: paths, sha256: createHash('sha256').update(patch).digest('hex')};
  });
  const metadata = {source_commit: result.source_commit, final_native_passed: passed, command_records: commands.length, patches};
  writeFileSync(`${dir}/reviewfix-artifacts.json`, JSON.stringify(metadata, null, 2)+'\n');
  console.log(metadata);
} else throw new Error('Expected baseline, run, patch, or verify-artifacts');
