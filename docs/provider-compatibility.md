# Provider compatibility and evidence status

This register lets an integration engineer choose a provider channel without conflating model IDs, billing, authentication, or local-runtime behavior. It records official documentation available on 2026-09-25 and safe local version/help probes. It does not establish account entitlement, a valid credential, or a live request.

## Evidence levels

- **Docs verified:** a cited official page documents the behavior. Documentation is not a runtime test.
- **Protocol fixture tested:** a pinned installed runtime produced protocol/schema evidence and the project validated it. None of the provider channels has this status yet.
- **Live tested:** an authorized real model request was made and its result recorded. None has this status.

Unknown or account-specific values remain `null`; do not infer them from a marketing alias. Provider ID, auth/billing channel, and model ID are separate fields.

## Provider matrix

| Application provider ID | Channel and auth/billing | Model identity | Documentation evidence | Runtime / live status |
|---|---|---|---|---|
| `codex_local` | Official Codex CLI App Server on local stdio. ChatGPT subscription login, API-key billing, and enterprise access tokens are distinct documented modes. | `null`: App Server accepts a `model` parameter; the account-entitled model is not universal. | Codex App Server, Authentication, and MCP docs below. | Codex CLI is unavailable on this workstation; version/help and generated schemas were not run. Protocol fixture and live status: not tested. |
| `claude_local` | Official Claude Code `-p` CLI with a user's Claude subscription login. Anthropic Console API-key use is a different billing channel and is not an acceptable silent substitute. | `null` for this installed runtime/account. The current documented `sonnet` alias maps to Sonnet 5 for Anthropic API, but Sonnet 5 requires Claude Code >=2.1.197; installed CLI is 2.1.183. Do not claim this runtime selects Sonnet 5. | Claude Code headless, CLI, auth, model and permission docs below. | `claude --version` and `claude --help` ran without starting a session: version `2.1.183`. No provider call, auth-status command, MCP startup, or schema fixture was run. Protocol fixture and live status: not tested. |
| `openai_api` | Direct OpenAI Platform API, authenticated with a separately authorized API key; not Codex subscription access. | `gpt-6-luna` is the exact API model ID in the current official catalog. | OpenAI GPT-6 Luna model and API security docs below. | Docs verified only. No key inspection, API request, entitlement check, or live test. |
| `anthropic_api` | Direct Anthropic Platform API with an Anthropic Console API key; not Claude subscription/CLI auth. | `claude-sonnet-5` is the current documented Anthropic API Sonnet ID at access time. | Anthropic Models overview below. | Docs verified only. No key inspection, API request, entitlement check, or live test. |
| `mimo_api` | Direct Xiaomi MiMo API. Pay-as-you-go `sk-...` and Token Plan `tp-...` keys are different products; the latter's console-provided base URL is authoritative. | Documented IDs: `mimo-v2.6-flash`, `mimo-v2.6-pro`, `mimo-v2.6-pro-ultraspeed`, `mimo-v2.5-pro`, `mimo-v2.5`. | MiMo Chat Completions, image-understanding, and API-integration FAQ below. | Docs verified only. No key inspection, API request, account/plan check, or live test. |

## Local Codex App Server

Use the official CLI's `app-server` stdio transport only after pinning and probing the actual CLI version. The official protocol is JSONL, JSON-RPC 2.0 with the `jsonrpc` header omitted on the wire. Each connection requires exactly one `initialize` request followed by `initialized`; other requests before handshake and repeated initialization are rejected. Streaming notifications carry turn/item events. `turn/interrupt` is the documented turn-cancel request; terminal status must be read from the runtime response.

The official CLI documents version-specific schema commands:

```text
codex app-server generate-ts --out <dir>
codex app-server generate-json-schema --out <dir>
```

Those commands were not executed because `codex` is not installed/available on PATH. No schema artifact or schema hash exists for this project. Do not hand-author a substitute and call it the installed protocol. Generate both artifacts with the pinned runtime when available, record CLI version and hashes, and validate messages against that output.

