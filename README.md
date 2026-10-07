# WebLabel

Windows 本地图片标注与 AI 审校工作台：React 业务 UI、Rust/WASM 编辑内核与真实 wgpu 画布、Axum API、SQLite WAL 和不可变内容寻址媒体。人工编辑不需要 Python、模型权重、API key 或官方订阅 CLI。

**发行边界：可重复源码构建、含固定运行时的工程便携归档与原生Linux loopback镜像；未提供签名 exe/安装器。五种必需真实模型渠道仍 blocked，不能宣称完整 G4/T35 发布。**

**公开历史说明：** 此仓库是保留186项开发提交的独立净化副本，认证实测产物与大型trace不公开；原本地源码、完整证据和未提交文件未改。应用／构建／测试源码及必要公开fixture保留。原始SHA、任务状态与实际净化验证见[公开来源索引](reports/index.md)和[提交映射](reports/publication/commit-map.json)。历史报告链接指向本地私有归档，不代表公开文件或在新SHA上复跑；历史证据复组脚本也不保证脱离私有归档可执行。

## 本地启动

需要固定 Node **24.16.0**、pnpm **10.34.5**、Rust **1.96.0**（Windows MSVC 与 WASM target）、wasm-bindgen **0.2.128**、wasm-pack **0.15.0**，以及真实 WebGPU 的桌面 Chrome/Edge。

