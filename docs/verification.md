# 测试、发布关卡与证据要求

供验收人员选择检查入口、记录失败和判断发布范围。先确定要证明哪一关，再执行对应命令；设计要求、工程证据、硬件测量和真实模型调用必须分开报告。

## 1. 关卡定义

| 关卡 | 必须完成 | 不允许的替代 |
|---|---|---|
| G0 环境与契约 | T00、T01；锁版本、测试 runner、WASM build、schema golden | 只有目录和 README |
| G1 人工闭环 | T15；导入→真 wgpu编辑→保存→刷新→独立导出回显 | Canvas2D mock、内存“保存” |
| G2 AI 工程闭环 | T25；run→候选→差异→接受/撤销→保存，协议失败路径 | 聊天框返回一段 JSON 但不进入命令系统 |
| G3 数据可信与可靠性 | T26..T30、T33；审核/快照/权限/恢复/包交付 | 只测正常 happy path |
| G4 真实能力 | T31、T32；目标设备 GPU + 各必需 provider/检测器实际验收 | 软件 GPU当硬件、fixture 当真模型 |
| G5 可发布报告 | T34、T35；完整检查、限制和实测证据 | 没凭证却全绿、声称已经提高30%效率 |

G1/G2 可以供内部继续开发，但不是所有模型已接入的发布声明。T32 必需 profiles 为 Claude 本人官方订阅/full Sonnet、OpenAI API/full Luna、MiMo image API、锁定 RT-DETR 四项。Codex 退役；Anthropic API 是补充路径，未 live 的 UI 明确标未验证。安全专题本轮 skipped_by_user/not_verified，仍属于完整发行缺项。

若账号权限实际不包含对应型号，显示完整 model_id/权限错误并标该验收 blocked；可独立出 limited preview，但不能把它称为完整 G5。

## 2. T00 必须实现的统一命令

根 package.json 的六个 verify 入口调用 `scripts/verify.mjs` 的实际子进程图，而不是固定 BLOCKED 占位。执行不等于通过：缺前置、零收集、全部 skipped、解析坏报表、源码在运行中改变和真实失败都保留非零结果。当前结果必须读本轮独立输出的 result.json，不能引用历史任务 done 推断当前 HEAD 全绿。

共同参数为 `--report-dir <项目内新目录>` 与 `--skip-security`；live/release 另支持 `--live-evidence <项目内证据目录>`。省略输出目录会生成唯一 run 目录；已有 result.json 不覆盖。默认不转发凭证环境、不检查账号、不安装工具。安全专题 skipped_by_user 时，工程子集与完整发行结论分开，`full_1_0_ready` 不得为 true。

```text
pnpm dev                       Vite + Rust API；关闭时清理子进程树
pnpm build                     contracts check + release WASM + native Web + single Rust product
weblabel serve                 启动已校验的 v2 发行，显式指定原 data-dir 与 port
weblabel doctor --mode runtime  只读核对预编译发行、容量/锁与可选 readiness，不要求 Node/Python
pnpm test:task T03              按 TASKS.json 精确运行本任务 checks；不存在/零匹配为失败
pnpm verify:fast                fmt/contracts/Web与全部活跃测试strict TS/实际Web Vitest；先构建原生API和WASM
pnpm verify:integration         完整Rust workspace、fresh API/WASM/v2发行，再跑真实临时DB集成
pnpm verify:browser             当前Playwright非付费端到端，记录native cases与实际adapter
pnpm verify:gpu                 当前API/正式WASM/hardware工作负载；缺设备/前置为blocked2
pnpm verify:live                默认四渠道session-free诊断；--live-evidence只离线聚合，不做模型调用
pnpm verify:release             执行上述全图、独立复构/doctor/真实同源Startup与G5证据检查；缺项非零
pnpm contracts:generate
pnpm contracts:check
```

scripts/task.mjs 读取 manifest 的 argv 数组调用进程，不通过拼接 shell string。Windows 的 pnpm wrapper 需用已解析的 Node CLI 入口或明确 shell 适配，不能假设 `.cmd` 可以按 POSIX 可执行文件运行。产品运行时仍严格禁止 shell:true。
Rust 工具链固定版本 `1.96.0`，由 rustup 选择本机 host，不能把 Windows target triple 写进跨平台 channel；安全专题是否执行仍由本轮授权决定。1301 项逐页范围回归保留全部选择与请求断言，仅为该长用例使用 15 秒独立测试期限，不能把此期限当作产品性能指标。

每个命令保存实际 argv/cwd、完整 stdout/stderr、native exit/signal、runner 结果及实际 collected/passed/failed/skipped/flaky（不可观察为 null），非测试命令 tests 为 null。取消后不启动下一阶段，先回收自有操作并落盘。原生 Startup 的物理键盘 0x03 正常停机必须真实退出 0，不沿用旧 Node 前门的 130 例外。缺工具/证据为 blocked2，实际失败为1，外层验证被 SIGINT/SIGTERM 取消保留130/143。

Startup截图必须等刷新后的实际WebGPU设备再次ready、backend为webgpu且adapter为hardware，并等待渲染帧；对象DOM出现、API回读成功或刷新前设备ready不替代刷新后的已绘制画面。回执分别记录刷新前后设备状态，保留先前捕获到loading的原始截图，不将其称为稳定画布证明。

WASM 构建缺固定工具时输出结构化前置诊断并退出2，实际编译失败仍为1；Playwright 实际失败不能变成缺前置。原生 doctor 保留 tools/release/capabilities 与 status/blockers：runtime 不要求编译工具，build 另查固定工具；已有无效发行/hash/配置优先 failed1。未知参数失败1。runner 只解析已登记描述符的结构化 prerequisite2，不把任意 exit2 洗成 blocked；浏览器成功仍要求真实报表与设备证据。

