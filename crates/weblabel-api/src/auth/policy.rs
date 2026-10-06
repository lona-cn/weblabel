use std::{
    net::SocketAddr,
    sync::{atomic::AtomicBool, Arc},
    time::Duration,
};

use axum::{
    body::Body,
    http::{header, Request, StatusCode},
};
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

pub(crate) use super::csrf::hash as csrf_hash;
use super::error;

#[derive(Clone)]
pub struct AuthConfig {
    pub bind: SocketAddr,
    pub cookie_secure: bool,
    pub allowed_origins: Vec<String>,
    pub allowed_hosts: Vec<String>,
    /// SHA-256 digest of the one-time launch code. Never store or log the code here.
    pub launch_code: String,
    pub launch_code_expires_at: i64,
}
#[derive(Clone)]
pub struct AuthState {
    pub pool: SqlitePool,
    pub config: AuthConfig,
    pub(crate) bootstrap_consumed: Arc<AtomicBool>,
    pub(crate) restore_bootstrap_enabled: Arc<AtomicBool>,
    pub(crate) login_limiter: Arc<tokio::sync::Mutex<LoginLimiter>>,
    pub(crate) dummy_password_hash: String,
}

#[derive(Default)]
pub(crate) struct LoginLimiter {
    known_usernames: std::collections::HashMap<String, (u32, i64)>,
    unknown_usernames: std::collections::HashMap<String, (u32, i64)>,
    global_known: (u32, i64),
    global_unknown: (u32, i64),
}

impl LoginLimiter {
    pub(crate) fn allow(
        &mut self,
        username: &str,
        account_exists: bool,
        current_time: i64,
    ) -> bool {
        const WINDOW_SECONDS: i64 = 60;
        const MAX_PER_USERNAME: u32 = 8;
        const MAX_GLOBAL_PER_WINDOW: u32 = 1024;
        const MAX_TRACKED_USERNAMES: usize = 512;

        self.known_usernames
            .retain(|_, (_, started)| current_time - *started < WINDOW_SECONDS);
        self.unknown_usernames
            .retain(|_, (_, started)| current_time - *started < WINDOW_SECONDS);
        let (usernames, global) = if account_exists {
            (&mut self.known_usernames, &mut self.global_known)
        } else {
            (&mut self.unknown_usernames, &mut self.global_unknown)
        };
        if usernames.get(username).is_some_and(|(count, started)| {
            current_time - *started < WINDOW_SECONDS && *count >= MAX_PER_USERNAME
        }) {
            return false;
        }
        if current_time - global.1 >= WINDOW_SECONDS {
            *global = (0, current_time);
        }
        if global.0 >= MAX_GLOBAL_PER_WINDOW {
            return false;
        }
        global.0 += 1;

        if let Some(attempts) = usernames.get_mut(username) {
            if current_time - attempts.1 >= WINDOW_SECONDS {
                *attempts = (0, current_time);
            }
            attempts.0 += 1;
        } else if usernames.len() < MAX_TRACKED_USERNAMES {
            usernames.insert(username.to_owned(), (1, current_time));
        }
        true
    }

    pub(crate) fn clear(&mut self, username: &str) {
        self.known_usernames.remove(username);
        self.unknown_usernames.remove(username);
    }
}

impl AuthState {
    pub fn new(pool: SqlitePool, config: AuthConfig) -> Result<Self, argon2::password_hash::Error> {
        Ok(Self {
            pool,
            config,
            bootstrap_consumed: Arc::new(AtomicBool::new(false)),
            restore_bootstrap_enabled: Arc::new(AtomicBool::new(false)),
            login_limiter: Arc::new(tokio::sync::Mutex::new(LoginLimiter::default())),
            dummy_password_hash: super::password::hash("nonexistent-account-password")?,
        })
    }

    /// Trusted local restore startup only; never resets any surviving credential or session.
    pub async fn enable_restore_bootstrap(&self) -> Result<bool, sqlx::Error> {
        let eligible: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users) AND NOT EXISTS(SELECT 1 FROM users WHERE password_hash != '') AND NOT EXISTS(SELECT 1 FROM sessions)")
            .fetch_one(&self.pool).await?;
        self.restore_bootstrap_enabled
            .store(eligible, std::sync::atomic::Ordering::Release);
        Ok(eligible)
    }
}

