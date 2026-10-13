# WebLabel 与 Label Studio：功能及使用体验对比

本文面向产品负责人、技术选型者和维护者，归档下表明确版本基线的分析，不随主分支自动更新、不改变发布关卡。2026-10-13 起的五批体验增量另见[当前能力与边界](current-capabilities.md)及[体验计划](ux-improvement-plan.md)；本页历史问题与观察保留原时态。

## 1. 结论

**当前 WebLabel 还不能整体替代 Label Studio。**

- 功能广度、可配置性、日常标注操作和数据管理：Label Studio Community 更完整。
- 团队分发、评论、共识评估、企业身份和运维：Label Studio 付费版本优势更明确。
- WebLabel 的差异化方向：本机图片检测标注、明确的保存与恢复状态、固定版本审核、可追溯训练数据交付，以及受控的 AI 候选采纳。
- 当前最大短板不是缺少视频或分割，而是部分后端能力尚未形成完整用户界面；AI 接入也尚未完成真实渠道验收。

**产品建议：优先将 WebLabel 做成可信、精确、本地优先的检测标签修正与交付工具，而不是功能不全的通用 Label Studio。**这是基于当前范围和差距的建议，不是已经验证的市场、效率或收益结论。

## 2. 版本、方法与证据边界

| 项目 | 比较基线 |
|---|---|
| WebLabel | 公开发布的 `v0.1.0-rc.2`；提交 `536d65caf6f9eac8a4e51ec97a8055ee7fde335a`；工程预发布 |
| Label Studio Community | 分析时核实的官方最新稳定版 `1.23.2`；2026-09-29 发布；提交 `df96d79183156e556d91825d15fa7721f1145e1a` |
| Label Studio 付费版 | Starter Cloud、Enterprise 分开比较；依据分析时的在线官方资料，不将套餐文档当作 Community 1.23.2 实测 |
| 研究方法 | 三个并行只读切片：标注与数据、AI与协作部署、用户旅程；另做媒体持久化及套餐歧义补查 |
| WebLabel 实测 | 公开 Windows 包：首登、创建项目、导入图片、真实 WebGPU 画框、保存、刷新、撤销/重做、COCO 导出、失败反馈、窄屏与无障碍抽查 |
| Label Studio 实测 | 官方公开 Playground：选择检测模板、选择类别、拖动画框、生成标注 JSON |
| 未实测 | Label Studio 本地后端及 Enterprise 账号；双方同条件性能、真实操作员效率、AI 准确率、总拥有成本 |

### 证据如何解读

- **实测**：本轮运行观察到的结果。
- **实现/文档**：固定版本源码、工程证据或官方指南支持的能力，不自动代表本轮完整运行过。
- **建议**：选型和优先级判断，不是测量结果。
- **未知**：没有足够证据或官方材料有冲突，不用推测填补。

公开 Playground 未固定为 1.23.2，不能证明该版本后端持久化或企业功能。WebLabel 的规划、API、独立组件和正式页面能力也必须分开。未安装并完整操作 Label Studio 1.23.2 服务，因此本文不是双方完整后端验收报告。

## 3. 标注功能与配置

