CREATE TABLE dataset_versions (
 dataset_version_id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(project_id),
 ontology_version_id TEXT NOT NULL,
 manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
 manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64),
 created_by TEXT NOT NULL REFERENCES users(user_id),
 created_at TEXT NOT NULL,
 FOREIGN KEY(project_id,ontology_version_id) REFERENCES ontology_versions(project_id,ontology_version_id),
 UNIQUE(project_id,dataset_version_id)
);
CREATE TABLE dataset_exports (
 export_id TEXT PRIMARY KEY NOT NULL REFERENCES jobs(job_id),
 project_id TEXT NOT NULL,
 dataset_version_id TEXT NOT NULL,
 manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64),
 actor_id TEXT NOT NULL REFERENCES users(user_id),
 format TEXT NOT NULL CHECK(format IN ('native','yolo','coco')),
 object_sha256 TEXT NOT NULL CHECK(length(object_sha256)=64),
 byte_size INTEGER NOT NULL CHECK(byte_size>=0),
 loss_report_json TEXT NOT NULL CHECK(json_valid(loss_report_json)),
 created_at TEXT NOT NULL,
 FOREIGN KEY(project_id,dataset_version_id) REFERENCES dataset_versions(project_id,dataset_version_id)
);
CREATE INDEX dataset_exports_project_page ON dataset_exports(project_id,created_at,export_id);
CREATE TRIGGER dataset_versions_no_update BEFORE UPDATE ON dataset_versions
BEGIN SELECT RAISE(ABORT,'dataset versions are immutable'); END;
CREATE TRIGGER dataset_versions_no_delete BEFORE DELETE ON dataset_versions
BEGIN SELECT RAISE(ABORT,'dataset versions are immutable'); END;
CREATE TRIGGER dataset_exports_no_update BEFORE UPDATE ON dataset_exports
BEGIN SELECT RAISE(ABORT,'dataset exports are immutable'); END;
CREATE TRIGGER dataset_exports_no_delete BEFORE DELETE ON dataset_exports
BEGIN SELECT RAISE(ABORT,'dataset exports are immutable'); END;
