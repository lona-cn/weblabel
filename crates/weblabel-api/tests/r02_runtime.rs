//! Synthetic release/SQLite fixtures exercise the real native product executable.
//! This is not a packaged-release, browser, GPU, provider, or model-live claim.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

fn scratch() -> tempfile::TempDir {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/test-artifacts/R02-server");
    fs::create_dir_all(&root).unwrap();
    tempfile::tempdir_in(root).unwrap()
}
fn product() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_weblabel"));
    for key in [
        "WEBLABEL_RUNTIME_CONFIG",
        "WEBLABEL_RUNTIME_ALLOWED_ENV",
        "WEBLABEL_RESTORE_AUTH",
        "WEBLABEL_ADMIN_RECOVERY_REQUEST_ID",
        "WEBLABEL_ADMIN_RECOVERY_USERNAME",
        "WEBLABEL_TEST_MANUAL_MODEL_WORKER",
    ] {
        command.env_remove(key);
    }
    command.env("WEBLABEL_ENV", "production");
    command
}
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}
fn hash(path: &Path) -> String {
    let mut file = fs::File::open(path).unwrap();
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = file.read(&mut buffer).unwrap();
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    format!("{:x}", hasher.finalize())
}
// Compare native identity and metadata without reading Windows' mandatory-locked byte.
#[cfg(windows)]
fn file_identity(path: &Path) -> (u64, u64, u64, std::time::SystemTime) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let file = fs::File::open(path).unwrap();
    let mut information = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
    // SAFETY: the open file handle remains valid and the output storage has the required size.
    assert_ne!(
        unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) },
        0,
        "native lock-file identity: {}",
        std::io::Error::last_os_error()
    );
    let information = unsafe { information.assume_init() };
    let metadata = file.metadata().unwrap();
    (
        u64::from(information.dwVolumeSerialNumber),
        (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
        metadata.len(),
        metadata.modified().unwrap(),
    )
}
#[cfg(unix)]
fn file_identity(path: &Path) -> (u64, u64, u64, std::time::SystemTime) {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::metadata(path).unwrap();
    (
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        metadata.modified().unwrap(),
    )
}
struct Fixture {
    root: tempfile::TempDir,
    release: PathBuf,
    data: PathBuf,
    manifest: Value,
}
impl Fixture {
    fn new() -> Self {
        let root = scratch();
        let release = root.path().join("release");
        let data = root.path().join("data");
        fs::create_dir_all(release.join("web/wasm")).unwrap();
        fs::create_dir_all(release.join("migrations")).unwrap();
        let binary = weblabel_api::server::release::executable_name();
        fs::copy(env!("CARGO_BIN_EXE_weblabel"), release.join(binary)).unwrap();
        fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/web/index.html"),
            release.join("web/index.html"),
        )
        .unwrap();
        fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/web/src/styles/tokens.css"),
            release.join("web/theme.css"),
        )
        .unwrap();
        // Explicit minimal synthetic WASM assets only test byte serving/MIME, not a functioning editor.
        fs::write(
            release.join("web/wasm/wasm_bridge.js"),
            b"export const fixture_kind = 'synthetic_static';\n",
        )
        .unwrap();
        fs::write(
            release.join("web/wasm/wasm_bridge_bg.wasm"),
            b"\0asm\x01\0\0\0",
        )
        .unwrap();
        fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations/0001_core.sql"),
            release.join("migrations/0001_core.sql"),
        )
        .unwrap();
        fs::write(release.join("web/unlisted.txt"), b"never public").unwrap();
        let paths = [
            binary,
            "web/index.html",
            "web/theme.css",
            "web/wasm/wasm_bridge.js",
            "web/wasm/wasm_bridge_bg.wasm",
            "migrations/0001_core.sql",
        ];
        let files: Vec<Value> = paths
            .iter()
            .map(|path| {
                let file = release.join(path);
                json!({"path":path,"size":fs::metadata(&file).unwrap().len(),"sha256":hash(&file)})
            })
            .collect();
        let manifest = json!({"format":"weblabel-local-release","version":2,"platform":weblabel_api::server::release::platform(),"arch":weblabel_api::server::release::arch(),"source_commit":"91edf309b3c5325a1fa42a2241b6de79a55e5c34","pins":{"node":"24.16.0","pnpm":"10.34.5","rust":"1.96.0","wasm_bindgen":"0.2.128","wasm_pack":"0.15.0"},"files":files});
        let fixture = Self {
            root,
            release,
            data,
            manifest,
        };
        fixture.save();
        fixture
    }
    fn save(&self) {
        fs::write(
            self.release.join("release.json"),
            serde_json::to_vec(&self.manifest).unwrap(),
        )
        .unwrap();
    }
    fn serve(&self, port: u16) -> Command {
        let mut command = product();
        command
            .args(["serve", "--build-dir"])
            .arg(&self.release)
            .arg("--data-dir")
            .arg(&self.data)
            .arg("--port")
            .arg(port.to_string());
        command.current_dir(self.root.path());
        command
    }
    fn doctor(&self) -> Command {
        let mut command = product();
        command
            .arg("doctor")
            .arg("--mode")
            .arg("runtime")
            .arg("--build-dir")
            .arg(&self.release)
            .arg("--data-dir")
            .arg(&self.data);
        command
    }
}
struct Running {
    child: Child,
    lines: mpsc::Receiver<String>,
    stderr: Option<std::thread::JoinHandle<Vec<u8>>>,
}
impl Running {
    fn spawn(mut command: Command) -> Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x00000200);
        }
        let mut child = command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if let Ok(line) = line {
                    let _ = tx.send(line);
                } else {
                    break;
                }
            }
        });
        let stderr = Some(std::thread::spawn(move || {
            let mut bytes = Vec::new();
            stderr.take(1024 * 1024).read_to_end(&mut bytes).unwrap();
            bytes
        }));
        Self {
            child,
            lines,
            stderr,
        }
    }
    fn ready(&self) -> Option<String> {
        let mut code = None;
        loop {
            let line = self
                .lines
                .recv_timeout(Duration::from_secs(30))
                .expect("native server startup receipt");
            if let Some(value) = line.strip_prefix("WEBLABEL_BOOTSTRAP_CODE=") {
                code = Some(value.to_owned());
            }
            if line.starts_with("WEBLABEL_LOCAL_URL=") {
                return code;
            }
        }
    }
    fn stop(&mut self) -> String {
        #[cfg(unix)]
        {
            assert_eq!(
                unsafe { libc::kill(self.child.id() as i32, libc::SIGTERM) },
                0
            );
        }
        #[cfg(windows)]
        {
            assert_ne!(
                unsafe {
                    windows_sys::Win32::System::Console::GenerateConsoleCtrlEvent(
                        windows_sys::Win32::System::Console::CTRL_BREAK_EVENT,
                        self.child.id(),
                    )
                },
                0,
                "test requires an attached console for real CTRL_BREAK"
            );
        }
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success(), "graceful native exit");
                break;
            }
            assert!(Instant::now() < deadline, "bounded shutdown");
            std::thread::sleep(Duration::from_millis(20));
        }
        String::from_utf8(self.stderr.take().unwrap().join().unwrap()).unwrap()
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
struct Response {
    status: u16,
    headers: String,
    body: Vec<u8>,
}
fn request(
    port: u16,
    method: &str,
    path: &str,
    host: &str,
    origin: Option<&str>,
    body: &str,
) -> Response {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    write!(stream,"{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{}\r\n{body}", body.len(), origin.map(|value|format!("Origin: {value}\r\n")).unwrap_or_default()).unwrap();
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).unwrap();
    let end = bytes.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let headers = String::from_utf8(bytes[..end].to_vec()).unwrap();
    let status = headers.split_whitespace().nth(1).unwrap().parse().unwrap();
    Response {
        status,
        headers: headers.to_ascii_lowercase(),
        body: bytes[end + 4..].to_vec(),
    }
}
fn get(port: u16, path: &str) -> Response {
    request(port, "GET", path, &format!("127.0.0.1:{port}"), None, "")
}

