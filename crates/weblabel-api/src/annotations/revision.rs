use annotation_domain::{document::validate_id, AnnotationDocument, AnnotationRevision, Id};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use sqlx::{Row, SqlitePool};

use crate::auth::{error, Principal};

use super::AnnotationState;

#[derive(Deserialize)]
pub(super) struct HeadQuery {
    ontology_version_id: Option<String>,
}

pub(super) async fn head(
    State(state): State<AnnotationState>,
    Path(asset_revision_id): Path<String>,
    Query(query): Query<HeadQuery>,
    Extension(principal): Extension<Principal>,
) -> Response {
    let Some(ontology_version_id) = query.ontology_version_id else {
        return error(
            StatusCode::BAD_REQUEST,
            "ONTOLOGY_VERSION_REQUIRED",
            "ontology_version_id query parameter is required",
        );
    };
    if validate_id(&ontology_version_id).is_err() {
        return error(
            StatusCode::BAD_REQUEST,
            "INVALID_ONTOLOGY_VERSION_ID",
            "ontology_version_id is invalid",
        );
    }
    let project_id =
        match accessible_project(&state.auth.pool, &asset_revision_id, &principal.user_id).await {
            Ok(Some(project_id)) => project_id,
            Ok(None) => {
                return error(
                    StatusCode::NOT_FOUND,
                    "ANNOTATION_NOT_FOUND",
                    "Annotation head not found",
                )
            }
            Err(_) => {
                return error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "ANNOTATION_READ_FAILED",
                    "Could not read annotation head",
                )
            }
        };
    let row = sqlx::query(
        "SELECT r.annotation_revision_id, r.parent_revision_id, r.revision_no, \
                r.body_json, r.content_hash, r.created_by, r.created_at \
         FROM annotation_heads h \
         JOIN annotation_revisions r ON r.project_id=h.project_id \
             AND r.annotation_revision_id=h.annotation_revision_id \
         WHERE h.project_id=? AND h.asset_revision_id=? AND h.ontology_version_id=?",
    )
    .bind(&project_id)
    .bind(&asset_revision_id)
    .bind(&ontology_version_id)
    .fetch_optional(&state.auth.pool)
    .await;
    match row {
        Ok(Some(row)) => match parse_revision(&row) {
            Ok(revision) => Json(revision).into_response(),
            Err(()) => error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "ANNOTATION_CORRUPT",
                "Stored annotation revision is invalid",
            ),
        },
        Ok(None) => error(
            StatusCode::NOT_FOUND,
            "ANNOTATION_NOT_FOUND",
            "Annotation head not found",
        ),
        Err(_) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "ANNOTATION_READ_FAILED",
            "Could not read annotation head",
        ),
    }
}

pub(super) async fn historical(
    State(state): State<AnnotationState>,
    Path(annotation_revision_id): Path<String>,
    Extension(principal): Extension<Principal>,
) -> Response {
    let row = sqlx::query(
        "SELECT r.annotation_revision_id, r.parent_revision_id, r.revision_no, \
                r.body_json, r.content_hash, r.created_by, r.created_at \
         FROM annotation_revisions r \
         JOIN memberships m ON m.project_id=r.project_id \
         WHERE r.annotation_revision_id=? AND m.user_id=?",
    )
    .bind(&annotation_revision_id)
    .bind(&principal.user_id)
    .fetch_optional(&state.auth.pool)
    .await;
    match row {
        Ok(Some(row)) => match parse_revision(&row) {
            Ok(revision) => Json(revision).into_response(),
            Err(()) => error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "ANNOTATION_CORRUPT",
                "Stored annotation revision is invalid",
            ),
        },
        Ok(None) => error(
            StatusCode::NOT_FOUND,
            "ANNOTATION_NOT_FOUND",
            "Annotation revision not found",
        ),
        Err(_) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "ANNOTATION_READ_FAILED",
            "Could not read annotation revision",
        ),
    }
}

pub(super) fn parse_revision(row: &sqlx::sqlite::SqliteRow) -> Result<AnnotationRevision, ()> {
    let annotation_revision_id: String = row.try_get("annotation_revision_id").map_err(|_| ())?;
    let parent_revision_id: Option<String> = row.try_get("parent_revision_id").map_err(|_| ())?;
    let revision_no: i64 = row.try_get("revision_no").map_err(|_| ())?;
    let body_json: String = row.try_get("body_json").map_err(|_| ())?;
    let content_hash: String = row.try_get("content_hash").map_err(|_| ())?;
    let created_by: String = row.try_get("created_by").map_err(|_| ())?;
    let created_at: String = row.try_get("created_at").map_err(|_| ())?;
    let document: AnnotationDocument = serde_json::from_str(&body_json).map_err(|_| ())?;
    let revision_no = u64::try_from(revision_no).map_err(|_| ())?;
    Ok(AnnotationRevision {
        annotation_revision_id: Id::from(annotation_revision_id),
        parent_revision_id: parent_revision_id.map(Id::from),
        revision_no,
        document,
        created_at,
        created_by: Id::from(created_by),
        content_hash,
    })
}

pub(super) async fn accessible_project(
    pool: &SqlitePool,
    asset_revision_id: &str,
    user_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT r.project_id FROM media_revisions r \
         JOIN memberships m ON m.project_id=r.project_id \
         WHERE r.asset_revision_id=? AND m.user_id=?",
    )
    .bind(asset_revision_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
}
