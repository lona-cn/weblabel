//! Concrete native provider composition. No Host loader or provider registry.
use super::{
    config::RuntimeConfig,
    detector::{self, DetectorPool},
    providers::{claude, http::HttpRunner},
    run_tokens::RunTokenStore,
};
use crate::{
    jobs::model_jobs::{RunDriver, RunOutcome, RunRunner, RunnerError},
    storage::Repository,
};
use annotation_domain::ProviderId;
use std::{
    future::Future,
    net::SocketAddr,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
    time::Duration,
};

struct Configured {
    repository: Repository,
    api_address: SocketAddr,
    configuration: Arc<RuntimeConfig>,
    timeout: Duration,
    http: Option<Result<HttpRunner, RunnerError>>,
    detector: Option<Result<DetectorPool, RunnerError>>,
    claude_root: Option<Result<PathBuf, RunnerError>>,
}
pub struct ProductionRunner {
    tokens: RunTokenStore,
    configured: Option<Configured>,
}
fn unavailable() -> RunnerError {
    RunnerError::new(
        "RUNTIME_CONFIGURATION_UNAVAILABLE",
        "Native execution is not configured; manual annotation remains available",
    )
}
impl ProductionRunner {
    pub fn new(
        repository: Repository,
        api_addr: SocketAddr,
        private_config_path: &Path,
        allowed_secret_env: &[String],
        tokens: RunTokenStore,
        timeout: Duration,
    ) -> Result<Self, RunnerError> {
        let configuration = Arc::new(
            RuntimeConfig::load(private_config_path, allowed_secret_env)
                .map_err(|_| unavailable())?,
        );
        let timeout = timeout.min(Duration::from_millis(configuration.timeout_ms));
        let (mut has_http, mut has_claude, mut has_detector) = (false, false, false);
        for provider in configuration.providers() {
            match provider.provider.as_str() {
                "openai_api" | "anthropic_api" | "mimo_api" => has_http = true,
                "claude_local" => has_claude = true,
                "detector_local" => has_detector = true,
                _ => unreachable!("RuntimeConfig validates the fixed provider set"),
            }
        }
        let http = has_http.then(|| {
            HttpRunner::new(
                repository.clone(),
                Arc::clone(&configuration),
                tokens.clone(),
                timeout,
            )
        });
        let detector = has_detector.then(|| {
            let executable = std::env::current_exe().map_err(|_| {
                RunnerError::new(
                    "NATIVE_EXECUTABLE_UNAVAILABLE",
                    "Product executable identity is unavailable",
                )
            })?;
            DetectorPool::new(executable, DetectorPool::DEFAULT_PENDING).map_err(|error| {
                RunnerError::new(&error.code, "Native detector admission is unavailable")
            })
        });
        let claude_root = has_claude.then(|| {
            let parent = repository.object_store().root().parent().ok_or_else(|| {
                RunnerError::new(
                    "NATIVE_RUNTIME_DIRECTORY_UNAVAILABLE",
                    "Private native runtime directory is unavailable",
                )
            })?;
            private_root(&parent.join(".runtime-claude"))
        });
        Ok(Self {
            tokens,
            configured: Some(Configured {
                repository,
                api_address: api_addr,
                configuration,
                timeout,
                http,
                detector,
                claude_root,
            }),
        })
    }

    pub fn unconfigured(tokens: RunTokenStore) -> Self {
        Self {
            tokens,
            configured: None,
        }
    }
    pub(crate) fn configuration(&self) -> Option<&Arc<RuntimeConfig>> {
        self.configured
            .as_ref()
            .map(|configured| &configured.configuration)
    }

    pub async fn shutdown(&self) -> Result<(), RunnerError> {
        if let Some(Ok(pool)) = self
            .configured
            .as_ref()
            .and_then(|configured| configured.detector.as_ref())
        {
            pool.shutdown().await.map_err(|error| {
                RunnerError::new(&error.code, "Native detector cleanup was not proved")
            })?;
        }
        Ok(())
    }

    /// Without a configured native child executor zero is known; otherwise use
    /// individual task cleanup receipts instead of inventing a global count.
    pub fn shutdown_child_count(&self) -> Option<u64> {
        if self.configured.as_ref().is_some_and(|configured| {
            configured.detector.is_some() || configured.claude_root.is_some()
        }) {
            None
        } else {
            Some(0)
        }
    }
}
impl RunRunner for ProductionRunner {
    fn execute<'a>(
        &'a self,
        driver: &'a RunDriver,
    ) -> Pin<Box<dyn Future<Output = Result<RunOutcome, RunnerError>> + Send + 'a>> {
        Box::pin(async move {
            let Some(configured) = &self.configured else {
                self.tokens.revoke_run(driver.run_id());
                return Err(unavailable());
            };
            match driver.profile().provider_id {
                ProviderId::OpenaiApi | ProviderId::AnthropicApi | ProviderId::MimoApi => {
                    let http = configured
                        .http
                        .as_ref()
                        .ok_or_else(unavailable)?
                        .as_ref()
                        .map_err(Clone::clone)?;
                    http.run(driver).await
                }
                ProviderId::ClaudeLocal => {
                    let root = configured
                        .claude_root
                        .as_ref()
                        .ok_or_else(unavailable)?
                        .as_ref()
                        .map_err(Clone::clone)?;
                    let configuration = configured
                        .configuration
                        .selected("claude_local", &driver.profile().profile_id)
                        .map_err(|_| unavailable())?;
                    claude::execute(
                        driver,
                        &configured.repository,
                        &self.tokens,
                        configured.api_address,
                        configuration,
                        root,
                        configured.timeout,
                    )
                    .await
                }
                ProviderId::DetectorLocal => {
                    let pool = configured
                        .detector
                        .as_ref()
                        .ok_or_else(unavailable)?
                        .as_ref()
                        .map_err(Clone::clone)?;
                    detector::execute(
                        &configured.repository,
                        &self.tokens,
                        &configured.configuration,
                        pool,
                        configured.timeout,
                        driver,
                    )
                    .await
                }
                ProviderId::CodexLocal => Err(RunnerError::new(
                    "PROVIDER_RETIRED",
                    "Codex is retained only in historical records",
                )),
                ProviderId::Mock => Err(RunnerError::new(
                    "MOCK_RUNNER_DISABLED",
                    "Mock execution is not a native provider",
                )),
            }
        })
    }
}

fn private_root(path: &Path) -> Result<PathBuf, RunnerError> {
    let failure = || {
        RunnerError::new(
            "NATIVE_RUNTIME_DIRECTORY_UNAVAILABLE",
            "Private native runtime directory is unavailable",
        )
    };
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = std::fs::DirBuilder::new();
        builder.mode(0o700);
        builder
    };
    #[cfg(not(unix))]
    let builder = std::fs::DirBuilder::new();
    match builder.create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(failure()),
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|_| failure())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(failure());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(failure());
        }
    }
    let actual = path.canonicalize().map_err(|_| failure())?;
    let parent = path
        .parent()
        .ok_or_else(failure)?
        .canonicalize()
        .map_err(|_| failure())?;
    if !actual.starts_with(parent) {
        return Err(failure());
    }
    Ok(actual)
}