#[test]
fn rejects_incomplete_unknown_duplicate_and_legacy_cli_without_startup() {
    for args in [
        vec![],
        vec!["backup"],
        vec!["mcp-stdio"],
        vec!["detector-worker"],
        vec!["serve", "--api-port", "48101"],
        vec!["serve", "--port", "0"],
        vec!["serve", "--port", "65536"],
        vec!["serve", "--port", "+1"],
        vec!["serve", "--port"],
        vec!["serve", "--port", "1", "--port", "2"],
        vec!["serve-api", "--data-dir", "x"],
    ] {
        let output = product().args(args).output().unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }
    let output = product()
        .arg("serve-api")
        .env("WEBLABEL_BIND", "0.0.0.0:48100")
        .env("WEBLABEL_COOKIE_SECURE", "false")
        .env("WEBLABEL_ENV", "development")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}

#[test]
fn release_validation_rejects_v1_corruption_escape_duplicate_and_missing_assets_before_data_creation(
) {
    let mut fixture = Fixture::new();
    let original = fixture.manifest.clone();
    for mutation in 0..7 {
        fixture.manifest = original.clone();
        match mutation {
            0 => fixture.manifest["version"] = json!(1),
            1 => fixture.manifest["files"][0]["sha256"] = json!("0".repeat(64)),
            2 => fixture.manifest["files"][0]["path"] = json!("../outside"),
            3 => {
                let duplicate = fixture.manifest["files"][0].clone();
                fixture.manifest["files"]
                    .as_array_mut()
                    .unwrap()
                    .push(duplicate);
            }
            4 => fixture.manifest["pins"]["rust"] = json!("unknown"),
            5 => fixture.manifest["platform"] = json!("other"),
            _ => {
                fixture.manifest["files"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|entry| entry["path"] != "web/index.html");
            }
        }
        fixture.save();
        let output = fixture.serve(free_port()).output().unwrap();
        assert!(!output.status.success());
        assert!(!fixture.data.exists());
        let output = fixture.doctor().output().unwrap();
        assert!(!output.status.success());
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["release"]["status"], "invalid");
    }
}

