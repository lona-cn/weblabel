//! Official native Claude adapter. No Node host, shell command, API credential,
//! model alias, or alternate tool authorization path is accepted here.
pub mod protocol;

use crate::{
    ai::{consent, events::ProviderEvent, predictions::SubmitCandidates, runs},
    jobs::model_jobs::{RunDriver, RunOutcome, RunnerError},
    runtime::{
        host::{spawn_native, validate_native_executable, HostConfig},
        run_tokens::RunTokenStore,
    },
    storage::Repository,
};
use annotation_domain::{ProviderId, RunEventType};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use std::{
    collections::BTreeMap,
    net::SocketAddr,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const MCP_SERVER_NAME: &str = "weblabel-agent-tools";
const MAX_LINE: usize = 4 * 1024 * 1024;
const MAX_OUTPUT: usize = 32 * 1024 * 1024;
const DRAIN: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{code}: native Claude run refused or failed")]
pub struct ClaudeError {
    pub code: &'static str,
}
impl ClaudeError {
    pub fn new(code: &'static str) -> Self {
        Self { code }
    }
}
impl From<ClaudeError> for RunnerError {
    fn from(error: ClaudeError) -> Self {
        RunnerError::new(
            error.code,
            "Native Claude run failed; upstream cost may be unknown",
        )
    }
}

pub fn permitted_tools() -> Vec<String> {
    crate::runtime::agent_tools::TOOL_NAMES
        .iter()
        .map(|name| format!("mcp__{MCP_SERVER_NAME}__{name}"))
        .collect()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClaudeConfig {
    pub profile_id: String,
    pub model_id: String,
    pub executable: PathBuf,
    pub timeout_ms: u64,
    pub max_tool_turns: usize,
    pub max_tool_result_bytes: usize,
}
impl ClaudeConfig {
    pub fn parse(value: &Value) -> Result<Self, ClaudeError> {
        let config: Self = serde_json::from_value(value.clone())
            .map_err(|_| ClaudeError::new("RUNTIME_CONFIGURATION_UNAVAILABLE"))?;
        if config.timeout_ms == 0
            || config.max_tool_turns == 0
            || config.max_tool_result_bytes == 0
            || !config.model_id.starts_with("claude-")
            || !config
                .model_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        {
            return Err(ClaudeError::new("RUNTIME_CONFIGURATION_UNAVAILABLE"));
        }
        validate_native_executable(&config.executable)
            .map_err(|_| ClaudeError::new("native_cli_required"))?;
        Ok(config)
    }
}

/// Prompt and token are deliberately absent from argv. Never log HostConfig.
/// Caller supplies an existing, newly-created private run directory (not a repo).
/// This is a tool/cwd restriction, NOT an OS sandbox, especially on Windows.
pub fn launch_config(
    config: &ClaudeConfig,
    product: &Path,
    cwd: &Path,
    api_base: &str,
    token: &str,
    session: &str,
    source_env: BTreeMap<String, String>,
) -> Result<HostConfig, ClaudeError> {
    if !config.model_id.starts_with("claude-")
        || !config
            .model_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err(ClaudeError::new("model_invalid"));
    }
    crate::runtime::mcp::validate_api_base(api_base)
        .map_err(|_| ClaudeError::new("MCP_API_BASE_INVALID"))?;
    validate_native_executable(product)
        .map_err(|_| ClaudeError::new("product_executable_invalid"))?;
    validate_native_executable(&config.executable)
        .map_err(|_| ClaudeError::new("native_cli_required"))?;
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ClaudeError::new("RUN_TOKEN_INVALID"));
    }
    if uuid::Uuid::parse_str(session).is_err() {
        return Err(ClaudeError::new("session_mismatch"));
    }
    // Only platform/session lookup essentials may reach the official CLI. Never
    // forward credential, endpoint, proxy, NODE_OPTIONS or arbitrary CLAUDE_* vars.
    const SAFE: &[&str] = &[
        "SystemRoot",
        "WINDIR",
        "USERPROFILE",
        "HOME",
        "APPDATA",
        "LOCALAPPDATA",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LANG",
        "LC_ALL",
    ];
    if source_env
        .keys()
        .any(|key| !SAFE.iter().any(|safe| safe.eq_ignore_ascii_case(key)))
    {
        return Err(ClaudeError::new("env_denied"));
    }
    let product = product
        .canonicalize()
        .map_err(|_| ClaudeError::new("product_executable_invalid"))?;
    // Inline config contains only environment interpolation, never the secret.
    // It also avoids leaving a private token config file behind after a crash.
    let mcp = json!({"mcpServers":{MCP_SERVER_NAME:{"command":product,"args":["mcp-stdio"],
        "env":{"WEBLABEL_API_BASE":"${WEBLABEL_API_BASE}","WEBLABEL_RUN_TOKEN":"${WEBLABEL_RUN_TOKEN}"}}}});
    let schema = json!({"type":"object","additionalProperties":false,"required":["changes","issues"],
        "properties":{"changes":{"type":"array","items":{"type":"object"}},"issues":{"type":"array","items":{"type":"object"}},"score":{"type":["number","null"]}}});
    let argv = vec![
        "-p".into(),
        "--verbose".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--input-format".into(),
        "text".into(),
        "--mcp-config".into(),
        mcp.to_string(),
        "--strict-mcp-config".into(),
        "--tools".into(),
        "".into(),
        "--allowedTools".into(),
        permitted_tools().join(","),
        "--disallowedTools".into(),
        "Bash,PowerShell,Edit,Write,Read,NotebookEdit,WebFetch,WebSearch,Glob,Grep,Task,Agent"
            .into(),
        "--setting-sources".into(),
        "local".into(),
        "--no-session-persistence".into(),
        "--disable-slash-commands".into(),
        "--no-chrome".into(),
        "--json-schema".into(),
        schema.to_string(),
        "--model".into(),
        config.model_id.clone(),
        "--session-id".into(),
        session.into(),
    ];
    if argv.iter().any(|a| a.contains(token)) {
        return Err(ClaudeError::new("token_in_argv"));
    }
    let mut extra_env = source_env;
    extra_env.insert("WEBLABEL_API_BASE".into(), api_base.into());
    extra_env.insert("WEBLABEL_RUN_TOKEN".into(), token.into());
    let executable = config
        .executable
        .canonicalize()
        .map_err(|_| ClaudeError::new("native_cli_required"))?;
    let cwd = cwd
        .canonicalize()
        .map_err(|_| ClaudeError::new("cwd_untrusted"))?;
    let host = HostConfig {
        trusted_executable_roots: vec![executable
            .parent()
            .ok_or_else(|| ClaudeError::new("native_cli_required"))?
            .into()],
        trusted_cwd_roots: vec![cwd.clone()],
        executable,
        argv,
        cwd,
        allowed_env: extra_env.keys().cloned().collect(),
        source_env: BTreeMap::new(),
        extra_env,
    };
    host.validate()
        .map_err(|_| ClaudeError::new("launch_policy_invalid"))?;
    Ok(host)
}