既有 `--skip-security` browser 排除列表按完整标题排除 `F11 two actual pages sharing head and lease have exactly one complete save and unsynced loser draft`，登记到 excluded_tests；非权限 task lineage 与 late ACK 保留。integration 既有列表排除 `F10/F11 concurrent real CAS plus transferred and expired lease reject without partial revisions`。本轮只用实际 Playwright `--list` 核对 F11 未调度，不运行该权限/lease race。
既有排除列表还包含 T33 packaging 的凭据碰撞/脱敏、不可变审核审计故障注入、带 origin 拒绝的混合启动和含秘密断言的 doctor 用例。正常包装缺前置、产物完整性、owned 子树退出和正常 WAL 备份/恢复不属于这些标题排除。生命周期由独立物理 Ctrl+C startup 证明，不以运行被排除安全断言替代。此前门禁误漏排这些标题的原始结果保留，不计为安全验收；失败凭据碰撞用例在 bootstrap 前中止，也不能计为专题验证。
这些标题排除不是完整安全专题排除：`cargo test --workspace` 和 Web 测试集中仍有安全相关用例，`scripts/release-smoke.mjs` 的 `exerciseRuntime` seed helper 也含未认证和跨源负控。用户要求跳过安全专题时，不得直接运行包含这些路径的完整 runner 或该 fixture；既有误执行如实记录，不作为安全验收。
安全跳过范围尚未完成拆分，因此 `verify.mjs fast|integration|browser|release --skip-security` 必须在启动任何子命令之前返回 blocked、退出 2 并记录 `SECURITY_SKIP_PARTITION_INCOMPLETE`；不能将被阻断写成通过。独立 GPU 或离线 live 的既有入口不受此 guard 影响。
`node scripts/verify.mjs nonsecurity-audited --skip-security --report-dir <项目内新目录>` 是显式的已审非安全子集：运行几何 `t03_geometry`、编辑内核 `t04_editor / t12_tools / commercial_relabel_projection`，以及 `t01_contracts` 中五个标注契约用例、`t14_formats` 中八个 COCO/YOLO 转换用例（均按完整名称精确选择）；Web 运行 `native-help-layout / native-attributes-escape / native-project-publication / delivery-plan / protocol / dialog / virtual-list` 七个指定测试文件。此前 `native-outcome` 和 `native-objects` 被误列入，实际引用含安全负载和撤销清理的共享 fixture；本轮及历史原结果保留，但这五项不计非安全验收，现已从入口移除。混合的 `t01_contracts` 和 `t14_formats` 不能整文件运行；实际用例名称见 runner。启动前核对已审测试、依赖源码及固定工具清单的指纹；新增或修改输入时先返回 `NONSECURITY_AUDIT_STALE`，不启动子命令，须重新审查后更新指纹。未审的其他非安全测试、安全专题、模型运行和 GPU 性能均不运行；即使子集通过，结果仍为 `blocked / NONSECURITY_PARTITION_INCOMPLETE`，不冒充完整门禁。
保留的早期单文件 smoke 曾执行 `native-outcome` 四项；U14 两次子集各执行上述五项；U36 的 `native-outcome` 定向文件也曾运行两次。这些共享 fixture 执行均属于范围偏差，不计非安全验收。修正入口后的一次 69 项子集通过，但随后 U26 焦点移动修复以及 U21、U22/U23、U45、U43、U39、U27、U31、U30、U12、U28 独立视图和紧凑队列源码改动未覆盖在该次子集中，不能把前次子集绑定到当前源码。
标注导入可将同一实际表单与预览移入共享原生 dialog：三种格式、固定目标和映射、只读投影、实际 loss 与确认同时可见；关闭后保留已生成预览及勾选，显式取消和完成提交继续遵守原有范围锁与未知请求保留规则。合成 COCO 在真实原生服务和硬件 WebGPU 工作台完成一次预览与一次明确确认；预览前后 head 未变，确认后新 revision 的 parent 与坐标经服务器数据库核对。1536×1024 的图片、两项 loss 和确认位于视口内，900×600 可滚动到确认；Tab/Esc 与画布恢复仅作局部检查。额外三对象、两类别合成预览中的标签、类别颜色和框在真实浏览器可见，明确取消不改变 head；101 个框/100 个文字标签的上限为定向 fixture 验证，不代表高密度性能验收。其余 U14 参考状态及完整 48 态未因此通过。
项目规范编辑器的枚举选项、数值范围和默认值直接显示在属性行，桌面提交操作保持可见，窄屏字段按列排列。一次真实原生服务的合成草稿在 1536×1024 同时显示四种类型与只读预览，并在 320×640 核对数值最小值与提交按钮可达、无横向滚动；明确创建后，数据库中的四种默认值、枚举选项和数值范围与输入一致，未产生标注 revision。此次仅覆盖该草稿与单次创建，不代表完整视觉矩阵或全设备验收。
有固定基线的规范发布结果未知时，保留输入并直接展示只读差异；版本切换和重新发布仍禁用。真实合成服务分别演练发布已提交但 201 响应丢失、以及收到 201 后版本读取失败：前者只读核对匹配版本仍不能认领或再发，后者按已确认版本 ID 只读核对后恢复操作；两次核对均未产生新 POST。两个定向行为回归通过；这不是全部视觉状态或安全专题验收。
帮助与休息视图复用原生 dialog 和既有暂停、提醒状态。真实合成工作台在 1536×1024 检查快捷键、上下文及控件同屏，六次 Tab、一次反向 Tab 与 Esc 保持焦点边界；暂停后关闭仍禁写，重新打开并恢复后画布解除 inert、矩形工具启用，原滚动和焦点归还。900×600 只检查提醒控件和关闭入口可达；45 分钟到期、固定任务上下文及完整视觉矩阵未在此次实测。
紧凑工作台复用原保存控制器，将状态、保存和完成操作集中排列；无目标确认仍是明确勾选，不改写保存协议。真实原生服务的合成两对象页面在 1024×768 同屏显示状态和 44px 主操作；删除这两个对象后，服务端空文档仍为原完成状态，仅选择“已确认无目标”未产生 PUT 或新 head，勾选并确认后才得到 parent 指向原 head 的 confirmed_negative 修订。1536×1024 的确认说明、勾选入口和按钮同屏；900×600 需要滚动，回读后保存与完成入口可达。未因此验证冲突/恢复布局、全部 U15/U24 状态、48 态或当前硬件性能。
紧凑布局的只读选择摘要复用实际 Native 选择、对象类别与本地锁定标志。真实合成工作台在 1024×768 核对单选、锁定、两对象多选以及摘要打开原属性抽屉；Esc 归还摘要按钮焦点并解除画布 inert，期间未产生 PUT 或新 head。1536×1024 隐藏紧凑摘要，900×600 的主操作仍需滚动；320×640 页面根宽度超过可见 clientWidth 15px，未通过无横向滚动检查。这不代表全部选择、权限或视觉状态已验。
紧凑图片与对象抽屉打开时，真实 WebGPU 背景保持选中对象轮廓但不绘制编辑手柄，关闭后原区域像素与打开前一致；选择、服务器 head 和 PUT 数不变。隐藏选中对象时其画布标签消失，显式恢复后仍可选择。另一次在抽屉开启期间销毁真实 GPUDevice 并观察到 destroyed、第二个 device 和 ready：重建后仍为 inert 无手柄，关闭抽屉后恢复手柄。设备 hook 仅观察并销毁真实设备，不替换 adapter；这不是全部 U25/U26 状态或硬件性能验收。
属性抽屉内的 Esc 在有未提交几何/属性输入时先取消该输入并保留抽屉；没有待取消内容时关闭抽屉并归还焦点。真实合成工作台分别检查空闲与未提交几何、非法几何和文本属性；移动焦点至几何按钮或干净文本字段后，未提交的几何仍先被取消，第二次 Esc 才关闭。取消前后服务器 head 不变且没有 PUT。原先空闲字段吞掉 Esc、移动焦点后未取消草稿的现象均有定向回归；此次不代表全部 U26、输入法或权限状态验收。
WebGPU 不可用时，中央诊断卡显示真实接口、渲染状态及只读说明；完整 code/message/request_id 保留在同一“GPU 诊断”展开区，其他工作台错误仍单独显示。实际禁用 GPU 的浏览器中 `navigator.gpu` 存在而 `requestAdapter()` 返回 null：1536×1024 的合成管理员页面可选择对象并查看禁用的几何/属性，画布 inert，鼠标和键盘均可展开原始诊断，返回项目不产生 PUT 或新 head。900×600 初版曾出现焦点落到卡内可滚动区域外，修正后实际焦点回到可见区域；正常硬件 WebGPU 的画布和诊断入口另行实测。此项未检查 viewer 角色、不代表完整 U21 或硬件性能验收。
设备丢失与恢复状态复用中央诊断卡，显示 CPU 文档和撤销历史，丢失时提供显式重试。实际合成离线草稿由 4px 编辑至 6px，真实 GPUDevice 被销毁；浏览器 hook 明确注入一次重建失败，再暂缓下一次真实设备返回以观察恢复中，未替换真实设备。失联与恢复中几何和撤销禁用，恢复后仍为 6px，一次真实撤销回到 4px；服务器 head 不变，一次离线 PUT 尝试以断网失败并保留未知原请求。初版诊断控件从卡片移回状态行时焦点落到 body，修正后键盘重试进入恢复及恢复完成均保留诊断焦点。这是局部故障注入与实际 GPU 设备检查，不等于完整 U22/U23 或性能验收。
硬件 GPU runner 的合成 bootstrap fixture 此前即使设置 `WEBLABEL_SKIP_SECURITY=1` 仍检查响应是否包含密码，属于误执行已跳过的安全专题断言，不能计为安全验收；修正后仅在未跳过安全时执行该检查，正常安全范围不变。此修正不使上述完整 runner 成为安全跳过模式。

