use std::sync::atomic::Ordering;

use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    middleware,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use sqlx::Row;

use super::{
    cookie_value,
    csrf::constant_time_eq,
    error, password,
    policy::{
        cookie, csrf_hash, digest, duration, now, random_token, verify_launch_code, AuthState,
        Principal,
    },
};

const SESSION_SECONDS: u64 = 12 * 60 * 60;

pub fn router(state: AuthState) -> Router {
    Router::new()
        .route("/api/session/bootstrap", post(bootstrap))
        .route("/api/session/login", post(login))
        .route("/api/session/logout", post(logout))
        .route("/api/session", get(current_session))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            super::csrf_and_origin,
        ))
        .with_state(state)
}

async fn bootstrap(
    State(state): State<AuthState>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let Some(code) = body.get("launch_code").and_then(Value::as_str) else {
        return error(
            StatusCode::BAD_REQUEST,
            "INVALID_REQUEST",
            "launch_code is required",
        );
    };
    let Some(password_value) = body
        .get("password")
        .and_then(Value::as_str)
        .filter(|value| (12..=1024).contains(&value.len()))
    else {
        return error(
            StatusCode::BAD_REQUEST,
            "INVALID_PASSWORD",
            "Password must contain 12-1024 bytes",
        );
    };
    if !verify_launch_code(
        code,
        &state.config.launch_code,
        state.config.launch_code_expires_at,
        now(),
    ) {
        return error(
            StatusCode::UNAUTHORIZED,
            "INVALID_BOOTSTRAP_CODE",
            "Bootstrap code is invalid or expired",
        );
    }
    if state
        .bootstrap_consumed
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return error(
            StatusCode::CONFLICT,
            "BOOTSTRAP_USED",
            "Bootstrap code has already been used",
        );
    }
    let result = async {
        let admin_id = uuid::Uuid::new_v4().to_string();
        let password_hash = password::hash(password_value).map_err(|_| ())?;
        let token = random_token();
        let csrf = random_token();
        let mut tx = state.pool.begin().await.map_err(|_| ())?;
        let existing_user = sqlx::query_as::<_, (i64,)>("SELECT EXISTS(SELECT 1 FROM users)")
            .fetch_one(&mut *tx)
            .await
            .map_err(|_| ())?
            .0;
        if existing_user != 0 {
            return Err(());
        }
        sqlx::query("INSERT INTO users(user_id, username, password_hash, created_at, platform_admin) VALUES(?, 'local-admin', ?, ?, 1)")
            .bind(&admin_id)
            .bind(password_hash)
            .bind(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            .execute(&mut *tx)
            .await
            .map_err(|_| ())?;
        sqlx::query("INSERT INTO sessions(session_id, user_id, expires_at, created_at, csrf_hash) VALUES(?, ?, ?, ?, ?)")
            .bind(digest(&token))
            .bind(&admin_id)
            .bind((now() + duration().as_secs() as i64).to_string())
            .bind(now().to_string())
            .bind(csrf_hash(&csrf))
            .execute(&mut *tx)
            .await
            .map_err(|_| ())?;
        tx.commit().await.map_err(|_| ())?;
        Ok::<_, ()>((admin_id, token, csrf))
    }.await;
    match result {
        Ok((admin_id, token, csrf)) => (
            StatusCode::OK,
            [(header::SET_COOKIE, cookie(&token, &state, SESSION_SECONDS))],
            Json(json!({"user_id": admin_id, "username": "local-admin", "csrf_token": csrf})),
        )
            .into_response(),
        Err(()) => {
            state.bootstrap_consumed.store(false, Ordering::Release);
            error(
                StatusCode::CONFLICT,
                "BOOTSTRAP_UNAVAILABLE",
                "Bootstrap could not create the initial administrator",
            )
        }
    }
}

async fn login(
    State(state): State<AuthState>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let username = body.get("username").and_then(Value::as_str).unwrap_or("");
    let password_value = body.get("password").and_then(Value::as_str).unwrap_or("");
    if !(3..=64).contains(&username.len())
        || !username
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        || !(12..=1024).contains(&password_value.len())
    {
        return error(
            StatusCode::BAD_REQUEST,
            "INVALID_CREDENTIALS",
            "Username or password has an invalid length or format",
        );
    }
    let row = match sqlx::query("SELECT user_id, password_hash FROM users WHERE username = ?")
        .bind(username)
        .fetch_optional(&state.pool)
        .await
    {
        Ok(row) => row,
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "LOGIN_FAILED",
                "Login failed",
            )
        }
    };
    if !state
        .login_limiter
        .lock()
        .await
        .allow(username, row.is_some(), now())
    {
        return error(
            StatusCode::TOO_MANY_REQUESTS,
            "LOGIN_RATE_LIMITED",
            "Too many login attempts",
        );
    }
    let (user_id, stored_hash) = match row {
        Some(row) => (
            row.get::<String, _>("user_id"),
            row.get::<String, _>("password_hash"),
        ),
        None => {
            let _ = password::verify(password_value, &state.dummy_password_hash);
            return error(
                StatusCode::UNAUTHORIZED,
                "INVALID_CREDENTIALS",
                "Username or password is incorrect",
            );
        }
    };
    if !password::verify(password_value, &stored_hash) {
        return error(
            StatusCode::UNAUTHORIZED,
            "INVALID_CREDENTIALS",
            "Username or password is incorrect",
        );
    }
    state.login_limiter.lock().await.clear(username);
    match create_session(&state, &user_id).await {
        Ok((token, csrf)) => (
            StatusCode::OK,
            [(header::SET_COOKIE, cookie(&token, &state, SESSION_SECONDS))],
            Json(json!({"csrf_token": csrf})),
        )
            .into_response(),
        Err(_) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "LOGIN_FAILED",
            "Login failed",
        ),
    }
}