| 维度 | WebLabel 当前版本 | Label Studio Community | 判断 |
|---|---|---|---|
| 数据模态 | 静态图片、检测框、对象属性 | 图片、文本、音频、视频、时序、多模态任务 | LS 覆盖明显更广 |
| 图片格式 | PNG/JPEG，有格式与编码检查 | 官方指南列出更多图片格式，如 BMP、GIF、WebP、SVG | WebLabel 输入范围较窄；LS 也不是任意格式都支持 |
| 矩形框 | 轴对齐 `bbox_xyxy` | 矩形及旋转框 | 旋转检测需求不适合当前 WebLabel |
| 多边形、Mask、关键点 | 不支持；不在本轮范围 | 有对应标签与模板 | 分割、姿态任务选 LS |
| 视频与高级追踪 | 不支持 | 有视频任务；高级 SAM 2、Interfaces 等需逐项核对版本和套餐 | 不能将所有高级功能算进免费版 |
| 多类别规范 | 后端支持规范，但创建页只配置首个类别 | 模板、标签配置、XML 配置 | WebLabel 标准配置入口不足 |
| 绘制类别及改类 | 正式工作台未发现类别切换控件；源码初始化为第一类别 | 选择类别画区域、修改已有区域类别 | WebLabel 核心人工流程缺口 |
| 对象属性 | 有 enum/boolean/number/text 规则和属性面板；创建页不能配置完整属性规范 | 可组合 Choices、TextArea 等区域级控件 | WebLabel 后端规则比前端配置入口完整 |
| 标注模板 | 固定检测工作台，没有通用模板配置器证据 | 模板库、XML、实时预览 | LS 更适合不同类型任务 |
| 实体关系、复杂条件界面 | 未发现正式支持 | 有关系及条件显示等标签组合 | LS 配置能力更强 |
| 精确数值编辑 | 已有数值几何组件，但未挂载到正式工作台 | Details 提供位置、尺寸、旋转等编辑 | 组件存在不等于用户能使用 |
| 坐标语义 | canonical 连续像素，EXIF 变换可追溯，DPR 不进入持久坐标 | 图片结果通常使用百分比，附原始尺寸和旋转信息 | 数据迁移必须转换，不能直接改字段名 |

**关键发现：WebLabel 不仅功能范围较窄，还存在“内核/API 能做，但正式页面没有入口”的断层。**多类别选择、规范配置和数值几何最值得优先补齐。

WebLabel 轴对齐框采用连续像素 xyxy，不加 1。导出 COCO 为 xywh、YOLO 为归一化中心及宽高。Label Studio 的百分比坐标、原图尺寸、旋转角度和类别映射需一起处理；旋转框不能直接无损塞进 WebLabel 的轴对齐框。

## 4. 导入、导出与训练数据交付

| 维度 | WebLabel 当前版本 | Label Studio Community |
|---|---|---|
| 图片导入 | 正式页面支持多文件导入，后台媒体作业处理 | 文件、任务 JSON、URL、存储引用等路径 |
| 图片准入 | 实现限制 64 MiB 请求/单文件预算、边长 4096、总像素 16,777,216；做静态图检查及 EXIF 1–8 canonical 变换 | 限制需按导入接口、部署和媒体类型判断，不能与任务 JSON 大小直接比较 |
| COCO/YOLO 标注导入 | 转换器、鉴权 preview/commit API 已实现；正式工作台未发现对应导入消费者 | 可导入标准 predictions JSON，并使用格式转换工具 |
| 格式兼容范围 | 检测子集；COCO segmentation/crowd 等可能产生损失，YOLO 仅检测五列 | 支持的标签类型更多，但同样不是任意外部格式无损往返 |
| 训练格式导出 | COCO、YOLO、WebLabel 原生包 | JSON、COCO、YOLO 及其他与任务类型匹配的格式 |
| 信息损失 | 有损失报告和确认协议；本轮真实 COCO 导出显示对象 ID 损失 | 有格式支持与转换说明；未核实等价的逐字段强制确认机制 |
| 原生导出 | 保留支持的数据模型；单图包是 manifest + canonical PNG | 完整 LS JSON 与精简 JSON 有不同语义 |
| 快照 | 固定媒体、规范、标注 revision 和审核证据，导出不读取后来变化的 head | Community 也有 SDK/API export snapshots |
| 快照容量 | UI 与后端均限制单次最多 512 条，包含排除项 | 可通过 SDK/API 导出；高级快照 UI、后台导出另看付费版本 |
| train/val/test | 页面支持逐项选择，服务端检查 source_group 跨分割泄漏；不能宣传为完整自动比例切分 UI | 可用筛选、SDK及外部训练流水线组织 |
| 完成与负样本 | 未处理、处理中、完成、明确负样本分开；空文档不自动成为负样本 | 有 annotation、draft、skip 等语义，不能直接与 WebLabel 四态等同 |
| 筛选、排序、批量管理 | 当前页面以媒体列表和交付范围选择为主 | Data Manager 有筛选、排序、tabs、批量任务/标注操作 |
| 自动化集成 | 本地 HTTP API；未发现成熟外部 SDK/Webhooks 产品入口 | 官方 API、Python SDK、Webhooks |

