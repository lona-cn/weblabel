//! The five frozen semantic tools behind `POST /internal/agent-tools/{tool}`.
//!
//! Contract C5/C6: the route is authenticated exclusively by a short-lived
//! run-scoped bearer token — never by a session cookie. The run token fixes the
//! project, asset revision, annotation revision and ontology: tool arguments
//! can never switch project or address arbitrary files/URLs. Model output and
//! tool arguments are untrusted; all validation here is server-side and
//! authoritative, and `propose_changes`/`report_issues` only ever record
//! candidates through the T17 prediction funnel (`ai::predictions::
//! record_candidate`, schema + domain + capability gates). They never write
//! annotations; acceptance stays an explicit human command (T19).

use std::collections::BTreeMap;

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use image::GenericImageView;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::Row;

use annotation_domain::{
    AnnotationObject, BBox, Change, LabelDef, ModelProfile, OntologyVersion, QualityIssue,
    RunContext,
};

use crate::ai::{consent, predictions, runs};
use crate::media::ingest;
use crate::storage::Repository;

use super::run_tokens::{RunTokenGrant, RunTokenStore, TokenError};

/// The five tool names are frozen in docs/contracts.md C5.
pub const TOOL_GET_CONTEXT: &str = "get_context";
pub const TOOL_LIST_OBJECTS: &str = "list_objects";
pub const TOOL_READ_REGION: &str = "read_region";
pub const TOOL_PROPOSE_CHANGES: &str = "propose_changes";
pub const TOOL_REPORT_ISSUES: &str = "report_issues";

pub const TOOL_NAMES: [&str; 5] = [
    TOOL_GET_CONTEXT,
    TOOL_LIST_OBJECTS,
    TOOL_READ_REGION,
    TOOL_PROPOSE_CHANGES,
    TOOL_REPORT_ISSUES,
];

/// The single native schema source used by provider and MCP adapters.
/// Nested candidate types are generated from the unchanged domain wire types.
pub fn tool_definitions() -> Value {
    fn schema<T: schemars::JsonSchema>() -> Value {
        serde_json::to_value(schemars::schema_for!(T)).expect("tool schemas serialize")
    }
    let context = schema::<EmptyArgs>();
    let mut objects = schema::<ListObjectsArgs>();
    objects["properties"]["cursor"]["maxLength"] = json!(128);
    objects["properties"]["limit"] = json!({"type":"integer","minimum":1,"maximum":MAX_LIST_LIMIT});
    let mut region = schema::<ReadRegionArgs>();
    region["required"] = json!(["region"]);
    let mut changes = schema::<ProposeChangesArgs>();
    changes["properties"]["changes"]["maxItems"] = json!(MAX_CHANGES);
    changes["properties"]["issues"]["maxItems"] = json!(MAX_ISSUES);
    let mut issues = schema::<ReportIssuesArgs>();
    issues["properties"]["issues"]["minItems"] = json!(1);
    issues["properties"]["issues"]["maxItems"] = json!(MAX_ISSUES);
    json!([
        {"name":TOOL_GET_CONTEXT,"description":"Frozen run context, pinned versions and approved scope; identity cannot be switched.","inputSchema":context},
        {"name":TOOL_LIST_OBJECTS,"description":"Cursor-paginated objects from the frozen, approved run scope.","inputSchema":objects},
        {"name":TOOL_READ_REGION,"description":"Authorized canonical image or crop with its exact transform; consumes image budgets. No paths or URLs.","inputSchema":region},
        {"name":TOOL_PROPOSE_CHANGES,"description":"Submit untrusted candidate changes and issues for server validation and human review. Never writes annotations.","inputSchema":changes},
        {"name":TOOL_REPORT_ISSUES,"description":"Submit suspected quality issues for human review, never review conclusions.","inputSchema":issues}
    ])
}

/// Hard cap on a single tool request body (controlled 413 above this).
pub const MAX_TOOL_BODY_BYTES: usize = 1024 * 1024;
/// C4 caps for candidate submissions.
pub const MAX_CHANGES: usize = 1000;
pub const MAX_ISSUES: usize = 1000;
/// Bounded tool output: guidelines and label lists are capped in `get_context`.
pub const MAX_GUIDELINES_CHARS: usize = 16_384;
pub const MAX_LABELS: usize = 512;
/// `list_objects` pagination bound (C5: limit 1..100).
pub const MAX_LIST_LIMIT: u64 = 100;

/// Arguments that would override the identity fixed by the run token.
const IDENTITY_KEYS: [&str; 7] = [
    "project_id",
    "run_id",
    "asset_revision_id",
    "annotation_revision_id",
    "ontology_version_id",
    "actor_id",
    "user_id",
];

