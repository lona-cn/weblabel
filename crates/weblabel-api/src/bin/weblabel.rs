fn main() -> Result<(), Box<dyn std::error::Error>> {
    // The Linux subreaper must start single-threaded, before Tokio exists.
    // Only the native general broker is dispatched before the runtime.
    #[cfg(target_os = "linux")]
    {
        use weblabel_api::runtime::supervisor::linux_broker;
        let mut arguments = std::env::args_os().skip(1);
        let mode = arguments.next();
        if mode.as_deref() == Some(std::ffi::OsStr::new(linux_broker::MODE)) {
            let result = linux_broker::run(arguments);
            let code = match result {
                Ok(code) => code,
                Err(error) => {
                    eprintln!("runtime broker: {error}");
                    125
                }
            };
            std::process::exit(code);
        }
    }
    let result = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(weblabel_api::cli::run(std::env::args_os().skip(1)));
    match result {
        Err(error) => match error.downcast_ref::<weblabel_api::cli::ExitStatus>() {
            Some(status) => std::process::exit(status.0),
            None => Err(error),
        },
        Ok(()) => Ok(()),
    }
}