### 不能忽略的格式差异

- WebLabel COCO 导入需要明确类别映射；多图文件需选择目标图像。YOLO 检测导入同样需要类别映射，不能理解为任意 COCO/YOLO 全量语义导入。
- **不能说 Label Studio 免费版没有快照。**固定 1.23.2 指南区分普通同步 UI 导出和 SDK/API snapshots；普通 UI 导出不应用 Data Manager tab 筛选。付费增益主要是相应 UI、后台处理与管理体验。
- **不能将 WebLabel 原生标注包当作完整项目备份。**它使用 canonical 图像，不保证原始来源图像字节不变，也不是账号、数据库、历史和未同步草稿的完整归档。
- LS JSON 的任务、标注、预测 envelope 与 WebLabel 原生包不是同一契约。两者“原生”均不表示所有其他工具都能无损读取。

本轮真实导出验证的是 COCO 路径；固定快照、YOLO 和原生包的完整运行不属于本轮实测范围。

## 5. AI、协作与质量治理

| 维度 | WebLabel | Label Studio Community | Starter Cloud / Enterprise |
|---|---|---|---|
| 预标注接入 | 有预测、候选、运行协议和 UI 工程链路 | 可导入预测、连接自建 ML Backend | 增加托管模型辅助、Prompts 等产品能力，范围依套餐 |
| 当前真实模型可用性 | 四个必需渠道仍 blocked；默认包没有可用真实模型 profile 时不能运行 AI；Codex 已退役 | 后端与模型仍需用户配置，不是安装即附送全部模型 | 文档能力不等于用户账号已有额度或模型权限 |
| Claude 官方订阅运行时 | 有专项工程适配，真实协议、账号和图像闭环验收未完成；Codex 不再提供活动通道 | 未找到同等原生通道证据 | API/Prompts 不能作为订阅 CLI 的等价替代 |
| VLM 属性审校 | 目标明确，有意图、对象范围和差异结构 | 可通过模型后端构建 | 有更成熟的提示词、评估产品资料 |
| 按变化查看与采纳 | 有 before/after、逐项选择、过期上下文检查、编辑命令及 journal | 有 prediction/annotation 工作流；未核实相同逐 change 协议 | 审核/history 不等于同样的 AI 采纳事务 |
| 外发控制 | 项目策略、固定 scope、preview、明确授权；变化需重新授权 | 由模型后端、数据访问及部署配置控制 | 有组织级能力，但未核实相同逐 run 授权协议 |
| 费用与取消 | 费用未知必须保留；本地结束不代表远端停止计费 | 依模型后端及外部服务 | 预算、报价、取消保证需核套餐与合同 |
| 用户与角色 | 有项目角色及服务端权限机制 | 多用户不等于细粒度项目 RBAC | 当前套餐表中 Starter、EE 有 RBAC |
| 任务占用 | 有租约、续租、转移和 fencing | 不等同付费角色分发工作流 | 有任务分配及角色工作流；Starter 部分能力有限 |
| 正式审核 | 绑定不可变 revision；新编辑版本不继承旧批准 | 没有同等内置正式 reviewer 工作流 | Starter、EE 有 reviewer 能力 |
| 评论与通知 | 有理由、问题记录，但未发现成熟线程评论/通知 | 不是 Community 标配 | Starter、EE 有评论与通知 |
| 共识与绩效 | 未发现成熟多标注者共识、自动重分配、绩效工作台 | 可导出后自算，不等于内置高级治理 | EE 有更完整指标及质量工作流 |
| 并发保存 | 服务端实际执行 CAS、幂等，任务场景校验 lease/fencing | 本次未核实等价命令事务保证 | history/RBAC 本身不能证明相同机制 |
| 审计 | 版本、来源及采纳 journal；不等于合规级不可篡改日志 | 与付费 activity log 区分 | 有活动日志等能力，保留期限与合规需核合同 |

