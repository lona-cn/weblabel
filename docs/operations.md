# 本地运维

供管理本机数据目录的操作者进行高级运维：诊断故障、停启服务、配置团队成员和保管数据。普通用户先读[网页首次登录与人工标注](getting-started.md#首次登录与人工标注)；首次设置和密码登录都在网页完成，不需要另开 PowerShell 或调用初始化 API。忘记已有管理员密码见[管理员密码恢复](#管理员密码恢复)，从备份恢复到新目录见[备份恢复](backup-restore.md)，两者不混用。工具准备见[开发者构建与启动](getting-started.md#构建与启动)；本文不提供公网部署方案，真实验证边界以对应报告为准。

## 进程与端口

默认入口为 `127.0.0.1:48100`。同一个 Rust 进程提供发行 Web/WASM、HTTP API 和受运行级权限保护的内部工具路由；没有 Node 前门或第二个私有 API 端口。每个业务资源仍执行身份、membership、CSRF 与权限检查，内部工具不能用浏览器 session 代替私有能力。

```powershell
.\target\local-release\weblabel.exe serve --build-dir "target/local-release" --data-dir "data" --port 48200
```

这个命令只允许改端口，不能绑定 `0.0.0.0`、LAN 或公网。浏览器使用输出的精确 `http://127.0.0.1:<port>`，而非任意 hostname。HTTP loopback 的 cookie Secure 显式为 false，HttpOnly/SameSite/CSRF 仍有效；不要把它当 HTTPS 远程部署配置。

服务输出实际 canonical 数据目录和精确 `WEBLABEL_LOCAL_URL`。`/ready` 的 200/normal 才表示业务依赖准备完成；503/password_recovery 表示维护，`/health` 204 或端口可连接不能替代。Ctrl+C 停止接单、撤销能力并等待所属 worker/数据库关闭，之后释放 OS 锁；收费取消/成本仍可能 unknown。

数据库旁的 `api.sqlite.runtime.lock` 持有整个进程寿命的 OS 独占锁，直接 serve-api 也受保护。sidecar 文件永久保留，退出后由 OS 释放锁。**不要删除该文件来抢占数据库**，也不要删除 SQLite/WAL/SHM/对象以修复启动。路径别名先规范化，不用 hardlink 或外部工具绕过同库互斥。

旧安装的 `runtime.lock` PID 元数据只作诊断；新程序不凭其中 PID 杀进程或自动移除未知锁。升级前停止所有旧服务，验证备份，显式传入旧 canonical 数据目录并保留原 48100 origin；不要初始化替代库或清 IndexedDB。回滚需使用保留的旧发行与切换前备份，不对新库重放旧迁移。

## 管理员密码恢复

仅用于有本机启动权限的操作者忘记**已有平台管理员**密码；不提供公网/普通用户自助找回，不接受环境变量中的新密码或自定义恢复码。先确认原数据目录、实际管理员用户名和使用当前功能的发行；不要清库、创建替代账号或改 membership。未同步草稿先保全，恢复不会清 IndexedDB；账号 user_id 保持不变。

1. 停止原服务和同库所有 API，确认已退出。使用原数据目录；空库应走首次设置，已 scrubbed 的备份库应走备份恢复后的账户设置，不能用本功能补密码。
2. 在包含当前原生发行的终端执行，用户名替换为原管理员实际值；不需要 Node。UUID 是非秘密操作标识，不是密码/恢复码；不要用 `1` 或复用已完成的 ID。

```powershell
$env:WEBLABEL_ADMIN_RECOVERY_REQUEST_ID = [guid]::NewGuid().ToString("D")
$env:WEBLABEL_ADMIN_RECOVERY_USERNAME = "local-admin"
try {
  .\target\local-release\weblabel.exe serve --build-dir "target/local-release" --data-dir "data" --port 48100
} finally {
  Remove-Item Env:\WEBLABEL_ADMIN_RECOVERY_REQUEST_ID -ErrorAction SilentlyContinue
  Remove-Item Env:\WEBLABEL_ADMIN_RECOVERY_USERNAME -ErrorAction SilentlyContinue
}
```

3. 启动终端输出新的 `WEBLABEL_ADMIN_RECOVERY_CODE`（随机 32 字节 hex，600 秒有效、只能用一次）。它是服务输出，不是要手设的环境变量。打开精确 `WEBLABEL_LOCAL_URL`，刷新页面，确认“管理员密码恢复维护”的目标用户名和 request ID。在网页填写恢复码、新密码、确认密码；密码 12–1024 UTF-8 字节，首尾空格保留。不得把码或密码放 URL、报告、截图或 transcript。
4. 页面确认 `completed` 后仍处于维护，**不会自动登录**。在启动终端 Ctrl+C 停止维护；finally 清除两个输入变量。再用相同发行、原数据目录普通启动，完整刷新网页并用新密码登录：

```powershell
.\target\local-release\weblabel.exe serve --build-dir "target/local-release" --data-dir "data" --port 48100
```

维护期间普通登录、bootstrap、业务与内部工具路由不可用，业务和模型 workers 不启动。密码更新、撤销目标管理员全部 session、写入不可修改的完成 journal 在同一事务；user_id、角色、业务历史与其他用户 session 不变。正常重启仍遵守权限和租约。

错误码/密码被明确拒绝可人工纠正；限流等待后再试。网络/解析/500/409 等不明结果只能点击“只读核对恢复状态”，不自动或反复重发 POST；GET 会等待正在结算的提交。仅同一 request ID/用户名的 `available` 核对才能解锁人工重提，`completed` 走退出维护步骤。`expired` 且未完成时，可先停服务、保留原两输入值重启以获取新码；已经完成的 ID 无论重启多少次都拒绝重新启用。启动提示 ID 已完成时，清除输入变量正常启动，用此次选择的新密码核实，不另造 ID 掩盖未知结果。

本次功能真实发行、浏览器、事务和旧/新登录证据在 T10 恢复验收（私有归档：`reports/T10/admin-recovery/real-smoke.json`）；合成数据验证不代表真实业务数据库或模型渠道已验收。

## 只读 doctor

```powershell
.\target\local-release\weblabel.exe doctor --mode runtime --build-dir "target/local-release" --data-dir "data" --api-url "http://127.0.0.1:48100"
.\target\local-release\weblabel.exe doctor --mode build --build-dir "target/local-release"
.\target\local-release\weblabel.exe doctor --mode ai --build-dir "target/local-release"
# 升级预检必须先有已验证的备份并停止源服务：
.\target\local-release\weblabel.exe doctor --mode runtime --build-dir "target/local-release" --data-dir "data" --target-release "target/next-release" --backup-dir "backups/verified-snapshot" --support-receipt "target/support-receipt.json"
```

runtime 只要求已构建 v2 发行与本机运行条件，不要求 Node、Python、编译器或官方模型 CLI；build 额外检查固定构建工具；ai 只探测可选 CLI 版本，不登录或调用模型。passed/blocked/failed 对应 0/2/1。指定 api-url 时实际 readiness 失败或维护保持阻塞。容量和锁读取有界、拒绝链接；unknown 不是 0，不保证未来写入成功、不自动 GC。

凭证环境不转发到工具探针，账号不读取。升级预检要求停机与已验证备份，在同一数据库 OS 锁保护下拷贝、模拟精确 schema/migration prefix 并核对源 hash 不变；不执行源库升级，不声称所有回滚成立。支持收据白名单去除路径/PID/私有输出/配置，独占新文件；它不是业务救援包。

## 配置团队审核账号与成员

网页首选：项目页或工作台“管理”中建立平台账号，再在目标项目按真实user_id授reviewer。平台管理员可以读/建账号，项目管理员管理本项目成员，不能拿平台身份替代项目membership。未知用户创建先只读核对，不能凭同名认领；成员核对只证明当前角色，不证明原POST唯一归属。下方API流程保留给高级集成调用者；GET users现支持limit=1..100及cursor，完整读取须按next_cursor继续，不能把第一页当全站用户。

### 1. 核实已有管理员并建立同源会话

先在网页用已有 `local-admin` 和自己设置的密码普通登录，确认目标项目存在。全程使用启动终端的精确 `WEBLABEL_LOCAL_URL`；不要换成 localhost、私有 API 端口或其他端口。PowerShell 会话与浏览器会话独立，不复制浏览器 Cookie。恢复库请改用保存的实际 `restore-admin-<新UUID>` 用户名。

在仓库根目录的独立 PowerShell 终端逐段执行；不启用 transcript，不打印密码、Cookie、CSRF 或请求 body。密码仅在必要内存中转换为 UTF-8 JSON；finally 释放 BSTR 并清除变量引用，这不是托管内存完全擦除的保证。

```powershell
$ErrorActionPreference = 'Stop'
$localUrl = Read-Host '粘贴启动终端的精确 WEBLABEL_LOCAL_URL（无末尾斜线）'
$localUri = [Uri]$localUrl
if ($localUri.Scheme -ne 'http' -or $localUri.Host -ne '127.0.0.1' -or
    $localUri.AbsolutePath -ne '/' -or $localUri.Query -or $localUri.Fragment -or
    $localUri.UserInfo -or $localUrl -ne $localUri.GetLeftPart([UriPartial]::Authority)) {
  throw '必须使用启动器输出的精确 HTTP loopback 入口'
}
$adminUsername = Read-Host '已有管理员实际用户名（普通新库为 local-admin）'
$webSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$securePassword = Read-Host '已有管理员密码' -AsSecureString
$passwordPtr = [IntPtr]::Zero
try {
  $passwordPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
  $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPtr)
  $loginJson = @{ username = $adminUsername; password = $plainPassword } | ConvertTo-Json -Compress
  $loginBytes = [Text.Encoding]::UTF8.GetBytes($loginJson)
  $login = Invoke-RestMethod -Method Post -Uri "$localUrl/api/session/login" -WebSession $webSession -Headers @{ Origin = $localUrl } -ContentType 'application/json; charset=utf-8' -Body $loginBytes
} finally {
  if ($passwordPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPtr) }
  $plainPassword = $null; $loginJson = $null; $loginBytes = $null
  $securePassword.Dispose()
}
if (-not $login.csrf_token) { throw '登录未取得 CSRF；不要执行写入' }
$headers = @{ Origin = $localUrl; 'x-csrf-token' = $login.csrf_token }
$login = $null
$identity = Invoke-RestMethod -Method Get -Uri "$localUrl/api/session" -WebSession $webSession -Headers $headers
if ($identity.platform_admin -ne $true) { throw '需要 platform_admin；停止配置' }
$projectResponse = Invoke-WebRequest -UseBasicParsing -Method Get -Uri "$localUrl/api/projects" -WebSession $webSession -Headers $headers
$projects = [Text.Encoding]::UTF8.GetString($projectResponse.RawContentStream.ToArray()) | ConvertFrom-Json
$projects.items | Select-Object project_id, name, role
$projectId = Read-Host '粘贴目标项目的 project_id（不是项目名称）'
$projectRole = @($identity.project_roles | Where-Object { $_.project_id -eq $projectId -and $_.role -eq 'admin' })
if ($projectRole.Count -ne 1) { throw '当前身份必须具有该项目 admin membership' }
$projectPath = [Uri]::EscapeDataString($projectId)
$membersUrl = "$localUrl/api/projects/$projectPath/members"
function Read-ProjectMembers {
  $cursor = $null
  do {
    $uri = "${membersUrl}?limit=100"
    if ($cursor) { $uri += '&cursor=' + [Uri]::EscapeDataString($cursor) }
    $page = Invoke-RestMethod -Method Get -Uri $uri -WebSession $webSession -Headers $headers
    $page.items
    $cursor = $page.next_cursor
  } while ($cursor)
}
$usersBefore = Invoke-RestMethod -Method Get -Uri "$localUrl/api/users" -WebSession $webSession -Headers $headers
$usersBefore.items | Select-Object user_id, username
Read-ProjectMembers | Select-Object user_id, username, role
```

登录 POST 仅返回 `csrf_token`；用户 ID、用户名、`platform_admin` 和 `project_roles` 来自随后 GET session。GET/POST users 要求 platform_admin；GET/POST members 都要求该项目 admin，平台管理员身份不能替代项目成员权限。成员 GET 默认 limit=100，允许 1–100，按 next_cursor 继续读取；上面函数读取全部页面。

### 2. 创建独立 reviewer 并核实成员

选择不在刚才用户列表中的新用户名：3–64 个 ASCII 字母、数字或 `._-`；密码 12–1024 UTF-8 字节，不 trim。审核者应自己设置、保管密码；不要写字面默认密码或把密码放进脚本文件。创建只执行一次，不加自动重试循环：

```powershell
$reviewerUsername = Read-Host '独立审核者的新用户名'
if ($reviewerUsername -notmatch '\A[A-Za-z0-9._-]{3,64}\z') { throw '新用户名格式无效' }
if (@($usersBefore.items | Where-Object { $_.username -eq $reviewerUsername }).Count -ne 0) { throw '用户名已存在；不要覆盖' }
$securePassword = Read-Host '独立审核者的新密码' -AsSecureString
$passwordPtr = [IntPtr]::Zero
try {
  $passwordPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
  $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPtr)
  $passwordLength = [Text.Encoding]::UTF8.GetByteCount($plainPassword)
  if ($passwordLength -lt 12 -or $passwordLength -gt 1024) { throw '密码须为 12–1024 UTF-8 字节' }
  $userJson = @{ username = $reviewerUsername; password = $plainPassword } | ConvertTo-Json -Compress
  $userBytes = [Text.Encoding]::UTF8.GetBytes($userJson)
  $createdUser = Invoke-RestMethod -Method Post -Uri "$localUrl/api/users" -WebSession $webSession -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $userBytes
} finally {
  if ($passwordPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPtr) }
  $plainPassword = $null; $userJson = $null; $userBytes = $null
  $securePassword.Dispose()
}
if (-not $createdUser.user_id -or $createdUser.username -cne $reviewerUsername) { throw '创建响应未核实；先只读查询' }
$reviewerId = $createdUser.user_id
$usersAfter = Invoke-RestMethod -Method Get -Uri "$localUrl/api/users" -WebSession $webSession -Headers $headers
if (@($usersAfter.items | Where-Object { $_.user_id -eq $reviewerId -and $_.username -ceq $reviewerUsername }).Count -ne 1) { throw '用户读取未核实；停止' }
$memberJson = @{ user_id = $reviewerId; role = 'reviewer' } | ConvertTo-Json -Compress
$memberResult = Invoke-RestMethod -Method Post -Uri $membersUrl -WebSession $webSession -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($memberJson))
$member = @(Read-ProjectMembers | Where-Object { $_.user_id -eq $reviewerId -and $_.role -eq 'reviewer' })
if ($member.Count -ne 1) { throw '成员角色未核实；不要继续审核' }
$member | Select-Object user_id, username, role
```

POST users 成功为 201，返回 `{user_id,username}`；POST members 请求为 `{user_id,role}`，成功为 200，返回 `{project_id,user_id,role}`。成员写入会更新已有角色，不能拿它当无副作用的探测；role 可为 admin/annotator/reviewer/viewer，本例只授 reviewer。

### 3. 处理未知结果并完成网页登录检查

任何创建响应丢失、超时或解析失败，先停在该步骤，不重新 POST users，也不自动重发成员写入。在同一有效会话中仅运行：

```powershell
$observedUsers = Invoke-RestMethod -Method Get -Uri "$localUrl/api/users" -WebSession $webSession -Headers $headers
$observedUsers.items | Select-Object user_id, username, created_at
Read-ProjectMembers | Select-Object user_id, username, role
```

记录原目标用户名、项目 ID、已确认的 user_id、发生时间和非秘密错误/request_id；不保存密码或 body。GET 中同名用户只能证明现在存在，不能证明是原请求 ACK；不能仅凭同名自动认领或继续授权。409 `USERNAME_EXISTS` 不覆盖密码，也不自动改名再创建。403 `PLATFORM_ADMIN_REQUIRED` / `PROJECT_ADMIN_REQUIRED` 时重查身份/项目，不改 DB 绕过；401 时正常登录恢复会话。结果仍无法归属时由管理员核对该账户的真实持有人，在确认之前停止后续操作。

成员 GET 已明确核实目标 user_id/reviewer 后，在网页退出管理员，用新审核者自己的用户名、密码普通登录同一入口；项目页应显示目标项目与 reviewer 身份。若需要程序化核查，新审核者另建自己的 WebRequestSession 按第 1 段普通登录，再 GET session，确认自己的 user_id 和目标 project_roles 中 reviewer；不要复用管理员 Cookie。网页查看实际任务差异、批准/退回的步骤见[团队审核](getting-started.md#6-审核指定-revision)。提交者不能自审；默认 allow_self_review=false，不通过改策略完成本例。完成后关闭本 PowerShell 终端以释放 Cookie/CSRF，不打印或导出会话。

## AI 可选配置

人工工作不依赖 AI。持久 profile、公开投影、私有原生运行配置、项目外发策略与逐次 preview/consent 分层。平台管理员可以在网页从服务器固定预设建立 profile；浏览器不提交原始配置、endpoint、路径、启动命令或秘密。空库没有配置也能人工编辑。

本机操作者显式指定 `WEBLABEL_RUNTIME_CONFIG` 的绝对私有配置路径与 `WEBLABEL_RUNTIME_ALLOWED_ENV` 凭证名称白名单，由 Rust factory 选择精确 provider/profile。配置不自动创建持久 profile，不启动旧 Node/Python 产品。官方登录由用户本人完成；不复制认证目录或打印私有 JSON/key。配置可见不等于模型可用或 live_passed，见[配置参考](configuration.md)与[已知限制](known-limitations.md)。

恢复会清空全部 provider 私有配置，状态回到 needs_configuration/not_run；旧外发 consent、运行授权和 preview 也会移除。重新配置不能继承旧 live 证明；参考 [provider compatibility](provider-compatibility.md) 并显式授权预算后另跑实际验收。

## 自愿本地测量

需要记录工时时，先读 [自愿本地工时与受控试点协议](pilot-protocol.md)。记录默认关闭；明确保存才写入当前项目/用户的本机服务，不是后台遥测。备份会保留已明确提交的活动记录，但不会搬运浏览器尚未提交的本地记录。程序化演示只证明格式与计算链路，不是人工试点、ROI 或“节省30%”证据。

## 故障处理

按[故障诊断与安全恢复](troubleshooting.md)的十组症状处理：先保全，再核对 code/未知结果和当前资格，最后选择明确允许的动作。本页不维护第二张长故障表。保存未知结果必须保留原 operation/body/base/lease/journal；不能泛化为刷新或重新领取后换请求。

保存与候选接受的同事务、CAS 和幂等仍由 API 负责，启动器不能绕过。对象内容寻址且不可变；v0.1 不做自动 GC，不删除仍被历史 revision 或快照引用的对象。