async fn logout(State(state): State<AuthState>, headers: HeaderMap) -> axum::response::Response {
    let Some(token) = cookie_value(&headers, "weblabel_session") else {
        return error(
            StatusCode::UNAUTHORIZED,
            "UNAUTHENTICATED",
            "Authentication required",
        );
    };
    match sqlx::query("DELETE FROM sessions WHERE session_id = ?")
        .bind(digest(&token))
        .execute(&state.pool)
        .await
    {
        Ok(_) => (
            StatusCode::NO_CONTENT,
            [(
                header::SET_COOKIE,
                format!(
                    "weblabel_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0{}",
                    if state.config.cookie_secure {
                        "; Secure"
                    } else {
                        ""
                    }
                ),
            )],
        )
            .into_response(),
        Err(_) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "LOGOUT_FAILED",
            "Logout failed",
        ),
    }
}

async fn current_session(
    State(state): State<AuthState>,
    headers: HeaderMap,
) -> axum::response::Response {
    let Some(token) = cookie_value(&headers, "weblabel_session") else {
        return error(
            StatusCode::UNAUTHORIZED,
            "UNAUTHENTICATED",
            "Authentication required",
        );
    };
    match principal(&state, &token).await {
        Ok(Some(principal)) => {
            let projects = sqlx::query(
                "SELECT project_id,role FROM memberships WHERE user_id=? ORDER BY project_id",
            )
            .bind(&principal.user_id)
            .fetch_all(&state.pool)
            .await;
            match projects {
                Ok(projects) => {
                    let roles: Vec<Value> = projects.iter().map(|row| json!({"project_id": row.get::<String,_>("project_id"), "role": row.get::<String,_>("role")})).collect();
                    (StatusCode::OK, Json(json!({"user_id": principal.user_id, "username": principal.username, "platform_admin": principal.platform_admin, "project_roles": roles}))).into_response()
                }
                Err(_) => error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "AUTHENTICATION_FAILED",
                    "Authentication failed",
                ),
            }
        }
        Ok(None) => error(
            StatusCode::UNAUTHORIZED,
            "UNAUTHENTICATED",
            "Authentication required",
        ),
        Err(_) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "AUTHENTICATION_FAILED",
            "Authentication failed",
        ),
    }
}

async fn create_session(state: &AuthState, user_id: &str) -> Result<(String, String), sqlx::Error> {
    let token = random_token();
    let csrf = random_token();
    let expires_at = (now() + duration().as_secs() as i64).to_string();
    sqlx::query("INSERT INTO sessions(session_id, user_id, expires_at, created_at, csrf_hash) VALUES(?, ?, ?, ?, ?)")
        .bind(digest(&token)).bind(user_id).bind(expires_at).bind(now().to_string()).bind(csrf_hash(&csrf)).execute(&state.pool).await?;
    Ok((token, csrf))
}

pub(crate) async fn principal(
    state: &AuthState,
    token: &str,
) -> Result<Option<Principal>, sqlx::Error> {
    let row = sqlx::query("SELECT u.user_id, u.username, u.platform_admin FROM sessions s JOIN users u ON u.user_id=s.user_id WHERE s.session_id=? AND CAST(s.expires_at AS INTEGER)>?")
        .bind(digest(token)).bind(now()).fetch_optional(&state.pool).await?;
    Ok(row.map(|r| Principal {
        user_id: r.get("user_id"),
        username: r.get("username"),
        platform_admin: r.get::<i64, _>("platform_admin") == 1,
    }))
}

pub(crate) async fn validate_csrf(
    state: &AuthState,
    token: &str,
    csrf: &str,
) -> Result<bool, sqlx::Error> {
    let stored = sqlx::query(
        "SELECT csrf_hash FROM sessions WHERE session_id=? AND CAST(expires_at AS INTEGER)>?",
    )
    .bind(digest(token))
    .bind(now())
    .fetch_optional(&state.pool)
    .await?;
    Ok(stored
        .is_some_and(|row| constant_time_eq(&row.get::<String, _>("csrf_hash"), &csrf_hash(csrf))))
}