/// Arguments that would address files, URLs, grants or processes.
const FORBIDDEN_KEYS: [&str; 8] = [
    "path", "url", "file", "filename", "grant_id", "command", "argv", "cwd",
];

/// Reusable authorization boundary for both HTTP and in-process providers.
#[derive(Clone)]
pub struct AgentToolService {
    repository: Repository,
    tokens: RunTokenStore,
}

#[derive(Debug)]
pub struct AuthorizedRegion {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub width: u32,
    pub height: u32,
    pub region: Option<[u32; 4]>,
    pub transform_to_canonical: [f64; 9],
}

#[derive(Debug)]
pub enum AgentToolOutput {
    Json(Value),
    Region(AuthorizedRegion),
}

#[derive(Debug)]
pub struct AgentToolError {
    pub status: StatusCode,
    pub code: String,
    pub message: String,
    pub details: Value,
}

type ToolResult = Result<AgentToolOutput, AgentToolError>;

/// Mounts the internal agent tools route. No session middleware is attached:
/// only run-scoped bearer tokens are accepted.
pub fn router(
    repository: Repository,
    tokens: RunTokenStore,
    auth: crate::auth::AuthState,
) -> Router {
    Router::new()
        .route("/internal/agent-tools/{tool}", post(invoke_tool))
        .route_layer(middleware::from_fn_with_state(
            auth,
            crate::auth::host_and_origin,
        ))
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .with_state(AgentToolService::new(repository, tokens))
}

fn tool_failure(status: StatusCode, code: &str, message: &str) -> AgentToolError {
    AgentToolError {
        status,
        code: code.to_owned(),
        message: message.to_owned(),
        details: Value::Null,
    }
}

fn tool_error(status: StatusCode, code: &str, message: &str, details: Value) -> ToolResult {
    Err(AgentToolError {
        details,
        ..tool_failure(status, code, message)
    })
}

fn simple_error(status: StatusCode, code: &str, message: &str) -> ToolResult {
    Err(tool_failure(status, code, message))
}

fn http_result(result: ToolResult) -> Response {
    match result {
        Ok(AgentToolOutput::Json(value)) => Json(value).into_response(),
        Ok(AgentToolOutput::Region(region)) => Json(json!({
            "mime": region.mime,
            "width": region.width,
            "height": region.height,
            "region": region.region,
            "transform_to_canonical": region.transform_to_canonical,
            "data_base64": base64_encode(&region.bytes),
        }))
        .into_response(),
        Err(error) => (
            error.status,
            Json(json!({
                "code": error.code,
                "message": error.message,
                "request_id": uuid::Uuid::new_v4().to_string(),
                "details": error.details,
            })),
        )
            .into_response(),
    }
}

fn token_failure(error: TokenError) -> AgentToolError {
    let status = match error {
        TokenError::Required | TokenError::Invalid | TokenError::Expired | TokenError::Revoked => {
            StatusCode::UNAUTHORIZED
        }
        TokenError::ProjectMismatch
        | TokenError::BudgetExhausted
        | TokenError::AlreadyDispatched => StatusCode::FORBIDDEN,
    };
    tool_failure(status, error.code(), "run token rejected")
}

fn token_error(error: TokenError) -> ToolResult {
    Err(token_failure(error))
}

/// Extracts the run-scoped bearer token. Session cookies are never consulted.
fn bearer_token(headers: &HeaderMap) -> Result<&str, TokenError> {
    let header = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or(TokenError::Required)?;
    let mut parts = header.split_whitespace();
    let scheme = parts.next().ok_or(TokenError::Required)?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return Err(TokenError::Required);
    }
    let token = parts.next().ok_or(TokenError::Required)?;
    if parts.next().is_some() {
        return Err(TokenError::Required);
    }
    Ok(token)
}

fn check_argument_keys(value: &Value) -> Option<ToolResult> {
    let Some(object) = value.as_object() else {
        return Some(simple_error(
            StatusCode::BAD_REQUEST,
            "INVALID_ARGUMENTS",
            "tool arguments must be a JSON object",
        ));
    };
    for key in object.keys() {
        if IDENTITY_KEYS.contains(&key.as_str()) {
            return Some(simple_error(
                StatusCode::BAD_REQUEST,
                "IDENTITY_OVERRIDE",
                "project, run and actor identity come from the run token and cannot be overridden",
            ));
        }
        if FORBIDDEN_KEYS.contains(&key.as_str()) {
            return Some(simple_error(
                StatusCode::BAD_REQUEST,
                "FORBIDDEN_ARGUMENT",
                "tools never accept file paths, URLs, grants or commands",
            ));
        }
    }
    None
}

