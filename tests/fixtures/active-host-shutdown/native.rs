//! Engineering-only native process fixture, never a model/provider implementation.
//! Built explicitly as a Cargo example; not included in a product release.
use serde_json::{json, Value};
use std::{
    env, fs,
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::Path,
    process::{Command, Stdio},
    thread,
    time::Duration,
};

#[cfg(windows)]
unsafe extern "system" fn ignore_console(_: u32) -> i32 {
    1
}
fn ignore_console_interrupt() -> bool {
    #[cfg(windows)]
    unsafe {
        if windows_sys::Win32::System::Console::GetConsoleCP() == 0 {
            return false;
        }
        assert_ne!(
            windows_sys::Win32::System::Console::SetConsoleCtrlHandler(Some(ignore_console), 1),
            0
        );
    }
    #[cfg(unix)]
    unsafe {
        assert_ne!(libc::signal(libc::SIGINT, libc::SIG_IGN), libc::SIG_ERR);
        assert_ne!(libc::signal(libc::SIGTERM, libc::SIG_IGN), libc::SIG_ERR);
    }
    true
}
fn publish(directory: &Path, name: &str, value: &Value) {
    let temporary = directory.join(format!("{name}.tmp"));
    fs::write(&temporary, serde_json::to_vec(value).unwrap()).unwrap();
    fs::rename(temporary, directory.join(name)).unwrap();
}
fn context() -> Value {
    let base = env::var("WEBLABEL_API_BASE").expect("explicit scoped loopback base");
    let address: SocketAddr = base
        .strip_prefix("http://")
        .expect("HTTP loopback only")
        .parse()
        .unwrap();
    assert!(address.ip().is_loopback() && address.port() != 0);
    let token = env::var("WEBLABEL_RUN_TOKEN").expect("private scoped capability");
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(5)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    write!(stream, "POST /internal/agent-tools/get_context HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}").unwrap();
    let mut bytes = Vec::new();
    stream.take(65537).read_to_end(&mut bytes).unwrap();
    assert!(bytes.len() <= 65536);
    let end = bytes
        .windows(4)
        .position(|part| part == b"\r\n\r\n")
        .unwrap();
    assert_eq!(
        std::str::from_utf8(&bytes[..end])
            .unwrap()
            .split_whitespace()
            .nth(1),
        Some("200")
    );
    serde_json::from_slice(&bytes[end + 4..]).unwrap()
}
fn main() {
    let executable = env::current_exe().unwrap();
    let directory = executable.parent().unwrap();
    let args: Vec<String> = env::args().collect();
    let console_handler = ignore_console_interrupt();
    if args.get(1).is_some_and(|arg| arg == "--leaf") {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        publish(
            directory,
            "native-leaf.json",
            &json!({"pid":std::process::id(),"port":listener.local_addr().unwrap().port(),"console_handler_registered":console_handler}),
        );
        for socket in listener.incoming() {
            let mut socket = socket.unwrap();
            let mut request = [0u8; 8192];
            let _ = socket.read(&mut request);
            let body = b"T33-owned-stubborn-descendant";
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            socket.write_all(body).unwrap();
        }
        return;
    }
    let argument = |name: &str| {
        args.windows(2)
            .find(|pair| pair[0] == name)
            .expect("fixed native CLI argument")[1]
            .clone()
    };
    let session = argument("--session-id");
    let model = argument("--model");
    let mut prompt = String::new();
    std::io::stdin().read_to_string(&mut prompt).unwrap();
    assert!(!prompt.is_empty() && !args.iter().any(|arg| arg.contains(&prompt)));
    let scoped = context();
    let mut child = Command::new(&executable);
    child
        .arg("--leaf")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        child.creation_flags(0x00000008 | 0x00000200);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        child.process_group(0);
    }
    let child = child.spawn().unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let leaf: Value = loop {
        if let Ok(bytes) = fs::read(directory.join("native-leaf.json")) {
            break serde_json::from_slice(&bytes).unwrap();
        }
        assert!(std::time::Instant::now() < deadline);
        thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(leaf["pid"].as_u64(), Some(u64::from(child.id())));
    publish(
        directory,
        "native-started.json",
        &json!({"fixture_kind":"synthetic_native_lifecycle_no_inference","root_pid":std::process::id(),"descendant_pid":child.id(),"port":leaf["port"],"run_id":scoped["run_id"],"model_id":model,"actual_run_token_context_status":200,"actual_run_token_context":scoped,"descendant_detached":true,"root_console_handler_registered":console_handler,"descendant_console_handler_registered":leaf["console_handler_registered"]}),
    );
    println!(
        "{}",
        json!({"type":"system","subtype":"init","session_id":session,"auth_mode":"subscription","model":model,"tools":["mcp__weblabel-agent-tools__get_context","mcp__weblabel-agent-tools__list_objects","mcp__weblabel-agent-tools__read_region","mcp__weblabel-agent-tools__propose_changes","mcp__weblabel-agent-tools__report_issues"],"mcp_servers":[{"name":"weblabel-agent-tools","status":"connected"}]})
    );
    std::io::stdout().flush().unwrap();
    if model.ends_with("-crash") {
        std::process::exit(7);
    }
    if model.ends_with("-oversized") {
        let block = [b'x'; 8192];
        let mut stdout = std::io::stdout().lock();
        for _ in 0..513 {
            stdout.write_all(&block).unwrap();
        }
        stdout.flush().unwrap();
    }
    // Deliberately no terminal result: only the real parent can reclaim this tree.
    loop {
        thread::sleep(Duration::from_millis(50));
    }
}
