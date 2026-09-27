CREATE TABLE review_tasks (
 task_id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(project_id),
 asset_revision_id TEXT NOT NULL,
 ontology_version_id TEXT NOT NULL,
 assignee_id TEXT NOT NULL REFERENCES users(user_id),
 created_by TEXT NOT NULL REFERENCES users(user_id),
 state TEXT NOT NULL CHECK(state IN ('open','submitted','closed')),
 created_at TEXT NOT NULL,
 FOREIGN KEY(project_id,asset_revision_id) REFERENCES media_revisions(project_id,asset_revision_id),
 FOREIGN KEY(project_id,ontology_version_id) REFERENCES ontology_versions(project_id,ontology_version_id),
 UNIQUE(project_id,task_id)
);
CREATE UNIQUE INDEX one_open_task_per_asset ON review_tasks(asset_revision_id) WHERE state='open';
CREATE INDEX review_tasks_project_page ON review_tasks(project_id,created_at,task_id);
CREATE INDEX review_tasks_asset_open ON review_tasks(asset_revision_id,state);
CREATE TABLE task_leases (
 task_id TEXT PRIMARY KEY NOT NULL REFERENCES review_tasks(task_id),
 holder_id TEXT REFERENCES users(user_id),
 fencing_token INTEGER NOT NULL CHECK(fencing_token > 0),
 expires_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE TABLE review_submissions (
 review_id TEXT PRIMARY KEY NOT NULL,
 task_id TEXT NOT NULL REFERENCES review_tasks(task_id),
 project_id TEXT NOT NULL REFERENCES projects(project_id),
 submitted_by TEXT NOT NULL REFERENCES users(user_id),
 revision_ids_json TEXT NOT NULL CHECK(json_valid(revision_ids_json)),
 state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected')),
 created_at TEXT NOT NULL,
 FOREIGN KEY(project_id, task_id) REFERENCES review_tasks(project_id,task_id)
);
CREATE UNIQUE INDEX one_pending_submission_per_task ON review_submissions(task_id) WHERE state='pending';
CREATE TRIGGER review_submissions_transition
BEFORE UPDATE ON review_submissions
WHEN OLD.state!='pending'
  OR NEW.state NOT IN ('approved','rejected')
  OR NEW.review_id!=OLD.review_id
  OR NEW.task_id!=OLD.task_id
  OR NEW.project_id!=OLD.project_id
  OR NEW.submitted_by!=OLD.submitted_by
  OR NEW.revision_ids_json!=OLD.revision_ids_json
  OR NEW.created_at!=OLD.created_at
BEGIN SELECT RAISE(ABORT,'review submission is immutable'); END;
CREATE TRIGGER review_submissions_no_delete BEFORE DELETE ON review_submissions BEGIN SELECT RAISE(ABORT,'review submissions are immutable'); END;
CREATE TABLE review_decisions (
 review_id TEXT PRIMARY KEY NOT NULL REFERENCES review_submissions(review_id),
 decided_by TEXT NOT NULL REFERENCES users(user_id),
 decision TEXT NOT NULL CHECK(decision IN ('approve','reject')),
 reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
 revision_ids_json TEXT NOT NULL CHECK(json_valid(revision_ids_json)),
 created_at TEXT NOT NULL
);
CREATE TABLE review_issues (
 issue_id TEXT PRIMARY KEY NOT NULL,
 review_id TEXT NOT NULL REFERENCES review_submissions(review_id),
 project_id TEXT NOT NULL REFERENCES projects(project_id),
 annotation_revision_id TEXT NOT NULL,
 ontology_version_id TEXT NOT NULL,
 object_id TEXT,
 code TEXT NOT NULL,
 message TEXT NOT NULL,
 region_json TEXT CHECK(region_json IS NULL OR json_valid(region_json)),
 created_by TEXT NOT NULL REFERENCES users(user_id),
 created_at TEXT NOT NULL,
 FOREIGN KEY(project_id,annotation_revision_id) REFERENCES annotation_revisions(project_id,annotation_revision_id),
 FOREIGN KEY(project_id,ontology_version_id) REFERENCES ontology_versions(project_id,ontology_version_id)
);
CREATE INDEX review_issues_revision ON review_issues(annotation_revision_id,created_at,issue_id);
CREATE TRIGGER review_decisions_no_update BEFORE UPDATE ON review_decisions BEGIN SELECT RAISE(ABORT,'review decisions are immutable'); END;
CREATE TRIGGER review_decisions_no_delete BEFORE DELETE ON review_decisions BEGIN SELECT RAISE(ABORT,'review decisions are immutable'); END;
CREATE TRIGGER review_issues_no_update BEFORE UPDATE ON review_issues BEGIN SELECT RAISE(ABORT,'review issues are immutable'); END;
CREATE TRIGGER review_issues_no_delete BEFORE DELETE ON review_issues BEGIN SELECT RAISE(ABORT,'review issues are immutable'); END;