fn invalid_arguments(error: impl std::fmt::Display) -> ToolResult {
    simple_error(
        StatusCode::BAD_REQUEST,
        "INVALID_ARGUMENTS",
        &format!("tool arguments do not match the frozen schema: {error}"),
    )
}

// ---------------------------------------------------------------------------
// argument schemas (JSON objects with additionalProperties: false)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct EmptyArgs {}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct ListObjectsArgs {
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<u64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct ReadRegionArgs {
    region: Option<BBox>,
}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct ProposeChangesArgs {
    changes: Vec<Change>,
    #[serde(default)]
    issues: Vec<QualityIssue>,
    #[serde(default)]
    score: Option<f64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct ReportIssuesArgs {
    issues: Vec<QualityIssue>,
}

fn json_fits_budget(value: &impl Serialize, limit: usize) -> bool {
    struct Budget {
        bytes: usize,
        limit: usize,
    }
    impl std::io::Write for Budget {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.bytes = self.bytes.saturating_add(bytes.len());
            if self.bytes > self.limit {
                return Err(std::io::Error::other("JSON byte budget exceeded"));
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    serde_json::to_writer(Budget { bytes: 0, limit }, value).is_ok()
}

/// MCP tools and terminal echoes share one run-scoped semantic candidate identity.
/// Normalize only through the existing strict tool schema, without cloning raw JSON.
pub fn claude_candidate_event_id(raw: &Value) -> Result<String, AgentToolError> {
    let too_large = || {
        tool_failure(
            StatusCode::PAYLOAD_TOO_LARGE,
            "PREDICTION_TOO_LARGE",
            "raw provider output exceeds the 262144 byte cap",
        )
    };
    let invalid = || {
        tool_failure(
            StatusCode::BAD_REQUEST,
            "INVALID_ARGUMENTS",
            "Claude candidate does not match the frozen proposal schema",
        )
    };
    if !json_fits_budget(raw, predictions::MAX_RAW_OUTPUT_BYTES) {
        return Err(too_large());
    }
    let args = ProposeChangesArgs::deserialize(raw).map_err(|_| invalid())?;
    let normalized = serde_json::to_value(args).map_err(|_| invalid())?;
    if !json_fits_budget(&normalized, predictions::MAX_RAW_OUTPUT_BYTES) {
        return Err(too_large());
    }
    let hash = annotation_domain::hash::execution_configuration_hash(&normalized)
        .map_err(|_| invalid())?;
    Ok(format!("claude-candidate-{hash}"))
}

// ---------------------------------------------------------------------------
// run-scoped read model
// ---------------------------------------------------------------------------

struct RunFacts {
    record: runs::RunRecord,
    context: RunContext,
    profile: ModelProfile,
    width: u32,
    height: u32,
    original_to_canonical: Vec<f64>,
    labels: Vec<LabelDef>,
    guidelines_markdown: String,
    objects: BTreeMap<String, AnnotationObject>,
    grants: annotation_domain::AiApprovedGrants,
    ontology: OntologyVersion,
}

async fn load_facts(
    repository: &Repository,
    grant: &RunTokenGrant,
    submission: bool,
) -> Result<RunFacts, AgentToolError> {
    let mut tx = repository.begin_write().await.map_err(|_| {
        tool_failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "STORAGE_UNAVAILABLE",
            "could not read the frozen run context",
        )
    })?;
    let record = runs::load_record(tx.connection(), &grant.run_id)
        .await
        .map_err(|_| {
            tool_failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "STORAGE_UNAVAILABLE",
                "could not read the frozen run context",
            )
        })?
        .ok_or_else(|| {
            tool_failure(
                StatusCode::UNAUTHORIZED,
                "RUN_TOKEN_INVALID",
                "run token does not name a live run",
            )
        })?;
    if record.project_id != grant.project_id {
        return Err(token_failure(TokenError::ProjectMismatch));
    }
    if record.cancel_requested {
        return Err(token_failure(TokenError::Revoked));
    }
    if matches!(
        record.state,
        runs::RunState::Cancelled | runs::RunState::Interrupted
    ) {
        return Err(token_failure(TokenError::Revoked));
    }
    let authorization = if submission {
        consent::authorize_submission(tx.connection(), &record).await
    } else {
        consent::authorize_run(tx.connection(), &record).await
    };
    let grants = authorization
        .map_err(|failure| tool_failure(failure.status, failure.code, &failure.message))?;

    let context = record.context().map_err(|_| {
        tool_failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "RUN_CONTEXT_INVALID",
            "the stored run context cannot be decoded",
        )
    })?;
    let profile: ModelProfile =
        serde_json::from_str(&record.profile_snapshot_json).map_err(|_| {
            tool_failure(
                StatusCode::INTERNAL_SERVER_ERROR,
                "RUN_CONTEXT_INVALID",
                "the stored profile snapshot cannot be decoded",
            )
        })?;

    let media_row = sqlx::query(
        "SELECT canonical_width, canonical_height, original_to_canonical_json \
         FROM media_metadata WHERE asset_revision_id=?",
    )
    .bind(&record.asset_revision_id)
    .fetch_optional(tx.connection())
    .await
    .map_err(|_| storage_unavailable())?
    .ok_or_else(|| {
        tool_failure(
            StatusCode::NOT_FOUND,
            "MEDIA_NOT_FOUND",
            "the run's pinned media revision is gone",
        )
    })?;
    let width: i64 = media_row
        .try_get("canonical_width")
        .map_err(|_| storage_unavailable())?;
    let height: i64 = media_row
        .try_get("canonical_height")
        .map_err(|_| storage_unavailable())?;
    let matrix_json: String = media_row
        .try_get("original_to_canonical_json")
        .map_err(|_| storage_unavailable())?;
    let original_to_canonical: Vec<f64> = serde_json::from_str(&matrix_json)
        .unwrap_or_else(|_| vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);

    let ontology_json: Option<String> = sqlx::query_scalar(
        "SELECT body_json FROM ontology_versions WHERE ontology_version_id=? AND project_id=?",
    )
    .bind(&record.ontology_version_id)
    .bind(&record.project_id)
    .fetch_optional(tx.connection())
    .await
    .map_err(|_| storage_unavailable())?;
    let ontology: OntologyVersion = serde_json::from_str(&ontology_json.ok_or_else(|| {
        tool_failure(
            StatusCode::NOT_FOUND,
            "ONTOLOGY_NOT_FOUND",
            "the run's pinned ontology version is gone",
        )
    })?)
    .map_err(|_| {
        tool_failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "RUN_CONTEXT_INVALID",
            "the pinned ontology cannot be decoded",
        )
    })?;

    let annotation_json: Option<String> = sqlx::query_scalar(
        "SELECT body_json FROM annotation_revisions WHERE annotation_revision_id=? AND project_id=?",
    )
    .bind(&record.annotation_revision_id)
    .bind(&record.project_id)
    .fetch_optional(tx.connection())
    .await
    .map_err(|_| storage_unavailable())?;
    let document: annotation_domain::AnnotationDocument =
        serde_json::from_str(&annotation_json.ok_or_else(|| {
            tool_failure(
                StatusCode::NOT_FOUND,
                "REVISION_NOT_FOUND",
                "the run's pinned annotation revision is gone",
            )
        })?)
        .map_err(|_| {
            tool_failure(
                StatusCode::INTERNAL_SERVER_ERROR,
                "RUN_CONTEXT_INVALID",
                "the pinned annotation revision cannot be decoded",
            )
        })?;
    tx.commit().await.map_err(|_| storage_unavailable())?;

    let mut objects = BTreeMap::new();
    for object in document.objects {
        if grants.allow_object_context
            && (context.selected_object_ids.is_empty()
                || context.selected_object_ids.contains(&object.object_id))
        {
            objects.insert((*object.object_id).to_owned(), object);
        }
    }
    Ok(RunFacts {
        record,
        context,
        profile,
        width: u32::try_from(width).unwrap_or(1),
        height: u32::try_from(height).unwrap_or(1),
        original_to_canonical,
        labels: ontology.labels.clone(),
        guidelines_markdown: ontology.guidelines_markdown.clone(),
        ontology,

        grants,
        objects,
    })
}

