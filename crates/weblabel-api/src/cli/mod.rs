//! Native product commands. Protocol subcommands are registered only when implemented.
use std::{collections::BTreeMap, ffi::OsString, io, path::PathBuf};

pub type Error = Box<dyn std::error::Error>;

#[derive(Debug)]
pub enum Command {
    Serve { build_dir: PathBuf, data_dir: PathBuf, port: u16 },
    ServeApi,
    Doctor { build_dir: PathBuf, data_dir: Option<PathBuf> },
    McpStdio,
    DetectorWorker,
}

fn invalid() -> io::Error { io::Error::new(io::ErrorKind::InvalidInput, "INVALID_ARGUMENTS") }

pub fn parse(arguments: impl IntoIterator<Item = OsString>) -> io::Result<Command> {
    let mut arguments = arguments.into_iter();
    let command = arguments.next().ok_or_else(invalid)?;
    let allowed: &[&str] = match command.to_str() {
        Some("serve") => &["--build-dir", "--data-dir", "--port"],
        Some("serve-api") => &[],
        Some("mcp-stdio") => &[],
        Some("detector-worker") => &[],
        Some("doctor") => &["--build-dir", "--data-dir"],
        _ => return Err(invalid()),
    };
    let mut flags = BTreeMap::new();
    while let Some(flag) = arguments.next() {
        let flag = flag.to_str().filter(|flag| allowed.contains(flag)).ok_or_else(invalid)?.to_owned();
        let value = arguments.next().filter(|value| !value.is_empty() && !value.to_string_lossy().starts_with("--")).ok_or_else(invalid)?;
        if flags.insert(flag, value).is_some() { return Err(invalid()); }
    }
    if command == "serve-api" { return Ok(Command::ServeApi); }
    if command == "mcp-stdio" { return Ok(Command::McpStdio); }
    if command == "detector-worker" { return Ok(Command::DetectorWorker); }
    let build_dir = match flags.remove("--build-dir") {
        Some(value) => PathBuf::from(value),
        None if command == "doctor" => return Err(invalid()),
        None => std::env::current_exe()?.parent().ok_or_else(invalid)?.to_path_buf(),
    };
    let data_dir = flags.remove("--data-dir").map(PathBuf::from);
    if command == "doctor" { return Ok(Command::Doctor { build_dir, data_dir }); }
    let port = match flags.remove("--port") {
        Some(value) => {
            let text = value.to_str().ok_or_else(invalid)?;
            if !text.bytes().all(|byte| byte.is_ascii_digit()) { return Err(invalid()); }
            text.parse::<u16>().ok().filter(|port| *port > 0).ok_or_else(invalid)?
        }
        None => 48100,
    };
    let data_dir = data_dir.unwrap_or_else(|| build_dir.join("data"));
    Ok(Command::Serve { build_dir, data_dir, port })
}

pub async fn run(arguments: impl IntoIterator<Item = OsString>) -> Result<(), Error> {
    match parse(arguments)? {
        Command::McpStdio => crate::runtime::mcp::run_stdio().await.map_err(Into::into),
        Command::DetectorWorker => crate::runtime::detector::worker_stdio().map_err(Into::into),
        Command::Doctor { build_dir, data_dir } => crate::ops::doctor::run(build_dir, data_dir).await,
        command => {
            // Keep initialization out of parse/doctor and future protocol dispatch.
            let _ = tracing_subscriber::fmt().with_writer(std::io::stderr)
                .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
                .try_init();
            crate::server::run(command).await
        }
    }
}
