# ADR 0001: Keep official local runtimes separate from provider APIs

- **Status:** Accepted
- **Date:** 2026-09-25
- **Decision owner:** WebLabel maintainers
- **Evidence register:** [Provider compatibility and evidence status](../provider-compatibility.md)

## Context

The product has five distinct provider IDs: `codex_local`, `claude_local`, `openai_api`, `anthropic_api`, and `mimo_api`. Their model names, auth modes, billing, CLI protocols, media capabilities, and tool boundaries are not interchangeable. A current documentation page cannot prove the behavior of a locally installed CLI or a user's account.

The local workspace reports Codex CLI unavailable. Claude Code 2.1.183 is installed; its version/help were read without starting a session. Current official Claude docs require version 2.1.197 or later for Sonnet 5, so this installed version does not establish the requested current Sonnet model. No provider login, credential inspection, model request, or user-media upload was authorized or performed.

## Decision

1. `codex_local` and `claude_local` use the end user's official local runtime, with its documented protocol and the user's own official authentication flow. WebLabel does not collect, copy, proxy, or reverse-engineer subscription tokens.
2. `openai_api`, `anthropic_api`, and `mimo_api` are direct API channels with distinct API credentials, model IDs, billing, and consent. An API key is never presented as local subscription authentication.
3. Provider ID, authentication/billing mode, exact model ID, runtime version, and capability evidence are separate fields. Unknown account- or version-specific values stay unknown.
4. Documentation verification, protocol-fixture testing, and authorized live testing are independent states. Only actual evidence advances each state.
5. Local runtime protocols and model/tool outputs are untrusted. Before an adapter is enabled, the host must pin/probe its installed version, validate protocol messages and model output, constrain tools and working directories at the server/OS boundary, apply run-scoped permissions and budgets, and require explicit human acceptance for annotation changes.
6. Codex integrations use local stdio, generate schemas from the pinned CLI, and avoid documented out-of-sandbox shell/process methods and experimental APIs by default. Claude integrations use an explicit MCP configuration, distinguish available tools from auto-approved tools, check runtime metadata/load errors, and do not treat permission patterns as filesystem/network isolation.
7. Image egress requires a real project policy decision, effective permission scope, and user authorization. Documented URL/Base64 support alone never authorizes upload.

## Alternatives rejected

- **Treat a direct API key as the subscription product.** Rejected: auth, billing, entitlement and features differ.
- **Infer a runtime's model from an alias or current model catalog.** Rejected: aliases depend on CLI version, provider and account entitlement.
- **Extract cached subscription credentials or proxy them.** Rejected: violates the product boundary and creates credential exposure.
- **Trust model prompts or CLI approval settings as tool security.** Rejected: they do not replace server-side allowlists and OS-level filesystem/network constraints.
- **Mark documentation as protocol or live acceptance.** Rejected: no such evidence exists without executing the corresponding pinned runtime or authorized request.

## Consequences

- An unavailable CLI or unverified safety boundary is `blocked`, not a fallback opportunity. The Codex local channel remains blocked until its CLI and generated schema can be probed; the current Claude local version does not establish Sonnet 5 support.
- Direct API channels can be implemented separately, but remain unavailable until an authorized credential source, policy/scope approval and real capability test are provided. No credentials are stored in this ADR or compatibility register.
- A request abort only proves the client stopped waiting. MiMo documentation does not establish remote generation or billing cancellation for real-time SSE; the UI must preserve that uncertainty.
- `docs/provider-compatibility.md` is the source-linked current facts register. Runtime upgrades require refreshing the version/help/schema evidence rather than silently inheriting old compatibility claims.
