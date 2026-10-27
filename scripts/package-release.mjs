import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, options, requireNode, checkedPath, files, entries, sha, mainGuard } from './build.mjs';
import { validateRelease, executableName } from './release-manifest.mjs';

export function packageRelease(argv = process.argv.slice(2)) {
  const args = options(argv, ['--build-dir', '--output-dir', '--version']);
  requireNode();
  if (!args['--build-dir'] || !args['--output-dir'] || !args['--version']) throw new Error('required: --build-dir --output-dir --version <semver>');
  const semver = /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?$/;
  const version = semver.exec(args['--version']);
  if (!version) throw new Error('release_version_invalid: strict SemVer without build metadata required');
  const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const packageBase = typeof packageVersion === 'string' ? packageVersion.split(/[+-]/, 1)[0] : '';
  if (!semver.test(packageBase) || version[1] !== packageBase) throw new Error('release_version_base_mismatch: must match package.json major.minor.patch');
  if (!['win32', 'linux'].includes(process.platform)) throw new Error('package_platform_unsupported');
  const build = fs.realpathSync(path.resolve(args['--build-dir']));
  const output = path.resolve(args['--output-dir']);
  if (fs.existsSync(output)) throw new Error('output_directory_exists: choose a NEW output directory');
  const actualOutput = path.join(fs.realpathSync(path.dirname(output)), path.basename(output));
  if (actualOutput.startsWith(build + path.sep)) throw new Error('output_inside_build_refused');
  const { manifest } = validateRelease(build);
  if (!/^[0-9a-f]{40}$/.test(manifest.source_commit)) throw new Error('release_source_commit_invalid');
  const expected = new Set(['release.json', ...manifest.files.map(item => item.path)]);
  if (files(build).some(name => !expected.has(name))) throw new Error('release_unmanifested_file');
  // Atomic reservation: never merge into or remove a pre-existing destination.
  fs.mkdirSync(output);
  const bundle = path.join(output, 'bundle');
  fs.mkdirSync(bundle);
  const copy = (source, relative) => {
    const destination = path.join(bundle, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  };
  for (const name of expected) copy(checkedPath(build, name), `release/${name}`);
  fs.writeFileSync(path.join(bundle, 'launch.sh'), '#!/bin/sh\nset -eu\nbundle=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nhas_data=false\nfor arg do\n  if [ "$arg" = "--data-dir" ]; then has_data=true; fi\ndone\nif [ "$has_data" = true ]; then\n  exec "$bundle/release/weblabel" serve --build-dir "$bundle/release" "$@"\nelse\n  exec "$bundle/release/weblabel" serve --build-dir "$bundle/release" --data-dir "$PWD/data" "$@"\nfi\n', { flag: 'wx' });
  fs.writeFileSync(path.join(bundle, 'launch.cmd'), '@echo off\r\nsetlocal\r\nset "bundle=%~dp0"\r\nset "has_data="\r\n:scan\r\nif "%~1"=="" goto run\r\nif "%~1"=="--data-dir" set "has_data=1"\r\nshift\r\ngoto scan\r\n:run\r\nif defined has_data goto explicit\r\n"%bundle%release\\weblabel.exe" serve --build-dir "%bundle%release" --data-dir "%CD%\\data" %*\r\nexit /b %errorlevel%\r\n:explicit\r\n"%bundle%release\\weblabel.exe" serve --build-dir "%bundle%release" %*\r\nexit /b %errorlevel%\r\n', { flag: 'wx' });
  for (const name of ['launch.sh', `release/${executableName}`]) fs.chmodSync(path.join(bundle, name), 0o755);
  fs.writeFileSync(path.join(bundle, 'BUNDLE.md'), `# WebLabel ${args['--version']} engineering prerelease\n\nThis ${process.platform}/${process.arch} bundle runs the single native Rust executable in release/. It includes immutable web/WASM assets and migrations, with no Node, pnpm, Python or compiler runtime dependency. It does not certify real AI providers, accounts, G4 quality or hardware WebGPU. Editing needs a real compatible browser WebGPU device. Optional ONNX Runtime files include their licenses; no model weights are bundled by default.\n\nRun launch.cmd (Windows) or launch.sh (Linux), or invoke release/${executableName} serve --build-dir <bundle>/release --data-dir <writable-data> --port 48100 directly. Launch scripts default data to the caller's working-directory/data; direct native serve defaults to release/data. For an existing installation ALWAYS pass its original canonical WEBLABEL_DATA_DIR receipt path and retain the same loopback origin/port. Never substitute or reinitialize the old database, clear IndexedDB, remove an unknown lock or expose the terminal bootstrap code. Ctrl+C stops the owned service.\n\nOperations use release/${executableName}: backup --data-dir <source> --backup-dir <new-backup>; restore --backup-dir <backup> --data-dir <new-data>; doctor --build-dir <bundle>/release --mode runtime; upgrade-preflight --build-dir <new-release> --data-dir <stopped-source> --backup-dir <existing-valid-backup>. Restore preserves historical identities but scrubs authentication and requires fresh local bootstrap. Backups are sensitive, unencrypted and unsigned; browser drafts require separate rescue. The default doctor build mode checks developer pins; runtime mode requires none of those tools. Live models are never probed by these operations.\n\nVerify the archive's adjacent .sha256, bundle.json and unchanged release/release.json. The source-checkout release-smoke verifier is build/CI tooling, not a bundled product dependency. Keep the original backup and old release for rollback; preflight does not certify rollback or authorize old migrations against a newer database.\n`, { flag: 'wx' });
  validateRelease(path.join(bundle, 'release'));
  if (sha(path.join(build, 'release.json')) !== sha(path.join(bundle, 'release/release.json'))) throw new Error('release_manifest_changed');
  const metadata = { format: 'weblabel-portable-bundle', version: 2, release_version: args['--version'], maturity: 'engineering-prerelease', source_commit: manifest.source_commit, platform: process.platform, arch: process.arch, product_runtime: 'native-rust', release_manifest_sha256: sha(path.join(build, 'release.json')), capabilities: { real_ai: 'not-verified', g4: 'not-verified', webgpu: 'real-browser-device-required' }, files: entries(bundle) };
  fs.writeFileSync(path.join(bundle, 'bundle.json'), JSON.stringify(metadata, null, 2), { flag: 'wx' });
  const archiveName = `weblabel-${args['--version']}-${process.platform}-${process.arch}.tar.gz`;
  const archive = path.join(output, archiveName);
  const tar = spawnSync('tar', ['-czf', archive, '-C', output, 'bundle'], { shell: false, windowsHide: true, encoding: 'utf8' });
  if (tar.status !== 0) throw new Error(`archive_failed: exit=${tar.status ?? 'spawn-error'}`);
  const archiveHash = sha(archive);
  const checksum = `${archiveHash}  ${archiveName}\n`;
  fs.writeFileSync(archive + '.sha256', checksum, { flag: 'wx' });
  if (fs.readFileSync(archive + '.sha256', 'utf8') !== checksum || sha(archive) !== archiveHash) throw new Error('archive_checksum_verification_failed');
  const summary = { format: metadata.format, release_version: metadata.release_version, source_commit: metadata.source_commit, platform: metadata.platform, arch: metadata.arch, archive: archiveName, checks: ['release-v2-hashes', 'immutable-release-manifest', 'single-native-product-runtime', 'archive-sha256'] };
  console.log(JSON.stringify(summary));
  return { bundle, archive, metadata };
}
mainGuard(import.meta.url, () => packageRelease());
