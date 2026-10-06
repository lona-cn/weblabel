CREATE TABLE activity_sessions (
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    actor_id TEXT NOT NULL REFERENCES users(user_id),
    session_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version > 0),
    intervals_json TEXT NOT NULL,
    PRIMARY KEY(project_id, actor_id, session_id)
);
