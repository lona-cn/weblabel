//! Private stdio MCP transport. The loopback API remains the authorization boundary.
//! This module must be dispatched before database, logging, or server startup.
use super::agent_tools::{tool_definitions, MAX_TOOL_BODY_BYTES, TOOL_NAMES};
use rmcp::{
    model::*,
    service::{RequestContext, RoleServer},
    ErrorData, ServerHandler, ServiceExt,
};
use serde_json::{json, Value};
use std::{
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};
use tokio::io::{AsyncRead, ReadBuf};

const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

/// Deliberately carries no URL, token, HTTP body, or underlying reqwest error.
#[derive(Debug, thiserror::Error)]
#[error("{code}: private MCP bridge unavailable")]
pub struct McpBridgeError {
    pub code: &'static str,
}
fn failure(code: &'static str) -> McpBridgeError {
    McpBridgeError { code }
}

struct BudgetWriter<W> {
    sink: W,
    written: usize,
    maximum: usize,
}
impl<W: std::io::Write> std::io::Write for BudgetWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.maximum.saturating_sub(self.written) {
            return Err(std::io::Error::other("JSON byte budget exceeded"));
        }
        self.sink.write_all(bytes)?;
        self.written += bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.sink.flush()
    }
}
/// Check each serialization write before the byte budget can grow. Shared by
/// MCP arguments, candidate identities and tool-result accounting.
pub fn serialize_bounded(value: &Value, maximum: usize) -> Result<Vec<u8>, McpBridgeError> {
    let mut writer = BudgetWriter {
        sink: Vec::with_capacity(maximum.min(4096)),
        written: 0,
        maximum,
    };
    serde_json::to_writer(&mut writer, value).map_err(|_| failure("JSON_BUDGET_EXCEEDED"))?;
    Ok(writer.sink)
}
pub fn json_size_bounded(value: &Value, maximum: usize) -> Result<usize, McpBridgeError> {
    let mut writer = BudgetWriter {
        sink: std::io::sink(),
        written: 0,
        maximum,
    };
    serde_json::to_writer(&mut writer, value).map_err(|_| failure("JSON_BUDGET_EXCEEDED"))?;
    Ok(writer.written)
}

/// Validate the original spelling before URL normalization (which accepts 127.1,
/// decimal IPv4 and implicit ports). No path, including a trailing '/', is accepted.
pub fn validate_api_base(raw: &str) -> Result<reqwest::Url, McpBridgeError> {
    let authority = raw
        .strip_prefix("http://")
        .ok_or_else(|| failure("MCP_API_BASE_INVALID"))?;
    let port = authority
        .strip_prefix("127.0.0.1:")
        .or_else(|| authority.strip_prefix("[::1]:"))
        .ok_or_else(|| failure("MCP_API_BASE_INVALID"))?;
    if port.is_empty()
        || !port.bytes().all(|b| b.is_ascii_digit())
        || port.parse::<u16>().ok().filter(|p| *p != 0).is_none()
    {
        return Err(failure("MCP_API_BASE_INVALID"));
    }
    reqwest::Url::parse(raw).map_err(|_| failure("MCP_API_BASE_INVALID"))
}

