# 架构与范围冻结：WebLabel v0.1

日期：2026-09-25。本文中的技术选择和预算是本执行计划的决策，不是已完成能力或实测结论。

## 1. 目标与演示路径

实现一个浏览器里的高性能图片标注与 AI 审校工作台。用户导入图片和已有检测标签，在 wgpu 画布修正矩形及对象属性，运行检测或多模态辅助，把候选变更逐项/批量接受，保存、审核、冻结数据集并导出。

首个差异化场景固定为“密集对象的检测结果修正 + 按自然语言批量检查对象属性”。演示规范包含 person 类和 helmet_state=wearing/not_wearing/unknown 属性；它只是样例项目，不得硬编码进业务逻辑。用户可以新建其他类别和属性规范。

验收演示：导入 20 张图及 COCO 标签 → 选择一张包含多个对象的图 → 指令“只检查安全帽属性，不改框；看不清的设为 unknown” → 展示逐对象差异 → 选择接受 → 一次撤销恢复整批变更 → 重新接受并保存 → 提交并审核指定版本 → 导出 YOLO/COCO 和属性损失报告。

没有账号或没有真实模型时，继续开发并展示明确标识的模拟结果，但不得把该演示标成真实模型通过。

## 2. 相对原草案的明确变更

原草案存于 docs/reference/original-proposal.md。保留其坐标、不变量、预测隔离、保存、审核和快照语义。以下是本计划新增/调整的决策：

| 项目 | 本次冻结决定 |
|---|---|
| VLM 优先级 | 从后续增强提前到首版差异化闭环，不能只交付普通画框器 |
| 首期部署 | 本地服务 + 浏览器；不是纯静态网页，也不是先建设多租户 SaaS |
| 默认环境 | Windows 11 的桌面 Chrome/Edge 为首要人工验收平台；Linux 用于无凭证自动化；其他平台分别报告验证状态 |
| 存储 | Rust 服务 + SQLite WAL + 内容寻址文件存储；不要求 Docker/PostgreSQL/Redis/S3 才能启动 |
| AI 集成 | Codex/Claude 官方本地运行时；OpenAI、Anthropic、MiMo API 适配器；一个实际检测适配器 |
| 协作 | 基础项目角色、任务占用、版本冲突和审核；不做实时共同编辑 |
| 大图与分割 | v0.1 不做金字塔、Polygon、Mask；以准入限制保护内存，后续另立任务 |
| 本地推理 | 检测可用独立 Python CPU Worker；浏览器 wgpu 推理和自研 ONNX 引擎不进入关键路径 |

这些取舍是为了从空目录交付可验证软件，不代表永久排除云端部署。普通图片编辑不应被 Python、模型权重、官方 CLI 或订阅登录阻塞。

## 3. 技术栈与固定版本策略

- UI：React + TypeScript + Vite；DOM 承担表单、列表、属性和 AI 面板。使用 TanStack Query 管理服务器缓存、TanStack Virtual 管理长列表；表单状态与编辑几何分开。
- 内核：Rust 2021 edition；geometry、annotation-domain、editor-core 都能在无 GPU 的 native 单元测试中运行。
- 渲染：wgpu 30.0.1 作为初始化候选，WGSL；wasm-bindgen/wasm-pack 构建浏览器模块。T00 必须验证组合后精确固定，不盲信旧教程 API。
- 服务：Rust、Tokio、Axum、SQLx SQLite、tracing；单个模块化服务，内部持久化作业队列。
- Agent Host：Node.js 24 LTS + TypeScript；官方 CLI 子进程、API 请求和 MCP 适配集中在这一边界。它不是第二份业务数据库。
- 检测：Python 3.12 + uv，Transformers/PyTorch CPU；首选 PekingU/rtdetr_v2_r18vd，T18 固定权重 revision 和文件哈希。
- 测试：cargo test/proptest、Vitest、Playwright、pytest；无凭证测试与真实 provider/GPU 测试分开。
- JS 包管理：pnpm。T00 查询一次稳定版本，写 packageManager 的精确版本并提交 pnpm-lock.yaml；不假设 Corepack 预装。

T00 的版本选择算法：读取已安装版本 → 查官方稳定版/MSRV/兼容要求 → 先编译最小 Rust→WASM→wgpu 画布及 Node 子进程探针 → 把成功组合记录在 docs/compatibility.md、rust-toolchain.toml、package.json 和 lockfiles。Node 固定 24.x 的实际补丁号；Rust 固定实际通过的稳定补丁号且不低于 wgpu/MSRV；禁止写 latest、*、浮动 Git HEAD 或仅写 stable 作为交付工具链。

