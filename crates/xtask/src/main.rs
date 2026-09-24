use std::process::ExitCode;

fn main() -> ExitCode {
    let command = std::env::args().nth(1).unwrap_or_default();
    eprintln!("xtask command '{command}' is provided by the corresponding implementation task.");
    ExitCode::FAILURE
}
