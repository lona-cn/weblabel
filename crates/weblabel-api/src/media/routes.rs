use axum::{
    body::Body,
    extract::{DefaultBodyLimit, FromRequest, Multipart, Path, Query, State},
    http::{header, HeaderMap, HeaderValue, Request, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::{
    auth::{error, AuthState, Principal},
    jobs::queue::JobQueue,
    media::{
        canonical::sha256_hex,
        ingest::{self, ImportError, ImportInput, MAX_IMPORT_ITEMS, MAX_MEDIA_PAGE},
        limits::MAX_UPLOAD_BYTES,
    },
    projects::project_role,
    storage::Repository,
};

#[derive(Clone)]
struct MediaState {
    repository: Repository,
    auth: AuthState,
}

#[derive(Deserialize)]
struct ListQuery {
    cursor: Option<String>,
    limit: Option<usize>,
}

pub fn router(repository: Repository, auth: AuthState) -> Router {
    let state = MediaState {
        repository,
        auth: auth.clone(),
    };
    Router::new()
        .route("/api/projects/{project_id}/assets", post(upload).get(list))
        .route("/api/assets/{asset_revision_id}/image", get(image))
        .route_layer(middleware::from_fn_with_state(
            auth.clone(),
            crate::auth::authenticate,
        ))
        .route_layer(middleware::from_fn_with_state(
            auth.clone(),
            crate::auth::csrf_and_origin,
        ))
        .layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES))
        .with_state(state)
}

async fn upload(
    State(state): State<MediaState>,
    Path(project_id): Path<String>,
    Extension(principal): Extension<Principal>,
    request: Request<Body>,
) -> Response {
    match project_role(&state.auth, &principal.user_id, &project_id).await {
        Ok(Some(role)) if role.can_write() => {}
        Ok(Some(_)) => {
            return error(
                StatusCode::FORBIDDEN,
                "PROJECT_WRITE_REQUIRED",
                "Project write role required",
            )
        }
        Ok(None) => {
            return error(
                StatusCode::NOT_FOUND,
                "PROJECT_NOT_FOUND",
                "Project not found",
            )
        }
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "PROJECT_LOOKUP_FAILED",
                "Could not authorize project",
            )
        }
    }
    if request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_UPLOAD_BYTES)
    {
        return error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "UPLOAD_TOO_LARGE",
            "Multipart request exceeds the upload budget",
        );
    }
    let Some(operation_id) = request
        .headers()
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty() && value.chars().count() <= 128)
        .map(str::to_owned)
    else {
        return error(
            StatusCode::BAD_REQUEST,
            "IDEMPOTENCY_KEY_REQUIRED",
            "Idempotency-Key header is required and must be at most 128 characters",
        );
    };
    let mut multipart = match Multipart::from_request(request, &state).await {
        Ok(multipart) => multipart,
        Err(rejection) => {
            return error(
                rejection.status(),
                "INVALID_MULTIPART",
                "Could not parse bounded multipart upload",
            )
        }
    };
    let ontology_version_id: Option<String> = match sqlx::query_scalar(
        "SELECT ontology_version_id FROM ontology_versions WHERE project_id=? ORDER BY version_no DESC LIMIT 1",
    )
    .bind(&project_id)
    .fetch_optional(&state.auth.pool)
    .await {
        Ok(value) => value,
        Err(_) => return error(StatusCode::INTERNAL_SERVER_ERROR, "ONTOLOGY_LOOKUP_FAILED", "Could not resolve project ontology"),
    };
    let Some(ontology_version_id) = ontology_version_id else {
        return error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "ONTOLOGY_REQUIRED",
            "Publish an ontology before importing media",
        );
    };
    let source_group_id = Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("{project_id}:{operation_id}").as_bytes(),
    )
    .to_string();
    let mut inputs = Vec::new();
    let mut total_bytes = 0usize;
    loop {
        let field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(_) => {
                return error(
                    StatusCode::BAD_REQUEST,
                    "INVALID_MULTIPART",
                    "Could not read multipart upload",
                )
            }
        };
        if field.name() != Some("images") {
            continue;
        }
        if inputs.len() == MAX_IMPORT_ITEMS {
            return error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "TOO_MANY_IMAGES",
                "An import batch cannot exceed 500 images",
            );
        }
        let Some(original_name) = field.file_name().map(str::to_owned) else {
            return error(
                StatusCode::BAD_REQUEST,
                "INVALID_MULTIPART",
                "Each image must include a filename",
            );
        };
        let declared_mime = field.content_type().map(str::to_owned);
        let bytes = match field.bytes().await {
            Ok(bytes) => bytes,
            Err(_) => {
                return error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "UPLOAD_TOO_LARGE",
                    "Multipart request exceeds the upload budget",
                )
            }
        };
        total_bytes = match total_bytes.checked_add(bytes.len()) {
            Some(total) if total <= MAX_UPLOAD_BYTES => total,
            _ => {
                return error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "UPLOAD_TOO_LARGE",
                    "Multipart request exceeds the upload budget",
                )
            }
        };
        inputs.push(ImportInput {
            project_id: project_id.clone(),
            ontology_version_id: ontology_version_id.clone(),
            actor_id: principal.user_id.clone(),
            source_group_id: source_group_id.clone(),
            original_name,
            declared_mime,
            bytes: bytes.to_vec(),
        });
    }
    if inputs.is_empty() {
        return error(
            StatusCode::BAD_REQUEST,
            "EMPTY_BATCH",
            "At least one images field is required",
        );
    }
    let queue = JobQueue::new(state.repository.clone());
    match ingest::enqueue_import_job(&state.repository, &queue, &operation_id, inputs).await {
        Ok(job) => (
            StatusCode::ACCEPTED,
            Json(json!({"import_job_id": job.job_id, "duplicate": job.duplicate})),
        )
            .into_response(),
        Err(failure) => import_error(failure),
    }
}