根 Playwright 配置显式启动独占的 recovery origin（默认 `127.0.0.1:5191`，可用 `WEBLABEL_T30_ORIGIN` 指定独立 loopback 端口），供 T13/T30 使用；不得以用户已有服务替代。T25/T30 通过实际 `AI 审校` 按钮展开折叠面板后再输入，不修改产品默认折叠状态。T09-D 验证真实 Native 文档、canonical 几何、generation 与 undo/redo 在 hover 前后不变，保留真实 GPU idle/resize 验证；不再把合法初始化的累计 `get_snapshot` 次数当作 pointermove 违规，也不重钉实现计数。
单图新导出由同一 `EditorPort.canExport()` 约束父级 admission 与 `prepareExport()`：当前固定 LoadedAsset 的 Host 必须 ready 或真实 terminal-error，读取/初始化/恢复期间不能开始新导出。该条件不是写角色或 editableHost 门禁：只读服务端版本仍可导出；原产物显式下载、未知操作保留、损失确认与 stale-scope 围栏不变。切图卸载期间 GPU 诊断明确回到 idle/none，不沿用前一设备的 ready 标记。
T13 offline 双页场景既有 120s deadline 在 describe 配置时声明，覆盖 cold app/seed/login fixtures；显式恢复分支后等待实际替换 Host，再读当前 CPU 文档。T15 在选择固定规范及首次 Host 创建之前安装实际 mount observer；空 observer 数组不是 Native 初始化失败。真实 GPU 恢复造成 canvas inert 时保留焦点归还意图，仅在恢复可编辑且焦点仍为空 body 时归还画布，不抢走用户已移至控件的焦点。初始化、预算、48步几何 oracle 和性能阈值不变。
原生 AI 审校可逐次收窄图像、固定对象详情和 canonical 整数 crop；无效、非整数或越界范围阻止预览，不静默退回整图。授权确认使用共享原生 dialog 的大尺寸只读 SVG/固定版本视图，显示服务端实际 grants、完整 model_id、对象详情、有效期与未知费用；默认不勾选，不重用旧授权。Tab 在可用可见控件间循环；Esc 返回原触发器，1100↔1099 布局隐藏原触发器时返回 AI 启动按钮。native close 事件可能仍聚焦已不渲染的旧标题，不能仅以 body 判断焦点是否需要归还。授权范围变化清空旧预览和勾选；过期还由 run-controller 与服务端拒绝。该工程 smoke 仅使用本地合成数据和预览，不等于模型运行、外发或 live 验收，wire 仍为 v1。
U36 配置视图使用现有 AI 面板和共享原生 dialog，不复制运行控制器或编辑几何。实际合成两对象在真实硬件 WebGPU 画布中选中后，固定上下文只读 SVG 显示两个原轮廓，未配置 profile 的完整 model_id 与 `needs_configuration / not_run` 可见且运行范围按钮禁用；桌面 Tab/Escape、900×600 双层抽屉焦点恢复和返回后的画框/撤销已局部演练。未启动模型；已配置渠道的预览及运行态在此局部检查中未演练，不代表48态或完整发行通过。
U43 大视图复用原工时控件、真实运行状态和结果节点，只有项目、图片与规范均匹配时才显示当前运行；关闭返回原焦点与滚动，不创建新运行或自动上传。真实合成工作台核对默认关闭、焦点循环、Esc 与画布恢复；本地 loopback 合成协议产生的失败运行在页面明确显示 `failed`，只读摘要 GET 的候选数与未知费用来自实际服务端，切图后隐藏旧结果。两次合成运行共四个本地协议 POST，无真实或付费模型调用；仅覆盖局部 U43，成功运行与完整视觉矩阵未验收。
原生项目列表的成功空态、读取中、读取失败与403保留同一导航、四步指南和退出入口；空列表不自动打开创建表单。创建与提交都要求完整的最新列表基线，失败时隐藏缓存项目及其成员入口。已开始的新建草稿可在基线未知时查看，但不能提交；重新读取、返回列表及再次打开不清除名称、类别或指南。读取中的静态骨架对辅助技术隐藏，不冒充项目或百分比；只读重试完成后，仅在焦点仍丢失于 body 时归还重试按钮，不抢走用户的新焦点。创建入口禁用时，从保留草稿返回到仍可用的草稿入口或重新读取按钮。403 smoke 的网络故障仅针对 GET 列表，不冒充真实服务端权限撤销。
项目列表明确标示读取中、未知空态与读取失败，同时保留原始错误；四步指南、交付提示、列表表头和草稿入口保持在同一页。真实合成页面暂缓一次列表 GET 后中断该请求，再以另一次 GET 重试：读取中不显示项目行且静态骨架对辅助技术隐藏；失败时草稿可查看但不能提交，重试成功后原名称仍在，未发送 POST。键盘重试失败后焦点归还重试按钮；900×600 的实际 Tab 使按钮滚入视口且页面无横向溢出。该局部检查未执行 403 或权限撤销。
另在真实原生发行中使用没有项目成员关系的合成账户读取成功空列表：服务端返回 200，提示明确限定“当前没有可访问的项目”，不声称服务中没有其他项目；创建表单保持关闭，明确点击后打开，返回时焦点归还创建入口且未提交项目。1536×1024 和 900×600 的局部画面已查看，未复测 403 或权限撤销，不代表 U45 全态完成。
后续空态视图补上居中说明、空态创建按钮、列表下方创建入口和角色边界；三个入口复用同一创建流程与禁用条件。真实合成服务中，键盘打开空态及下方入口、返回原触发器，草稿在三个入口之间保留；一次列表 GET 被故意中断时空态隐藏、创建禁用，草稿可查看但不能提交，成功重新读取后保留原草稿，未发送项目 POST。900×600 下 Tab 可将下方入口滚入视口；403 仍按用户选择未复测。
项目列表正常态将四步指南、紧凑项目表和交付边界依次展示；空态仍在列表前显示警示并保留三个创建入口。当前原生发行与合成账户在 1536×1024 局部核对了四个项目和规范入口，900×600 核对了表格布局和操作尺寸；另以无项目成员关系的合成账户确认空态、创建入口、草稿和返回焦点。空态草稿检查未发送项目 POST；未复测 403 或完整 U05/U45。
原生会话恢复必须同时取得当前会话与非空的标签页 CSRF，不能仅凭仍有效的 Cookie 显示可写页面。缺少 CSRF 时复用既有只读诊断及本站 Cookie 的恢复说明，不放宽服务端校验、不自动重发初始化，也不清除项目数据或 IndexedDB。真实合成账户经正常登录可恢复 CSRF；账号创建丢 ACK 的控制在原生201提交之后仅丢弃响应，随后只 GET 核对、保留冻结输入，不把同名账户当作原写入收据或再发 POST。
项目成员表在中等宽度改为纵向排列；窄宽允许完整 user_id 和操作换行，不截短身份或扩大成员权限。新账户设置成功后进入项目成功空态，无需点击隐藏的编辑器返回按钮。真实原生发行的合成管理员在1280、900、757 CSSpx核对全部成员操作未横向裁切，并用 Enter 选择原 reviewer ID；757px 是 viewport 检查，不冒称 200% 缩放。
真实事件列表按服务端 seq、type 与 message 展示简短状态，原始 data 保留为可展开的技术详情，不把嵌套模型收据铺满窄检查器。合成 loopback SSE 的失败验证确认排队、开始、工具调用、终态失败、费用 unknown 与终态禁用取消；真实模型或付费验证仍未取得。provider 日志不得因折叠而删除，也不能将合成失败计为 live 验收。
终态事件之后仍可能到达 provider observation checkpoint：事件列表按 seq 全部保留，但运行摘要以已发生的 succeeded/failed/cancelled 终态为准，不能回退成 progress；同批含终态时完成原严格 after 游标后停止轮询。原生服务的合成 loopback 验证先真实复现 `cancelled → progress` 显示错误，再仅延迟一次真实 GET，在修复发行核对两条服务端事件、终态摘要和禁用取消；不伪造响应、不删除诊断或调用真实模型。
原生任务演练使用分离的合成管理员、标注者和审核者：真实 lease 领取、20秒续期、释放、固定版本提交及继续下一任务均经服务端确认。转交提交成功但响应被丢弃时只读核对，不重复写入；原请求和未知结果保持可见。独立审核批准原 revision 后，新 lease 下的后续编辑产生新 head，交付范围显示未经审批；旧固定页面仍读取原几何。这些局部截图不等于全部视觉状态已验收。
任务创建的图片或成员选择在刷新分页后仍保留；若当前已读分页尚未确认该选择，选项与创建按钮暂时禁用，并提示继续读取或重新选择。真实合成项目复现第二页图片刷新后丢失，修复后实际刷新和再次读取均返回 200，原图片、规范和成员不变；图片与成员分别由两项定向回归覆盖，真实服务的成员第二页未实测。未执行实际任务创建或完整 U29。
Windows 原生子树的回收不能仅凭 Job 活动计数为零或已退出的根进程句柄认定已观察到的子进程完成退出。终止前仅为当前 Job 成员获取可等待的原始进程对象句柄并核对归属；Job 本身仍是唯一终止授权。等待活动数归零、原根句柄及已观察子进程句柄发出退出信号，观察失败保持失败，现有五秒期限不放宽。新增后代与终止并发时仍以 Job 包含和计数保护；不能声称每个未观察到的后代均有单独句柄证明。
数据集范围表及冻结确认明细放在有名称、可键盘聚焦的独立滚动区，保留真实分页100项和逐行权限/划分选择；PageDown 可滚动，焦点到末行时必须实际可见。滚动容器不缩减冻结范围或绕过第二次显式确认。实测1536个已审批修订按 seed 17 形成1024/512两批，两个固定版本的 ID 集合与已选择范围完全一致；512项原生ZIP逐一独立核对 revision、原图、canonical 图和批准身份，wire 仍为 v1。
数据集范围读取过后续页，再重新读取第一页时，只检查当前游标与保留的祖先页是否形成回环；已浏览图片身份和跨页选择仍保留。真实合成项目以 100+1 项复现旧版误报分页无效；修复后两页、刷新和再次翻页均返回 200，摘要为已浏览101、排除1、范围外100，原排除选择仍在。明确开始新范围后计数归零；未发送 POST，一项定向回归先失败后通过。未复测完整 U32 或冻结导出。
数据集范围布局局部检查：1536×1024 的真实合成页面显示可用的 44px 计划预览按钮及并列行操作；900×600 页面本身无横向溢出，表格区域可键盘横向滚动，焦点可到操作列。另一已批准的合成图片实际生成一批、一项纳入的计划预览；未冻结或导出。该检查不代表完整 U32、全部状态或屏幕阅读器验收。
冻结确认表使用带列关联的表头，并展示每项资产修订及固定标注修订，避免同名文件身份不明。真实合成 1536 项按 1024/512 分批后，实际浏览全部 17 页：第一批 1024 条的资产、标注、规范、审批、决定及划分与已选择范围和计划一致；第二批 512 个资产身份与计划一致。切换批次先清除原确认，整个核对过程未发送写请求。最终构建仅调整窄屏列宽，另以一张已批准合成图片核对确认表与键盘横向滚动；未复测实际冻结导出或完整 U33。
数据集导出损失提示按实际 `annotation.*` 字段解释标签文件影响，同时保留服务端原始原因；复选框紧邻其文字，切换格式清除旧报告和同意。真实合成固定版本的 YOLO 返回 422 及两项损失，确认前按钮禁用；勾选后切换 COCO 清除同意，重新检查并明确同意后 COCO 返回 202，已有作业实际到达 succeeded。仅验证一份合成快照，不代表全部损失字段、下载或完整 U34 验收。
数据集已有作业的下载确认保存在对应作业，而非被页面重绘立即覆盖；只有签名、字节数及 SHA-256 校验通过后才显示“已发起下载”，不声称浏览器已保存。真实合成 Native 作业通过下载，浏览器落盘 ZIP 的字节数、SHA-256、CRC 和 manifest 固定版本与回执一致；只读重查及开始新范围后确认仍在，未发新写请求。仅覆盖一个成功作业，不代表完整 U35。
旧默认目录交接在项目内隔离旧工作树执行，旧启动器不传 `--data-dir`；迁移前核对其 canonical 数据目录和备份。旧浏览器保留的原 pending/journal 不在服务端备份内，必须显式选择分支后恢复；新原生服务沿用同源、旧身份与数据目录，只在用户明确重试时发送完全相同的 operation 和 payload。原分支保留，服务端 ACK 与新 fork 的本地提交分别确认；不能把这项合成数据证据写成真实业务数据迁移或授权跳过 lease/fencing。
响应式截图分别记录 viewport/DPR 模拟与真正的浏览器页面缩放，不能把 DPR 或 CSS 缩放冒充 200% 页面缩放。项目内隔离 Chrome profile 通过实际外观设置从 100% 切到 200%，关闭 device-metrics 覆盖，并在结束后恢复 100%；画布仍为 hardware WebGPU，原生抽屉的 Tab/Shift-Tab 保持内部、Esc 归还焦点并解除画布 inert。这些结果不替代输入法、设备丢失、对比度或全部视觉状态验收。
真实 hardware GPUDevice.destroy 的工程检查在本地有未同步编辑时进行：只拦截标注 PUT，实际 loss 为 destroyed，重新申请第二个设备后同页恢复 WebGPU；本地文档、代数及 undo 保留，画布前后 PNG 完全相同，一次 undo 回到服务器原文。设备观察仅向浏览器接收的原始发行模块前置 hook，不替换 adapter/device，磁盘发行与 CSP 不变。pointercancel、blur 和切图在真实拖动及 pointer capture 后验证无半框；IME 使用 Chrome 合成输入法组合并记录 trusted 事件，不冒充物理系统输入法。
`navigator.gpu` 存在不保证能取得 adapter：实际浏览器禁用 GPU 后 `requestAdapter()` 返回 null。`WEBGPU_UNAVAILABLE` 应归类为 unsupported，保留结构化 code/message/request_id 和原 GPU 诊断，不能显示 `[object Object]` 或伪装 Canvas2D；对象可只读选择，画布、几何、属性及编辑快捷键均不能写入。前后截图和单项回归分别保留，软件 GPU 不计硬件性能证明。
属性审校候选在窄检查器中只展开本次变更键的原值和建议值，完整对象与几何仍保留在可展开技术详情中；缺少键、null、false、空字符串必须分别显示，不能改写建议或绕过版本、拒绝状态与采纳确认。真实原生服务上的合成 loopback 属性建议分别拒绝一项、采纳另一项并撤销；每个实际决策与对应不可变 revision 核对，未调用真实模型或本地检测。
U40 的同图旧 generation 候选必须只读：单项、所选、本组及跨组拒绝与采纳均不可发起，原有选择保留；当前匹配范围的正常拒绝仍可用，未知拒绝仍保留原 operation 供只读核对。真实原生发行与硬件 WebGPU 上，本机合成协议先生成两项属性建议，勾选一项后改动完成状态使本地 generation 变化：旧版仍可拒绝，新版采纳和各拒绝入口均禁用，服务端 journal 没有该候选的决定。前后各两次 loopback 协议 POST，无真实模型或检测器调用；未检查异图、未知拒绝、跨组或完整 U40。
U41 的预设保存成功或只读核对确认同一配置后，当前选择立即显示“已配置相同哈希”并禁用重复保存；核对不证明原写入唯一归属。真实原生服务中两次使用合成预设，各让服务端真实 PUT 返回 200 后丢弃浏览器响应：旧版一次 GET 核对后仍误显示未配置且允许再次保存，修复版保留完整身份、未知期间冻结选择，仅以一次 GET 核对后显示已配置并禁用保存；每次均只有一次 PUT。定向回归先失败后通过；未调用模型、未运行用户跳过的安全负例，不代表完整 U41。

