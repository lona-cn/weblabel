use std::{env, net::SocketAddr, path::PathBuf, time::Duration};

use rand::{rngs::OsRng, RngCore};
use weblabel_api::{
    auth::{hash_launch_code, AuthConfig},
    config::ServerConfig,
    router, AppState,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
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
    if user_count == 0 {
        println!("WEBLABEL_BOOTSTRAP_CODE={launch_code}");
    }
    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    tracing::info!(address = %config.bind, "WebLabel API listening");
    axum::serve(listener, router(state)).await?;
    Ok(())
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