#[test]
fn same_origin_static_head_wasm_security_auth_and_os_lock_are_real_product_behaviors() {
    let fixture = Fixture::new();
    let port = free_port();
    let host = format!("127.0.0.1:{port}");
    let origin = format!("http://{host}");
    let mut first = Running::spawn(fixture.serve(port));
    let code = first.ready().unwrap();
    let index = get(port, "/");
    assert_eq!(index.status, 200);
    assert_eq!(
        index.body,
        fs::read(fixture.release.join("web/index.html")).unwrap()
    );
    assert!(index.headers.contains("x-content-type-options: nosniff"));
    assert!(index.headers.contains("x-frame-options: deny"));
    assert!(index.headers.contains("referrer-policy: no-referrer"));
    assert!(index.headers.contains("'wasm-unsafe-eval'"));
    assert!(!index.headers.contains("'unsafe-eval'"));
    let wasm = get(port, "/wasm/wasm_bridge_bg.wasm");
    assert_eq!(wasm.status, 200);
    assert!(wasm.headers.contains("application/wasm"));
    let head = request(port, "HEAD", "/wasm/wasm_bridge_bg.wasm", &host, None, "");
    assert_eq!(head.status, 200);
    assert!(head.body.is_empty());
    assert!(head.headers.contains("content-length: 8"));
    for path in [
        "/api/missing",
        "/web/unlisted.txt",
        "/unlisted.txt",
        "/migrations/0001_core.sql",
        "/../release.json",
        "/%2e%2e/release.json",
        "/%2findex.html",
        "/%255cindex.html",
    ] {
        assert_ne!(get(port, path).status, 200, "{path}");
    }
    assert_eq!(get(port, "/api/projects").status, 401);
    assert_eq!(
        request(port, "GET", "/", "attacker.invalid", None, "").status,
        403
    );
    assert_eq!(
        request(port, "GET", "/", &host, Some("http://127.0.0.1:5173"), "").status,
        403
    );
    let body = json!({"launch_code":code,"password":"r02-synthetic-password"}).to_string();
    let login = request(
        port,
        "POST",
        "/api/session/bootstrap",
        &host,
        Some(&origin),
        &body,
    );
    assert_eq!(login.status, 200);
    assert!(login.headers.contains("httponly"));
    assert!(login.headers.contains("samesite=strict"));
    assert_ne!(
        request(
            port,
            "POST",
            "/api/session/bootstrap",
            &host,
            Some(&origin),
            &body
        )
        .status,
        200
    );
    let second = fixture.serve(free_port()).output().unwrap();
    assert!(!second.status.success());
    assert!(String::from_utf8_lossy(&second.stderr).contains("DATABASE_IN_USE"));
    let lock = fixture.data.join("api.sqlite.runtime.lock");
    let before = file_identity(&lock);
    let doctor = fixture.doctor().env("PATH", "").output().unwrap();
    assert!(doctor.status.success());
    let diagnostics: Value = serde_json::from_slice(&doctor.stdout).unwrap();
    assert_eq!(diagnostics["storage"]["lock"]["status"], "occupied");
    assert!(diagnostics["storage"]["available_bytes"].is_string());
    assert_eq!(file_identity(&lock), before);
    let receipt = first.stop();
    assert!(receipt.contains("weblabel-shutdown"));
    assert!(!receipt.contains(&code));
    assert_eq!(file_identity(&lock), before);
    let unlocked_hash = hash(&lock);
    let doctor = fixture.doctor().output().unwrap();
    let diagnostics: Value = serde_json::from_slice(&doctor.stdout).unwrap();
    assert_eq!(diagnostics["storage"]["lock"]["status"], "available");
    assert_eq!(file_identity(&lock), before);
    assert_eq!(hash(&lock), unlocked_hash);
    let mut restarted = Running::spawn(fixture.serve(free_port()));
    assert!(restarted.ready().is_none());
    restarted.stop();
}

