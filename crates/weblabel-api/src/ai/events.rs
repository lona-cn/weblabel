//! Provider event stream: server-side monotonic sequence numbers, duplicate
//! normalization, explicit retention and `after=seq` polling.

use annotation_domain::RunEvent;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Row, SqliteConnection};

use crate::{
    ai::{failure_response, redact_json, redact_text, runs, AiState},
    auth::Principal,
};

pub use annotation_domain::RunEventType;

/// Retention budget per run: the most recent events are kept, older ones are
/// pruned at write time so a long-running run cannot grow without bound.
pub const MAX_EVENTS_PER_RUN: i64 = 2000;
pub const EVENTS_PAGE_DEFAULT: usize = 100;
pub const EVENTS_PAGE_MAX: usize = 200;
pub const MAX_EVENT_MESSAGE_CHARS: usize = 2048;
pub const MAX_EVENT_DATA_BYTES: usize = 16 * 1024;

/// An event as delivered by a provider channel, before normalization.
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderEvent {
    pub provider_event_id: String,
    pub provider_seq: Option<i64>,
    pub event_type: RunEventType,
    pub message: String,
    pub data: Option<Value>,
}

/// A normalized event ready for persistence. Server-generated lifecycle events
/// carry no provider identity.
#[derive(Debug, Clone)]
pub struct RecordEvent<'a> {
    pub provider_event_id: Option<&'a str>,
    pub provider_seq: Option<i64>,
    pub event_type: RunEventType,
    pub message: &'a str,
    pub data: Option<Value>,
}

/// Persists one event with a server-assigned monotonic sequence number.
/// Returns `false` when a duplicate provider event was dropped.
pub async fn record(
    connection: &mut SqliteConnection,
    run_id: &str,
    event: RecordEvent<'_>,
) -> Result<bool, sqlx::Error> {
    if let Some(provider_event_id) = event.provider_event_id {
        let duplicate = sqlx::query_scalar::<_, i64>(
            "SELECT EXISTS(SELECT 1 FROM run_events WHERE run_id=? AND provider_event_id=?)",
        )
        .bind(run_id)
        .bind(provider_event_id)
        .fetch_one(&mut *connection)
        .await?;
        if duplicate != 0 {
            return Ok(false);
        }
    }
    let seq: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(seq), 0) + 1 FROM run_events WHERE run_id=?")
            .bind(run_id)
            .fetch_one(&mut *connection)
            .await?;
    let mut message = redact_text(event.message);
    if message.chars().count() > MAX_EVENT_MESSAGE_CHARS {
        message = message.chars().take(MAX_EVENT_MESSAGE_CHARS).collect();
        message.push_str("…[truncated]");
    }
    let data_json = match event.data {
        Some(mut data) => {
            redact_json(&mut data);
            let serialized = serde_json::to_string(&data).unwrap_or_else(|_| "{}".to_owned());
            if serialized.len() > MAX_EVENT_DATA_BYTES {
                Some(json!({"dropped": "event_data_too_large"}).to_string())
            } else {
                Some(serialized)
            }
        }
        None => None,
    };
    sqlx::query(
        "INSERT INTO run_events(run_id, seq, event_type, message, data_json, provider_event_id, provider_seq, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(run_id)
    .bind(seq)
    .bind(event_type_str(event.event_type))
    .bind(&message)
    .bind(&data_json)
    .bind(event.provider_event_id)
    .bind(event.provider_seq)
    .bind(crate::projects::now_rfc3339())
    .execute(&mut *connection)
    .await?;
    if seq > MAX_EVENTS_PER_RUN {
        sqlx::query("DELETE FROM run_events WHERE run_id=? AND seq <= ?")
            .bind(run_id)
            .bind(seq - MAX_EVENTS_PER_RUN)
            .execute(&mut *connection)
            .await?;
    }
    Ok(true)
}

/// Preserve the last controlled named-API observation on the single service
/// lifecycle event, including immediate cancellation before response headers.
pub(crate) async fn terminal_data(
    connection: &mut SqliteConnection,
    record: &runs::RunRecord,
    code: Option<&str>,
    extra: Option<Value>,
) -> Result<Option<Value>, sqlx::Error> {
    if !matches!(
        record.provider_id.as_str(),
        "openai_api" | "anthropic_api" | "mimo_api"
    ) {
        return Ok(extra);
    }
    let mut data = match extra {
        Some(Value::Object(data)) => data,
        Some(other) => return Ok(Some(other)),
        None => serde_json::Map::new(),
    };
    // A failed checkpoint is not evidence of zero requests, nor proof that an
    // older snapshot describes the latest attempt. Keep prior progress in the
    // history, but explicitly withhold a falsely complete terminal observation.
    if code == Some("event_checkpoint_failed")
        || data.get("dropped").and_then(Value::as_str) == Some("observation_checkpoint_unconfirmed")
    {
        for key in ["receipts", "receipt", "usage", "cost_display"] {
            data.remove(key);
        }
        data.insert(
            "dropped".to_owned(),
            Value::String("observation_checkpoint_unconfirmed".to_owned()),
        );
        if let Some(code) = code {
            data.insert("error_code".to_owned(), Value::String(code.to_owned()));
        }
        return Ok(Some(Value::Object(data)));
    }
    let observed: Option<String> = sqlx::query_scalar(
        "SELECT data_json FROM run_events WHERE run_id=? AND event_type='progress' \
         AND message='provider observation checkpoint' AND data_json IS NOT NULL ORDER BY seq DESC LIMIT 1",
    ).bind(&record.run_id).fetch_optional(&mut *connection).await?;
    // Local configuration/budget rejection has no upstream observation. Preserve
    // the controlled empty envelope, without overwriting terminal evidence or
    // turning an explicitly dropped checkpoint into a false zero-attempt claim.
    if observed.is_none() {
        data.entry("receipts")
            .or_insert_with(|| Value::Array(Vec::new()));
        data.entry("receipt").or_insert(Value::Null);
        data.entry("usage").or_insert_with(|| {
            serde_json::json!({
                "input_tokens": null, "output_tokens": null, "cost_usd": null,
            })
        });
        data.entry("cost_display")
            .or_insert_with(|| Value::String("unknown".to_owned()));
    }
    if let Some(raw) = observed.filter(|raw| raw.len() <= MAX_EVENT_DATA_BYTES) {
        if let Ok(Value::Object(mut observation)) = serde_json::from_str(&raw) {
            observation.retain(|key, _| {
                matches!(
                    key.as_str(),
                    "receipts" | "receipt" | "usage" | "cost_display" | "dropped"
                )
            });
            // An observed cost classification must not be replaced by the
            // generic cancellation row's unknown classification.
            data.extend(observation);
        }
    }
    if let Some(code) = code {
        data.insert("error_code".to_owned(), Value::String(code.to_owned()));
    }
    Ok(if data.is_empty() {
        None
    } else {
        Some(Value::Object(data))
    })
}

