# 配置与生效边界

供本机维护者选择实际入口、配置原生运行时并核对诊断。人工标注不要求 AI 配置。操作步骤见[入门指南](getting-started.md)，维护见[运维手册](operations.md)。源码接口说明不是账号、GPU 或真实模型验收结论。

## 固定版本与选择方式

| 工具 | 固定值 | 使用范围 |
|---|---|---|
| Node | 24.16.0 | 构建、开发、验证；不是 v2 产品运行依赖 |
| pnpm | 10.34.5 | 安装与构建 Web 依赖 |
| Rust | 1.96.0 | 编译原生产品与 WASM |
| wasm-bindgen | 0.2.128 | 浏览器 WASM ABI |
| wasm-pack | 0.15.0 | 构建工具版本检查 |

只调整当前终端 PATH，核对实际可执行路径，不改全局配置。已构建的 v2 发行使用单个 `weblabel.exe`（Windows）或 `weblabel`（Linux），不启动 Node/Python 产品进程。旧预发布包仍按自己的清单运行，不手改清单迁移。

## CLI 选项表

参数均为独立 `--名称 值`，重复、未知和缺值失败。相对路径按进程 cwd 解析。不要猜测 `--force`、覆盖恢复或忽略 hash 的选项。

| 入口 | 选项 | 默认或必填 | 边界 |
|---|---|---|---|
| `node scripts/build.mjs` | `--build-dir` | `target/local-release` | 新目录，拒绝覆盖 |
| build | `--cargo-cwd` | 项目根 | 仅改变编译工具 cwd，不改变项目或输出归属 |
| build | `--target-dir` | `target` | 可复用 Cargo 缓存，不是发行目录 |
| build | `--intermediate-dir` | 项目内独有目录 | 新建 WASM 中间目录，不与发行重叠 |
| build | `--onnxruntime-dir` | 可选 | 复制本地 runtime 库及许可证，不下载或打包默认模型 |
| `weblabel serve` | `--build-dir` | 可执行文件所在目录 | 必须通过 v2 manifest/platform/arch/hash 校验 |
| serve | `--data-dir` | build-dir 下的 data | 升级必须显式指定原 canonical 数据目录；不要依赖默认值 |
| serve | `--port` | 48100 | 单个 loopback Web/API 端口，1–65535；没有第二个 API 端口 |
| `weblabel doctor` | `--mode` | build | build/runtime/ai；运行预编译产品用 runtime |
| doctor | `--build-dir` | 可执行文件所在目录 | 检查同一 v2 发行 |
| doctor | `--cargo-cwd` | 当前 cwd | build 模式工具探针 cwd |
| doctor | `--data-dir` / `--api-url` | 可选 | 只读容量、锁、实际 readiness；不替代浏览器/GPU 验证 |
| doctor | `--target-release` / `--backup-dir` | 同时提供，且需 data-dir | 使用已验证备份做停机升级预检 |
| doctor | `--support-receipt` | 可选新文件 | 白名单脱敏收据，不覆盖已有文件 |
| `weblabel backup` | `--data-dir` / `--backup-dir` | 必填 | 一致性快照；备份目标必须不存在且不在源内部 |
| `weblabel restore` | `--backup-dir` / `--data-dir` | 必填 | 校验完成后恢复到不存在的新目标；失败目标保留 |
| restore | `--migrations-dir` | 当前发行 migrations | 只接受可信迁移材料，不放宽 schema 校验 |
| `weblabel upgrade-preflight` | `--data-dir` / `--build-dir` / `--backup-dir` | 必填 | 持有同一 DB OS 锁，在副本模拟，不升级源库 |
| upgrade-preflight | `--scratch-dir` | 源数据目录的父目录 | 指定本次副本的父目录；物理路径等于或位于源、备份、发行内部时以 `SCRATCH_INSIDE_PROTECTED_ROOT` 拒绝，不创建副本。共同父目录内的新独立子目录仍允许 |

`doctor` 的 passed/blocked/failed 对应 0/2/1。runtime 模式不要求构建工具；ai 模式只做可选 CLI 版本探测，不登录、不加载模型。配置缺席与配置无效不同；结构正确也不代表模型 ready。

## 开发 API 环境

`weblabel serve-api` 是开发/工程验证入口，不提供发行静态页面。`serve` 在同一 Rust 进程中提供 Web、WASM、HTTP API 和私有授权工具路由。

