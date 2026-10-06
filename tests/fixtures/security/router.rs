//! Synthetic T29 fixture. Mounts the unmodified production router; private stdin
//! issues capabilities using the production RunTokenStore, never an HTTP backdoor.
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use weblabel_api::{
    auth::{hash_launch_code, AuthConfig},
    config::ServerConfig,
    AppState,
};

#[tokio::main]
async fn main() {
    let directory = PathBuf::from(std::env::args().nth(1).expect("synthetic directory"));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let bind = listener.local_addr().unwrap();
    let origin = format!("http://{bind}");
    let launch_code = "T29-synthetic-one-time-bootstrap";
    let config = ServerConfig {
        bind,
        database_url: format!("sqlite:{}", directory.join("api.sqlite").display()),
        object_root: directory.join("objects"),
        write_timeout: Duration::from_secs(2),
        production: false,
    };
    let state = AppState::open_with_auth(
        &config,
        AuthConfig {
            bind,
            cookie_secure: false,
            allowed_origins: vec![origin.clone()],
            allowed_hosts: vec![bind.to_string()],
            launch_code: hash_launch_code(launch_code),
            launch_code_expires_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64
                + 600,
        },
    )
    .await
    .unwrap();
    let tokens = state.run_tokens.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, weblabel_api::router(state))
            .await
            .unwrap();
    });
    println!(
        "{}",
        json!({"base_url": origin, "launch_code": launch_code})
    );
    io::stdout().flush().unwrap();
    tokio::task::spawn_blocking(move || {
        for line in io::stdin().lock().lines() {
            let mut command: Value = serde_json::from_str(&line.unwrap()).unwrap();
            if let Some(bytes) = command.get_mut("archive_bytes") {
                let bytes: Vec<u8> = serde_json::from_value(bytes.take()).unwrap();
                let result = dataset_formats::archive::extract_safe_zip(
                    &bytes,
                    &dataset_formats::archive::ArchiveLimits::default(),
                );
                let answer = match result {
                    Ok(files) => json!({"accepted": true, "files": files}),
                    Err(_) => json!({"accepted": false}),
                };
                println!("{answer}");
                io::stdout().flush().unwrap();
                continue;
            }
            let token = tokens.issue(
                command["run_id"].as_str().unwrap(),
                command["project_id"].as_str().unwrap(),
                Duration::from_millis(command["ttl_ms"].as_u64().unwrap()),
            );
            println!("{}", json!({"token": token}));
            io::stdout().flush().unwrap();
        }
    })
    .await
    .unwrap();
    server.abort();
}