struct Bridge {
    client: reqwest::Client,
    base: reqwest::Url,
    token: String,
    tools: Vec<Tool>,
    // Serialize calls: budgets and candidate order remain observable at the API.
    calls: tokio::sync::Mutex<()>,
}
impl Bridge {
    fn from_environment() -> Result<Self, McpBridgeError> {
        let base = validate_api_base(
            &std::env::var("WEBLABEL_API_BASE").map_err(|_| failure("MCP_API_BASE_INVALID"))?,
        )?;
        let token =
            std::env::var("WEBLABEL_RUN_TOKEN").map_err(|_| failure("RUN_TOKEN_REQUIRED"))?;
        if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(failure("RUN_TOKEN_INVALID"));
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| failure("MCP_HTTP_UNAVAILABLE"))?;
        let tools = serde_json::from_value(tool_definitions())
            .map_err(|_| failure("MCP_SCHEMA_UNAVAILABLE"))?;
        Ok(Self {
            client,
            base,
            token,
            tools,
            calls: tokio::sync::Mutex::new(()),
        })
    }
    async fn invoke(&self, name: &str, arguments: Value) -> Result<CallToolResult, McpBridgeError> {
        let _call = self.calls.lock().await;
        if !TOOL_NAMES.contains(&name) {
            return Err(failure("UNKNOWN_TOOL"));
        }
        let body = serialize_bounded(&arguments, MAX_TOOL_BODY_BYTES)
            .map_err(|_| failure("TOOL_PAYLOAD_TOO_LARGE"))?;
        let url = self
            .base
            .join(&format!("/internal/agent-tools/{name}"))
            .map_err(|_| failure("MCP_API_BASE_INVALID"))?;
        let mut response = self
            .client
            .post(url)
            .bearer_auth(&self.token)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .map_err(|_| failure("MCP_API_UNAVAILABLE"))?;
        if response.status().is_redirection() {
            return Err(failure("MCP_REDIRECT_FORBIDDEN"));
        }
        let success = response.status().is_success();
        if response
            .content_length()
            .is_some_and(|n| n > MAX_RESPONSE_BYTES as u64)
        {
            return Err(failure("TOOL_RESULT_TOO_LARGE"));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| failure("MCP_API_TRUNCATED"))?
        {
            if chunk.len() > MAX_RESPONSE_BYTES.saturating_sub(bytes.len()) {
                return Err(failure("TOOL_RESULT_TOO_LARGE"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let mut value: Value =
            serde_json::from_slice(&bytes).map_err(|_| failure("MCP_API_INVALID_RESPONSE"))?;
        if !success {
            // API codes are stable machine identifiers. Never relay untrusted message,
            // details, or request payloads (including a maliciously echoed bearer).
            let code = value["code"]
                .as_str()
                .filter(|s| {
                    s.len() <= 128
                        && s.bytes()
                            .all(|b| b.is_ascii_uppercase() || b == b'_' || b.is_ascii_digit())
                })
                .unwrap_or("MCP_API_REJECTED");
            return Ok(CallToolResult::structured_error(
                json!({"code":code,"message":"The authorized API rejected this call"}),
            ));
        }
        if name == "read_region" {
            let data = value
                .as_object_mut()
                .and_then(|v| v.remove("data_base64"))
                .filter(Value::is_string)
                .ok_or_else(|| failure("MCP_API_INVALID_RESPONSE"))?;
            // Preserve all image/crop/transform identity in a separate text content
            // block. The image bytes cross base64 only at this MCP/HTTP boundary.
            let result = json!({"content":[{"type":"text","text":value.to_string()},
                {"type":"image","mimeType":value["mime"],"data":data}],"isError":false});
            serde_json::from_value(result).map_err(|_| failure("MCP_API_INVALID_RESPONSE"))
        } else {
            Ok(CallToolResult::structured(value))
        }
    }
}
impl ServerHandler for Bridge {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions("Only the five run-scoped WebLabel tools are available. Candidate tools never apply annotations.")
    }
    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        if request.is_some_and(|p| p.cursor.is_some()) {
            return Err(ErrorData::invalid_params("No next page", None));
        }
        let mut result = ListToolsResult::default();
        result.tools = self.tools.clone();
        Ok(result)
    }
    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.tools.iter().find(|tool| tool.name == name).cloned()
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        if !TOOL_NAMES.contains(&request.name.as_ref()) {
            return Err(ErrorData::invalid_params("Unknown WebLabel tool", None));
        }
        let arguments = Value::Object(request.arguments.unwrap_or_default());
        let result = match self.invoke(&request.name, arguments).await {
            Ok(result) => result,
            Err(error) => CallToolResult::structured_error(
                json!({"code":error.code,"message":"Private tool transport failed"}),
            ),
        };
        Ok(result.into())
    }
    async fn list_prompts(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListPromptsResult, ErrorData> {
        Err(ErrorData::method_not_found::<ListPromptsRequestMethod>())
    }
    async fn list_resources(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        Err(ErrorData::method_not_found::<ListResourcesRequestMethod>())
    }
    async fn list_resource_templates(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListResourceTemplatesResult, ErrorData> {
        Err(ErrorData::method_not_found::<
            ListResourceTemplatesRequestMethod,
        >())
    }
    async fn complete(
        &self,
        _: CompleteRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<CompleteResult, ErrorData> {
        Err(ErrorData::method_not_found::<CompleteRequestMethod>())
    }
}

/// Reject oversized NDJSON before rmcp's decoder can grow an unbounded frame.
struct FramedInput<R> {
    reader: R,
    line_bytes: usize,
}
impl<R: AsyncRead + Unpin> AsyncRead for FramedInput<R> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        let before = buf.filled().len();
        match Pin::new(&mut this.reader).poll_read(cx, buf) {
            Poll::Ready(Ok(())) => {
                for byte in &buf.filled()[before..] {
                    if *byte == b'\n' {
                        this.line_bytes = 0;
                    } else {
                        this.line_bytes += 1;
                    }
                    if this.line_bytes > MAX_FRAME_BYTES {
                        return Poll::Ready(Err(std::io::Error::other("MCP frame exceeds budget")));
                    }
                }
                Poll::Ready(Ok(()))
            }
            other => other,
        }
    }
}

pub async fn run_stdio() -> Result<(), McpBridgeError> {
    let bridge = Bridge::from_environment()?;
    let service = bridge
        .serve((
            FramedInput {
                reader: tokio::io::stdin(),
                line_bytes: 0,
            },
            tokio::io::stdout(),
        ))
        .await
        .map_err(|_| failure("MCP_INITIALIZE_FAILED"))?;
    service
        .waiting()
        .await
        .map_err(|_| failure("MCP_TRANSPORT_FAILED"))?;
    Ok(())
}
