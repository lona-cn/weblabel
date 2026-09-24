use std::process::ExitCode;

mod contracts;

fn main() -> ExitCode {
    let command = std::env::args().nth(1).unwrap_or_default();
    let result = match command.as_str() {
        "contracts-generate" => {
            contracts::generate(std::path::Path::new("packages/contracts/generated"))
        }
        "contracts-check" => {
            let generated =
                std::env::temp_dir().join(format!("weblabel-contracts-{}", std::process::id()));
            contracts::check(
                std::path::Path::new("packages/contracts/generated"),
                &generated,
            )
            .and_then(|matches| {
                if matches {
                    Ok(())
                } else {
                    Err("generated contracts differ".into())
                }
            })
        }
        _ => {
            eprintln!("unsupported xtask command '{command}'");
            return ExitCode::FAILURE;
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("xtask {command} failed: {error}");
            ExitCode::FAILURE
        }
    }
}