Codex documentation separates ChatGPT subscription login from API-key usage billing. An API key must not be presented as subscription access. Enterprise access tokens are a separate documented trusted-automation mode. This project must not inspect or extract cached auth data, proxy subscription credentials, or silently change billing modes.

The App Server docs say `thread/shellCommand` runs outside the thread sandbox with full access, and experimental `process/spawn` also runs outside it. Do not expose these methods to a provider adapter. Keep the client method allowlist narrow and use OS/process isolation; sandbox settings and approval prompts alone are not a substitute for server-side tool authorization. Do not enable `experimentalApi` by default. WebSocket is documented as experimental/unsupported for production; prefer local stdio.

Image input docs list URL and `localImage` forms; that is syntax evidence only. It does not prove that an installed version can safely access a given image or that this product is authorized to transmit it. The account's effective `thread/start.model` remains unknown until an allowed local runtime response supplies it.

**Status:** docs verified; local runtime, generated schema/protocol fixture, and live use not tested. Adapter is blocked until a version-pinned, safe local protocol probe is possible.

## Local Claude Code

The safe local probes were `claude --version` and `claude --help`; both completed without starting a model session. The installed version is `2.1.183`. Its help lists `-p`, `--output-format` (`text`, `json`, `stream-json`), `--json-schema`, `--mcp-config`, `--strict-mcp-config`, `--tools`, `--disallowedTools`, `--bare`, and `--permission-mode`.

Current official headless docs describe `-p` non-interactive mode, JSON/stream-JSON results, and structured output with `--json-schema`. The `system/init` stream event may report model, tools, MCP servers and load errors; `mcp_server_errors` requires Claude Code >=2.1.219. Since the installed CLI is 2.1.183, do not rely on that field without observing the actual event. A missing field is not proof that no server failed to load. Local `--help` confirms flag presence, not actual runtime behavior, loaded tools, auth mode, or model access.

Important auth and startup boundary: official docs and the installed help state `--bare` does not use subscription OAuth credentials; it accepts an API key or `apiKeyHelper` for Anthropic API access. Therefore `--bare` cannot be used to claim this is the user's subscription-authenticated Claude channel. In `-p` mode without `--bare`, Claude Code skips the workspace-trust dialog, runs project hooks and connects `.mcp.json` servers; an untrusted repository can therefore start commands before any human trust prompt. `--strict-mcp-config` can limit MCP loading to the explicitly supplied config but does not replace hook controls or OS sandboxing. Do not run an untrusted repository through the subscription CLI; verify an explicit minimal configuration and filesystem/network isolation before accepting untrusted model output.

Tool controls are not interchangeable:

- `--tools` restricts built-in tools, not MCP tools.
- `--allowedTools` auto-approves matching tools; it does not remove tools from the available set.
- `--disallowedTools` and permission rules can deny tools; `mcp__*` is documented as a deny-all-MCP rule. CLI rules are not an OS filesystem/network sandbox.
- `--strict-mcp-config` limits discovery to supplied MCP config, but a runtime fixture must still verify which servers/tools actually loaded and fail closed on errors.

The official current model config says `sonnet` is an alias for the latest Sonnet available for a provider and lists Sonnet 5 for Anthropic API; it also says Sonnet 5 requires Claude Code >=2.1.197. The installed CLI is 2.1.183. Thus the current docs do not establish that this installed runtime supports Sonnet 5 or that a subscription account can use it. Record the actual model from authorized result metadata when a safe runtime test is available; do not infer it from the alias or API catalog.

Claude model catalogs document image input, but the reviewed `claude -p` CLI documentation does not establish a dedicated local-image transport for this application. Treat image transport as unknown until a safe local fixture proves it. Do not use API mode to make the subscription path appear to work.

**Status:** official docs and local version/help verified; no auth state read, session started, protocol fixture run, or live model call. Local CLI version/model/tool isolation are not accepted for production adapter use yet.

## Direct API channels

### OpenAI Platform

The official catalog identifies the exact model ID `gpt-6-luna`, with text/image input and Responses API and Chat Completions support. The catalog recommends Responses for built-in tools and function calling; Chat Completions supports function calling only with `reasoning_effort=none`. This is an API model identity, not a Codex CLI or subscription model. Account availability, rate limits, billing and image authorization remain unverified. No API key was read or request made.