#[test]
fn overlapping_static_gets_wait_for_four_body_owned_io_permits() {
    let mut fixture = Fixture::new();
    let asset = fixture.release.join("web/backpressured.bin");
    let chunk: Vec<u8> = (0..65536).map(|index| (index % 251) as u8).collect();
    const SIZE: u64 = 32 * 1024 * 1024;
    let mut file = fs::File::create(&asset).unwrap();
    for _ in 0..SIZE / chunk.len() as u64 {
        file.write_all(&chunk).unwrap();
    }
    drop(file);
    let expected_hash = hash(&asset);
    fixture.manifest["files"]
        .as_array_mut()
        .unwrap()
        .push(json!({"path":"web/backpressured.bin","size":SIZE,"sha256":expected_hash}));
    fixture.save();
    let port = free_port();
    let mut server = Running::spawn(fixture.serve(port));
    server.ready();
    let begin = || {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(30)))
            .unwrap();
        write!(stream, "GET /backpressured.bin HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").unwrap();
        BufReader::new(stream)
    };
    let headers = |reader: &mut BufReader<TcpStream>| {
        let mut headers = String::new();
        loop {
            let mut line = String::new();
            assert_ne!(
                reader.read_line(&mut line).unwrap(),
                0,
                "complete static response headers"
            );
            if line == "\r\n" {
                break;
            }
            headers.push_str(&line);
            assert!(headers.len() < 16384);
        }
        assert!(headers.starts_with("HTTP/1.1 200 "), "{headers}");
        assert!(headers
            .to_ascii_lowercase()
            .contains(&format!("content-length: {SIZE}\r\n")));
    };
    let drain = |mut reader: BufReader<TcpStream>| {
        let mut digest = Sha256::new();
        let mut bytes = 0u64;
        let mut buffer = [0u8; 65536];
        loop {
            let count = reader.read(&mut buffer).unwrap();
            if count == 0 {
                break;
            }
            bytes += count as u64;
            assert!(bytes <= SIZE);
            digest.update(&buffer[..count]);
        }
        assert_eq!(bytes, SIZE);
        assert_eq!(format!("{:x}", digest.finalize()), expected_hash);
    };
    // Header receipt proves all four requests have opened their real release asset.
    // Do not read their large bodies: socket backpressure must keep those permits owned.
    let mut held = Vec::new();
    for _ in 0..4 {
        let mut reader = begin();
        headers(&mut reader);
        held.push(reader);
    }
    let mut queued: Vec<_> = (0..2).map(|_| begin()).collect();
    for reader in &mut queued {
        reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(500)))
            .unwrap();
        let error = reader
            .get_mut()
            .read(&mut [0u8; 1])
            .expect_err("requests beyond four must wait, not return 503 or bypass the I/O bound");
        assert!(
            matches!(
                error.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            ),
            "{error}"
        );
        reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_secs(30)))
            .unwrap();
    }
    for reader in held {
        drain(reader);
    }
    for mut reader in queued {
        headers(&mut reader);
        drain(reader);
    }
    server.stop();
}

