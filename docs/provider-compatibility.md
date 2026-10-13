# Provider compatibility and evidence status

供集成工程师核对型号、计费、认证和本地 runtime 的区别。本登记保存 2026-09-25 的历史研究，不证明账户权益、有效凭证或 live 请求。**当前 Codex 活动渠道已退役；下文 Codex 协议与命令仅为原研究归档，不是安装/调用入口，不执行其 CLI 探针。** 当前四必需渠道与可选 Anthropic 以 `tests/live/manifest.json` 为准；退役行为见 `providers/codex.md`。后续工程与 live 尝试查 verification.md 和任务报告。

## Evidence levels

- **Docs verified：**官方页面说明了相应行为，不是 runtime 测试。
- **Protocol fixture tested：**固定安装版本产出协议/schema 证据，并由项目校验。此项研究时没有渠道达到该状态。
- **Live tested：**实际执行了授权真实模型请求并记录结果。此项研究没有这类结果；后续尝试不能倒写为当时已通过。

未知或账户相关值保持 `null`，不从营销别名推断。provider ID、认证/计费通道、model ID 分别记录。

## Provider matrix

| provider ID | 通道与认证/计费 | 型号身份 | 文档依据 | 2026-09-25 的 runtime/live 状态 |
|---|---|---|---|---|
| `codex_local` | 官方 Codex CLI App Server，本地 stdio。ChatGPT 订阅登录、API-key 计费、enterprise access token 是不同模式。 | `null`；App Server 接收 model 参数，账户可用型号并不通用。 | Codex App Server、Authentication、MCP。 | 本机 CLI 不可用，未跑 version/help 或生成 schema；协议/live 未测。 |
| `claude_local` | 官方 Claude Code -p，使用本人 Claude 订阅登录。Anthropic Console API key 是另一计费通道，不能暗中替换。 | 本机/账户值 `null`。官方当前 sonnet 在 Anthropic API 映射 Sonnet 5，但需 CLI >=2.1.197；已装 2.1.183 不能证明选择 Sonnet 5。 | Claude headless、CLI、auth、model、permission。 | version/help 显示 2.1.183；未启动 provider、auth-status、MCP、schema fixture 或 live。 |
| `openai_api` | 直接 OpenAI Platform API，另行授权 API key，不是 Codex 订阅。 | 官方当前 API 精确 ID `gpt-6-luna`。 | GPT-6 Luna 和 API security。 | 只核文档，无 key 检查、请求、权益检查或 live。 |
| `anthropic_api` | 直接 Anthropic Platform API，Console API key，不是 Claude 订阅/CLI。 | 核验时当前 API Sonnet ID `claude-sonnet-5`。 | Anthropic Models overview。 | 只核文档，无 key 检查、请求、权益检查或 live。 |
| `mimo_api` | 直接 Xiaomi MiMo API。pay-as-you-go sk-... 与 Token Plan tp-... 是独立产品，后者以用户控制台 base URL 为准。 | `mimo-v2.6-flash`、`mimo-v2.6-pro`、`mimo-v2.6-pro-ultraspeed`、`mimo-v2.5-pro`、`mimo-v2.5`。 | Chat Completions、image-understanding、FAQ。 | 只核文档，无 key 检查、请求、账户/套餐检查或 live。 |

## Local Codex App Server

先固定并探测实际 CLI 版本，再使用官方 app-server stdio。文档协议为 JSONL、JSON-RPC 2.0，但 wire 省略 jsonrpc header。每条连接恰好一次 initialize，再发送 initialized；握手前的其他请求和重复初始化都拒绝。流式通知携带 turn/item 事件；turn/interrupt 是文档取消请求，仍须读 runtime 返回的终态。

固定版本支持的 schema 命令见下方。该次研究因 codex 不在 PATH，未执行它们，也没有项目 schema artifact 或 hash。不能手写替代品后称为已安装协议。版本可用时，生成两份工件，记录 CLI 版本/hash，并据此校验消息。

```text
codex app-server generate-ts --out <dir>
codex app-server generate-json-schema --out <dir>
```

ChatGPT 订阅登录、API-key usage billing 和 enterprise access token 分开；后者是文档中的 trusted-automation 模式。项目不得检查或提取缓存认证、代理订阅凭证，也不能暗中切换计费。

App Server 文档指出 thread/shellCommand 以完整权限在 thread sandbox 外运行，实验 process/spawn 也在沙箱外。adapter 不能暴露这些方法。client 方法允许列表必须窄，并配合 OS/process 隔离；sandbox 设置与审批不能替代服务端工具授权。默认不启用 experimentalApi。WebSocket 仍是实验/不受支持的生产路径，优先本地 stdio。

图片 URL/localImage 只是语法证据，不证明安装版本能安全读图，更不授权外发。有效 thread/start.model 要从授权 runtime 响应获取，不能猜账户权益。

**该次状态：**文档已核；本地 runtime、生成 schema/协议 fixture、live 未测。adapter 在固定版本安全协议探针之前 blocked。

