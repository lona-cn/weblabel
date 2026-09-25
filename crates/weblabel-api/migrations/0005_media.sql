ALTER TABLE jobs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0);
ALTER TABLE jobs ADD COLUMN worker_id TEXT;
ALTER TABLE jobs ADD COLUMN lease_until TEXT;
ALTER TABLE jobs ADD COLUMN fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0);
ALTER TABLE jobs ADD COLUMN progress_completed INTEGER NOT NULL DEFAULT 0 CHECK (progress_completed >= 0);
ALTER TABLE jobs ADD COLUMN progress_total INTEGER NOT NULL DEFAULT 0 CHECK (progress_total >= 0 AND (progress_total = 0 OR progress_completed <= progress_total));
ALTER TABLE jobs ADD COLUMN progress_json TEXT CHECK (progress_json IS NULL OR json_valid(progress_json));
CREATE INDEX jobs_lease_scan ON jobs(state, lease_until, created_at, job_id);
CREATE INDEX jobs_project_status_page ON jobs(project_id, created_at, job_id);

CREATE TABLE job_idempotency (
    scope_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    job_id TEXT NOT NULL UNIQUE REFERENCES jobs(job_id) ON DELETE CASCADE,
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
    created_at TEXT NOT NULL,
    PRIMARY KEY (scope_id, operation_id, kind)
);

CREATE TABLE media_metadata (
    asset_revision_id TEXT PRIMARY KEY NOT NULL REFERENCES media_revisions(asset_revision_id) ON DELETE CASCADE,
    canonical_width INTEGER NOT NULL CHECK (canonical_width BETWEEN 1 AND 4096),
    canonical_height INTEGER NOT NULL CHECK (canonical_height BETWEEN 1 AND 4096),
    exif_orientation INTEGER NOT NULL CHECK (exif_orientation BETWEEN 1 AND 8),
    original_to_canonical_json TEXT NOT NULL CHECK (json_valid(original_to_canonical_json) AND json_array_length(original_to_canonical_json) = 9),
    source_group_id TEXT NOT NULL CHECK (length(source_group_id) BETWEEN 1 AND 128),
    original_object_sha256 TEXT NOT NULL CHECK (length(original_object_sha256) = 64),
    canonical_object_sha256 TEXT NOT NULL CHECK (length(canonical_object_sha256) = 64),
    preview_object_sha256 TEXT NOT NULL CHECK (length(preview_object_sha256) = 64),
    FOREIGN KEY (asset_revision_id, original_object_sha256) REFERENCES media_object_refs(asset_revision_id, sha256) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (asset_revision_id, canonical_object_sha256) REFERENCES media_object_refs(asset_revision_id, sha256) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (asset_revision_id, preview_object_sha256) REFERENCES media_object_refs(asset_revision_id, sha256) DEFERRABLE INITIALLY DEFERRED
);
