# 本地运维

本指南面向管理本机数据目录的操作者。目标是诊断、停启和安全保管数据，而非公网部署。

## 进程与端口

默认浏览器入口为 `127.0.0.1:48100`；私有 API 为 `127.0.0.1:48101`。启动器提供已构建静态 Web/WASM 和同源 `/api/` 转发，先精确检查浏览器 Host/Origin，再转发到受限本地 API。API 每个资源仍执行身份、membership、CSRF 与权限检查。内部 Agent 工具路由不由浏览器静态代理暴露。

```powershell
node scripts/start-local.mjs --build-dir "target/local-release" --data-dir "data" --port 48200 --api-port 48201
```

只能调整端口，不能通过此命令绑定 `0.0.0.0`、LAN 或公网。浏览器使用输出的精确 `http://127.0.0.1:<port>`，而非任意 hostname。HTTP loopback 的 cookie Secure 显式为 false，HttpOnly/SameSite/CSRF 仍有效；不要把它当 HTTPS 远程部署配置。

数据目录中的 `runtime.lock` 保留启动器 PID 和端口；重复启动同一目录会非零退出。Ctrl+C 关闭 Web listener、完整受管 API/Host 树，再移除锁。Windows 为按树强制终止，SQLite WAL 保留完整已提交事务。正在运行/中断的收费模型调用成本可能未知，必须由用户检查后显式重试，不能自动重发。

如果机器断电留下锁：先在任务管理器按锁中的 PID、可执行路径和端口核对所有受管进程已停止，然后**仅移除该锁文件**再启动。不要删除 `api.sqlite`、`-wal`、`-shm` 或对象目录以“修复启动”。CLI 不自动清理未知锁，也不重置已有数据。

## 只读 doctor

```powershell
pnpm run doctor
# 指定发行或中性 Cargo cwd：
node scripts/doctor.mjs --build-dir "target/local-release" --cargo-cwd "D:/cache/cargo/bin"
```

诊断 JSON 将固定工具版本、产物 hash 和配置是否存在分别列出。缺失、版本不符、发行缺失/损坏均非零退出；诊断本身不创建数据、修改配置、登录账号、读取私人凭证文件、启动 Python、hash 模型权重、下载或收费调用。

`environment-present-not-validated` 只是指定环境变量存在，不验证账户、端点、权限、模型图像输入或余额。`live-not-run` 和 `browser-device-probe-required` 不应解读为模型/GPU通过。实际浏览器 device 与真实 provider 关卡独立验证。

## AI 可选配置

人工编辑不需要任何 AI 组件。只有操作者显式提供 `WEBLABEL_HOST_CONFIG` 的绝对私有配置路径，启动器才启用发行内的 Node Host/runtime；内部 MCP 也在同次发行中。API 项目外发策略默认 false，预览与授权仍必须通过实际服务端接口。CLI 登录由用户本人在官方流程完成；不让编码 Agent 代填、不把 token 交给应用、不复制官方凭证目录。

恢复后所有 provider 私有配置被清空并标记 needs_configuration/not_run，旧外发 consent、运行授权和 preview 被移除。重新配置不能继承旧 live 证明；参考 [provider compatibility](provider-compatibility.md) 并显式授权预算后另跑实际验收。

## 自愿本地测量

需要记录工时时，先读 [自愿本地工时与受控试点协议](pilot-protocol.md)。记录默认关闭；明确保存才写入当前项目/用户的本机服务，不是后台遥测。备份会保留已明确提交的活动记录，但不会搬运浏览器尚未提交的本地记录。程序化演示只证明格式与计算链路，不是人工试点、ROI 或“节省30%”证据。

## 故障处理

| 错误 | 安全动作 |
|---|---|
| `node_version` / version_mismatch / missing | 安装固定版本，重新运行 doctor；不要降低版本校验 |
| `build_missing` / hash_mismatch | 选择新发行目录重新构建；不要手动伪造 manifest |
| `data_in_use` | 检查当前服务/锁 PID；确认停止后只处理锁 |
| API unavailable | 保留数据，读取终端错误；确认私有端口未占用/配置路径存在 |
| GPU unsupported/lost | 保留 CPU 文档/本地草稿；使用诊断或显式恢复，不切 Canvas2D |
| 保存 conflict/lease expired | 保留草稿，比较版本/重新取得有效租约；不覆写服务器 head |
| restore_directory_exists | 选择新的目标目录；不使用 overwrite 或 reset |

服务器保存/接受同事务、CAS 和幂等由 API 实现；此启动器不会绕过这些规则。对象采用内容寻址且不可变。v0.1 无自动 GC，避免删除仍被历史 revision/快照引用的对象。
