//! MiMo's documented chat SSE dialect and nullable usage, not Responses.
use serde_json::{json,Value};
use super::http::{Call,HttpError,Turn,tools};

pub fn request(config:&Value,messages:&[Value],tokens:u64)->Value {
    let definitions=tools().iter().map(|t|json!({"type":"function","function":{"name":t["name"],"description":t["description"],"parameters":t["inputSchema"]}})).collect::<Vec<_>>();
    // Current official documentation names max_completion_tokens. Disable
    // optional thinking so multi-turn history never drops reasoning_content.
    json!({"model":config["model_id"],"stream":true,"max_completion_tokens":tokens,"thinking":{"type":"disabled"},"messages":messages,"tools":definitions,"tool_choice":"auto"})
}
pub(crate) fn frame(turn:&mut Turn,event:&Value)->Result<(),HttpError> {
    if event.get("error").is_some(){return Err(HttpError::new("provider_reported_failure"))}
    turn.observe(event,"id")?;
    let Some(choices)=event["choices"].as_array() else{return Err(HttpError::new("invalid_json"))};
    if choices.is_empty(){return Ok(())}
    if choices.len()!=1||choices[0]["index"].as_u64()!=Some(0){return Err(HttpError::new("stream_order_invalid"))}
    let choice=&choices[0];let delta=&choice["delta"];
    if turn.finished{return Err(HttpError::new("stream_order_invalid"))}
    if let Some(text)=delta["content"].as_str(){turn.text.push_str(text);}
    if let Some(calls)=delta["tool_calls"].as_array() {
        for entry in calls {
            let index=entry["index"].as_u64().ok_or_else(||HttpError::new("stream_order_invalid"))?;
            let key=index.to_string();let function=&entry["function"];
            if let Some(&position)=turn.indices.get(&key) {
                let call=&mut turn.calls[position];
                if entry.get("id").is_some_and(|id|id.as_str()!=Some(call.id.as_str()))||function.get("name").is_some_and(|name|name.as_str()!=Some(call.name.as_str())){return Err(HttpError::new("duplicate_tool_call"))}
                if let Some(args)=function["arguments"].as_str(){call.arguments.push_str(args);}
            } else {
                if index!=turn.calls.len() as u64{return Err(HttpError::new("stream_order_invalid"))}
                turn.add_call(key,Call::new(&entry["id"],&function["name"],function["arguments"].as_str().unwrap_or(""))?)?;
            }
        }
    }
    if let Some(reason)=choice["finish_reason"].as_str() {
        if !["stop","tool_calls"].contains(&reason){return Err(HttpError::new("provider_reported_failure"))}
        if (reason=="tool_calls")!=!turn.calls.is_empty(){return Err(HttpError::new("stream_order_invalid"))}
        turn.finished=true;
    }
    Ok(())
}
pub(crate) fn append(history:&mut Vec<Value>,calls:&[Call],outputs:Vec<(Value,Option<Value>)>) {
    let entries=calls.iter().map(|c|json!({"id":c.id,"type":"function","function":{"name":c.name,"arguments":c.arguments}})).collect::<Vec<_>>();
    history.push(json!({"role":"assistant","content":null,"tool_calls":entries}));
    let mut images=Vec::new();
    for (call,(output,image)) in calls.iter().zip(outputs) {
        history.push(json!({"role":"tool","tool_call_id":call.id,"content":output.to_string()}));
        if let Some(image)=image {images.push(image);}
    }
    if !images.is_empty(){history.push(json!({"role":"user","content":images}));}
}
