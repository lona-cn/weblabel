//! Run-scoped bearer tokens for `POST /internal/agent-tools/{tool}` (C5).
//!
//! Tokens are generated and held by the service only. They are short-lived,
//! bound to a single model run (and therefore a single project), and are never
//! accepted in tool arguments, argv or tool output: the MCP child receives its
//! token exclusively through its private environment. Cancelling a run revokes
//! its tokens immediately (`revoke_run`), and `verify` refuses anything that is
//! expired, revoked or unbound.
//!
//! The store also carries the per-token `read_region` budgets (crop calls,
//! full-image reads and crop pixels), so every read is charged exactly once
//! against the token that requested it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rand::RngCore;

/// Bytes of entropy in every issued token.
pub const TOKEN_BYTES: usize = 32;
/// Default lifetime of a run token; runs are bounded by far shorter budgets.
pub const DEFAULT_TOKEN_TTL: Duration = Duration::from_secs(900);

/// Maximum `read_region` crop calls per token.
pub const MAX_CROP_CALLS: u32 = 32;
/// Maximum `read_region` full-image reads per token.
pub const MAX_FULL_IMAGE_CALLS: u32 = 8;
/// Maximum pixels of any single crop.
pub const MAX_CROP_PIXELS_PER_CALL: u64 = 1_048_576;
/// Maximum total crop pixels per token.
pub const MAX_CROP_PIXELS_TOTAL: u64 = 8_388_608;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenError {
    /// No bearer credential was presented at all.
    Required,
    /// The credential is malformed or unknown to this service.
    Invalid,
    /// The token lived past its expiry instant.
    Expired,
    /// The token (or its run) was revoked, e.g. by user cancellation.
    Revoked,
    /// The token is bound to a different project than the run it names.
    ProjectMismatch,
    /// A `read_region` budget is exhausted.
    BudgetExhausted,
}

impl TokenError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::Required => "RUN_TOKEN_REQUIRED",
            Self::Invalid => "RUN_TOKEN_INVALID",
            Self::Expired => "RUN_TOKEN_EXPIRED",
            Self::Revoked => "RUN_TOKEN_REVOKED",
            Self::ProjectMismatch => "RUN_TOKEN_PROJECT_MISMATCH",
            Self::BudgetExhausted => "READ_BUDGET_EXHAUSTED",
        }
    }
}

/// The verified identity behind a run token. Everything else (project scope,
/// asset, ontology, tool permissions) is derived server-side from this run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunTokenGrant {
    pub run_id: String,
    pub project_id: String,
    pub expires_at_ms: i64,
}

#[derive(Debug)]
struct TokenEntry {
    run_id: String,
    project_id: String,
    expires_at_ms: i64,
    revoked: bool,
    crop_calls: u32,
    full_image_calls: u32,
    crop_pixels: u64,
}

/// Service-held token table. `Arc<Mutex<..>>` because the store is shared by
/// the HTTP state, run creation and cancellation paths.
#[derive(Debug, Clone, Default)]
pub struct RunTokenStore {
    tokens: Arc<Mutex<HashMap<String, TokenEntry>>>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

fn random_token() -> String {
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let mut token = String::with_capacity(TOKEN_BYTES * 2);
    for byte in bytes {
        token.push(char::from_digit(u32::from(byte >> 4), 16).unwrap());
        token.push(char::from_digit(u32::from(byte & 15), 16).unwrap());
    }
    token
}

impl RunTokenStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Issues a fresh run-scoped token. `run_id`/`project_id` must come from an
    /// authenticated run record, never from tool arguments.
    pub fn issue(&self, run_id: &str, project_id: &str, ttl: Duration) -> String {
        assert!(!run_id.is_empty(), "run tokens must name a run");
        assert!(!project_id.is_empty(), "run tokens must name a project");
        let ttl_ms = i64::try_from(ttl.as_millis()).unwrap_or(i64::MAX);
        let entry = TokenEntry {
            run_id: run_id.to_owned(),
            project_id: project_id.to_owned(),
            expires_at_ms: now_ms().saturating_add(ttl_ms),
            revoked: false,
            crop_calls: 0,
            full_image_calls: 0,
            crop_pixels: 0,
        };
        let token = random_token();
        self.tokens
            .lock()
            .expect("run token store poisoned")
            .insert(token.clone(), entry);
        token
    }

