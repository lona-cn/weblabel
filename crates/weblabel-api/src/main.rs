use std::{env, net::SocketAddr, path::PathBuf, time::Duration};

use weblabel_api::{config::ServerConfig, router, AppState};

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
    let state = AppState::open(&config).await?;
    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    tracing::info!(address = %config.bind, "WebLabel API listening");
    axum::serve(listener, router(state)).await?;
    Ok(())
}
