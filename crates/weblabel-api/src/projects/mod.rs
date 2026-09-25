mod ontology;
mod users;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    middleware,
    response::IntoResponse,
    routing::{get, post},
    Extension, Json, Router,
};
use serde_json::{json, Value};
use sqlx::Row;

use crate::auth::{error, AuthState, Principal, Role};

pub fn router(state: AuthState) -> Router {
    Router::new()
        .route(
            "/api/users",
            get(users::list_users).post(users::create_user),
        )
        .route("/api/projects", get(list_projects).post(create_project))
        .route("/api/projects/{project_id}/members", post(add_member))
        .route(
            "/api/projects/{project_id}/ontologies",
            get(ontology::list).post(ontology::publish),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            crate::auth::authenticate,
        ))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            crate::auth::csrf_and_origin,
        ))
        .with_state(state)
}

async fn list_projects(
    State(state): State<AuthState>,
    Extension(principal): Extension<Principal>,
) -> axum::response::Response {
    let rows = sqlx::query("SELECT p.project_id,p.name,p.description,p.allow_self_review,m.role FROM projects p JOIN memberships m ON m.project_id=p.project_id WHERE m.user_id=? ORDER BY p.created_at,p.project_id")
        .bind(&principal.user_id).fetch_all(&state.pool).await;
    match rows {
        Ok(rows) => (StatusCode::OK, Json(json!({"items": rows.iter().map(|row| json!({"project_id": row.get::<String,_>("project_id"), "name": row.get::<String,_>("name"), "description": row.get::<String,_>("description"), "allow_self_review": row.get::<i64,_>("allow_self_review") == 1, "role": row.get::<String,_>("role")})).collect::<Vec<_>>(), "next_cursor": null}))).into_response(),
        Err(_) => crate::auth::error(StatusCode::INTERNAL_SERVER_ERROR, "PROJECT_LIST_FAILED", "Could not list projects"),
    }
}

async fn create_project(
    State(state): State<AuthState>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let Some(name) = body
        .get("name")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty() && s.len() <= 128)
    else {
        return error(
            StatusCode::BAD_REQUEST,
            "INVALID_PROJECT",
            "Project name is required",
        );
    };
    let Some(description) = body
        .get("description")
        .and_then(Value::as_str)
        .filter(|value| value.len() <= 4096)
    else {
        return error(
            StatusCode::BAD_REQUEST,
            "INVALID_PROJECT",
            "description must be a string of at most 4096 bytes",
        );
    };
    let Some(allow_self_review) = body.get("allow_self_review").and_then(Value::as_bool) else {
        return error(
            StatusCode::BAD_REQUEST,
            "INVALID_PROJECT",
            "allow_self_review must be a boolean",
        );
    };
    let project_id = uuid::Uuid::new_v4().to_string();
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "PROJECT_CREATE_FAILED",
                "Could not create project",
            )
        }
    };
    let result = async {
        sqlx::query("INSERT INTO projects(project_id,name,description,allow_self_review,created_at) VALUES(?,?,?,?,?)")
            .bind(&project_id).bind(name.trim()).bind(description).bind(if allow_self_review { 1_i64 } else { 0_i64 }).bind(now_rfc3339()).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO memberships(project_id,user_id,role) VALUES(?,?, 'admin')").bind(&project_id).bind(&principal.user_id).execute(&mut *tx).await?;
        Ok::<_, sqlx::Error>(())
    }.await;
    if result.is_err() || tx.commit().await.is_err() {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "PROJECT_CREATE_FAILED",
            "Could not create project",
        );
    }
    (StatusCode::CREATED, Json(json!({"project_id": project_id, "name": name.trim(), "description": description, "allow_self_review": allow_self_review}))).into_response()
}

async fn add_member(
    State(state): State<AuthState>,
    Extension(principal): Extension<Principal>,
    Path(project_id): Path<String>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let Some(user_id) = body.get("user_id").and_then(Value::as_str) else {
        return error(
            StatusCode::BAD_REQUEST,
            "INVALID_MEMBERSHIP",
            "user_id is required",
        );
    };
    let Some(role) = body
        .get("role")
        .and_then(Value::as_str)
        .and_then(Role::parse)
    else {
        return error(
            StatusCode::BAD_REQUEST,
            "INVALID_MEMBERSHIP",
            "role is invalid",
        );
    };
    match project_role(&state, &principal.user_id, &project_id).await {
        Ok(Some(Role::Admin)) => {}
        Ok(Some(_)) => {
            return error(
                StatusCode::FORBIDDEN,
                "PROJECT_ADMIN_REQUIRED",
                "Project administrator required",
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
                "MEMBERSHIP_FAILED",
                "Could not update membership",
            )
        }
    }
    match user_exists(&state, user_id).await {
        Ok(true) => {}
        Ok(false) => return error(StatusCode::NOT_FOUND, "USER_NOT_FOUND", "User not found"),
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "MEMBERSHIP_FAILED",
                "Could not update membership",
            )
        }
    }
    match sqlx::query("INSERT INTO memberships(project_id,user_id,role) VALUES(?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role")
        .bind(&project_id).bind(user_id).bind(role.as_str()).execute(&state.pool).await {
        Ok(_) => (StatusCode::OK, Json(json!({"project_id": project_id, "user_id": user_id, "role": role.as_str()}))).into_response(),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "MEMBERSHIP_FAILED", "Could not update membership"),
    }
}

pub(crate) async fn project_role(
    state: &AuthState,
    user_id: &str,
    project_id: &str,
) -> Result<Option<Role>, sqlx::Error> {
    let row = sqlx::query("SELECT role FROM memberships WHERE user_id=? AND project_id=?")
        .bind(user_id)
        .bind(project_id)
        .fetch_optional(&state.pool)
        .await?;
    Ok(row.and_then(|r| Role::parse(&r.get::<String, _>("role"))))
}
pub(crate) async fn user_exists(state: &AuthState, user_id: &str) -> Result<bool, sqlx::Error> {
    let (exists,) =
        sqlx::query_as::<_, (i64,)>("SELECT EXISTS(SELECT 1 FROM users WHERE user_id=?)")
            .bind(user_id)
            .fetch_one(&state.pool)
            .await?;
    Ok(exists == 1)
}

pub(crate) fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
