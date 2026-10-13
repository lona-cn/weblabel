use std::sync::Arc;

use annotation_domain::{AdminRecoveryRequest, AdminRecoveryState, AdminRecoveryStatus};
use axum::{
    extract::{rejection::JsonRejection, State},
    http::{header, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use tokio::sync::Mutex;

use super::{
    error, password,
    policy::{digest, now},
    AuthState,
};

pub(crate) struct Recovery {
    request_id: String,
    user_id: String,
    username: String,
    code_hash: String,
    expires_at: i64,
    // Owned across hashing/commit, including a disconnected HTTP caller.
    inflight: Arc<Mutex<()>>,
    attempts: Mutex<(u32, i64)>,
}

impl AuthState {
    /// Trusted maintenance startup: configuration is never persisted and cannot retarget an account.
    pub async fn enable_password_recovery(
        &mut self,
        request_id: &str,
        username: &str,
        code_hash: String,
        expires_at: i64,
    ) -> Result<(), String> {
        if self.password_recovery.is_some() {
            return Err("Password recovery is already configured".into());
        }
        let uuid = uuid::Uuid::parse_str(request_id)
            .map_err(|_| "Recovery request ID must be a canonical UUID".to_owned())?;
        if uuid.is_nil() || uuid.to_string() != request_id {
            return Err("Recovery request ID must be a canonical UUID".into());
        }
        if !(3..=64).contains(&username.len())
            || !username
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        {
            return Err("Recovery username has an invalid format".into());
        }
        if code_hash.len() != 64
            || !code_hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("Recovery code digest has an invalid format".into());
        }
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|_| "Recovery configuration could not be checked".to_owned())?;
        let consumed: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM admin_password_recoveries WHERE request_id=?)",
        )
        .bind(request_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| "Recovery configuration could not be checked".to_owned())?;
        if consumed {
            return Err("Recovery request ID has already been completed".into());
        }
        let user_id: Option<String> = sqlx::query_scalar(
            "SELECT user_id FROM users WHERE username=? AND platform_admin=1 AND password_hash!=''",
        )
        .bind(username)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| "Recovery configuration could not be checked".to_owned())?;
        let user_id = user_id.ok_or_else(|| {
            "Recovery requires an existing credentialed platform administrator".to_owned()
        })?;
        tx.commit()
            .await
            .map_err(|_| "Recovery configuration could not be checked".to_owned())?;
        self.password_recovery = Some(Arc::new(Recovery {
            request_id: request_id.into(),
            user_id,
            username: username.into(),
            code_hash,
            expires_at,
            inflight: Arc::new(Mutex::new(())),
            attempts: Mutex::new((0, 0)),
        }));
        Ok(())
    }

    pub fn password_recovery_enabled(&self) -> bool {
        self.password_recovery.is_some()
    }
}

pub fn password_recovery_router(state: AuthState) -> Router {
    Router::new()
        .route("/api/session/password-recovery", get(status).post(redeem))
        .layer(middleware::from_fn_with_state(state.clone(), gate))
        .with_state(state)
}

// This deliberately does not use session/CSRF middleware: only the independent code
// authorizes recovery, while ordinary routes retain their existing CSRF checks.
async fn gate(
    State(state): State<AuthState>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let headers = request.headers();
    let host_allowed = headers.get_all(header::HOST).iter().count() == 1
        && headers
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .is_some_and(|host| {
                state
                    .config
                    .allowed_hosts
                    .iter()
                    .any(|h| h.eq_ignore_ascii_case(host))
            });
    let origins = headers.get_all(header::ORIGIN).iter().count();
    let origin_allowed = origins == 1
        && headers
            .get(header::ORIGIN)
            .and_then(|h| h.to_str().ok())
            .is_some_and(|origin| state.config.allowed_origins.iter().any(|o| o == origin));
    let mut response = if !host_allowed {
        error(
            StatusCode::FORBIDDEN,
            "HOST_NOT_ALLOWED",
            "Host is not allowed",
        )
    } else if origins > 0 && !origin_allowed {
        error(
            StatusCode::FORBIDDEN,
            "ORIGIN_NOT_ALLOWED",
            "Origin is not allowed",
        )
    } else if request.method() == Method::POST && !origin_allowed {
        error(
            StatusCode::FORBIDDEN,
            "ORIGIN_REQUIRED",
            "Origin is required for recovery",
        )
    } else {
        next.run(request).await
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn failed() -> Response {
    error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "RECOVERY_FAILED",
        "Password recovery failed",
    )
}
fn completed_error() -> Response {
    error(
        StatusCode::CONFLICT,
        "RECOVERY_COMPLETED",
        "Recovery is already completed",
    )
}
fn status_body(recovery: &Recovery, state: AdminRecoveryState) -> Response {
    Json(AdminRecoveryStatus {
        state,
        request_id: Some(recovery.request_id.clone()),
        username: Some(recovery.username.clone()),
    })
    .into_response()
}
async fn completed(state: &AuthState, recovery: &Recovery) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM admin_password_recoveries WHERE request_id=?)")
        .bind(&recovery.request_id)
        .fetch_one(&state.pool)
        .await
}
async fn status(State(state): State<AuthState>) -> Response {
    let Some(recovery) = &state.password_recovery else {
        return Json(AdminRecoveryStatus {
            state: AdminRecoveryState::Disabled,
            request_id: None,
            username: None,
        })
        .into_response();
    };
    // Do not advertise availability while an unknown-result POST is settling.
    let _guard = recovery.inflight.lock().await;
    match completed(&state, recovery).await {
        Ok(true) => status_body(recovery, AdminRecoveryState::Completed),
        Ok(false) => status_body(
            recovery,
            if now() >= recovery.expires_at {
                AdminRecoveryState::Expired
            } else {
                AdminRecoveryState::Available
            },
        ),
        Err(_) => failed(),
    }
}

