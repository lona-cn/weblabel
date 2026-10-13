# 配置与生效边界

读者：开发者、本机服务维护者与验收者。读后行动：按实际入口选择参数，分清可配置值、服务受管值与私有模型边界。本文核对当前 CLI/API/Host/检测器实现，不证明本轮启动、模型或备份恢复已经运行。首次使用步骤见[本地教程](getting-started.md)，运维动作见[运行手册](operations.md)。

## 固定版本与选择方式

| 工具 | 固定值 | 选择依据 |
|---|---|---|
| Node | 24.16.0 | 根 engines 与发行 pins；发行、备份恢复入口精确检查 |
| pnpm | 10.34.5 | 根 packageManager 与 lockfile |
| Rust | 1.96.0 | rust-toolchain 与发行 pins，构建子进程指定 RUSTUP_TOOLCHAIN |
| wasm-bindgen | 0.2.128 | 发行 pins 与 WASM ABI 组合 |
| wasm-pack | 0.15.0 | 发行 pins |

选择当前进程 PATH，核实版本及 executable 实际路径；不以“Node 24 LTS”代替补丁号。安装及中性 Cargo cwd 的现有流程见[兼容性](compatibility.md)与[开发指南](development.md)。`--cargo-cwd` 改 Cargo/工具检查 cwd，不把项目根或输出根搬走，也不忽略该 cwd 的 Cargo 配置。

## CLI 选项表

所有下列选项采用独立的 `--名称 值` 参数对；重复、未知、缺值参数失败，不支持凭猜测添加 `--force`。相对路径按进程 cwd 解析，未指定的默认目录按项目根解析。目录归属、hash、平台与精确 pin 仍会校验。

| 入口 | 选项 | 默认或必填 | 约束/管理行为 |
|---|---|---|---|
| `node scripts/build.mjs` | `--build-dir` | `target/local-release` | 新发行目录，不得已存在；与 intermediate 的真实目录不得重叠 |
| build | `--cargo-cwd` | 项目根 | Cargo 与相关版本命令 cwd，manifest 仍为本项目 |
| build | `--target-dir` | `target` | Cargo 编译缓存，可复用；不是发行目录 |
| build | `--intermediate-dir` | `target/build-cache/<UUID>` | 独占新建，WASM/Host 中间输出；不覆盖已有目录 |
| `node scripts/start-local.mjs` | `--build-dir` | `target/local-release` | 必须是已构建且 manifest/hash 合格的发行 |
| start-local | `--data-dir` | `data` | 创建或打开数据目录，取得独占 runtime.lock |
| start-local | `--port` | 48100 | 浏览器 loopback 端口，整数 1–65535 |
| start-local | `--api-port` | 48101 | 私有 API loopback 端口，整数 1–65535，与 Web 不同 |
| `node scripts/doctor.mjs` | `--build-dir` | `target/local-release` | 只检查指定发行，不构建、不启动模型 |
| doctor | `--cargo-cwd` | 项目根 | 工具探针 cwd，不改变发行目标 |
| `node scripts/backup.mjs` | `--data-dir` | 必填 | 源数据目录，读取一致性数据库与已引用对象 |
| backup | `--backup-dir` | 必填 | 新目录，不得等于源或位于源内部 |
| `node scripts/restore.mjs` | `--backup-dir` | 必填 | 校验备份 manifest、数据库、schema、对象 |
| restore | `--data-dir` | 必填 | 不存在的新目录，父目录须存在；失败目标保留 |
| restore | `--migrations-dir` | 项目内 API migrations | schema 校验材料；常规恢复不覆盖，不能借此跳过兼容性 |

doctor 的 `configuration` 为 `credential_environment=not_forwarded`、`account_state=not_inspected`。工具状态为 pinned/version_mismatch/missing，发行状态为 missing/hashes_valid/invalid；总状态 passed/blocked/failed 对应 exit 0/2/1。结构和 hash 合格不等于 WebGPU、账号、推理或 release gate 通过。

## API 直接运行环境

直接 cargo/API 二进制入口使用以下变量；启动器对子进程覆盖的值另见下一节。未设置 Cookie Secure 时启动失败，不能把 dev 自动补值套在直接运行上。

| 名称 | 默认或必填 | 生效入口与约束 | 是否由服务管理 |
|---|---|---|---|
| `WEBLABEL_BIND` | `127.0.0.1:48100` | API SocketAddr；production 非 loopback 返回 NON_LOOPBACK_BIND | 直接运行可设；start-local 管理 |
| `WEBLABEL_DATABASE_URL` | `sqlite:weblabel.db` | API Repository；当前实现去 sqlite: 前缀作文件名，不是任意数据库后端连接串 | 直接运行可设；start-local 管理 |
| `WEBLABEL_OBJECT_ROOT` | `objects` | API 内容寻址对象根；相对路径从 API cwd 起算 | 直接运行可设；start-local 管理 |
| `WEBLABEL_SQLITE_WRITE_TIMEOUT_MS` | 2000 | API u64 毫秒，必须大于 0；SQLite busy/write timeout，不是 HTTP 请求重试次数 | 操作者可设，启动器继承 |
| `WEBLABEL_ENV` | 未设或非 development 均 production | 仅精确 development 使 production=false；不是对外部署入口 | 直接运行可设；start-local 强制 production |
| `WEBLABEL_COOKIE_SECURE` | 必填，精确 true/false | API session cookie；loopback HTTP false，HTTPS true 仍需正确接入/白名单设计 | dev 未设才补 false；start-local 强制 false |
| `RUST_LOG` | info | API tracing 环境过滤；禁止记录凭证/业务图 | 操作者可设，非认证开关 |