U39 展开对照使用同一候选控制器、单组只读 canonical 投影和原有选择及决策流程；重合原轮廓的虚线绘制在建议实线上方。真实合成服务和硬件 WebGPU 中，两项属性建议在 1536×1024 显示一张投影及两条差异；局部定位、返回主画布、900×600 双层抽屉焦点及 Escape 已局部检查。明确拒绝一项、采纳另一项、撤销后，服务器 journal 与 revision 链均已核对；三次局部合成运行共六个 loopback 协议 POST，没有真实或付费模型调用、没有检测器 forward。候选后的完整多组、全部参考状态、当前硬件性能和完整门禁仍未验收。

U27 的 AI 检查器将实际运行状态和取消入口置于配置之前，事件保留在可滚动区域；关闭或切换检查器不取消运行。真实合成工作台在 1024×768 显示状态及 44px 取消按钮，关闭后切换属性及 AI 仍为同一运行，明确取消后服务端显示 cancelled。前后共两次本地 loopback 协议 POST，没有真实模型、付费调用或检测器 forward；这不是完整 U27 或视觉矩阵验收。
U38 的运行进度大视图复用原运行状态、取消控件和事件节点，仅在当前项目、图片与规范匹配时开放。真实本地合成上游返回 500：真实运行按服务端顺序显示七条事件及 `upstream_5xx` 失败，终态禁用取消；运行中关闭大视图未发送取消，最终同一运行失败。桌面和 900×600 的关闭与焦点、桌面滚动恢复局部验证，失败后实际画框并撤销；三个合成运行各一次 loopback 上游请求，无真实或付费模型调用。该轮没有 tool_call，不代表完整 U38、48 态或当前 GPU 性能验收。
U37 预览实际服务端授权的 canonical crop 与固定对象：真实合成项目选中两对象，服务器返回的 crop 与请求一致，两个实线框逐坐标匹配固定 revision，裁剪边界以虚线显示。预览中授权复选框未勾选、开始按钮禁用；1536×1024 与 900×600 局部检查焦点和可达性，取消未产生 consent/run 请求。该次仅本地 preview，未连接模型；其他授权范围及完整 U37 未验收。

