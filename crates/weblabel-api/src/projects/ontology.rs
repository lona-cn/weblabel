use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Extension, Json,
};
use serde_json::{json, Value};
use sqlx::Row;

use crate::{
    auth::{error, AuthState, Principal, Role},
    projects::project_role,
};

pub(super) async fn list(
    State(state): State<AuthState>,
    Extension(principal): Extension<Principal>,
    Path(project_id): Path<String>,
) -> axum::response::Response {
    match project_role(&state, &principal.user_id, &project_id).await {
        Ok(Some(_)) => {}
        Ok(None) => {
            return error(
                StatusCode::NOT_FOUND,
                "PROJECT_NOT_FOUND",
                "Project not found",
            )
        }
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "ONTOLOGY_READ_FAILED",
                "Could not read ontologies",
            )
        }
    }
    match sqlx::query(
        "SELECT body_json FROM ontology_versions WHERE project_id=? ORDER BY version_no DESC",
    )
    .bind(&project_id)
    .fetch_all(&state.pool)
    .await
    {
        Ok(rows) => {
            let items: Result<Vec<Value>, _> = rows
                .iter()
                .map(|row| serde_json::from_str(row.get::<String, _>("body_json").as_str()))
                .collect();
            match items {
                Ok(items) => (
                    StatusCode::OK,
                    Json(json!({"items": items, "next_cursor": null})),
                )
                    .into_response(),
                Err(_) => error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "ONTOLOGY_READ_FAILED",
                    "Could not read ontologies",
                ),
            }
        }
        Err(_) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "ONTOLOGY_READ_FAILED",
            "Could not read ontologies",
        ),
    }
}

pub(super) async fn publish(
    State(state): State<AuthState>,
    Extension(principal): Extension<Principal>,
    Path(project_id): Path<String>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    match project_role(&state, &principal.user_id, &project_id).await {
        Ok(Some(Role::Admin)) => {}
        Ok(Some(_)) => {
            return error(
                StatusCode::FORBIDDEN,
                "PROJECT_ADMIN_REQUIRED",
                "Project administrator required",
            )
        }
        Ok(None) => {
            return error(
                StatusCode::NOT_FOUND,
                "PROJECT_NOT_FOUND",
                "Project not found",
            )
        }
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "ONTOLOGY_PUBLISH_FAILED",
                "Could not publish ontology",
            )
        }
    }
    let Some(labels) = body.get("labels").and_then(Value::as_array) else {
        return error(
            StatusCode::BAD_REQUEST,
            "INVALID_ONTOLOGY",
            "labels must be an array",
        );
    };
    if labels.len() > 512 || !unique_valid_labels(labels) {
        return error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_ONTOLOGY",
            "Ontology labels must have unique IDs and valid definitions",
        );
    }
    let Some(guidelines) = body.get("guidelines_markdown").and_then(Value::as_str) else {
        return error(
            StatusCode::BAD_REQUEST,
            "INVALID_ONTOLOGY",
            "guidelines_markdown is required",
        );
    };
    if guidelines.len() > 65_536 {
        return error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_ONTOLOGY",
            "Guidelines are too long",
        );
    }
    let ontology_id = uuid::Uuid::new_v4().to_string();
    let transaction = async {
        let mut tx = state.pool.begin().await?;
        let row = sqlx::query("SELECT COALESCE(MAX(version_no),0) AS version_no FROM ontology_versions WHERE project_id=?").bind(&project_id).fetch_one(&mut *tx).await?;
        let version_no: i64 = row.get("version_no");
        let version_no = version_no + 1;
        let ontology = json!({"ontology_version_id": ontology_id, "project_id": project_id, "version_no": version_no, "labels": labels, "guidelines_markdown": guidelines, "allow_out_of_bounds": false});
        let body_json = serde_json::to_string(&ontology).map_err(|error| sqlx::Error::Protocol(error.to_string()))?;
        sqlx::query("INSERT INTO ontology_versions(ontology_version_id,project_id,version_no,body_json,created_at) VALUES(?,?,?,?,?)")
            .bind(&ontology_id).bind(&project_id).bind(version_no).bind(body_json).bind(crate::projects::now_rfc3339()).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok::<Value, sqlx::Error>(ontology)
    }.await;
    match transaction {
        Ok(ontology) => (StatusCode::CREATED, Json(ontology)).into_response(),
        Err(_) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "ONTOLOGY_PUBLISH_FAILED",
            "Could not publish ontology",
        ),
    }
}