fn storage_unavailable() -> AgentToolError {
    tool_failure(
        StatusCode::SERVICE_UNAVAILABLE,
        "STORAGE_UNAVAILABLE",
        "could not read the frozen run context",
    )
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

async fn invoke_tool(
    State(service): State<AgentToolService>,
    Path(tool): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let token = match bearer_token(&headers) {
        Ok(token) => token,
        Err(error) => return http_result(token_error(error)),
    };
    // Preserve the HTTP boundary's error ordering and original wire budget.
    if !TOOL_NAMES.contains(&tool.as_str()) {
        return http_result(simple_error(
            StatusCode::NOT_FOUND,
            "UNKNOWN_TOOL",
            "only the five frozen semantic tools are available",
        ));
    }
    if body.len() > MAX_TOOL_BODY_BYTES {
        return http_result(simple_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "TOOL_PAYLOAD_TOO_LARGE",
            "tool arguments exceed the 1 MiB request budget",
        ));
    }
    let arguments = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(error) => return http_result(invalid_arguments(error)),
    };
    http_result(service.invoke_checked(token, &tool, &arguments).await)
}

impl AgentToolService {
    pub fn new(repository: Repository, tokens: RunTokenStore) -> Self {
        Self { repository, tokens }
    }

    pub async fn invoke(
        &self,
        token: &str,
        name: &str,
        arguments: &Value,
    ) -> Result<AgentToolOutput, AgentToolError> {
        if !TOOL_NAMES.contains(&name) {
            return simple_error(
                StatusCode::NOT_FOUND,
                "UNKNOWN_TOOL",
                "only the five frozen semantic tools are available",
            );
        }
        // Count serialized bytes without allocating another potentially large JSON buffer.
        if !json_fits_budget(arguments, MAX_TOOL_BODY_BYTES) {
            return simple_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "TOOL_PAYLOAD_TOO_LARGE",
                "tool arguments exceed the 1 MiB request budget",
            );
        }
        self.invoke_checked(token, name, arguments).await
    }

    // Private boundary: caller has already checked the tool name and byte budget.
    // HTTP measures its original wire bytes, avoiding a second serialization.
    async fn invoke_checked(&self, token: &str, name: &str, arguments: &Value) -> ToolResult {
        if let Some(result) = check_argument_keys(arguments) {
            return result;
        }
        let grant = self.tokens.verify(token).map_err(token_failure)?;
        let facts = load_facts(
            &self.repository,
            &grant,
            matches!(name, TOOL_PROPOSE_CHANGES | TOOL_REPORT_ISSUES),
        )
        .await?;
        match name {
            TOOL_GET_CONTEXT => get_context(&facts, arguments),
            TOOL_LIST_OBJECTS => list_objects(&facts, arguments),
            TOOL_READ_REGION => read_region(self, token, &facts, arguments).await,
            TOOL_PROPOSE_CHANGES => {
                submit_candidates(self, token, &facts, arguments, CandidateKind::Changes).await
            }
            TOOL_REPORT_ISSUES => {
                submit_candidates(self, token, &facts, arguments, CandidateKind::Issues).await
            }
            _ => unreachable!("tool names were checked above"),
        }
    }
}

