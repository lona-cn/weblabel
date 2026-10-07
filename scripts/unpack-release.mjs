import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { options, sha, files, validateEntries, command, requireNode, mainGuard } from './build.mjs';
export async function unpackRelease(argv = process.argv.slice(2)) {
  requireNode();
  const args = options(argv, ['--artifact-dir', '--output-dir', '--expected-commit']);
  if (!args['--artifact-dir'] || !args['--output-dir'] || !/^[a-f0-9]{40}$/.test(args['--expected-commit'] ?? '')) throw new Error('required_artifact_output_commit');
  const artifacts = fs.realpathSync(path.resolve(args['--artifact-dir']));
  const names = fs.readdirSync(artifacts).filter(name => /^weblabel-[0-9A-Za-z.-]+-(?:linux|win32)-x64\.tar\.gz$/.test(name));
  if (names.length !== 1) throw new Error('exactly_one_native_archive_required');
  const name = names[0];
  const checksum = fs.readFileSync(path.join(artifacts, name + '.sha256'), 'utf8').trim();
  if (checksum !== sha(path.join(artifacts, name)) + '  ' + name) throw new Error('archive_sha256_mismatch');
  const output = path.resolve(args['--output-dir']);
  if (fs.existsSync(output)) throw new Error('output_directory_exists');
  const listing = command(['tar', '-tzf', path.join(artifacts, name)]).split(/\r?\n/).filter(Boolean);
  if (!listing.length || listing.some(item => !/^bundle(?:\/|$)/.test(item) || item.includes(String.fromCharCode(92)) || item.split('/').includes('..'))) throw new Error('archive_path_refused');
  fs.mkdirSync(output, { recursive: true });
  command(['tar', '-xzf', path.join(artifacts, name), '--strip-components=1', '-C', output]);
  files(output); // Refuse symlinks/nonregular payloads before any JavaScript execution.
  const bundle = JSON.parse(fs.readFileSync(path.join(output, 'bundle.json'), 'utf8'));
  if (bundle.format !== 'weblabel-portable-bundle' || bundle.version !== 1 || bundle.source_commit !== args['--expected-commit'] || bundle.platform !== process.platform || bundle.arch !== process.arch) throw new Error('bundle_identity_mismatch');
  validateEntries(output, bundle.files);
  const expected = new Set(['bundle.json', ...bundle.files.map(item => item.path)]);
  if (files(output).some(name => !expected.has(name))) throw new Error('unmanifested_bundle_file');
  const { validateRelease } = await import(pathToFileURL(path.join(output, 'scripts/start-local.mjs')).href);
  const { manifest } = validateRelease(path.join(output, 'release'));
  if (manifest.source_commit !== args['--expected-commit']) throw new Error('release_commit_mismatch');
  console.log(JSON.stringify({ archive: name, source_commit: manifest.source_commit, platform: manifest.platform, checks: ['archive-sha256', 'bundle-hashes', 'release-hashes', 'source-commit'] }));
  return output;
}
mainGuard(import.meta.url, () => unpackRelease());
