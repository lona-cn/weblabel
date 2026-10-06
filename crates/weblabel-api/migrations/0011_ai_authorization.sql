ALTER TABLE projects ADD COLUMN allow_external_processing INTEGER NOT NULL DEFAULT 0
    CHECK (allow_external_processing IN (0, 1));

CREATE TABLE ai_run_previews (
    preview_id TEXT PRIMARY KEY NOT NULL,
    actor_id TEXT NOT NULL REFERENCES users(user_id),
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    profile_id TEXT NOT NULL REFERENCES model_profiles(profile_id),
    input_fingerprint TEXT NOT NULL CHECK (length(input_fingerprint) = 64),
    request_json TEXT NOT NULL CHECK (json_valid(request_json)),
    profile_configuration_hash TEXT NOT NULL CHECK (length(profile_configuration_hash) = 64),
    grants_json TEXT NOT NULL CHECK (json_valid(grants_json)),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE INDEX ai_run_previews_actor_expiry ON ai_run_previews(actor_id, expires_at);

CREATE TRIGGER ai_run_previews_immutable
BEFORE UPDATE ON ai_run_previews
BEGIN
    SELECT RAISE(ABORT, 'AI run preview inputs are immutable');
END;

ALTER TABLE consents ADD COLUMN preview_id TEXT REFERENCES ai_run_previews(preview_id);

CREATE TABLE model_run_authorizations (
    run_id TEXT PRIMARY KEY NOT NULL REFERENCES model_runs(run_id),
    preview_id TEXT NOT NULL REFERENCES ai_run_previews(preview_id),
    grants_json TEXT NOT NULL CHECK (json_valid(grants_json)),
    profile_configuration_hash TEXT NOT NULL CHECK (length(profile_configuration_hash) = 64)
);

CREATE TRIGGER model_run_authorizations_immutable
BEFORE UPDATE ON model_run_authorizations
BEGIN
    SELECT RAISE(ABORT, 'Model run authorization is immutable');
END;
