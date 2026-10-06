# 本地开始使用

面向 Windows 本机操作者：从源代码构建、启动并使用人工标注。不需要 Python、模型权重、API key、Codex/Claude 或订阅登录。AI 是单独配置和授权的可选功能。

## 前提

- Windows x64，桌面 Chrome/Edge，真实可用的 WebGPU device。无 WebGPU 时只能使用诊断/只读入口，不能用 Canvas2D 冒充编辑。
- Node **24.15.0**、pnpm **10.34.5**、Rust **1.96.0**（MSVC 工具链与 Windows C++ Build Tools）、Rust 的 `wasm32-unknown-unknown` target。
- wasm-bindgen CLI **0.2.128**、wasm-pack **0.15.0**。不要使用 `latest` 或浮动 `stable` 替代这些固定版本。
- 首次获取锁定依赖需要网络；构建不会登录账号、调用收费模型或下载模型权重。源发行没有签名 exe、安装器或跨 OS 安装承诺。

## 构建与启动

在仓库根目录的终端运行：

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm start:local
```

根命令由 T33 integration patch 注册；等价的直接入口是：

```powershell
node scripts/build.mjs
node scripts/start-local.mjs
```

默认发行目录是 `target/local-release`，默认数据目录是 `data`。重复构建**拒绝已有发行目录**，以免旧产物混入新发行。选择新的目录：

```powershell
node scripts/build.mjs --build-dir "target/本地 release 2026-10-06"
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

## 首次登录与人工标注

1. 打开终端显示的 `WEBLABEL_LOCAL_URL`，默认 `http://127.0.0.1:48100`。不使用公网地址。
2. 空数据库第一次启动会在本地终端显示一次性 `WEBLABEL_BOOTSTRAP_CODE`。在登录页输入此码并设置 **12–1024 字节**密码；代码有效 10 分钟，仅能成功兑换一次，不放 URL 或日志。
3. 普通新库用户名是 `local-admin`。记录你设置的密码；本版本没有公网注册、密码找回或 SSO。
4. 新建项目并发布类别/属性规范；导入静态 PNG/JPEG，等待后台媒体作业完成。
5. 打开资产工作台。WebGPU 必须显示真正 ready 才可编辑。框选工具画框、选择/修改类别和属性；一次拖动一个 undo。等待远端保存确认，不把“已保存本地”当远端 ACK。
6. 审核绑定已保存不可变 revision。冻结数据集指定 train/val/test，快照导出不跟随最新 head。YOLO/COCO 属性信息损失需要明确确认；原生包用于无损交付。

恢复的数据库会保留历史用户/审核身份，但不会继承旧登录。使用相同启动码/新密码界面创建新管理员；其 **`restore-admin-<新 UUID>`** 用户名由服务返回并显示，记录实际返回的名字以便下次密码登录，不假设固定 `restore-admin`。

按 **Ctrl+C** 停止。启动器仅监听 loopback，管理 API 及其 Host 子进程树。Windows 使用受管根 PID 的 `taskkill /T /F`，SQLite WAL 崩溃一致性保证不会因强制退出产生半个事务；它不是“每个 AI 调用都已优雅结束”的保证。

更多操作见 [本地运维](operations.md)、[备份恢复](backup-restore.md) 和 [已知限制](known-limitations.md)。
