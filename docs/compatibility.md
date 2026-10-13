<a id="compatibility-current-runtime-pin-and-t00-evidence"></a>
# 兼容性：当前工具版本与历史证据

供操作者选择构建工具，也供维护者区分环境检查、产品运行和性能验收。先按当前 pin 操作，再看对应日期和源码版本的证据；不要把历史结果改记为新版本实测。

<a id="current-local-runtime-pin"></a>
## Current local runtime pin

当前精确版本是 Node.js **24.16.0**、pnpm **10.34.5**、Rust **1.96.0**、wasm-bindgen CLI **0.2.128**、wasm-pack **0.15.0**。构建、启动、doctor、备份和恢复前，按[当前终端选择 Node](getting-started.md#当前终端选择-node)设置当前进程。全局 Node 和配置保持不变。

旧 Node 24.15.0 发行的 manifest 不匹配当前 pin。保留旧目录和清单，用新目录构建，不能手改旧 manifest。

### Node 24.16.0 的身份验证

[官方 runtime 回执](../reports/T31/node-runtime-migration/official-runtime-verification.json)记录 Windows x64 独立 ZIP 与官方 HTTPS SHA256 清单一致、解压后的 executable hash、Valid OpenJS Authenticode，以及实际 Node `v24.16.0` / libuv `1.52.1` 探针；全局 Node 仍为 24.15.0。

这份回执没有证明 PGP release-key 校验、24.16.0 下的浏览器/GPU 或备份恢复验收，也没有确认本地 worker 崩溃的根因已经修复。工具身份与产品验收是两件事。

### 对应源码的产品运行

在应用源码 `256e105b4cb0c5977f7bbc422a3f5ea35c4e1666` 上，主会话随后运行相关 consumer：39 项通过，其中 10 项 runtime 单测过滤了 12 项无关测试；另运行新的不可变发行构建/doctor、注册 T33（16 项通过），以及正式产品中硬件 WebGPU 的画框、Delete、Undo、Redo。完整 API 与完成事务的 IDB 记录均留存。

环境和手势执行的归因限制见[产品证据及独立审查](../reports/T31/node-runtime-migration/independent-product-evidence-review.json)。原样 8000-row 硬件尝试为 2 项通过、1 项失败：2k committed-edit CPU P95 **8.791 ms > 8 ms**。[该次失败](../reports/T31/runs/2026-10-07T04-29-50.974Z/result.json)仍须保留，不能由构建或单测覆盖。没有放宽阈值、计时方法、数量、场景、重试或 JIT 设置。

### 标签投影后的目标机器结果

只读 native CSS-label projection 变更提交为 `d156ffbe636881b91ab690aca620cbf639c613a5`。主会话验证 25 项受影响/生命周期 consumer、strict types、新的不可变构建/doctor，并在[正式产品硬件 WebGPU](../reports/T31/label-projection/main-fresh-production-ui.json)操作标签平移、缩放、选择、隐藏、显示及资产替换；画框、Delete、Undo、Redo 也有完整 API 和完成事务的 IDB 记录。

未修改的原始 full8000 工作负载随后为 **3 passed、0 failed、0 skipped、0 flaky**。2000 框 committed-edit CPU P95 **7.808 ms <= 8 ms**，scheduling-proxy P95 **16.4 ms <= 33 ms**。10000 框 CPU **28.336 ms** 只是补充压力数据，不是 8 ms 认证。

[独立执行的审查](../reports/T31/label-projection/independent-main-passing-closure-review.json)检查源码、产品、全部 8000 行、生命周期和 4012 个原始/脱敏 ZIP 成员，未留下未解决问题。闭合后主会话只移除自己创建的三个被忽略 raw-auth review 别名。

这个结果接受的是目标机器上一轮接近门槛的 T31 观测，不证明重复性、因果提速、Node 崩溃根因、整体 G4、T32 模型渠道或 T35 发布。先前 **8.791 / 8.569 / crash** 失败仍是证据。全局 JSXDEV 样本和重叠的 CanvasView 包含祖先成本，不能归给 100 个标签，也不能直接从 P95 扣除；原 profile 没记录标签数量。见[归因修正](../reports/T31/committed-profile/main-react-attribution-correction.json)。

<a id="t00-historical-matrix--2026-09-25"></a>
## T00 historical matrix — 2026-09-25

下表只记录 2026-09-25 在这台机器查询或运行的工具链和构建检查，不代表产品或 GPU 验收。后来的硬件结果见上文，不能倒写进这份历史矩阵。

| 组件 | 当时固定值 | 证据与限制 |
|---|---|---|
| OS target | Windows x64, MSVC | 已安装 Rust target `x86_64-pc-windows-msvc`。 |
| Node.js | 24.15.0 | T00 时写入 .node-version、package.json engines 和 CI；不是当前 pin。 |
| pnpm | 10.34.5 | 精确 stable v10，Node engine >=18.12，在 Node 24.15.0 验证。用 `pnpm run doctor` 调用项目脚本；直接 `pnpm doctor` 是 pnpm 12 保留命令，pnpm 10 下也不分派本项目脚本。 |
| Rust | 1.96.0 (x86_64-pc-windows-msvc) | rustc --version，已安装并固定在 rust-toolchain.toml。 |
| Rust WASM target | wasm32-unknown-unknown | 已为固定工具链安装。 |
| wgpu | 30.0.1 | renderer-wgpu/Cargo.toml 的精确依赖，须另验 WASM 编译。 |
| wasm-pack | 0.15.0 | 浏览器 probe build 检查精确 CLI 版本。 |
| wasm-bindgen CLI | 0.2.128 | probe build 检查版本，与 Rust 依赖匹配。 |
| Browser / GPU | Playwright Chromium 153.0.8010.12 | 当时启用 WebGPU、选择 SwiftShader 请求 adapter/device，但 Chromium 没有适配器。pnpm test:e2e 只通过明确 blocked 诊断；pnpm test:gpu:software 因无 device 正确失败。没有硬件或软件 GPU 验收。 |
| OMP | 18.3.0 | omp --version；omp config list --json 显示 task.isolation.enabled=true、backend=auto、apply=true、merge=patch、concurrency=4、recursion depth=1。当时项目 .omp/config.yml 对应这些默认值。 |

T00 只新增开发测试工具 Vitest **5.0.1** 和 Playwright **1.63.0**，不是产品运行依赖。Node stdio 测试只跑 bootstrap probe，不是生产 Agent Host/provider。浏览器 fixture 调用 wasm-bindgen 导出的 WebGPU adapter/device initializer。

当时开发 WASM 使用 wasm-pack `--dev`：初次 release build 的 wasm-opt 拒绝 Rust bulk-memory opcodes，因此该记录不声称优化构建或性能通过。pnpm-lock.yaml 与 Cargo.lock 由精确 manifest 生成。当时机器无浏览器 adapter，软件 device CI 未验证、硬件验收 blocked；这些是当时的状态，不覆盖上文后续记录。
