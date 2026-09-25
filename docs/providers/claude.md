# Claude 官方订阅运行时（`claude_local`）— T23

主Agent集成记录（依据实现、测试与命令日志撰写；本文与 `reports/T23/*` 只引用可核实事实）。

## 渠道定位

`claude_local` 是 `ProviderAdapter` 的官方 Claude Code 非交互通道（`-p/--print` headless、
stdio、`stream-json` 输出，合同基线 docs/provider-compatibility.md 与
docs/adr/0001-provider-runtime-boundaries.md，T02 核验）。它与 T20 的 `anthropic_api` 是
**两个独立 profile**：本通道保留官方订阅登录与用户自付；`anthropic_api` 是独立的 Console
API key 计费通道。**API 调用永远不会被呈现为订阅运行成功**：`--bare`（强制 API key /
apiKeyHelper 计费）从不出现在启动参数里，凭证类环境变量（`ANTHROPIC_API_KEY`、
`ANTHROPIC_AUTH_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN`）永远无法被 allowlist 进子进程，
运行时元数据一旦报告 `auth_mode=api_key` 即以独立状态 `api_auth_not_subscription` 失败；
**缺少或未知 `auth_mode` 一律按 `needs_login` 失败**（绝不当作订阅成功），没有任何 init 的
result 按 `claude_protocol_violation` 失败。

## 本机状态（如实）

- **Claude Code 2.1.183 已安装**。本任务只执行了 `claude --version`（exit 0，
  `2.1.183 (Claude Code)`）与 `claude --help`（exit 0，224 行）；完整原文存
  `reports/T23/claude-version.txt`、`reports/T23/claude-help.txt`。二者均不启动会话、
  不联网、不读取认证状态。
- **本任务零外部调用**：未登录、未联网、未订阅调用、未执行任何 `claude -p` 真实运行、
  未运行 `auth` 子命令。测试中的子进程全部是 `node <fake-cli>` 合成脚本。
- **协议 fixture / 真实运行 = T32 关卡**。当前 `probe()` 永远不报告 `ready`/`live`：
  CLI 缺席 → `needs_configuration`；其余 → `blocked`（协议与工具隔离边界未经真实运行时
  验证，ADR 0001）。`verification` 恒为 `not_run`。
- 型号身份诚实：`ModelProfile.model_id='unknown'`。当前官方文档的 `sonnet` 别名指向
  Sonnet 5，但要求 Claude Code ≥2.1.197；本机 2.1.183 **不建立** Sonnet 5 支持，别名与
  API 目录都不得用来推断本机/本账号的有效型号。`--model` 只接受帮助输出中逐字出现的
  别名（fable/opus/sonnet）或简单形状的完整 id，用于运行期与 `system/init` 报告值比对
  （不一致 → 独立 `model_unavailable`）。

## 启动计划（全部 flags 来自本机 `claude --help` 逐字核验）

启动参数由 `buildClaudeLaunchPlan` 生成，除下列已核验 flags 外不传任何参数：

| 参数 | 作用 | 证据 |
|---|---|---|
| `-p` | 非交互输出（管道可用） | help 逐字 |
| `--output-format stream-json` | 流式事件边界 | help 逐字 |
| `--input-format text` | 提示词经 stdin（默认 text） | help 逐字 |
| `--mcp-config <file>` | 只注入本项目 MCP（0600 生成文件） | help 逐字 |
| `--strict-mcp-config` | 只用 `--mcp-config` 的服务器，忽略其他 MCP 配置 | help 逐字 |
| `--tools ""` | **禁用全部内建工具**（MCP 不受影响） | help 逐字 |
| `--allowedTools <五工具>` | 仅自动批准 T21 五个 MCP 工具 | help 逐字 |
| `--disallowedTools <执行面>` | 对 Bash/Write/Edit/Read 等再加 deny 规则 | help 逐字 |
| `--setting-sources local` | 限制 user/project 设置串入（语义为 pin，T32 复核） | help 逐字 |
| `--no-session-persistence` | 会话不落盘、不可恢复 | help 逐字 |
| `--json-schema <schema>` | 候选草稿的结构化输出（校验以服务端为准） | help 逐字 |
| `--model <id>` | 可选；仅简单形状 id/已核验别名 | help 逐字 |
| `--session-id <uuid>` | 本 run 的会话 id（外来会话事件被拒） | help 逐字 |
| `--version` | **probe 唯一调用面**（免会话） | help 逐字 |

