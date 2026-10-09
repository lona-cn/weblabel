# ADR 0003：浏览器首次登录

状态：批准。契约版本：v1，新增只读端点；原 POST 请求与响应不变。

## 原因

GET /api/session 的 401 UNAUTHENTICATED 只能说明没有当前身份，不能区分首次设置、恢复设置和普通登录。浏览器需要提示，但提示不得成为重置账号或绕过启动码的权限。

## 协议

GET /api/session/bootstrap 返回 200：`{ "mode": "initial" | "restore" | "login", "bootstrap_available": boolean }`。Rust BootstrapStatus 生成 TS 和 JSON Schema，浏览器校验后使用。

一次 SELECT 的三个 EXISTS 读取是否有 users、非空 password_hash、任意 sessions。无 users 为 initial；有 users 且 restore_bootstrap_enabled 明确启用、无非空密码且无任意 session 为 restore；其余为 login。失效账号或过期 session 不自动开启恢复。

仅非 login、now <= launch_code_expires_at 且 bootstrap_consumed=false 时 available=true。占用中也返回 false；状态 GET 从不释放或消费码。SQL 失败返回 500/BOOTSTRAP_STATUS_FAILED，固定 message `Bootstrap status could not be read`，不降级成任何认证入口。

session router 最外层统一 Cache-Control: no-store，包括成功、错误及 Host/Origin 拒绝。沿用精确 Host/Origin 和 CSRF 协议，无 Origin 的 GET 沿用现有允许规则。状态不返回启动码、摘要、CSRF、身份或计数。POST 仍常量时间验码、原子占用并在事务内复核恢复资格；恢复管理员新建身份，不覆盖历史账号。

## 浏览器状态与重试

已认证身份优先；仅明确的 401 UNAUTHENTICATED 才查询提示。网络、权限、数据库或 schema 错误显示故障，不伪装为普通登录。

启动码由本机终端交给用户，十分钟有效、单次兑换。只 trim 码，密码原样按 UTF-8 12–1024 字节校验并确认。单飞提交，不自动重发初始化 POST。

成功 ack 后先切换已创建状态并清敏感表单，再安装合法 CSRF、持久化并 GET 完整身份。storage/GET 失败只重查会话；明确 401 后普通登录使用实际用户名提示。POST 结果不明或缺 CSRF 时只读核实身份，不假装会话可写；若身份存在但缺有效 CSRF，指导只清当前站点 weblabel_session Cookie 后正常登录，不清业务数据、不猜 token。

递增 request generation 拒绝过期读取及卸载后的提交。所有凭证只在必要内存或原 sessionStorage CSRF key 使用，启动码和密码不写 storage、URL 或日志。

## 范围

保留 query 导航，不新增静态发行不支持 fallback 的 /setup 路径。没有公网注册、网页发码、自动重启、密码找回、云账号或订阅要求。初始化状态只是 UI 提示，不赋予任何写权限。