pub(crate) const fn event_type_str(event_type: RunEventType) -> &'static str {
    match event_type {
        RunEventType::Queued => "queued",
        RunEventType::Started => "started",
        RunEventType::Progress => "progress",
        RunEventType::ToolCall => "tool_call",
        RunEventType::Candidate => "candidate",
        RunEventType::Succeeded => "succeeded",
        RunEventType::Failed => "failed",
        RunEventType::Cancelled => "cancelled",
    }
}

#[derive(Deserialize)]
pub(super) struct ListQuery {
    after: Option<String>,
    limit: Option<usize>,
}

pub(super) async fn list(
    State(state): State<AiState>,
    Path(run_id): Path<String>,
    Query(query): Query<ListQuery>,
    Extension(principal): Extension<Principal>,
) -> Response {
    let after = match query.after {
        Some(after) => match after.parse::<i64>() {
            Ok(after) if after >= 0 => after,
            _ => {
                return failure_response(
                    StatusCode::BAD_REQUEST,
                    "INVALID_EVENTS_QUERY",
                    "after must be a non-negative sequence number",
                )
            }
        },
        None => 0,
    };
    let limit = query.limit.unwrap_or(EVENTS_PAGE_DEFAULT);
    if limit == 0 || limit > EVENTS_PAGE_MAX {
        return failure_response(
            StatusCode::BAD_REQUEST,
            "INVALID_EVENTS_QUERY",
            "limit must be between 1 and 200",
        );
    }
    let summary =
        match runs::load_visible_summary(&state.repository, &run_id, &principal.user_id, false)
            .await
        {
            Ok(summary) => summary,
            Err(failure) => return failure.into_response(),
        };
    let mut tx = match state.repository.begin_write().await {
        Ok(tx) => tx,
        Err(_) => {
            return failure_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "EVENTS_READ_FAILED",
                "Could not read run events",
            )
        }
    };
    let rows = match sqlx::query(
        "SELECT seq, event_type, message, data_json FROM run_events \
         WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?",
    )
    .bind(&run_id)
    .bind(after)
    .bind(limit as i64)
    .fetch_all(tx.connection())
    .await
    {
        Ok(rows) => rows,
        Err(_) => {
            return failure_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "EVENTS_READ_FAILED",
                "Could not read run events",
            )
        }
    };
    tx.commit().await.ok();
    let mut items = Vec::with_capacity(rows.len());
    for row in &rows {
        let seq: i64 = row.try_get("seq").unwrap_or(0);
        let event_type: String = row.try_get("event_type").unwrap_or_default();
        let message: String = row.try_get("message").unwrap_or_default();
        let data_json: Option<String> = row.try_get("data_json").unwrap_or(None);
        let data = data_json.and_then(|json| serde_json::from_str(&json).ok());
        items.push(RunEvent {
            run_id: annotation_domain::Id::from(run_id.clone()),
            seq: u64::try_from(seq).unwrap_or(0),
            event_type: parse_event_type(&event_type).unwrap_or(RunEventType::Progress),
            message,
            data,
        });
    }
    let next_cursor = if items.len() == limit {
        items.last().map(|event| event.seq.to_string())
    } else {
        None
    };
    (
        StatusCode::OK,
        Json(json!({"run": summary, "items": items, "next_cursor": next_cursor})),
    )
        .into_response()
}

fn parse_event_type(value: &str) -> Option<RunEventType> {
    match value {
        "queued" => Some(RunEventType::Queued),
        "started" => Some(RunEventType::Started),
        "progress" => Some(RunEventType::Progress),
        "tool_call" => Some(RunEventType::ToolCall),
        "candidate" => Some(RunEventType::Candidate),
        "succeeded" => Some(RunEventType::Succeeded),
        "failed" => Some(RunEventType::Failed),
        "cancelled" => Some(RunEventType::Cancelled),
        _ => None,
    }
}
