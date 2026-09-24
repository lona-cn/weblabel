# 测试、发布关卡与证据要求

## 1. 关卡定义

| 关卡 | 必须完成 | 不允许的替代 |
|---|---|---|
| G0 环境与契约 | T00、T01；锁版本、测试 runner、WASM build、schema golden | 只有目录和 README |
| G1 人工闭环 | T15；导入→真 wgpu编辑→保存→刷新→独立导出回显 | Canvas2D mock、内存“保存” |
| G2 AI 工程闭环 | T25；run→候选→差异→接受/撤销→保存，协议失败路径 | 聊天框返回一段 JSON 但不进入命令系统 |
| G3 数据可信与可靠性 | T26..T30、T33；审核/快照/权限/恢复/包交付 | 只测正常 happy path |
| G4 真实能力 | T31、T32；目标设备 GPU + 各必需 provider/检测器实际验收 | 软件 GPU当硬件、fixture 当真模型 |
| G5 可发布报告 | T34、T35；完整检查、限制和实测证据 | 没凭证却全绿、声称已经提高30%效率 |

G1/G2 可以供内部继续开发，但不是所有模型已接入的发布声明。T32 的必需 profiles 为 Codex订阅、Claude订阅下可用 Sonnet、OpenAI API 可用 Luna、MiMo多模态API、真实检测器。Anthropic API作为补充路径也要有自动化合约测试，未 live 的补充路径 UI明确标未验证。

若账号权限实际不包含对应型号，显示完整 model_id/权限错误并标该验收 blocked；可独立出 limited preview，但不能把它称为完整 G5。

## 2. T00 必须实现的统一命令

这些产品命令是本计划要求创建的接口，不是当前包里已存在的实现。

```text
pnpm dev                       Vite + Rust API；关闭时清理子进程树
pnpm build                     contracts check + WASM + Web + Node Host + Rust release
pnpm start:local               启动已构建的本地版本，缺构建即报错
pnpm run doctor                只读检查工具、WebGPU诊断入口、运行时/权重状态；不打印凭证
pnpm test:task T03              按 TASKS.json 精确运行本任务 checks；不存在/零匹配为失败
pnpm verify:fast                format/lint/TS/cargo unit/contract、无浏览器无账号
pnpm verify:integration         临时DB、端口与目录，保存/权限/作业/快照集成
pnpm verify:browser             Playwright 非付费端到端，必须记录实际adapter
pnpm verify:gpu                 目标真实GPU profile，缺设备返回 BLOCKED/非零
pnpm verify:live                明确允许外发/费用后测试配置的真实 providers
pnpm verify:release             聚合报告；缺必需G4不能返回成功
pnpm contracts:generate
pnpm contracts:check
pnpm demo:seed                  只生成程序化测试图片与示例项目，不下载私人/未知许可图片
```

scripts/task.mjs 读取 manifest 的 argv 数组调用进程，不通过拼接 shell string。Windows 的 pnpm wrapper 需用已解析的 Node CLI 入口或明确 shell 适配，不能假设 `.cmd` 可以按 POSIX 可执行文件运行。产品运行时仍严格禁止 shell:true。runner 要转发 SIGINT/退出码、检测缺 target/零测试，保留测试失败；不得 `|| true`。

生成物改动检查要在临时目录重生成，不改工作树“掩盖差异”。CI 默认不安装/调用商业模型，不自动下载权重，测试网络对外默认阻断。依赖安装属于 bootstrap，不属于 verify 的隐藏副作用。

## 3. 测试夹具与工具

T01 创建 tests/fixtures/golden/{ontology,media,document,save,prediction}.json 和 schema-invalid/；T07 创建程序化不对称方向图、EXIF1..8、伪MIME、超尺寸头和截断图片；T14 创建 yolo/coco/native 的合法及有损/恶意输入。夹具是测试数据，不伪装真实模型产物。

集成 TestApp 启动独立临时 SQLite 和 object store，随机未占用端口；从临时进程的 bootstrap 管道建立管理员 session，按真实认证创建 annotator/reviewer/viewer。禁止测试依赖个人数据库或端口48100。TestApp 的 HTTP 访问使用真实路由而非直调内部存储来冒充鉴权。

Vitest fixture API 在 tests/support/app.ts：`start_test_app():Promise<TestApp>`；TestApp 提供 `base_url`、`as_user(role):Promise<ApiClient>`、`stop():Promise<void>`；ApiClient 提供 `request(method,path,body?)`、`upload(path,bytes,filename)`，其返回 {status,json,headers}。T06/T10共同落地，T00只注册测试环境，不返回固定成功响应。

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

Playwright chromium-webgpu 可以使用软件适配器验证功能，但报告 software=true，并且不得据此通过硬件性能验收。真实性能profile在Windows目标机器上运行，记录OS、CPU、GPU/driver、浏览器、wgpu/应用commit、viewport/DPR、样本seed。默认不要求修改用户浏览器全局flags；无法获得GPU时记录blocked。

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

无商业密钥时 verify:fast/integration 可通过；verify:live 返回 blocked 信息和非零状态，绝不跳过后全绿。

## 7. 质量与商业效果

T34只实现测量工具，不能生成“节省30%”的虚假实测结论。对照组必须包括现有工具+相同AI能力；记录标注、修正、审核、切换、模型等待、错误/漏标和费用。任务窗口失焦/长时间闲置不计作有效操作时长；禁止后台跟踪与未经同意上传遥测。

真实试点采用有独立人工审核的样本；明确统计单位是图片/对象/任务和样本量。同等质量下总人工时间降低30%是建议试点目标，不是软件发布关卡的事实陈述。

## 8. 报告文件

每个任务至少 reports/Txx/result.json、tests.log、review.md；需要视觉的任务另有 screenshots/ 与 traces/；真实敏感媒体不进入Git，使用脱敏截图/哈希。最终 reports/release.json 包含各关卡 pass/fail/blocked、版本矩阵、已知限制、实际启动命令和剩余动作。

产品完成与计划完整性分开：本执行包仅提供设计和任务，检查任务图、文件引用与JSON不等于已经运行产品测试。