### Anthropic Platform

The current official model catalog maps Anthropic API Sonnet to `claude-sonnet-5`, with image input and tool use. Claude Code's `sonnet` alias is provider- and runtime-dependent; the API ID must not be assigned to every local Claude account or a third-party deployment. No API key was read or request made.

### Xiaomi MiMo API

The documented pay-as-you-go OpenAI-compatible base is `https://api.xiaomimimo.com/v1`, with `POST /chat/completions`. MiMo documents `api-key` and Bearer authorization headers. Token Plan uses the exact OpenAI- or Anthropic-compatible base URL displayed in that user's console; do not guess it. Pay-as-you-go `sk-...` and Token Plan `tp-...` credentials are independent.

The OpenAI-compatible request requires `model` and `messages`; `stream: true` returns server-sent events. Documented response usage may be `null`; preserve missing usage as unknown, never zero. Function tools support only a subset of JSON Schema in strict mode, and server documentation warns that generated tool-call arguments can be invalid or include unknown fields. Validate all output server-side.

Image understanding documents URL and Base64 data-URL input, a 50 MB maximum for a single image, and model support for v2.6 flash/pro/pro-ultraspeed and v2.5. Real-time local-file upload is not supported; Base64 encoding is still an outbound data request and requires policy/scope/consent checks. The endpoint docs do not define a real-time remote-cancellation guarantee or whether closing an SSE connection cancels backend work/billing. Do not report remote cancellation success or cost certainty based on client disconnect. Batch cancellation is a separate API and does not establish chat-completions cancellation behavior.

**Status:** docs verified; no account/plan check, credential inspection, request, image upload, or live result.

## Required runtime gate

Each adapter must keep three independent statuses: `docs_verified`, `protocol_fixture_tested`, and `live_tested`. Documentation never promotes the latter two. Before enabling an adapter, pin the actual runtime, generate and hash its real schemas where supported, test version-specific handshake/stream/cancel/error behavior without credentials, and verify the exposed tool set and filesystem/network isolation. All model/tool output is untrusted and remains subject to server-side schema/domain validation, project permission scopes, run budgets, and explicit human acceptance.

No provider was live-tested in this research. Codex is unavailable locally; Claude 2.1.183 is available but is below the documented minimum for the current Sonnet 5 model. Missing safe evidence is a blocked capability, not a reason to extract tokens, switch billing silently, widen tools, or claim compatibility.

## Official sources

All sources below were read on 2026-09-25. Links support documentation claims only.

| Source | Official URL |
|---|---|
| Codex App Server | <https://learn.chatgpt.com/docs/app-server> |
| Codex authentication | <https://learn.chatgpt.com/docs/auth> |
| Codex MCP | <https://learn.chatgpt.com/docs/extend/mcp> |
| Claude Code headless | <https://code.claude.com/docs/en/headless> |
| Claude Code CLI reference | <https://code.claude.com/docs/en/cli-reference> |
| Claude Code authentication | <https://code.claude.com/docs/en/authentication> |
| Claude Code model configuration | <https://code.claude.com/docs/en/model-config> |
| Claude Code MCP | <https://code.claude.com/docs/en/mcp> |
| Claude Code permissions | <https://code.claude.com/docs/en/permissions> |
| Anthropic model catalog | <https://platform.claude.com/docs/en/models/overview> |
| OpenAI GPT-6 Luna model | <https://developers.openai.com/api/docs/models/gpt-6-luna> |
| OpenAI production security | <https://developers.openai.com/api/docs/guides/production-best-practices> |
| MiMo Chat Completions compatibility | <https://mimo.mi.com/docs/en-US/api/chat/openai-api> |
| MiMo image understanding | <https://mimo.mi.com/docs/en-US/quick-start/usage-guide/multimodal-understanding/image-understanding> |
| MiMo API integration FAQ | <https://mimo.mi.com/docs/en-US/quick-start/faq/api-integration> |