/// Transport-level engineering surface shared by the adapter and deterministic
/// native fixtures. No real CLI is invoked by tests or by metadata probing.
pub async fn run_native(
    host: &HostConfig,
    prompt: &str,
    mut session: protocol::Session,
    tokens: &RunTokenStore,
    token: &str,
    deadline: tokio::time::Instant,
    driver: Option<&RunDriver<'_>>,
) -> Result<protocol::Completion, ClaudeError> {
    if prompt.len() > 1024 * 1024 {
        return Err(ClaudeError::new("prompt_too_large"));
    }
    if tokio::time::Instant::now() >= deadline {
        return Err(ClaudeError::new("tool_time_budget_exceeded"));
    }
    // Main's single token-authority mutex covers the final liveness check,
    // one-shot dispatch marker AND this synchronous spawn. No verify/spawn gap.
    let mut process = tokens
        .dispatch_if_live(token, || spawn_native(host))
        .map_err(|error| ClaudeError::new(error.code()))?
        .map_err(|_| ClaudeError::new("native_spawn_failed"))?;
    let mut stdin = process
        .child
        .stdin
        .take()
        .ok_or_else(|| ClaudeError::new("native_stdio_failed"))?;
    let mut stdout = process
        .child
        .stdout
        .take()
        .ok_or_else(|| ClaudeError::new("native_stdio_failed"))?;
    let mut stderr = process
        .child
        .stderr
        .take()
        .ok_or_else(|| ClaudeError::new("native_stdio_failed"))?;
    // Both pipes belong to this future, not detached tasks. Abandonment drops
    // their reads and the job owner immediately; normal paths prove reclamation.
    let mut discarded = [0u8; 8192];
    let mut stderr_open = true;
    let mut cancellation = tokio::time::interval(Duration::from_millis(100));
    let mut exit = None;
    let mut cleanup = None;
    let outcome=async {
        {
        let send=async{
            stdin.write_all(prompt.as_bytes()).await.map_err(|_|ClaudeError::new("native_stdin_failed"))?;
            stdin.shutdown().await.map_err(|_|ClaudeError::new("native_stdin_failed"))
        };
        tokio::pin!(send);
        loop {
            tokio::select!{
                biased;
                _=tokio::time::sleep_until(deadline)=>return Err(ClaudeError::new("tool_time_budget_exceeded")),
                _=cancellation.tick()=>{if tokens.verify(token).is_err(){return Err(ClaudeError::new("run_cancelled"));}},
                sent=&mut send=>{sent?;break;},
                read=stderr.read(&mut discarded),if stderr_open=>{stderr_open=read.map_err(|_|ClaudeError::new("native_stdio_failed"))?!=0;},
            }
        }
        }
        drop(stdin);
        let mut chunk=[0u8;8192];
        let mut line=Vec::new();
        let mut total=0usize;
        let mut completion=None;
        loop {
            // One sentinel byte detects over-budget input without ever growing
            // the line or aggregate payload past the remaining allowance.
            let window=chunk.len().min(MAX_LINE.saturating_sub(line.len()).min(MAX_OUTPUT.saturating_sub(total))+1);
            let count=tokio::select!{
                biased;
                _=tokio::time::sleep_until(deadline)=>return Err(ClaudeError::new("tool_time_budget_exceeded")),
                _=cancellation.tick()=>{if tokens.verify(token).is_err(){return Err(ClaudeError::new("run_cancelled"));}continue;},
                read=stdout.read(&mut chunk[..window])=>read.map_err(|_|ClaudeError::new("claude_disconnected"))?,
                status=process.child.wait(),if exit.is_none()=>{
                    exit=Some(status.map_err(|_|ClaudeError::new("native_exit_failed"))?);
                    // Descendants can retain inherited pipe handles after the
                    // original root exits. Reclaim them before waiting for EOF,
                    // then still parse buffered terminal/usage bytes normally.
                    cleanup=Some(process.reclaim().await);
                    if cleanup.as_ref().is_some_and(Result::is_err){return Err(ClaudeError::new("process_tree_reclaim_failed"));}
                    continue;
                },
                read=stderr.read(&mut discarded),if stderr_open=>{stderr_open=read.map_err(|_|ClaudeError::new("native_stdio_failed"))?!=0;continue;},
            };
            if count==0 {
                if !line.is_empty(){return Err(ClaudeError::new("truncated_stream"));}
                return completion.ok_or_else(||ClaudeError::new("claude_disconnected"));
            }
            for byte in &chunk[..count]{
                if line.len()>=MAX_LINE||total>=MAX_OUTPUT{return Err(ClaudeError::new("stream_budget_exceeded"));}
                line.push(*byte);total+=1;
                if *byte!=b'\n'{continue;}
                let event:Value=serde_json::from_slice(&line).map_err(|_|ClaudeError::new("claude_protocol_violation"))?;
                line.clear();
                let folded=session.fold(&event);
                // Usage observation precedes success, candidate submission,
                // exit/reclaim checks, and propagation of a failed terminal.
                if let Some(usage)=session.take_terminal_usage(){
                    if let Some(driver)=driver{
                        driver.emit(ProviderEvent{provider_event_id:"claude-terminal-usage".into(),provider_seq:None,
                            event_type:RunEventType::Progress,message:"Terminal usage observed; upstream billing remains unverified".into(),
                            data:Some(json!({"usage":usage,"cost_display":"unknown"}))}).await.map_err(|_|ClaudeError::new("event_record_failed"))?;
                    }
                }
                if let Some(result)=folded?{completion=Some(result);}
                for (id,name,is_result) in session.boundaries.drain(..){
                    if let Some(driver)=driver{
                        driver.emit(ProviderEvent{provider_event_id:format!("claude-tool-{}-{id}",if is_result{"result"}else{"call"}),
                            provider_seq:None,event_type:if is_result{RunEventType::Progress}else{RunEventType::ToolCall},
                            message:if is_result{"Tool result received".into()}else{"Authorized tool call".into()},
                            data:Some(json!({"tool_use_id":id,"tool":name}))}).await.map_err(|_|ClaudeError::new("event_record_failed"))?;
                    }
                }
            }
        }
    }.await;
    if outcome.is_ok() && exit.is_none() {
        let wait_deadline = deadline.min(tokio::time::Instant::now() + DRAIN);
        loop {
            tokio::select! {
                biased;
                _=tokio::time::sleep_until(wait_deadline)=>break,
                _=cancellation.tick()=>{if tokens.verify(token).is_err(){break;}},
                status=process.child.wait()=>{exit=status.ok();break;},
                read=stderr.read(&mut discarded),if stderr_open=>{stderr_open=read.ok().is_some_and(|count|count!=0);},
            }
        }
    }
    let cleanup = match cleanup {
        Some(outcome) => outcome,
        None => process.reclaim().await,
    };
    // No model/event interpretation during the bounded post-kill drain.
    let _ = tokio::time::timeout(DRAIN, tokio::io::copy(&mut stdout, &mut tokio::io::sink())).await;
    let _ = tokio::time::timeout(DRAIN, tokio::io::copy(&mut stderr, &mut tokio::io::sink())).await;
    if cleanup.is_err() {
        return Err(ClaudeError::new("process_tree_reclaim_failed"));
    }
    let completion = outcome?;
    // Cleanup and drainage await: cancellation sampled before them is stale.
    // This prompt failure check does not replace the final publication fence
    // inside RunDriver's transaction admission with the same original token.
    if tokens.verify(token).is_err() {
        return Err(ClaudeError::new("run_cancelled"));
    }
    if !exit.is_some_and(|status| status.success()) {
        return Err(ClaudeError::new("native_exit_failed"));
    }
    Ok(completion)
}

