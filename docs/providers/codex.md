# Codex 已退役：历史身份 `codex_local` — T22

本项目不再提供 Codex 活动适配器、安装步骤、CLI 调用入口或执行兼容路径。`openai_api` 与 `claude_local` 不是其 alias，不自动替代旧选择。

## 历史保全

Rust 领域枚举 `ProviderId::CodexLocal` 与 wire 值 `codex_local` 仍可解码历史 `ModelProfile`、profile snapshot、RunSummary、幂等回执及 prediction/decision。旧数据库行、run/model 身份和已持久终态不重写。历史 T22 actualcommit、合成协议验证以及真实条件未满足的记录仍保留在 `reports/T22/`；当前退役不将这些记录改成“从未实现”。

## 当前边界

- 活动 model profile 列表与 Web 选择器隐藏退役 profile。
- 明确选择旧 profile 的新 preview/start 返回 409 `PROVIDER_RETIRED`，没有新的 preview/consent/run/job。
- 同 operation、同 payload 的历史回放仍返回原 run；换 payload 仍返回 409，不重新执行。
- 旧 queued run 在 runner 调用前持久化 failed/`PROVIDER_RETIRED`；取消优先。终态、事件与历史身份保留。
- ProductionRunner、Host 实值配置在 runtime context、授权 token 或子进程执行前拒绝该通道；UI 缓存旧选择不可运行。
- 历史采纳/撤销和通用政策撤销约束不因退役删除。

当前 T22 行为验收见 `tasks/T22.md`、`crates/weblabel-api/tests/t22_provider_retirement.rs` 与 Host `t25_runtime`。本轮工程证据使用新 repair 子目录，不覆盖旧报告。

## 发行边界

`tests/live/manifest.json` 当前必需渠道为 Claude 本人官方订阅/full Sonnet、OpenAI API/full Luna、MiMo image API、锁定 RT-DETR 检测器四项；Anthropic API 可选。各渠道不能互相替代证明。退役不解除缺实际调用授权和原始 live 证据的 blocked，也不把安全排除记成通过。