U31 固定版本页直接展示固定目标与父版本凭证、对象标签、变化字段前后值与选中对象只读属性；无父版本时明确不可比较。真实合成 revision 与其父版本在 1536×1024 显示一条属性变化及三处轮廓，切换版本和定位所读属性与原服务器版本一致，未发送写入请求；900×600 检查页面无横向溢出。另一合成根 revision 禁用基线切换并说明无父版本。仅覆盖这两个 revision，不代表完整 U31、48 态或当前 GPU 性能验收。

U30 审核差异大视图复用当前任务的固定 revision、只读投影、理由与批准/退回控件；退出保留未提交理由。真实合成标注者领取并提交后，独立合成审核者在 1536×1024 与 900×600 查看固定版本、输入理由并明确批准；服务端响应和数据库均绑定同一 revision，任务从队列移除后焦点回到待审核导航。首次实现中批准后焦点落到 body，修正后以另一真实合成任务复验。未演练退回、未知审核结果、完整 U30 或权限安全专题。

U12 空项目将同一媒体导入控件移到图片栏；未选文件的上传和未载入文档的完成操作保持禁用，不显示虚假的服务器确认。1536×1024 与 1024×768 在最终构建的真实合成页面局部检查；两次不同构建各明确上传一次合成 PNG，较后的 202 回执、作业和列表均显示成功，从紧凑抽屉切往导入面板保留同一控件及作业结果。最终构建额外核对了未载入文档时的确认未知文案，未重新上传。初版紧凑抽屉禁用文件选择、随后初版面板交接未关闭抽屉，均已修正；不代表完整 U12 或完整视觉矩阵验收。