#[test]
fn doctor_is_readonly_single_sanitized_json_and_changed_static_bytes_fail_closed() {
    let fixture = Fixture::new();
    let port = free_port();
    let mut server = Running::spawn(fixture.serve(port));
    server.ready();
    let before = hash(&fixture.release.join("release.json"));
    let malformed = fixture.root.path().join("malformed-private.json");
    let private_marker = b"invalid-native-config-marker: not JSON";
    fs::write(&malformed, private_marker).unwrap();
    for path in [
        fixture.root.path().join("missing-private.json"),
        malformed.clone(),
    ] {
        let output = fixture
            .doctor()
            .env("WEBLABEL_RUNTIME_CONFIG", &path)
            .env("PATH", "")
            .output()
            .unwrap();
        assert!(!output.status.success());
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["readonly"], true);
        assert_eq!(result["status"], "failed");
        assert_eq!(result["release"]["status"], "hashes_valid");
        assert_eq!(result["configuration"]["status"], "invalid");
        assert_eq!(
            result["configuration"]["code"],
            "RUNTIME_CONFIGURATION_UNAVAILABLE"
        );
        for bytes in [&output.stdout, &output.stderr] {
            let text = String::from_utf8_lossy(bytes);
            assert!(!text.contains(path.file_name().unwrap().to_str().unwrap()));
            assert!(!text.contains("invalid-native-config-marker"));
        }
    }
    assert_eq!(fs::read(&malformed).unwrap(), private_marker);
    assert_eq!(hash(&fixture.release.join("release.json")), before);
    fs::write(fixture.release.join("web/theme.css"), b"tampered").unwrap();
    assert_eq!(get(port, "/theme.css").status, 503);
    server.stop();
}

#[test]
fn doctor_fails_explicit_invalid_data_but_optional_configuration_and_default_data_are_not_required()
{
    let fixture = Fixture::new();
    let before = hash(&fixture.release.join("release.json"));
    let default_data = fixture.release.join("data");
    let output = product()
        .arg("doctor")
        .arg("--mode")
        .arg("runtime")
        .arg("--build-dir")
        .arg(&fixture.release)
        .env("PATH", "")
        .output()
        .unwrap();
    assert!(output.status.success());
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["status"], "passed");
    assert_eq!(result["configuration"]["status"], "not_configured");
    assert!(!default_data.exists());
    assert!(!fixture.data.exists());
    let data_file = fixture.root.path().join("not-a-directory");
    fs::write(&data_file, b"synthetic non-directory").unwrap();
    for path in [&fixture.data, &data_file] {
        let output = product()
            .arg("doctor")
            .arg("--mode")
            .arg("runtime")
            .arg("--build-dir")
            .arg(&fixture.release)
            .arg("--data-dir")
            .arg(path)
            .output()
            .unwrap();
        assert!(!output.status.success());
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["release"]["status"], "hashes_valid");
        assert_eq!(result["configuration"]["status"], "not_configured");
        assert_eq!(result["storage"]["code"], "DATA_DIRECTORY_UNAVAILABLE");
    }
    assert!(!fixture.data.exists());
    fs::create_dir(&fixture.data).unwrap();
    let output = fixture.doctor().output().unwrap();
    assert!(output.status.success());
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["status"], "passed");
    assert_eq!(result["configuration"]["status"], "not_configured");
    assert_eq!(result["storage"]["database"]["status"], "absent");
    assert_eq!(
        fs::read_dir(&fixture.data).unwrap().count(),
        0,
        "doctor must not initialize storage"
    );
    assert_eq!(hash(&fixture.release.join("release.json")), before);
}

#[test]
fn runtime_doctor_accepts_explicit_native_configuration_without_external_tools() {
    let fixture = Fixture::new();
    let native = fixture.root.path().join("runtime.json");
    fs::write(
        &native,
        json!({"schema_version":1,"timeout_ms":1000,"providers":[]}).to_string(),
    )
    .unwrap();
    let before = hash(&native);
    let output = product()
        .arg("doctor")
        .arg("--mode")
        .arg("runtime")
        .arg("--build-dir")
        .arg(&fixture.release)
        .env("WEBLABEL_RUNTIME_CONFIG", native.canonicalize().unwrap())
        .env("PATH", "")
        .output()
        .unwrap();
    assert!(output.status.success());
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["status"], "passed");
    assert_ne!(result["configuration"]["status"], "invalid");
    assert!(output.stderr.is_empty());
    assert_eq!(hash(&native), before);
    assert!(!fixture.release.join("data").exists());
    assert!(!fixture.data.exists());
}

