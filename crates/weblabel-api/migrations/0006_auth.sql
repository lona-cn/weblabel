ALTER TABLE users ADD COLUMN platform_admin INTEGER NOT NULL DEFAULT 0 CHECK (platform_admin IN (0, 1));
ALTER TABLE sessions ADD COLUMN csrf_hash TEXT NOT NULL DEFAULT '';
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TRIGGER ontology_versions_no_update
BEFORE UPDATE ON ontology_versions
BEGIN
    SELECT RAISE(ABORT, 'ontology versions are immutable');
END;

CREATE TRIGGER ontology_versions_no_delete
BEFORE DELETE ON ontology_versions
BEGIN
    SELECT RAISE(ABORT, 'ontology versions are immutable');
END;