### AI 的真实结论

WebLabel 的“自然语言属性审校 → 差异 → 人工采纳 → 可撤销保存”具有明确差异化设计，但目前不能说已经比 Label Studio 的 AI 更好用或更准确。

四个必需渠道 `claude_local`、`openai_api`、`mimo_api`、`detector_local` 仍 blocked；`anthropic_api` 可选且未宣称真实验收通过，`codex_local` 只保留历史身份。T32 blocked、T35 pending，不能包装成成熟 AI 产品能力。API key、官方订阅运行时和本地模型是不同渠道，不得相互替代证明。

Label Studio Community 也不是开箱即有免费模型：ML Backend、模型部署、服务权限与费用仍需配置。双方都不能用 mock、配置文件中的型号或静态预测当作真实模型支持证据。

### 套餐歧义

官方套餐表将 Starter 的 programmable/embeddable interfaces 标为不支持，LiDAR Interfaces 模板页又写 Starter 可用。模板使用与完整编写/嵌入权限可能不同，但未核清，本文不武断统一。采购应核对具体能力及合同。

## 6. 实际用户旅程与体验

| 用户旅程 | WebLabel 实际表现 | Label Studio 对照 |
|---|---|---|
| 安装启动 | Portable 带固定 Node，人工服务无需先安装 Rust、pnpm、Python；仍是终端启动，不是成熟安装器 | CE 常用 pip/Docker；托管版减少本机运维 |
| 首次登录 | 复制终端一次性码、设置并确认密码、自动进入项目；本轮实际成功 | CE 常规邮箱/密码注册登录 |
| 创建项目 | 直接，但只有项目名和首个类别；复杂规范配置欠缺 | 模板选择、配置及预览更完整 |
| 进入标注 | 导入完成后需选择媒体；支持明确 GPU 状态 | 从 Data Manager/标注队列进入任务 |
| 对象识别 | 列表和框上显示原始对象 ID，列表还显示 label ID | 类别名称、Regions/Outliner 的语义表达更成熟 |
| 快捷键 | 有工具、撤销、删除等键位及焦点/IME 保护；就地帮助不足 | 有更完整热键说明、区域操作及配置资料 |
| 保存反馈 | 区分本地待同步、服务器同步、失败和冲突；保存与刷新保持 revision 已验证 | 自动保存、draft、Submit；语义与服务器事务需分别判断 |
| 失败反馈 | 媒体后台失败结果未在正式导入区展示 | 有导入/存储故障文档；本次未做后端同条件错误测试 |
| 导出反馈 | 实际成功，但损失报告直接呈现 JSON/英文，理解成本高 | 格式选择和数据管理体系更成熟 |
| 任务分配 | 创建任务需手填媒体 revision、ontology version、用户 ID | 付费版本有人员及队列分发工作流 |
| 工作区布局 | 上方策略/工时、下方 AI/审核使页面较长；本轮 1280×800 下画布高约 319px | 区域面板有折叠、停靠、分组等能力；未做同尺寸完整产品测试 |
| 窄屏 | 登录已处理 320px；工作台 320px 时实际宽度为 360px | 未完成移动端同条件验证，不能宣称全面优胜 |
| 语言与帮助 | 基础流程中文，AI、ID、损失报告混有英文及技术表达 | 文档、模板、SDK生态更丰富；中文界面质量未完整验证 |
| 无障碍 | 字段标签、错误聚焦、live 状态有价值；抽查退出/导出按钮对比度 4.41，低于 4.5 | Playground 也有问题；不同界面不能按失败项数量给整体产品排名 |

### 三个已确认的重要问题

#### 6.1 导入失败被隐藏

