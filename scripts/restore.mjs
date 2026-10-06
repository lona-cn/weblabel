import fs from 'node:fs';
import path from 'node:path';
import { root, options, requireNode, validateEntries, checkedPath, sha, mainGuard } from './build.mjs';
import { schemaHash, migrations, validateDatabase, objectHashes, objectName } from './backup.mjs';
requireNode();
const { DatabaseSync } = await import('node:sqlite');

export function validateBackup(source, migrationDirectory = path.join(root, 'crates/weblabel-api/migrations')) {
  const manifestFile = checkedPath(source, 'backup.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.format !== 'weblabel-backup' || manifest.version !== 1 || manifest.authentication !== 'scrubbed-fresh-local-bootstrap-required') throw new Error('backup_incompatible');
  validateEntries(source, manifest.files);
  const expectedFiles = new Set(manifest.files.map(item => item.path));
  if (!expectedFiles.has('api.sqlite')) throw new Error('backup_database_missing');
  for (const file of expectedFiles) if (file !== 'api.sqlite' && !/^objects\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(file)) throw new Error('backup_unexpected_file');
  const db = new DatabaseSync(checkedPath(source, 'api.sqlite'), { readOnly: true });
  try {
    validateDatabase(db);
    if (schemaHash(db) !== manifest.schema_hash || JSON.stringify(migrations(db)) !== JSON.stringify(manifest.migrations)) throw new Error('backup_schema_mismatch');
    const sqlFiles = fs.readdirSync(migrationDirectory).filter(name => /^\d+_.+\.sql$/.test(name)).sort();
    const versionedFiles = sqlFiles.filter(name => name !== '0001_core.sql');
    if (versionedFiles.length !== manifest.migrations.length) throw new Error('schema_incompatible');
    for (let i = 0; i < versionedFiles.length; i++) {
      if (versionedFiles[i].slice(0, -4) !== manifest.migrations[i].version) throw new Error(`schema_incompatible: ${versionedFiles[i]}`);
    }
    const expected = new DatabaseSync(':memory:');
    try {
      expected.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
      for (const name of sqlFiles) expected.exec(fs.readFileSync(path.join(migrationDirectory, name), 'utf8'));
      if (schemaHash(expected) !== schemaHash(db)) throw new Error('schema_incompatible: actual schema differs from shipped migrations');
    } finally { expected.close(); }
    if (db.prepare("SELECT COUNT(*) AS count FROM users WHERE password_hash<>''").get().count || db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count || db.prepare("SELECT COUNT(*) AS count FROM model_profiles WHERE config_json<>'{}' OR secret_ref IS NOT NULL").get().count) throw new Error('backup_authentication_not_scrubbed');
    for (const hash of objectHashes(db)) if (!expectedFiles.has(objectName(hash)) || sha(checkedPath(source, objectName(hash))) !== hash) throw new Error('backup_object_missing_or_corrupt');
  } finally { db.close(); }
  return { manifest, manifest_sha256: sha(manifestFile) };
}
export function restoreBackup(argv = process.argv.slice(2)) {
  const args = options(argv, ['--backup-dir', '--data-dir', '--migrations-dir']);
  requireNode();
  if (!args['--backup-dir'] || !args['--data-dir']) throw new Error('required: --backup-dir --data-dir');
  const source = path.resolve(args['--backup-dir']), destination = path.resolve(args['--data-dir']);
  if (fs.existsSync(destination)) throw new Error('restore_directory_exists: restore only to a NEW directory');
  const { manifest, manifest_sha256 } = validateBackup(source, args['--migrations-dir'] ? path.resolve(args['--migrations-dir']) : undefined);
  // Reserve the target without recursive mkdir: a concurrent restore cannot overwrite it.
  fs.mkdirSync(destination);
  try {
    for (const item of manifest.files) {
      const original = checkedPath(source, item.path);
      const output = path.join(destination, item.path);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.copyFileSync(original, output, fs.constants.COPYFILE_EXCL);
      if (sha(output) !== item.sha256) throw new Error('restore_copy_hash_mismatch');
    }
    fs.mkdirSync(path.join(destination, 'objects'), { recursive: true });
    fs.writeFileSync(path.join(destination, 'restore.json'), JSON.stringify({ format: 'weblabel-restored-data', version: 1, backup_manifest_sha256: manifest_sha256, authentication: manifest.authentication }, null, 2), { flag: 'wx' });
  } catch (error) { throw new Error(`restore_failed_target_preserved: ${error.message}`); }
  console.log(`restore_created: ${destination}; choose fresh local credentials using the one-time bootstrap code`);
  return destination;
}
mainGuard(import.meta.url, () => restoreBackup());
