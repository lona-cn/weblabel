# 从这里开始

这个目录已经有可运行的本地应用。想使用它，先读[构建、登录和标注指南](docs/getting-started.md)；想继续开发，按下面的步骤恢复，不要重新初始化仓库。

[文档总入口](docs/README.md)提供操作者、开发者、维护/验收者路线。继续开发先用[开发指南](docs/development.md)选择当前模块与验证，再按[文档治理](docs/documentation-policy.md)同步维护相关说明。
当前源码入口是原生HTML/TypeScript与唯一Rust产品`weblabel`；Node/pnpm只用于构建、开发和验证，不是新发行的产品运行依赖。业务wire保持v1，发行布局为v2，备份格式仍为v1。旧Node发行的历史证据不替代原生版重验；重构进度以STATUS和对应实际提交、运行报告为准，不能据此升级T32/T35。


## 继续开发

先按[当前终端选择 Node](docs/getting-started.md#当前终端选择-node)核对 Node 24.16.0 并设置当前进程 PATH，不改全局配置。然后检查任务图和证据：

```text
node tools/check-plan.mjs
node --test tools/check-plan.test.mjs
pnpm docs:check
```

这些命令只检查计划及文档结构，不会构建应用、登录账号或调用模型；结构通过不代表产品验收。

恢复最近会话：


```text
omp -c
```

若有多个项目，先确认当前目录和会话。也可以新开会话，明确从本目录恢复：


```text
omp "@prompts/RESUME.md" "继续本目录任务，先核验STATUS、git和证据，不重新初始化。"
```

PowerShell 中给 `@文件` 加引号，避免它被当作语法。omp 需要提前安装；CLI 参数以实际帮助为准，不编造 `--parallel` 等选项。[S3]

## 哪些资料需要看

| 资料 | 用途 |
|---|---|
| [文档总入口](docs/README.md) / [文档治理](docs/documentation-policy.md) | 唯一目录、读者行动、更新责任与历史证据边界 |
| [开发指南](docs/development.md) / [配置参考](docs/configuration.md) | 固定工具、两种本地拓扑、真实参数与受管内部值 |
| [数据模型](docs/data-model.md) / [API 参考](docs/api-reference.md) | 不可变生命周期、保存事务及普通同源调用 |
| [实施计划](PLAN.md) | 项目边界、36 项任务和发布关卡 |
| [执行约束](AGENTS.md) | 每位工作者必须遵守的安全边界和不变量 |
| TASKS.json / STATUS.json | 机器可读的依赖、互斥域、验收命令和当前进度 |
| [架构](docs/architecture.md) | 模块职责、预算和首版取舍 |
| [契约](docs/contracts.md) / [测试约定](docs/testing-contracts.md) | 前后端、编辑内核和模型共享的接口 |
| [协作规程](docs/execution.md) | 隔离、审查、集成与恢复 |
| [验收说明](docs/verification.md) | 自动检查、故障场景，以及真实 GPU / 模型的要求 |
| tasks/ 与 prompts/ | 可以单独派发的任务卡及派工、审查、恢复模板 |
| .omp/agents/ | 项目角色定义；不硬编码开发模型 |
| [资料来源](docs/sources.md) / [需求对应表](docs/requirement-map.md) | 决策依据、未验证项和后续边界 |
| [原始草案](docs/reference/original-proposal.md) | 用户提供的历史原文，仅用于对照 |

项目级并发和隔离配置要以实际文件及 omp 设置为准。不要假定历史执行包中的 .omp/config.yml 仍然存在，也不要擅自恢复用户删除的配置。在 `/settings` 核对 Tasks Isolation，用 `/agents` 确认角色已加载；隔离无法确认，就串行工作。[S1][S2]

## 首次初始化与完成条件

只有真正从空目录开始、T00 尚未完成时，才使用[初始化指令](START_PROMPT.md)完成 T00。Git 身份缺失时，由用户设置，工作者不能代填。

人工标注不要求云资源、Docker、API key、Python 权重或订阅登录。订阅登录、付费调用、权重下载和业务图外发，都需要明确授权。

页面能打开、类型检查通过或 mock 给出候选，并不等于交付完成。要实际画框、保存、恢复、正确导出；GPU 和模型各自需要真实验证。缺少账号或硬件时，可以继续独立任务，但 G4 仍须如实记为 blocked。T35 完成或没有可执行任务时停止，不自动增加视频、云平台等范围。
