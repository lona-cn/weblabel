# 从空目录开始

这是一份给omp执行的计划包，不是已经写好的标注软件。将ZIP内容直接解压到你的新项目根目录；不要只复制PLAN.md而漏掉任务卡和契约。

## 1. 启动

在解压后的根目录执行（PowerShell、Bash均可）：

```text
git init
omp "@START_PROMPT.md" "按计划开始执行。先完成T00，再依TASKS.json调度；最多3个写Agent和1个只读审查Agent。"
```

`@START_PROMPT.md`加引号可避免PowerShell把前缀当作特殊语法。`omp`本身应已安装可启动；本包不代替omp安装。当前CLI支持文件附加参数；T00仍应核对实际版本帮助。[S3]

已有Node时可先运行不需要安装依赖的计划校验：

```text
node tools/check-plan.mjs
node --test tools/check-plan.test.mjs
```

这里检查的是任务图/文件/状态，不会构建产品、登录或调用模型。

## 2. 首次执行会做什么

T00建立workspace、安装并固定实际可用版本、准备构建/测试脚本并检查Git/omp隔离。Git姓名/email缺失时由用户配置自己的身份；不能让Agent代填。默认新项目文件以本包为上下文，没有应用代码。

本包提供项目级 .omp/config.yml，设置总并发4、单层派工和auto隔离，不修改全局审批模式。实际生效与平台支持仍不能猜；在omp中核对 `/settings` 的Tasks Isolation，并用 `/agents`确认本项目角色已加载。主Agent按实际工具schema操作，不依赖不存在的 `--parallel` 参数。隔离不可用先串行，而不是共用工作区冒险并写。[S1][S2]

v0.1默认“本地Rust服务+浏览器”，不要求云资源、Docker、API key、Python权重才能使用人工编辑；AI/检测功能按配置启用。外部模型订阅登录、付费调用、权重下载和业务图外发需要你的明确授权。

## 3. 中断后继续

```text
omp -c
```

这是继续最近会话；多个项目时先确认当前目录/会话。新会话恢复也可：

```text
omp "@prompts/RESUME.md" "继续本目录任务，先核验STATUS、git和证据，不重新初始化。"
```

## 4. 关键文件

| 文件 | 作用 |
|---|---|
| PLAN.md | 完整任务索引、关卡与目标 |
| AGENTS.md | 每个Agent都必须遵守的边界和不变量 |
| TASKS.json / STATUS.json | 精确依赖/互斥/验收命令；当前进度 |
| tasks/T00.md … tasks/T35.md | 可独立交给工作者的36张任务卡 |
| docs/architecture.md | 技术栈、目录、预算、v0.1取舍 |
| docs/contracts.md / testing-contracts.md | 前后端/内核/模型共享协议与测试接口 |
| docs/execution.md | 隔离、并行、审查、集成、恢复规则 |
| docs/verification.md | 自动化、错误矩阵、真GPU/真模型发布门槛 |
| .omp/agents/ + .omp/config.yml | 8个角色及项目级并发/隔离配置，不硬编码开发模型 |
| prompts/ | 派工、审查、恢复提示 |
| docs/reference/original-proposal.md | 原始上传草案原样保留 |
| docs/sources.md / requirement-map.md | 依据、未验证项、覆盖范围与后置功能 |

## 5. 使用时最重要的判断

页面能打开、mock给出候选、所有类型检查通过，都不等于产品已交付。必须能真实画框、保存恢复、正确导出；模型与GPU要独立真实验证。

没有登录/真实GPU时允许完成其他代码，但必须明确G4 blocked。不要让Agent修改验收门槛来换一个“全部完成”。T35完成后停止，不自动扩展视频或云平台。
