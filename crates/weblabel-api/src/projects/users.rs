use axum::{extract::State, http::StatusCode, Extension, Json};
use serde_json::{json, Value};
use sqlx::Row;

use crate::auth::{error, password, AuthState, Principal};

pub(super) async fn list_users(
    State(state): State<AuthState>,
    Extension(principal): Extension<Principal>,
) -> axum::response::Response {
    if !principal.platform_admin {
        return error(
            StatusCode::FORBIDDEN,
            "PLATFORM_ADMIN_REQUIRED",
            "Platform administrator required",
        );
    }
    match sqlx::query("SELECT user_id,username,created_at FROM users ORDER BY created_at,user_id").fetch_all(&state.pool).await {
        Ok(rows) => (StatusCode::OK, Json(json!({"items": rows.iter().map(|r| json!({"user_id": r.get::<String,_>("user_id"), "username": r.get::<String,_>("username"), "created_at": r.get::<String,_>("created_at")})).collect::<Vec<_>>(), "next_cursor": null}))).into_response(),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "USER_LIST_FAILED", "Could not list users"),
    }
}

pub(super) async fn create_user(
    State(state): State<AuthState>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    if !principal.platform_admin {
        return error(
            StatusCode::FORBIDDEN,
            "PLATFORM_ADMIN_REQUIRED",
            "Platform administrator required",
        );
    }
    let Some(username) = body.get("username").and_then(Value::as_str).filter(|s| {
        (3..=64).contains(&s.len())
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    }) else {
        return error(
            StatusCode::BAD_REQUEST,
            "INVALID_USER",
            "Username must be 3-64 ASCII letters, digits, dot, underscore or hyphen",
        );
    };
    let Some(password_value) = body
        .get("password")
        .and_then(Value::as_str)
        .filter(|p| p.len() >= 12 && p.len() <= 1024)
    else {
        return error(
            StatusCode::BAD_REQUEST,
            "INVALID_USER",
            "Password must contain 12-1024 bytes",
        );
    };
    let password_hash = match password::hash(password_value) {
        Ok(hash) => hash,
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "USER_CREATE_FAILED",
                "Could not create user",
            )
        }
    };
    let user_id = uuid::Uuid::new_v4().to_string();
    let created_at = crate::projects::now_rfc3339();
    match sqlx::query("INSERT INTO users(user_id,username,password_hash,created_at,platform_admin) VALUES(?,?,?,?,0)")
        .bind(&user_id).bind(username).bind(password_hash).bind(created_at).execute(&state.pool).await {
        Ok(_) => (StatusCode::CREATED, Json(json!({"user_id": user_id, "username": username}))).into_response(),
        Err(sqlx::Error::Database(error)) if error.is_unique_violation() => error_response(),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "USER_CREATE_FAILED", "Could not create user"),
    }
}

fn error_response() -> axum::response::Response {
    error(
        StatusCode::CONFLICT,
        "USERNAME_EXISTS",
        "Username is already in use",
    )
}
use axum::response::IntoResponse;
