# 已知限制与验证边界

**历史证据边界：** 本页的私有归档路径仅记录原始验收来源，不随公开仓库分发，也不代表在当前公开提交重新验证。

读者：本地操作者与发布负责人。读后行动：根据限制选择人工、团队或 AI 流程，并区分源码能力与实际验证。Windows x64 交付的是可重复源码构建加本地启动，不是签名 exe、安装器、公网服务或完整 G4 认证。本轮仅文档结构检查，不是重新验收产品。

## 核心与运行边界

- 默认仅 loopback；没有 LAN/公网受支持部署、多租户订阅代理、SSO、在线自助找回或远程运维组件。有本机启动权限的操作者可按[管理员密码恢复](operations.md#管理员密码恢复)进入一次性维护，保留原身份；不是远程登录绕过。
- 只做静态 PNG/JPEG、bbox 和属性。文件 ≤64 MiB、单边 ≤4096、总像素 ≤16,777,216；无视频、Mask/Polygon、大图瓦片、移动端或 CRDT。
- 人工编辑无需 Python/官方 CLI/登录模型账号，但需要真实 WebGPU device。无 WebGPU 只读/诊断，不伪造 Canvas2D 降级。
- GPU logical bytes 与实际 VRAM 不等同；源码/自动化通过不替代目标机器性能验收。T31 的正式测量独立报告，T33 不给 G4/GPU 阈值结论。
- Windows 停机按受管 PID 树强制结束，SQLite WAL 保证事务原子恢复；不声称收费模型取消已经获得远端终态，费用未知必须保留。
- T33已实际验证核心API/Web与活跃configured Host的物理Ctrl+C：独立owned ConPTY内真实keyboard 0x03及direct API控制事件，Host root和detach后忽略SIGINT的descendant在API终止时已退出，端口/锁/SQLite完整性均核对；凭证、策略、preview/consent/START及run-token授权为真实API路径。Host响应为明确synthetic NDJSON工程fixture，不证明官方账号、provider推理、收费取消或G4。
- 没有自动 GC。磁盘不足时保留错误/草稿，不自动删除历史或用户数据。
- 备份不包含未同步浏览器草稿，不加密/签名；只支持当前精确 schema，拒绝已有恢复目标。认证清空后使用新的本地身份，而非复制旧 session。
- C06–C10 的实际验收覆盖固定任务创建屏障、原请求幂等重放、每次真实 ACK 后的最新 IDB 提交屏障、foreign-author 只读保全、Native Undo/Redo，以及不支持 schema 与目录读取失败时的完整 raw 救援。缺可信作者的旧记录不会借当前账户取得写权限。原 C5 已拒绝请求的旧账号未恢复；该入口仅有消费者测试与源码审查，不能写成旧账号真实通过。跨 tab 写入协调仍未实现。
- paused恢复需显式singleflight原请求确认，保留原operation/body/base/lease/journal；真实ACK与最新记录IDB complete且scope仍current之前保持编辑屏障，generic flush/timer不能解锁。fresh明确lease拒绝仅允许核对实际同一固定任务/资产/规范、Native/context并精准领取后明确reprepare新operation；historical unknown不能替换原payload。跨tab冲突仍未解决。 旧成功原请求回执可与当前新操作 lease 资格分离核对；没有 fixed lease 时允许原回执及最新本地记录的受限确认，不允许继续编辑、创建下一操作或把 partial ACK 说成全量同步。
- 无待处理的无主只读快照只作折叠留档；本地同步标记不是独立服务器 ACK 证明，不用于原作者认领、恢复、merge 或写授权。原始记录保留；未知请求、错误、暂停和坏结构不能归入该展示分类。
- 构建使用固定 Rust release 与 wasm-bindgen；不依赖旧 wasm-opt 的优化成功，也不宣称二进制位级重现或每种 OS 已验证。
- 普通入口按项目 tasks 完整分页、asset-wide 核对编辑资格；已关联任务（含关闭、其他作者或规范）保持只读，需明确新任务/领取。列表读取是时点快照而非分配事务锁；后来新增任务仍可能被服务端拒绝，原请求与草稿必须保留，不能自动换 lease/operation 或重放。
- AI 结果的任务关联仅证明决策保存的精确revision被某submission提交，不证明模型导致审核结果；自愿run/task工时由用户明确选择、本人显式发布。旧区间无绑定ID不可追溯归因，后继revision不能冒充精确绑定，未记录不填零。
## 模型事实矩阵

当前活动四必需渠道为 claude_local、openai_api、mimo_api、detector_local；anthropic_api 为可选，codex_local 已退役。下列旧“五渠道检查”只描述原 T32 的历史参与者数量，不是当前活动渠道清单。

来源为已提交的 T32 result（私有归档：`reports/T32/result.json`） 与 registered closure（私有归档：`reports/T32/main-final-registered-closure.log`）。该次注册命令退出 **2**：35 项工程 consumer 测试通过，0 failed/skip；**五个 live 渠道 blocked**，外发模型调用 0、worker probe 未运行。

这些数字只描述该次记录，不概括之后的授权尝试。后续证据字段 consumer 窄检查 35 项退出 0，不解除 live 阻塞。

| 渠道 | 已有源码/工程证据 | 真实支持状态 / 缺失前提 |
|---|---|---|
| codex_local（历史身份） | 原工程报告冻结；当前删除活动适配器/选择与执行入口 | **retired**；仅历史解码/查询/原幂等回放，不安装或接入 CLI，不自动替代模型 |
| claude_local | 官方 headless/受限 MCP 与工程合约 | **blocked**；官方订阅登录、完整 Sonnet 型号、固定支持 runtime 协议及图像/预算授权 |
| openai_api（Luna 候选） | 实际 loopback API/Host/TCP 工程 receipt 持久化与授权链 | **blocked**；用户授权账户/key reference、当前官方完整 Luna 型号/端点验证、明确费用/图像预算 |
| mimo_api | 独立 SSE receipt/工具与错误工程路径 | **blocked**；用户授权账户/key reference、当前完整多模态型号/端点、明确费用/图像预算 |
| detector_local | worker 路径/权重锁定/预算/坐标工程实现 | **blocked**；该次 T32 记录未下载权重，要求固定公开权重/runtime/label mapping、真实 load+forward 和两张合成图人审。2026-10-09 后续授权尝试的有限结果见 verification.md：CPU forward/300 queries、零检测不等于完整闭环通过 |
| anthropic_api | API adapter 源码与工程验证；当前可选，非四必需渠道替代品 | **未宣称 live_passed**；不能用 API 替代 Claude 订阅/Sonnet 关卡 |

持久 profile、公开投影、私有 Host 配置、项目策略与逐次 preview/consent 是独立层。平台管理员已有固定预设 GUI 与 GET/PUT 配置 API，只选择本机操作者准备的预设，不接受自定义秘密、路径或启动命令；单设 WEBLABEL_HOST_CONFIG 不自动创建持久 profile。保存为 not_run，不登录、不下载权重、不调用模型，也不授予 live_passed。空库仍可人工编辑。当前接口见[API参考](api-reference.md)。

判断支持状态时，不从登录成功推断全部模型可用，不把请求的 model_id 当实际响应型号，也不把 mock candidate 当 live 证据。上游未暴露 runtime 版本时是 null/not_exposed，费用未知仍为 null/unknown。T32 receipt 来自合成 loopback 工程服务，不能据此认定官方付费端点/账户通过。

Codex 已退役，旧 profile 的新 preview/start 为 `PROVIDER_RETIRED`；退役不是解除原真实证据缺项。当前四必需渠道仍 blocked。doctor 不检查账户登录、不探测权重、不调用模型。T33 不以替代模型、全局安全配置修改、跳过门槛或静态 JSON 解除 blocked。

当前已提供 GUI 账号/成员管理、固定 revision 只读页、逐项拒绝 journal、提交后只读核对与继续下一任务、显式整组 seed 分批。它们不放宽权限/CAS/lease，不保证任意规模：每批纳入加排除最多 1024 项，真实 ZIP 仍有 96 MiB 预算；冻结成功不保证导出成功。拒绝不是只能整 set reject，已接受项仍须先保存撤销。

仓库仍为 UNLICENSED，不据工程预览宣称商业授权。无 Mask、视频、云端支持；没有真实生产无损升级/回滚承诺，备份恢复必须按精确 schema 与现行工具限制核实。T35 发布评审需综合实际证据；真实模型/账号 G4 未满足，只能交付明确范围的工程预览，不能宣称完整发布。