API 由 bind 地址族与端口生成精确 Host/HTTP Origin 集合，并列出 5173 开发 Origin；没有“任意 Origin”配置入口。单改 bind 不改 Vite proxy，development 也不授权远程 SaaS。拓扑差异见[开发指南](development.md#热开发与-packaged-local-的区别)。

## 管理员恢复输入

仅有本机启动权限的操作者使用；两个变量必须同时设置，恢复前先停掉原服务，使用**原数据目录**。启动器和 dev 校验格式并只向 API 转发；Vite/pnpm 等非 API 子进程不继承 `WEBLABEL_ADMIN_RECOVERY_*`。API 再检查已有非空密码的 platform_admin、未消费 request ID 和 loopback，不能用于空库、普通用户或已 scrubbed 的备份恢复库。

| 名称 | 默认或必填 | 约束 |
|---|---|---|
| `WEBLABEL_ADMIN_RECOVERY_REQUEST_ID` | 未设为关闭；启用时必填 | canonical 小写、非 nil UUID；完成后持久消费，同一 ID 重启拒绝；不是 boolean |
| `WEBLABEL_ADMIN_RECOVERY_USERNAME` | 启用时必填 | 实际已有管理员用户名，3–64 ASCII 字母数字或 `._-`，精确匹配、不 trim |

不接收环境变量中的新密码或自定义恢复码，不绕过登录；与 `WEBLABEL_RESTORE_AUTH=1` 互斥。维护期间不启动普通业务/模型/Host workers，也不恢复中断作业。完成后仍保持维护，必须清除这两个变量并正常重启，再刷新网页、用新密码登录。完整步骤见[管理员密码恢复](operations.md#管理员密码恢复)。

## 启动器管理的值

start-local 的环境由当前进程派生，但强制子 API 的 `WEBLABEL_ENV=production`、`WEBLABEL_BIND=127.0.0.1:<api-port>`、`WEBLABEL_COOKIE_SECURE=false`、`WEBLABEL_DATABASE_URL=sqlite:<data-dir>/api.sqlite`、`WEBLABEL_OBJECT_ROOT=<data-dir>/objects`。不要设置这些父环境来试图绕过启动器参数。

普通启动时，若父进程显式设置非空 `WEBLABEL_HOST_CONFIG`，启动器为 API 设置 `WEBLABEL_HOST_EXECUTABLE` 为当前 Node executable、`WEBLABEL_HOST_CWD` 为数据目录、`WEBLABEL_HOST_SCRIPT` 为发行 `host/runtime.mjs`；否则移除 Host executable/script/cwd/allowed-env，core 仍可运行。管理员恢复维护无条件移除这些值和 Host config；该设置不创建 profile。

| 名称 | 默认或必填 | 生效入口与约束 | 是否由服务管理 |
|---|---|---|---|
| `WEBLABEL_RESTORE_AUTH` | API 未设视为 false；仅精确 0/1 | start-local 校验 restore.json 与已 scrubbed 数据后才传 1；API 还核验恢复资格 | **受管内部值**，不手设绕过认证 |
| `WEBLABEL_RUN_TOKEN` | 每次授权运行生成 | Rust run-scoped Bearer 经私有环境/stdio 给 Host/MCP，撤销/过期失效；不是浏览器 session | **受管内部值**，不自填、不放 argv/日志 |
| `WEBLABEL_BOOTSTRAP_CODE` | API 生成的输出，不是输入配置 | 空库或合格恢复启动时向本地终端输出，10 分钟、单次兑换 | 服务输出；不得写 URL/报告/截图 |
| `WEBLABEL_ADMIN_RECOVERY_CODE` | API 生成的输出，不是输入配置 | 合格管理员恢复启动时打印随机 32 字节的 hex 码，600 秒、单次；GET 不返回码 | 服务输出；只在网页填写，不写 URL/报告/截图 |
| `WEBLABEL_LOCAL_URL` | 启动器输出 | 精确浏览器入口，以输出值为准 | 服务输出，不是端口覆盖变量 |

restore CLI 只创建新恢复目录和 restore.json，不打印恢复码；恢复目录经 start-local 管理的 API 启动终端才输出一次性码。保留旧用户/审核身份与新 restore-admin 的区别，见[备份恢复](backup-restore.md)。

## 私有 Host 与检测器配置边界

| 名称 | 默认或必填 | 生效入口与约束 | 是否由服务管理 |
|---|---|---|---|
| `WEBLABEL_HOST_CONFIG` | 可选；启用 Host 时必填 | API/Node runtime 的私有 JSON；必须现存绝对文件；Node 限制文件 ≤1 MiB | 操作者选择，启动器继承；不公开返回 |
| `WEBLABEL_HOST_EXECUTABLE` | 不设则 ProductionRunner unconfigured | 直接 API 的可信可执行文件；其父目录作为 trusted executable root | 直接运行需配置；packaged 管理 |
| `WEBLABEL_HOST_CWD` | 启用 executable 时必填 | 固定可信 cwd；请求不可换 cwd | 直接运行需配置；packaged 管理 |
| `WEBLABEL_HOST_SCRIPT` | 启用 executable 时必填 | 现存绝对脚本路径，固定 argv | 直接运行需配置；packaged 管理 |
| `WEBLABEL_HOST_ALLOWED_ENV` | 空附加列表 | API 以逗号分隔环境名称，忽略空项、不自动 trim；只转发已有值；不是 secret 本身 | 操作者明确白名单；无 Host 时启动器移除 |
| `WEBLABEL_WASM_BRIDGE_DIR` | crate 下生成的 Web WASM 目录 | Vite 开发/构建读取 wasm_bridge.js 与 wasm_bridge_bg.wasm；不是 Host 配置 | 构建为 Vite 子进程管理；开发可显式选择 |
| `WEBLABEL_DETECTOR_MODELS_LOCK` | detector service 的 models.lock.json | Python Worker 接收；空字符串同未设；锁固定模型与文件 bytes/SHA256 | 可配置，但须同时通过 Node spawn allowlist |
| `WEBLABEL_DETECTOR_WEIGHTS_DIR` | detector service 的 weights | Python Worker 接收；空字符串同未设；resolved 权重根、文件/hash 校验 | 可配置，但须同时通过 Node spawn allowlist |

API Host 最小环境包含 `WEBLABEL_HOST_CONFIG`、`WEBLABEL_RUN_TOKEN` 和 Windows SystemRoot/SystemDrive/TEMP/TMP/WINDIR；额外 credential 环境只能按明确名称加入 allowlist，provider 再按 secret_ref 解析。不能把全部 process.env 无条件交给模型。检测器的 Node `lockPath` 仅是显示身份 fallback，不会自动设置 Python Worker 的实际 lock/weights；`labelMapPath` 为显式 category→label_id 映射，不按名称猜类别。

五层不能混用：

1. **持久 profile**：固定 provider/model/auth/capabilities、execution configuration 与验证状态。
2. **公开投影**：`GET /api/model-profiles` 返回公开状态，隐藏 config/secret_ref，排除 retired codex_local。
3. **私有 Host JSON 与 credential 环境**：HostConfiguration 包含 apiBase、timeoutMs、providers；Host 条目必须与本次获批持久 execution config 精确匹配，否则 profile_configuration_changed。
4. **项目 external-processing policy**：限制允许通道、外发范围和预算。
5. **本次 preview/consent**：固定 actor、revision/ontology/media、作用范围、profile/policy 与 grant；有配置不等于每次获得授权。

正式链路：本机操作者先按provider专题准备固定 WEBLABEL_HOST_CONFIG 与明确环境引用；平台管理员在工作台“管理”只读选择服务器预设，再由 PUT /api/model-profiles/{profile_id} 提交 configuration_hash。GET /api/model-profile-presets 分页公开安全元数据，不输出endpoint/secret_ref/raw config；浏览器不能提交argv、路径或密钥。profile身份/capabilities与真实adapter必须精确匹配；同配置可核对，变更不能覆盖历史profile。未知PUT用GET同时核对hash、profile/provider/model/auth与五capabilities，不重复PUT或调用模型。新profile保持not_run/verified_at=null，配置/Host/政策/按次授权/真实验收分层。未配置预设、无权限、读取失败各自解释；人工工作不依赖AI。

以下仅表示 secret_ref 的脱敏引用结构，不是可直接部署的完整 Host 配置，也不读取任何私人 JSON：

```json
{"secret_ref":"env:WEBLABEL_EXAMPLE_API_KEY"}
```

该环境引用名字只是示意，不是内置默认key。真实Host字段和端点复用provider专题，预设只作严格配置匹配；不借SQL provisioning或示意片段补造“已验证”profile。

## 仅测试与内部变量

`WEBLABEL_TEST_MANUAL_MODEL_WORKER=1` 只在 debug 构建让集成 fixture 自己 drain 模型队列，release 忽略；debug-only drain 不是生产管理 API。`WEBLABEL_API_BINARY` 是测试 helper 的显式二进制选择，不证明它由当前源码构建。`WEBLABEL_T30_HOST_SCRIPT` 属于 Host 测试夹具覆盖，不是用户启动器配置。

`WEBLABEL_API_BASE` 用于私有 MCP/Claude 权限桥，默认 loopback API 48100；packaged 自定义端口需使授权执行配置的 apiBase 对应私有 API，不能拿浏览器端口替代。它不是 Vite proxy 自动覆盖变量，也不授予 Bearer。禁止把内部值当作“跳过初始化/权限”的环境开关。全部可观察成功仍应按 session、项目角色、job/revision ACK 核实，不能以变量已设置宣称能力通过。