async fn list(
    State(state): State<MediaState>,
    Path(project_id): Path<String>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<ListQuery>,
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
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "PROJECT_LOOKUP_FAILED",
                "Could not authorize project",
            )
        }
    }
    let limit = query.limit.unwrap_or(50);
    if limit == 0 || limit > MAX_MEDIA_PAGE {
        return error(
            StatusCode::BAD_REQUEST,
            "INVALID_PAGE",
            "limit must be between 1 and 100",
        );
    }
    if query
        .cursor
        .as_ref()
        .is_some_and(|cursor| cursor.is_empty() || cursor.len() > 128)
    {
        return error(StatusCode::BAD_REQUEST, "INVALID_PAGE", "cursor is invalid");
    }
    match ingest::list_media(
        &state.repository,
        &project_id,
        query.cursor.as_deref(),
        limit,
    )
    .await
    {
        Ok(items) => {
            let next_cursor = (items.len() == limit)
                .then(|| items.last().map(|item| item.asset_revision_id.to_string()))
                .flatten();
            (
                StatusCode::OK,
                Json(json!({"items": items, "next_cursor": next_cursor})),
            )
                .into_response()
        }
        Err(failure) => import_error(failure),
    }
}

async fn image(
    State(state): State<MediaState>,
    Path(asset_revision_id): Path<String>,
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
) -> Response {
    let project_id = match sqlx::query_scalar::<_, String>(
        "SELECT r.project_id FROM media_revisions r JOIN memberships m ON m.project_id=r.project_id WHERE r.asset_revision_id=? AND m.user_id=?",
    )
    .bind(&asset_revision_id)
    .bind(&principal.user_id)
    .fetch_optional(&state.auth.pool)
    .await {
        Ok(Some(project_id)) => project_id,
        Ok(None) => return error(StatusCode::NOT_FOUND, "MEDIA_NOT_FOUND", "Media revision not found"),
        Err(_) => return error(StatusCode::INTERNAL_SERVER_ERROR, "MEDIA_LOOKUP_FAILED", "Could not authorize media revision"),
    };
    let bytes = match ingest::load_canonical_png(&state.repository, &project_id, &asset_revision_id)
        .await
    {
        Ok(bytes) => bytes,
        Err(ImportError::NotFound) => {
            return error(
                StatusCode::NOT_FOUND,
                "MEDIA_NOT_FOUND",
                "Media revision not found",
            )
        }
        Err(failure) => return import_error(failure),
    };
    let etag = format!("\"{}\"", sha256_hex(&bytes));
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        == Some(etag.as_str())
    {
        return (
            StatusCode::NOT_MODIFIED,
            [(header::ETAG, HeaderValue::from_str(&etag).unwrap())],
        )
            .into_response();
    }
    let mut response = (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::ETAG, etag.as_str()),
            (header::CACHE_CONTROL, "private, no-cache"),
        ],
        bytes,
    )
        .into_response();
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

fn import_error(failure: ImportError) -> Response {
    match failure {
        ImportError::EmptyBatch | ImportError::TooManyItems => error(
            StatusCode::BAD_REQUEST,
            "INVALID_IMPORT",
            "Import batch is invalid",
        ),
        ImportError::Media(crate::media::limits::MediaError::TooManyBytes) => error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "UPLOAD_TOO_LARGE",
            "Image exceeds the upload budget",
        ),
        ImportError::NotFound => error(
            StatusCode::NOT_FOUND,
            "MEDIA_NOT_FOUND",
            "Media revision not found",
        ),
        ImportError::Media(_) | ImportError::InvalidMetadata => error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_MEDIA",
            "Media request is invalid",
        ),
        ImportError::Queue(crate::jobs::queue::QueueError::IdempotencyConflict) => error(
            StatusCode::CONFLICT,
            "IDEMPOTENCY_CONFLICT",
            "Idempotency-Key was already used with a different request",
        ),
        ImportError::Queue(crate::jobs::queue::QueueError::QueueFull) => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "QUEUE_FULL",
            "The import queue is full",
        ),
        ImportError::Queue(_)
        | ImportError::Storage(_)
        | ImportError::Object(_)
        | ImportError::ObjectUnavailable => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "MEDIA_IMPORT_FAILED",
            "Media operation failed",
        ),
    }
}