#[derive(Clone, Debug)]
pub struct Principal {
    pub user_id: String,
    pub username: String,
    pub platform_admin: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Role {
    Admin,
    Annotator,
    Reviewer,
    Viewer,
}

impl Role {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "admin" => Some(Self::Admin),
            "annotator" => Some(Self::Annotator),
            "reviewer" => Some(Self::Reviewer),
            "viewer" => Some(Self::Viewer),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Admin => "admin",
            Self::Annotator => "annotator",
            Self::Reviewer => "reviewer",
            Self::Viewer => "viewer",
        }
    }
    pub fn can_write(self) -> bool {
        matches!(self, Self::Admin | Self::Annotator)
    }
}
pub fn hash_launch_code(code: &str) -> String {
    digest(code)
}
pub fn verify_launch_code(code: &str, hash: &str, expires_at: i64, current_time: i64) -> bool {
    current_time <= expires_at && super::csrf::constant_time_eq(&digest(code), hash)
}
pub(crate) fn random_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub(crate) fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
pub(crate) fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

pub(crate) fn check_host_and_origin(
    state: &AuthState,
    request: &Request<Body>,
) -> Option<axum::response::Response> {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !state
        .config
        .allowed_hosts
        .iter()
        .any(|expected| expected.eq_ignore_ascii_case(host))
    {
        return Some(error(
            StatusCode::FORBIDDEN,
            "HOST_NOT_ALLOWED",
            "Host is not allowed",
        ));
    }
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok());
    if let Some(origin) = origin {
        if !state
            .config
            .allowed_origins
            .iter()
            .any(|expected| expected == origin)
        {
            return Some(error(
                StatusCode::FORBIDDEN,
                "ORIGIN_NOT_ALLOWED",
                "Origin is not allowed",
            ));
        }
    }
    None
}

pub(crate) fn check_request(
    state: &AuthState,
    request: &Request<Body>,
) -> Option<axum::response::Response> {
    if let Some(response) = check_host_and_origin(state, request) {
        return Some(response);
    }
    if request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .is_none()
        && !matches!(request.method().as_str(), "GET" | "HEAD" | "OPTIONS")
        && request
            .headers()
            .get(header::COOKIE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value
                    .split(';')
                    .any(|part| part.trim().starts_with("weblabel_session="))
            })
    {
        return Some(error(
            StatusCode::FORBIDDEN,
            "ORIGIN_REQUIRED",
            "Origin is required for session writes",
        ));
    }
    None
}

pub(crate) fn cookie(token: &str, state: &AuthState, max_age: u64) -> String {
    format!(
        "weblabel_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{}",
        if state.config.cookie_secure {
            "; Secure"
        } else {
            ""
        }
    )
}

pub(crate) fn duration() -> Duration {
    Duration::from_secs(60 * 60 * 12)
}

#[cfg(test)]
mod tests {
    use super::LoginLimiter;

    #[test]
    fn full_known_account_table_keeps_limits_without_rejecting_new_names() {
        let mut limiter = LoginLimiter::default();
        for index in 0..512 {
            assert!(limiter.allow(&format!("account-{index}"), true, 100));
        }
        assert_eq!(limiter.known_usernames.len(), 512);
        for _ in 1..8 {
            assert!(limiter.allow("account-0", true, 100));
        }
        assert!(!limiter.allow("account-0", true, 100));
        assert_eq!(limiter.global_known.0, 519);
        assert!(limiter.allow("new-account", true, 100));
        assert_eq!(limiter.known_usernames.len(), 512);
        assert!(limiter.allow("account-0", true, 160));
    }

    #[test]
    fn unknown_username_spray_cannot_consume_known_account_capacity() {
        let mut limiter = LoginLimiter::default();
        for index in 0..1024 {
            assert!(limiter.allow(&format!("unknown-{index}"), false, 100));
        }
        assert_eq!(limiter.unknown_usernames.len(), 512);
        assert!(!limiter.allow("unknown-over-limit", false, 100));
        for attempt in 0..8 {
            assert!(
                limiter.allow("known-account", true, 100),
                "attempt {attempt}"
            );
        }
        assert!(!limiter.allow("known-account", true, 100));
    }

    #[test]
    fn global_login_limits_are_partitioned_and_roll_over_after_a_minute() {
        let mut limiter = LoginLimiter::default();
        for index in 0..1024 {
            assert!(limiter.allow(&format!("known-{index}"), true, 100));
        }
        assert!(!limiter.allow("known-over-limit", true, 100));
        assert!(limiter.allow("unknown-account", false, 100));
        assert!(limiter.allow("known-after-window", true, 160));
    }
}
