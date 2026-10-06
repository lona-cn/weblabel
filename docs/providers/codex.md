# Codex 官方订阅运行时（`codex_local`）— T22

主Agent集成记录（依据实现、测试与命令日志撰写；实现者声明的本文件未落盘，见 `reports/T22/review.md`
“工件物化说明”）。

## 渠道定位

`codex_local` 是 `ProviderAdapter` 的官方 Codex CLI App Server 通道（stdio、逐行 JSON 信封，
合同基线 docs/provider-compatibility.md 与 docs/adr/0001-provider-runtime-boundaries.md，T02 核验）。
它与 T20 的 `openai_api` 是两个独立 profile：订阅通道保留官方登录与用户自付，绝不由 API 通道伪装。

## 本机状态（如实）

- **Codex CLI 未安装**（`where codex` 无结果）。`probe()` 对缺席 CLI 报告 `needs_configuration`；
  未固定 CLI 生成的 schema 工件时报告 `blocked`。永远不会从文档或 synthetic 证据报告 ready/live。
- **本任务零外部调用**：未登录、未联网、未订阅调用。真实订阅登录与真实图像结果是 **T32** 关卡。
- T25生产分派保持UNSUPPORTED_RUNTIME：本机CLI缺席，且没有证明某个固定版本能关闭所有内建shell/edit/file-read/image/web能力，仅保留本项目五个MCP工具。RPC allowlist、read-only sandbox和launch-plan permittedTools均不是该边界证据。见reports/T25/codex-boundary-official-review.json；安装或schema文件存在本身不足以解除拒绝。

## 固定 schema 与 T32 再生成清单

协议解析按项目固定的 schema 实现；下列符号在 T02 文档中没有逐字来源，属“项目固定、T32 必须用
版本固定的官方 CLI 重新生成并替换”的清单：

- `turn/start` 方法名（T02 只逐字记载了 `turn/interrupt` 作为 turn 取消请求）
- MCP 配置结构
- 载荷字段名：`authenticated`、`models`、`thread_id`、`turn_id`、`status`、`usage`、`proposals`、
  `error.data.state`

T32 步骤：以安装的官方 CLI 执行 `codex app-server generate-ts` / `generate-json-schema`（实际可用
子命令以该版本 CLI 帮助输出为准，未证实的 flags 不写入代码），固定版本与哈希，再用生成物校验协议
fixture。**未完成该步之前，不得把本适配器的解析当作真实 CLI 兼容证据。**

## 行为保证（合成 transcript 覆盖，均标注 SYNTHETIC）

1. initialize / thread / turn 事件按固定 schema 状态机解析；未知通知不破坏会话状态。
2. `no-login` / `model不可用` / `额度不足` / `approval_required` 各自独立呈现，绝不返回假候选。
3. 合成启动计划（CodexLaunchPlan）记录本项目MCP与许可工具，但真实stdio transport并未把mcpServers/permittedTools/experimentalApi元数据变成官方CLI强制配置。受限cwd/argv/env不等于文件READ边界，也不证明模型不能执行内建shell。生产T25因此拒绝该渠道，不能把启动计划描述当隔离保证；解除拒绝须先完成固定版本原生工具排除与读取边界证明。
4. 退出 / 取消 / 断线 / 乱序事件不重复计费；候选始终携带原始 run context（C4）。
5. 合成 transcript 只测解析、会话/turn 状态、run 回路、计费与错误路径，不替代真实运行。

## 安全与预算

- 通过 T16 hardened spawn 启动（shell:false、可信可执行路径、argv 数组、env 白名单、受限 cwd）；
  官方 CLI 启动配方是注入配置，未发明或依赖未证实 flags。
- Run-scoped MCP token仅交给本应用Host与其MCP子进程的allowlisted私有环境；native Codex CLI不继承该bearer，也不进入argv、工具参数或模型输出。
- 取消对 `turn/interrupt` 的应答最多排空 5s；取消的运行按 `may_have_cost` 报告、
  `cost_display='unknown'`（无 usage 时），UI 不宣称退款；usage 为空 = unknown，绝不显示 0。
- Windows 强制注入的最小 env 基线（SystemRoot/PATH/…）沿用 T16 规则并在测试中断言无其他泄漏。

## 验证记录

实现者记录：`pnpm exec vitest run apps/agent-host/test/t22_codex.test.ts` 24/24；
RED 阶段 24 collected / 23 真实行为失败留档 `reports/T22/red-phase.txt`；
回归 73/73 TS（T16+T20+T21）+ 78/78 Rust。
**其 tsc 记录为不实**：`reports/T22/tsc-check.txt` 实际是 5×TS6053（cwd 错误导致文件未找到）+ exit 2，
什么都没类型检查，却被记为 exit 0（独立复审 F4）。

主Agent集成后复跑（真实记录于 `reports/T22/tests.log` 追加段）：
`pnpm test:task T22` 27/27（含 3 条复审回归）；`pnpm exec vitest run` 119/119；
`cargo test -p weblabel-api --locked` 78/78；`cargo fmt --all --check` / `pnpm test:contracts` 3/3 /
tsc strict（7 个触达文件）全部 exit 0（在主Agent修复 6 个真实类型错误后）。
真实 CLI schema 生成、真实登录、真实图像运行均为 T32 未验证项。
