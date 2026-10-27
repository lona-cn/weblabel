//! Parsing is inert: no data/release/configuration access, logging, or processes.
use crate::ops::{backup, database, doctor, preflight};
use std::{collections::BTreeMap, ffi::OsString, io, path::PathBuf};

pub type Error = Box<dyn std::error::Error>;
#[derive(Debug)]
pub struct ExitStatus(pub i32);
impl std::fmt::Display for ExitStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "operation exit status {}", self.0)
    }
}
impl std::error::Error for ExitStatus {}

#[derive(Debug)]
pub enum Command {
    Serve {
        build_dir: PathBuf,
        data_dir: PathBuf,
        port: u16,
    },
    ServeApi,
    Doctor(doctor::Options),
    Backup {
        data_dir: PathBuf,
        backup_dir: PathBuf,
    },
    Restore {
        backup_dir: PathBuf,
        data_dir: PathBuf,
        migrations_dir: Option<PathBuf>,
    },
    UpgradePreflight {
        data_dir: PathBuf,
        build_dir: PathBuf,
        backup_dir: PathBuf,
        scratch_dir: Option<PathBuf>,
    },
    McpStdio,
    DetectorWorker,
}
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "INVALID_ARGUMENTS")
}
pub fn executable_release() -> io::Result<PathBuf> {
    Ok(std::env::current_exe()?
        .parent()
        .ok_or_else(invalid)?
        .to_path_buf())
}
fn required(flags: &mut BTreeMap<String, OsString>, flag: &str) -> io::Result<PathBuf> {
    flags.remove(flag).map(PathBuf::from).ok_or_else(invalid)
}
fn text(flags: &mut BTreeMap<String, OsString>, flag: &str) -> io::Result<Option<String>> {
    flags
        .remove(flag)
        .map(|s| s.into_string().map_err(|_| invalid()))
        .transpose()
}

pub fn parse(arguments: impl IntoIterator<Item = OsString>) -> io::Result<Command> {
    let mut arguments = arguments.into_iter();
    let command = arguments.next().ok_or_else(invalid)?;
    let allowed: &[&str] = match command.to_str() {
        Some("serve") => &["--build-dir", "--data-dir", "--port"],
        Some("serve-api" | "mcp-stdio" | "detector-worker") => &[],
        Some("doctor") => &[
            "--build-dir",
            "--data-dir",
            "--mode",
            "--cargo-cwd",
            "--api-url",
            "--target-release",
            "--backup-dir",
            "--support-receipt",
        ],
        Some("backup") => &["--data-dir", "--backup-dir"],
        Some("restore") => &["--backup-dir", "--data-dir", "--migrations-dir"],
        Some("upgrade-preflight") => {
            &["--data-dir", "--build-dir", "--backup-dir", "--scratch-dir"]
        }
        _ => return Err(invalid()),
    };
    let mut flags = BTreeMap::new();
    while let Some(flag) = arguments.next() {
        let flag = flag
            .to_str()
            .filter(|flag| allowed.contains(flag))
            .ok_or_else(invalid)?
            .to_owned();
        let value = arguments
            .next()
            .filter(|value| !value.is_empty() && !value.to_string_lossy().starts_with("--"))
            .ok_or_else(invalid)?;
        if flags.insert(flag, value).is_some() {
            return Err(invalid());
        }
    }
    match command.to_str() {
        Some("serve-api") => return Ok(Command::ServeApi),
        Some("mcp-stdio") => return Ok(Command::McpStdio),
        Some("detector-worker") => return Ok(Command::DetectorWorker),
        Some("backup") => {
            return Ok(Command::Backup {
                data_dir: required(&mut flags, "--data-dir")?,
                backup_dir: required(&mut flags, "--backup-dir")?,
            })
        }
        Some("restore") => {
            return Ok(Command::Restore {
                backup_dir: required(&mut flags, "--backup-dir")?,
                data_dir: required(&mut flags, "--data-dir")?,
                migrations_dir: flags.remove("--migrations-dir").map(PathBuf::from),
            })
        }
        Some("upgrade-preflight") => {
            return Ok(Command::UpgradePreflight {
                data_dir: required(&mut flags, "--data-dir")?,
                build_dir: required(&mut flags, "--build-dir")?,
                backup_dir: required(&mut flags, "--backup-dir")?,
                scratch_dir: flags.remove("--scratch-dir").map(PathBuf::from),
            })
        }
        _ => {}
    }
    let build_dir = match flags.remove("--build-dir") {
        Some(value) => PathBuf::from(value),
        None => executable_release()?,
    };
    let data_dir = flags.remove("--data-dir").map(PathBuf::from);
    if command == "doctor" {
        let mode = text(&mut flags, "--mode")?.unwrap_or_else(|| "build".into());
        if !matches!(mode.as_str(), "build" | "runtime" | "ai") {
            return Err(invalid());
        }
        let target_release = flags.remove("--target-release").map(PathBuf::from);
        let backup_dir = flags.remove("--backup-dir").map(PathBuf::from);
        if target_release.is_some() && (data_dir.is_none() || backup_dir.is_none()) {
            return Err(invalid());
        }
        if backup_dir.is_some() && target_release.is_none() {
            return Err(invalid());
        }
        return Ok(Command::Doctor(doctor::Options {
            build_dir,
            data_dir,
            mode,
            cargo_cwd: flags.remove("--cargo-cwd").map(PathBuf::from),
            api_url: text(&mut flags, "--api-url")?,
            target_release,
            backup_dir,
            support_receipt: flags.remove("--support-receipt").map(PathBuf::from),
        }));
    }
    let port = match flags.remove("--port") {
        Some(value) => {
            let text = value.to_str().ok_or_else(invalid)?;
            if !text.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(invalid());
            }
            text.parse::<u16>()
                .ok()
                .filter(|port| *port > 0)
                .ok_or_else(invalid)?
        }
        None => 48100,
    };
    let data_dir = data_dir.unwrap_or_else(|| build_dir.join("data"));
    Ok(Command::Serve {
        build_dir,
        data_dir,
        port,
    })
}

