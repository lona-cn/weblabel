use std::{
    io::{BufRead, BufReader},
    net::TcpListener,
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::Duration,
};

struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}
fn command(database: &std::path::Path, objects: &std::path::Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_weblabel-api"));
    command
        .env("WEBLABEL_BIND", format!("127.0.0.1:{}", port()))
        .env(
            "WEBLABEL_DATABASE_URL",
            format!("sqlite:{}", database.display()),
        )
        .env("WEBLABEL_OBJECT_ROOT", objects)
        .env("WEBLABEL_COOKIE_SECURE", "false")
        .env("WEBLABEL_ENV", "production")
        .env_remove("WEBLABEL_RESTORE_AUTH")
        .env_remove("WEBLABEL_ADMIN_RECOVERY_REQUEST_ID")
        .env_remove("WEBLABEL_ADMIN_RECOVERY_USERNAME")
        .env_remove("WEBLABEL_HOST_EXECUTABLE")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}
#[test]
fn another_api_cannot_open_the_same_database_and_process_exit_releases_ownership() {
    let root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/admin-recovery-tests");
    std::fs::create_dir_all(&root).unwrap();
    let scratch = tempfile::tempdir_in(root).unwrap();
    let database = scratch.path().join("api.sqlite");
    let objects = scratch.path().join("objects");
    let mut first = Running(command(&database, &objects).spawn().unwrap());
    let stdout = first.0.stdout.take().unwrap();
    let (ready, receiver) = mpsc::channel();
    let output = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if line.unwrap().contains("WebLabel API listening") {
                let _ = ready.send(());
                break;
            }
        }
    });
    receiver
        .recv_timeout(Duration::from_secs(20))
        .expect("first API becomes ready");
    output.join().unwrap();
    let mut second = Running(command(&database, &objects).spawn().unwrap());
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let exit = loop {
        if let Some(status) = second.0.try_wait().unwrap() {
            break Some(status);
        }
        if std::time::Instant::now() >= deadline {
            break None;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(
        exit.is_some_and(|status| !status.success()),
        "second API must refuse the occupied database"
    );
    drop(second);
    drop(first);
    let mut restarted = Running(command(&database, &objects).spawn().unwrap());
    let stdout = restarted.0.stdout.take().unwrap();
    let (ready, receiver) = mpsc::channel();
    let output = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if line.unwrap().contains("WebLabel API listening") {
                let _ = ready.send(());
                break;
            }
        }
    });
    receiver
        .recv_timeout(Duration::from_secs(20))
        .expect("process exit releases database ownership");
    output.join().unwrap();
    drop(restarted);
}