**从不使用**：`--bare`（丢弃订阅 OAuth、改走 API key 计费）、`--dangerously-skip-permissions`、
`--allow-dangerously-skip-permissions`、`--permission-mode bypassPermissions/auto/acceptEdits`、
`--betas`、`--fallback-model`、`--plugin-*`、`--add-dir`、`--remote-control`、`--worktree`。
未核验语义的 `--permission-mode dontAsk` 也不作为安全控制使用：权威限制是
`--tools ""` + allow/deny 规则 + `--strict-mcp-config`（CLI 规则不是 OS 文件系统/网络沙箱，
T16 hardened spawn 与 run cwd 隔离才是）。

## 固定 schema 与 T32 再生成清单

Claude Code **没有** CLI 侧 schema 生成命令（`--help` 全文核验；与 Codex `app-server
generate-ts/generate-json-schema` 不同），因此协议事实只能来自文档 + 真实运行时抓取。
以下符号是**项目固定 pin**，未经真实运行时证实，T32 必须用版本固定的官方 CLI 抓取真实
`stream-json` fixture 并用其校验/替换本解析器：

- 事件族：`system`(subtype `init`) / `assistant` / `user` / `result`（文档确认
  stream-json 输出与 `system/init` 元数据事件；其余为 pin）
- 载荷字段名：`message.content` 内容块（`text` / `tool_use` / `tool_result`）、
  `session_id`、`usage`、`structured_output`、`proposals`、`error.{message,state}`、
  `is_error`、`subtype==='success'`
- init 元数据字段名：`model`、`tools`、`mcp_servers`、`auth_mode`（pin）、
  `mcp_server_errors`（文档字段名；**≥2.1.219 才有**，本机 2.1.183 缺席=未知，
  绝不解释为“没有服务器加载失败”）
- 状态标记 `error.state` ∈ `needs_login | model_unavailable | subscription_unavailable |
  insufficient_quota | api_auth_not_subscription`（产品状态 pin，精确匹配）
- MCP 配置文件形状 `mcpServers.<name>.{command,args,env}`；工具命名 `mcp__<server>__<tool>`

**T32 步骤**：以安装的官方 CLI 在授权环境抓取真实 `stream-json` 输出（init/工具/结果各一），
固定版本与哈希，作为 `apps/agent-host/test/fixtures/` 的 `fixture_kind: synthetic_protocol`
以外的**真实**协议 fixture，校验上述每个 pin；再跑真实订阅登录与真实图像运行。未完成该步
之前，本适配器的解析**不是**真实 CLI 兼容证据。

## 行为保证（合成 transcript 覆盖，均标注 SYNTHETIC）

1. 流式输出 / `tool_use` / `tool_result` / 最终 result 分界可靠：未匹配 tool_result、
   成功 result 时仍有未闭合 tool_use 都是受控 `claude_protocol_violation`，**不写任何标注**；
   截断 JSON 是受控 `invalid_json` 失败，草稿绝不触达 `submit_candidates`。
2. 官方认证与用户自付保留：无自建登录、无 token 中转、无凭证收集/保存；无 consent 记录
   则拒绝启动、不读图、不接触运行时。
3. allow/deny 策略在两层实测：启动计划（`--tools ""`、五工具 allow、执行面 deny、
   `--strict-mcp-config`、单 MCP 服务器、无 flag/命令注入、token 只经 env）与运行期
   元数据/事件校验（init.tools 超面、外来 MCP 服务器、`Bash` 类 tool_use →
   `method_not_permitted`；MCP 加载失败/缺本项目服务器（含 `mcp_servers` 为空）→ `mcp_load_error`）。
   run cwd 永不指向用户仓库（realpath 包含性校验，fail closed）。