// ---------------------------------------------------------------------------
// get_context
// ---------------------------------------------------------------------------

fn get_context(facts: &RunFacts, arguments: &Value) -> ToolResult {
    // get_context accepts exactly `{}`: nothing about the run can be selected.
    match serde_json::from_value::<EmptyArgs>(arguments.clone()) {
        Ok(_) => {}
        Err(error) => return invalid_arguments(error),
    }
    let guidelines_truncated = facts.guidelines_markdown.chars().count() > MAX_GUIDELINES_CHARS;
    let guidelines: String = facts
        .guidelines_markdown
        .chars()
        .take(MAX_GUIDELINES_CHARS)
        .collect();
    let mut visible_context = facts.context.clone();
    if !facts.grants.allow_object_context {
        visible_context.selected_object_ids.clear();
        visible_context.object_hashes.clear();
    } else if !visible_context.selected_object_ids.is_empty() {
        visible_context
            .object_hashes
            .retain(|id, _| visible_context.selected_object_ids.contains(id));
    }
    Ok(AgentToolOutput::Json(json!({
        "run_id": facts.record.run_id,
        "project_id": facts.record.project_id,
        "intent": facts.record.intent,

        "prompt": facts.record.prompt,
        "context": visible_context,
        "approved_grant_ids": if facts.grants.allow_image {vec![format!("image:{}",facts.record.run_id)]} else {vec![]},
        "approved_image_region": facts.grants.preview_crop,
        "allow_image": facts.grants.allow_image,
        "allow_object_context": facts.grants.allow_object_context,
        "media": {
            "canonical_sha256": facts.context.canonical_sha256,
            "width": facts.width,
            "height": facts.height,
            "original_to_canonical": facts.original_to_canonical,
        },
        "ontology": {
            "ontology_version_id": facts.context.ontology_version_id,
            "project_id": facts.ontology.project_id,
            "version_no": facts.ontology.version_no,
            "allow_out_of_bounds": facts.ontology.allow_out_of_bounds,
            "guidelines_markdown": guidelines,
            "guidelines_truncated": guidelines_truncated,
            "labels": facts.labels.iter().take(MAX_LABELS).collect::<Vec<_>>(),
            "labels_truncated": facts.labels.len() > MAX_LABELS,
        },
    })))
}

// ---------------------------------------------------------------------------
// list_objects
// ---------------------------------------------------------------------------

