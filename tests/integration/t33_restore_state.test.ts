import { expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { root, sha } from '../../scripts/build.mjs';
import { schemaHash, migrations } from '../../scripts/backup.mjs';

it('refuses a manifest-covered main database shadowed by unmanifested WAL credentials, and restores its checkpointed state exactly', () => {
  const scratch = fs.mkdtempSync(path.join(root, 'target', 't33-restore-state-'));
  const backup = path.join(scratch, 'backup');
  fs.mkdirSync(backup);
  const dbFile = path.join(backup, 'api.sqlite');
  const db = new DatabaseSync(dbFile);
  let open = true;
  const migrationDirectory = path.join(root, 'crates/weblabel-api/migrations');
  const sqlFiles = fs.readdirSync(migrationDirectory).filter(name => /^\d+_.+\.sql$/.test(name)).sort();
  const manifest = () => fs.writeFileSync(path.join(backup, 'backup.json'), JSON.stringify({
    format: 'weblabel-backup', version: 1,
    authentication: 'scrubbed-fresh-local-bootstrap-required',
    schema_hash: schemaHash(db), migrations: migrations(db),
    files: [{ path: 'api.sqlite', sha256: sha(dbFile), size: fs.statSync(dbFile).size }],
  }));
  const restore = (destination: string) => spawnSync(process.execPath, [path.join(root, 'scripts/restore.mjs'), '--backup-dir', backup, '--data-dir', destination], { cwd: root, encoding: 'utf8', shell: false, timeout: 10000 });
  try {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    for (const name of sqlFiles) {
      db.exec(fs.readFileSync(path.join(migrationDirectory, name), 'utf8'));
      if (name !== '0001_core.sql') db.prepare('INSERT INTO schema_migrations(version) VALUES(?)').run(name.slice(0, -4));
    }
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
    db.prepare('INSERT INTO users(user_id,username,password_hash,created_at,platform_admin) VALUES(?,?,?,?,1)').run('old-auditor', 'old-local-user', 'old-synthetic-credential', '2026-01-01T00:00:00Z');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const coveredHash = sha(dbFile);
    db.exec("UPDATE users SET password_hash=''");
    expect(sha(dbFile)).toBe(coveredHash);
    expect(fs.statSync(dbFile + '-wal').size).toBeGreaterThan(0);
    expect(db.prepare('SELECT password_hash FROM users').get()!.password_hash).toBe('');
    manifest();
    const rejectedTarget = path.join(scratch, 'must-not-restore-old-credentials');
    const rejected = restore(rejectedTarget);
    expect(rejected.status, rejected.stdout + rejected.stderr).toBe(1);
    expect(rejected.stderr).toContain('backup_sqlite_sidecar');
    expect(fs.existsSync(rejectedTarget)).toBe(false);
    expect(rejected.stdout + rejected.stderr).not.toContain('old-synthetic-credential');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    manifest();
    db.close(); open = false;
    expect(fs.existsSync(dbFile + '-wal')).toBe(false);
    expect(fs.existsSync(dbFile + '-shm')).toBe(false);
    const destination = path.join(scratch, 'checkpointed-restoration');
    const accepted = restore(destination);
    expect(accepted.status, accepted.stdout + accepted.stderr).toBe(0);
    expect(sha(path.join(destination, 'api.sqlite'))).toBe(sha(dbFile));
    const restored = new DatabaseSync(path.join(destination, 'api.sqlite'), { readOnly: true });
    try {
      expect(restored.prepare('SELECT user_id,password_hash FROM users').get()).toEqual({ user_id: 'old-auditor', password_hash: '' });
      expect(restored.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok');
    } finally { restored.close(); }
    expect(JSON.parse(fs.readFileSync(path.join(destination, 'restore.json'), 'utf8')).authentication).toBe('scrubbed-fresh-local-bootstrap-required');
  } finally {
    if (open) db.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}, 30000);