    /// Issues a token for a run that has none yet, so run start is idempotent
    /// across request replays and crash retries. Returns None when a live token
    /// already exists (budgets are per token, so runs get exactly one).
    pub fn issue_once(&self, run_id: &str, project_id: &str, ttl: Duration) -> Option<String> {
        {
            let tokens = self.tokens.lock().expect("run token store poisoned");
            let now = now_ms();
            if tokens
                .values()
                .any(|entry| entry.run_id == run_id && !entry.revoked && entry.expires_at_ms > now)
            {
                return None;
            }
        }
        Some(self.issue(run_id, project_id, ttl))
    }

    /// Live (unexpired, unrevoked) tokens bound to a run. Observability for the
    /// run lifecycle; never exposes token values.
    pub fn active_tokens_for_run(&self, run_id: &str) -> usize {
        let now = now_ms();
        self.tokens
            .lock()
            .expect("run token store poisoned")
            .values()
            .filter(|entry| entry.run_id == run_id && !entry.revoked && entry.expires_at_ms > now)
            .count()
    }

    /// Resolves a bearer token to its run binding, rejecting expired and
    /// revoked tokens.
    pub fn verify(&self, token: &str) -> Result<RunTokenGrant, TokenError> {
        if token.is_empty() || token.len() != TOKEN_BYTES * 2 {
            return Err(TokenError::Invalid);
        }
        let tokens = self.tokens.lock().expect("run token store poisoned");
        let entry = tokens.get(token).ok_or(TokenError::Invalid)?;
        if entry.revoked {
            return Err(TokenError::Revoked);
        }
        if now_ms() >= entry.expires_at_ms {
            return Err(TokenError::Expired);
        }
        Ok(RunTokenGrant {
            run_id: entry.run_id.clone(),
            project_id: entry.project_id.clone(),
            expires_at_ms: entry.expires_at_ms,
        })
    }

    /// Revokes a single token immediately.
    pub fn revoke(&self, token: &str) -> bool {
        let mut tokens = self.tokens.lock().expect("run token store poisoned");
        match tokens.get_mut(token) {
            Some(entry) => {
                entry.revoked = true;
                true
            }
            None => false,
        }
    }

    /// Revokes every token issued for a run (user cancellation path).
    pub fn revoke_run(&self, run_id: &str) -> usize {
        let mut tokens = self.tokens.lock().expect("run token store poisoned");
        let mut revoked = 0;
        for entry in tokens.values_mut() {
            if entry.run_id == run_id && !entry.revoked {
                entry.revoked = true;
                revoked += 1;
            }
        }
        revoked
    }

    /// Charges one full-image read against the token budget.
    pub fn charge_full_image_read(&self, token: &str) -> Result<(), TokenError> {
        let mut tokens = self.tokens.lock().expect("run token store poisoned");
        let entry = tokens.get_mut(token).ok_or(TokenError::Invalid)?;
        if entry.revoked {
            return Err(TokenError::Revoked);
        }
        if now_ms() >= entry.expires_at_ms {
            return Err(TokenError::Expired);
        }
        if entry.full_image_calls >= MAX_FULL_IMAGE_CALLS {
            return Err(TokenError::BudgetExhausted);
        }
        entry.full_image_calls += 1;
        Ok(())
    }

    /// Charges one crop of `pixels` pixels against the token budgets.
    pub fn charge_crop_read(&self, token: &str, pixels: u64) -> Result<(), TokenError> {
        let mut tokens = self.tokens.lock().expect("run token store poisoned");
        let entry = tokens.get_mut(token).ok_or(TokenError::Invalid)?;
        if entry.revoked {
            return Err(TokenError::Revoked);
        }
        if now_ms() >= entry.expires_at_ms {
            return Err(TokenError::Expired);
        }
        if pixels > MAX_CROP_PIXELS_PER_CALL
            || entry.crop_calls >= MAX_CROP_CALLS
            || entry.crop_pixels.saturating_add(pixels) > MAX_CROP_PIXELS_TOTAL
        {
            return Err(TokenError::BudgetExhausted);
        }
        entry.crop_calls += 1;
        entry.crop_pixels += pixels;
        Ok(())
    }
}
