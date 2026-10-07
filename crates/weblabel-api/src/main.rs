use std::{env, net::SocketAddr, path::PathBuf, time::Duration};

use rand::{rngs::OsRng, RngCore};
use weblabel_api::{
    auth::{hash_launch_code, AuthConfig},
    config::ServerConfig,
    router, AppState,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "linux")]
    {
        use weblabel_api::runtime::supervisor::linux_broker;
        let mut args = env::args_os().skip(1);
        if args.next().is_some_and(|arg| arg == linux_broker::MODE) {
            let code = match linux_broker::run(args) {
                Ok(code) => code,
                Err(error) => {
                    eprintln!("runtime broker: {error}");
                    125
                }
            };
            std::process::exit(code);
        }
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run())
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let defaults = ServerConfig::default();
    let config = ServerConfig {
        bind: env::var("WEBLABEL_BIND")
            .ok()
            .map(|value| value.parse::<SocketAddr>())
            .transpose()?
            .unwrap_or(defaults.bind),
        database_url: env::var("WEBLABEL_DATABASE_URL").unwrap_or(defaults.database_url),
        object_root: env::var_os("WEBLABEL_OBJECT_ROOT")
            .map(PathBuf::from)
            .unwrap_or(defaults.object_root),
        write_timeout: env::var("WEBLABEL_SQLITE_WRITE_TIMEOUT_MS")
            .ok()
            .map(|value| value.parse::<u64>().map(Duration::from_millis))
            .transpose()?
            .unwrap_or(defaults.write_timeout),
        production: !env::var("WEBLABEL_ENV")
            .as_deref()
            .is_ok_and(|value| value == "development"),
    };
    config.validate().map_err(|error| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("{}: {}", error.code, error.message),
        )
    })?;

    let cookie_secure = match env::var("WEBLABEL_COOKIE_SECURE")?.as_str() {
        "true" => true,
        "false" => false,
        _ => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "WEBLABEL_COOKIE_SECURE must be exactly true or false",
            )
            .into());
        }
    };
    let launch_code = {
        let mut bytes = [0_u8; 32];
        OsRng.fill_bytes(&mut bytes);
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    };
    let port = config.bind.port();
    let mut hosts = Vec::new();
    let mut origins = Vec::new();
    if config.bind.ip().is_ipv4() {
        hosts.push(format!("127.0.0.1:{port}"));
        hosts.push(format!("localhost:{port}"));
        origins.push(format!("http://127.0.0.1:{port}"));
        origins.push(format!("http://localhost:{port}"));
        origins.push("http://127.0.0.1:5173".to_owned());
        origins.push("http://localhost:5173".to_owned());
    } else {
        hosts.push(format!("[::1]:{port}"));
        hosts.push(format!("localhost:{port}"));
        origins.push(format!("http://[::1]:{port}"));
        origins.push(format!("http://localhost:{port}"));
        origins.push("http://[::1]:5173".to_owned());
        origins.push("http://localhost:5173".to_owned());
    }
    let auth_config = AuthConfig {
        bind: config.bind,
        cookie_secure,
        allowed_origins: origins,
        allowed_hosts: hosts,
        launch_code: hash_launch_code(&launch_code),
        launch_code_expires_at: unix_now() + 600,
    };
    let state = AppState::open_with_auth(&config, auth_config).await?;
    let user_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&state.auth.pool)
        .await?;
    let restore_auth_requested = match env::var("WEBLABEL_RESTORE_AUTH") {
        Ok(value) if value == "1" => true,
        Ok(value) if value == "0" => false,
        Err(env::VarError::NotPresent) => false,
        _ => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "WEBLABEL_RESTORE_AUTH must be exactly 0 or 1",
            )
            .into())
        }
    };
    let restore_bootstrap = restore_auth_requested && state.auth.enable_restore_bootstrap().await?;
    if user_count == 0 || restore_bootstrap {
        println!("WEBLABEL_BOOTSTRAP_CODE={launch_code}");
    }
    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    tracing::info!(address = %config.bind, "WebLabel API listening");
    let queue = weblabel_api::jobs::queue::JobQueue::new(state.repository.clone());
    let repository = state.repository.clone();
    let production_runner = match env::var_os("WEBLABEL_HOST_EXECUTABLE") {
        None => {
            weblabel_api::jobs::model_jobs::ProductionRunner::unconfigured(state.run_tokens.clone())
        }
        Some(executable) => {
            let executable = PathBuf::from(executable);
            let cwd = PathBuf::from(env::var("WEBLABEL_HOST_CWD")?);
            let config_path = PathBuf::from(env::var("WEBLABEL_HOST_CONFIG")?);
            let script = PathBuf::from(env::var("WEBLABEL_HOST_SCRIPT")?);
            if !config_path.is_absolute()
                || !script.is_absolute()
                || !config_path.is_file()
                || !script.is_file()
            {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "private host config and script must be existing absolute files",
                )
                .into());
            }
            let mut allowed_env = vec![
                "WEBLABEL_HOST_CONFIG".to_owned(),
                "WEBLABEL_RUN_TOKEN".to_owned(),
            ];
            allowed_env
                .extend(["SystemRoot", "SystemDrive", "TEMP", "TMP", "WINDIR"].map(str::to_owned));
            allowed_env.extend(
                env::var("WEBLABEL_HOST_ALLOWED_ENV")
                    .unwrap_or_default()
                    .split(',')
                    .filter(|key| !key.is_empty())
                    .map(str::to_owned),
            );
            let source_env = allowed_env
                .iter()
                .filter_map(|key| env::var(key).ok().map(|value| (key.clone(), value)))
                .collect();
            let extra_env = [(
                "WEBLABEL_HOST_CONFIG".to_owned(),
                config_path.to_string_lossy().into_owned(),
            )]
            .into_iter()
            .collect();
            let host = weblabel_api::runtime::host::HostConfig {
                trusted_executable_roots: vec![executable
                    .parent()
                    .ok_or_else(|| {
                        std::io::Error::new(
                            std::io::ErrorKind::InvalidInput,
                            "host executable requires trusted parent",
                        )
                    })?
                    .to_path_buf()],
                trusted_cwd_roots: vec![cwd.clone()],
                executable,
                argv: vec![script.to_string_lossy().into_owned()],
                cwd,
                allowed_env,
                source_env,
                extra_env,
            };
            weblabel_api::jobs::model_jobs::ProductionRunner::new(
                host,
                state.run_tokens.clone(),
                Duration::from_secs(120),
            )
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error.code))?
        }
    };
    let model_runner = ServiceRunner {
        production: production_runner,
        mock: (!config.production).then(weblabel_api::jobs::model_jobs::MockRunner::standard),
    };
    // Debug integration fixtures explicitly own manual drains; release ignores this switch.
    let manual_model_worker = cfg!(debug_assertions)
        && env::var("WEBLABEL_TEST_MANUAL_MODEL_WORKER").as_deref() == Ok("1");
    let model_queue = queue.clone();
    let model_repository = repository.clone();
    let media_queue = queue.clone();
    let media_repository = repository.clone();
    let (shutdown_tx, _) = tokio::sync::watch::channel(false);
    let mut worker_shutdown = shutdown_tx.subscribe();
    let export_worker = tokio::spawn(async move {
        loop {
            if *worker_shutdown.borrow() {
                break;
            }
            tokio::select! {
                changed = worker_shutdown.changed() => {
                    if changed.is_err() || *worker_shutdown.borrow() { break; }
                }
                result = weblabel_api::jobs::model_jobs::process_dataset_export_next(
                    &repository, &queue, "dataset-export-worker",
                ) => match result {
                    Ok(Some(_)) => {}
                    Ok(None) => tokio::time::sleep(Duration::from_millis(500)).await,
                    Err(error) => {
                        tracing::error!(%error, "dataset export worker failed");
                        tokio::time::sleep(Duration::from_secs(2)).await;
                    }
                }
            }
        }
    });
    let mut media_shutdown = shutdown_tx.subscribe();
    let media_worker = tokio::spawn(async move {
        if manual_model_worker {
            let _ = media_shutdown.changed().await;
            return;
        }
        loop {
            if *media_shutdown.borrow() {
                break;
            }
            tokio::select! {
                changed = media_shutdown.changed() => { if changed.is_err() || *media_shutdown.borrow() { break; } }
                result = weblabel_api::jobs::model_jobs::process_media_import_next(&media_repository, &media_queue, "media-import-worker") => {
                    match result {
                        Ok(Some(_)) => {}
                        Ok(None) => tokio::time::sleep(Duration::from_millis(500)).await,
                        Err(error) => { tracing::error!(%error, "media import worker failed"); tokio::time::sleep(Duration::from_secs(2)).await; }
                    }
                }
            }
        }
    });
    let mut model_shutdown = shutdown_tx.subscribe();
    let model_worker = tokio::spawn(async move {
        if manual_model_worker {
            let _ = model_shutdown.changed().await;
            return;
        }
        loop {
            if *model_shutdown.borrow() {
                break;
            }
            tokio::select! {
                changed = model_shutdown.changed() => { if changed.is_err() || *model_shutdown.borrow() { break; } }
                result = weblabel_api::jobs::model_jobs::process_model_next(&model_repository, &model_queue, "model-worker", Duration::from_secs(300), &model_runner) => {
                    match result {
                        Ok(Some(_)) => {}
                        Ok(None) => tokio::time::sleep(Duration::from_millis(500)).await,
                        Err(error) => { tracing::error!(%error, "model worker failed"); tokio::time::sleep(Duration::from_secs(2)).await; }
                    }
                }
            }
        }
    });
    let serving = axum::serve(listener, router(state)).with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    });
    let server_result = serving.await;
    let _ = shutdown_tx.send(true);
    if let Err(error) = export_worker.await {
        tracing::error!(%error, "dataset export worker did not stop cleanly");
    }
    if let Err(error) = media_worker.await {
        tracing::error!(%error, "media import worker did not stop cleanly");
    }
    if let Err(error) = model_worker.await {
        tracing::error!(%error, "model worker did not stop cleanly");
    }
    server_result?;
    Ok(())
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

// Engineering mocks are an explicit development channel, never a real-provider fallback.
struct ServiceRunner {
    production: weblabel_api::jobs::model_jobs::ProductionRunner,
    mock: Option<weblabel_api::jobs::model_jobs::MockRunner>,
}
impl weblabel_api::jobs::model_jobs::RunRunner for ServiceRunner {
    fn execute<'a>(
        &'a self,
        driver: &'a weblabel_api::jobs::model_jobs::RunDriver,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<
                        weblabel_api::jobs::model_jobs::RunOutcome,
                        weblabel_api::jobs::model_jobs::RunnerError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        if driver.profile().provider_id == annotation_domain::ProviderId::Mock {
            if let Some(mock) = &self.mock {
                return mock.execute(driver);
            }
        }
        self.production.execute(driver)
    }
}