上传合成损坏 PNG 后，服务端作业明确返回：

```text
state: failed
error: unsupported or mismatched image type
```

正式导入区没有 alert，也没有显示文件名或失败原因。用户看到的效果是处理提示消失，但没有新图片。固定版本工作台源码对失败/中断终态的处理与本轮观察一致。

#### 6.2 对象列表偏工程诊断，而非标注者语言

实际显示 UUID 和 label ID。密集对象场景中，这增加查找和理解成本。虚拟化解决 DOM 数量，不解决语义检索。

#### 6.3 多类别和精确几何存在界面断层

固定源码显示工作台初始化第一类别，没有找到正式改类入口；数值几何组件也未挂载。不能用内核命令或独立组件测试宣称完整人工操作已经可用。

### 真实完成的运行链路

- 首次设置和会话读取成功；必填错误聚焦首个缺失字段，敏感输入被遮蔽。
- 项目及规范创建均返回 HTTP 201。
- 合成 640×480 PNG 导入返回 HTTP 202，后台作业成功。
- 本轮设备实际报告 `webgpu`、`hardware`、`ready`，并渲染与编辑图片；不是 Canvas2D 替代。
- 绘框保存后读取到 `canonical_image_pixels` 浮点 xyxy；第二次拖动后一次 Undo 恢复前一文档，Redo 恢复新文档；刷新保留 revision 和对象。
- COCO 导出与下载均返回 HTTP 200，并显示 `object_ids` 损失报告。
- 无效 PNG 真实作业失败，但页面未显示原因。
- 320px 工作台页面宽度为 360px，存在水平溢出。

Label Studio Playground 实际完成类别选择及 bbox 绘制，输出包含原图尺寸、百分比坐标、rotation、rectanglelabels 和人工来源。没有验证真实后端保存。

无障碍采用 axe-core 4.13.0 抽查：WebLabel 本轮为一个对比度规则失败；LS Playground 为四个规则失败，涉及 separator 值、对比度、标签和滚动区域。**这是特定表面抽查，不是完整 WCAG 审计，也不是两产品合规排名。**

## 7. 部署、安全、规模与生态

| 维度 | WebLabel | Label Studio |
|---|---|---|
| 支持部署 | 正式边界仅 loopback | CE 可自托管；另有托管及企业私有部署 |
| 远程团队 | 有角色不代表支持 LAN/公网团队部署 | 团队服务形态更成熟，治理功能依套餐 |
| 浏览器门槛 | 人工编辑必须有真实 WebGPU；无设备只读/诊断 | 没有同样的 WebGPU 硬门槛 |
| 规模 | 有明确媒体预算、512 条快照边界 | 数据管理与程序化导出更适合大规模流程；仍受部署资源影响 |
| 存储接入 | 本地 SQLite、不可变对象存储 | 本地及云存储连接体系更丰富 |
| 备份恢复 | 有专用命令；不含未同步浏览器草稿、不加密签名、要求精确 schema，恢复后新身份 | 自托管需管理数据库、媒体和配置；托管恢复权限/RPO/RTO另核 |
| 长期运维 | 无自动 GC、SSO、密码找回、远程运维等完整产品体系 | CE 需自行运维；付费版有更完整身份与支持产品 |
| 发行成熟度 | 工程 RC，尚非 T35 正式验收 | 持续稳定发行和较大生态，不保证任何部署零故障 |
| 许可证 | 固定 SHA 根目录未见许可文件；使用/修改/再分发授权未核清 | CE 1.23.2 明确 Apache-2.0，不等于付费产品同样授权 |
| 成本 | 人工流程无模型订阅前置，但硬件、维护、AI调用仍有成本 | CE 同样无需 AI 账号；付费服务、模型和运维另算 |

