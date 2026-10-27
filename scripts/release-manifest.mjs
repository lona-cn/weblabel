// Build/verification tooling only. Product validation and serving belong to Rust.
import fs from 'node:fs';
import path from 'node:path';
import { pins, sha } from './build.mjs';

export const executableName = process.platform === 'win32' ? 'weblabel.exe' : 'weblabel';
const invalid = code => { throw new Error(code); };
export function validRelative(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\\:%\0?#]/.test(value) && value.split('/').every(part =>
    part && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/[\x00-\x1f\x7f]/.test(part) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part));
}
function regularFile(root, relative) {
  if (!validRelative(relative)) invalid('MANIFEST_PATH_INVALID');
  let current = root;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) invalid('MANIFEST_PATH_ESCAPE');
  }
  const actual = fs.realpathSync.native(current), confined = path.relative(root, actual);
  if (!confined || confined === '..' || confined.startsWith('..' + path.sep) || path.isAbsolute(confined)) invalid('MANIFEST_PATH_ESCAPE');
  return current;
}
export function validateRelease(directory) {
  if (fs.lstatSync(directory).isSymbolicLink()) invalid('MANIFEST_PATH_ESCAPE');
  const root = fs.realpathSync.native(directory), manifestFile = regularFile(root, 'release.json');
  if (fs.statSync(manifestFile).size > 4 * 1024 * 1024) invalid('RELEASE_MANIFEST_TOO_LARGE');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.format !== 'weblabel-local-release') invalid('RELEASE_FORMAT_INVALID');
  if (manifest.version !== 2) invalid('RELEASE_VERSION_UNSUPPORTED');
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) invalid('RELEASE_PLATFORM_MISMATCH');
  if (!/^[0-9a-f]{40}$/.test(manifest.source_commit)) invalid('RELEASE_SOURCE_INVALID');
  if (!manifest.pins || Object.keys(manifest.pins).length !== Object.keys(pins).length || Object.entries(pins).some(([name, value]) => manifest.pins[name] !== value)) invalid('RELEASE_PINS_INVALID');
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 10000) invalid('RELEASE_FILE_COUNT_INVALID');
  const seen = new Map(); let total = 0;
  for (const entry of manifest.files) {
    if (!entry || !validRelative(entry.path) || ![executableName, 'web/', 'migrations/', 'runtime/'].some(prefix => prefix.endsWith('/') ? entry.path.startsWith(prefix) : entry.path === prefix) || !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[0-9a-f]{64}$/.test(entry.sha256)) invalid('MANIFEST_ENTRY_INVALID');
    total += entry.size;
    if (entry.size > 512 * 1024 * 1024 || total > 2 * 1024 * 1024 * 1024) invalid('RELEASE_SIZE_LIMIT');
    const key = entry.path.toLowerCase();
    if (seen.has(key)) invalid('MANIFEST_ENTRY_DUPLICATE');
    const file = regularFile(root, entry.path);
    if (fs.statSync(file).size !== entry.size || sha(file) !== entry.sha256) invalid('RELEASE_HASH_MISMATCH');
    if (entry.path.startsWith('web/')) {
      const web = entry.path.slice(4);
      if (/[{}]/.test(web) || ['api', 'internal', 'health', 'ready'].some(prefix => web === prefix || web.startsWith(prefix + '/'))) invalid('RELEASE_ROUTE_COLLISION');
    }
    seen.set(key, entry);
  }
  for (const required of [executableName, 'web/index.html', 'web/wasm/wasm_bridge.js', 'web/wasm/wasm_bridge_bg.wasm']) {
    if (seen.get(required)?.path !== required || !seen.get(required)?.size) invalid('RELEASE_REQUIRED_ASSET_MISSING');
  }
  if (!manifest.files.some(entry => /^migrations\/\d+_.+\.sql$/.test(entry.path) && entry.size > 0)) invalid('RELEASE_MIGRATIONS_MISSING');
  return { manifest, executable: regularFile(root, executableName) };
}
