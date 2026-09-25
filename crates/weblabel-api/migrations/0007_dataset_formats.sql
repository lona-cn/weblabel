CREATE TABLE annotation_import_batches (
    import_batch_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    asset_revision_id TEXT NOT NULL,
    format TEXT NOT NULL CHECK (format IN ('native', 'yolo', 'coco')),
    ontology_version_id TEXT NOT NULL,
    source_image_id INTEGER,
    class_mapping_json TEXT NOT NULL CHECK (json_valid(class_mapping_json)),
    base_revision_id TEXT,
    base_revision_no INTEGER NOT NULL CHECK (base_revision_no >= 0),
    actor_id TEXT NOT NULL REFERENCES users(user_id),
    source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
    document_json TEXT NOT NULL CHECK (json_valid(document_json)),
    loss_report_json TEXT NOT NULL CHECK (json_valid(loss_report_json)),
    status TEXT NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'committed')),
    committed_revision_id TEXT,
    created_at TEXT NOT NULL,
    committed_at TEXT,
    FOREIGN KEY (project_id, asset_revision_id)
        REFERENCES media_revisions(project_id, asset_revision_id),
    FOREIGN KEY (project_id, ontology_version_id)
        REFERENCES ontology_versions(project_id, ontology_version_id),
    FOREIGN KEY (project_id, base_revision_id)
        REFERENCES annotation_revisions(project_id, annotation_revision_id),
    FOREIGN KEY (project_id, committed_revision_id)
        REFERENCES annotation_revisions(project_id, annotation_revision_id),
    CHECK ((status = 'preview' AND committed_revision_id IS NULL AND committed_at IS NULL)
        OR (status = 'committed' AND committed_revision_id IS NOT NULL AND committed_at IS NOT NULL)),
    CHECK ((base_revision_id IS NULL AND base_revision_no = 0)
        OR (base_revision_id IS NOT NULL AND base_revision_no > 0))
);
CREATE INDEX annotation_import_batches_asset ON annotation_import_batches(
    project_id, asset_revision_id, ontology_version_id, created_at
);
CREATE TRIGGER annotation_import_batches_transition
BEFORE UPDATE ON annotation_import_batches
WHEN OLD.status != 'preview'
  OR NEW.status != 'committed'
  OR NEW.import_batch_id != OLD.import_batch_id
  OR NEW.project_id != OLD.project_id
  OR NEW.format != OLD.format
  OR NEW.source_image_id IS NOT OLD.source_image_id
  OR NEW.class_mapping_json != OLD.class_mapping_json
  OR NEW.base_revision_id IS NOT OLD.base_revision_id
  OR NEW.base_revision_no != OLD.base_revision_no
  OR NEW.asset_revision_id != OLD.asset_revision_id
  OR NEW.ontology_version_id != OLD.ontology_version_id
  OR NEW.actor_id != OLD.actor_id
  OR NEW.source_sha256 != OLD.source_sha256
  OR NEW.document_json != OLD.document_json
  OR NEW.loss_report_json != OLD.loss_report_json
  OR NEW.created_at != OLD.created_at
  OR (NEW.base_revision_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM annotation_revisions r
      WHERE r.project_id=NEW.project_id
        AND r.annotation_revision_id=NEW.base_revision_id
        AND r.asset_revision_id=NEW.asset_revision_id
        AND r.ontology_version_id=NEW.ontology_version_id
  ))
  OR NOT EXISTS (
      SELECT 1 FROM annotation_revisions r
      WHERE r.project_id=NEW.project_id
        AND r.annotation_revision_id=NEW.committed_revision_id
        AND r.asset_revision_id=NEW.asset_revision_id
        AND r.ontology_version_id=NEW.ontology_version_id
  )
BEGIN
    SELECT RAISE(ABORT, 'annotation import batch is immutable');
END;
CREATE TRIGGER annotation_import_batches_no_delete
BEFORE DELETE ON annotation_import_batches
BEGIN
    SELECT RAISE(ABORT, 'annotation import batches are immutable');
END;


CREATE TABLE annotation_exports (
    export_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    annotation_revision_id TEXT NOT NULL,
    actor_id TEXT NOT NULL REFERENCES users(user_id),
    format TEXT NOT NULL CHECK (format IN ('native', 'yolo', 'coco')),
    object_sha256 TEXT NOT NULL CHECK (length(object_sha256) = 64),
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    loss_report_json TEXT NOT NULL CHECK (json_valid(loss_report_json)),
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id, annotation_revision_id)
        REFERENCES annotation_revisions(project_id, annotation_revision_id)
);
CREATE INDEX annotation_exports_project_page ON annotation_exports(
    project_id, created_at, export_id
);
CREATE TRIGGER annotation_exports_no_update
BEFORE UPDATE ON annotation_exports
BEGIN
    SELECT RAISE(ABORT, 'annotation exports are immutable');
END;
CREATE TRIGGER annotation_exports_no_delete
BEFORE DELETE ON annotation_exports
BEGIN
    SELECT RAISE(ABORT, 'annotation exports are immutable');
END;