U28 的“我的任务”和“待审核”复用同一队列控制器并打开独立视图，返回工作台不主动释放 lease。真实合成任务在初版领取、返回 WebGPU 工作区、提交固定 revision 并由独立审核者批准；修正焦点后的构建另行领取并明确释放另一任务。最终构建局部核对直接进入待审核后返回的焦点、导航状态及 900×600 布局；最终构建仅增加导航颜色，未重跑写入。首次直接路由返回焦点落到 body，已修正。分页、真实续期和完整 U28 参考表格未验收。

U28 紧凑队列用现有任务响应和已读取的项目上下文展示固定身份、状态、提交版本及租约；没有本人当前回执时显示未知，原操作待核对时不声称持有。较早构建的真实合成任务从未知、本人回执到固定版本提交并由独立审核者批准；管理员展开创建表单并折叠重开后输入保留，转交控件可展开但未执行转交。最终构建补充操作边界和完整审核理由显示，在 1536×1024 与 900×600 检查三条真实合成行及无根横向溢出；未重跑写入。真实续期、分页、全部队列状态和完整 48 态仍未验收。


R1 中 healthy ACK 本地回执屏障只阻断远端传输，不撤销当前合法 Native 编辑。Workbench 使用 SaveQueue.canAcceptEdits(asset, ontology) 判断本地 admission；已由 Native 提交的完整文档与 ordered journal 仍由 queue 保留，非 barrier paused/rescue 的既有内存政策不变。writes_paused、原 owner/scope guard、真实 receipt、write-token CAS、one-shot continuation 与 local_commit 保持 fail-closed；最新完整本地记录真正持久之前不得准备下一次 HTTP。真实回归在 pointerdown/up 之间释放实际服务端提交的旧 ACK，并保持物理 IndexedDB 回执 transaction，验证完整 canonical 文档、单次 undo/redo、精确新请求与 reload；48 步独立几何 oracle 的串行等待不能替代该时序证明。
原保存响应丢失时，若 pending 结果为 unknown 且请求已停止等待，工作台立即显示原操作结果未知，不能把网络错误当作服务端拒绝。原 ACK 确认后若有更晚的已持久化编辑，旧范围的自动续发仍受原 guard 约束；只有当前范围显式保存/完成动作、同一写入者和新的有效资格成立时，才可放弃已过期的继续发送 guard，并以原 ACK 的 revision 为 base 保存新编辑。未确认的 pending、尚未落盘的本地回执、一次性续发限制和 lease/fencing 均不绕过。
工作台资产列表、完成状态选择和只读分支比较使用同一组完成状态名称，不能将协议枚举直接显示给用户。重新打开后即使当前内存队列为 idle 或 synced，仍有未解决分支或旧库救援记录时，主保存状态须提示有待恢复或救援的本地草稿；已同步、已恢复或已留档的分支不误报。只改变显示，不自动选择、修改或重试原分支。

T31 的所属 Vite 由当前 Node 直接启动 `owned-vite-service.mjs`。正常收尾关闭所属 stdin pipe，等待真实 `server.close()` 与 native close，再观察独占 loopback listener 已关闭；不以 Windows `taskkill /T` 冒充正常关闭。超时或非零/signal/仍监听保持 failed；有界 forced backstop 仅用于回收，不洗绿。fast 登记真实 listener 的运行中 EOF 与启动中 EOF 两项回归。硬件 workload、2000/10000 数量、sample seed 与性能阈值不变；任何实测 P95 越界仍失败。
真实生命周期会多次重新加载同一 WASM：GPU 门禁要求至少一次实际加载，且每一次捕获的 SHA-256 都与本次发行构建完全相同；空列表、缺失或任意一次不一致均失败。第一次独占运行中两项 hardware 测试各实际捕获六次相同 hash，但外层错误地只接受单元素数组而失败，原结果与全部8000行保留；不得把重读该材料写成原命令通过，也不得改变样本、warmup、阈值或挑选性能结果。
随后固定阈值的独占GPU命令通过3/3、8000行；一次完整 release 中的GPU子关亦通过3/3。该完整 release 自身仍 failed：Rust workspace 有一项工作器等待超时、浏览器有一项旧隐藏返回按钮假设；后续API库103/103及定向浏览器通过不抹去失败，也不能证明超时根因。该次 `skipped_scope` 为空，live证据和完整 smoke/review 仍缺失；R10/R11与完整发布不因此通过。
最近一次针对工作台显示修复源码的真实硬件测量，2000 对象 `committed_edit` CPU P95 为 8.043 ms，超过未修改的 8 ms 门槛；旧源码的通过结果不能替代该失败。至用户作出该项豁免时，后续仅修改验证器与 fixture，未重新测量 GPU；之后 U36 工作台源码又已变化，当前 UI 的硬件性能仍未测量。独立诊断采样显示 IndexedDB 耐久写入为主要热点，但尚未证明其造成门槛失败，不为通过而删除或延迟耐久写。
用户明确跳过上述一次 2000 对象 `committed_edit` CPU P95 超标作为 R10 阻塞；该硬件结果仍为 failed，不能写成通过，原 8 ms 门槛、其他场景与授权范围均不改变。
用户随后选择保留 U16 的内嵌导出界面并跳过全页参考图差异，另跳过 U20 实际配额故障恢复复现；两项作为用户豁免，不计视觉通过或恢复通过。其他视觉状态、恢复要求及安全/live 授权边界未豁免。
release 的 release_gates 逐项列出 G0..G5 的 scope、实际 required_commands、SHA 绑定 evidence_refs、engineering_status 与完整 status。缺少命令为 not_started，缺少材料为 missing，不能从总状态或历史 commit 推导通过。G1/G3/G5 必须同时读取当前源码的 smoke；G5 还必须有独立完整规格/质量 review。smoke 的十三项场景只能引用同文件中已校验 SHA 的 artifacts；部分或损坏材料不能通过。

