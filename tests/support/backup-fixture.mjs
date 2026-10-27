// Independent Node/SQLite v1 manifest oracle for synthetic backup consumer tests.
// Product backup/restore and schema validation run only in the native executable.
import { createHash } from 'node:crypto';
export function schemaHash(database) {
  const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all().map(row => ({ ...row, sql: row.sql?.replaceAll('\r\n', '\n') ?? null }));
  return createHash('sha256').update(JSON.stringify(schema)).digest('hex');
}
export function migrations(database) {
  return database.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
}