## Local Claude Code

安全探针只跑 claude --version 和 claude --help，没有启动模型会话；安装版本为 2.1.183。help 列出 -p、--output-format（text/json/stream-json）、--json-schema、--mcp-config、--strict-mcp-config、--tools、--disallowedTools、--bare、--permission-mode。

当前 headless 文档说明 -p 非交互、JSON/stream-JSON 及 --json-schema。system/init 可能报告 model、tools、MCP server 和加载错误；mcp_server_errors 需 CLI >=2.1.219，不能默认 2.1.183 有该字段。缺字段不代表没有加载失败；help 有 flag 也不证明实际行为、加载工具、auth mode 或模型权限。

--bare 不使用订阅 OAuth，只接 API key 或 apiKeyHelper，因此不能用它证明订阅通道。-p 不带 --bare 时跳过 workspace-trust 对话，仍会运行项目 hooks 并连接 .mcp.json：不可信仓库可能在人工信任提示前启动命令。--strict-mcp-config 可限 MCP 来源，不能替代 hook 控制或 OS 沙箱。订阅 CLI 不应运行不可信仓库；任何真实运行前，要验证明确的最小配置和文件/进程边界。

工具控制并不等价：

- --tools 只限制内建工具，不限制 MCP。
- --allowedTools 自动批准匹配工具，不从可用集合删除其他工具。
- --disallowedTools/permission rules 可拒绝工具；mcp__* 是文档的拒绝所有 MCP 规则。CLI 规则不是 OS 文件/网络沙箱。
- --strict-mcp-config 只用明确 MCP 配置；runtime fixture 仍要验证实际加载 server/tools，加载错误时拒绝。

sonnet 是依 provider 选择最新可用 Sonnet 的别名。当前文档列 Anthropic API Sonnet 5，并要求 Claude Code >=2.1.197；2.1.183 及当前目录都不证明本机/本订阅能用 Sonnet 5。安全实测后记录 result metadata 的实际型号，不从别名/API 目录推断。

模型目录说明图像输入，但已审查的 claude -p 文档没有建立本应用专用本地读图传输。安全 fixture 证明前，图像传输保持未知；不能用 API 模式假装订阅通道成功。

**该次状态：**官方文档与 version/help 已核；未读 auth state、启动 session、跑协议 fixture 或 live。安装版本、型号和工具隔离还不能用于生产 adapter。

## Direct API channels

### OpenAI Platform

官方目录精确 ID 为 gpt-6-luna，支持 text/image、Responses API 和 Chat Completions。内建工具/function calling 建议 Responses；Chat Completions 只在 reasoning_effort=none 时支持 function calling。这是 API 身份，不是 Codex CLI 或订阅型号。账户权限、额度、计费与图像授权未验；未读 key 或请求。

### Anthropic Platform

当前 API 目录为 claude-sonnet-5，支持图像和工具。Claude Code 的 sonnet 依 provider/runtime 变化，不能把 API ID 赋给所有本地账户或第三方部署。未读 key 或请求。

### Xiaomi MiMo API

文档中 pay-as-you-go 的 OpenAI-compatible base 是 https://api.xiaomimimo.com/v1，使用 POST /chat/completions；支持 api-key 和 Bearer。Token Plan 必须用该用户控制台给出的精确 OpenAI/Anthropic-compatible base，不猜地址；sk-... 和 tp-... 凭证独立。

请求要求 model/messages，stream: true 返回 SSE。usage 可为 null，缺失必须保持 unknown，不能写 0。strict function tool 只支持 JSON Schema 子集；生成参数仍可能非法或带未知字段，输出必须由服务端校验。

图像文档支持 URL/Base64 data-URL，单图最大 50 MB，支持 v2.6 flash/pro/pro-ultraspeed 和 v2.5。不支持实时 local-file upload。Base64 仍属于外发，需 policy/scope/consent。文档未保证实时远端取消，也未说明 SSE 断连是否停止后台工作/计费；不能由断连宣称取消成功或费用确定。Batch cancellation 是独立 API，不证明 chat-completions 取消行为。

**该次状态：**文档已核，无账户/套餐检查、凭证检查、请求、上传或 live 结果。

## Required runtime gate

adapter 分别维护 docs_verified、protocol_fixture_tested、live_tested，文档不能推进后两者。启用前固定 runtime，在支持时生成真实 schema 并记录 hash；无凭证测试版本相关握手、流、取消、错误，核实可用工具与文件/网络隔离。模型/工具输出仍受服务端 schema/domain、项目 scope、run 预算和人工明确接受约束。

此项研究没有 live provider。Codex 当时不可用，Claude 2.1.183 低于当前 Sonnet 5 最低版本。缺安全证据就 blocked，不能提取 token、暗换计费、扩工具或宣称兼容。

## Official sources

以下来源读取于 2026-09-25，只支持文档事实，不是运行证明。

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
