CREATE TABLE admin_password_recoveries (
    request_id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(user_id),
    username TEXT NOT NULL,
    completed_at TEXT NOT NULL
);

CREATE TRIGGER admin_password_recoveries_no_update
BEFORE UPDATE ON admin_password_recoveries
BEGIN
    SELECT RAISE(ABORT, 'administrator recovery records are immutable');
END;

CREATE TRIGGER admin_password_recoveries_no_delete
BEFORE DELETE ON admin_password_recoveries
BEGIN
    SELECT RAISE(ABORT, 'administrator recovery records are immutable');
END;