pub async fn run(arguments: impl IntoIterator<Item = OsString>) -> Result<(), Error> {
    match parse(arguments)? {
        Command::McpStdio => crate::runtime::mcp::run_stdio().await.map_err(Into::into),
        Command::DetectorWorker => crate::runtime::detector::worker_stdio().map_err(Into::into),
        Command::Doctor(options) => doctor::run(options).await,
        Command::Backup {
            data_dir,
            backup_dir,
        } => {
            backup::print_boundary();
            backup::create(&data_dir, &backup_dir)?;
            println!("backup_created: {}", backup_dir.display());
            Ok(())
        }
        Command::Restore {
            backup_dir,
            data_dir,
            migrations_dir,
        } => {
            backup::print_boundary();
            let sql = match migrations_dir {
                Some(directory) => database::migration_directory(&directory)?,
                None => crate::server::release::Release::validate(&executable_release()?)?
                    .migration_sql()?,
            };
            let destination = backup::restore(&backup_dir, &data_dir, &sql)?;
            println!("restore_created: {}; choose fresh local credentials using the one-time bootstrap code", destination.display());
            println!(
                "{}",
                serde_json::json!({"format":"weblabel-restore-handoff","version":1,"historical_identities":"unchanged","business_bytes":"unchanged","checklist":backup::checklist()})
            );
            Ok(())
        }
        Command::UpgradePreflight {
            data_dir,
            build_dir,
            backup_dir,
            scratch_dir,
        } => {
            let result = preflight::run(&data_dir, &build_dir, &backup_dir, scratch_dir.as_deref());
            println!("{}", serde_json::to_string_pretty(&result)?);
            if result["status"] == "compatible" {
                Ok(())
            } else {
                Err(Box::new(ExitStatus(2)))
            }
        }
        command => {
            let _ = tracing_subscriber::fmt()
                .with_writer(std::io::stderr)
                .with_env_filter(
                    tracing_subscriber::EnvFilter::try_from_default_env()
                        .unwrap_or_else(|_| "info".into()),
                )
                .try_init();
            crate::server::run(command).await
        }
    }
}
