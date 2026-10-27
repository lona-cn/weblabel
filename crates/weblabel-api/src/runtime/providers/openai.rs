//! OpenAI Responses wire adapter; never Chat Completions compatibility.
use super::http::{tools, Call, HttpError, ResponseItem, ResponsePart, Turn, SYSTEM_TEXT};
use serde_json::{json, Value};

pub fn request(config: &Value, input: &[Value], tokens: u64) -> Value {
    request_with_labels(config, input, tokens, &[])
}
pub(crate) fn request_with_labels(
    config: &Value,
    input: &[Value],
    tokens: u64,
    labels: &[annotation_domain::LabelDef],
) -> Value {
    let definitions=tools().iter().map(|t|json!({"type":"function","name":t["name"],"description":t["description"],"parameters":strict_schema(&t["inputSchema"],&t["inputSchema"],labels,false),"strict":true})).collect::<Vec<_>>();
    json!({"model":config["model_id"],"stream":true,"store":false,"include":["reasoning.encrypted_content"],"max_output_tokens":tokens,"instructions":SYSTEM_TEXT,"input":input,"tools":definitions,"tool_choice":"auto"})
}
// Project, never duplicate, the authoritative tool schema. Strict Responses
// requires all properties, closed objects and explicit null omission markers.
// Attribute dictionaries are closed over the frozen ontology, as in the old
// adapter; the real domain validator remains authoritative after decoding.
fn strict_schema(
    schema: &Value,
    root: &Value,
    labels: &[annotation_domain::LabelDef],
    partial: bool,
) -> Value {
    if let Some(reference) = schema["$ref"].as_str() {
        if let Some(target) = reference
            .strip_prefix('#')
            .and_then(|pointer| root.pointer(pointer))
        {
            return strict_schema(target, root, labels, partial);
        }
    }
    if schema["type"] == "object" && schema["additionalProperties"].is_object() {
        fn attributes(label: Option<&annotation_domain::LabelDef>, partial: bool) -> Value {
            use annotation_domain::AttributeKind;
            let mut properties = serde_json::Map::new();
            for attribute in label.into_iter().flat_map(|label| &label.attributes) {
                let scalar = match attribute.kind {
                    AttributeKind::Enum => json!({"type":"string","enum":attribute.enum_values}),
                    AttributeKind::Boolean => json!({"type":"boolean"}),
                    AttributeKind::Number => json!({"type":"number"}),
                    AttributeKind::Text => json!({"type":"string"}),
                };
                properties.insert(
                    attribute.key.clone(),
                    if partial || !attribute.required {
                        json!({"anyOf":[scalar,{"type":"null"}]})
                    } else {
                        scalar
                    },
                );
            }
            json!({"type":"object","required":properties.keys().collect::<Vec<_>>(),"properties":properties,"additionalProperties":false})
        }
        return if labels.is_empty() {
            attributes(None, partial)
        } else {
            json!({"anyOf":labels.iter().map(|label|attributes(Some(label),partial)).collect::<Vec<_>>()})
        };
    }
    let Some(source) = schema.as_object() else {
        return schema.clone();
    };
    let mut result = serde_json::Map::new();
    for (key, value) in source {
        match key.as_str() {
            "$schema" | "definitions" | "$defs" | "title" | "format" | "propertyNames"
            | "default" | "required" => {}
            "oneOf" | "anyOf" => {
                result.insert(
                    "anyOf".into(),
                    json!(value
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|v| strict_schema(v, root, labels, partial))
                        .collect::<Vec<_>>()),
                );
            }
            "items" => {
                result.insert(key.clone(), strict_schema(value, root, labels, partial));
            }
            "properties" => {
                let required = schema["required"].as_array();
                let properties = value
                    .as_object()
                    .into_iter()
                    .flatten()
                    .map(|(name, child)| {
                        let projected = strict_schema(child, root, labels, name == "values");
                        let mandatory = required
                            .is_some_and(|names| names.iter().any(|v| v.as_str() == Some(name)));
                        (
                            name.clone(),
                            if mandatory {
                                projected
                            } else {
                                json!({"anyOf":[projected,{"type":"null"}]})
                            },
                        )
                    })
                    .collect::<serde_json::Map<_, _>>();
                result.insert(
                    "required".into(),
                    json!(properties.keys().collect::<Vec<_>>()),
                );
                result.insert(key.clone(), Value::Object(properties));
            }
            _ => {
                result.insert(key.clone(), value.clone());
            }
        }
    }
    if schema["type"] == "object" {
        result.insert("additionalProperties".into(), json!(false));
        if !result.contains_key("properties") {
            result.insert("properties".into(), json!({}));
            result.insert("required".into(), json!([]));
        }
    }
    Value::Object(result)
}
pub(crate) fn domain_arguments(
    name: &str,
    args: &mut Value,
    labels: &[annotation_domain::LabelDef],
    object_labels: &std::collections::BTreeMap<String, String>,
) {
    // Null means omission only for the known strict projection's optional
    // fields. Unknown fields are never removed or silently repaired.
    if let Some(tool) = tools().iter().find(|t| t["name"].as_str() == Some(name)) {
        if let Some(object) = args.as_object_mut() {
            let schema = &tool["inputSchema"];
            let optional = schema["properties"]
                .as_object()
                .into_iter()
                .flatten()
                .filter_map(|(key, _)| {
                    let required = schema["required"]
                        .as_array()
                        .is_some_and(|required| required.iter().any(|v| v.as_str() == Some(key)));
                    (!required && object.get(key) == Some(&Value::Null)).then_some(key.clone())
                })
                .collect::<Vec<_>>();
            for key in optional {
                object.remove(&key);
            }
        }
    }
    for change in args
        .get_mut("changes")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        let created = change["kind"] == "create";
        let label_id = if created {
            change["object"]["label_id"].as_str()
        } else {
            change["object_id"]
                .as_str()
                .and_then(|id| object_labels.get(id))
                .map(String::as_str)
        };
        let label = label_id.and_then(|id| labels.iter().find(|label| &*label.label_id == id));
        let values = if created {
            change["object"].get_mut("attributes")
        } else if change["kind"] == "set_attributes" {
            change.get_mut("values")
        } else {
            None
        };
        if let Some(values) = values.and_then(Value::as_object_mut) {
            // Partial edits use null for attributes of this object's label;
            // required create attributes must reach domain validation intact.
            let omitted = values
                .iter()
                .filter_map(|(key, value)| {
                    let known = label
                        .into_iter()
                        .flat_map(|l| &l.attributes)
                        .any(|d| d.key == *key && (!created || !d.required));
                    (value.is_null() && known).then_some(key.clone())
                })
                .collect::<Vec<_>>();
            for key in omitted {
                values.remove(&key);
            }
        }
    }
}
fn order() -> HttpError {
    HttpError::new("stream_order_invalid")
}
fn output_index(event: &Value) -> Result<usize, HttpError> {
    event["output_index"]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .ok_or_else(order)
}
fn active_item(turn: &Turn, event: &Value) -> Result<usize, HttpError> {
    let index = output_index(event)?;
    let item = turn.response_items.get(index).ok_or_else(order)?;
    if item.completed.is_some() || event["item_id"].as_str() != Some(item.id.as_str()) {
        return Err(order());
    }
    Ok(index)
}
fn complete_item(turn: &Turn, index: usize, item: &Value) -> Result<Value, HttpError> {
    let known = turn.response_items.get(index).ok_or_else(order)?;
    if item["id"].as_str() != Some(known.id.as_str())
        || item["type"].as_str() != Some(known.kind.as_str())
    {
        return Err(order());
    }
    match known.kind.as_str() {
        "function_call" => {
            let call = turn
                .indices
                .get(&known.id)
                .and_then(|index| turn.calls.get(*index))
                .ok_or_else(order)?;
            if !turn.closed.contains(&known.id)
                || item
                    .get("status")
                    .filter(|v| !v.is_null())
                    .is_some_and(|status| status != "completed")
                || item["call_id"].as_str() != Some(call.id.as_str())
                || item["name"].as_str() != Some(call.name.as_str())
                || item["arguments"].as_str() != Some(call.arguments.as_str())
            {
                return Err(order());
            }
            Ok(
                json!({"type":"function_call","id":known.id,"call_id":call.id,"name":call.name,"arguments":call.arguments,"status":"completed"}),
            )
        }
        "message" => {
            let content = item["content"].as_array().ok_or_else(order)?;
            if item["role"] != "assistant"
                || item["status"] != "completed"
                || content.len() != known.parts.len()
            {
                return Err(order());
            }
            let mut parts = Vec::with_capacity(content.len());
            for (index, part) in content.iter().enumerate() {
                let expected = known.parts.get(&(index as u64)).ok_or_else(order)?;
                if !expected.done
                    || !expected.text_done
                    || part["type"] != "output_text"
                    || part["text"].as_str() != Some(expected.text.as_str())
                    || !part["annotations"].is_array()
                {
                    return Err(order());
                }
                let mut projected = json!({"type":"output_text","text":expected.text,"annotations":part["annotations"]});
                if let Some(logprobs) = part.get("logprobs") {
                    projected["logprobs"] = logprobs.clone();
                }
                parts.push(projected);
            }
            Ok(
                json!({"type":"message","id":known.id,"role":"assistant","status":"completed","content":parts}),
            )
        }
        "reasoning" => {
            if item
                .get("status")
                .filter(|v| !v.is_null())
                .is_some_and(|status| status != "completed")
            {
                return Err(order());
            }
            let summary = item["summary"].as_array().ok_or_else(order)?;
            let mut entries = Vec::with_capacity(summary.len());
            for entry in summary {
                if entry["type"] != "summary_text" || !entry["text"].is_string() {
                    return Err(order());
                }
                entries.push(json!({"type":"summary_text","text":entry["text"]}));
            }
            let mut projected =
                json!({"type":"reasoning","id":known.id,"summary":entries,"status":"completed"});
            if let Some(encrypted) = item.get("encrypted_content").filter(|v| !v.is_null()) {
                if !encrypted.is_string() {
                    return Err(order());
                }
                projected["encrypted_content"] = encrypted.clone();
            }
            if let Some(content) = item.get("content").filter(|v| !v.is_null()) {
                let content = content.as_array().ok_or_else(order)?;
                let mut entries = Vec::with_capacity(content.len());
                for entry in content {
                    if entry["type"] != "reasoning_text" || !entry["text"].is_string() {
                        return Err(order());
                    }
                    entries.push(json!({"type":"reasoning_text","text":entry["text"]}));
                }
                projected["content"] = json!(entries);
            }
            Ok(projected)
        }
        _ => Err(order()),
    }
}
pub(crate) fn frame(turn: &mut Turn, event: &Value) -> Result<(), HttpError> {
    let kind = event["type"].as_str().unwrap_or("");
    // Extensions are tolerated, but are never receipt observations, start or
    // completion evidence, tools, or stateless continuation authority.
    if !matches!(
        kind,
        "response.created"
            | "response.in_progress"
            | "response.queued"
            | "response.completed"
            | "response.failed"
            | "response.incomplete"
            | "error"
            | "response.output_item.added"
            | "response.output_item.done"
            | "response.function_call_arguments.delta"
            | "response.function_call_arguments.done"
            | "response.content_part.added"
            | "response.content_part.done"
            | "response.output_text.delta"
            | "response.output_text.done"
            | "response.refusal.delta"
            | "response.refusal.done"
    ) {
        return Ok(());
    }
    if turn.terminal {
        return Err(order());
    }
    if kind == "error" {
        return Err(HttpError::new("provider_reported_failure"));
    }
    let sequence = event["sequence_number"].as_u64().ok_or_else(order)?;
    if turn.sequence.is_some_and(|old| sequence <= old) {
        return Err(order());
    }
    turn.sequence = Some(sequence);
    if kind == "response.created" {
        if turn.started {
            return Err(order());
        }
        let response = &event["response"];
        if !response["id"].as_str().is_some_and(|id| !id.is_empty())
            || !matches!(response["status"].as_str(), Some("in_progress" | "queued"))
            || !response["output"].as_array().is_some_and(Vec::is_empty)
        {
            return Err(order());
        }
        turn.observe(response, "id")?;
        turn.started = true;
        return Ok(());
    }
    if !turn.started {
        return Err(order());
    }
    match kind {
        "response.in_progress"
        | "response.queued"
        | "response.completed"
        | "response.failed"
        | "response.incomplete" => {
            let response = &event["response"];
            if response["id"].as_str() != turn.response_id.as_deref() {
                return Err(order());
            }
            turn.observe(response, "id")?;
            let expected = match kind {
                "response.failed" => "failed",
                "response.incomplete" => "incomplete",
                "response.completed" => "completed",
                "response.queued" => "queued",
                _ => "in_progress",
            };
            if response["status"] != expected {
                return Err(order());
            }
            if kind == "response.failed" || kind == "response.incomplete" {
                return Err(HttpError::new("provider_reported_failure"));
            }
            if kind == "response.completed" {
                let output = response["output"].as_array().ok_or_else(order)?;
                if output.len() != turn.response_items.len()
                    || turn.calls.len() != turn.closed.len()
                {
                    return Err(order());
                }
                for (index, item) in output.iter().enumerate() {
                    let known = turn.response_items[index]
                        .completed
                        .as_ref()
                        .ok_or_else(order)?;
                    if item != known && complete_item(turn, index, item)? != *known {
                        return Err(order());
                    }
                }
                for item in &mut turn.response_items {
                    if item.kind != "function_call" {
                        turn.continuation
                            .push(item.completed.take().ok_or_else(order)?);
                    }
                }
                turn.terminal = true;
            }
        }
        "response.output_item.added" => {
            let index = output_index(event)?;
            let item = &event["item"];
            let id = item["id"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 256)
                .ok_or_else(order)?;
            let item_kind = item["type"].as_str().ok_or_else(order)?;
            if turn.response_items.iter().any(|item| item.id == id) {
                return Err(if item_kind == "function_call" {
                    HttpError::new("duplicate_tool_call")
                } else {
                    order()
                });
            }
            if index != turn.response_items.len() {
                return Err(order());
            }
            match item_kind {
                "function_call" => {
                    if item
                        .get("status")
                        .filter(|v| !v.is_null())
                        .is_some_and(|status| status != "in_progress")
                    {
                        return Err(order());
                    }
                    let arguments = item["arguments"].as_str().ok_or_else(order)?;
                    turn.add_call(
                        id.into(),
                        Call::new(&item["call_id"], &item["name"], arguments)?,
                    )?;
                }
                "message" => {
                    if item["status"] != "in_progress"
                        || item["role"] != "assistant"
                        || !item["content"].as_array().is_some_and(Vec::is_empty)
                    {
                        return Err(order());
                    }
                }
                "reasoning" => {
                    if !item["summary"].is_array()
                        || item
                            .get("status")
                            .filter(|v| !v.is_null())
                            .is_some_and(|status| status != "in_progress")
                    {
                        return Err(order());
                    }
                }
                _ => return Err(order()),
            }
            turn.response_items.push(ResponseItem {
                id: id.into(),
                kind: item_kind.into(),
                parts: Default::default(),
                completed: None,
            });
        }
        "response.function_call_arguments.delta" | "response.function_call_arguments.done" => {
            let item = active_item(turn, event)?;
            let id = &turn.response_items[item].id;
            if turn.response_items[item].kind != "function_call" || turn.closed.contains(id) {
                return Err(order());
            }
            let call = *turn.indices.get(id).ok_or_else(order)?;
            if kind.ends_with(".delta") {
                turn.input_deltas.insert(item as u64);
                turn.calls[call]
                    .arguments
                    .push_str(event["delta"].as_str().ok_or_else(order)?);
            } else {
                let complete = event["arguments"].as_str().ok_or_else(order)?;
                if turn.calls[call].arguments.is_empty()
                    && !turn.input_deltas.contains(&(item as u64))
                {
                    turn.calls[call].arguments = complete.into();
                } else if turn.calls[call].arguments != complete {
                    return Err(order());
                }
                turn.closed.insert(id.clone());
            }
        }
        "response.content_part.added" => {
            let item = active_item(turn, event)?;
            let content = event["content_index"].as_u64().ok_or_else(order)?;
            let part = &event["part"];
            if turn.response_items[item].kind != "message"
                || content != turn.response_items[item].parts.len() as u64
                || part["type"] != "output_text"
            {
                return Err(order());
            }
            let text = part["text"].as_str().ok_or_else(order)?;
            turn.text.push_str(text);
            turn.response_items[item].parts.insert(
                content,
                ResponsePart {
                    text: text.into(),
                    ..Default::default()
                },
            );
        }
        "response.output_text.delta"
        | "response.output_text.done"
        | "response.content_part.done" => {
            let item = active_item(turn, event)?;
            let content = event["content_index"].as_u64().ok_or_else(order)?;
            if turn.response_items[item].kind != "message" {
                return Err(order());
            }
            let part = turn.response_items[item]
                .parts
                .get_mut(&content)
                .ok_or_else(order)?;
            if part.done {
                return Err(order());
            }
            match kind {
                "response.output_text.delta" => {
                    if part.text_done {
                        return Err(order());
                    }
                    let delta = event["delta"].as_str().ok_or_else(order)?;
                    part.text.push_str(delta);
                    turn.text.push_str(delta);
                }
                "response.output_text.done" => {
                    if part.text_done || event["text"].as_str() != Some(part.text.as_str()) {
                        return Err(order());
                    }
                    part.text_done = true;
                }
                _ => {
                    if !part.text_done
                        || event["part"]["type"] != "output_text"
                        || event["part"]["text"].as_str() != Some(part.text.as_str())
                    {
                        return Err(order());
                    }
                    part.done = true;
                }
            }
        }
        "response.output_item.done" => {
            let index = output_index(event)?;
            if turn
                .response_items
                .get(index)
                .ok_or_else(order)?
                .completed
                .is_some()
            {
                return Err(order());
            }
            let completed = complete_item(turn, index, &event["item"])?;
            turn.response_items[index].completed = Some(completed);
        }
        "response.refusal.delta" | "response.refusal.done" => {
            return Err(HttpError::new("provider_reported_failure"))
        }
        _ => {}
    }
    Ok(())
}
pub(crate) fn append(
    history: &mut Vec<Value>,
    calls: &[Call],
    outputs: Vec<(Value, Option<Value>)>,
) {
    for (call, (output, image)) in calls.iter().zip(outputs) {
        history.push(json!({"type":"function_call","call_id":call.id,"name":call.name,"arguments":call.arguments}));
        history.push(
            json!({"type":"function_call_output","call_id":call.id,"output":output.to_string()}),
        );
        if let Some(image) = image {
            history.push(json!({"role":"user","content":[image]}));
        }
    }
}
