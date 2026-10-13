CREATE TABLE suggestion_rejection_operations (
    operation_id TEXT PRIMARY KEY NOT NULL,
    suggestion_set_id TEXT NOT NULL REFERENCES suggestion_sets(suggestion_set_id),
    actor_id TEXT NOT NULL REFERENCES users(user_id),
    change_ids_json TEXT NOT NULL CHECK(json_valid(change_ids_json) AND json_type(change_ids_json) = 'array'),
    created_at TEXT NOT NULL
);
CREATE TABLE suggestion_change_rejections (
    suggestion_set_id TEXT NOT NULL REFERENCES suggestion_sets(suggestion_set_id),
    change_id TEXT NOT NULL,
    operation_id TEXT NOT NULL REFERENCES suggestion_rejection_operations(operation_id),
    PRIMARY KEY (suggestion_set_id, change_id)
);
CREATE INDEX suggestion_rejection_operations_scope ON suggestion_rejection_operations(suggestion_set_id, actor_id);
CREATE TRIGGER suggestion_rejection_operations_no_update BEFORE UPDATE ON suggestion_rejection_operations
BEGIN SELECT RAISE(ABORT, 'suggestion rejection operations are immutable'); END;
CREATE TRIGGER suggestion_rejection_operations_no_delete BEFORE DELETE ON suggestion_rejection_operations
BEGIN SELECT RAISE(ABORT, 'suggestion rejection operations are immutable'); END;
CREATE TRIGGER suggestion_change_rejections_no_update BEFORE UPDATE ON suggestion_change_rejections
BEGIN SELECT RAISE(ABORT, 'suggestion change rejections are immutable'); END;
CREATE TRIGGER suggestion_change_rejections_no_delete BEFORE DELETE ON suggestion_change_rejections
BEGIN SELECT RAISE(ABORT, 'suggestion change rejections are immutable'); END;
