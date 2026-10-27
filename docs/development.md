# 开发与变更验证

读者：开发者与模块维护者。读后行动：选择正确启动拓扑，定位修改所有者，迁移契约消费者，并提交覆盖改动的证据。本文依据当前 manifests、开发/验收入口和现行 v1 契约；源码核对不是本轮构建、浏览器或发布通过证明。首次操作者继续使用[完整本地教程](getting-started.md)，故障与发行维护见[本地运维](operations.md)。

## 准备固定工具

当前工具组合为 Node 24.16.0、pnpm 10.34.5、Rust 1.96.0、wasm-bindgen 0.2.128、wasm-pack 0.15.0。精确安装、当前进程 PATH 选择与 Windows 构建前提复用[从源码准备本地服务](getting-started.md#开发者从源码准备本地服务)及[兼容性记录](compatibility.md)。已有合格安装可用；不要修改全局配置或借文档工作恢复已删除的私人开发配置。

在项目根先核对 `node --version`、`node -p process.execPath` 与其余工具版本，再用 `pnpm install --frozen-lockfile` 恢复依赖。安装会写依赖目录；构建、生成和验收也会写产物。版本不符先处理 prerequisite，不降低 pin，不把旧二进制存在当作当前源码通过。

上述安装与启动命令是现行入口说明，本专题写作时未重新执行安装、构建或启动；每次实际运行必须另存命令、退出与运行条件。

## 热开发与 packaged local 的区别

| 入口 | 浏览器入口 | Rust API | 行为与边界 |
|---|---|---|---|
| `pnpm dev` | Vite `http://127.0.0.1:5173`，strictPort | 默认 `127.0.0.1:48100` | 同时运行 cargo API 与 Web dev；Web 的 predev 先构建 WASM bridge。前端热更新不代表 Rust 自动热重启 |
| `weblabel serve` | 默认 `http://127.0.0.1:48100` | 同一 Rust 进程、同一 origin | 校验 v2 发行 manifest/hash，提供静态 Web/WASM 与 API；持有数据库 OS 锁，无 Node/Python 产品进程 |

`pnpm dev` 只在未设置时补 `WEBLABEL_COOKIE_SECURE=false`，**不会自动设置 `WEBLABEL_ENV=development`**。默认仍为 production；显式 development 才允许工程 mock runner，不能把 mock 当真实模型结果。开发默认在项目 cwd 使用 `weblabel.db` 与 `objects`；正式 serve 默认在发行目录下使用 data。始终显式选择数据目录，避免开发与发行共用业务数据。

Vite 的 `/api` proxy 目标固定为 `http://127.0.0.1:48100`；改变 `WEBLABEL_BIND` 不会更新它。改开发端口时须同时核对两端。正式入口只有 `--port`，由 `WEBLABEL_LOCAL_URL` 输出精确浏览器入口；没有第二个私有 API 端口，不换用 localhost 别名。

开发入口退出一项即停止其拥有的进程组；正式入口停止接单、撤销运行能力并等待自有 worker/数据库关闭后释放 OS 锁。持久 sidecar 文件保留，不能删除文件抢占仍在运行的数据库。构建、doctor 与 serve 指向同一发行；升级显式使用原数据目录和原 origin。参数见[配置参考](configuration.md)。

### 原生 Rust 产品与运行边界

产品只有 `weblabel`；weblabel-api 是承载实现的 crate 名，不是第二个产品 binary。开发可执行 `cargo run -p weblabel-api --locked -- serve-api`，仍须显式设置 Cookie Secure 并使用独立数据。正式运行 `weblabel serve --build-dir <v2发行目录> --data-dir <明确数据目录> --port 48100`。

`weblabel doctor --mode runtime --build-dir <同一发行目录>` 不要求 Node、Python 或编译器。运行配置只来自 `WEBLABEL_RUNTIME_CONFIG/WEBLABEL_RUNTIME_ALLOWED_ENV`，按精确 provider/profile 匹配；旧配置加载器与 Node 启动/IPC 链已删除，没有兼容别名。缺席、无效配置和真实模型可用性分别处理。

HTTP provider、Claude MCP 和 CPU 检测器由 Rust factory 组装。原生进程测试和 synthetic HTTP 证明工程边界，不证明账号、模型或目标硬件支持。受控旧备份/新恢复及同路径服务切换的核对不等于用户真实数据库升级承诺；先验证备份再切换，不重初始化 SQLite 或清 IndexedDB。

## 按模块定位修改

| 修改对象 | 负责模块 | 消费者和必须一起考虑的边界 |
|---|---|---|
| 领域实体、JSON 类型、schema、hash | annotation-domain | Rust API、EditorCore、dataset-formats、生成 TS/JSON Schema；不要手改 generated |
| bbox/坐标/变换 | geometry | EditorCore、媒体 canonical 变换、导入导出；f64 领域坐标不能套 GPU f32 容差 |
| 编辑命令、undo/redo、候选接受 | editor-core | wasm-bridge facade、Web 投影与保存 journal；展示层不另存可修改 bbox |
| GPU 资源、WGSL、viewport | renderer-wgpu | wasm-bridge、真实浏览器 device；无 GPU native 测试不证明渲染 |
| 浏览器 facade 和 Native 装配 | wasm-bridge、@weblabel/web | 完整 Native delta 是文档/IDB/保存 producer，设备恢复不能重建业务草稿 |
| 会话、权限、媒体、保存、任务、快照、作业 | weblabel-api | SQLite migrations、公开/局部 DTO、HTTP clients；保存 CAS/lease 同事务 |
| COCO/YOLO/native | dataset-formats | 导入预览/确认、单图与数据集导出、loss_ack 和独立 loader |
| provider、MCP、进程与外发 | Rust runtime | 原始 OS 所有权、持久 profile 与逐次 consent；浏览器不配置 shell/路径 |
| 检测器变换/CPU Worker | Rust runtime detector | 锁定 ONNX/runtime/显式 label mapping；Python 仅导出/独立对照工具，不是产品 |
| 生成和验收 | xtask、scripts、tests | TASKS 固定 argv、证据身份和 reports；主集成者管理共享入口 |

模块职责详见[架构](architecture.md#6-目录职责)，实体和恢复边界详见[数据模型](data-model.md)。新增模块应有真实消费者；不要建立第二套 wire 或业务状态。

## 生成契约与消费者迁移

1. 先确认[共享契约](contracts.md)对应章节及当前恢复增量，区分约束、实现与验证结果。wire `schema_version=1` 与私有 detector `protocol_version=1` 不意味着 HTTP 路径带 `/v1`。
2. Rust 领域类型是生成 wire 的来源。修改需由主集成者批准；同时更新序列化、验证、golden 输入及 Rust/TS 消费者。handler-local DTO 仍须直接核对 handler，不能假称所有响应都已生成。
3. `pnpm contracts:generate` 先运行 Rust xtask，写 `packages/contracts/generated` 的 TS/JSON Schema，再运行开发期 Node 生成器，把既有浏览器契约编译、打包到 `packages/contracts/src/browser-validators.generated.js`。两类生成物均不得手改；Rust 类型仍是 wire 来源。
4. `pnpm contracts:check` 编译 Rust，在项目内唯一 `target/test-artifacts/html-rust-rebuild/contracts-check-*` 目录生成对照，并检查 browser standalone 产物漂移；它不是只读文件系统命令。Node/AJV/esbuild 只参与开发期生成，浏览器不运行 schema compiler，严格 CSP 不需要 `unsafe-eval`。`pnpm test:contracts` 同时运行原 Node 消费者及 `--disallow-code-generation-from-strings` 下的浏览器消费者；这些检查不替代真实浏览器验收。生成失败保留诊断，不拿旧输出当 ACK。
5. 迁移每个实际调用者：可空字段仍必须显式 null，普通 SaveRequest 也完整携带 `lease:null` 和 `suggestion_decisions:[]`。lease、operation/base、journal 不能在未知重放时换值。
6. 完成窄行为检查后再交主集成者统一生成、全树检查和集成；共享 manifest/lockfile、migrations 编号、路由装配、全局导航与 STATUS 不由并发模块作者写。协作边界见[执行规程](execution.md)。

## 按改动选择测试

| 改动 | 首选检查 | 不能由此宣称 |
|---|---|---|
| 领域/geometry/editor | 对应 crate 的 cargo 窄测试、任务卡 argv、边界 fixture | GPU/浏览器/真实 provider 通过 |
| Web 状态、IDB、保存 | 对应 Web Vitest 文件；跨 HTTP 改动加真实 API integration | mocked transport 证明服务端提交 |
| HTTP/权限/CAS/任务 | 对应 Rust/API integration 与真实合成请求 | 只 typecheck 就证明事务正确 |
| 原生协议与 provider | 对应 Rust synthetic-process/loopback 窄测试 | 官方协议、live 授权或真实消费通过 |
| 几何/导入导出 | 固定向量与独立 loader 回读 | 导出成功就说明审核/信息无损 |
| 交互/渲染 | Playwright 与真实 device 场景，必要的手工观察 | software GPU 或截图解除 hardware 边界 |

测试 helper、稳定 fixture 和设备诊断见[测试契约](testing-contracts.md)。根 `pnpm test:unit` 是 `vitest run`，收集 unit、integration、web、live-engineering 项目；不是只跑纯单元测试，集成工程检查会准备真实本地 API。任务窄入口以 TASKS.json 为准，不能把 zero tests 当通过。全部活跃 TS 测试消费者另由测试 tsconfig 做 strict typecheck。

`pnpm test:task <任务ID>` 按任务声明的 checks 执行；以实际 TASKS.json/card 为准，不猜测试名。`verify:fast`、`verify:integration`、`verify:browser`、`verify:gpu`、`verify:live`、`verify:release` 由 wrapper 聚合，但会生成日志/JSON、构建产物或测试数据，不是只读诊断。live 还涉及额外授权边界，不能为普通开发顺手调用。范围与 gate 定义见[验证说明](verification.md)。

验收子进程保留当前进程显式设置的`RUSTC_WRAPPER`，包括用于禁用Cargo配置中wrapper的空字符串；未设置时不替用户选择或修改全局wrapper。不要用shell中“删除变量”冒充显式空值，两者可能选择不同的编译路径。固定工具、缓存、临时目录及凭据白名单仍由验收入口隔离。

## 调试与提交证据

先判定错误来自哪一层：工具 pin → WASM predev → Vite proxy/端口 → session/CSRF/项目角色 → Native/IDB/HTTP → CAS/lease → review/snapshot。保留具体 code/request_id 和原输入；不记录启动码、Cookie、CSRF、密码、private Host JSON 或用户图。`RUST_LOG` 是 tracing 过滤入口，默认 info，不应以调高日志为由暴露秘密。

保存问题先记录 document/base/generation、pending 原请求、双作者、journal 和未知 outcome；查看 head 只能诊断，不能证明本次请求是否已提交。图形调试要分别记录 actual_backend、adapter_kind、device_state；API 的 health 或页面能打开不是 device ready。

提交证据至少包含实际 base/集成 commit、命令 argv/exit、测试数量或 null、工具与运行条件、输入/产物 hash、已验证和未验证项。文档字节单独 hash，工程 source snapshot 不自动覆盖 Markdown。历史报告不重写；T32 blocked/T35 pending 等状态不因本专题新增而升级。独立审查与全项目验收由主集成者在所有切片落地后执行。
