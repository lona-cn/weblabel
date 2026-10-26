use super::{require_project_role, ReviewState};
use crate::auth::{error, Principal, Role};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
#[derive(Deserialize)]
pub(super) struct SubmitRequest {
    annotation_revision_ids: Vec<String>,
}
pub(super) async fn submit(
    State(state): State<ReviewState>,
    Path(task_id): Path<String>,
    Extension(actor): Extension<Principal>,
    Json(body): Json<SubmitRequest>,
) -> Result<Json<Value>, axum::response::Response> {
    if body.annotation_revision_ids.len() != 1 {
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_SUBMISSION",
            "A task submission must identify exactly its immutable annotation revision",
        ));
    }
    let mut tx = state.repository.begin_write().await.map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "REVIEW_UNAVAILABLE",
            "Could not begin submission",
        )
    })?;
    let task=sqlx::query("SELECT project_id,asset_revision_id,ontology_version_id,assignee_id,state FROM review_tasks WHERE task_id=?").bind(&task_id).fetch_optional(tx.connection()).await.map_err(|_|error(StatusCode::SERVICE_UNAVAILABLE,"REVIEW_UNAVAILABLE","Could not read task"))?.ok_or_else(||error(StatusCode::NOT_FOUND,"TASK_NOT_FOUND","Task does not exist"))?;
    let project: String = task.get("project_id");
    let asset: String = task.get("asset_revision_id");
    let ontology: String = task.get("ontology_version_id");
    let assignee: String = task.get("assignee_id");
    let task_state: String = task.get("state");
    require_project_role(
        &state.auth,
        &actor.user_id,
        &project,
        &[Role::Annotator, Role::Admin],
    )
    .await?;
    if assignee != actor.user_id && !actor.platform_admin {
        let _ = tx.rollback().await;
        return Err(error(
            StatusCode::FORBIDDEN,
            "TASK_NOT_ASSIGNED",
            "Only the assigned annotator may submit",
        ));
    }
    if task_state != "open" {
        let _ = tx.rollback().await;
        return Err(error(
            StatusCode::CONFLICT,
            "TASK_NOT_OPEN",
            "Only open tasks can receive a submission",
        ));
    }
    let lease =
        sqlx::query("SELECT holder_id,fencing_token,expires_at FROM task_leases WHERE task_id=?")
            .bind(&task_id)
            .fetch_optional(tx.connection())
            .await
            .map_err(|_| {
                error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "REVIEW_UNAVAILABLE",
                    "Could not verify task lease",
                )
            })?
            .ok_or_else(|| {
                error(
                    StatusCode::CONFLICT,
                    "LEASE_REQUIRED",
                    "An active task lease is required",
                )
            })?;
    if lease.get::<Option<String>, _>("holder_id").as_deref() != Some(actor.user_id.as_str())
        || lease.get::<i64, _>("expires_at") <= chrono::Utc::now().timestamp()
    {
        let _ = tx.rollback().await;
        return Err(error(
            StatusCode::CONFLICT,
            "LEASE_EXPIRED",
            "A current task lease is required",
        ));
    }
    let rev=sqlx::query("SELECT body_json FROM annotation_revisions WHERE annotation_revision_id=? AND project_id=? AND asset_revision_id=? AND ontology_version_id=?").bind(&body.annotation_revision_ids[0]).bind(&project).bind(&asset).bind(&ontology).fetch_optional(tx.connection()).await.map_err(|_|error(StatusCode::SERVICE_UNAVAILABLE,"REVIEW_UNAVAILABLE","Could not read revision"))?.ok_or_else(||error(StatusCode::UNPROCESSABLE_ENTITY,"REVISION_MISMATCH","Revision must belong to task media and ontology"))?;
    let document: Value = serde_json::from_str(rev.get::<String, _>("body_json").as_str())
        .map_err(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "REVISION_INVALID",
                "Stored annotation revision is invalid",
            )
        })?;
    let completion = document.get("completion").and_then(Value::as_str);
    let empty = document
        .get("objects")
        .and_then(Value::as_array)
        .is_some_and(Vec::is_empty);
    if completion == Some("confirmed_negative") && !empty {
        let _ = tx.rollback().await;
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_NEGATIVE",
            "Confirmed negative requires an empty object list",
        ));
    }
    if empty && completion != Some("confirmed_negative") {
        let _ = tx.rollback().await;
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "EMPTY_NOT_NEGATIVE",
            "An empty annotation must be explicitly confirmed negative",
        ));
    }
    if completion != Some("complete") && completion != Some("confirmed_negative") {
        let _ = tx.rollback().await;
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "ANNOTATION_INCOMPLETE",
            "Unprocessed or in-progress annotations cannot be submitted",
        ));
    }
    let current=sqlx::query_scalar::<_,String>("SELECT annotation_revision_id FROM annotation_heads WHERE project_id=? AND asset_revision_id=? AND ontology_version_id=?").bind(&project).bind(&asset).bind(&ontology).fetch_optional(tx.connection()).await.map_err(|_|error(StatusCode::SERVICE_UNAVAILABLE,"REVIEW_UNAVAILABLE","Could not verify current annotation head"))?;
    if current.as_deref() != Some(body.annotation_revision_ids[0].as_str()) {
        let _ = tx.rollback().await;
        return Err(error(
            StatusCode::CONFLICT,
            "REVISION_NOT_HEAD",
            "Submission must identify the current saved revision",
        ));
    }
    let review_id = uuid::Uuid::new_v4().to_string();
    let now = crate::projects::now_rfc3339();
    sqlx::query("INSERT INTO review_submissions(review_id,task_id,project_id,submitted_by,revision_ids_json,state,created_at) VALUES(?,?,?,?,?,'pending',?)").bind(&review_id).bind(&task_id).bind(&project).bind(&actor.user_id).bind(serde_json::to_string(&body.annotation_revision_ids).unwrap_or_default()).bind(&now).execute(tx.connection()).await.map_err(|_|error(StatusCode::CONFLICT,"SUBMISSION_CONFLICT","Task already has a pending submission"))?;
    let changed =
        sqlx::query("UPDATE review_tasks SET state='submitted' WHERE task_id=? AND state='open'")
            .bind(&task_id)
            .execute(tx.connection())
            .await
            .map_err(|_| {
                error(
                    StatusCode::CONFLICT,
                    "TASK_STATE_CONFLICT",
                    "Task is not open",
                )
            })?;
    if changed.rows_affected() != 1 {
        let _ = tx.rollback().await;
        return Err(error(
            StatusCode::CONFLICT,
            "TASK_STATE_CONFLICT",
            "Task is not open",
        ));
    }
    let fence = lease
        .get::<i64, _>("fencing_token")
        .checked_add(1)
        .filter(|value| (1..=9_007_199_254_740_991).contains(value))
        .ok_or_else(|| {
            error(
                StatusCode::CONFLICT,
                "FENCING_LIMIT_REACHED",
                "Lease fencing limit reached",
            )
        })?;
    sqlx::query(
        "UPDATE task_leases SET holder_id=NULL,expires_at=0,fencing_token=? WHERE task_id=?",
    )
    .bind(fence)
    .bind(&task_id)
    .execute(tx.connection())
    .await
    .map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "REVIEW_UNAVAILABLE",
            "Could not end submitted task lease",
        )
    })?;
    tx.commit().await.map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "REVIEW_UNAVAILABLE",
            "Could not commit submission",
        )
    })?;
    Ok(Json(
        json!({"review_id":review_id,"task_id":task_id,"submitted_by":actor.user_id,"revision_ids":body.annotation_revision_ids,"state":"pending","created_at":now,"lease_ended":true}),
    ))
}

