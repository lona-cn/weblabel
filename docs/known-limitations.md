# 已知限制与验证边界

本次是 Windows x64 **可重复源码构建 + 本地启动**，不是签名 exe、安装器、公网服务或完整 G4 发布认证。打包成功与真实模型支持是两回事。

## 核心与运行边界

- 默认仅 loopback；没有 LAN/公网受支持部署、多租户订阅代理、SSO、密码找回、远程运维组件。
- 只做静态 PNG/JPEG、bbox 和属性。文件 ≤64 MiB、单边 ≤4096、总像素 ≤16,777,216；无视频、Mask/Polygon、大图瓦片、移动端或 CRDT。
- 人工编辑无需 Python/官方 CLI/登录模型账号，但需要真实 WebGPU device。无 WebGPU 只读/诊断，不伪造 Canvas2D 降级。
- GPU logical bytes 与实际 VRAM 不等同；源码/自动化通过不替代目标机器性能验收。T31 的正式测量独立报告，T33 不给 G4/GPU 阈值结论。
- Windows 停机按受管 PID 树强制结束，SQLite WAL 保证事务原子恢复；不声称收费模型取消已经获得远端终态，费用未知必须保留。
- T33 已实际验证核心 API/Web 的物理 Ctrl+C 和独立嵌套进程树清理；活跃 Host 的物理信号还涉及 API `RuntimeLease` 提前退出竞态，主 Agent 的最终共享 shutdown 修复/重建/重放尚是集成前置条件。本报告不把无 Host 的测试推断成活跃 Host 已验收。
- 没有自动 GC。磁盘不足时保留错误/草稿，不自动删除历史或用户数据。
- 备份不包含未同步浏览器草稿，不加密/签名；只支持当前精确 schema，拒绝已有恢复目标。认证清空后使用新的本地身份，而非复制旧 session。
- 构建使用固定 Rust release 与 wasm-bindgen；不依赖旧 wasm-opt 的优化成功，也不宣称二进制位级重现或每种 OS 已验证。

## 模型事实矩阵

来源为已提交的 [T32 result](../reports/T32/result.json) 与 [registered closure](../reports/T32/main-final-registered-closure.log)。实际注册命令退出 **2**，35 项工程 consumer 测试通过、0 failed/skip，**五个 live 渠道 blocked**，外发模型调用 0、worker probe 未运行。后续证据字段 consumer 窄检查 35 项退出 0，不解除 live 阻塞。

| 渠道 | 已有源码/工程证据 | 真实支持状态 / 缺失前提 |
|---|---|---|
| codex_local | 官方协议适配、拒绝不受支持边界的工程实现 | **blocked**；固定官方 runtime 内建工具/文件边界实证、用户本人登录、完整授权型号及图像/预算授权 |
| claude_local | 官方 headless/受限 MCP 与工程合约 | **blocked**；官方订阅登录、完整 Sonnet 型号、固定支持 runtime 协议及图像/预算授权 |
| openai_api（Luna 候选） | 实际 loopback API/Host/TCP 工程 receipt 持久化与授权链 | **blocked**；用户授权账户/key reference、当前官方完整 Luna 型号/端点验证、明确费用/图像预算 |
| mimo_api | 独立 SSE receipt/工具与错误工程路径 | **blocked**；用户授权账户/key reference、当前完整多模态型号/端点、明确费用/图像预算 |
| detector_local | worker 路径/权重锁定/预算/坐标工程实现 | **blocked**；操作者提供公开固定权重/runtime/label mapping、真实 load+forward、两张合成图人审；未下载权重 |
| anthropic_api | API adapter 源码与工程验证，非上述五渠道替代品 | **未宣称 live_passed**；不能用 API 替代 Claude 订阅/Sonnet 关卡 |

不存在“已登录所以支持所有模型”“请求配置 model_id 等于实际响应型号”或“mock candidate 等于 live”的结论。上游未暴露 runtime 版本时是 null/not_exposed，费用未知仍为 null/unknown。T32 receipt 来自合成 loopback 工程服务，不能据此认定官方付费端点/账户通过。

Codex 生产仍保持 `UNSUPPORTED_RUNTIME`，直到正式固定版本的边界实证完成。doctor 不检查账户登录、不探测权重、不调用模型。T33 不会以替代模型、全局安全配置修改、跳过门槛或静态 JSON 解除 blocked。

正式发布结论由主 Agent 在 T35 综合证据决定；G4 不满足时只能交付明确受限的工程预览。
