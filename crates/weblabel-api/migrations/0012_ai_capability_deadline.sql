-- Legacy authorizations without a deadline remain non-executable; runtime fails closed.
ALTER TABLE model_run_authorizations ADD COLUMN capability_expires_at TEXT
    CHECK (capability_expires_at IS NULL OR julianday(capability_expires_at) IS NOT NULL);