struct TokenLease<'a> {
    tokens: &'a RunTokenStore,
    run: String,
}
impl Drop for TokenLease<'_> {
    fn drop(&mut self) {
        self.tokens.revoke_run(&self.run);
    }
}
struct RunDirectory(PathBuf);
impl Drop for RunDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir(&self.0);
    }
}

/// Main composes this fixed provider into ProductionRunner. `run_root` is a
/// trusted private runtime directory, never a browser path or user repository.
/// Live availability remains blocked/not_run until the installed CLI's actual
/// auth/tool/stream schema is independently evidenced; this function does not
/// manufacture that evidence or infer subscription from missing metadata.
pub async fn execute(
    driver: &RunDriver<'_>,
    repository: &Repository,
    tokens: &RunTokenStore,
    api_addr: SocketAddr,
    configuration: &Value,
    run_root: &Path,
    timeout: Duration,
) -> Result<RunOutcome, RunnerError> {
    let config = ClaudeConfig::parse(configuration)?;
    if driver.profile().provider_id != ProviderId::ClaudeLocal
        || driver.profile().model_id != config.model_id
        || &*driver.profile().profile_id != config.profile_id
    {
        return Err(ClaudeError::new("PROFILE_CONFIGURATION_CONFLICT").into());
    }
    let mut tx = repository
        .begin_write()
        .await
        .map_err(|_| ClaudeError::new("STORAGE_UNAVAILABLE"))?;
    let record = runs::load_record(tx.connection(), driver.run_id())
        .await
        .map_err(|_| ClaudeError::new("STORAGE_UNAVAILABLE"))?
        .ok_or_else(|| ClaudeError::new("RUN_NOT_FOUND"))?;
    consent::authorize_run(tx.connection(), &record)
        .await
        .map_err(|e| RunnerError::new(e.code, &e.message))?;
    if record.context().ok().as_ref() != Some(driver.context())
        || record.provider_id != "claude_local"
    {
        return Err(ClaudeError::new("RUN_CONTEXT_CHANGED").into());
    }
    let row = sqlx::query("SELECT config_json FROM model_profiles WHERE profile_id=?")
        .bind(&record.profile_id)
        .fetch_one(tx.connection())
        .await
        .map_err(|_| ClaudeError::new("STORAGE_UNAVAILABLE"))?;
    let persisted: Value = serde_json::from_str(&row.get::<String, _>("config_json"))
        .map_err(|_| ClaudeError::new("PROFILE_CONFIGURATION_CONFLICT"))?;
    if annotation_domain::hash::execution_configuration_hash(&persisted).ok()
        != annotation_domain::hash::execution_configuration_hash(configuration).ok()
    {
        return Err(ClaudeError::new("PROFILE_CONFIGURATION_CONFLICT").into());
    }
    let row =
        sqlx::query("SELECT capability_expires_at FROM model_run_authorizations WHERE run_id=?")
            .bind(driver.run_id())
            .fetch_one(tx.connection())
            .await
            .map_err(|_| ClaudeError::new("RUN_AUTHORIZATION_REQUIRED"))?;
    let expires =
        chrono::DateTime::parse_from_rfc3339(&row.get::<String, _>("capability_expires_at"))
            .map_err(|_| ClaudeError::new("RUN_AUTHORIZATION_EXPIRED"))?
            .timestamp_millis();
    tx.commit()
        .await
        .map_err(|_| ClaudeError::new("STORAGE_UNAVAILABLE"))?;
    let remaining = u64::try_from(expires - chrono::Utc::now().timestamp_millis())
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(|| ClaudeError::new("RUN_AUTHORIZATION_EXPIRED"))?;
    let timeout = timeout
        .min(Duration::from_millis(config.timeout_ms))
        .min(Duration::from_millis(remaining));
    let token = tokens
        .issue_once_until(driver.run_id(), &record.project_id, expires)
        .ok_or_else(|| ClaudeError::new("RUN_TOKEN_UNAVAILABLE"))?;
    let _lease = TokenLease {
        tokens,
        run: driver.run_id().into(),
    };
    let root = run_root
        .canonicalize()
        .map_err(|_| ClaudeError::new("cwd_untrusted"))?;
    if !root.is_dir() {
        return Err(ClaudeError::new("cwd_untrusted").into());
    }
    let cwd = root.join(format!("claude-{}", uuid::Uuid::new_v4()));
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = std::fs::DirBuilder::new();
        builder.mode(0o700);
        builder
    };
    #[cfg(not(unix))]
    let builder = std::fs::DirBuilder::new();
    builder
        .create(&cwd)
        .map_err(|_| ClaudeError::new("cwd_untrusted"))?;
    let _directory = RunDirectory(cwd.clone());
    if !cwd
        .canonicalize()
        .map_err(|_| ClaudeError::new("cwd_untrusted"))?
        .starts_with(&root)
    {
        return Err(ClaudeError::new("cwd_untrusted").into());
    }
    let session_id = uuid::Uuid::new_v4().to_string();
    let mut env = BTreeMap::new();
    for key in [
        "SystemRoot",
        "WINDIR",
        "USERPROFILE",
        "HOME",
        "APPDATA",
        "LOCALAPPDATA",
        "LANG",
        "LC_ALL",
    ] {
        if let Ok(value) = std::env::var(key) {
            env.insert(key.into(), value);
        }
    }
    for key in ["TEMP", "TMP", "TMPDIR"] {
        env.insert(key.into(), cwd.to_string_lossy().into_owned());
    }
    let product =
        std::env::current_exe().map_err(|_| ClaudeError::new("product_executable_invalid"))?;
    let host = launch_config(
        &config,
        &product,
        &cwd,
        &format!("http://{api_addr}"),
        &token,
        &session_id,
        env,
    )?;
    let session = protocol::Session::new(
        session_id,
        config.model_id.clone(),
        config.max_tool_turns,
        config.max_tool_result_bytes,
    );
    let completion = run_native(
        &host,
        &record.prompt,
        session,
        tokens,
        &token,
        tokio::time::Instant::now() + timeout,
        Some(driver),
    )
    .await?;
    for candidate in completion.candidates {
        let provider_event_id = crate::runtime::agent_tools::claude_candidate_event_id(&candidate)
            .map_err(|error| RunnerError::new(&error.code, &error.message))?;
        driver
            .submit_candidates(
                SubmitCandidates {
                    provider_event_id,
                    provider_seq: None,
                    raw: candidate,
                },
                Some((tokens, &token)),
            )
            .await?;
    }
    Ok(RunOutcome::Completed)
}