只有主 Agent 修改 workspace manifests/lockfiles。子 Agent 把新增依赖、用途、版本和许可证写入 reports/Txx/dependencies.json，由主 Agent串行批准并更新。不得为避开编译问题重写渲染后端或替换整个技术栈。

## 4. 运行拓扑

```text
Browser: React + WASM Editor + wgpu
      | same-origin HTTP, credentials included
Rust API: auth/project/media/revision/jobs/review/export
      |-- SQLite + immutable local object store
      |-- media/import/export workers (bounded concurrency)
      |-- private stdio NDJSON --> Node Agent Host
                                    |-- OpenAI / Anthropic / MiMo APIs
                                    |-- unmodified Codex App Server (stdio)
                                    |-- unmodified Claude Code (official headless interface)
                                    |-- project-scoped MCP tool bridge
      |-- private stdio NDJSON --> optional Python detector
```

生产本地端口默认 127.0.0.1:48100；开发 Vite 127.0.0.1:5173，经 /api 代理到本地 API。端口可用环境变量覆盖，不硬编码进客户端契约。浏览器不直接连 Codex/Claude，不把官方运行时端口暴露给网络。

正式本地启动只绑定 loopback。Host 与 Origin 精确白名单，不允许 `*`。服务必须有本地启动认证，不可认为“localhost 就不需要认证”。初始管理员通过一次性启动码换取 session；启动码从本地终端交给用户，不放 URL query、日志或前端包。会话用 HttpOnly、SameSite=Strict cookie；HTTPS 时设置 Secure，loopback HTTP 单独明确配置。写操作要求 CSRF token/Origin 验证，登出撤销会话。生产拒绝测试认证开关。

v0.1 的订阅模式仅供本机最终用户本人运行。把服务改为非 loopback 监听不是受支持的上线方式。团队/远程 SaaS 的本地伴随程序配对、租户计费和公网运维另立方案，不可让远端用户消耗服务器所有者的订阅凭证。

## 5. 状态的唯一来源

| 状态 | 所有者 |
|---|---|
| 当前可编辑几何、工具状态机、撤销栈 | Rust EditorCore |
| 已持久化不可变版本、审核、任务、预测 | Rust API + SQLite |
| UI 面板展开、搜索、请求加载状态 | React |
| 图像纹理、实例缓冲、选中覆盖层 | Renderer，仅缓存 |
| 本地待同步草稿 | IndexedDB，包含业务文档而非 GPU 数据 |
| Provider 密钥、认证状态 | 最终用户的官方运行时或本地 secret store；不属于项目数据 |

React 不得复制一套可以自行修改的 bbox 真相。所有创建/修改/接受 AI/撤销通过同一 EditorCommand 入口。服务器重新验证每一份保存文档，不能信任 WASM 客户端。

## 6. 目录职责

```text
apps/web/src/
  app/                  页面路由与装配
  features/projects/    项目、规范、导入
  features/workbench/   画布容器、列表、属性、工具栏
  features/ai/          运行、候选、差异、来源与权限
  features/review/      任务与审核
  features/datasets/    快照与导出
  lib/editor/           WASM facade，不重写几何
  lib/persistence/      IndexedDB 与保存队列
apps/api/src/
  auth/ projects/ media/ annotations/ jobs/ ai/ review/ datasets/
  storage/              DB 与不可变文件存储
  runtime/              host 子进程监管与有限能力 RPC
apps/api/migrations/    仅后端主写任务修改，编号由主 Agent 分配
apps/agent-host/src/
  providers/            openai-api / anthropic-api / mimo-api / codex / claude
  mcp/                  只读上下文与提交候选工具
  security/             进程、路径、环境、外发策略
crates/annotation-domain/src/
crates/geometry/src/
crates/editor-core/src/
crates/renderer-wgpu/src/
crates/renderer-wgpu/shaders/
crates/wasm-bridge/src/
crates/dataset-formats/src/
crates/xtask/src/
packages/contracts/generated/   从 Rust 类型生成，禁止手改
packages/wasm-editor/            生成的 WASM 包与 facade 类型
services/detector/
tests/fixtures/ tests/integration/ tests/e2e/ tests/live/ tests/perf/
scripts/                         跨平台开发与验收入口
reports/Txx/                     任务证据，不存敏感媒体和密钥
```

T00 创建 workspace 必需的 package/crate 空壳和脚本，不创建几十个未使用抽象类。一个 crate 可以有少量文件；模块按实际依赖新增。

## 7. 坐标、输入、渲染约定

