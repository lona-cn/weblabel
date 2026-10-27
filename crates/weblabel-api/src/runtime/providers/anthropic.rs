//! Anthropic Messages content blocks, cumulative message usage, tool results.
use super::http::{tools, Call, HttpError, Turn, SYSTEM_TEXT};
use serde_json::{json, Value};

pub fn request(config: &Value, messages: &[Value], tokens: u64) -> Value {
    let definitions=tools().iter().map(|t|json!({"name":t["name"],"description":t["description"],"input_schema":t["inputSchema"]})).collect::<Vec<_>>();
    json!({"model":config["model_id"],"stream":true,"max_tokens":tokens,"system":SYSTEM_TEXT,"messages":messages,"tools":definitions})
}
pub(crate) fn frame(turn: &mut Turn, event: &Value) -> Result<(), HttpError> {
    let kind = event["type"].as_str().unwrap_or("");
    match kind {
        "message_start" => {
            if turn.started {
                return Err(HttpError::new("stream_order_invalid"));
            }
            turn.started = true;
            turn.observe(&event["message"], "id")?;
        }
        "content_block_start" => {
            if !turn.started || turn.finished {
                return Err(HttpError::new("stream_order_invalid"));
            }
            let index = event["index"]
                .as_u64()
                .ok_or_else(|| HttpError::new("stream_order_invalid"))?;
            if index != turn.blocks.len() as u64 {
                return Err(HttpError::new("stream_order_invalid"));
            }
            let block = &event["content_block"];
            let block_type = block["type"].as_str().unwrap_or("");
            turn.blocks.insert(index, block_type.into());
            if block_type == "tool_use" {
                let initial = block
                    .get("input")
                    .filter(|v| v.is_object())
                    .ok_or_else(|| HttpError::new("invalid_json"))?;
                turn.initial_inputs.insert(index, initial.clone());
                turn.add_call(
                    index.to_string(),
                    Call::new(&block["id"], &block["name"], "")?,
                )?;
            } else if block_type == "text" {
                turn.text.push_str(block["text"].as_str().unwrap_or(""));
            }
        }
        "content_block_delta" => {
            let index = event["index"]
                .as_u64()
                .ok_or_else(|| HttpError::new("stream_order_invalid"))?;
            if turn.block_closed.contains(&index) {
                return Err(HttpError::new("stream_order_invalid"));
            }
            let block = turn
                .blocks
                .get(&index)
                .ok_or_else(|| HttpError::new("stream_order_invalid"))?;
            let delta = &event["delta"];
            match delta["type"].as_str().unwrap_or("") {
                "input_json_delta" if block == "tool_use" => {
                    let call = *turn
                        .indices
                        .get(&index.to_string())
                        .ok_or_else(|| HttpError::new("stream_order_invalid"))?;
                    turn.input_deltas.insert(index);
                    turn.calls[call].arguments.push_str(
                        delta["partial_json"]
                            .as_str()
                            .ok_or_else(|| HttpError::new("invalid_json"))?,
                    );
                }
                "text_delta" if block == "text" => turn.text.push_str(
                    delta["text"]
                        .as_str()
                        .ok_or_else(|| HttpError::new("invalid_json"))?,
                ),
                "thinking_delta" | "signature_delta" => {}
                _ => return Err(HttpError::new("stream_order_invalid")),
            }
        }
        "content_block_stop" => {
            let index = event["index"]
                .as_u64()
                .ok_or_else(|| HttpError::new("stream_order_invalid"))?;
            if !turn.blocks.contains_key(&index) || !turn.block_closed.insert(index) {
                return Err(HttpError::new("stream_order_invalid"));
            }
            if let Some(initial) = turn.initial_inputs.remove(&index) {
                if !turn.input_deltas.contains(&index) {
                    let call = *turn
                        .indices
                        .get(&index.to_string())
                        .ok_or_else(|| HttpError::new("stream_order_invalid"))?;
                    turn.calls[call].arguments = initial.to_string();
                }
            }
        }
        "message_delta" => {
            if !turn.started || turn.blocks.len() != turn.block_closed.len() {
                return Err(HttpError::new("stream_order_invalid"));
            }
            turn.usage.observe(&event["usage"]);
            if let Some(reason) = event["delta"]["stop_reason"].as_str() {
                if !["end_turn", "tool_use", "stop_sequence"].contains(&reason) {
                    return Err(HttpError::new("provider_reported_failure"));
                }
                if (reason == "tool_use") != !turn.calls.is_empty()
                    || turn.stop_reason.as_deref().is_some_and(|old| old != reason)
                {
                    return Err(HttpError::new("stream_order_invalid"));
                }
                turn.stop_reason = Some(reason.into());
                turn.finished = true;
            }
        }
        "message_stop" => {
            if !turn.started || !turn.finished || turn.blocks.len() != turn.block_closed.len() {
                return Err(HttpError::new("stream_order_invalid"));
            }
            turn.terminal = true;
        }
        "error" => return Err(HttpError::new("provider_reported_failure")),
        _ => {}
    }
    Ok(())
}
pub(crate) fn append(
    history: &mut Vec<Value>,
    calls: &[Call],
    outputs: Vec<(Value, Option<Value>)>,
) {
    // All parallel tool_use blocks precede one user result block, preserving
    // Anthropic's adjacency requirements instead of interleaving assistants.
    let assistant=calls.iter().map(|c|json!({"type":"tool_use","id":c.id,"name":c.name,"input":serde_json::from_str::<Value>(&c.arguments).unwrap_or(Value::Null)})).collect::<Vec<_>>();
    history.push(json!({"role":"assistant","content":assistant}));
    let mut content = Vec::new();
    for (call, (output, image)) in calls.iter().zip(outputs) {
        let mut result = vec![json!({"type":"text","text":output.to_string()})];
        if let Some(image) = image {
            result.push(image);
        }
        content.push(json!({"type":"tool_result","tool_use_id":call.id,"content":result}));
    }
    history.push(json!({"role":"user","content":content}));
}
