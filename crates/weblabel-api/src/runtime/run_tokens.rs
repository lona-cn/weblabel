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

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rand::RngCore;

/// Bytes of entropy in every issued token.
pub const TOKEN_BYTES: usize = 32;

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
    /// This run has already crossed the native process dispatch boundary.
    AlreadyDispatched,
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
            Self::AlreadyDispatched => "RUN_TOKEN_ALREADY_DISPATCHED",
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
    dispatched: bool,
    observation_pending: bool,
    revocation: tokio::sync::watch::Sender<bool>,
    crop_calls: u32,
    full_image_calls: u32,
    crop_pixels: u64,
}

#[derive(Debug, Default)]
struct TokenState {
    entries: HashMap<String, TokenEntry>,
    revoked_runs: HashSet<String>,
    closed: bool,
}

/// Service-held token table. `Arc<Mutex<..>>` because the store is shared by
/// the HTTP state, run creation and cancellation paths.
#[derive(Debug, Clone, Default)]
pub struct RunTokenStore {
    tokens: Arc<Mutex<TokenState>>,
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
            dispatched: false,
            observation_pending: false,
            revocation: tokio::sync::watch::channel(false).0,
            crop_calls: 0,
            full_image_calls: 0,
            crop_pixels: 0,
        };
        let token = random_token();
        let mut tokens = self.tokens.lock().expect("run token store poisoned");
        let mut entry = entry;
        entry.revoked = tokens.closed
            || tokens.revoked_runs.contains(run_id)
            || tokens.entries.values().any(|prior| {
                prior.run_id == run_id && (prior.revoked || prior.expires_at_ms <= now_ms())
            });
        if entry.revoked {
            entry.revocation.send_replace(true);
        }
        tokens.entries.insert(token.clone(), entry);
        token
    }

    /// Issues once with the authoritative persisted capability expiry, never renewing it.
    pub fn issue_once_until(
        &self,
        run_id: &str,
        project_id: &str,
        expires_at_ms: i64,
    ) -> Option<String> {
        if run_id.is_empty() || project_id.is_empty() {
            return None;
        }
        let mut tokens = self.tokens.lock().expect("run token store poisoned");
        if tokens.closed
            || expires_at_ms <= now_ms()
            || tokens.revoked_runs.contains(run_id)
            || tokens.entries.values().any(|entry| entry.run_id == run_id)
        {
            return None;
        }
        let token = random_token();
        tokens.entries.insert(
            token.clone(),
            TokenEntry {
                run_id: run_id.to_owned(),
                project_id: project_id.to_owned(),
                expires_at_ms,
                revoked: false,
                dispatched: false,
                observation_pending: false,
                revocation: tokio::sync::watch::channel(false).0,
                crop_calls: 0,
                full_image_calls: 0,
                crop_pixels: 0,
            },
        );
        Some(token)
    }

    /// Linearizes native dispatch with revocation. The callback is short and
    /// synchronous: it must neither await nor re-enter this token store.
    pub fn dispatch_if_live<T>(
        &self,
        token: &str,
        dispatch: impl FnOnce() -> T,
    ) -> Result<T, TokenError> {
        let mut tokens = self.tokens.lock().expect("run token store poisoned");
        let entry = tokens.entries.get(token).ok_or(TokenError::Invalid)?;
        if entry.revoked {
            return Err(TokenError::Revoked);
        }
        if entry.expires_at_ms <= now_ms() {
            return Err(TokenError::Expired);
        }
        if tokens
            .entries
            .values()
            .any(|prior| prior.run_id == entry.run_id && prior.dispatched)
        {
            return Err(TokenError::AlreadyDispatched);
        }
        tokens
            .entries
            .get_mut(token)
            .expect("verified token disappeared")
            .dispatched = true;
        Ok(dispatch())
    }

    /// Orders a short synchronous IO admission with revocation. Callers must
    /// actually poll/start IO inside the callback, not return an unpolled future.
    /// The callback must not await, block, or re-enter this store.
    pub fn if_live<T>(&self, token: &str, action: impl FnOnce() -> T) -> Result<T, TokenError> {
        let tokens = self.tokens.lock().expect("run token store poisoned");
        let entry = tokens.entries.get(token).ok_or(TokenError::Invalid)?;
        if entry.revoked {
            return Err(TokenError::Revoked);
        }
        if entry.expires_at_ms <= now_ms() {
            return Err(TokenError::Expired);
        }
        Ok(action())
    }

    /// Tracks a controlled observation until its metadata commit is acknowledged.
    /// Finishing after revocation is allowed; this never grants execution rights.
    pub(crate) fn set_observation_pending(
        &self,
        token: &str,
        pending: bool,
    ) -> Result<(), TokenError> {
        let mut tokens = self.tokens.lock().expect("run token store poisoned");
        let entry = tokens.entries.get_mut(token).ok_or(TokenError::Invalid)?;
        entry.observation_pending = pending;
        Ok(())
    }

    /// Read after writer admission so a failed checkpoint cannot be laundered
    /// into an empty or complete cancellation receipt. Revocation keeps this bit.
    pub(crate) fn observation_pending_for_run(&self, run_id: &str) -> bool {
        self.tokens
            .lock()
            .expect("run token store poisoned")
            .entries
            .values()
            .any(|entry| entry.run_id == run_id && entry.observation_pending)
    }

    /// Polls one owned nonblocking IO future only while its capability is live.
    /// Each IO admission is ordered against revocation under the same mutex;
    /// already-dispatched remote/SQL work cannot be retroactively withdrawn.
    /// The future must not block or re-enter this store from `poll`.
    pub async fn while_live<T>(
        &self,
        token: &str,
        future: impl Future<Output = T>,
    ) -> Result<T, TokenError> {
        let (mut revoked, expires_at_ms) = {
            let tokens = self.tokens.lock().expect("run token store poisoned");
            let entry = tokens.entries.get(token).ok_or(TokenError::Invalid)?;
            if entry.revoked {
                return Err(TokenError::Revoked);
            }
            if entry.expires_at_ms <= now_ms() {
                return Err(TokenError::Expired);
            }
            (entry.revocation.subscribe(), entry.expires_at_ms)
        };
        let remaining = Duration::from_millis(expires_at_ms.saturating_sub(now_ms()).max(0) as u64);
        tokio::pin!(future);
        tokio::select! { biased;
            _ = revoked.changed() => Err(TokenError::Revoked),
            _ = tokio::time::sleep(remaining) => Err(TokenError::Expired),
            result = std::future::poll_fn(|cx| {
                let tokens = self.tokens.lock().expect("run token store poisoned");
                let Some(entry) = tokens.entries.get(token) else { return std::task::Poll::Ready(Err(TokenError::Invalid)); };
                if entry.revoked { return std::task::Poll::Ready(Err(TokenError::Revoked)); }
                if entry.expires_at_ms <= now_ms() { return std::task::Poll::Ready(Err(TokenError::Expired)); }
                future.as_mut().poll(cx).map(Ok)
            }) => result,
        }
    }

    /// Orders irreversible commit admission with revocation, then observes its
    /// outcome without cancelling an already-admitted (possibly durable) write.
    /// Only the first nonblocking poll holds the token mutex; no store re-entry.
    pub async fn admit_if_live<T>(
        &self,
        token: &str,
        future: impl Future<Output = T>,
    ) -> Result<T, TokenError> {
        tokio::pin!(future);
        let first = std::future::poll_fn(|cx| {
            let tokens = self.tokens.lock().expect("run token store poisoned");
            let Some(entry) = tokens.entries.get(token) else {
                return std::task::Poll::Ready(Err(TokenError::Invalid));
            };
            if entry.revoked {
                return std::task::Poll::Ready(Err(TokenError::Revoked));
            }
            if entry.expires_at_ms <= now_ms() {
                return std::task::Poll::Ready(Err(TokenError::Expired));
            }
            std::task::Poll::Ready(Ok(future.as_mut().poll(cx)))
        })
        .await?;
        match first {
            std::task::Poll::Ready(result) => Ok(result),
            std::task::Poll::Pending => Ok(future.await),
        }
    }

    /// Live (unexpired, unrevoked) tokens bound to a run. Observability for the
    /// run lifecycle; never exposes token values.
    pub fn active_tokens_for_run(&self, run_id: &str) -> usize {
        let now = now_ms();
        self.tokens
            .lock()
            .expect("run token store poisoned")
            .entries
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
        let entry = tokens.entries.get(token).ok_or(TokenError::Invalid)?;
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
        match tokens.entries.get_mut(token) {
            Some(entry) => {
                entry.revoked = true;
                entry.revocation.send_replace(true);
                true
            }
            None => false,
        }
    }

    /// Revokes every token issued for a run (user cancellation path).
    pub fn revoke_run(&self, run_id: &str) -> usize {
        let mut tokens = self.tokens.lock().expect("run token store poisoned");
        tokens.revoked_runs.insert(run_id.to_owned());
        let mut revoked = 0;
        for entry in tokens.entries.values_mut() {
            if entry.run_id == run_id && !entry.revoked {
                entry.revoked = true;
                entry.revocation.send_replace(true);
                revoked += 1;
            }
        }
        revoked
    }

    /// Revokes all in-memory capabilities before native shutdown settlement.
    pub fn revoke_all(&self) -> usize {
        let mut tokens = self.tokens.lock().expect("run token store poisoned");
        tokens.closed = true;
        let mut revoked = 0;
        for entry in tokens.entries.values_mut() {
            if !entry.revoked {
                entry.revoked = true;
                entry.revocation.send_replace(true);
                revoked += 1;
            }
        }
        revoked
    }

    /// Charges one full-image read against the token budget.
    pub fn charge_full_image_read(&self, token: &str) -> Result<(), TokenError> {
        let mut tokens = self.tokens.lock().expect("run token store poisoned");
        let entry = tokens.entries.get_mut(token).ok_or(TokenError::Invalid)?;
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
        let entry = tokens.entries.get_mut(token).ok_or(TokenError::Invalid)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shutdown_revokes_capabilities_across_runs_and_projects() {
        let tokens = RunTokenStore::new();
        let first = tokens.issue("run-a", "project-a", Duration::from_secs(60));
        let second = tokens.issue("run-b", "project-b", Duration::from_secs(60));
        assert_eq!(tokens.revoke_all(), 2);
        assert!(matches!(tokens.verify(&first), Err(TokenError::Revoked)));
        assert!(matches!(tokens.verify(&second), Err(TokenError::Revoked)));
        assert!(matches!(
            tokens.charge_crop_read(&second, 1),
            Err(TokenError::Revoked)
        ));
        assert_eq!(tokens.revoke_all(), 0);
    }

    #[test]
    fn cancellation_before_first_issue_cannot_mint_a_native_capability() {
        let tokens = RunTokenStore::new();
        assert_eq!(tokens.revoke_run("cancelled-before-dispatch"), 0);
        assert!(tokens
            .issue_once_until("cancelled-before-dispatch", "project", now_ms() + 60_000)
            .is_none());
    }

    #[test]
    fn cancelled_capability_is_never_reissued_with_a_new_secret_or_expiry() {
        let tokens = RunTokenStore::new();
        let token = tokens
            .issue_once_until("cancelled", "project", now_ms() + 60_000)
            .unwrap();
        assert_eq!(tokens.revoke_run("cancelled"), 1);
        assert_eq!(tokens.verify(&token), Err(TokenError::Revoked));
        assert!(tokens
            .issue_once_until("cancelled", "project", now_ms() + 120_000)
            .is_none());
    }

    #[test]
    fn expired_capability_does_not_create_a_second_execution_right() {
        let tokens = RunTokenStore::new();
        let token = tokens.issue("expired", "project", Duration::ZERO);
        assert_eq!(tokens.verify(&token), Err(TokenError::Expired));
        assert!(tokens
            .issue_once_until("expired", "project", now_ms() + 60_000)
            .is_none());
        let replacement = tokens.issue("expired", "project", Duration::from_secs(60));
        assert!(
            tokens.verify(&replacement).is_err(),
            "the mock seam cannot revive an expired run either"
        );
    }

    #[test]
    fn shutdown_closes_issuance_even_for_runs_without_a_prior_token() {
        let tokens = RunTokenStore::new();
        assert_eq!(tokens.revoke_all(), 0);
        assert!(tokens
            .issue_once_until("not-yet-dispatched", "project", now_ms() + 60_000)
            .is_none());
    }
}
