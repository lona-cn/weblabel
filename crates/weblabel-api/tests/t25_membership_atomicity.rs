//! Real Router + SQLite WAL authorization race; no model/provider calls.
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tower::ServiceExt;
use weblabel_api::{
    auth::{hash_launch_code, AuthConfig},
    config::ServerConfig,
    router, AppState,
};

const HOST: &str = "127.0.0.1:48125";
async fn call(
    app: &Router,
    path: &str,
    body: Value,
    cookie: Option<&str>,
    csrf: Option<&str>,
) -> (StatusCode, Value, Option<String>) {
    let mut request = Request::builder()
        .method("POST")
        .uri(path)
        .header("host", HOST)
        .header("origin", format!("http://{HOST}"))
        .header("content-type", "application/json");
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    if let Some(csrf) = csrf {
        request = request.header("x-csrf-token", csrf);
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let cookie = response
        .headers()
        .get("set-cookie")
        .map(|v| v.to_str().unwrap().split(';').next().unwrap().to_owned());
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap(), cookie)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn committed_admin_demotion_cannot_be_overwritten_by_stale_self_regrant() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("membership.sqlite");
    let config = ServerConfig {
        bind: HOST.parse().unwrap(),
        database_url: format!("sqlite:{}", database.display()),
        object_root: directory.path().join("objects"),
        write_timeout: Duration::from_secs(10),
        production: true,
    };
    let mut state = AppState::open_with_auth(
        &config,
        AuthConfig {
            bind: config.bind,
            cookie_secure: false,
            allowed_origins: vec![format!("http://{HOST}")],
            allowed_hosts: vec![HOST.to_owned()],
            launch_code: hash_launch_code("atomicity-launch"),
            launch_code_expires_at: chrono::Utc::now().timestamp() + 3600,
        },
    )
    .await
    .unwrap();
    let app = router(state.clone());
    let (status, login, cookie) = call(
        &app,
        "/api/session/bootstrap",
        json!({"launch_code":"atomicity-launch","password":"atomicity-synthetic-password"}),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let cookie = cookie.unwrap();
    let csrf = login["csrf_token"].as_str().unwrap().to_owned();
    let actor = login["user_id"].as_str().unwrap().to_owned();
    let (status, project, _) = call(
        &app,
        "/api/projects",
        json!({"name":"Atomicity","description":"Synthetic only","allow_self_review":false}),
        Some(&cookie),
        Some(&csrf),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let project = project["project_id"].as_str().unwrap().to_owned();
    let members = format!("/api/projects/{project}/members");
    assert_eq!(
        call(
            &app,
            &members,
            json!({"user_id":actor,"role":"admin"}),
            None,
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let (status, body, _) = call(
        &app,
        &members,
        json!({"user_id":"missing-user","role":"admin"}),
        Some(&cookie),
        Some(&csrf),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["code"], "USER_NOT_FOUND");
    let (status, body, _) = call(
        &app,
        "/api/projects/missing-project/members",
        json!({"user_id":actor,"role":"admin"}),
        Some(&cookie),
        Some(&csrf),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["code"], "PROJECT_NOT_FOUND");
    assert_eq!(
        call(
            &app,
            &members,
            json!({"user_id":actor,"role":"admin"}),
            Some(&cookie),
            Some(&csrf)
        )
        .await
        .0,
        StatusCode::OK
    );

    // Instrument only the test-owned SQLx pool, not a production handler hook.
    // Two real middleware reads precede handler access. The third acquisition
    // identifies the handler starting while the competing WAL writer owns the
    // lock. In the vulnerable handler, the fifth acquisition (its write Tx)
    // is gated after its stale role/user reads have completed.
    let acquisitions = Arc::new(AtomicUsize::new(0));
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let count = acquisitions.clone();
    let permit = gate.clone();
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&database)
        .foreign_keys(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(10));
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .test_before_acquire(false)
        .before_acquire(move |_, _| {
            let sender = sender.clone();
            let count = count.clone();
            let permit = permit.clone();
            Box::pin(async move {
                let number = count.fetch_add(1, Ordering::SeqCst) + 1;
                sender.send(number).unwrap();
                if number == 5 {
                    permit.acquire().await.unwrap().forget();
                }
                Ok(true)
            })
        })
        .connect_with(options)
        .await
        .unwrap();
    // Ensure the sole connection is idle before numbering the request accesses.
    tokio::time::timeout(Duration::from_secs(2), async {
        while pool.num_idle() != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    acquisitions.store(0, Ordering::SeqCst);
    while receiver.try_recv().is_ok() {}
    state.auth.pool = pool.clone();
    let app = router(state.clone());
    let mut competitor = state.repository.begin_write().await.unwrap();
    sqlx::query("UPDATE memberships SET role='viewer' WHERE project_id=? AND user_id=?")
        .bind(&project)
        .bind(&actor)
        .execute(competitor.connection())
        .await
        .unwrap();
    let request_app = app.clone();
    let request_path = format!("/api/projects/{project}/members");
    let request_actor = actor.clone();
    let request = tokio::spawn(async move {
        call(
            &request_app,
            &request_path,
            json!({"user_id":request_actor,"role":"admin"}),
            Some(&cookie),
            Some(&csrf),
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(3), async {
        while receiver.recv().await.unwrap() != 3 {}
    })
    .await
    .expect("authenticated Router request did not reach handler access");
    // Old code deterministically reaches the gated fifth acquisition. Correct
    // code instead stays pending at BEGIN IMMEDIATE on the occupied connection.
    let stale_reads_completed = tokio::time::timeout(Duration::from_secs(2), async {
        while receiver.recv().await.unwrap() != 5 {}
    })
    .await
    .is_ok();
    assert!(
        !request.is_finished(),
        "request unexpectedly completed while competing writer held lock"
    );
    assert_eq!(
        pool.size() - pool.num_idle() as u32,
        1,
        "handler connection must be occupied"
    );
    competitor.commit().await.unwrap();
    gate.add_permits(1);
    let (status, body, _) = tokio::time::timeout(Duration::from_secs(5), request)
        .await
        .unwrap()
        .unwrap();
    let mut tx = state.repository.begin_write().await.unwrap();
    let role: String =
        sqlx::query_scalar("SELECT role FROM memberships WHERE project_id=? AND user_id=?")
            .bind(&project)
            .bind(&actor)
            .fetch_one(tx.connection())
            .await
            .unwrap();
    tx.commit().await.unwrap();
    println!("adminrace stale_reads_completed={stale_reads_completed} status={status} persisted_role={role} body={body}");
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "stale authorization must not restore admin: {body}"
    );
    assert_eq!(body["code"], "PROJECT_ADMIN_REQUIRED");
    assert_eq!(role, "viewer");
}
