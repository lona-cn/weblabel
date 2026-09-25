CREATE TABLE model_profiles (
    profile_id TEXT PRIMARY KEY NOT NULL,
    provider_id TEXT NOT NULL CHECK (
        provider_id IN ('codex_local', 'claude_local', 'openai_api', 'anthropic_api', 'mimo_api', 'detector_local', 'mock')
    ),
    model_id TEXT NOT NULL,
    auth_kind TEXT NOT NULL CHECK (
        auth_kind IN ('official_user_login', 'api_key', 'local_weights', 'none')
    ),
    capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
    availability TEXT NOT NULL CHECK (
        availability IN ('ready', 'needs_login', 'needs_configuration', 'unsupported', 'blocked')
    ),
    verification TEXT NOT NULL CHECK (
        verification IN ('not_run', 'mock_only', 'live_passed', 'live_failed')
    ),
    runtime_version TEXT,
    verified_at TEXT,
    config_json TEXT NOT NULL CHECK (json_valid(config_json)),
    secret_ref TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE consents (
    consent_id TEXT PRIMARY KEY NOT NULL,
    actor_id TEXT NOT NULL REFERENCES users(user_id),
    profile_id TEXT NOT NULL,
    input_fingerprint TEXT NOT NULL,
    approved_grants_json TEXT NOT NULL CHECK (json_valid(approved_grants_json)),
    created_at TEXT NOT NULL,
    expires_at TEXT
);

CREATE TABLE model_runs (
    run_id TEXT PRIMARY KEY NOT NULL,
    operation_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    asset_revision_id TEXT NOT NULL,
    annotation_revision_id TEXT NOT NULL,
    ontology_version_id TEXT NOT NULL,
    actor_id TEXT NOT NULL REFERENCES users(user_id),
    job_id TEXT NOT NULL REFERENCES jobs(job_id),
    profile_id TEXT NOT NULL,
    profile_snapshot_json TEXT NOT NULL CHECK (json_valid(profile_snapshot_json)),
    provider_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('mock', 'provider', 'manual')),
    intent TEXT NOT NULL CHECK (intent IN ('detect', 'audit_attributes', 'find_issues')),
    prompt TEXT NOT NULL,
    consent_id TEXT,
    context_json TEXT NOT NULL CHECK (json_valid(context_json)),
    input_fingerprint TEXT NOT NULL,
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
    state TEXT NOT NULL CHECK (
        state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted')
    ),
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
    cost_display TEXT NOT NULL CHECK (cost_display IN ('none', 'unknown', 'recorded')),
    usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    FOREIGN KEY (project_id, asset_revision_id)
        REFERENCES media_revisions(project_id, asset_revision_id),
    FOREIGN KEY (project_id, annotation_revision_id)
        REFERENCES annotation_revisions(project_id, annotation_revision_id),
    UNIQUE (project_id, run_id)
);
CREATE INDEX model_runs_project_page ON model_runs(project_id, created_at, run_id);
CREATE INDEX model_runs_job ON model_runs(job_id);

CREATE TRIGGER model_runs_pinned_inputs_immutable
BEFORE UPDATE ON model_runs
WHEN NEW.run_id != OLD.run_id
  OR NEW.operation_id != OLD.operation_id
  OR NEW.project_id != OLD.project_id
  OR NEW.asset_revision_id != OLD.asset_revision_id
  OR NEW.annotation_revision_id != OLD.annotation_revision_id
  OR NEW.ontology_version_id != OLD.ontology_version_id
  OR NEW.actor_id != OLD.actor_id
  OR NEW.job_id != OLD.job_id
  OR NEW.profile_id != OLD.profile_id
  OR NEW.profile_snapshot_json != OLD.profile_snapshot_json
  OR NEW.provider_id != OLD.provider_id
  OR NEW.source != OLD.source
  OR NEW.intent != OLD.intent
  OR NEW.prompt != OLD.prompt
  OR NEW.consent_id IS NOT OLD.consent_id
  OR NEW.context_json != OLD.context_json
  OR NEW.input_fingerprint != OLD.input_fingerprint
  OR NEW.request_hash != OLD.request_hash
  OR NEW.created_at != OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'model run inputs are immutable');
END;

CREATE TRIGGER model_runs_state_transition
BEFORE UPDATE ON model_runs
WHEN NEW.state != OLD.state
  AND NOT (
    (OLD.state = 'queued' AND NEW.state IN ('running', 'cancelled', 'failed', 'interrupted'))
    OR (OLD.state = 'running' AND NEW.state IN ('succeeded', 'failed', 'cancelled', 'interrupted'))
  )
BEGIN
    SELECT RAISE(ABORT, 'illegal model run state transition');
END;