#[test]
fn password_recovery_serves_account_assets_but_not_business_routes_or_workers() {
    let fixture = Fixture::new();
    let port = free_port();
    let host = format!("127.0.0.1:{port}");
    let mut server = Running::spawn(fixture.serve(port));
    let code = server.ready().unwrap();
    let response = request(
        port,
        "POST",
        "/api/session/bootstrap",
        &host,
        Some(&format!("http://{host}")),
        &json!({"launch_code":code,"password":"r02-synthetic-password"}).to_string(),
    );
    assert_eq!(response.status, 200);
    server.stop();
    let mut command = fixture.serve(free_port());
    command
        .env(
            "WEBLABEL_ADMIN_RECOVERY_REQUEST_ID",
            uuid::Uuid::new_v4().to_string(),
        )
        .env("WEBLABEL_ADMIN_RECOVERY_USERNAME", "local-admin");
    let recovery_port: u16 = command
        .get_args()
        .last()
        .unwrap()
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    let mut server = Running::spawn(command);
    assert!(server.ready().is_none());
    assert_eq!(get(recovery_port, "/").status, 200);
    assert_eq!(get(recovery_port, "/theme.css").status, 200);
    assert_eq!(get(recovery_port, "/ready").status, 503);
    assert_eq!(get(recovery_port, "/api/projects").status, 503);
    assert_eq!(
        get(recovery_port, "/internal/agent-tools/get_context").status,
        503
    );
    server.stop();
}

#[cfg(unix)]
#[test]
fn linked_release_asset_is_refused_even_when_target_bytes_match() {
    let fixture = Fixture::new();
    let original = fixture.release.join("web/theme.css");
    let target = fixture.root.path().join("outside.css");
    fs::rename(&original, &target).unwrap();
    std::os::unix::fs::symlink(&target, &original).unwrap();
    let output = fixture.serve(free_port()).output().unwrap();
    assert!(!output.status.success());
    assert!(!fixture.data.exists());
}

#[cfg(windows)]
#[test]
fn junction_release_asset_directory_is_refused_even_when_target_bytes_match() {
    let fixture = Fixture::new();
    let directory = fixture.release.join("web/wasm");
    let outside = fixture.root.path().join("outside-wasm");
    fs::rename(&directory, &outside).unwrap();
    // cmd's built-in mklink parses the mixed "/../" spelling as switches.
    // Canonicalize the existing parent/target, then use normal native drive paths.
    let native_path = |path: &Path| {
        let canonical = path.canonicalize().unwrap();
        let mut components = canonical.components();
        if let Some(std::path::Component::Prefix(prefix)) = components.next() {
            if let std::path::Prefix::VerbatimDisk(drive) = prefix.kind() {
                return PathBuf::from(format!("{}:", char::from(drive))).join(components.as_path());
            }
        }
        canonical
    };
    let directory = native_path(directory.parent().unwrap()).join(directory.file_name().unwrap());
    let outside = native_path(&outside);
    let output = Command::new("cmd.exe")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(&directory)
        .arg(&outside)
        .output()
        .unwrap();
    assert!(output.status.success(), "synthetic junction fixture creation: link={directory:?}; target={outside:?}; exit_code={:?}; stdout={}; stderr={}", output.status.code(), String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    let output = fixture.serve(free_port()).output().unwrap();
    assert!(!output.status.success());
    assert!(!fixture.data.exists());
}

#[test]
fn api_only_native_entry_preserves_dev_origin_without_static_files() {
    let root = scratch();
    let port = free_port();
    let mut command = product();
    command
        .arg("serve-api")
        .current_dir(root.path())
        .env("WEBLABEL_BIND", format!("127.0.0.1:{port}"))
        .env(
            "WEBLABEL_DATABASE_URL",
            format!("sqlite:{}", root.path().join("api.sqlite").display()),
        )
        .env("WEBLABEL_OBJECT_ROOT", root.path().join("objects"))
        .env("WEBLABEL_COOKIE_SECURE", "false")
        .env("WEBLABEL_ENV", "development");
    let mut server = Running::spawn(command);
    assert!(server.ready().is_some());
    assert_eq!(get(port, "/").status, 404);
    let response = request(
        port,
        "GET",
        "/api/session/bootstrap",
        &format!("127.0.0.1:{port}"),
        Some("http://127.0.0.1:5173"),
        "",
    );
    assert_eq!(response.status, 200);
    let receipt = server.stop();
    assert!(receipt.contains("weblabel-shutdown"));
}
