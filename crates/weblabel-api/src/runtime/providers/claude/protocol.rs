//! Strict project-side stream-json consumer. Synthetic pins are not evidence
//! that an installed official CLI reports subscription authentication this way.
use super::{ClaudeError, MCP_SERVER_NAME};
use crate::runtime::mcp::{json_size_bounded, serialize_bounded};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};

fn permitted(name: &str) -> bool {
    name.strip_prefix("mcp__")
        .and_then(|n| n.strip_prefix(MCP_SERVER_NAME))
        .and_then(|n| n.strip_prefix("__"))
        .is_some_and(|n| crate::runtime::agent_tools::TOOL_NAMES.contains(&n))
}
#[derive(Debug)]
pub struct Completion {
    pub usage: Option<Value>,
    pub candidates: Vec<Value>,
    pub tool_calls: usize,
}
pub struct Session {
    id: String,
    model: String,
    initialized: bool,
    terminal: bool,
    calls: BTreeMap<String, bool>,
    tool_result_bytes: usize,
    max_turns: usize,
    max_result_bytes: usize,
    candidates: Vec<Value>,
    pub(crate) boundaries: Vec<(String, String, bool)>,
    candidate_keys: BTreeSet<String>,
    terminal_usage: Option<Value>,
}
impl Session {
    pub fn new(id: String, model: String, max_turns: usize, max_result_bytes: usize) -> Self {
        Self {
            id,
            model,
            initialized: false,
            terminal: false,
            calls: BTreeMap::new(),
            tool_result_bytes: 0,
            max_turns,
            max_result_bytes,
            candidates: Vec::new(),
            candidate_keys: BTreeSet::new(),
            boundaries: Vec::new(),
            terminal_usage: None,
        }
    }
    /// A validated terminal observation, including null when usage was absent.
    /// Taking it never permits a second observation or adds checkpoint usage.
    pub fn take_terminal_usage(&mut self) -> Option<Value> {
        self.terminal_usage.take()
    }
    fn candidate(&mut self, value: &Value) -> Result<(), ClaudeError> {
        if !value.is_object() {
            return Err(ClaudeError::new("candidate_invalid"));
        }
        let bytes = serialize_bounded(value, crate::ai::predictions::MAX_RAW_OUTPUT_BYTES)
            .map_err(|_| ClaudeError::new("candidate_too_large"))?;
        let key = String::from_utf8(bytes).map_err(|_| ClaudeError::new("candidate_invalid"))?;
        if self.candidate_keys.contains(&key) {
            return Ok(());
        }
        if self.candidates.len() >= 1000 {
            return Err(ClaudeError::new("candidate_budget_exceeded"));
        }
        self.candidate_keys.insert(key);
        self.candidates.push(value.clone());
        Ok(())
    }
    pub fn fold(&mut self, event: &Value) -> Result<Option<Completion>, ClaudeError> {
        if self.terminal {
            return Err(ClaudeError::new("duplicate_result"));
        }
        if event["session_id"].as_str() != Some(self.id.as_str()) {
            return Err(ClaudeError::new("session_mismatch"));
        }
        let kind = event["type"]
            .as_str()
            .ok_or_else(|| ClaudeError::new("claude_protocol_violation"))?;
        if !matches!(kind, "system" | "assistant" | "user" | "result") {
            return Err(ClaudeError::new("claude_protocol_violation"));
        }
        if kind == "system" {
            if event["subtype"] != "init" {
                return Err(ClaudeError::new("claude_protocol_violation"));
            }
            if self.initialized {
                return Err(ClaudeError::new("duplicate_init"));
            }
            match event["auth_mode"].as_str() {
                Some("subscription") => {}
                Some("api_key") => return Err(ClaudeError::new("api_auth_not_subscription")),
                _ => return Err(ClaudeError::new("needs_login")),
            }
            if event["model"].as_str() != Some(self.model.as_str()) {
                return Err(ClaudeError::new("model_mismatch"));
            }
            let tools = event["tools"]
                .as_array()
                .ok_or_else(|| ClaudeError::new("method_not_permitted"))?;
            if tools.len() != crate::runtime::agent_tools::TOOL_NAMES.len()
                || tools.iter().enumerate().any(|(i, tool)| {
                    !tool.as_str().is_some_and(permitted) || tools[..i].contains(tool)
                })
            {
                return Err(ClaudeError::new("method_not_permitted"));
            }
            let servers = event["mcp_servers"]
                .as_array()
                .ok_or_else(|| ClaudeError::new("mcp_load_error"))?;
            if servers.len() != 1
                || servers[0]["name"] != MCP_SERVER_NAME
                || servers[0]["status"] != "connected"
            {
                return Err(ClaudeError::new("mcp_load_error"));
            }
            if event
                .get("mcp_server_errors")
                .is_some_and(|v| !v.is_null() && !v.as_object().is_some_and(|m| m.is_empty()))
            {
                return Err(ClaudeError::new("mcp_load_error"));
            }
            self.initialized = true;
            return Ok(None);
        }
        if !self.initialized {
            return Err(ClaudeError::new("init_required"));
        }
        if kind == "result" {
            let subtype = event["subtype"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| ClaudeError::new("claude_protocol_violation"))?;
            let is_error = match event.get("is_error") {
                None => false,
                Some(Value::Bool(error)) => *error,
                _ => return Err(ClaudeError::new("claude_protocol_violation")),
            };
            let usage = normalized_usage(event.get("usage"))?;
            // Set terminal and retain usage BEFORE any outcome/pairing/candidate
            // failure. Runtime emits this through the existing event funnel.
            self.terminal = true;
            self.terminal_usage = Some(usage.clone());
            if self.calls.values().any(|resolved| !*resolved) {
                return Err(ClaudeError::new("tool_boundary_violation"));
            }
            if subtype != "success" || is_error {
                return Err(ClaudeError::new("provider_reported_failure"));
            }
            self.proposals(event)?;
            if let Some(output) = event.get("structured_output").filter(|v| !v.is_null()) {
                self.candidate(output)?;
            }
            return Ok(Some(Completion {
                usage: if usage.is_null() { None } else { Some(usage) },
                candidates: std::mem::take(&mut self.candidates),
                tool_calls: self.calls.len(),
            }));
        }
        let blocks = event["message"]["content"]
            .as_array()
            .ok_or_else(|| ClaudeError::new("claude_protocol_violation"))?;
        for block in blocks {
            match block["type"].as_str() {
                Some("tool_use") => {
                    if kind != "assistant" {
                        return Err(ClaudeError::new("tool_boundary_violation"));
                    }
                    let name = block["name"]
                        .as_str()
                        .filter(|n| permitted(n))
                        .ok_or_else(|| ClaudeError::new("method_not_permitted"))?;
                    let id = block["id"]
                        .as_str()
                        .filter(|s| !s.is_empty() && s.len() <= 128)
                        .ok_or_else(|| ClaudeError::new("tool_boundary_violation"))?;
                    if self.calls.contains_key(id) {
                        return Err(ClaudeError::new("tool_boundary_violation"));
                    }
                    if self.calls.len() >= self.max_turns {
                        return Err(ClaudeError::new("tool_turn_budget_exceeded"));
                    }
                    self.calls.insert(id.into(), false);
                    self.boundaries.push((id.into(), name.into(), false));
                }
                Some("tool_result") => {
                    if kind != "user" {
                        return Err(ClaudeError::new("tool_boundary_violation"));
                    }
                    let id = block["tool_use_id"]
                        .as_str()
                        .ok_or_else(|| ClaudeError::new("tool_boundary_violation"))?;
                    if !self.calls.get(id).is_some_and(|resolved| !*resolved) {
                        return Err(ClaudeError::new("tool_boundary_violation"));
                    }
                    let bytes = json_size_bounded(
                        block,
                        self.max_result_bytes.saturating_sub(self.tool_result_bytes),
                    )
                    .map_err(|_| ClaudeError::new("tool_byte_budget_exceeded"))?;
                    // No resolved/counter mutation until the remaining budget fits.
                    self.calls.insert(id.into(), true);
                    self.tool_result_bytes += bytes;
                    self.boundaries.push((id.into(), String::new(), true));
                }
                Some("text" | "thinking" | "redacted_thinking") => {}
                _ => return Err(ClaudeError::new("claude_protocol_violation")),
            }
        }
        if kind == "assistant" {
            self.proposals(event)?;
        } else if event.get("proposals").is_some() {
            return Err(ClaudeError::new("claude_protocol_violation"));
        }
        Ok(None)
    }
    fn proposals(&mut self, event: &Value) -> Result<(), ClaudeError> {
        if let Some(proposals) = event.get("proposals") {
            let proposals = proposals
                .as_array()
                .ok_or_else(|| ClaudeError::new("candidate_invalid"))?;
            for proposal in proposals {
                self.candidate(proposal)?;
            }
        }
        Ok(())
    }
}
fn normalized_usage(usage: Option<&Value>) -> Result<Value, ClaudeError> {
    let Some(value) = usage.filter(|v| !v.is_null()) else {
        return Ok(Value::Null);
    };
    let raw = value
        .as_object()
        .ok_or_else(|| ClaudeError::new("claude_protocol_violation"))?;
    json_size_bounded(value, 4096).map_err(|_| ClaudeError::new("claude_protocol_violation"))?;
    let mut normalized = Map::new();
    for key in [
        "input_tokens",
        "output_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    ] {
        if let Some(value) = raw.get(key) {
            if !value.is_null() && !value.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991) {
                return Err(ClaudeError::new("claude_protocol_violation"));
            }
            normalized.insert(key.into(), value.clone());
        }
    }
    Ok(if normalized.is_empty() {
        Value::Null
    } else {
        Value::Object(normalized)
    })
}