持久化使用基准图连续像素坐标，原点左上，x 向右、y 向下，边界 [0,W]×[0,H]，bbox=[xmin,ymin,xmax,ymax]，宽高不加 1。领域 f64；GPU 上传 f32。全部数值有限，框面积正；首期规范不允许超出图像。

原图不可变；服务端统一 EXIF 1..8（包括镜像），生成方向明确的 canonical PNG；预览不改变几何基准；首期导出 canonical 图及对应坐标，不承诺导回原始方向。原始文件与变换保存在原生包中。

视图公式：canvas_css=(image*scale)+translation；指针先减 Canvas bounding rect；DPR 只用于后备像素尺寸，不能再次乘进图像坐标。缩放锚点保持鼠标处 image 坐标不变。控制点 8 CSS px、命中半径 6 CSS px，变焦不改变屏幕触控大小。

工具：选择、框选、拖动创建矩形、四边/四角 resize、移动、多选、重复、删除、改类别/属性、平移、缩放。Esc 取消预览；pointercancel、失焦和切图都不生成半成品；pointer capture 与释放必须配对。中文输入法 composition 和文本框聚焦时禁用编辑快捷键。一次拖动/批量接受=一个撤销单元。最小交互框边长 2 CSS px，提交还需图像空间正面积。

Renderer 用批量实例矩形、缓存 image texture、增量更新、按需重绘。预览与正式对象分层。画布标签只显示选中/悬停及视口前 100 个对象，其余通过 DOM 虚拟列表查看，不能生成万级 DOM 标签。CPU 空间索引 + 明确排序实现重叠循环选择，不做同步 GPU 回读命中。

无 WebGPU 显示诊断和导出/查看列表入口，不静默换 Canvas2D 并宣称完成 wgpu；WebGL 降级不在 v0.1。设备丢失时保留 CPU 文档、本地保存与错误状态，重建资源成功才恢复编辑；零尺寸 Canvas 暂停 configure/render。

## 8. 媒体与资源预算

v0.1 接收静态 PNG 和 JPEG，单文件 ≤64 MiB、宽高分别 ≤4096、总像素 ≤16,777,216。SVG、动图、TIFF、PDF/视频、CMYK/无法明确处理的色彩格式拒绝并给原因。通过解码头验证，不信扩展名或浏览器声明 MIME。保留原图元信息，不能把显示色彩处理宣称为色彩校准。

一次解码任务并发 1，媒体后台任务并发 2，当前图+相邻图最多 3 张解码缓存；GPU 纹理预算 256 MiB，超预算先淘汰邻图并显示占用。用实际 adapter limits 进一步缩小可显示范围，超限明确拒绝，不按低清图坐标保存。

单图软压测 10,000 个框；可写入硬上限 50,000 个框、文档 JSON ≤32 MiB。API 独立设置上传/保存/候选响应的不同 body limit。候选每次最多 1,000 个变更，AI 单次 crop ≤16 张，每张边长 ≤1536（检测器预处理另有记录）。这些是初始安全预算，可在有实测的 ADR 中修改。

## 9. 保存与版本

AnnotationRevision 不可变，head 单独引用。保存携带 operation_id、base_revision_id、document；服务器在单事务中先核查幂等，再比较 head，写新 revision 并原子替换 head。相同 operation_id + 相同请求哈希返回原结果；不同负载复用 operation_id 返回 409 IDEMPOTENCY_KEY_REUSE；版本不匹配返回 409 REVISION_CONFLICT。

客户端每 asset 只有一个保存请求在途；本地事务成功后才显示“已保存本地”。收到旧 generation 的 ACK 不能把更新中的文档显示为已同步。逻辑操作结束后防抖 400ms；提交审核、AI 启动、切图前执行 flush；失败时保留草稿和可下载恢复包。切图可以完成，但不得丢弃原图片的保存队列。

IndexedDB 保存 {asset_revision_id, ontology_version_id, base_revision_id, draft_generation, document, pending_operation_id}。恢复时只有 base=head 才自动恢复；否则进入比较/另存分支/显式舍弃流程，不执行 last-write-wins。浏览器配额失败必须可见。撤销已同步变更会保存新 revision，不删除历史。

## 10. AI：结构、语义与权限

Provider 是通道，不是模型；Profile 固定 provider、完整 model_id、认证类型、能力与验证状态。必须分别列出：codex_local、claude_local、openai_api、anthropic_api、mimo_api、detector_local。一个通道通过不代表其他通道通过。

Codex/Claude 使用官方未修改运行时及其认证流程。不得复制 OAuth token、伪造客户端、调用未公开的订阅后端、将用户令牌发到自己的中转。具体合法使用边界和套餐能力由 T02/T32 结合官方资料与实际账号核实；不把“能登录”当成“允许任意商用代理”。