先按[当前终端选择 Node](docs/getting-started.md#当前终端选择-node)校验并选择官方独立 ZIP 中的 Node；以下命令须在该终端运行。只改当前进程的 PATH，不全局安装或改配置；仅用绝对路径启动父 Node 不足以切换子命令中的裸 `node`。结束后还原原 PATH。旧 Node 24.15.0 发行应保留，改用新目录构建，不能改写旧 manifest。

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm start:local
```

根 `build` 和 `start:local` 分别执行 `scripts/build.mjs` 与 `scripts/start-local.mjs`，`backup`/`restore` 也已注册真实CLI入口。首次空库从本地终端的一次性启动码设置新密码；默认网页 `http://127.0.0.1:48100`。服务只监听loopback，媒体、revision和导出仍须身份/项目权限。Ctrl+C清理受管进程树，保留SQLite已提交事务。

- [从零构建、登录、人工编辑](docs/getting-started.md)
- [只读 doctor 与本地运维](docs/operations.md)
- [一致性备份、认证 scrub 与新目录恢复](docs/backup-restore.md)
- [已知限制与模型证据矩阵](docs/known-limitations.md)

## 已提交证据，不等同于完整发布

| 范围 | 实际证据 | 结论边界 |
|---|---|---|
| 保存/审核/快照/权限 | T27/T29 已集成报告 | 不可变版本与鉴权导出工程验收，不是公网部署 |
| 崩溃/设备恢复 | 原始私有T30归档：注册integration7 + 真实硬件browser9；受影响T09为5项 | 继承原始验收，不是在公开SHA上重跑，不是模型调用或全部T31阈值 |
| 真实模型诊断 | 原始私有T32归档：注册exit2，工程consumer35passed，五渠道blocked，外发0 | 不是官方账户/型号支持，公开推送不解除阻塞 |
| 本地发行/备份恢复 | 原始私有T33归档：产品构建、注册16/16、真实首次bootstrap、浏览器登录和受管退出／数据恢复 | 非签名安装包或live证明；公开副本保留实际构建／恢复源码 |
| 自愿工时/试点分析 | 原始私有T34归档：API7/7、Web75/75、真实Workbench保存及20张完整GT合成fixture | 合成fixture保留；人工试点0、费用unknown=null、ROI/结论null，30%仅目标 |
| 最终发布 | 主 Agent T35 | 仍需 G4 独立真实条件，不能由 pnpm build/doctor 替代 |

### 五个必需 live 渠道

| 渠道 | 当前状态 | 必要但尚未满足的实际条件 |
|---|---|---|
| Codex 本人订阅 | blocked / 生产 UNSUPPORTED_RUNTIME | 官方登录、完整型号、固定 runtime 内建工具/文件边界证明、图像/预算授权 |
| Claude 本人订阅 / Sonnet | blocked | 官方登录、完整 Sonnet 型号、固定协议/边界、图像/预算授权 |
| Luna API | blocked | 用户授权账户、当前完整型号/官方端点、收费及合成图预算 |
| MiMo API | blocked | 用户授权账户、完整多模态型号/官方端点、收费及合成图预算 |
| 本地实际 detector | blocked | 公开固定权重/runtime/标签映射、授权真实 forward 与两张合成图人审 |

这张表来自 T32 已提交报告，不读取私人凭证，不以 mock、配置型号或替代通道产生“supported”。Anthropic API 源码也不能替代 Claude 订阅关卡。模型只能产候选；接受必须明确、可撤销、事务保存；外发须项目策略、服务端 scope 与用户授权。

## 数据保护

先在当前终端选择同一 Node 24.16.0，再执行：

```powershell
node scripts/backup.mjs --data-dir "data" --backup-dir "backups/新的备份"
node scripts/restore.mjs --backup-dir "backups/新的备份" --data-dir "新的恢复目录"
```

备份使用真实 SQLite backup API 包含 WAL 提交，并验证引用对象 hash。认证、私有 provider 配置、官方登录凭证不搬运；历史业务用户/审计身份保留，恢复后创建新的授权本地管理员。恢复只接受完整、hash/schema 兼容的备份并拒绝已有目录，无清空/覆盖开关。备份包含敏感业务数据且不加密，请参照操作指南设置本地 ACL 和保管策略。

## CI 与工程发行

面向下载发行包的用户和 CI 维护者：先辨明工程 prerelease 与产品验收，再启动本地服务。

- 主分支推送、PR 和手动 CI：Windows 2025 / Ubuntu 24.04 完整构建，下载并校验同一提交的便携归档，再运行 Rust workspace、Node 契约/计划、TypeScript、完整平台支持的 Vitest 与离线 detector pytest。Vitest 使用 2 个 file workers，不放宽现有断言或 deadline；Linux 仅不运行 Windows 物理 ConPTY Ctrl+C 测试，该测试仍由 Windows lane 执行。
- Windows Chromium 的软件 GPU lane 必须实际取得 wgpu device；它不是硬件性能/恢复/G4 证明。真实模型、官方账号、付费 API 和大权重不在托管 CI 中调用。
- PR 不发布 Release 或镜像。正常主分支 CI 在测试通过后验证 Linux 容器，再发布 GHCR SHA 分发。只有镜像写 job 获得 packages:write；只有最终 Release job 获得 contents:write。所有外部 Actions 固定官方完整 commit SHA；语言与工具版本、锁文件固定。Python 精确为 3.13.16，uv 精确为 0.12.17；uv 的官方 parenthesized 平台/build metadata 不参与数字版本比较，其他版本仍拒绝。
- 推送合法 v 前缀的版本 tag，或从 main 手动运行 Release，可发布工程 prerelease，例如 v0.1.0-rc.1。版本 base 必须与项目一致；稳定 Release/镜像要求真实 T35 完成及 G0–G5 全 pass。已有 Release 不覆盖；已有 SHA 镜像复用原 digest 并重新实际验证，版本标签只提升到通过 registry pull/运行检查的 digest，冲突拒绝，不发布 latest。
- Release 包含 Windows/Linux x64 tar.gz、各自 SHA256 sidecar 和记录源码提交/已验证镜像 digest 的分发 JSON。SHA256 是完整性检查，不是代码签名；不提供签名安装器。

维护者在已授权官方 gh CLI 的终端中触发：

~~~powershell
node scripts/ci_monitor.cjs dispatch release.yml --ref main -f tag=v0.1.0-rc.1
node scripts/ci_monitor.cjs runs --branch main
node scripts/ci_monitor.cjs watch <上一步的运行ID>
node scripts/ci_monitor.cjs test-summary <运行ID>
~~~

完整结果以[GitHub Actions](https://github.com/lona-cn/weblabel/actions)和[Releases](https://github.com/lona-cn/weblabel/releases)为准。工程发布不会将 T32、T35 或原始私有硬件证据自动变为新提交的通过记录。

### 下载包启动

选择系统对应的归档，核对其 SHA256 sidecar，然后解压。包内包含固定 Node 24.16.0、API、WASM/Web、Host 及启动/备份/恢复工具；人工编辑不要求安装编译器或 Python。

Windows PowerShell 示例（替换实际下载的版本）：

~~~powershell
Get-FileHash .\weblabel-0.1.0-rc.1-win32-x64.tar.gz -Algorithm SHA256
tar -xzf .\weblabel-0.1.0-rc.1-win32-x64.tar.gz
& .\bundle\launch.cmd --data-dir "$env:LOCALAPPDATA\WebLabel\data"
~~~

Linux x64：

~~~sh
sha256sum -c weblabel-0.1.0-rc.1-linux-x64.tar.gz.sha256
tar -xzf weblabel-0.1.0-rc.1-linux-x64.tar.gz
./bundle/launch.sh --data-dir "$HOME/.local/share/weblabel"
~~~

在本地终端使用首次启动码设置自己的密码，浏览器打开 http://127.0.0.1:48100。只有真实桌面 WebGPU 才支持编辑；无 WebGPU 不用 Canvas2D 假替代。显式指定数据目录，避免把数据放进下载包或随当前工作目录变化。备份/恢复使用包内 Node 执行对应运维工具，遵守上文新目录与认证 scrub 约束。最小运行包健康检查不等同完整开发工具 doctor。

### GHCR Linux 镜像

仅支持原生 Linux x64 Docker host networking；不是 Docker Desktop 端口转发方案。必须保留 loopback，不使用 -p、不增加公网监听。若 registry 要求授权，使用 GitHub 官方 GHCR 登录方式，不向 WebLabel 提交 token。

~~~sh
docker volume create weblabel-data
docker run --name weblabel --network host --read-only --mount source=weblabel-data,target=/data ghcr.io/lona-cn/weblabel:0.1.0-rc.1
# 使用本地终端的首次启动码；停止时保留 volume
docker stop --time 30 weblabel
~~~

推荐从 Release 分发 JSON 选择 ghcr.io/lona-cn/weblabel@sha256:… 的确切 digest。镜像以非 root 用户运行，PID1 为 tini，程序/静态资源只读，SQLite/对象/临时目录在 /data。SIGTERM 必须回收 API/Host 并移除自有 lock，受管退出码为 130；数据保留供重启。被 SIGKILL/主机断电后不会自动删 stale lock，先按运维文档核实所有者与无运行进程，不能随意删除 lock 或用户 volume。


## 维护与验收

`pnpm test:task T33` 实际注册运行发行 CLI 与 SQLite/HTTP 行为验收；没有发行 override 时从当前源码构建专用发行。固定版本、契约、任务 DAG 和集成状态分别以项目计划与任务报告为准。根 manifest/router/migration 由主 Agent 串行集成；本文不把工程源码提交自行标记为 STATUS done。
