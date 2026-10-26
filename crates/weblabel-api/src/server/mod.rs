//! Single-process native product serving; no Node/Python execution path.
pub mod release;
mod static_files;
mod workers;

use std::{env, future::Future, io, net::SocketAddr, path::PathBuf, time::Duration};
use rand::{rngs::OsRng, RngCore};
use axum::middleware;
use crate::{auth::{hash_launch_code, AuthConfig}, cli::{Command, Error}, config::ServerConfig, runtime::config::{legacy_host_environment_present, ProfileConfiguration}, AppState};

fn invalid(code: &'static str) -> io::Error { io::Error::new(io::ErrorKind::InvalidInput, code) }
fn flag(name: &str) -> io::Result<bool> {
    match env::var(name) { Ok(value) if value == "1" => Ok(true), Ok(value) if value == "0" => Ok(false), Err(env::VarError::NotPresent) => Ok(false), _ => Err(invalid("INVALID_STARTUP_CONFIGURATION")) }
}
fn unix_now() -> i64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() as i64 }

pub async fn run(command: Command) -> Result<(), Error> {
    if legacy_host_environment_present() {
        tracing::warn!(code="LEGACY_HOST_CONFIGURATION_IGNORED", "legacy Host configuration is ignored; configure the native runtime explicitly");
    }
    let (mut config, release, data_dir, api_only) = match command {
        Command::Serve { build_dir, data_dir, port } => {
            let release = tokio::task::spawn_blocking(move || release::Release::validate(&build_dir)).await??;
            // Only a fully verified release can create or open product data.
            std::fs::create_dir_all(&data_dir)?;
            let data_dir = data_dir.canonicalize()?;
            let database = data_dir.join("api.sqlite");
            (ServerConfig { bind: SocketAddr::from(([127,0,0,1], port)), database_url: format!("sqlite:{}", database.display()), object_root: data_dir.join("objects"), production: true, ..ServerConfig::default() }, Some(release), data_dir, false)
        }
        Command::ServeApi => {
            let defaults = ServerConfig::default();
            let config = ServerConfig {
                bind: env::var("WEBLABEL_BIND").ok().map(|value| value.parse::<SocketAddr>()).transpose().map_err(|_| invalid("INVALID_BIND"))?.unwrap_or(defaults.bind),
                database_url: env::var("WEBLABEL_DATABASE_URL").unwrap_or(defaults.database_url),
                object_root: env::var_os("WEBLABEL_OBJECT_ROOT").map(PathBuf::from).unwrap_or(defaults.object_root),
                write_timeout: env::var("WEBLABEL_SQLITE_WRITE_TIMEOUT_MS").ok().map(|value| value.parse::<u64>().map(Duration::from_millis)).transpose().map_err(|_| invalid("INVALID_WRITE_TIMEOUT"))?.unwrap_or(defaults.write_timeout),
                production: !(cfg!(debug_assertions) && env::var("WEBLABEL_ENV").as_deref() == Ok("development")),
            };
            let database = PathBuf::from(config.database_url.strip_prefix("sqlite:").unwrap_or(&config.database_url));
            let data_dir = database.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or(std::path::Path::new(".")).canonicalize()?;
            (config, None, data_dir, true)
        }
        _ => return Err(invalid("INVALID_SERVER_COMMAND").into()),
    };
    if !config.bind.ip().is_loopback() || config.bind.port() == 0 { return Err(invalid("NON_LOOPBACK_OR_INVALID_PORT").into()); }
    config.validate().map_err(|_| invalid("INVALID_SERVER_CONFIGURATION"))?;
    let cookie_secure = if api_only { match env::var("WEBLABEL_COOKIE_SECURE").as_deref() { Ok("true") => true, Ok("false") => false, _ => return Err(invalid("COOKIE_SECURE_REQUIRED").into()) } } else { false };
    let recovery = crate::startup::AdminRecoveryOptions::from_env()?;
    let restore_auth = flag("WEBLABEL_RESTORE_AUTH")?;
    if recovery.is_some() {
        if restore_auth { return Err(invalid("RECOVERY_CONFLICTS_WITH_RESTORE").into()); }
        if !std::path::Path::new(config.database_url.strip_prefix("sqlite:").unwrap_or(&config.database_url)).is_file() { return Err(invalid("RECOVERY_REQUIRES_EXISTING_DATABASE").into()); }
    }
    let database_owner = crate::startup::lock_database(&config.database_url)?;
    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    config.bind = listener.local_addr()?;
    let address = config.bind;
    let port = address.port();
    let literal = if address.is_ipv4() { address.ip().to_string() } else { format!("[{}]", address.ip()) };
    let mut origins = vec![format!("http://{literal}:{port}"), format!("http://localhost:{port}")];
    if api_only { origins.extend([format!("http://{literal}:5173"), "http://localhost:5173".to_owned()]); }
    let mut entropy = [0u8; 32]; OsRng.fill_bytes(&mut entropy);
    let launch_code: String = entropy.iter().map(|byte| format!("{byte:02x}")).collect();
    let auth = AuthConfig { bind: address, cookie_secure, allowed_hosts: vec![format!("{literal}:{port}"), format!("localhost:{port}")], allowed_origins: origins, launch_code: hash_launch_code(&launch_code), launch_code_expires_at: unix_now() + 600 };
    let maintenance = recovery.is_some();
    let mut state = if maintenance { AppState::open_for_password_recovery(&config, auth).await? } else { AppState::open_with_auth(&config, auth).await? };
    // The native entry never consumes the legacy Host loader, even in development.
    let production = if maintenance {
        state.profile_configuration = ProfileConfiguration::Native(Ok(None));
        None
    } else { Some(workers::configure(&mut state, address)) };
    state.allow_mock_runs = api_only && cfg!(debug_assertions) && !config.production;
    if let Some(recovery) = recovery {
        state.auth.enable_password_recovery(&recovery.request_id, &recovery.username, hash_launch_code(&launch_code), unix_now() + 600).await.map_err(|_| invalid("INVALID_ADMIN_RECOVERY_CONFIGURATION"))?;
        println!("WEBLABEL_ADMIN_RECOVERY_CODE={launch_code}");
        println!("WEBLABEL_ADMIN_RECOVERY_TARGET={}", recovery.username);
    } else {
        let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users").fetch_one(&state.auth.pool).await?;
        let restored = restore_auth && state.auth.enable_restore_bootstrap().await?;
        if users == 0 || restored { println!("WEBLABEL_BOOTSTRAP_CODE={launch_code}"); }
    }
    let auth_guard = state.auth.clone();
    let router = if let Some(release) = release { crate::router_with_static(state.clone(), static_files::router(release, maintenance)?) } else { crate::router(state.clone()) };
    let router = router.layer(middleware::from_fn_with_state(auth_guard, crate::auth::host_and_origin))
        .layer(middleware::from_fn(static_files::security_headers));
    let signal = shutdown_signal()?;
    let (shutdown, _) = tokio::sync::watch::channel(false);
    let workers = production.as_ref().map_or_else(Vec::new, |runner| workers::start(&state, runner.clone(), shutdown.subscribe()));
    println!("WEBLABEL_DATA_DIR={}", data_dir.display());
    println!("WEBLABEL_API_STATE={}", if maintenance { "password_recovery" } else { "normal" });
    println!("WEBLABEL_LOCAL_URL=http://{literal}:{port}");
    let settlement_state = state.clone();
    let stop = shutdown.clone();
    let mut stopped = shutdown.subscribe();
    let signal_task = tokio::spawn(async move {
        if signal.await.is_err() { tracing::error!(code="SHUTDOWN_SIGNAL_FAILED", "shutdown signal failed"); }
        // Wake Axum's graceful stop immediately; settlement proceeds alongside HTTP draining.
        let _ = stop.send(true);
        if !maintenance && revoke_and_interrupt(&settlement_state).await.is_err() {
            tracing::error!(code="SHUTDOWN_SETTLEMENT_FAILED", "run settlement failed");
        }
    });
    let result = axum::serve(listener, router).with_graceful_shutdown(async move {
        while !*stopped.borrow() { if stopped.changed().await.is_err() { break; } }
    }).await;
    if !*shutdown.borrow() { signal_task.abort(); }
    let _ = signal_task.await;
    let _ = shutdown.send(true);
    let mut worker_errors = 0usize;
    for worker in workers { if worker.await.is_err() { worker_errors += 1; } }
    let runtime_shutdown = match &production { Some(Ok(runner)) => runner.shutdown().await, _ => Ok(()) };
    let owned_child_processes = if worker_errors == 0 && runtime_shutdown.is_ok() {
        match &production { Some(Ok(runner)) => runner.shutdown_child_count(), _ => Some(0) }
    } else { None };
    let settlement = if maintenance { Ok(0) } else { revoke_and_interrupt(&state).await };
    state.auth.pool.close().await;
    state.repository.close().await;
    drop(state);
    // Pool and job completion precedes releasing this OS lock. Never unlink its sidecar.
    drop(database_owner);
    tracing::info!(receipt = %serde_json::json!({"format":"weblabel-shutdown","version":1,"workers_joined":true,"worker_errors":worker_errors,"settlement":if settlement.is_ok(){"complete"}else{"failed"},"native_runtime_shutdown":if runtime_shutdown.is_ok(){"complete"}else{"failed"},"owned_child_processes":owned_child_processes,"pools_closed":true,"upstream_billing":"not_claimed"}), "native shutdown receipt");
    result?; settlement?;
    runtime_shutdown.map_err(|error| io::Error::other(error.code))?;
    if worker_errors != 0 { return Err(io::Error::other("WORKER_SHUTDOWN_FAILED").into()); }
    Ok(())
}

async fn revoke_and_interrupt(state: &AppState) -> Result<u64, sqlx::Error> {
    state.run_tokens.revoke_all();
    crate::ai::runs::recover_interrupted(&state.repository, &state.run_tokens).await
}

fn shutdown_signal() -> io::Result<impl Future<Output = io::Result<()>> + Send> {
    #[cfg(unix)] {
        use tokio::signal::unix::{signal, SignalKind};
        let mut terminate = signal(SignalKind::terminate())?;
        let mut interrupt = signal(SignalKind::interrupt())?;
        Ok(async move { tokio::select! { _ = terminate.recv() => Ok(()), _ = interrupt.recv() => Ok(()) } })
    }
    #[cfg(windows)] {
        let mut interrupt = tokio::signal::windows::ctrl_c()?;
        let mut control_break = tokio::signal::windows::ctrl_break()?;
        let mut close = tokio::signal::windows::ctrl_close()?;
        let mut shutdown = tokio::signal::windows::ctrl_shutdown()?;
        Ok(async move { tokio::select! { _ = interrupt.recv() => Ok(()), _ = control_break.recv() => Ok(()), _ = close.recv() => Ok(()), _ = shutdown.recv() => Ok(()) } })
    }
}
