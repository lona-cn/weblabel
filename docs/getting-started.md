# 本地开始使用

面向 Windows 本机操作者：从源代码构建、启动并使用人工标注。不需要 Python、模型权重、API key、Codex/Claude 或订阅登录。AI 是单独配置和授权的可选功能。

## 前提

- Windows x64，桌面 Chrome/Edge，真实可用的 WebGPU device。无 WebGPU 时只能使用诊断/只读入口，不能用 Canvas2D 冒充编辑。
- Node **24.16.0**、pnpm **10.34.5**、Rust **1.96.0**（MSVC 工具链与 Windows C++ Build Tools）、Rust 的 `wasm32-unknown-unknown` target。
- wasm-bindgen CLI **0.2.128**、wasm-pack **0.15.0**。不要使用 `latest` 或浮动 `stable` 替代这些固定版本。
- 首次获取锁定依赖需要网络；构建不会登录账号、调用收费模型或下载模型权重。源发行没有签名 exe、安装器或跨 OS 安装承诺。

## 当前终端选择 Node

从 [Node 官方发行目录](https://nodejs.org/download/release/v24.16.0/)获取 Windows x64 ZIP，用该目录的 `SHASUMS256.txt` 校验 SHA256 后，解压到自己选择的独立目录。保留完整 ZIP 内容，包括随附的 `node_modules/corepack/dist/pnpm.js`；现有 Windows 构建和 doctor 会使用 Node 旁的 Corepack，不能只复制 `node.exe`。这不需要全局安装 Node、启用全局 Corepack shim 或修改全局配置。

在仓库根目录的 PowerShell 中选择该目录（示例路径须改为你实际解压的位置）：

```powershell
$nodeDir = (Resolve-Path "C:/tools/node-v24.16.0-win-x64").Path
$originalPath = $env:PATH
$env:PATH = "$nodeDir;$originalPath"
node --version       # 必须是 v24.16.0
node -p "process.execPath" # 必须位于上面的独立目录
pnpm --version       # 必须是 10.34.5
```

只修改此终端进程的 PATH，后续裸 `node` 子命令才会继承选中的版本；仅以绝对路径调用父 `node.exe` 不够。版本不符时先停止，检查目录和实际命令，不降低校验。若没有可用的 `pnpm` 命令，下文 `pnpm <参数>` 可改为 `node "$nodeDir/node_modules/corepack/dist/pnpm.js" <参数>`，使用仓库固定的 pnpm 10.34.5；首次获取该版本可能需要网络，不运行全局安装或配置命令。

下文构建、启动、doctor、备份及恢复均使用此终端选择。完成或命令异常返回后还原 `$env:PATH = $originalPath`；也可以在独立子 PowerShell 中执行，退出子终端不会改变父终端的 PATH。下面的主流程用 `finally` 自动还原；之后若要运行其他入口或在新终端操作，应重新执行上述选择步骤。

## 构建与启动

在仓库根目录的终端按顺序执行；任一步非零退出时先停止并处理终端错误，不继续启动：

```powershell
try {
  pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw "依赖安装失败，请先处理终端错误" }
  pnpm build
  if ($LASTEXITCODE -ne 0) { throw "构建失败，请先处理终端错误" }
  pnpm run doctor
  if ($LASTEXITCODE -ne 0) { throw "doctor 未通过，请先处理终端错误" }
  pnpm start:local
} finally {
  $env:PATH = $originalPath
}
```

根命令已注册真实入口；在已选择 Node 的终端中，等价的直接入口是：

```powershell
node scripts/build.mjs
node scripts/start-local.mjs
```

默认发行目录是 `target/local-release`，默认数据目录是 `data`。重复构建**拒绝已有发行目录**，以免旧产物混入新发行。旧 Node 24.15.0 发行的工具 pin 不兼容当前启动器；保留旧目录与 `release.json`，不要手改清单，选择新的目录重新构建：

```powershell
node scripts/build.mjs --build-dir "target/本地 release 2026-10-06"
node scripts/doctor.mjs --build-dir "target/本地 release 2026-10-06"
node scripts/start-local.mjs --build-dir "target/本地 release 2026-10-06" --data-dir "data/项目 数据"
```

参数是独立 argv、`shell:false`；中文、空格和 `&` 可用于目录名，但终端仍需把整个路径加引号。不要拼接未经信任的 shell 命令。输出 `release.json` 包含 API、Web、WASM、Host、migrations 的实际 SHA256/字节数、平台和工具版本；启动前重新验证全部列出的文件和必需产物，缺失/修改会非零退出。

构建使用 release Rust→WASM，再由固定 wasm-bindgen 生成浏览器模块，不调用失败的旧 wasm-opt 优化路径。人工编辑的几何与渲染来自同一次当前源码编译，不加载陈旧的开发 WASM。构建也运行生成契约一致性和 Web 类型检查。

如果本机祖先目录有不兼容的 Cargo 配置，不要修改全局配置；使用你选择的中性目录和当前工具链的显式编译器：

```powershell
$env:RUSTUP_TOOLCHAIN = "1.96.0"
$env:RUSTC = "D:/cache/cargo/toolchains/1.96.0-x86_64-pc-windows-msvc/bin/rustc.exe"
node scripts/build.mjs --cargo-cwd "D:/cache/cargo/bin" --build-dir "target/新的发行目录"
```

以上 `D:` 路径是本次实测机器的示例，不是产品依赖；你的机器应使用自己的已安装路径。构建内部使用绝对 manifest/target 路径。

doctor 是只读 JSON 诊断：工具版本须为 `pinned`，选定发行须为 `hashes_valid`；缺失、版本不符或发行损坏均非零退出。新目录的 `--build-dir` 必须在构建、doctor 与启动时保持一致。它不证明浏览器 WebGPU、模型账户或 Node 24.16.0 的备份恢复实测通过；[兼容性记录](compatibility.md)区分当前 pin 与历史观察。

## 首次登录与人工标注

1. 打开终端显示的 `WEBLABEL_LOCAL_URL`，默认 `http://127.0.0.1:48100`。不使用公网地址。
2. 空数据库第一次启动会在本地终端显示一次性 `WEBLABEL_BOOTSTRAP_CODE`，有效10分钟、仅能兑换一次。登录页目前只有用户名/密码，没有启动码输入控件；在**另一个本机 PowerShell 终端**调用真实初始化API，设置12–1024字节的新密码，不把码放URL或日志：

```powershell
$base = "http://127.0.0.1:48100" # 改为终端实际 WEBLABEL_LOCAL_URL
$launchCode = Read-Host "一次性启动码" -AsSecureString
$newPassword = Read-Host "新本地密码（至少12字节）" -AsSecureString
try {
  $payload = @{
    launch_code = [System.Net.NetworkCredential]::new("", $launchCode).Password
    password = [System.Net.NetworkCredential]::new("", $newPassword).Password
  } | ConvertTo-Json -Compress
  $result = Invoke-RestMethod -Method Post -Uri "$base/api/session/bootstrap" -Headers @{Origin=$base} -ContentType "application/json; charset=utf-8" -Body $payload
  "本地管理员用户名：" + $result.username
} finally {
  Remove-Variable launchCode,newPassword,payload,result -ErrorAction SilentlyContinue
}
```

3. 回到浏览器，用返回的用户名和刚设置的密码正常登录，获取浏览器自己的session/CSRF。普通新库用户名为 `local-admin`；本版本没有公网注册、密码找回或SSO。不要把API初始化发出的session手工搬到浏览器。
4. 新建项目并发布类别/属性规范；导入静态PNG/JPEG，等待后台媒体作业完成。
5. 打开资产工作台。WebGPU必须显示真实ready才可编辑。框选工具画框、选择/修改类别和属性；一次拖动一个undo。焦点在画布或对象列表时，`V/B/H` 切换选择/矩形/平移，`Delete/Backspace` 删除当前原生选择，`Ctrl/Meta+Z` 撤销、`Ctrl/Meta+Y` 或 `Ctrl/Meta+Shift+Z` 重做，按住 Space 临时平移、松开恢复原工具。文本/IME、项目导航、审核和AI控件不触发编辑快捷键；按钮的 Space 仍用于激活。设备未就绪、服务端版本只读预览或审核提交期间不允许这些原生命令。等待远端保存确认，不把“已保存本地”当远端ACK。
6. 审核绑定已保存不可变revision。冻结数据集指定train/val/test，快照导出不跟随最新head。YOLO/COCO属性信息损失需要明确确认；原生包用于无损交付。

恢复数据库保留历史用户/审核身份，但不继承旧登录。使用同一个终端API初始化流程创建新管理员；返回的 `restore-admin-<新UUID>` 是实际用户名，记录后再在普通登录页用新密码登录，不假设固定 `restore-admin`。

按 **Ctrl+C** 停止。启动器仅监听 loopback，管理 API 及其 Host 子进程树。Windows 使用受管根 PID 的 `taskkill /T /F`，SQLite WAL 崩溃一致性保证不会因强制退出产生半个事务；它不是“每个 AI 调用都已优雅结束”的保证。

更多操作见 [本地运维](operations.md)、[备份恢复](backup-restore.md) 和 [已知限制](known-limitations.md)。