G3/G4/G5 在本轮安全 skipped_by_user 时完整 status 为 blocked，即使各自工程子集通过。G4 的 live 未授权/未实际验收同样阻断；G5 不声称已经完成商业30%效率试点。release 的 engineering_status 也检查实际 review/smoke，不能只看子命令退出码。执行失败优先 failed，其余任何必需 missing/blocked/skipped/not_verified 保持 blocked；只有六关及全部范围满足才允许 full_1_0_ready。

生成物改动检查要在临时目录重生成，不改工作树“掩盖差异”。CI 默认不安装/调用商业模型，不自动下载权重，测试网络对外默认阻断。依赖安装属于 bootstrap，不属于 verify 的隐藏副作用。

### 文档结构门禁

`pnpm docs:check`（即 `node tools/check-docs.mjs`）是只读结构检查；受控夹具可用唯一可选参数 `--root <目录>`。stdout 仅 JSON：`ok`、`scope=documentation_structure_only_not_product_verification`、实际 `files_checked`/`links_checked` 与按文件/行排序的 `errors`；通过退出 0，其余退出 1。检查本身不写文件、启动子进程或联网。

登记范围是五个根入口、全部 `docs/**/*.md`、三个 prompts 和 `reports/index.md`；六列目录必须逐项登记。出链再加入 TASKS 的 card，跳过 `docs/reference/` 的历史出链和 reports 全目录递归，但指向历史文件的本地目标与 Markdown 锚点仍须存在。解析真实 Markdown token，验证相对路径、URI 解码、中文/重复标题、显式 HTML id、图片非空 alt 和 realpath 根内边界；外链只分类，不验证其可访问性。规范与目录分别见[文档治理](documentation-policy.md)和[文档总入口](README.md)。

窄检查：

```text
node --test tools/check-docs.test.mjs tools/check-plan.test.mjs tests/bootstrap/verification.test.mjs
pnpm docs:check
node tools/check-plan.mjs
```

当前 fast 的 `fast-bootstrap` 收集文档边界用例，`fast-plan-structure` 后执行真实 `fast-docs`。当前 release 聚合的 G0 fastCore 与 G2/G5 完整 fast 都要求该步骤；文档未执行会 blocked，失败优先 failed。该增量不倒改旧报告或原任务 DAG。fast 模式不生成 release_gates；只读调用 `describeReleaseGates` 检视 fast 输出时，缺少 doctor/integration/GPU/live/acceptance 仍须阻断，不能声称 release 已运行。结构通过不证明接口示例、浏览器编辑、硬件、模型或安全通过。

## 3. 测试夹具与工具

T01 创建 tests/fixtures/golden/{ontology,media,document,save,prediction}.json 和 schema-invalid/；T07 创建程序化不对称方向图、EXIF1..8、伪MIME、超尺寸头和截断图片；T14 创建 yolo/coco/native 的合法及有损/恶意输入。夹具是测试数据，不伪装真实模型产物。

集成 TestApp 启动独立临时 SQLite 和 object store，随机未占用端口；从临时进程的 bootstrap 管道建立管理员 session，按真实认证创建 annotator/reviewer/viewer。禁止测试依赖个人数据库或端口48100。TestApp 的 HTTP 访问使用真实路由而非直调内部存储来冒充鉴权。

Vitest fixture API 在 tests/support/app.ts：`start_test_app():Promise<TestApp>`；TestApp 提供 `base_url`、`as_user(role):Promise<ApiClient>`、`stop():Promise<void>`；ApiClient 提供 `request(method,path,body?)`、`upload(path,bytes,filename)`，其返回 {status,json,headers}。T06/T10共同落地，T00 的职责限于注册测试环境，不允许返回固定成功响应。

## 4. 强制异常矩阵

| ID | 情况 | 预期 | 所属 |
|---|---|---|---|
| F01 | DPR1/1.25/2/3，鼠标中心缩放 | canonical坐标不变 | T03/T09/T12 |
| F02 | EXIF镜像、旋转后导出 | 图像和bbox对齐 | T07/T14/T15 |
| F03 | pointercancel/失焦/切图 | 取消预览，不生成半框 | T12 |
| F04 | IME输入、文本框Delete快捷键 | 不误删对象 | T12 |
| F05 | 空画布0×0恢复尺寸 | 不panic/invalid configure | T05/T09 |
| F06 | AI返回非法类别/NaN/超大数组 | 422或413，不进入正式文档 | T19/T25 |
| F07 | 切图后旧AI返回/运行乱序 | 归属原图，stale不可覆盖 | T24/T30 |
| F08 | 保存ACK晚于新编辑 | 保留dirty和后续保存 | T13 |
| F09 | 断网、DB超时、IndexedDB配额 | 分别显示失败，草稿可导出 | T13/T30 |
| F10 | 幂等重试、相同key不同payload | 同结果重放/409 | T11/T17 |
| F11 | 多标签页/租约过期 | CAS与fencing保护 | T26/T30 |
| F12 | 审核旧版后产生新版本 | 新版本不继承批准 | T26 |
| F13 | 导出中继续编辑 | 快照文件内容固定 | T27 |
| F14 | GPU device lost | CPU文档不丢，可重建 | T05/T30/T31 |
| F15 | 跨项目访问/下载/工具调用 | 403/404且不泄露内容 | T10/T21/T29 |
| F16 | 图片/标签内提示注入 | 不越权读文件/接受标注 | T21/T29 |
| F17 | CLI崩溃/超长行/取消子孙进程 | 确定失败、无孤儿、可继续人工编辑 | T16/T22/T23/T30 |
| F18 | ZIP路径穿越/重复文件/炸弹 | 拒绝、不写root外、不覆盖 | T14/T29 |
| F19 | 未确认空样本 | 不作为完成negative导出 | T14/T27 |
| F20 | 同名图片/Unicode路径/Windows长路径 | 用ID识别、明确长度失败 | T07/T14/T33 |
| F21 | 依赖/命令不存在/零测试匹配 | runner非零，不显示通过 | T00 |
| F22 | 暂存授权后内容或提供方改变 | consent失效，需要新批准 | T25/T29 |
| F23 | 模型费用未知/请求超时 | 显示unknown，不自动重复计费 | T17/T25/T32 |
| F24 | 新标签规范与旧文档混用 | 拒绝或显式迁移 | T10/T19 |

