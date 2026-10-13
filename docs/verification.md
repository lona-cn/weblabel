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
pnpm build                     contracts check + WASM + Web + Node Host + Rust release
pnpm start:local               启动已构建的本地版本，缺构建即报错
pnpm run doctor                只读检查工具、WebGPU诊断入口、运行时/权重状态；不打印凭证
pnpm test:task T03              按 TASKS.json 精确运行本任务 checks；不存在/零匹配为失败
pnpm verify:fast                fmt/contracts/三组strict TS/Node/实际Web+Host Vitest；先新建WASM与Host
pnpm verify:integration         显式Rust targets与fresh API/Host/WASM/发行，再跑真实临时DB集成
pnpm verify:browser             当前Playwright非付费端到端，记录native cases与实际adapter
pnpm verify:gpu                 当前API/正式WASM/hardware工作负载；缺设备/前置为blocked2
pnpm verify:live                默认四渠道session-free诊断；--live-evidence只离线聚合，不做模型调用
pnpm verify:release             执行上述全图、独立复构/doctor/真实同源Startup与G5证据检查；缺项非零
pnpm contracts:generate
pnpm contracts:check
pnpm demo:seed                  只生成程序化测试图片与示例项目，不下载私人/未知许可图片
```

scripts/task.mjs 读取 manifest 的 argv 数组调用进程，不通过拼接 shell string。Windows 的 pnpm wrapper 需用已解析的 Node CLI 入口或明确 shell 适配，不能假设 `.cmd` 可以按 POSIX 可执行文件运行。产品运行时仍严格禁止 shell:true。

每个命令保存实际 argv/cwd、完整 stdout/stderr、native exit/signal、归一化 runner 结果及原生收集/通过/失败/skipped/flaky（无法观察为 null），非测试命令的 tests 为 null；不得编造全零统计。gate 全生命周期取消后不再启动下一阶段，先回收所属操作并落盘。正常 Startup 的物理键盘130是登记过的例外，不把任意非零命令当成功。缺工具/证据为blocked2，执行/解析失败为1，SIGINT/SIGTERM取消为130/143。

`build-web-bridge.mjs` 与 `build-wgpu-probe.mjs` 缺少锁定版本的 wasm-pack/wasm-bindgen 时输出结构化前置诊断并退出2；实际构建失败仍为1。`test-e2e.mjs` 使用当前 Node 执行 probe，保留其前置诊断/exit2，不把实际 Playwright 失败变成前置缺失。`build.mjs` 的 Node/工具版本前置保留具体 blocker/exit2，实际编译、产物/schema 或参数失败为1。`doctor.mjs` 保留 tools/release/capabilities 原字段，补充 status/blockers：缺工具、版本不符、process-tree 工具或发行 manifest 为 blocked2，已存在但无效的发行/hash 优先 failed1。未知 wrapper 参数始终失败1。统一 runner 仅为已登记的这些描述符解析对应结构化 prerequisite2；正常构建/doctor 为非测试命令，浏览器正常执行仍要求真实 Playwright 报表。不把任意命令 exit2 视为 blocked，native exit/signal 原值保留。

`--skip-security` 的 browser 子图以完整标题排除 `F11 two actual pages sharing head and lease have exactly one complete save and unsynced loser draft`，登记到 excluded_tests；非权限 task lineage 与 late ACK 保留。integration 继续排除既有 `F10/F11 concurrent real CAS plus transferred and expired lease reject without partial revisions`。本轮只用实际 Playwright `--list` 核对 F11 未调度，不运行该权限/lease race。
`--skip-security` 同时按完整标题排除 T33 packaging 的凭据碰撞/脱敏、不可变审核审计故障注入、带 origin 拒绝的混合启动和含秘密断言的 doctor 用例；完整标题登记在 excluded_tests。正常包装缺前置、产物完整性、owned 子树退出和正常 WAL 备份/恢复仍保留。生命周期由独立物理 Ctrl+C startup 证明，不以运行被排除安全断言替代。此前门禁误漏排这些标题的原始结果保留，不计为安全验收；失败凭据碰撞用例在 bootstrap 前中止，也不能计为专题验证。

根 Playwright 配置显式启动独占的 recovery origin（默认 `127.0.0.1:5191`，可用 `WEBLABEL_T30_ORIGIN` 指定独立 loopback 端口），供 T13/T30 使用；不得以用户已有服务替代。T25/T30 通过实际 `AI 审校` 按钮展开折叠面板后再输入，不修改产品默认折叠状态。T09-D 验证真实 Native 文档、canonical 几何、generation 与 undo/redo 在 hover 前后不变，保留真实 GPU idle/resize 验证；不再把合法初始化的累计 `get_snapshot` 次数当作 pointermove 违规，也不重钉实现计数。
单图新导出要求当前 LoadedAsset 的 Native 初始化已经交付 ready 或真实 terminal-error Host；初始化期不能启动 preflight，避免首次 Host 安装改变 scope 而吞掉过早的点击。该条件不是写角色或 editableHost 门禁：只读服务端导出仍可用，未知请求重放、原范围救援下载、损失确认与 stale-scope 保护不变。内部 CanvasView 回调统一为 onHostSettled，所有实际消费者迁移；DenseHarness 仍只对 ready Host 执行工作负载。Native load lifecycle 绑定实际不可变 request 身份；同资产或重复查看同一服务器版本产生的新 request 必须重新加载并交付当前 Host，不能只改变引用后让旧加载被拒绝且没有替代。
T13 offline 双页场景既有 120s deadline 在 describe 配置时声明，覆盖 cold app/seed/login fixtures；其余场景和性能阈值不变。T15 readonly preview 的完整 CPU 文档断言先安装实际 observeEditor mount observer，再等待当前父级 export admission；只有 installBrowserFaults 的空 hosts 数组不是 Native 初始化失败，不能以新增等待或产品 fallback 代替缺失 observer。

R1 中 healthy ACK 本地回执屏障只阻断远端传输，不撤销当前合法 Native 编辑。Workbench 使用 SaveQueue.canAcceptEdits(asset, ontology) 判断本地 admission；已由 Native 提交的完整文档与 ordered journal 仍由 queue 保留，非 barrier paused/rescue 的既有内存政策不变。writes_paused、原 owner/scope guard、真实 receipt、write-token CAS、one-shot continuation 与 local_commit 保持 fail-closed；最新完整本地记录真正持久之前不得准备下一次 HTTP。真实回归在 pointerdown/up 之间释放实际服务端提交的旧 ACK，并保持物理 IndexedDB 回执 transaction，验证完整 canonical 文档、单次 undo/redo、精确新请求与 reload；48 步独立几何 oracle 的串行等待不能替代该时序证明。

T31 的所属 Vite 由当前 Node 直接启动 `owned-vite-service.mjs`。正常收尾关闭所属 stdin pipe，等待真实 `server.close()` 与 native close，再观察独占 loopback listener 已关闭；不以 Windows `taskkill /T` 冒充正常关闭。超时或非零/signal/仍监听保持 failed；有界 forced backstop 仅用于回收，不洗绿。fast 登记真实 listener 的运行中 EOF 与启动中 EOF 两项回归。硬件 workload、2000/10000 数量、sample seed 与性能阈值不变；任何实测 P95 越界仍失败。
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

- `services/detector` 的真实运行额外依赖使用 `transformers[vision]`，同时需要 torch、Pillow 和 torchvision；metadata 探针必须将缺少的图像依赖报告为 `needs_configuration`。默认离线安装不下载这些运行依赖或模型。

  CPU wheel 的实际来源/版本必须单独留证，不能仅凭依赖解析结果声称 CPU 已运行。
- Windows stdio worker 在开始阻塞读取 stdin 前初始化已安装的 NumPy 原生模块，避免模型线程的首次 torch/NumPy 导入与打开的 stdin 管道互相阻塞；此准备不导入 torch/transformers，也不加载权重。缺少 NumPy 时保留可选服务的诊断路径；原生模块无法导入时在协议启动前明确失败，metadata 可见不代表原生库可用。
- RT-DETR v2 从框架输出 `pred_boxes` 和 `logits` 进入同一个 canonical 解码器；不使用不存在的 `pred_logits`，不再调用带 `target_sizes` 的二次反缩放。
- 生产 worker 只在真实 forward 和解码完成后将 execution receipt 附在 `succeeded.data`；记录锁定 model_id、实际运行版本/device、query/检测数量。`response_id` 是本地 worker 的 run_id 关联，不是外部供应商响应 ID；注入的调度 double 不产生真实执行回执。
- 零检测也可以是实际执行成功，但不证明检测质量，也不完成候选接受/撤销/保存验收。`verification` 仍须保持未完整验收状态；缺少候选时不得降低锁定阈值、注入候选或把空文档标成 negative 来凑闭环。
- 2026-10-09 授权实测见 `reports/T32/detector-live-2026-10-09/`：五次请求额度全部使用，最后遮挡图完成 CPU forward/300 queries、零检测。清晰图最终仍有失败记录，双图成功/候选闭环/取消和完整 T32/G4 未通过。

无商业密钥时 fast/integration 的非安全工程子集可以通过；live 默认和缺完整离线证据时返回blocked2。实际采集必须另行运行 `node scripts/verify-live.mjs --run --config <公开配置.json> --report-dir <新目录>` 并经用户对账号、外发图像、调用预算与费用的明确授权；本轮没有该授权，也不执行采集。`--prepare-inputs` 只生成本地PNG，不是真模型结果。当前四渠道的完整clear/occluded、回执、Native差异、人工判读、接受/撤销保存及错误路径证据均未补齐，T32/T35仍不可通过。

## 7. 质量与商业效果

T34只实现测量工具，不能生成“节省30%”的虚假实测结论。对照组必须包括现有工具+相同AI能力；记录标注、修正、审核、切换、模型等待、错误/漏标和费用。任务窗口失焦/长时间闲置不计作有效操作时长；禁止后台跟踪与未经同意上传遥测。

真实试点采用有独立人工审核的样本；明确统计单位是图片/对象/任务和样本量。同等质量下总人工时间降低30%是建议试点目标，不是软件发布关卡的事实陈述。

## 8. 报告文件

每个任务至少 reports/Txx/result.json、tests.log、review.md；需要视觉的任务另有 screenshots/ 与 traces/；真实敏感媒体不进入Git，使用脱敏截图/哈希。最终 reports/release.json 包含各关卡 pass/fail/blocked、版本矩阵、已知限制、实际启动命令和剩余动作。

计划结构检查只能证明任务图、文件引用与 JSON 结构符合要求。产品是否完成，要看实际运行结果；已实现的部分和仍 blocked 的关卡分别列出，不能用计划完整性替代产品验收。
