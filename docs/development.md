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
| `node scripts/start-local.mjs` | 默认 `http://127.0.0.1:48100` | 私有 `127.0.0.1:48101` | 先校验发行 manifest/hash，再提供发行 Web、代理 API、占有数据目录 runtime.lock；不是 Vite |

`pnpm dev` 只在未设置时补 `WEBLABEL_COOKIE_SECURE=false`，**不会自动设置 `WEBLABEL_ENV=development`**。默认仍为 production；显式 development 才允许工程 mock runner，不能把 mock 当真实模型结果。其默认数据库是项目根工作目录下的 `weblabel.db`、对象根是 `objects`，不等于正式启动器默认 `data/api.sqlite` 与 `data/objects`。避免开发与发行共用业务数据。

Vite 的 `/api` proxy 目标固定为 `http://127.0.0.1:48100`；改变 `WEBLABEL_BIND` 不会更新它。需要改开发端口时必须一并核对 Vite、API 的 Host/Origin 白名单及测试 helper，不能只改一端。正式启动器通过 `--port`/`--api-port` 管理不同端口，并以 `WEBLABEL_LOCAL_URL` 输出唯一浏览器入口；它只接受该精确 Host/Origin，不能换用 localhost 别名。

开发入口退出一项即停止其拥有的进程组；正式入口按自己的 Ctrl+C 生命周期停止服务并释放自己的锁。不要终止用户其他服务，或在服务活着时删 runtime.lock。发行构建、doctor、启动的 `--build-dir` 必须相同。参数与环境覆盖规则见[配置参考](configuration.md)。

## 按模块定位修改

| 修改对象 | 负责模块 | 消费者和必须一起考虑的边界 |
|---|---|---|
| 领域实体、JSON 类型、schema、hash | annotation-domain | Rust API、EditorCore、dataset-formats、生成 TS/JSON Schema；不要手改 generated |
| bbox/坐标/变换 | geometry | EditorCore、媒体 canonical 变换、导入导出；f64 领域坐标不能套 GPU f32 容差 |
| 编辑命令、undo/redo、候选接受 | editor-core | wasm-bridge facade、Web 投影与保存 journal；React 不另存可修改 bbox |
| GPU 资源、WGSL、viewport | renderer-wgpu | wasm-bridge、真实浏览器 device；无 GPU native 测试不证明渲染 |
| 浏览器 facade 和 Native 装配 | wasm-bridge、@weblabel/web | 完整 Native delta 是文档/IDB/保存 producer，设备恢复不能重建业务草稿 |
| 会话、权限、媒体、保存、任务、快照、作业 | weblabel-api | SQLite migrations、公开/局部 DTO、HTTP clients；保存 CAS/lease 同事务 |
| COCO/YOLO/native | dataset-formats | 导入预览/确认、单图与数据集导出、loss_ack 和独立 loader |
| provider、stdio/MCP、进程外发 | @weblabel/agent-host | Rust runtime 父进程、持久 profile 与逐次 consent；不由浏览器配置 shell/路径 |
| 检测器变换/CPU Worker | detector service | 锁定模型、显式 label mapping、Node spawn policy；离线算法测试不是推理 |
| 生成和验收 | xtask、scripts、tests | TASKS 固定 argv、证据身份和 reports；主集成者管理共享入口 |