fn list_objects(facts: &RunFacts, arguments: &Value) -> ToolResult {
    if !facts.grants.allow_object_context {
        return simple_error(
            StatusCode::FORBIDDEN,
            "OBJECT_CONTEXT_NOT_APPROVED",
            "Object context was not approved",
        );
    }
    // The advertised schema types limit as integer 1..100: an explicit null is
    // out of that domain even though an absent key falls back to 50.
    if arguments.get("limit") == Some(&Value::Null) {
        return simple_error(
            StatusCode::BAD_REQUEST,
            "INVALID_ARGUMENTS",
            "limit must be an integer between 1 and 100",
        );
    }
    let args: ListObjectsArgs = match serde_json::from_value(arguments.clone()) {
        Ok(args) => args,
        Err(error) => return invalid_arguments(error),
    };
    let limit = args.limit.unwrap_or(50);
    if limit == 0 || limit > MAX_LIST_LIMIT {
        return simple_error(
            StatusCode::BAD_REQUEST,
            "INVALID_ARGUMENTS",
            "limit must be between 1 and 100",
        );
    }
    if let Some(cursor) = &args.cursor {
        if cursor.chars().count() > 128 {
            return simple_error(
                StatusCode::BAD_REQUEST,
                "INVALID_ARGUMENTS",
                "cursor must be at most 128 characters",
            );
        }
    }

    // Scope: the run's frozen selection, or every object of the pinned revision.
    let scoped: Vec<&AnnotationObject> = if facts.context.selected_object_ids.is_empty() {
        facts.objects.values().collect()
    } else {
        facts
            .context
            .selected_object_ids
            .iter()
            .filter_map(|id| facts.objects.get(&**id))
            .collect()
    };
    let start = match &args.cursor {
        Some(cursor) => scoped
            .iter()
            .position(|object| {
                let id: &str = &object.object_id;
                id > cursor.as_str()
            })
            .unwrap_or(scoped.len()),
        None => 0,
    };
    let end = (start + limit as usize).min(scoped.len());
    let items: Vec<Value> = scoped[start..end]
        .iter()
        .map(|object| {
            let object_id = (*object.object_id).to_owned();
            let hash = facts
                .context
                .object_hashes
                .get(&object.object_id)
                .cloned()
                .unwrap_or_else(|| annotation_domain::object_hash(object));
            json!({
                "object": object,
                "object_id": object_id,
                "label_id": object.label_id,
                "bbox": object.geometry,
                "attributes": object.attributes,
                "object_hash": hash,
            })
        })
        .collect();
    let next_cursor = if end < scoped.len() {
        items
            .last()
            .and_then(|item| item["object_id"].as_str().map(str::to_owned))
    } else {
        None
    };
    Ok(AgentToolOutput::Json(
        json!({ "items": items, "next_cursor": next_cursor }),
    ))
}

// ---------------------------------------------------------------------------
// read_region
// ---------------------------------------------------------------------------

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = u32::from(*chunk.get(1).unwrap_or(&0));
        let b2 = u32::from(*chunk.get(2).unwrap_or(&0));
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(char::from(ALPHABET[(triple >> 18 & 63) as usize]));
        out.push(char::from(ALPHABET[(triple >> 12 & 63) as usize]));
        out.push(if chunk.len() > 1 {
            char::from(ALPHABET[(triple >> 6 & 63) as usize])
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            char::from(ALPHABET[(triple & 63) as usize])
        } else {
            '='
        });
    }
    out
}

