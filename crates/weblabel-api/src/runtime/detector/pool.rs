use super::{DetectorError, WorkerRequest, WorkerResult, MAX_FRAME};
use crate::runtime::{
    host::{spawn_native, HostConfig, NativeProcess},
    parse_envelope,
    run_tokens::RunTokenStore,
    EnvelopeKind, EnvelopeMethod, RuntimeEnvelope,
};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{Notify, Semaphore},
    time::Instant,
};

#[derive(Clone, Default)]
pub struct Cancellation {
    inner: Arc<CancelState>,
}
#[derive(Default)]
struct CancelState {
    cancelled: AtomicBool,
    notify: Notify,
}
impl Cancellation {
    pub fn cancel(&self) {
        self.inner.cancelled.store(true, Ordering::Release);
        self.inner.notify.notify_waiters();
    }
    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::Acquire)
    }
    async fn wait(&self) {
        loop {
            let wake = self.inner.notify.notified();
            tokio::pin!(wake);
            wake.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            wake.await;
        }
    }
}
/// Share ONE instance across all detector profiles, not one per run/provider profile.
pub struct DetectorPool {
    executable: PathBuf,
    active: Semaphore,
    waiting: Semaphore,
    poisoned: Arc<AtomicBool>,
    shutdown: Cancellation,
}
impl DetectorPool {
    pub const DEFAULT_PENDING: usize = 8;
    pub fn new(current_product_exe: PathBuf, capacity: usize) -> Result<Self, DetectorError> {
        if !current_product_exe.is_absolute() || !(1..=1024).contains(&capacity) {
            return Err(DetectorError::new(
                "needs_configuration",
                "trusted product executable and bounded queue required",
            ));
        }
        Ok(Self {
            executable: current_product_exe,
            active: Semaphore::new(1),
            waiting: Semaphore::new(capacity),
            poisoned: Arc::new(AtomicBool::new(false)),
            shutdown: Cancellation::default(),
        })
    }
    pub async fn execute(
        &self,
        request: WorkerRequest,
        cancel: Cancellation,
    ) -> Result<WorkerResult, DetectorError> {
        self.execute_inner(request, cancel, None).await
    }
    /// Product-only dispatch: atomic capability consumption and native spawn share
    /// the token store's mutex. Offline numerical controls have no repository grant.
    pub async fn execute_authorized(
        &self,
        request: WorkerRequest,
        cancel: Cancellation,
        tokens: &RunTokenStore,
        token: &str,
    ) -> Result<WorkerResult, DetectorError> {
        let grant = tokens.verify(token).map_err(|e| {
            DetectorError::new(e.code(), "detector dispatch capability is not live")
        })?;
        if grant.run_id != request.run_id {
            return Err(DetectorError::new(
                "RUN_TOKEN_RUN_MISMATCH",
                "detector token belongs to another run",
            ));
        }
        self.execute_inner(request, cancel, Some((tokens, token)))
            .await
    }
    async fn execute_inner(
        &self,
        request: WorkerRequest,
        cancel: Cancellation,
        authorization: Option<(&RunTokenStore, &str)>,
    ) -> Result<WorkerResult, DetectorError> {
        if self.poisoned.load(Ordering::Acquire) {
            return Err(DetectorError::new(
                "worker_cleanup_failed",
                "detector admission stopped after incomplete tree reclamation",
            ));
        }
        if cancel.is_cancelled() || self.shutdown.is_cancelled() {
            return Err(cancelled());
        }
        if request.timeout_ms == 0 {
            return Err(DetectorError::new(
                "invalid_request",
                "positive deadline required",
            ));
        }
        let deadline = Instant::now()
            .checked_add(Duration::from_millis(request.timeout_ms))
            .ok_or_else(|| DetectorError::new("invalid_request", "deadline out of range"))?;
        // Active work does not consume a waiting slot. Waiting permits are immediately
        // released on cancellation/deadline, with no detached inference future.
        let active = match self.active.try_acquire() {
            Ok(permit) => permit,
            Err(_) => {
                let waiting = self.waiting.try_acquire().map_err(|_| {
                    DetectorError::new("queue_full", "detector pending queue is full")
                })?;
                let active = tokio::select! {biased;_=self.shutdown.wait()=>return Err(cancelled()),_=cancel.wait()=>return Err(cancelled()),_=tokio::time::sleep_until(deadline)=>return Err(timed_out()),permit=self.active.acquire()=>permit.map_err(|_|cancelled())?};
                drop(waiting);
                active
            }
        };
        if cancel.is_cancelled() || self.shutdown.is_cancelled() {
            return Err(cancelled());
        }
        if self.poisoned.load(Ordering::Acquire) {
            return Err(DetectorError::new(
                "worker_cleanup_failed",
                "detector admission stopped after incomplete tree reclamation",
            ));
        }
        if Instant::now() >= deadline {
            return Err(timed_out());
        }
        let envelope = RuntimeEnvelope::request(
            &request.run_id,
            EnvelopeMethod::StartRun,
            serde_json::to_value(&request).map_err(|_| protocol())?,
        );
        let line = envelope.to_line().map_err(|_| protocol())?;
        let mut environment = BTreeMap::from([
            (
                "TEMP".into(),
                request.artifact_root.to_string_lossy().into_owned(),
            ),
            (
                "TMP".into(),
                request.artifact_root.to_string_lossy().into_owned(),
            ),
            (
                "TMPDIR".into(),
                request.artifact_root.to_string_lossy().into_owned(),
            ),
        ]);
        if let Ok(root) = std::env::var("SystemRoot") {
            environment.insert("SystemRoot".into(), root);
        }
        let host = HostConfig {
            executable: self.executable.clone(),
            argv: vec!["detector-worker".into()],
            cwd: request.artifact_root.clone(),
            allowed_env: environment.keys().cloned().collect(),
            source_env: BTreeMap::new(),
            extra_env: environment,
            trusted_executable_roots: vec![self
                .executable
                .parent()
                .ok_or_else(protocol)?
                .to_path_buf()],
            trusted_cwd_roots: vec![request.artifact_root.clone()],
        };
        let spawn = || spawn_native(&host);
        let native = match authorization {
            Some((tokens, token)) => tokens.dispatch_if_live(token, spawn).map_err(|e| {
                DetectorError::new(e.code(), "detector dispatch capability is not live")
            })?,
            None => spawn(),
        }
        .map_err(|_| {
            DetectorError::new(
                "worker_spawn_failed",
                "cannot start contained native product worker",
            )
        })?;
        let mut guard = OwnedWorker {
            native,
            reclaimed: false,
            poisoned: Arc::clone(&self.poisoned),
        };
        let mut stdin = guard.native.child.stdin.take().ok_or_else(protocol)?;
        let mut stdout = guard.native.child.stdout.take().ok_or_else(protocol)?;
        let mut stderr = guard.native.child.stderr.take().ok_or_else(protocol)?;
        let exchange = async {
            let write = async {
                stdin.write_all(line.as_bytes()).await?;
                stdin.write_all(b"\n").await?;
                stdin.shutdown().await?;
                drop(stdin);
                Ok::<(), std::io::Error>(())
            };
            // Count bytes even after the capture limit: a log flood is an error, not an unbounded drain.
            let read = async {
                let mut output = Vec::new();
                (&mut stdout)
                    .take((MAX_FRAME + 3) as u64)
                    .read_to_end(&mut output)
                    .await?;
                if output.len() > MAX_FRAME + 2 {
                    return Err(protocol());
                }
                Ok(output)
            };
            let logs = async {
                let mut total = 0usize;
                let mut buffer = [0u8; 4096];
                loop {
                    let count = stderr.read(&mut buffer).await?;
                    if count == 0 {
                        break;
                    }
                    total += count;
                    if total > 64 * 1024 {
                        return Err(DetectorError::new(
                            "worker_output_limit",
                            "worker stderr budget exceeded",
                        ));
                    }
                }
                Ok::<(), DetectorError>(())
            };
            let (_, output, _) = tokio::try_join!(
                async { write.await.map_err(DetectorError::from) },
                read,
                logs
            )?;
            let status = guard.native.child.wait().await?;
            if !status.success() {
                return Err(DetectorError::new(
                    "worker_failed",
                    "native detector worker exited unsuccessfully",
                ));
            }
            let mut reader = std::io::Cursor::new(output);
            let frame = super::read_frame(&mut reader)?.ok_or_else(protocol)?;
            if reader.position() != reader.get_ref().len() as u64 {
                return Err(protocol());
            }
            let response = parse_envelope(std::str::from_utf8(&frame).map_err(|_| protocol())?)
                .map_err(|_| protocol())?;
            if response.id != request.run_id
                || response.kind != EnvelopeKind::Response
                || response.method != EnvelopeMethod::StartRun
            {
                return Err(protocol());
            }
            if let Some(error) = response.payload.get("error") {
                return Err(serde_json::from_value(error.clone()).map_err(|_| protocol())?);
            }
            let result: WorkerResult = serde_json::from_value(
                response.payload.get("result").ok_or_else(protocol)?.clone(),
            )
            .map_err(|_| protocol())?;
            if result.run_id != request.run_id
                || result.receipt.run_id != request.run_id
                || result.projection != request.projection
                || result.region != request.region
            {
                return Err(protocol());
            }
            Ok(result)
        };
        let result = tokio::select! {biased;_=self.shutdown.wait()=>Err(cancelled()),_=cancel.wait()=>Err(cancelled()),_=tokio::time::sleep_until(deadline)=>Err(timed_out()),result=exchange=>result};
        // Owned NativeProcess proves Job ActiveProcesses==0 before the active permit
        // is released. Unexpected Future drop closes its kill-on-close Job and poisons admission.
        let reclaimed = guard.reclaim().await;
        drop(active);
        reclaimed?;
        if cancel.is_cancelled() || self.shutdown.is_cancelled() {
            return Err(cancelled());
        }
        if Instant::now() >= deadline {
            return Err(timed_out());
        }
        result
    }
    /// Stop admission, cancel queued/active work, and await owned-tree cleanup.
    pub async fn shutdown(&self) -> Result<(), DetectorError> {
        self.shutdown.cancel();
        self.waiting.close();
        let _idle = self.active.acquire().await.map_err(|_| cancelled())?;
        if self.poisoned.load(Ordering::Acquire) {
            return Err(DetectorError::new(
                "worker_cleanup_failed",
                "detector tree cleanup incomplete",
            ));
        }
        Ok(())
    }
}
fn protocol() -> DetectorError {
    DetectorError::new("worker_protocol", "invalid native detector response")
}
fn cancelled() -> DetectorError {
    DetectorError::new(
        "cancelled",
        "detector request cancelled; late output quarantined",
    )
}
fn timed_out() -> DetectorError {
    DetectorError::new("detector_timeout", "detector parent deadline exceeded")
}
struct OwnedWorker {
    native: NativeProcess,
    reclaimed: bool,
    poisoned: Arc<AtomicBool>,
}
impl OwnedWorker {
    async fn reclaim(&mut self) -> Result<(), DetectorError> {
        if self.native.reclaim().await.is_err() {
            self.poisoned.store(true, Ordering::Release);
            return Err(DetectorError::new(
                "worker_cleanup_failed",
                "native detector containment could not prove an empty process tree",
            ));
        }
        self.reclaimed = true;
        Ok(())
    }
}
impl Drop for OwnedWorker {
    fn drop(&mut self) {
        if !self.reclaimed {
            // NativeProcess owns the only containment handle; its Drop closes the
            // KILL_ON_JOB_CLOSE Job immediately. Without an explicit ActiveProcesses0
            // receipt, do not admit another inference or claim cleanup was verified.
            self.poisoned.store(true, Ordering::Release);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{future::Future, task::Poll};
    fn request() -> WorkerRequest {
        let root =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/test-artifacts/R05");
        WorkerRequest {
            run_id: "synthetic-queue-control".into(),
            artifact_root: root.clone(),
            lock_path: root.join("absent-lock"),
            model_dir: root.clone(),
            runtime_library: root.join("absent-runtime"),
            runtime_sha256: "0".repeat(64),
            label_map_path: root.join("absent-map"),
            input: super::super::WorkerInput::Tensor {
                path: root.join("absent-input"),
                sha256: "0".repeat(64),
            },
            projection: super::super::Projection {
                width: 1,
                height: 1,
                canonical_width: 1,
                canonical_height: 1,
                transform_to_canonical: [1., 0., 0., 0., 1., 0., 0., 0., 1.],
            },
            region: None,
            timeout_ms: 1000,
            budget_ticket: None,
            return_raw: false,
        }
    }
    #[tokio::test]
    async fn queued_cancellation_releases_slot_and_never_spawns() {
        let pool = DetectorPool::new(std::env::current_exe().unwrap(), 1).unwrap();
        // Hold the active permit rather than faking a native model or sleeping process.
        let active = pool.active.acquire().await.unwrap();
        let cancellation = Cancellation::default();
        let pending = pool.execute(request(), cancellation.clone());
        tokio::pin!(pending);
        std::future::poll_fn(|cx| {
            assert!(pending.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        assert_eq!(
            pool.execute(request(), Cancellation::default())
                .await
                .unwrap_err()
                .code,
            "queue_full"
        );
        cancellation.cancel();
        assert_eq!(pending.await.unwrap_err().code, "cancelled");
        assert_eq!(pool.waiting.available_permits(), 1);
        drop(active);
    }
    #[tokio::test]
    async fn queued_parent_deadline_expires_without_spawning() {
        let pool = DetectorPool::new(std::env::current_exe().unwrap(), 1).unwrap();
        let active = pool.active.acquire().await.unwrap();
        let mut input = request();
        input.timeout_ms = 1;
        assert_eq!(
            pool.execute(input, Cancellation::default())
                .await
                .unwrap_err()
                .code,
            "detector_timeout"
        );
        assert_eq!(pool.waiting.available_permits(), 1);
        drop(active);
    }
    #[tokio::test]
    async fn pre_cancelled_request_never_opens_files_or_spawns() {
        let pool = DetectorPool::new(std::env::current_exe().unwrap(), 1).unwrap();
        let cancel = Cancellation::default();
        cancel.cancel();
        assert_eq!(
            pool.execute(request(), cancel).await.unwrap_err().code,
            "cancelled"
        );
    }
    #[tokio::test]
    async fn revoked_product_capability_cannot_spawn_a_native_worker() {
        let pool = DetectorPool::new(std::env::current_exe().unwrap(), 1).unwrap();
        let tokens = RunTokenStore::new();
        let input = request();
        let token = tokens.issue(&input.run_id, "synthetic-project", Duration::from_secs(60));
        tokens.revoke(&token);
        assert_eq!(
            pool.execute_authorized(input, Cancellation::default(), &tokens, &token)
                .await
                .unwrap_err()
                .code,
            "RUN_TOKEN_REVOKED"
        );
        assert_eq!(pool.active.available_permits(), 1);
    }
    #[tokio::test]
    async fn product_capability_cannot_dispatch_another_run() {
        let pool = DetectorPool::new(std::env::current_exe().unwrap(), 1).unwrap();
        let tokens = RunTokenStore::new();
        let token = tokens.issue(
            "different-run",
            "synthetic-project",
            Duration::from_secs(60),
        );
        assert_eq!(
            pool.execute_authorized(request(), Cancellation::default(), &tokens, &token)
                .await
                .unwrap_err()
                .code,
            "RUN_TOKEN_RUN_MISMATCH"
        );
        assert_eq!(pool.active.available_permits(), 1);
    }
}
