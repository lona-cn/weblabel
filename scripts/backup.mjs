import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { root, options, requireNode, sha, entries, checkedPath, mainGuard } from './build.mjs';
requireNode();
const { DatabaseSync, backup } = await import('node:sqlite');

const quote = value => `"${value.replaceAll('"', '""')}"`;
export function schemaHash(db) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all().map(row => ({ ...row, sql: row.sql?.replaceAll('\r\n', '\n') ?? null }));
  return createHash('sha256').update(JSON.stringify(schema)).digest('hex');
}
export function migrations(db) {
  return db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
}
export function validateDatabase(db) {
  if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('database_invalid');
}
export function objectHashes(db) {
  const hashes = new Set();
  for (const [table, column] of [['media_object_refs', 'sha256'], ['annotation_exports', 'object_sha256'], ['dataset_exports', 'object_sha256']]) {
    for (const row of db.prepare(`SELECT ${quote(column)} AS hash FROM ${quote(table)}`).all()) {
      if (!/^[0-9a-f]{64}$/.test(row.hash)) throw new Error('object_hash_invalid');
      hashes.add(row.hash);
    }
  }
  return [...hashes].sort();
}
export const objectName = hash => `objects/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
function scrub(db) {
  const secrets = new Set();
  const privateKey = /(?:api[_-]?key|secret|password|authorization|credential|access[_-]?token|refresh[_-]?token|session[_-]?token)/i;
  function collect(value) {
    if (typeof value === 'string' && value.length) secrets.add(value);
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { if (privateKey.test(key)) collect(item); else if (item && typeof item === 'object') collect(item); }
  }
  for (const row of db.prepare('SELECT config_json,secret_ref FROM model_profiles').all()) {
    collect(JSON.parse(row.config_json));
    if (typeof row.secret_ref === 'string' && row.secret_ref.length) secrets.add(row.secret_ref);
  }
  function redact(value) {
    if (typeof value === 'string') { let out = value; for (const secret of secrets) out = out.replaceAll(secret, '[REDACTED]'); return out; }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
    return value;
  }
  const triggers = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all();
  db.exec('PRAGMA foreign_keys=OFF; PRAGMA secure_delete=ON; BEGIN IMMEDIATE');
  try {
    for (const trigger of triggers) db.exec(`DROP TRIGGER ${quote(trigger.name)}`);
    db.exec("DELETE FROM sessions; UPDATE users SET password_hash=''; UPDATE model_profiles SET config_json='{}',secret_ref=NULL,availability='needs_configuration',verification='not_run',verified_at=NULL; DELETE FROM model_run_authorizations; DELETE FROM consents; DELETE FROM ai_run_previews;");
    // Restoring never resumes a potentially billed AI run or an active lease.
    db.exec("UPDATE model_runs SET state='interrupted' WHERE state IN ('queued','running'); UPDATE jobs SET state='interrupted',worker_id=NULL,lease_until=NULL WHERE state IN ('queued','running'); UPDATE task_leases SET holder_id=NULL,expires_at=0;");
    for (const { name: table } of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations','model_profiles')").all()) {
      const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all().filter(column => column.type === 'TEXT' && (column.name.endsWith('_json') || ['message', 'reason', 'prompt'].includes(column.name)));
      for (const column of columns) {
        const rows = db.prepare(`SELECT rowid AS backup_rowid,${quote(column.name)} AS value FROM ${quote(table)} WHERE ${quote(column.name)} IS NOT NULL`).all();
        const update = db.prepare(`UPDATE ${quote(table)} SET ${quote(column.name)}=? WHERE rowid=?`);
        for (const row of rows) {
          if (column.name.endsWith('_json')) {
            const original = JSON.parse(row.value);
            const value = JSON.stringify(redact(original));
            if (value !== JSON.stringify(original)) {
              if (['annotation_revisions', 'ontology_versions', 'dataset_versions', 'annotation_import_batches'].includes(table)) throw new Error('credential_in_immutable_business_data: cannot scrub without invalidating business hashes');
              update.run(value, row.backup_rowid);
            }
          } else {
            const value = redact(row.value);
            if (value !== row.value) update.run(value, row.backup_rowid);
          }
        }
      }
    }
    for (const trigger of triggers) db.exec(trigger.sql);
    db.exec('COMMIT; PRAGMA foreign_keys=ON; VACUUM; PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export async function createBackup(argv = process.argv.slice(2)) {
  const args = options(argv, ['--data-dir', '--backup-dir']);
  requireNode();
  if (!args['--data-dir'] || !args['--backup-dir']) throw new Error('required: --data-dir --backup-dir');
  const data = path.resolve(args['--data-dir']), destination = path.resolve(args['--backup-dir']);
  if (destination === data || destination.startsWith(data + path.sep)) throw new Error('backup_destination_inside_data');
  if (fs.existsSync(destination)) throw new Error('backup_directory_exists');
  const sourceFile = checkedPath(data, 'api.sqlite');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.mkdirSync(destination, { mode: 0o700 });
  let db;
  try {
    const source = new DatabaseSync(sourceFile, { readOnly: true });
    try { await backup(source, path.join(destination, 'api.sqlite')); } finally { source.close(); }
    db = new DatabaseSync(path.join(destination, 'api.sqlite'));
  } catch (error) { fs.rmSync(destination, { recursive: true, force: true }); throw error; }
  try {
    validateDatabase(db);
    const originalSchema = schemaHash(db), applied = migrations(db);
    scrub(db); validateDatabase(db);
    if (schemaHash(db) !== originalSchema) throw new Error('schema_changed');
    for (const hash of objectHashes(db)) {
      const relative = objectName(hash);
      const sourceObject = checkedPath(data, relative);
      if (sha(sourceObject) !== hash) throw new Error(`object_hash_mismatch: ${hash}`);
      fs.mkdirSync(path.dirname(path.join(destination, relative)), { recursive: true });
      fs.copyFileSync(sourceObject, path.join(destination, relative));
    }
    db.close();
    const manifest = { format: 'weblabel-backup', version: 1, created_at: new Date().toISOString(), schema_hash: originalSchema, migrations: applied, authentication: 'scrubbed-fresh-local-bootstrap-required', files: entries(destination).filter(item => !item.path.endsWith('-wal') && !item.path.endsWith('-shm')) };
    fs.writeFileSync(path.join(destination, 'backup.json'), JSON.stringify(manifest, null, 2));
    console.log(`backup_created: ${destination}`);
    return manifest;
  } catch (error) { try { db.close(); } catch {} fs.rmSync(destination, { recursive: true, force: true }); throw error; }
}
mainGuard(import.meta.url, () => createBackup());