async fn read_region(
    state: &AgentToolService,
    token: &str,
    facts: &RunFacts,
    arguments: &Value,
) -> ToolResult {
    if !arguments
        .as_object()
        .is_some_and(|object| object.contains_key("region"))
    {
        return simple_error(
            StatusCode::BAD_REQUEST,
            "INVALID_ARGUMENTS",
            "read_region requires an explicit region key (null for the full image)",
        );
    }
    let args: ReadRegionArgs = match serde_json::from_value(arguments.clone()) {
        Ok(args) => args,
        Err(error) => return invalid_arguments(error),
    };

    if !facts.grants.allow_image {
        return simple_error(
            StatusCode::FORBIDDEN,
            "IMAGE_NOT_APPROVED",
            "Image access was not approved",
        );
    }
    if let Some(approved) = &facts.grants.preview_crop {
        let Some(region) = &args.region else {
            return simple_error(
                StatusCode::FORBIDDEN,
                "REGION_NOT_APPROVED",
                "Full image access was not approved",
            );
        };
        // Enforce actual encoded pixel footprint, not merely floating point input.
        if region.x_min.floor() < approved.x_min
            || region.y_min.floor() < approved.y_min
            || region.x_max.ceil() > approved.x_max
            || region.y_max.ceil() > approved.y_max
        {
            return simple_error(
                StatusCode::FORBIDDEN,
                "REGION_NOT_APPROVED",
                "Requested pixels exceed the approved ROI",
            );
        }
    }
    let canonical_png = match ingest::load_canonical_png(
        &state.repository,
        &facts.record.project_id,
        &facts.record.asset_revision_id,
    )
    .await
    {
        Ok(bytes) => bytes,
        Err(_) => {
            return simple_error(
                StatusCode::BAD_REQUEST,
                "IMAGE_UNAVAILABLE",
                "the pinned canonical image is unavailable",
            )
        }
    };

    let Some(region) = args.region else {
        if let Err(error) = state.tokens.charge_full_image_read(token) {
            return token_error(error);
        }
        let (width, height) = (facts.width, facts.height);
        return Ok(AgentToolOutput::Region(AuthorizedRegion {
            bytes: canonical_png,
            mime: "image/png".to_owned(),
            width,
            height,
            region: None,
            transform_to_canonical: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
        }));
    };

    // Bounded coordinates only: the region must lie inside the canonical image.
    let coordinates = [region.x_min, region.y_min, region.x_max, region.y_max];
    let width = f64::from(facts.width);
    let height = f64::from(facts.height);
    if coordinates.iter().any(|value| !value.is_finite())
        || region.x_min < 0.0
        || region.y_min < 0.0
        || region.x_max <= region.x_min
        || region.y_max <= region.y_min
        || region.x_max > width
        || region.y_max > height
    {
        return simple_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_REGION",
            "region must be a non-degenerate box inside the canonical image",
        );
    }
    let x0 = region.x_min.floor().clamp(0.0, width) as u32;
    let y0 = region.y_min.floor().clamp(0.0, height) as u32;
    let x1 = region.x_max.ceil().clamp(0.0, width) as u32;
    let y1 = region.y_max.ceil().clamp(0.0, height) as u32;
    let crop_width = x1 - x0;
    let crop_height = y1 - y0;
    let pixels = u64::from(crop_width) * u64::from(crop_height);
    if let Err(error) = state.tokens.charge_crop_read(token, pixels) {
        return token_error(error);
    }

    let decoded = match image::load_from_memory(&canonical_png) {
        Ok(image) => image.to_rgba8(),
        Err(_) => {
            return simple_error(
                StatusCode::BAD_REQUEST,
                "IMAGE_UNAVAILABLE",
                "the pinned canonical image cannot be decoded",
            )
        }
    };
    let crop = decoded.view(x0, y0, crop_width, crop_height).to_image();
    let mut encoded = std::io::Cursor::new(Vec::new());
    if image::DynamicImage::ImageRgba8(crop)
        .write_to(&mut encoded, image::ImageFormat::Png)
        .is_err()
    {
        return simple_error(
            StatusCode::BAD_REQUEST,
            "IMAGE_UNAVAILABLE",
            "the requested crop cannot be encoded",
        );
    }
    Ok(AgentToolOutput::Region(AuthorizedRegion {
        bytes: encoded.into_inner(),
        mime: "image/png".to_owned(),
        width: crop_width,
        height: crop_height,
        region: Some([x0, y0, x1, y1]),
        // Crop pixels to canonical pixels: translation by the crop origin.
        transform_to_canonical: [
            1.0,
            0.0,
            f64::from(x0),
            0.0,
            1.0,
            f64::from(y0),
            0.0,
            0.0,
            1.0,
        ],
    }))
}

// ---------------------------------------------------------------------------
// propose_changes / report_issues
// ---------------------------------------------------------------------------

enum CandidateKind {
    Changes,
    Issues,
}

