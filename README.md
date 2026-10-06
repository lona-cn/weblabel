# WebLabel

Windows 本地图片标注与 AI 审校工作台：React 业务 UI、Rust/WASM 编辑内核与真实 wgpu 画布、Axum API、SQLite WAL 和不可变内容寻址媒体。人工编辑不需要 Python、模型权重、API key 或官方订阅 CLI。

**发行边界：可重复源码构建与 loopback 启动；未提供签名 exe/安装器。五种必需真实模型渠道仍 blocked，不能宣称完整 G4 发布。**

## 本地启动

需要固定 Node **24.15.0**、pnpm **10.34.5**、Rust **1.96.0**（Windows MSVC 与 WASM target）、wasm-bindgen **0.2.128**、wasm-pack **0.15.0**，以及真实 WebGPU 的桌面 Chrome/Edge。

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
| 崩溃/设备恢复 | [T30 result](reports/T30/result.json)：注册 integration 7 + 真实硬件 browser 9；受影响 T09 5 | 实际源码与浏览器交互证据；不是模型调用或 T31 所有性能阈值 |
| 真实模型诊断 | [T32 result](reports/T32/result.json)：注册 exit 2，工程 consumer 35 passed，五渠道 blocked，外发 0 | 实际 loopback API/Host/worker 工程 proof，不是官方账户/型号支持 |
| 本地发行/备份恢复 | [T33 Main closure](reports/T33/main-final-closure.json)：Root全产品构建、注册16/16、真实PowerShell首次bootstrap与浏览器密码登录；实际active Host物理Ctrl+C及新目录数据恢复 | manifest源码与最终解释型CLI源码分别记录；已闭合受管子孙退出、portable DB及已配置密钥在业务TEXT/JSON碰撞时拒绝备份；不是签名安装包/live证明 |
| 自愿工时/试点分析 | [T34 Main closure](reports/T34/main-final-closure.json)：API7/7、受影响Web75/75、真实Workbench显式PUT200、20张完整GT合成图JSON/CSV | 默认关闭/无后台外传；费用未知=null；实际人工试点0，ROI/结论null，30%仅目标 |
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

```powershell
node scripts/backup.mjs --data-dir "data" --backup-dir "backups/新的备份"
node scripts/restore.mjs --backup-dir "backups/新的备份" --data-dir "新的恢复目录"
```

备份使用真实 SQLite backup API 包含 WAL 提交，并验证引用对象 hash。认证、私有 provider 配置、官方登录凭证不搬运；历史业务用户/审计身份保留，恢复后创建新的授权本地管理员。恢复只接受完整、hash/schema 兼容的备份并拒绝已有目录，无清空/覆盖开关。备份包含敏感业务数据且不加密，请参照操作指南设置本地 ACL 和保管策略。

## 维护与验收

`pnpm test:task T33` 实际注册运行发行 CLI 与 SQLite/HTTP 行为验收；没有发行 override 时从当前源码构建专用发行。固定版本、契约、任务 DAG 和集成状态分别以项目计划与任务报告为准。根 manifest/router/migration 由主 Agent 串行集成；本文不把工程源码提交自行标记为 STATUS done。