后续本机管理员恢复增量已独立实现：[维护恢复](operations.md#管理员密码恢复)保留原账号身份，终端码授权重置、结束维护后正常登录。它不提供在线自助找回、SSO或远程运维；上表其他比较仍按原评估基线，不升级原发布/模型门禁。

WebLabel 的 loopback、Host/Origin、CSRF、启动认证与逐 run scope 控制有明确边界，但不能据此宣称整体更安全或符合某种监管要求。

Label Studio 比较基线为已包含安全修复的 1.23.2。该发布说明包括 SECRET_KEY 文件权限/轮换、私网资源相关 SSRF 防护、可信 Host，以及上传 HTML/SVG/XML 的沙箱处理。不能把这些已修复事项描述为基线仍未修复，也不应关闭防护来取得功能对等。

WebLabel 备份保留已提交业务数据和历史身份，恢复需要新管理员，不包含浏览器未同步草稿；它不是加密、签名、跨任意 schema 的自动灾备。LS 的自托管备份同样需要运营者管理，不能只因为有数据库就宣称完整恢复体系。

## 8. 性能、质量与收益：目前不能下的结论

没有证据支持“Rust/wgpu 所以一定更快”“节省 30%”“AI 更准”“总成本更低”。真实硬件 WebGPU 在本机成功不等于 G4 完成，也不证明跨浏览器、跨显卡支持。

需要同图、同硬件、同操作员培训、同 AI、独立真值的配对试点，比较吞吐、修改率、误标率、失败恢复及最终数据质量。当前只能确认本轮 WebLabel 画框、保存、一次拖动一次撤销、重做、刷新持久化闭环可运行。

双方的 AI、企业服务、价格、SLA、监管适用性、长时可靠性均不能仅由架构或功能表推导。商业选型需核对授权、合同、运行环境及实际任务。

## 9. 改进建议与优先级

这些是比较建议，不是已实施修复，不新增任务、不改变现有发布状态。

### P0：先补核心可用性，不先扩模态

1. **完整规范配置、多类别绘制与改类入口。**避免 API 能做而普通用户做不了。
2. **导入失败/中断可见结果。**展示逐文件原因与下一步，不让后台失败看起来像完成。
3. **宣传 AI 差异化之前完成真实渠道验收。**保留授权、预算、候选隔离及不可自动重发原则；不用 mock 或适配器存在代替支持证据。

### P1：提高持续标注效率

- 正式接入数值几何编辑。
- 类别名、对象序号替代 UUID 主显示，增加检索/分组。
- 任务分配使用人员、媒体、规范选择器，减少原始 ID 输入。
- 解释保存、冲突、救援状态，将 JSON 错误和损失报告转为可读内容。
- 按需折叠策略、工时、AI、审核区域，增加画布空间。
- 补窄屏、小控件命中、对比度及就地快捷键帮助。
- 按目标规模设计超过单次 512 条的交付路径，补齐格式导入 UI。
- 明确许可证及再分发边界。

### P2：按产品定位补生态

SDK、Webhooks、存储连接、安装器和升级体验值得考虑。Mask、视频、3D 不应仅为了追平 Label Studio 而自动进入当前范围。

## 10. 场景选型

| 需求 | 当前建议 |
|---|---|
| 本机、静态 PNG/JPEG、简单单类别 bbox，希望无需 Python 启动 | WebLabel 可试用；保存与恢复语义有明确价值 |
| 多类别、复杂属性配置、精确坐标编辑，希望全部通过页面完成 | 当前优先 Label Studio Community |
| 文本、音频、视频、分割、关键点、多模态 | Label Studio |
| Python 流水线、通用筛选批处理、SDK/Webhooks | Label Studio Community |
| 团队分发、reviewer、评论、共识、企业身份与运营指标 | 按能力核对 Starter Cloud / Enterprise |
| 密集检测修正＋自然语言属性审校＋可撤销采纳 | WebLabel 的差异化方向，但仍需 UI 闭环、真实模型和质量验收 |

选型前先明确模态、用户人数、部署边界、外发政策、数据规模和治理要求。不要因为 WebLabel 有角色接口就按远程团队服务部署，也不要因为 Label Studio 免费版有账号就认为已经具备付费 RBAC。

## 11. 来源与可复核证据

### 固定版本与官方资料

- [WebLabel v0.1.0-rc.2 发布](https://github.com/lona-cn/weblabel/releases/tag/v0.1.0-rc.2)
- [WebLabel 固定版本工作台实现](https://github.com/lona-cn/weblabel/blob/536d65caf6f9eac8a4e51ec97a8055ee7fde335a/apps/web/src/features/workbench/Workbench.tsx)
- [WebLabel 固定版本限制与验收边界](https://github.com/lona-cn/weblabel/blob/536d65caf6f9eac8a4e51ec97a8055ee7fde335a/docs/known-limitations.md)
- [WebLabel 固定版本共享契约](https://github.com/lona-cn/weblabel/blob/536d65caf6f9eac8a4e51ec97a8055ee7fde335a/docs/contracts.md)
- [Label Studio 1.23.2 发布与安全修复](https://github.com/HumanSignal/label-studio/releases/tag/1.23.2)
- [Label Studio 固定 1.23.2 标注指南](https://github.com/HumanSignal/label-studio/blob/df96d79183156e556d91825d15fa7721f1145e1a/docs/source/guide/labeling.md)
- [Label Studio 固定 1.23.2 导出与快照指南](https://github.com/HumanSignal/label-studio/blob/df96d79183156e556d91825d15fa7721f1145e1a/docs/source/guide/export.md)
- [Label Studio 固定 1.23.2 许可证](https://github.com/HumanSignal/label-studio/blob/df96d79183156e556d91825d15fa7721f1145e1a/LICENSE)
- [官方 Community / Starter / Enterprise 对比](https://docs.humansignal.com/guide/label_studio_compare)
- [Label Studio 任务导入](https://labelstud.io/guide/tasks.html)
- [Label Studio Data Manager](https://labelstud.io/guide/manage_data)
- [Label Studio ML Backend](https://labelstud.io/guide/ml)
- [Label Studio Community 用户与项目边界](https://labelstud.io/guide/signup)
- [Label Studio 企业角色](https://docs.humansignal.com/guide/admin_roles)
- [Label Studio 质量管理](https://docs.humansignal.com/guide/quality)
- [Label Studio Prompts](https://docs.humansignal.com/guide/prompts_overview)
- [官方 Playground，未固定版本](https://labelstud.io/playground)

固定提交链接保存历史判断依据；在线套餐文档可能变化。更新比较时需重新核实，不能只替换版本号。

### 本轮本地证据

以下链接指向项目内本轮证据；构建缓存可能未纳入版本控制，其他 checkout 或发布站点不保证包含它们。此文已保留关键观察与边界，即使缓存缺失，也不应将其当作新的实时验收。

- [版本、能力与优先级核对](../target/build-cache/label-studio-comparison/3d5df9e6-c387-4b8a-b6cd-bd78e8202627/comparison-basis.json)
- [HTTP 关键步骤](../target/build-cache/label-studio-comparison/3d5df9e6-c387-4b8a-b6cd-bd78e8202627/http-milestones.json)
- [浏览器观察与抽查](../target/build-cache/label-studio-comparison/3d5df9e6-c387-4b8a-b6cd-bd78e8202627/observations.json)
- [WebLabel 工作台截图](../target/build-cache/label-studio-comparison/3d5df9e6-c387-4b8a-b6cd-bd78e8202627/weblabel-workbench.webp)
- [Label Studio Playground 截图](../target/build-cache/label-studio-comparison/3d5df9e6-c387-4b8a-b6cd-bd78e8202627/label-studio-playground.webp)
- [运行资源清理记录](../target/build-cache/label-studio-comparison/3d5df9e6-c387-4b8a-b6cd-bd78e8202627/cleanup.json)

本轮使用合成图片及公开示例，未登录外部账号、调用付费模型、下载大权重或上传业务图片。临时服务、浏览器配置、解包目录及合成数据已清理。分析未修改业务代码；本文归档也不宣称修复了任何上述问题。