async fn submit_candidates(
    state: &AgentToolService,
    token: &str,
    facts: &RunFacts,
    arguments: &Value,
    kind: CandidateKind,
) -> ToolResult {
    let raw = match kind {
        CandidateKind::Changes => {
            let args: ProposeChangesArgs = match ProposeChangesArgs::deserialize(arguments) {
                Ok(args) => args,
                Err(error) => return invalid_arguments(error),
            };
            if args.changes.is_empty() && args.issues.is_empty() {
                return simple_error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "EMPTY_SUBMISSION",
                    "changes must contain at least one candidate",
                );
            }
            if args.changes.len() > MAX_CHANGES || args.issues.len() > MAX_ISSUES {
                return simple_error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "TOO_MANY_CHANGES",
                    "a suggestion set may contain at most 1000 changes",
                );
            }
            json!({ "changes": args.changes, "issues": args.issues, "score": args.score })
        }
        CandidateKind::Issues => {
            let args: ReportIssuesArgs = match ReportIssuesArgs::deserialize(arguments) {
                Ok(args) => args,
                Err(error) => return invalid_arguments(error),
            };
            if args.issues.is_empty() {
                return simple_error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "EMPTY_SUBMISSION",
                    "issues must contain at least one entry",
                );
            }
            if args.issues.len() > MAX_ISSUES {
                return simple_error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "TOO_MANY_ISSUES",
                    "a suggestion set may contain at most 1000 issues",
                );
            }
            json!({ "changes": [], "issues": args.issues, "score": null })
        }
    };

    let changes_count = raw["changes"].as_array().map_or(0, Vec::len);
    let issues_count = raw["issues"].as_array().map_or(0, Vec::len);
    let target = predictions::CandidateTarget {
        width: facts.width,
        height: facts.height,
        labels: &facts.labels,
        objects: &facts.objects,
    };
    let submit = predictions::SubmitCandidates {
        provider_event_id: if facts.record.provider_id == "claude_local" {
            claude_candidate_event_id(&raw)?
        } else {
            uuid::Uuid::new_v4().to_string()
        },
        provider_seq: None,
        raw,
    };

    let mut tx = match state.repository.begin_write().await {
        Ok(tx) => tx,
        Err(_) => return Err(storage_unavailable()),
    };
    state.tokens.verify(token).map_err(token_failure)?;
    let live = match runs::load_record(tx.connection(), &facts.record.run_id).await {
        Ok(Some(record)) => record,
        _ => return Err(storage_unavailable()),
    };
    let grants = match consent::authorize_submission(tx.connection(), &live).await {
        Ok(grants) => grants,
        Err(failure) => return simple_error(failure.status, failure.code, &failure.message),
    };
    if let Err(failure) = consent::validate_candidate_scope(&grants, &facts.context, &submit.raw) {
        return simple_error(failure.status, failure.code, &failure.message);
    }
    let outcome = match predictions::record_candidate(
        tx.connection(),
        &facts.record,
        &facts.profile,
        &target,
        &submit,
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(_) => return Err(storage_unavailable()),
    };
    if state
        .tokens
        .admit_if_live(token, tx.commit())
        .await
        .map_err(token_failure)?
        .is_err()
    {
        return Err(storage_unavailable());
    }

    match outcome {
        predictions::CandidateOutcome::Applied {
            prediction_id,
            suggestion_set_id,
        } => Ok(AgentToolOutput::Json(json!({
            "suggestion_set_id": suggestion_set_id,
            "prediction_id": prediction_id,
            "state": "pending",
            "changes_count": changes_count,
            "issues_count": issues_count,
        }))),
        predictions::CandidateOutcome::Duplicate => simple_error(
            StatusCode::CONFLICT,
            "DUPLICATE_CANDIDATE",
            "this candidate was already recorded",
        ),
        predictions::CandidateOutcome::Quarantined { audit_id } => tool_error(
            StatusCode::CONFLICT,
            "RUN_TERMINAL_QUARANTINED",
            "the run is finished; the candidate was quarantined and never applied",
            json!({ "audit_id": audit_id }),
        ),
        predictions::CandidateOutcome::Rejected { code, message } => {
            simple_error(StatusCode::UNPROCESSABLE_ENTITY, code, &message)
        }
    }
}

#[cfg(test)]
mod service_boundary_tests {
    use super::*;

    #[tokio::test]
    async fn http_region_adapter_preserves_integer_crop_and_transform() {
        let response = http_result(Ok(AgentToolOutput::Region(AuthorizedRegion {
            bytes: vec![0, 1, 2, 255],
            mime: "image/png".into(),
            width: 3,
            height: 4,
            region: Some([7, 11, 10, 15]),
            transform_to_canonical: [1.0, 0.0, 7.0, 0.0, 1.0, 11.0, 0.0, 0.0, 1.0],
        })));
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["data_base64"], "AAEC/w==");
        assert_eq!(value["region"], json!([7, 11, 10, 15]));
        assert_eq!(
            value["transform_to_canonical"],
            json!([1.0, 0.0, 7.0, 0.0, 1.0, 11.0, 0.0, 0.0, 1.0])
        );
        assert_eq!(value["width"], 3);
        assert_eq!(value["height"], 4);
    }

    #[test]
    fn internal_argument_guards_do_not_depend_on_http() {
        for (arguments, code) in [
            (json!({"project_id":"other"}), "IDENTITY_OVERRIDE"),
            (json!({"path":"private.png"}), "FORBIDDEN_ARGUMENT"),
            (json!([]), "INVALID_ARGUMENTS"),
        ] {
            let error = check_argument_keys(&arguments).unwrap().unwrap_err();
            assert_eq!(error.status, StatusCode::BAD_REQUEST);
            assert_eq!(error.code, code);
            assert!(error.details.is_null());
        }
        assert!(
            serde_json::from_value::<ReadRegionArgs>(json!({"region":null,"url":"file:///x"}))
                .is_err()
        );
        assert!(serde_json::from_value::<ListObjectsArgs>(json!({"limit":1.5})).is_err());
    }
}
