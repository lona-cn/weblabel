use super::AnnotationState;
use crate::{
    auth::{error, Principal},
    projects::project_role,
};
use annotation_domain::{
    AnnotationHeadPage, AnnotationHeadSummary, AssetAnnotationHead, AssetAnnotationHeadPage, Id,
    MediaRevision,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use sqlx::{sqlite::SqliteRow, Row};

#[derive(Deserialize)]
pub(super) struct HeadQuery {
    limit: Option<usize>,
    cursor: Option<String>,
    ontology_version_id: Option<String>,
}

impl HeadQuery {
    fn limit(&self) -> Option<usize> {
        self.limit
            .or(Some(100))
            .filter(|value| (1..=100).contains(value))
    }
}

fn failed() -> Response {
    error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "ANNOTATION_HEAD_READ_FAILED",
        "Could not read annotation heads",
    )
}

// Only immutable revision facts are summarized. Approval names this exact revision,
// asset and ontology; a later head never inherits a previous revision's approval.
const SUMMARY: &str = r#"r.annotation_revision_id,r.ontology_version_id,r.revision_no,r.content_hash,
 json_extract(r.body_json,'$.completion') AS completion,
 json_array_length(r.body_json,'$.objects') AS object_count,
 json_type(r.body_json,'$.objects') AS objects_type,
 (SELECT s.review_id FROM review_submissions s JOIN review_decisions d ON d.review_id=s.review_id
 JOIN review_tasks t ON t.task_id=s.task_id
 WHERE s.project_id=r.project_id AND t.asset_revision_id=r.asset_revision_id
 AND t.ontology_version_id=r.ontology_version_id AND s.state='approved' AND d.decision='approve'
 AND EXISTS(SELECT 1 FROM json_each(s.revision_ids_json) WHERE value=r.annotation_revision_id)
 AND EXISTS(SELECT 1 FROM json_each(d.revision_ids_json) WHERE value=r.annotation_revision_id)
 ORDER BY s.created_at DESC,s.review_id LIMIT 1) AS approved_review_id"#;

fn summary(row: &SqliteRow) -> Result<AnnotationHeadSummary, sqlx::Error> {
    use annotation_domain::Completion;
    if row.try_get::<&str, _>("objects_type")? != "array" {
        return Err(sqlx::Error::Protocol("Invalid annotation summary".into()));
    }
    let completion = match row.try_get::<&str, _>("completion")? {
        "unprocessed" => Completion::Unprocessed,
        "in_progress" => Completion::InProgress,
        "complete" => Completion::Complete,
        "confirmed_negative" => Completion::ConfirmedNegative,
        _ => return Err(sqlx::Error::Protocol("Invalid completion".into())),
    };
    let safe = |value: i64| -> Result<u64, sqlx::Error> {
        if !(0..=9_007_199_254_740_991).contains(&value) {
            return Err(sqlx::Error::Protocol("Unsafe summary integer".into()));
        }
        Ok(value as u64)
    };
    Ok(AnnotationHeadSummary {
        ontology_version_id: Id::from(row.try_get::<String, _>("ontology_version_id")?),
        annotation_revision_id: Id::from(row.try_get::<String, _>("annotation_revision_id")?),
        revision_no: safe(row.try_get("revision_no")?)?,
        content_hash: row.try_get("content_hash")?,
        completion,
        object_count: safe(row.try_get("object_count")?)?,
        approved_review_id: row
            .try_get::<Option<String>, _>("approved_review_id")?
            .map(Id::from),
    })
}

pub(super) async fn asset(
    State(state): State<AnnotationState>,
    Path(asset_id): Path<String>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<HeadQuery>,
) -> Response {
    let project: Result<Option<String>, _> = sqlx::query_scalar("SELECT r.project_id FROM media_revisions r JOIN memberships m ON m.project_id=r.project_id AND m.user_id=? WHERE r.asset_revision_id=?")
        .bind(&principal.user_id).bind(&asset_id).fetch_optional(&state.auth.pool).await;
    let project = match project {
        Ok(Some(project)) => project,
        Ok(None) => return error(StatusCode::NOT_FOUND, "ASSET_NOT_FOUND", "Asset not found"),
        Err(_) => return failed(),
    };
    let Some(limit) = query.limit() else {
        return error(
            StatusCode::BAD_REQUEST,
            "INVALID_LIMIT",
            "limit must be 1–100",
        );
    };
    let sql = format!("SELECT h.ontology_version_id AS head_ontology_id,{SUMMARY} FROM annotation_heads h LEFT JOIN annotation_revisions r ON r.project_id=h.project_id AND r.annotation_revision_id=h.annotation_revision_id AND r.asset_revision_id=h.asset_revision_id AND r.ontology_version_id=h.ontology_version_id WHERE h.project_id=? AND h.asset_revision_id=? AND (? IS NULL OR h.ontology_version_id>?) ORDER BY h.ontology_version_id LIMIT ?");
    let rows = match sqlx::query(&sql)
        .bind(&project)
        .bind(&asset_id)
        .bind(&query.cursor)
        .bind(&query.cursor)
        .bind((limit + 1) as i64)
        .fetch_all(&state.auth.pool)
        .await
    {
        Ok(rows) => rows,
        Err(_) => return failed(),
    };
    let next_cursor = if rows.len() > limit {
        rows[limit - 1]
            .try_get::<String, _>("head_ontology_id")
            .ok()
    } else {
        None
    };
    let items: Result<Vec<_>, _> = rows.iter().take(limit).map(summary).collect();
    match items {
        Ok(items) => Json(AnnotationHeadPage { items, next_cursor }).into_response(),
        Err(_) => failed(),
    }
}