4. 账号/型号/订阅不符独立呈现：`needs_login`、`model_unavailable`、
   `subscription_unavailable`、`insufficient_quota`、`api_auth_not_subscription`
   各自独立终态，绝不返回假候选、绝不把 API 通道伪装成订阅成功。
5. 真实图像运行在 T32 核验。本适配器**不暂存任何像素字节**：图像只经 T21 MCP
   `read_region` 面（consent 作用域 + crop/pixel 预算服务端强制，MCP image content block
   返回）。合成测试只覆盖解析与错误路径。
6. usage 只取终态 result 一次（重放/重复/乱序不重复计费；外来会话事件与未标注会话的
   result 不进计费、不终止运行，记入 violations；assistant/user 帧可无 session_id），
   usage 为空 = unknown（绝不显示 0），费用只由显式定价计算。
7. 工具回路有界：turns（默认 32）、bytes（默认 1 MiB）、time（runTimeoutMs）分别以
   `tool_turn_budget_exceeded` / `tool_byte_budget_exceeded` / `tool_time_budget_exceeded` 失败。
8. 候选只经 `ctx.submit_candidates`，严格 schema+domain 校验后才入库，始终携带原始 run
   context（C4）；`bbox_output=false`，属性审校不得 create/改 bbox（合成 create 草稿被拒）。
   取消时已完整解析的候选照常校验提交（原 context），终态恒为 `cancelled` +
   `billing='may_have_cost'`、`cost_display='unknown'`（无 usage 时）；**UI 不宣称退款**。

## 安全与预算

- 通过 T16 hardened spawn 启动：shell:false、可信可执行根、argv 数组（prompt 永远走
  stdin、绝不进 argv）、env 白名单（SystemRoot/PATH/… 最小基线，Windows 强制注入基线
  在测试中断言无其他泄漏）、受限 cwd、进程树回收。
- run-scoped MCP token 只经子进程环境与 0600 的生成 MCP 配置文件传递；argv、可执行路径、
  工具参数、输出中都不出现（测试断言）。`NODE_OPTIONS` 等注入向量与凭证类环境变量永远
  不能被 allowlist。
- `--bare` 等 API 计费/绕过权限 flags 结构性不存在；模型 id/argv 前缀做注入形状校验。
- 取消即杀进程树（`-p` 文本输入无已证实的 turn-interrupt 请求），最多排空 5s 已到达行；
  取消可能已产生费用，按 `may_have_cost` 如实报告。

## 验证记录

实现者记录（`reports/T23/tests.log` 为完整真实输出与退出码）：

- RED：骨架模块 35 collected / 34 真实行为失败（`reports/T23/red-phase.txt`）。
- `pnpm exec vitest run apps/agent-host/test/t23_claude.test.ts` → exit 0，**35/35**；
  `pnpm test:task T23` → exit 0，35/35。
- 回归 `t16+t20+t21+t22` → exit 0，**100/100**；`pnpm test:contracts` → exit 0，3/3。
- `cargo test -p weblabel-api --locked` 裸跑被机器 user-global nightly-only cargo 配置
  阻塞（exit 101，如实记录，全局配置未改动）；经 T16 记录的 CARGO_HOME shim 配方
  （1.96.0 pinned 工具链）→ exit 0，**78/78（9 suites）**。`cargo fmt --all --check` → exit 0。
- `pnpm --filter @weblabel/web exec tsc --noEmit --strict ...`（5 个触达 TS 文件，
  相对路径正确解析）→ exit 0；同命令附加故意 TS2322 文件的负对照 → exit 1，
  证明诊断真实生效（不是 TS6053 空跑）。

**未验证（T32）**：真实订阅登录、真实图像运行、真实 stream-json 协议 fixture 与
pin 复核、`--setting-sources`/`--permission-mode` 在固定版本上的真实语义、
`mcp_server_errors` 字段（本机版本无此字段）。
