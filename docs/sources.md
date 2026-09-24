# 依据与外部接口核验

编写核验日期：2026-09-25。运行时/模型权限可能变化；T00/T02固定实际安装版本并保存相应来源与验证结果。来源说明≠产品能力已经通过实测。

| ID | 官方来源 | 本计划使用的有限事实 |
|---|---|---|
| S0 | docs/reference/original-proposal.md，用户v0.1草案，2026-09-24 | 图片检测首期、DOM/Rust/wgpu边界、坐标/预测/保存/审核/快照不变量；具体技术栈取舍由本计划新增 |
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

本计划新增：local-service-first、具体Rust/TS/Python分工、v0.1的VLM优先级、36项任务DAG、omp运行规程、初始预算、官方运行时安全边界与发布关卡。这些是工程设计决定，不是引用来源的产品能力宣称。

未验证事项：开发者机器是否有WebGPU、用户实际订阅/地区/额度、模型对真实任务的效果、MiMo具体API合同、Windows官方CLI工具限制效果。它们分别进入T00/T02/T31/T32，不能靠文档推断为通过。

T02输出 docs/provider-compatibility.md，每个provider记录来源URL、读取日、软件版本、schema版本、完整model_id（不能获得则null）、认证方式、图像输入、结构化/工具行为、取消/额度语义、许可证/条款边界、known_limit、verification。网络或账号限制时提供证据并标blocked，不编造接口。
