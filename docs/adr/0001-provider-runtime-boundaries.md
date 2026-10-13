# ADR 0001: Keep official local runtimes separate from provider APIs

- **Status:** Accepted
- **Date:** 2026-09-25
- **Decision owner:** WebLabel maintainers
- **Evidence register:** [Provider compatibility and evidence status](../provider-compatibility.md)

供 provider 集成维护者选择认证和运行通道。以下保存 2026-09-25 的历史决定与研究；当前 Codex 活动通道退役，相关描述不构成安装/接入步骤。活动通道以当前 required-channel manifest 和退役合同为准。ADR 本身不证明渠道可用。

## Context

此项决策区分五个 provider ID：`codex_local`、`claude_local`、`openai_api`、`anthropic_api`、`mimo_api`。型号、认证、计费、CLI 协议、图像能力与工具边界不能互换。当前官方文档也不能证明本机 CLI 或具体账户的行为。

2026-09-25 的本机观察为 Codex CLI 不可用、Claude Code 2.1.183 已安装，只读了 version/help，没有启动会话。当前官方文档要求 Sonnet 5 使用 Claude Code >=2.1.197，因此该安装版本不证明当前 Sonnet 支持。该次研究未授权或执行登录、凭证检查、模型请求或用户媒体上传。

## Decision

1. `codex_local` 与 `claude_local` 使用最终用户的官方本地运行时、文档协议及本人官方认证流程。不收集、复制、代理或逆向订阅 token。
2. `openai_api`、`anthropic_api`、`mimo_api` 是独立直接 API 通道，各有自己的凭证、型号、计费和 consent。API key 不能呈现为本地订阅认证。
3. provider ID、认证/计费模式、完整 model ID、runtime version 和能力证据分别记录。账户或版本相关未知值保持未知。
4. 文档核验、协议 fixture 测试、授权 live 测试是独立状态，只能由对应实际证据推进。
5. 本地 runtime 协议、模型输出和工具输出都不可信。启用 adapter 前，必须固定并探测安装版本，校验协议及模型输出，在服务端/OS 边界限制工具和 cwd，执行 run-scoped 权限及预算；标注变更仍须人工明确接受。
6. Codex 使用本地 stdio，从固定 CLI 生成 schema，默认不开放文档中绕过沙箱的 shell/process 方法或实验 API。Claude 使用明确 MCP 配置，区分“可用工具”和“自动批准工具”，检查元数据及加载错误；权限模式不能当作文件系统/网络隔离。
7. 图片外发需要实际项目策略、有效 scope 和用户授权。URL/Base64 语法支持不授权上传。

## Alternatives rejected

- **把 API key 当订阅通道。**认证、计费、权益和能力不同。
- **从别名或当前目录推断 runtime 型号。**别名取决于 CLI 版本、provider 和账户权益。
- **提取缓存订阅凭证或代理 token。**违反产品边界并暴露凭证。
- **用提示词或 CLI 审批设置代替工具安全。**它们不能替代服务端允许列表与 OS 文件/网络限制。
- **把文档核验标成协议或 live 验收。**未执行固定 runtime 或授权请求，就没有这类证据。

## Consequences

- CLI 不可用或安全边界未验证时标 `blocked`，不是偷偷降级的机会。Codex 仍需 CLI 和生成 schema 探针；当前 Claude 安装版本不证明 Sonnet 5 支持。
- 直接 API 可独立实现，但必须提供授权凭证来源、策略/scope 批准和真实能力测试后才可用。本文和兼容性登记不保存凭证。
- 请求 abort 只证明客户端停止等待。MiMo 文档没有证明实时 SSE 的远端生成/计费取消，UI 必须保留不确定性。
- `docs/provider-compatibility.md` 记录带来源和日期的事实。runtime 升级后重新核验 version/help/schema，不继承旧兼容结论。
