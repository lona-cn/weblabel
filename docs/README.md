# WebLabel 文档总入口

本文供操作者、开发者和维护/验收者选择阅读路线。读后行动：找到负责当前动作的维护文档与真实证据。目录不声明产品已验证或发布通过。

## 操作者路线

先读[项目介绍](../README.md)，再按[构建、登录和标注指南](getting-started.md)完成本地人工流程；团队审核与备份分别进入[运维手册](operations.md)和[备份恢复](backup-restore.md)。故障先按[故障指南](troubleshooting.md)保全，受支持范围见[已知限制](known-limitations.md)。

## 开发者路线

从[恢复入口](../START_HERE.md)核对状态，按[开发指南](development.md)准备工具、定位模块和选择检查。再读[配置参考](configuration.md)、[架构](architecture.md)、[数据模型](data-model.md)、[共享契约](contracts.md)及[API 参考](api-reference.md)，用[测试装配](testing-contracts.md)与[协作规程](execution.md)完成变更。按[文档治理](documentation-policy.md)同步说明，运行 `pnpm docs:check` 只证明结构。

## 维护与验收者路线

按[验收说明](verification.md)选择范围；人工路径用[手工验收](manual-smoke.md)，账户与恢复用[运维](operations.md)/[备份恢复](backup-restore.md)，实际结果查[报告索引](../reports/index.md)。当前任务状态来自 [TASKS.json](../TASKS.json)、[STATUS.json](../STATUS.json)和真实提交，不由本文复制或升级。任务卡出链由 TASKS.json 的 card 列表登记，36 项依赖入口见[实施计划](../PLAN.md#完整任务目录)。

## 文档目录

| 文档 | 类型 | 读者与读后动作 | 维护责任 | 事实范围/权威依据 | 更新触发 |
|---|---|---|---|---|---|
| [../README.md](../README.md) | 入口 | 操作者：判断范围并开始使用 | main | 当前介绍与已绑定报告 | 功能、教程或证据边界变化 |
| [../START_HERE.md](../START_HERE.md) | 入口 | 开发维护者：恢复当前工作 | main | 恢复约束与任务系统 | 启动、恢复或检查入口变化 |
| [../START_PROMPT.md](../START_PROMPT.md) | 入口 | 主集成者：仅在空目录初始化 | main | 原初始化要求 | 初始化约束变化 |
| [../PLAN.md](../PLAN.md) | 计划 | 维护者：确认边界与 DAG | main | 设计目标，不是完成状态 | 范围或批准计划变化 |
| [../AGENTS.md](../AGENTS.md) | 规范 | 全部工作者：遵守执行约束 | main | 项目安全与协作不变量 | 执行约束变化 |
| [README.md](README.md) | 入口 | 三类读者：选择路线与专题 | main | 当前维护目录 | 文档新增、移动或职责变化 |
| [documentation-policy.md](documentation-policy.md) | 规范 | 作者与审查者：维护和交付文档 | main | 文档治理约束 | 写作、审查或门禁变化 |
| [getting-started.md](getting-started.md) | 指南 | 操作者：构建登录标注并导出 | wl-backend / wl-web | 当前使用步骤与历史实测边界 | 启动或界面流程变化 |
| [architecture.md](architecture.md) | 参考 | 开发者：按边界定位模块 | main / wl-core | 设计目标与当前拓扑说明 | 模块或设计约束变化 |
| [contracts.md](contracts.md) | 规范 | 接口维护者：迁移全部消费者 | main / wl-core | 现行 v1 契约及实现增量 | 字段、路由或不变量变化 |
| [testing-contracts.md](testing-contracts.md) | 规范 | 开发者：复用测试 helper 与夹具 | wl-qa | 现行测试装配契约 | helper 或装配变化 |
| [execution.md](execution.md) | 规范 | 主集成者：隔离派工审查并恢复 | main | 现行协作约束 | 调度与目录边界变化 |
| [verification.md](verification.md) | 参考 | 验收者：选择检查并解释门禁 | wl-qa / main | 检查实现与证据边界 | 检查命令或聚合变化 |
| [sources.md](sources.md) | 参考 | 维护者：核验来源与历史读取日 | wl-researcher | 官方来源登记与历史观察 | 新增来源核验 |
| [compatibility.md](compatibility.md) | 参考 | 开发者：选择固定工具组合 | main | 工具 pin 与历史探针 | 固定版本变化 |
| [operations.md](operations.md) | 运行手册 | 管理员：诊断启动并配置成员 | wl-backend | 当前 CLI 与权限实现 | 运维或认证流程变化 |
| [backup-restore.md](backup-restore.md) | 运行手册 | 维护者：一致性备份并恢复 | wl-backend | 备份恢复实现与验证边界 | 存储或恢复流程变化 |
| [manual-smoke.md](manual-smoke.md) | 指南 | 验收者：合成输入人工闭环检查 | wl-qa | 人工验收步骤，不是通过记录 | 页面、输入或导出变化 |
| [known-limitations.md](known-limitations.md) | 参考 | 使用者：识别未支持与未验证范围 | main | 当前限制及历史验收边界 | 支持或证据范围变化 |
| [security-model.md](security-model.md) | 规范 | 维护者：遵守信任和外发边界 | wl-backend / wl-ai | 当前安全契约与设计边界 | 认证、授权或外发变化 |
| [requirement-map.md](requirement-map.md) | 参考 | 审查者：定位需求与负责模块 | main | 需求对应关系 | 需求或实现入口变化 |
| [provider-compatibility.md](provider-compatibility.md) | 参考 | 模型维护者：核对渠道历史兼容记录 | wl-ai / wl-researcher | 历史登记与当前退役说明 | 渠道或版本核验变化 |
| [providers/codex.md](providers/codex.md) | 参考 | 维护者：识别退役与历史身份 | wl-ai | Codex 退役，历史解码边界 | 历史兼容或退役约束变化 |
| [providers/claude.md](providers/claude.md) | 参考 | 模型维护者：使用本人官方运行时 | wl-ai | 运行时协议与历史 T23 观察 | 官方运行时接口变化 |
| [adr/0001-provider-runtime-boundaries.md](adr/0001-provider-runtime-boundaries.md) | 决策 | 维护者：遵守 provider 边界 | main / wl-ai | 已记录决定及证据 | 替代决定或契约影响变化 |
| [adr/0002-server-owned-ai-authorization.md](adr/0002-server-owned-ai-authorization.md) | 决策 | 维护者：执行服务端外发授权 | main / wl-ai | 已记录授权决定 | 替代决定或授权变化 |
| [adr/0003-browser-first-login.md](adr/0003-browser-first-login.md) | 决策 | 维护者：保留网页首次登录流程 | main / wl-web | 已记录首次登录决定 | 替代决定或登录变化 |
| [commercial-core-plan.md](commercial-core-plan.md) | 计划 | 维护者：理解后续工程验收切片 | main | 工程实施计划，不替代原 DAG | 批准计划变化 |
| [ux-improvement-plan.md](ux-improvement-plan.md) | 计划 | 主集成者：按四角色需求选择批次并验收修复 | main | 用户体验增量计划，不是完成或发布声明 | 批次范围、依赖或验收行为变化 |
| [current-capabilities.md](current-capabilities.md) | 参考 | 产品与试用交付人员：选择当前适配路径和核实边界 | main | 当前源码能力及绑定证据，不替代历史关卡 | 能力、接口或实际验收边界变化 |
| [label-studio-comparison.md](label-studio-comparison.md) | 参考 | 维护者：区分竞品比较与实测能力 | wl-researcher | 带来源的比较与证据边界 | 来源或能力对照变化 |
| [pilot-protocol.md](pilot-protocol.md) | 规范 | 验收者：执行效率质量测量协议 | wl-qa | 测量目标与协议，不是结果 | 测量协议变化 |
| [reference/original-proposal.md](reference/original-proposal.md) | 归档 | 审查者：对照用户原始草案 | main | 历史原文，不是当前实现 | 仅归档说明，不倒写原文 |
| [../prompts/RESUME.md](../prompts/RESUME.md) | 指南 | 主集成者：按证据恢复会话 | main | 恢复派工模板 | 恢复约束变化 |
| [../prompts/TASK_PACKET.md](../prompts/TASK_PACKET.md) | 指南 | 主集成者：填写独立派工输入 | main | 任务包模板 | 派工契约变化 |
| [../prompts/REVIEW.md](../prompts/REVIEW.md) | 指南 | 审查者：实施规格与质量审查 | main / wl-qa | 审查模板 | 审查要求变化 |
| [../reports/index.md](../reports/index.md) | 入口 | 验收者：查找绑定运行条件的报告 | main | 历史及本轮报告索引，不是统一通过声明 | 新增真实报告 |
| [development.md](development.md) | 指南 | 开发者：定位模块并验证变更 | main / wl-core / wl-web | 当前开发入口与消费者迁移 | 工具、模块或验证入口变化 |
| [configuration.md](configuration.md) | 参考 | 维护者：选择参数并区分受管值 | wl-backend / wl-ai | 当前 CLI 与环境实现 | 参数、默认或配置边界变化 |
| [data-model.md](data-model.md) | 参考 | 开发者：追踪保存审核与恢复 | wl-core / wl-backend / wl-web | 当前实体与事务生命周期 | 数据、事务或恢复资格变化 |
| [api-reference.md](api-reference.md) | 参考 | 调用者：构造请求并处理错误 | wl-backend / wl-ai | 当前公开 handler 与 v1 契约 | 路由、字段、权限或错误变化 |
| [troubleshooting.md](troubleshooting.md) | 运行手册 | 操作者与维护者：保全并恢复故障 | wl-backend / wl-web / wl-qa | 当前故障分支与恢复资格 | code、状态或恢复路径变化 |