## 5. 渲染与性能验收

T05 必须有真正的 wgpu 资源/pipeline/提交和 WGSL；测试通过 image readback/截图辅助确认，不能只检查canvas元素存在。Native无GPU单测验证buffer布局/剔除，不冒充浏览器渲染。

Playwright chromium-webgpu 可以使用软件适配器验证功能，但报告 software=true，并且不得据此通过硬件性能验收。真实性能profile在Windows目标机器上运行，记录OS、CPU、GPU/driver、浏览器、wgpu/应用commit、viewport/DPR、样本seed。

默认不要求修改用户浏览器全局flags；无法获得GPU时记录blocked。

| 场景 | 初始目标，不是现成保证 |
|---|---|
| 2048×2048，2000个bbox，已加载，连续拖动/缩放 | 参考机器上95分位CPU编辑+提交≤8ms；pointer→下一可见帧95分位≤33ms |
| 10000个bbox压力场景 | 可操作，无全量DOM对象、无指针逐次全序列化；先报告实测，不设跨设备FPS承诺 |
| 稳态空闲10秒 | 无持续全量绘制；无变化时不重复GPU提交 |
| 切图100次/重复进入工作台 | live GPU资源计数回到稳定范围；不能线性泄漏 |
| 缩放/resize/DPR变化 | 控制点恒定屏幕尺寸、标注回显误差≤0.5CSS像素 |

测量方法：预热后固定动作脚本，逐场景收集不少于1000次有效样本；不把网络/冷加载混入已加载交互指标。内存用明确可测的JS heap与应用持有资源估算分别报告；不能称估算值为真实VRAM。GPU timestamp不可用时写不可用。

## 6. 真模型验收

每个必需 profile 单独记录 auth类型、完整model_id、CLI/SDK版本、官方来源核验日、输入哈希、响应ID（可脱敏）、图像能力、候选结构、非法动作防护、取消、额度失败、人工接受/撤销/保存。

检测器必须实际运行权重，检测输出经过 canonical坐标验证，不能仅用预存预测。属性审校至少使用一张能明确判断和一张遮挡/不确定样本，人工判读，不将模型自评作为正确答案。账号登录、外发真实数据和可能产生费用的调用由用户明确授权；默认仅程序化/已授权测试样本。

### 检测器运行与回执边界

- 产品检测器使用`weblabel detector-worker`与已固定CPU ONNX Runtime；运行不需要Python、torch、Transformers、Pillow或torchvision。`tools/detector-export`保留的Python环境仅用于开发导出与参考比较，不是产品fallback。
- 默认doctor不加载动态模型runtime或建立Session。只有经过真实授权、scope与文件hash校验的运行才可载入模型；metadata可见、配置存在或包已复制都不等于真实forward。
- RT-DETR v2从原生ORT的`boxes`与`logits`进入同一个canonical解码器；Python参考原始字段为`pred_boxes`，不使用不存在的`pred_logits`，不进行二次反缩放。
- 生产worker只在真实forward和解码完成后将execution receipt附在`succeeded.data`，记录锁定model_id、实际runtime/device与检测数量；本地`response_id`是run_id关联，不是外部供应商响应ID。synthetic进程/HTTP夹具不产生真实模型证明。
- 零检测也可以是实际执行成功，但不证明检测质量，也不完成候选接受/撤销/保存验收。`verification` 仍须保持未完整验收状态；缺少候选时不得降低锁定阈值、注入候选或把空文档标成 negative 来凑闭环。
- 2026-10-09 授权实测见 `reports/T32/detector-live-2026-10-09/`：五次请求额度全部使用，最后遮挡图完成 CPU forward/300 queries、零检测。清晰图最终仍有失败记录，双图成功/候选闭环/取消和完整 T32/G4 未通过。
- R05唯一账本已耗尽20/20；六普通图、五同tensor实际来源及11路保留输出的生产Rust解码重放分别绑定。叶文件symlink负控、严格raw logits门槛和独立旋转tensor路径为用户明确豁免，不记为通过，不为R09/R10追加forward、warmup、导出或新账本。原始失败及[公开接受结果](../reports/publication/r05-accepted.json)保留；不升级检测质量、产品采纳闭环或T32/G4。

无商业密钥时 fast/integration 的非安全工程子集可以通过；live 默认和缺完整离线证据时返回blocked2。实际采集必须另行运行 `node scripts/verify-live.mjs --run --config <公开配置.json> --report-dir <新目录>` 并经用户对账号、外发图像、调用预算与费用的明确授权；本轮没有该授权，也不执行采集。`--prepare-inputs` 只生成本地PNG，不是真模型结果。当前四渠道的完整clear/occluded、回执、Native差异、人工判读、接受/撤销保存及错误路径证据均未补齐，T32/T35仍不可通过。

## 7. 质量与商业效果

T34只实现测量工具，不能生成“节省30%”的虚假实测结论。对照组必须包括现有工具+相同AI能力；记录标注、修正、审核、切换、模型等待、错误/漏标和费用。任务窗口失焦/长时间闲置不计作有效操作时长；禁止后台跟踪与未经同意上传遥测。

真实试点采用有独立人工审核的样本；明确统计单位是图片/对象/任务和样本量。同等质量下总人工时间降低30%是建议试点目标，不是软件发布关卡的事实陈述。

## 8. 报告文件

每个任务至少 reports/Txx/result.json、tests.log、review.md；需要视觉的任务另有 screenshots/ 与 traces/；真实敏感媒体不进入Git，使用脱敏截图/哈希。最终 reports/release.json 包含各关卡 pass/fail/blocked、版本矩阵、已知限制、实际启动命令和剩余动作。

计划结构检查只能证明任务图、文件引用与 JSON 结构符合要求。产品是否完成，要看实际运行结果；已实现的部分和仍 blocked 的关卡分别列出，不能用计划完整性替代产品验收。