async fn redeem(
    State(state): State<AuthState>,
    body: Result<Json<AdminRecoveryRequest>, JsonRejection>,
) -> Response {
    let Some(recovery) = state.password_recovery.clone() else {
        return error(
            StatusCode::NOT_FOUND,
            "RECOVERY_DISABLED",
            "Password recovery is disabled",
        );
    };
    // A read owns this gate too; wait fairly rather than treating it as a write.
    let guard = recovery.inflight.clone().lock_owned().await;
    match completed(&state, &recovery).await {
        Ok(true) => return completed_error(),
        Err(_) => return failed(),
        Ok(false) => {}
    }
    let Ok(Json(body)) = body else {
        return error(
            StatusCode::BAD_REQUEST,
            "INVALID_PASSWORD",
            "Invalid recovery request",
        );
    };
    if !(12..=1024).contains(&body.password.len()) {
        return error(
            StatusCode::BAD_REQUEST,
            "INVALID_PASSWORD",
            "Password must contain 12 to 1024 UTF-8 bytes",
        );
    }
    let current = now();
    {
        let mut attempts = recovery.attempts.lock().await;
        if current - attempts.1 >= 60 {
            *attempts = (0, current);
        }
        if attempts.0 >= 8 {
            let mut response = error(
                StatusCode::TOO_MANY_REQUESTS,
                "RECOVERY_RATE_LIMITED",
                "Too many recovery attempts",
            );
            response.headers_mut().insert(
                header::RETRY_AFTER,
                HeaderValue::from_str(&(60 - (current - attempts.1)).max(1).to_string()).unwrap(),
            );
            return response;
        }
        attempts.0 += 1;
    }
    if current >= recovery.expires_at
        || !super::csrf::constant_time_eq(&digest(&body.recovery_code), &recovery.code_hash)
    {
        return error(
            StatusCode::UNAUTHORIZED,
            "INVALID_RECOVERY_CODE",
            "Recovery code is invalid or expired",
        );
    }
    // Disconnecting the client must not release the gate while SQLite may still
    // commit. This task owns the guard until the definitive database outcome.
    tokio::spawn(async move {
        let _guard = guard;
        let hash = match tokio::task::spawn_blocking(move || password::hash(&body.password)).await {
            Ok(Ok(hash)) => hash,
            _ => return failed(),
        };
        if now() >= recovery.expires_at {
            return error(
                StatusCode::UNAUTHORIZED,
                "INVALID_RECOVERY_CODE",
                "Recovery code is invalid or expired",
            );
        }
        match commit(&state, &recovery, &hash).await {
            Ok(()) => status_body(&recovery, AdminRecoveryState::Completed),
            Err(_) => match completed(&state, &recovery).await {
                Ok(true) => completed_error(),
                Ok(false) if now() >= recovery.expires_at => error(
                    StatusCode::UNAUTHORIZED,
                    "INVALID_RECOVERY_CODE",
                    "Recovery code is invalid or expired",
                ),
                _ => failed(),
            },
        }
    })
    .await
    .unwrap_or_else(|_| failed())
}

async fn commit(state: &AuthState, recovery: &Recovery, hash: &str) -> Result<(), sqlx::Error> {
    // The first statement acquires the SQLite writer lock and the PK is the durable
    // single-use guard. A target whose identity/role changed yields no inserted row.
    let mut tx = state.pool.begin().await?;
    let inserted = sqlx::query("INSERT INTO admin_password_recoveries(request_id,user_id,username,completed_at) SELECT ?,user_id,username,? FROM users WHERE user_id=? AND username=? AND platform_admin=1 AND password_hash!='' AND CAST(strftime('%s','now') AS INTEGER) < ?")
        .bind(&recovery.request_id).bind(chrono::Utc::now().to_rfc3339()).bind(&recovery.user_id).bind(&recovery.username).bind(recovery.expires_at).execute(&mut *tx).await?;
    if inserted.rows_affected() != 1 {
        return Err(sqlx::Error::RowNotFound);
    }
    let updated = sqlx::query(
        "UPDATE users SET password_hash=? WHERE user_id=? AND username=? AND platform_admin=1",
    )
    .bind(hash)
    .bind(&recovery.user_id)
    .bind(&recovery.username)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(sqlx::Error::RowNotFound);
    }
    sqlx::query("DELETE FROM sessions WHERE user_id=?")
        .bind(&recovery.user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await
}