fn unique_valid_labels(labels: &[Value]) -> bool {
    let mut ids = std::collections::HashSet::with_capacity(labels.len());
    labels.iter().all(|label| {
        valid_label(label) && ids.insert(label["label_id"].as_str().unwrap_or_default())
    })
}

fn valid_label(label: &Value) -> bool {
    let Some(label_id) = label.get("label_id").and_then(Value::as_str) else {
        return false;
    };
    let Some(name) = label.get("name").and_then(Value::as_str) else {
        return false;
    };
    let Some(color) = label.get("color").and_then(Value::as_str) else {
        return false;
    };
    let Some(attributes) = label.get("attributes").and_then(Value::as_array) else {
        return false;
    };
    let Some(shortcut) = label.get("shortcut") else {
        return false;
    };
    let shortcut_valid =
        shortcut.is_null() || shortcut.as_str().is_some_and(|value| value.len() == 1);
    let mut attribute_keys = std::collections::HashSet::new();
    !label_id.is_empty()
        && label_id.len() <= 128
        && !name.trim().is_empty()
        && name.len() <= 128
        && !color.is_empty()
        && color.len() <= 32
        && shortcut_valid
        && label
            .get("allowed_geometry_types")
            .and_then(Value::as_array)
            .is_some_and(|types| types.len() == 1 && types[0] == "bbox_xyxy")
        && attributes.iter().all(|attribute| {
            valid_attribute(attribute)
                && attribute
                    .get("key")
                    .and_then(Value::as_str)
                    .is_some_and(|key| attribute_keys.insert(key))
        })
}

fn valid_attribute(attribute: &Value) -> bool {
    let Some(key) = attribute.get("key").and_then(Value::as_str) else {
        return false;
    };
    let Some(kind) = attribute.get("kind").and_then(Value::as_str) else {
        return false;
    };
    let Some(required) = attribute.get("required").and_then(Value::as_bool) else {
        return false;
    };
    let Some(default_value) = attribute.get("default_value") else {
        return false;
    };
    let Some(enum_values) = attribute.get("enum_values").and_then(Value::as_array) else {
        return false;
    };
    let Some(min) = attribute.get("min") else {
        return false;
    };
    let Some(max) = attribute.get("max") else {
        return false;
    };
    let valid_min = min.is_null() || min.as_f64().is_some_and(f64::is_finite);
    let valid_max = max.is_null() || max.as_f64().is_some_and(f64::is_finite);
    if !valid_min || !valid_max || key.is_empty() || key.len() > 128 {
        return false;
    }
    if min
        .as_f64()
        .zip(max.as_f64())
        .is_some_and(|(min, max)| min > max)
    {
        return false;
    }
    let enum_values_valid = enum_values.iter().all(Value::is_string)
        && enum_values
            .iter()
            .filter_map(Value::as_str)
            .collect::<std::collections::HashSet<_>>()
            .len()
            == enum_values.len();
    let default_valid = if default_value.is_null() {
        !required
    } else {
        match kind {
            "enum" => default_value
                .as_str()
                .is_some_and(|value| enum_values.iter().any(|item| item.as_str() == Some(value))),
            "boolean" => default_value.is_boolean(),
            "number" => {
                default_value.as_f64().is_some_and(f64::is_finite)
                    && min
                        .as_f64()
                        .is_none_or(|min| default_value.as_f64().is_some_and(|value| value >= min))
                    && max
                        .as_f64()
                        .is_none_or(|max| default_value.as_f64().is_some_and(|value| value <= max))
            }
            "text" => default_value
                .as_str()
                .is_some_and(|value| value.len() <= 4096),
            _ => false,
        }
    };
    default_valid
        && match kind {
            "enum" => {
                !enum_values.is_empty() && enum_values_valid && min.is_null() && max.is_null()
            }
            "boolean" | "text" => enum_values.is_empty() && min.is_null() && max.is_null(),
            "number" => enum_values.is_empty(),
            _ => false,
        }
}