CREATE TRIGGER model_runs_no_delete
BEFORE DELETE ON model_runs
BEGIN
    SELECT RAISE(ABORT, 'model runs are immutable');
END;

CREATE TABLE predictions (
    prediction_id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES model_runs(run_id),
    project_id TEXT NOT NULL,
    asset_revision_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('mock', 'provider', 'manual')),
    raw_output_json TEXT NOT NULL CHECK (json_valid(raw_output_json)),
    raw_output_bytes INTEGER NOT NULL CHECK (raw_output_bytes >= 0),
    usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id, asset_revision_id)
        REFERENCES media_revisions(project_id, asset_revision_id),
    UNIQUE (project_id, prediction_id)
);
CREATE INDEX predictions_run ON predictions(run_id, created_at);

CREATE TRIGGER predictions_no_update
BEFORE UPDATE ON predictions
BEGIN
    SELECT RAISE(ABORT, 'predictions are immutable');
END;

CREATE TRIGGER predictions_no_delete
BEFORE DELETE ON predictions
BEGIN
    SELECT RAISE(ABORT, 'predictions are immutable');
END;

CREATE TABLE prediction_audit (
    audit_id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES model_runs(run_id),
    project_id TEXT NOT NULL,
    asset_revision_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('mock', 'provider', 'manual')),
    raw_output_json TEXT NOT NULL CHECK (json_valid(raw_output_json)),
    raw_output_bytes INTEGER NOT NULL CHECK (raw_output_bytes >= 0),
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX prediction_audit_run ON prediction_audit(run_id, created_at);

CREATE TRIGGER prediction_audit_no_update
BEFORE UPDATE ON prediction_audit
BEGIN
    SELECT RAISE(ABORT, 'quarantined predictions are immutable');
END;

CREATE TRIGGER prediction_audit_no_delete
BEFORE DELETE ON prediction_audit
BEGIN
    SELECT RAISE(ABORT, 'quarantined predictions are immutable');
END;

CREATE TABLE suggestion_sets (
    suggestion_set_id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES model_runs(run_id),
    prediction_id TEXT NOT NULL REFERENCES predictions(prediction_id),
    project_id TEXT NOT NULL,
    asset_revision_id TEXT NOT NULL,
    changes_json TEXT NOT NULL CHECK (json_valid(changes_json)),
    issues_json TEXT NOT NULL CHECK (json_valid(issues_json)),
    score REAL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id, asset_revision_id)
        REFERENCES media_revisions(project_id, asset_revision_id),
    UNIQUE (project_id, suggestion_set_id)
);
CREATE INDEX suggestion_sets_run ON suggestion_sets(run_id, created_at);

CREATE TRIGGER suggestion_sets_no_update
BEFORE UPDATE ON suggestion_sets
BEGIN
    SELECT RAISE(ABORT, 'suggestion content is immutable');
END;

CREATE TRIGGER suggestion_sets_no_delete
BEFORE DELETE ON suggestion_sets
BEGIN
    SELECT RAISE(ABORT, 'suggestion content is immutable');
END;

CREATE TABLE suggestion_set_states (
    suggestion_set_id TEXT PRIMARY KEY NOT NULL REFERENCES suggestion_sets(suggestion_set_id),
    state TEXT NOT NULL CHECK (
        state IN ('pending', 'stale', 'rejected', 'partially_accepted', 'accepted')
    ),
    updated_at TEXT NOT NULL
);

CREATE TABLE suggestion_decisions (
    decision_id TEXT PRIMARY KEY NOT NULL,
    suggestion_set_id TEXT NOT NULL REFERENCES suggestion_sets(suggestion_set_id),
    change_id TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('accept', 'revert')),
    bound_revision_id TEXT,
    actor_id TEXT NOT NULL REFERENCES users(user_id),
    created_at TEXT NOT NULL
);
CREATE INDEX suggestion_decisions_set ON suggestion_decisions(suggestion_set_id, created_at);

CREATE TABLE run_events (
    run_id TEXT NOT NULL REFERENCES model_runs(run_id),
    seq INTEGER NOT NULL CHECK (seq >= 0),
    event_type TEXT NOT NULL CHECK (
        event_type IN ('queued', 'started', 'progress', 'tool_call', 'candidate', 'succeeded', 'failed', 'cancelled')
    ),
    message TEXT NOT NULL,
    data_json TEXT CHECK (data_json IS NULL OR json_valid(data_json)),
    provider_event_id TEXT,
    provider_seq INTEGER,
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, seq)
);
CREATE UNIQUE INDEX run_events_provider_dedup
    ON run_events(run_id, provider_event_id)
    WHERE provider_event_id IS NOT NULL;

CREATE TRIGGER run_events_no_update
BEFORE UPDATE ON run_events
BEGIN
    SELECT RAISE(ABORT, 'run events are immutable');
END;