模块职责详见[架构](architecture.md#6-目录职责)，实体和恢复边界详见[数据模型](data-model.md)。新增模块应有真实消费者；不要建立第二套 wire 或业务状态。

## 生成契约与消费者迁移

1. 先确认[共享契约](contracts.md)对应章节及当前恢复增量，区分约束、实现与已验证结果。`schema_version=1` 与 Host `protocol_version=1` 不意味着 HTTP 路径带 `/v1`。
2. Rust 领域类型是生成 wire 的来源。修改需由主集成者批准；同时更新序列化、验证、golden 输入及 Rust/TS 消费者。handler-local DTO 仍须直接核对 handler，不能假称所有响应都已生成。
3. `pnpm contracts:generate` 运行 xtask，写 `packages/contracts/generated` 的 TS/JSON Schema。不要手补 generated 来消除类型错误。
4. `pnpm contracts:check` 会编译 Rust，并在进程临时目录生成对照文件后检查，不是只读命令；如需全产物留在项目内，应在本次子进程设置项目内临时目录。生成失败保留诊断，不拿旧输出当 ACK。
5. 迁移每个实际调用者：可空字段仍必须显式 null，普通 SaveRequest 也完整携带 `lease:null` 和 `suggestion_decisions:[]`。lease、operation/base、journal 不能在未知重放时换值。
6. 完成窄行为检查后再交主集成者统一生成、全树检查和集成；共享 manifest/lockfile、migrations 编号、路由装配、全局导航与 STATUS 不由并发模块作者写。协作边界见[执行规程](execution.md)。

## 按改动选择测试

| 改动 | 首选检查 | 不能由此宣称 |
|---|---|---|
| 领域/geometry/editor | 对应 crate 的 cargo 窄测试、任务卡 argv、边界 fixture | GPU/浏览器/真实 provider 通过 |
| Web 状态、IDB、保存 | 对应 Web Vitest 文件；跨 HTTP 改动加真实 API integration | mocked transport 证明服务端提交 |
| HTTP/权限/CAS/任务 | 对应 Rust/API integration 与真实合成请求 | 只 typecheck 就证明事务正确 |
| Host 协议与 provider | 对应 agent-host fake-process/offline 测试 | live 授权或真实消费通过 |
| 几何/导入导出 | 固定向量与独立 loader 回读 | 导出成功就说明审核/信息无损 |
| 交互/渲染 | Playwright 与真实 device 场景，必要的手工观察 | software GPU 或截图解除 hardware 边界 |

测试 helper、稳定 fixture 和设备诊断见[测试契约](testing-contracts.md)。根 `pnpm test:unit` 实际为 `vitest run`，会收集 unit、integration、web、agent-host、live-engineering 多个项目；不是仅纯单元测试，integration/live-engineering 会准备真实 API。窄检查用任务卡既有 argv 或明确选项目/文件，不能替换指定任务入口或把 zero tests 当通过。

`pnpm test:task <任务ID>` 按任务声明的 checks 执行；以实际 TASKS.json/card 为准，不猜测试名。`verify:fast`、`verify:integration`、`verify:browser`、`verify:gpu`、`verify:live`、`verify:release` 由 wrapper 聚合，但会生成日志/JSON、构建产物或测试数据，不是只读诊断。live 还涉及额外授权边界，不能为普通开发顺手调用。范围与 gate 定义见[验证说明](verification.md)。

## 调试与提交证据

先判定错误来自哪一层：工具 pin → WASM predev → Vite proxy/端口 → session/CSRF/项目角色 → Native/IDB/HTTP → CAS/lease → review/snapshot。保留具体 code/request_id 和原输入；不记录启动码、Cookie、CSRF、密码、private Host JSON 或用户图。`RUST_LOG` 是 tracing 过滤入口，默认 info，不应以调高日志为由暴露秘密。

保存问题先记录 document/base/generation、pending 原请求、双作者、journal 和未知 outcome；查看 head 只能诊断，不能证明本次请求是否已提交。图形调试要分别记录 actual_backend、adapter_kind、device_state；API 的 health 或页面能打开不是 device ready。

提交证据至少包含实际 base/集成 commit、命令 argv/exit、测试数量或 null、工具与运行条件、输入/产物 hash、已验证和未验证项。文档字节单独 hash，工程 source snapshot 不自动覆盖 Markdown。历史报告不重写；T32 blocked/T35 pending 等状态不因本专题新增而升级。独立审查与全项目验收由主集成者在所有切片落地后执行。