OpenAI API 可将 gpt-6-luna 作为当前候选型号，但选择器以实际授权和输入能力为准，不写死所有账号都能使用。Sonnet 也必须显示完整 model_id。MiMo 具体多模态型号、端点和输出限制在 T02 从官方平台核验；配置缺失时 unavailable，不冒充 OpenAI 全兼容。

API Key 首期由启动环境或本地 OS secret store 提供，不落 IndexedDB/localStorage、项目导出、报告、日志和 Git。只有设置界面显示已配置/尾部掩码，不回传原值。

运行前：flush 当前文档 → 固定 revision、ontology、媒体 hash 和作用对象 → 显示外发预览与目标提供方 → 用户授权 → 入队。确认绑定 input_fingerprint，不得确认后增加其他图片。每次运行记录成本/用量可用字段；未知费用显示未知，不显示为 0。

VLM 默认只建议类别/属性/疑似问题；精确框候选优先使用检测器。VLM 不充当检测器前置存在性过滤。结构合法不代表识别正确。模型自报 confidence 不用于免审或解释为正确概率。

Prediction 原始结果不可修改。SuggestionSet 存具体 patch 与原因；接受操作经 EditorCore 校验、预览、显式确认和可撤销命令才更新 Draft。Agent 没有 accept/delete-export/project-admin 等工具。

异步结果永久归属原 asset/revision。修改了作用对象、规范、媒体、draft_generation，或有新运行替代旧请求时标 stale。v0.1 不自动 rebase：用户查看差异后重新运行；对仍完全匹配的子集，必须显式选择并重新校验 before_hash 才能另建接受事务。取消后允许记录已返回原结果，但不再生成可自动接受状态。

## 11. 官方运行时的安全边界

Node Host 与 Rust 父进程通过私有 stdio 消息交换，浏览器无法指定可执行文件、cwd、环境变量、文件路径或任意 URL。Host 按固定 argv 启动；禁止拼 shell 命令、执行模型返回的代码和 `shell:true`。

媒体用不透明 grant_id → 私有暂存文件映射；路径必须在本次运行根目录内，拒绝 traversal、symlink escape、Windows drive/UNC 绕过。MCP 暴露有限的 get_context/list_objects/read_region/propose_changes/report_issues；每次重新检查 project/run/asset 和授权预算。

通过官方支持的配置限制 CLI 文件/命令/网络工具，拒绝权限升级请求，不使用危险跳过审批参数。隔离 cwd 不等于安全沙箱。T02/T29 必须证明模型无法读取 home、凭证或其他项目，不能用 system prompt 代替权限隔离。某版运行时无法满足边界时，将该通道标 unavailable/blocked，保留 API 通道并报告缺失；不得悄悄扩权过验收。

官方登录由用户在终端或官方流程完成，不把验证码/密码交给编码 Agent。产品记录授权状态和账号掩码，不采集原始 session token。进程退出、取消、超时清理完整子进程树；运行时版本升级必须重跑协议/安全合约测试。

## 12. 任务、审核与交付

项目角色：admin、annotator、reviewer、viewer。服务器对每一个媒体/标注/候选/导出请求检查 project membership；新项目是否允许自审是显式设置。任务租约 60 秒、心跳 20 秒，服务端时钟判断；保存仍受版本 CAS 保护。

空文档不是负样本。完成状态区分 unprocessed/in_progress/complete/confirmed_negative；negative 要求 objects=[]。已通过版本产生新 head 后，新 head 不能继承批准。

DatasetVersion 在事务中固定媒体 revision、标注 revision、ontology、类别映射和 split。首期由用户明确指定 train/val/test；辅助确定性划分按 source_group_id，不把同来源组拆散。导出只读快照，不读“最新”。YOLO class index 从 0 开始；COCO 使用固定映射。原生格式无损；YOLO/COCO detection 对属性/审核丢失必须报告并要求用户确认。COCO segmentation 非空时不能静默降级为检测；导入必须显式选择“仅 bbox”并保留损失报告。

导入先 dry-run 报告，再原子提交一个媒体/标签单元，不能一半创建一半丢失。ZIP 防 Zip Slip、symlink、压缩炸弹；输出路径用稳定资产 ID 避免同名覆盖。数据包必须能由独立解析器读取并做回显比对。

## 13. 不在本轮执行的项目

Mask/Polygon、瓦片大图、视频/3DGS/点云、移动端/小程序、CRDT、模型训练、自研推理引擎、计费、SSO、公共插件市场、自动免审均不属于本轮。保留模块边界即可，不写假实现或空 UI。后续触发条件见 docs/after-mvp.md。