pub(super) async fn project(
    State(state): State<AnnotationState>,
    Path(project_id): Path<String>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<HeadQuery>,
) -> Response {
    match project_role(&state.auth, &principal.user_id, &project_id).await {
        Ok(Some(_)) => {}
        Ok(None) => {
            return error(
                StatusCode::NOT_FOUND,
                "PROJECT_NOT_FOUND",
                "Project not found",
            )
        }
        Err(_) => return failed(),
    }
    let Some(limit) = query.limit() else {
        return error(
            StatusCode::BAD_REQUEST,
            "INVALID_LIMIT",
            "limit must be 1–100",
        );
    };
    let Some(ontology) = query
        .ontology_version_id
        .as_deref()
        .filter(|id| !id.is_empty())
    else {
        return error(
            StatusCode::BAD_REQUEST,
            "ONTOLOGY_REQUIRED",
            "ontology_version_id is required",
        );
    };
    let result: Result<bool,_> = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM ontology_versions WHERE project_id=? AND ontology_version_id=?)").bind(&project_id).bind(ontology).fetch_one(&state.auth.pool).await;
    match result {
        Ok(true) => {}
        Ok(false) => {
            return error(
                StatusCode::NOT_FOUND,
                "ONTOLOGY_NOT_FOUND",
                "Ontology not found",
            )
        }
        Err(_) => return failed(),
    }
    // Limit media BEFORE joining heads: missing heads remain in the selected page.
    let sql = format!("WITH page AS (SELECT * FROM media_revisions WHERE project_id=? AND (? IS NULL OR asset_revision_id>?) ORDER BY asset_revision_id LIMIT ?) SELECT p.*,mm.canonical_width,mm.canonical_height,mm.exif_orientation,mm.original_to_canonical_json,mm.source_group_id,h.annotation_revision_id AS head_id,{SUMMARY} FROM page p LEFT JOIN media_metadata mm ON mm.asset_revision_id=p.asset_revision_id LEFT JOIN annotation_heads h ON h.project_id=p.project_id AND h.asset_revision_id=p.asset_revision_id AND h.ontology_version_id=? LEFT JOIN annotation_revisions r ON r.project_id=h.project_id AND r.annotation_revision_id=h.annotation_revision_id AND r.asset_revision_id=h.asset_revision_id AND r.ontology_version_id=h.ontology_version_id ORDER BY p.asset_revision_id");
    let rows = match sqlx::query(&sql)
        .bind(&project_id)
        .bind(&query.cursor)
        .bind(&query.cursor)
        .bind((limit + 1) as i64)
        .bind(ontology)
        .fetch_all(&state.auth.pool)
        .await
    {
        Ok(rows) => rows,
        Err(_) => return failed(),
    };
    let next_cursor = if rows.len() > limit {
        rows[limit - 1]
            .try_get::<String, _>("asset_revision_id")
            .ok()
    } else {
        None
    };
    let items: Result<Vec<_>, sqlx::Error> = rows
        .iter()
        .take(limit)
        .map(|row| {
            let matrix: String = row.try_get("original_to_canonical_json")?;
            let media = MediaRevision {
                asset_id: Id::from(row.try_get::<String, _>("asset_id")?),
                asset_revision_id: Id::from(row.try_get::<String, _>("asset_revision_id")?),
                project_id: Id::from(project_id.clone()),
                original_name: row.try_get("original_name")?,
                original_sha256: row.try_get("original_sha256")?,
                canonical_sha256: row.try_get("canonical_sha256")?,
                canonical_width: u32::try_from(row.try_get::<i64, _>("canonical_width")?)
                    .map_err(|error| sqlx::Error::Protocol(error.to_string()))?,
                canonical_height: u32::try_from(row.try_get::<i64, _>("canonical_height")?)
                    .map_err(|error| sqlx::Error::Protocol(error.to_string()))?,
                exif_orientation: u8::try_from(row.try_get::<i64, _>("exif_orientation")?)
                    .map_err(|error| sqlx::Error::Protocol(error.to_string()))?,
                original_to_canonical: serde_json::from_str(&matrix)
                    .map_err(|error| sqlx::Error::Protocol(error.to_string()))?,
                source_group_id: Id::from(row.try_get::<String, _>("source_group_id")?),
            };
            media
                .validate()
                .map_err(|error| sqlx::Error::Protocol(error.to_string()))?;
            let head = if row.try_get::<Option<String>, _>("head_id")?.is_some() {
                Some(summary(row)?)
            } else {
                None
            };
            Ok(AssetAnnotationHead { media, head })
        })
        .collect();
    match items {
        Ok(items) => Json(AssetAnnotationHeadPage { items, next_cursor }).into_response(),
        Err(_) => failed(),
    }
}
