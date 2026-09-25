PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY NOT NULL,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    allow_self_review INTEGER NOT NULL DEFAULT 0 CHECK (allow_self_review IN (0, 1)),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'annotator', 'reviewer', 'viewer')),
    PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS ontology_versions (
    ontology_version_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    version_no INTEGER NOT NULL CHECK (version_no > 0),
    body_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (project_id, version_no),
    UNIQUE (project_id, ontology_version_id)
);

CREATE TABLE IF NOT EXISTS media_assets (
    asset_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    created_at TEXT NOT NULL,
    UNIQUE (project_id, asset_id)
);

CREATE TABLE IF NOT EXISTS media_revisions (
    asset_revision_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    original_sha256 TEXT NOT NULL,
    canonical_sha256 TEXT NOT NULL,
    original_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id, asset_id) REFERENCES media_assets(project_id, asset_id),
    UNIQUE (project_id, asset_revision_id),
    UNIQUE (asset_revision_id, canonical_sha256)
);

CREATE TABLE IF NOT EXISTS media_object_refs (
    asset_revision_id TEXT NOT NULL REFERENCES media_revisions(asset_revision_id),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    PRIMARY KEY (asset_revision_id, sha256)
);

CREATE TABLE IF NOT EXISTS annotation_revisions (
    annotation_revision_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    asset_revision_id TEXT NOT NULL,
    ontology_version_id TEXT NOT NULL,
    parent_revision_id TEXT REFERENCES annotation_revisions(annotation_revision_id),
    revision_no INTEGER NOT NULL CHECK (revision_no > 0),
    body_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(user_id),
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id, asset_revision_id) REFERENCES media_revisions(project_id, asset_revision_id),
    FOREIGN KEY (project_id, ontology_version_id) REFERENCES ontology_versions(project_id, ontology_version_id),
    UNIQUE (asset_revision_id, ontology_version_id, revision_no),
    UNIQUE (project_id, annotation_revision_id)
);

CREATE TABLE IF NOT EXISTS annotation_heads (
    project_id TEXT NOT NULL,
    asset_revision_id TEXT NOT NULL,
    ontology_version_id TEXT NOT NULL,
    annotation_revision_id TEXT NOT NULL,
    FOREIGN KEY (project_id, asset_revision_id) REFERENCES media_revisions(project_id, asset_revision_id),
    FOREIGN KEY (project_id, ontology_version_id) REFERENCES ontology_versions(project_id, ontology_version_id),
    FOREIGN KEY (project_id, annotation_revision_id) REFERENCES annotation_revisions(project_id, annotation_revision_id),
    UNIQUE (asset_revision_id, ontology_version_id),
    PRIMARY KEY (project_id, asset_revision_id, ontology_version_id)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
    actor_id TEXT NOT NULL REFERENCES users(user_id),
    operation_id TEXT NOT NULL,
    operation_kind TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (actor_id, operation_id, operation_kind)
);

CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT REFERENCES projects(project_id),
    kind TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
    payload_json TEXT NOT NULL,
    result_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_items (
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    state TEXT NOT NULL,
    result_json TEXT,
    PRIMARY KEY (job_id, item_id)
);