/// A current target-state observation, not an idempotency receipt for a POST.
pub(super) async fn latest(
    State(state): State<ReviewState>,
    Path(task_id): Path<String>,
    Extension(actor): Extension<Principal>,
) -> Result<Json<Value>, axum::response::Response> {
    let mut tx = state.auth.pool.begin().await.map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "REVIEW_UNAVAILABLE",
            "Could not read submission",
        )
    })?;
    let project: String = sqlx::query_scalar("SELECT project_id FROM review_tasks WHERE task_id=?")
        .bind(&task_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "REVIEW_UNAVAILABLE",
                "Could not read task",
            )
        })?
        .ok_or_else(|| {
            error(
                StatusCode::NOT_FOUND,
                "TASK_NOT_FOUND",
                "Task does not exist",
            )
        })?;
    require_project_role(
        &state.auth,
        &actor.user_id,
        &project,
        &[Role::Admin, Role::Annotator, Role::Reviewer, Role::Viewer],
    )
    .await?;
    let row = sqlx::query("SELECT s.review_id,s.submitted_by,s.revision_ids_json,s.state,s.created_at,l.holder_id,l.expires_at FROM review_submissions s LEFT JOIN task_leases l ON l.task_id=s.task_id WHERE s.task_id=? ORDER BY s.created_at DESC,s.review_id DESC LIMIT 1")
        .bind(&task_id).fetch_optional(&mut *tx).await
        .map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE, "REVIEW_UNAVAILABLE", "Could not read submission"))?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "SUBMISSION_NOT_FOUND", "Task has no submission"))?;
    let revisions: Value = serde_json::from_str(&row.get::<String, _>("revision_ids_json"))
        .map_err(|_| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "REVIEW_UNAVAILABLE",
                "Invalid stored submission",
            )
        })?;
    let ended = row.get::<Option<String>, _>("holder_id").is_none()
        && row.get::<Option<i64>, _>("expires_at") == Some(0);
    Ok(Json(
        json!({"review_id":row.get::<String,_>("review_id"),"task_id":task_id,"submitted_by":row.get::<String,_>("submitted_by"),"revision_ids":revisions,"state":row.get::<String,_>("state"),"created_at":row.get::<String,_>("created_at"),"lease_ended":ended}),
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        auth::{hash_launch_code, AuthConfig},
        config::ServerConfig,
        AppState,
    };
    use std::time::Duration;
    #[test]
    fn readback_is_project_protected_and_observes_real_lease_state_without_writes() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/test-artifacts/html-rust-rebuild/r08-review-readback");
        std::fs::create_dir_all(&root).unwrap();
        let directory = tempfile::tempdir_in(&root).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(assert_readback(directory.path()));
        drop(runtime);
        directory.close().unwrap();
    }

    async fn assert_readback(directory: &std::path::Path) {
        let bind = "127.0.0.1:48100".parse().unwrap();
        let config = ServerConfig {
            bind,
            database_url: format!(
                "sqlite:{}",
                directory.join("readback.sqlite").display()
            ),
            object_root: directory.join("objects"),
            write_timeout: Duration::from_secs(2),
            production: true,
        };
        let app = AppState::open_with_auth(
            &config,
            AuthConfig {
                bind,
                cookie_secure: false,
                allowed_origins: vec!["http://127.0.0.1:48100".into()],
                allowed_hosts: vec!["127.0.0.1:48100".into()],
                launch_code: hash_launch_code("readback-test"),
                launch_code_expires_at: chrono::Utc::now().timestamp() + 60,
            },
        )
        .await
        .unwrap();
        let pool = &app.auth.pool;
        for query in [
            "INSERT INTO users(user_id,username,password_hash,created_at) VALUES('actor','actor','fixture','now'),('outsider','outsider','fixture','now')",
            "INSERT INTO projects(project_id,name,description,created_at) VALUES('project','fixture','','now')",
            "INSERT INTO memberships(project_id,user_id,role) VALUES('project','actor','viewer')",
            "INSERT INTO ontology_versions(ontology_version_id,project_id,version_no,body_json,created_at) VALUES('ontology','project',1,'{}','now')",
            "INSERT INTO media_assets(asset_id,project_id,created_at) VALUES('asset','project','now')",
            "INSERT INTO media_revisions(asset_revision_id,project_id,asset_id,original_sha256,canonical_sha256,original_name,created_at) VALUES('image','project','asset','original','canonical','fixture','now')",
            "INSERT INTO review_tasks(task_id,project_id,asset_revision_id,ontology_version_id,assignee_id,created_by,state,created_at) VALUES('task','project','image','ontology','actor','actor','submitted','now')",
            "INSERT INTO task_leases(task_id,holder_id,fencing_token,expires_at,updated_at) VALUES('task',NULL,3,0,0)",
            "INSERT INTO review_submissions(review_id,task_id,project_id,submitted_by,revision_ids_json,state,created_at) VALUES('review','task','project','actor','[\"fixed-revision\"]','pending','2026-10-13T00:00:00Z')",
        ] { sqlx::query(query).execute(pool).await.unwrap(); }
        let state = ReviewState {
            repository: app.repository.clone(),
            auth: app.auth.clone(),
        };
        let actor = Principal {
            user_id: "actor".into(),
            username: "actor".into(),
            platform_admin: false,
        };
        let Json(result) = latest(
            State(state.clone()),
            Path("task".into()),
            Extension(actor.clone()),
        )
        .await
        .unwrap();
        assert_eq!(result["lease_ended"], true);
        assert_eq!(result["submitted_by"], "actor");
        assert_eq!(result["revision_ids"], json!(["fixed-revision"]));
        let outsider = Principal {
            user_id: "outsider".into(),
            username: "outsider".into(),
            platform_admin: false,
        };
        assert_eq!(
            latest(
                State(state.clone()),
                Path("task".into()),
                Extension(outsider)
            )
            .await
            .unwrap_err()
            .status(),
            StatusCode::FORBIDDEN
        );
        sqlx::query("UPDATE task_leases SET holder_id='actor',expires_at=123 WHERE task_id='task'")
            .execute(pool)
            .await
            .unwrap();
        let Json(result) = latest(State(state), Path("task".into()), Extension(actor))
            .await
            .unwrap();
        assert_eq!(result["lease_ended"], false);
        let lease: (Option<String>, i64, i64) = sqlx::query_as(
            "SELECT holder_id,expires_at,fencing_token FROM task_leases WHERE task_id='task'",
        )
        .fetch_one(pool)
        .await
        .unwrap();
        assert_eq!(lease, (Some("actor".into()), 123, 3));
        // SQLx 0.8.6 may finish pool.close after the last permit is returned
        // without draining the connection queued by that return. Quiesce all
        // slots first, then await each SQLite worker before fixture deletion.
        let capacity = pool.options().get_max_connections();
        let mut connections = Vec::with_capacity(capacity as usize);
        for _ in 0..capacity {
            connections.push(pool.acquire().await.unwrap());
        }
        for connection in connections {
            connection.close().await.unwrap();
        }
        pool.close().await;
        // Drain the separate repository pool before the outer TempDir closes.
        app.repository.close().await;
        drop(app);
    }
}
