# 依据与外部接口核验

供维护者复核设计依据和外部接口边界。先看来源支持的有限事实，再核对固定版本的运行记录；官方文档不等于产品实测。

本表核验日期为 2026-09-25。运行时与模型权限可能变化，T00/T02 的来源和观察不能自动沿用到新版本。

| ID | 官方来源 | 本计划使用的有限事实 |
|---|---|---|
| S0 | [用户原始方案](reference/original-proposal.md)，v0.1，2026-09-24 | 图片检测首期、DOM/Rust/wgpu边界、坐标/预测/保存/审核/快照不变量；具体技术栈取舍由本计划新增 |
| S1 | `https://omp.sh/docs/subagents` | 子agent默认共享checkout；原生隔离及patch应用有独立配置，隔离不是安全sandbox |
| S2 | `https://omp.sh/docs/subagent-authoring` | `.omp/agents/*.md`，frontmatter name/description/tools；模型可继承主会话 |
| S3 | `https://omp.sh/docs/cli` | `omp`启动、`@文件`附加上下文、`omp -c`继续；不编造多agent命令行参数 |
| S4 | `https://omp.sh/docs/context-files` | 项目AGENTS.md用来传递持久上下文 |
| S5 | `https://learn.chatgpt.com/docs/app-server`；原入口 `https://developers.openai.com/codex/app-server` | Codex App Server提供stdio协议与生成客户端schema的命令；以固定CLI生成结果为准，实验功能不当稳定依赖 |
| S6 | `https://code.claude.com/docs/en/legal-and-compliance` | 官方运行时、认证和最终用户使用具有条件；不得收集/代理登录凭证或把订阅转售当产品基础 |
| S7 | `https://code.claude.com/docs/en/authentication` | 使用当前官方认证流程；UI不接收用户会话token |
| S8 | `https://docs.rs/wgpu/latest/wgpu/` | 核验时页面为wgpu30.0.1，最低Rust要求需与依赖组合再次确认 |
| S9 | `https://nodejs.org/en/about/previous-releases` | 选择Node24 LTS系列，实际补丁版由T00记录 |
| S10 | `https://huggingface.co/PekingU/rtdetr_v2_r18vd` | 候选RT-DETR v2检测权重与模型卡；T18固定revision/hash并核对许可 |
| S11 | `https://developers.openai.com/api/docs/models/gpt-6-luna` | 当前有Luna命名模型的官方文档；执行时使用完整且账号可访问的model_id，不假定套餐必定包含 |
| S12 | `https://platform.xiaomimimo.com/` | MiMo官方平台入口；本次未据此确认具体API endpoint、型号和图像payload，T02必须补官方证据，禁止猜兼容性 |
| S13 | `https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API` | 原草案引用的WebGPU能力检测/安全上下文参考 |
| S14 | `https://docs.ultralytics.com/datasets/detect/` | 原草案引用的YOLO检测格式；实现仍有独立黄金向量与加载器验证 |

从草案保留：所有业务正确性不变量、非负样本语义、EXIF规范化、图像尺寸和模型变换、独立预测、幂等/CAS、版本审核、冻结导出和有损报告。

本版自行决定 local-service-first、Rust/TS/Python 分工、VLM 优先级、36 项任务 DAG、omp 执行规程、初始预算、官方运行时安全边界和发布关卡。它们属于工程设计，不应归因于外部资料，也不证明产品能力已完成。

该历史核验未证明 WebGPU、用户订阅/地区/额度、真实任务效果、MiMo API 合同或 Windows 官方 CLI 的限制效果。分别查 T00/T02/T31/T32 后续记录；不能由本表推断通过，也不能把历史未知当成永久未验证。

T02输出 docs/provider-compatibility.md，每个provider记录来源URL、读取日、软件版本、schema版本、完整model_id（不能获得则null）、认证方式、图像输入、结构化/工具行为、取消/额度语义、许可证/条款边界、known_limit、verification。网络或账号限制时提供证据并标blocked，不编造接口。

## 原执行包指纹与当前版本

`MANIFEST.sha256` 记录原执行包的历史指纹，早已不是当前源码的完整性清单。修改文档后不要重新计算这份清单来冒充原包证明，也不要用旧 hash 判定新文档是否有效。

当前源码和文档以 Git 中的对应 commit 与实际工作区为准；发行产物以那次构建生成的 `release.json` 和实际文件 hash 为准。启动器和 doctor 校验选定的发行，不会因为原包清单存在就认定发行可用。

2026-10-09 的主会话检查中，doctor 的六项工具 pin 已通过，但默认 `target/local-release` 不存在，命令退出 1。这是“工具就绪、默认发行缺失”，不是构建完成或 doctor 全部通过；应按上手指南选择新目录构建，再校验该目录。

上述退出 1 保留为当时观察，不按当前行为倒改。当前 doctor 的工具/发行枚举、配置检查边界及 passed/0、blocked/2、failed/1 见[只读 doctor](operations.md#只读-doctor)。

## 文档门禁依赖核验（2026-10-12）

本次单独核验并固定 `markdown-it@14.1.0` 和 `github-slugger@2.0.0`，不修改 S0–S14 的历史读取日。前者解析 Markdown token/表格/引用式链接，后者生成逐文档 GitHub 标题锚点；这不是产品 API 或模型支持证据。

核验使用当前进程 Node 24.16.0/pnpm 10.34.5，执行 `pnpm view markdown-it@14.1.0 version --registry=https://registry.npmjs.org --fetch-retries=0 --fetch-timeout=20000` 与相同参数的 `pnpm view github-slugger@2.0.0 version`，分别实际返回 14.1.0 与 2.0.0。随后以 `pnpm add -w --save-dev --save-exact` 固定这两个版本并更新根锁。原默认 registry 的连接失败保留为本轮环境观察；按次选择官方 registry，不改全局配置。

来源：[markdown-it 14.1.0](https://www.npmjs.com/package/markdown-it/v/14.1.0)、[github-slugger 2.0.0](https://www.npmjs.com/package/github-slugger/v/2.0.0)。本轮独立验证入口由[报告索引](../reports/index.md)登记；维护文档字节另记 SHA256，不借工程 source snapshot 代替。