| 名称 | 默认或必填 | 生效边界 |
|---|---|---|
| `WEBLABEL_BIND` | `127.0.0.1:48100` | serve-api；production 拒绝非 loopback |
| `WEBLABEL_DATABASE_URL` | `sqlite:weblabel.db` | serve-api 的 SQLite 文件，不是任意数据库连接串 |
| `WEBLABEL_OBJECT_ROOT` | objects | serve-api 对象根 |
| `WEBLABEL_COOKIE_SECURE` | 显式 true/false | serve-api 必填；serve 的 HTTP loopback 固定 false |
| `WEBLABEL_ENV` | production | 仅精确 development 启用工程 mock；serve 固定 production |
| `WEBLABEL_SQLITE_WRITE_TIMEOUT_MS` | 2000 | 正整数毫秒，SQLite writer 等待，不是 HTTP 重试 |
| `RUST_LOG` | info | tracing 过滤，不得记录秘密或业务图片 |
| `WEBLABEL_WASM_BRIDGE_DIR` | 生成的 Web WASM 目录 | 仅 Vite 开发/构建输入，不是产品运行配置 |

`serve` 由 CLI 数据目录与端口管理实际数据库、对象根和 bind，不接受父环境来换成另一份库。数据库旁的 `api.sqlite.runtime.lock` 是持久 OS sidecar；退出释放 OS 锁但保留文件，不能删文件抢锁。旧安装的 PID 锁只作迁移诊断，不是终止进程的授权。

## 私有原生运行时

唯一配置入口是 `WEBLABEL_RUNTIME_CONFIG`：现存、绝对、无 `..` 的 UTF-8 JSON，最大 1 MiB。`WEBLABEL_RUNTIME_ALLOWED_ENV` 是明确允许的凭证环境变量名列表，不是凭证值；未列入的环境不传给 provider。没有旧配置加载器、Node IPC 或兼容别名。

根结构为 `schema_version:1`、正整数 `timeout_ms`、`providers` 数组；每项只有 `provider` 和 `config`。所有 provider 都按精确的 provider_id/profile_id 选择，profile_id 不重复。hash 使用原始 JSON 数值类别，不把整数和浮点表示混为一谈。

- HTTP provider 为 openai_api、anthropic_api 或 mimo_api；私有配置使用其受校验的 endpoint、model_id、secret_ref 与预算字段。`{"secret_ref":"env:WEBLABEL_EXAMPLE_API_KEY"}` 只说明引用结构，不是完整可部署配置。
- claude_local 的 config 字段为 profile_id、model_id、executable、timeout_ms、max_tool_turns、max_tool_result_bytes。executable 必须为可信原生可执行文件；官方订阅登录由用户本人完成，不接收 API key 来冒充订阅。
- detector_local 的 config 字段为 profile_id、lock_path、model_dir、label_map_path、onnxruntime_library、timeout_ms。路径均为显式绝对路径；runtime/权重/类别映射分别验证，不按类别名称猜映射，不自动下载或调用模型。

平台管理员在网页从本机操作者提供的固定预设建立持久 profile；浏览器只能提交预设身份与配置 hash，不能提交 argv、路径、endpoint、原始配置或凭证。公开 GET 隐藏 config/secret_ref。原生配置、持久 profile、项目外发策略、逐次 preview/consent 和真实模型验收是独立层，不能相互替代。HTTP 可用性不证明本地 Claude/检测器已通过真实准备或验收。

## 认证与受管内部值

管理员密码恢复使用 `WEBLABEL_ADMIN_RECOVERY_REQUEST_ID`（canonical 非 nil UUID）与 `WEBLABEL_ADMIN_RECOVERY_USERNAME`（已有管理员实际用户名）。两者必须同时设置；停止原服务后使用原数据目录。维护中不启动业务/模型 workers；完成后清除两个输入再正常启动。完整流程见[管理员密码恢复](operations.md#管理员密码恢复)。

`WEBLABEL_BOOTSTRAP_CODE`、`WEBLABEL_ADMIN_RECOVERY_CODE`、`WEBLABEL_LOCAL_URL` 是服务输出，不是输入；码不放 URL、报告或截图。`WEBLABEL_RUN_TOKEN` 与 `WEBLABEL_API_BASE` 是运行级私有工具桥输入，由可信 Rust 父进程提供，撤销后失效，不是浏览器 session。恢复完成标记由服务在取得 OS 锁后验证，再开启一次性新身份 bootstrap；不要手设内部恢复 flag 绕过资格。

`WEBLABEL_TEST_MANUAL_MODEL_WORKER=1` 只作用于 debug 工程测试，release 忽略。`WEBLABEL_API_BINARY` 仅是测试 helper 的显式二进制选择，不证明当前源码构建。测试 fixture、诊断 JSON 与页面可见均不能作为真实模型或硬件支持证明。
