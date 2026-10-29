# 验收记录从这里找

公开版本不分发原始认证产物、数据库、日志和 trace。下文历史结果继承原始私有归档，不是在新公开 SHA 重新执行；不可访问的证据路径以私有归档记录表示。本轮增量来源与独立验证见 [公开来源记录](publication/provenance.json)。

这个索引用来恢复工作和找到原始证据，不代替日志、截图或独立审查。下表中的状态取自本次文档整理前的 STATUS；测试数字是对应阶段实际记录，不表示这一轮又跑了一遍。

本次净化增量的[源码来源映射](publication/increment-map.json)与[实际整合验证](publication/increment-verification.json)单独记录。它们不分发原始私有产物，不把工程回归或一次硬件烟测写成模型 live、跨平台或 G4 通过。

已发布的[工程预发布 rc.3](https://github.com/lona-cn/weblabel/releases/tag/v0.1.0-rc.3)及其[净化增量与验证记录](publication/rc3-integration.json)绑定不可变 source `8a2ab61`：对应阶段的 Release 门禁、两平台公开下载产物校验与独立持久化烟测通过。该次净化增量当时仅含测试、文档和来源记录修复；后续原生重构与界面变更见下文，不能继承旧发行的当前版本验收。release tag 和 assets/image 不移动；原始报告、登录产物、截图和运行目录保持私有。工程预发布不升级 T32/T35/G4 验收。

## 原生 HTML / Rust 重构增量

[原生源码整合记录](publication/native-html-rust-rebuild.json)保留先前公开源码的实际验证范围；[R05 完成记录](publication/r05-accepted.json)记录三项用户豁免、原账本 20/20 与真实六普通图／五同 tensor 路径。保留形状、有限值、输入 hash、raw boxes、类别／阈值与 canonical 几何校验；raw logits 只作诊断，独立 rotate/tensor 未执行、未通过。旋转后处理已修复同一原始角点的 x/y 映射，并以已有真实输出零推理复算十一条路径。[先前数值失败](publication/r05-continuation.json)不改写。R05 与 [R09 源码切换](publication/r09-native-cutover.json)已完成；R10 已按用户批准的精简本地范围完成，R11 独立工程审查已完成并保留未知项，用户已接受该工程交付及明确豁免。T32 blocked、T35 pending 与原完整发行门禁不变。独占硬件 GPU 曾有一次限定范围通过，不能替代当前性能重验；模型运行来自原私有源目录，不冒充公开 SHA 再次推理，原始数组、nonce 账本、模型、runtime、数据库与日志不公开。

[R10 范围与历史结果](publication/r10-partial.json)保留完整发行失败、先前公开 CI 两平台构建通过但测试失败，以及本地原生进程和合成界面的实际验证边界。该记录中的工程完成与用户验收不等于完整公开发行通过；安全专题、真实模型、完整视觉矩阵和当前硬件性能的跳过或未知状态均不改写。

[完整源码对齐记录](publication/all-main-20261029.json)将后续本地源码、CI 夹具修复、产品上下文及完成状态补入公开主线；应用源码树与已验证的本地版本一致。原始报告和本机设计工具配置留在本地，既有公开回执保留。本轮只重新执行受影响的本地检查，未主动发起远端全量验收；最终元数据提交保留 `[skip ci]`，不扩大已跳过的安全专题范围或自动发布镜像。


## 当前还卡在哪里

原任务历史记录为 T00–T31、T33、T34 done，T32 当时五渠道完整验收 blocked、T35 pending。当前用户选择退役 Codex 后，必需真实渠道仅 Claude/OpenAI/MiMo/Detector 四项，仍全部 blocked；Anthropic API 可选。历史 GPU 通过不能代替本轮硬件重验或所有模型/完整 G4。

模型历史缺口见 T32（私有归档：`reports/T32/result.json`），当前合同以 required-channel manifest 为准。正式发布不能由页面、构建、doctor、mock、软件 GPU、删掉 Codex 或跳过安全条件代替。

## 四角色用户体验五波增量

用户已批准的完整[UX01–UX29历史计划](../docs/ux-improvement-plan.md)所含29项已逐切片落地并验收，不是仅修复拉框；计划原地归档，不再列作待实施批次。逐项提交、测试、运行证据和边界见需求目录（私有归档：`reports/T35/ux-improvement/item-catalog.json`）、最终结果（私有归档：`reports/T35/ux-improvement/result.json`）及STATUS.user_requests.ux_improvement。原36项状态、T32/G4/性能与许可阻塞不改写。

- 真实GPU手势与预览（私有归档：`reports/T05/ux-improvement/main-static-proof.json`）、DPR2/125%（私有归档：`reports/T05/ux-improvement/main-dpr2-125-proof.json`）、批量/隐藏/过滤外属性与完整几何undo（私有归档：`reports/T12/ux-improvement/main-bulk-geometry-proof.json`）、null明确提交（私有归档：`reports/T12/ux-improvement/main-attribute-proof.json`）。
- 正式人工→任务提交/继续→负样本→独立身份固定版本审核（私有归档：`reports/T26/ux-improvement/main-packaged-flow-proof.json`）绑定095d6574发行；602正式入口与原envelope完整保全（私有归档：`reports/T12/ux-improvement/main-final-task-entry-proof.json`）、自动媒体作业终态（私有归档：`reports/T08/ux-improvement/main-media-auto-track-proof.json`）、v2规范发布不迁移旧任务/head（私有归档：`reports/T08/ux-improvement/main-norm-version-proof.json`）各保留真实源版本。
- Main独立1099项/1024+75两批实际冻结下载与全ZIP复核（私有归档：`reports/T27/ux-improvement/acceptance/main-20261013/ux19-result.json`），绑定53b3f82d及源哈希，非1099逐张UI标注；96MiB真实图像ZIP拒绝有typed边界。
- [AI真实Native与公开preset的合成surface](T24/ux-improvement/primary-surface/)不是完整routed Workbench；候选/同意/拒绝收据HTTP部分受控、无模型调用。精确提交版本与本人显式工时API（私有归档：`reports/T24/ux-improvement/ux23-binding-api/verification.json`）、自愿区间/结果界面（私有归档：`reports/T24/ux-improvement/ux23-binding-ui/report.json`）、旧flight身份围栏（私有归档：`reports/T24/ux-improvement/ux23-publish-fence/proof.json`）分开记录，不伪造live、ROI或历史工时归因。
- 实际runtime doctor（私有归档：`reports/T33/ux-improvement/main-runtime-doctor-proof.json`）、备份/恢复/只读预检（私有归档：`reports/T33/ux-improvement/main-ops-proof.json`）、停机exit512原始记录（私有归档：`reports/T33/ux-improvement/main-entry-launcher-exit.json`）：实际owned进程停止/锁释放/数据保留，不冒称正常exit0、付费取消或生产回滚。
- 全量生产69文件/75reviewable独立复核（私有归档：`reports/T35/ux-improvement/review-60200d8.json`）；新UX23delta另审，旧72pass/1fail租约日志（私有归档：`reports/T24/ux-improvement/ux23-main/api-lib.log`）保留，确定性时钟修复（私有归档：`reports/T27/ux-improvement/lease-regression/report.json`）不放宽生产expiry/fence或减少九组合。602完整741回归（私有归档：`reports/T35/ux-improvement/entry-final/main-final-web.log`）不替代后来修改的最终日志。
- 最后生产源码97effe65：42文件768前端通过及类型/构建（私有归档：`reports/T35/ux-improvement/closure-final/main-final-runs.json`）、实际正式发行清单（私有归档：`reports/T35/ux-improvement/release-closure-final-manifest.json`）、73 API库回归（私有归档：`reports/T24/ux-improvement/ux23-main-final/api-lib.log`）、工作流2项（私有归档：`reports/T24/ux-improvement/ux23-main-final/workflow.log`）、修正目标后的readiness2项（私有归档：`reports/T24/ux-improvement/ux23-main-final/readiness-correct-target.log`）。原runner误目标101日志保留，不说所有迭代green。
- 最终实际WorkBench自愿计时/显式任务绑定/一次PUT与真实ACK（私有归档：`reports/T24/ux-improvement/ux23-main-final/production-activity-proof.json`）、新token旧props不得发起发布（私有归档：`reports/T24/ux-improvement/ux23-main-final/old-props-new-click-browser-proof.json`）、最后delta独立审查（私有归档：`reports/T35/ux-improvement/review-ux23-closure.json`）、自建工作树清理（私有归档：`reports/T35/ux-improvement/worktree-cleanup-final.json`）。任务-only实际发行闭环不冒称真实AI run或因果收益；旧身份受控surface证明不是生产鉴权完整闭环。

## 本机管理员密码恢复增量

用户授权的已有管理员恢复已完成，源码提交 `81978b02433035d55a4fa48de43ae05b29b0ff13`：完整验证（私有归档：`reports/T10/admin-recovery/verification.json`）、独立最终审查（私有归档：`reports/T10/admin-recovery/review-final.json`）、最终发行清单（私有归档：`reports/T10/admin-recovery/release-final-manifest.json`）、真实浏览器/HTTP/SQLite闭环（私有归档：`reports/T10/admin-recovery/final-smoke.json`）。24原生、607前端、18启动器、3契约及1备份兼容测试通过；8恢复回归复跑属于24原生内，不重复累计。GET先占门导致POST误409的审查问题有红测与公平等待修复；最终0待解决finding。

两环境输入仅授权本机exclusive maintenance，终端一次性随机码，新密码在网页设置；事务保留原身份/成员关系，只撤销目标会话，完成后清环境并重启才可正常登录。真实丢ACK仅POST一次、只读核对completed；同源八GET无误409；旧密码/旧会话拒绝、另一账号旧会话仍可用，最终CLI已消费ID拒绝。[使用步骤](../docs/operations.md#管理员密码恢复)、工作树清理（私有归档：`reports/T10/admin-recovery/worktree-cleanup.json`）、临时数据清理（私有归档：`reports/T10/admin-recovery/temporary-cleanup.json`）。

仅自建合成项目/成员关系，不冒称真实业务标注/审核历史、GPU性能、模型渠道或整轮发布门禁通过；T32 blocked、T35 pending及用户原dirty/untracked保留。测试发行保留在 `target/admin-recovery/release-final`，验证进程与浏览器均已停止。

## 本轮 WL-01–WL-10 缺陷修复

本轮已授权工程修复收尾；逐项报告（私有归档：`reports/T35/defect-repair/2026-10-11T13-21-39-234Z/repair-report.md`） 与 机器记录（私有归档：`reports/T35/defect-repair/2026-10-11T13-21-39-234Z/repair-result.json`） 绑定 source commit `04f7e27f6bf2a034152c5fb68fc32711be111f37` / snapshot `1e9f85917719920b8315650070c0dda419abad5695a7a22bd3c7ef183b61a3d3`，原用户 dirty/untracked 与历史证据保留，不是干净 clone 或远端CI证明。

当前实际整轮门禁（私有归档：`reports/T35/defect-repair/2026-10-11T13-21-39-234Z/gate-release-authorized-source/result.json`）：fast745pass/4skip，Rust184/184，integration74pass/28skip，硬件browser37/37无skip/retry/flaky；两次release build/doctor与真实startup/Ctrl+C通过。**release仍failed/exit1**：2k committed_edit CPU P9515.862ms>8ms；四真实渠道blocked、模型调用0、安全skipped_by_user/not_verified，full_1_0_ready=false。

137/137独立review（私有归档：`reports/T35/defect-repair/2026-10-11T13-21-39-234Z/gate-release-authorized-source/review.json`）、13 smoke/61 SHA artifacts（私有归档：`reports/T35/defect-repair/2026-10-11T13-21-39-234Z/gate-release-authorized-source/smoke.json`）、真实UI三ZIP/完整RGBA consumer、actual primary axe/focus与11WT普通清理均见逐项报告。组合身份与old-source局限明确；旧16.446ms失败、ENOSPC/未开始编译、九安全标题误调度8pass/1fail、a11y setup错误和exact service backstop原样保留，不洗绿。Codex按用户决定活动退役、历史保全；必需Claude/OpenAI/MiMo/Detector四项，Anthropic可选。


## 商业核心与体验增量

基于Label Studio固定版本比较的增量A/B/C已提交，并曾按用户要求在C后停止；发现基线为`ffc794c41d88fe3c879babef0178581bbcc6b126`。该停止要求已履行，随后获准恢复的D/E也已分别提交；下面的D/E证据只证明各自报告绑定commit，不是当前HEAD重验或T32/T35通过。规范、多类人工编辑、导入、对象检索、固定任务、可信反馈与布局的原实施范围保留在[商业核心计划归档](../docs/commercial-core-plan.md)，不再作为执行队列，不得把计划批准当结果。

- 发现基线与授权决定（私有归档：`reports/T08/commercial-core/baseline.json`）；发现资料在同目录discovery。
- 初次计划审查（私有归档：`reports/T08/commercial-core/plan-review.txt`）与修订批准（私有归档：`reports/T08/commercial-core/plan-approved.txt`）：仅计划通过，不是功能验收。
- A前置规范与安全契约已完成并提交 `ec077774de46f580e08517b4819e4ddd1fac8d88`：验证（私有归档：`reports/T08/commercial-core/iteration-a-verification.json`）、结果审查（私有归档：`reports/T08/commercial-core/review-a-final.json`）。实际110原生、9 API、51前端回归及同源硬件浏览器。
- B多类人工、原子数值几何/改类、语义列表、逐条导入结果和严格COCO/YOLO预览确认、单图三格式交付已完成并提交 `ade75241730502a8dfad56a022f6a9d37c16a784`：验证（私有归档：`reports/T08/commercial-core/iteration-b-verification.json`）、独立批准（私有归档：`reports/T08/commercial-core/review-b-final.json`）。实际101前端、13formats、9save API、8media及正式B3/NVIDIA浏览器；未知历史错误后仅原载荷重放，工程拒绝注入不当成真实鉴权证明。
- C06–C10固定任务、保存/恢复屏障、完整raw救援及工作区体验已完成并提交 `f2c0ef9e4101f848583f1d9569cc1d0970b1ce0a`：验证（私有归档：`reports/T08/commercial-core/iteration-c-verification.json`）、独立源码/结果批准（私有归档：`reports/T08/commercial-core/review-c-final.json`）、冲突恢复增量批准（私有归档：`reports/T08/commercial-core/c-conflict-recovery-delta-review.json`）、安全与读者审查（私有归档：`reports/T08/commercial-core/c-final-security-reader-review.json`）。实际493前端、5条受影响硬件浏览器路径、2项硬件producer及正式构建通过；真实角色提交/不可变审核/新head无继承批准、原请求重放、ACK+IDB及Native Undo/Redo、COCO损失确认/实际下载均有原始证据。T24模型接口是明确测试夹具，不升级真实模型验收。
- 原C停止要求已履行，清理记录（私有归档：`reports/T08/commercial-core/c-closure-cleanup.json`）保留。D恢复后计划/依赖审查（私有归档：`reports/T27/commercial-d/plan-review.json`）、完整验证（私有归档：`reports/T27/commercial-d/d-iteration-verification.json`）、独立最终审查（私有归档：`reports/T27/commercial-d/d-result-review-final.json`）PASS；实际提交`5849c5b918755febf91b000f1a3cb5d5ece29817`。D API原生75、格式19、真实HTTP2、前端561/交付边界68、1301分页、1024范围与513/1024六份全ZIP完整解析，真实损失撤销/GET重下载及320短屏键盘全部通过；初次26px失败、下载路径前提与review撤回依据保留。
- E已focused提交`35c8009c28b54681425d14bcfbf479f8e6168e27`：实际commit与精确构建/source绑定（私有归档：`reports/T27/commercial-d/e-actualcommit.json`）、完整验证与限制（私有归档：`reports/T27/commercial-d/e-joint-verification-final.json`）、独立完整882行审查PASS0（私有归档：`reports/T27/commercial-d/e-result-review-final.json`）。原生322、web24文件562、11整文件集成60、strict TS/contracts退出0、schema3、Rust精确7文件fmt、全新正式18+4；原fixture/TS与权限/焦点失败保留，不筛套件。
- E真实同源两类四属性、好坏媒体、NVIDIA Native绘/改/数值/Undo/Redo/保存刷新、v2发布旧v1继续可用、COCO/YOLO预览实际损失独立确认、B固定提交/C不可变批准：三份实际UI ZIP独立Python/Sharp全解析（私有归档：`reports/T27/commercial-d/e-three-ui-exports-independent-green.json`）、后续B新7不继承旧6批准（私有归档：`reports/T27/commercial-d/e-real-immutable-approval-new-head-not-inherited.json`）。
- E最终五viewport两surface44px/无横向溢出/实际Tab整屏solid2：数据集与320×400 Enter真实下载（私有归档：`reports/T27/commercial-d/e-five-final-source-actual-dataset-keyboard-green.json`）、真实硬件Native（私有归档：`reports/T27/commercial-d/e-five-final-source-native-hardware-keyboard-green.json`）。0.234px裁切以既有CSS8px scroll margin修正，不放宽判定；最终API/Host/WASM/业务JS字节与功能验收同一。GPU/样本限制保留，不当全WCAG、跨GPU或真实模型支持。
- E原36/75 DAG none-ready与metadata smoke（私有归档：`reports/T27/commercial-d/e-final-metadata-and-original-DAG-smoke.json`）、独立报告EPERM清障（私有归档：`reports/T27/commercial-d/e-review-report-persistence-cleared-by-main.json`）、owned正常CLI停止（私有归档：`reports/T27/commercial-d/e-final-normal-owned-runtime-stop.json`）、五worktree41文件保全后清理（私有归档：`reports/T27/commercial-d/e-owned-worktree-cleanup-complete.json`）、全部临时driver与ledger保全后清理（私有归档：`reports/T27/commercial-d/e-owned-temporary-drivers-cleanup.json`）。最后E2/E3/browser正常0，初E1 controller exit1另存不伪称全0；未改用户原有数据/源码/浏览器。
- 用户明确不追加模型调用，T32 blocked、T35 pending不变；暂不授予再分发许可，不自动新增开源LICENSE。

## 各任务的集成与证据

| 任务 | 状态 | 已集成提交 | 对应阶段的检查与边界 |
|---|---|---|---|
| T00（私有归档：`reports/T00/result.json`） | done | `13ba6c2a98eb9b43e22f6c0c71b30b6d85336a32` | 初始化；11 个 bootstrap 测试和 1 个浏览器探针。最初未找到 WebGPU adapter，不是 G4 通过。 |
| T01（私有归档：`reports/T01/result.json`） | done | `b0531eaab0ff4924e0419d9053eda21bcbd477fb` | 共享领域模型与生成契约；10 个 Rust 测试、contracts:check、3 个 Node 测试通过。 |
| [T02](T02/result.json) | done | `ad69b1d4677c12eaa489b09ecd07a7669f0bc798` | 运行时与模型资料核验；36 项任务、75 条依赖的结构检查通过。只运行 Claude version/help，没有模型调用。 |
| T03（私有归档：`reports/T03/result.json`） | done | `4653630f213849b74d961d14880d6e34c84e5ddb` | 坐标与几何；注册验收 7/7。 |
| T04（私有归档：`reports/T04/result.json`） | done | `f3f066ba367d1a8d0a8c00342044a31a2d0f481f` | 编辑命令与撤销；Rust 15/15。历史预算是估算值；候选接受在 T19 实现。 |
| T05（私有归档：`reports/T05/result.json`） | done | `6e7d67d0300c530a99de9e5be2a77fa237044c40` | 真实 RTX 5060 Ti / BrowserWebGpu；Rust 11/11、3 条真实 GPU 测试通过。初次无 adapter 的启动假象已查明。 |
| T06（私有归档：`reports/T06/result.json`） | done | `4653630f213849b74d961d14880d6e34c84e5ddb` | SQLite、文件仓库与服务骨架；10/10，含 Windows 并发目录与进程生命周期。 |
| T07（私有归档：`reports/T07/result.json`） | done | `bb6e9f81bfe301337291a8439e7d1dce91f5bdb9` | 媒体导入、方向与作业；7/7。媒体路由权限后来由 T10 接入。 |
| T08（私有归档：`reports/T08/result.json`） | done | `4653630f213849b74d961d14880d6e34c84e5ddb` | 工作台外壳与列表；当时 7/7，另有浏览器缩放、媒体、键盘检查。早期外壳验证不等于真实 GPU 验收。 |
| T09（私有归档：`reports/T09/result.json`） | done | `ec85e2180d9356bf7bf32a545fd63b621d3ee96a` | WASM 画布与生命周期；早期 blocked 是当时状态，T05 通过后继续完成。后续消费者回归见 T30。 |
| T10（私有归档：`reports/T10/result.json`） | done | `8261e3590c1d462cdb001987ce9f34470e035ac6` | 本地认证与项目角色；9/9、限速 3/3、API 集成 23/23。首次密码由 C6 要求，限速是进程内窗口。 |
| T11（私有归档：`reports/T11/result.json`） | done | `e26769d11c53be2f991ced3faae6d43b780a3e37` | 不可变保存、CAS 与幂等；4/4。该窄套件未单独验证 viewer/nonmember 和多 ontology head 的全部边界。 |
| T12（私有归档：`reports/T12/result.json`） | done | `57245a4addf9dcc2afe6917195a4ad8b247d0fe8` | 编辑与快捷键；注册 15/15，全 Rust 183/183、Web 209/209、真实 GPU 浏览器 8/8。 |
| T13（私有归档：`reports/T13/result.json`） | done | `0609e0ddc49962dd0da37c6a87d5bedd92b94370` | 本地恢复与保存队列；最初 33/33，后续回归 35/35、43/43。旧草稿不能覆盖新内存编辑。 |
| T14（私有归档：`reports/T14/result.json`） | done | `52ac6e622bdff04d136be2198a4c5ae4f3ee2476` | 原生、YOLO、COCO 转换；9/9。类别与来源图必须显式映射，损失需确认，ZIP 路径仅接受可移植 ASCII。 |
| T15（私有归档：`reports/T15/result.json`） | done | `02c0c523302a67f572692879763f591c7885c005` | 实际 API、画框、保存、导出和负样本确认；浏览器 3/3，加 API/export 1/1；不声称跨硬件或 AI 服务支持。 |
| T16（私有归档：`reports/T16/result.json`） | done | `85f2a48d5710906115a71ec88739ca00c48a2e67` | 安全 Host 与进程监管；15/15，Rust runtime 10/10、全 crate 52/52。POSIX 身份不可用的限制保留。 |
| T17（私有归档：`reports/T17/result.json`） | done | `53e41ddc41ab423fdceeae8414784618a736a515` | 持久作业、预测、事件与恢复；18/18。创建与取消竞态、能力门控和重启路径均修复；授权存在性由 T25 补齐。 |
| T18（私有归档：`reports/T18/result.json`） | done | `00cc0ccc265e861095973a2273011e908be3460a` | 检测 worker 与坐标变换；56/56。9 条 mock 张量仅测后处理；当时未下载权重，真实运行另归 T32。 |
| T19（私有归档：`reports/T19/result.json`） | done | `523bbfdada50ada9520041e7248b968bc44afcaa` | 原子接受、撤销与 decision journal；17/17。journal、revision、head 同事务；批量全有或全无，预测不可改。 |
| T20（私有归档：`reports/T20/result.json`） | done | `7a630af334120a39a6d2d561ff9292de1d79b70f` | 三种 HTTP 适配器；48/48。未知费用为 null，超时不重发，端点需管理员批准；没有 live 调用。 |
| T21（私有归档：`reports/T21/result.json`） | done | `e7eb8d21d233c0d7e2324c444f8193dc2be035f3` | 受限 MCP 与运行级令牌；Vitest 10、Rust 18。cookie 不代替 Bearer，工具建议不直接写标注；当时真实 Host 接线仍待后续完成。 |
| T22（私有归档：`reports/T22/result.json`） | done | `deeb2f70718bb8be514ada138933cfa55cbbc3ba` | Codex 适配工程；27/27。synthetic 协议不能当成真实订阅，verification 保持 not_run；型号未知仍如实记录。 |
| T23（私有归档：`reports/T23/result.json`） | done | `cad3ce8a4bd08217f35299c1b5e4e1ca4474d143` | Claude 适配工程；39/39，flags 对照本机 2.1.183 的真实 help。Sonnet 5 未建立，model_id 为 unknown，verification 为 not_run。 |
| T24（私有归档：`reports/T24/result.json`） | done | `aaeaefa56cfb6e707e4174e9a4d58e410ccc041d` | AI 面板与接受链；注册 27/27（21 Web、1 fresh WASM 浏览器、5 实际 API）。工程 mock 证明接受和 Undo 的持久化，不升级 live。 |
| T25（私有归档：`reports/T25/result.json`） | done | `c569fef4f88526aa49297255941b69d16e0cedd5` | 政策、授权与多渠道工程链路；Rust 60、附加 25、Node 151，真实硬件浏览器 2 加 HTTP 3。不可用 profile 不回退 mock；模型关卡另验。 |
| T26（私有归档：`reports/T26/result.json`） | done | `2b37cb57305042a0a34017e10e5adf58d9e49cf7` | 租约、审核和负样本语义；47/47，类型、格式与 Cargo 检查通过。 |
| T27（私有归档：`reports/T27/result.json`） | done | `51569b5e787845db6dc0aef6a847bfd8aab4913b` | 不可变数据集快照与导出；7/7。原开发服务编译阻塞已修，旧隔离视觉记录保留。 |
| T28（私有归档：`reports/T28/result.json`） | done | `5ca36cf8a7cb69b74a0499565a24b4306feed439` | 密集对象与按需绘制；97 个 native 测试，硬件浏览器 3/3。debug 2k / 10k committed-edit p95 为 28.3 / 110.8ms，是当时测量，不是 T31 通过证明。 |
| T29（私有归档：`reports/T29/result.json`） | done | `efc611f61be0b0b8c6c5f1fd52b6ac6eb9adcfa0` | 安全验收；20 项 integration 加 22 项 Host，共 42/42，无 skip/filter。真实发行扫描与启动通过；loopback 工程模型不是 live。 |
| T30（私有归档：`reports/T30/result.json`） | done | `ac722ee21724aa6e0f877f4168e8837f7fcfd0c7` | 恢复与乱序；7 项 integration、9 项实际 GPU 浏览器、受影响 T09 的 5 项通过。旧 F14、stale-WASM 与 overlay 反例保留。 |
| T31（私有归档：`reports/T31/result.json`） | done | `d156ffbe636881b91ab690aca620cbf639c613a5` | 目标机原 8000 行正式场景 3 passed；最终 2k committed CPU P95 7.808ms ≤ 8ms，double-rAF 代理 16.4ms ≤ 33ms。旧失败保留，单次通过不证明重复性。 |
| T32（私有归档：`reports/T32/result.json`） | blocked | `79360d3c6d23162b42f53bc67ccb320b91f00fb7` | 工程集成已完成，五个必需模型渠道的完整关卡仍 blocked。模型配置、合成协议和软件 GPU 不能替代真实证据。 |
| T33（私有归档：`reports/T33/result.json`） | done | `1effefb7994750fbe5f7253da676ef0a58d68966` | 本地发行、首次设置、退出与备份恢复；注册 16/16。活动 Host 物理 Ctrl+C、新目录恢复与业务 TEXT/JSON 的密钥碰撞拒绝已闭合；不是签名安装包。 |
| T34（私有归档：`reports/T34/result.json`） | done | `1effefb7994750fbe5f7253da676ef0a58d68966` | 自愿工时与试点分析；API 7/7、受影响 Web 75/75，真实 PUT/GET 200。人工试点 0、未知费用 null、ROI/结论 null；30% 只是目标。 |
| T35 | pending | — | 最终独立审查尚未就绪；T32 的依赖条件未满足，不自动启动或标记完成。 |

## 看历史记录时要注意

- 早期报告里的 running、blocked、待集成和失败，描述的是当时状态。后来的成功不覆盖它们；看最新状态时，还要核对 STATUS 和集成提交。
- T22 曾把 TS6053 × 5、exit 2 误写为类型检查成功。Main 已披露并修复 6 个真实类型错误；4 个未落盘工件后来补齐。该历史不能抹掉，也不能把修正当成真实订阅支持。
- T31 保留原 c2 的 2k committed CPU P95 22.013ms、原 8000 行的 8.569ms 与 8.791ms 等失败。最终成功来自同一正式场景，不改 8ms / 33ms 门槛，不用 10k stress 或诊断结果顶替。
- T31 最终原场景固定 seed 17、2048²、40 warm、4 × 1000 × 2。2k pointer / pan / zoom / committed CPU P95 为 1.517 / 2.472 / 2.472 / 7.808ms；对应 double-rAF 为 16.5 / 10.4 / 10.2 / 16.4ms。double-rAF 只是代理，不是物理光子延迟。10k committed 28.336ms / proxy 27.4ms 仅作 stress。
- 原 8000 行逐行有 native / GPU submit 1，committed 上传 48B，其余 0B，无二进制 readback。100 次切图保持 1 device、3 buffer、1 texture；4 DPR 的 8±1 控件、zero-size resume、真实 device-loss recovery 等有各自断言。旧 worker 崩溃未在某次运行出现，不证明 0xC0000409 已找到根因。
- Node 24.16.0 使用官方独立 ZIP、exe SHA 与有效 OpenJS Authenticode；系统 24.15.0、全局配置和旧发行不改。迁移时记录的 39/39 有 12 个 unit 被过滤，不是完整 suite。三份 ZIP 的认证脱敏派生有独立逐成员复核，不重写旧敏感历史提交。
- T29 的私有 50ef / 49 commands 与主仓 main-* 证明分开。T33 的发行 manifest、产品源码与解释型 CLI 来源也分别记录，不能混为一次构建的输出。
- 试点的 20 张 PNG、完整 GT、每臂 70 对象和 60 synthetic 记录是工具验收，不是人工收益研究。工时默认关闭，没有后台外传；未知费用不能写成 0。

详细发现、修复过程、方法和原始数据保留在每项任务的报告中。原始终端输出、页面快照、保存的验证源码和官方校验和不做文案润色。

## 最近的用户请求

### 界面改造

首次深度改造源码：`c126d734d802998b1da245b41d384b236da35482`，基线 `09ad052a1344e0d8b8a31580b70b9c7234ee73b1`，契约 v1。工作台改为三栏，低频详情保持挂载；真实保存、审核和固定快照状态仍显示。T08 / T24 28/28、types、Vite 构建及实际硬件 T15 3/3 通过，无 skip/flaky。发现的 HUD 抢指针、导出入口和标题层级已修复。没有外部模型调用，也不升级 T31 / T32 发布关卡。见 改造记录（私有归档：`reports/T08/ui-redesign/verification.json`）。

第二轮布局和文案源码：`3c9fb400ebed2f1b61d081a4687a824d4bae5abe`，基线 `0d775230d140a3873ffb8017540691f052e4940d`，文案切片 `e72639b7`，契约 v1。采用低装饰 Console，画布优先；授权范围、费用未知、保存救援、指定审核版本和导出损失确认都保留。

Web 114/114、types、前端 Vite 构建、实际硬件 Chromium T15 / T24 / T25 / T30 共 16/16 通过，无 skip/flaky。实际浏览器 1440 / 1024 / 390 没有水平溢出；已观察编辑、撤销重做、保存、指定版本审核、冻结、原生包下载和 YOLO 损失确认。完整仓库集成尝试因非前端 5 秒超时取消；最终全量 axe 超时，读屏未测，不能写成通过。保留会话刷新曾出现 CSRF_REQUIRED，后续按正常登录完成验证，未改认证逻辑。见 验证与截图（私有归档：`reports/T08/ui-refine/verification.json`）。

### 本地检测器的授权运行

恢复基线 `200c439cc1f956ddd30f581627eff35b39293f69`，源码 `79360d3c6d23162b42f53bc67ccb320b91f00fb7`。4 个锁文件的 SHA256 与大小通过，CPU 加载真实 20,174,608 参数。修复 vision 诊断、Windows stdin 尚打开时的 NumPy 冷导入死锁、RT-DETR 的 logits 字段与完成回执；失败前后回归和完整检测器 70/70 通过，两轮独立审查无阻断，这些测试不运行模型 forward。

用户先授权 3 次、再追加 2 次，数据库共 5 个请求：4 次失败保留，最后遮挡图真实 CPU forward/decode 完成，300 queries、0 检测。两个标注 head 和未处理状态没有改变；未降低 0.5 阈值，也未注入候选。实际运行与完整五渠道验收仍是两回事。见 授权运行记录（私有归档：`reports/T32/detector-live-2026-10-09/result.json`）。

### 文档整理

本轮改写 141 篇维护文档，清理 3 页临时资料。两页交接说明的原文已并入现有记录，再删除独立文件；原始草案、49 份页面快照、验证源码、日志和锁定哈希的模型说明保留。启动入口不再把已有应用当空目录，隔离规程明确默认项目根内及项目外授权，历史结果仍按当时范围说明。

141 篇的本地 Markdown 链接与锚点检查无断链；67 篇技术/执行文档和 68 篇历史报告的示例、权限、依赖、hash 与观察字段检查通过，计划检查及 6 项测试通过。独立冷读发现的初始化、隔离和历史导航问题已修正。六工具 pin 就绪，但默认发行缺失，doctor 退出 1；备份恢复只实测缺参拒绝，不声称实际数据演练。源码提交见 [本轮状态](../STATUS.json)，范围与实际输出见验证记录（私有归档：`reports/T00/docs-cleanup/verification.json`）和冷读记录（私有归档：`reports/T00/docs-cleanup/review.json`）。应用代码、原任务状态和发布关卡未改；本轮三个工作树已保全独有提交后移除。

### 工作台布局修复

本轮处理八项布局问题：图片与对象列表独立滚动，尺寸调节与实际边界一致，画布使用剩余空间，保存和完成状态留在画布下方。1099px 以下使用覆盖式侧栏；属性与 AI 按需切换，GPU 状态不再遮挡图像。数据集阶段动作置于长列表之前，项目页先继续已有项目，登录页保留单列表单。

前端 9 文件 113 项测试、类型检查和生产构建通过。主会话浏览器探针 163 项检查通过，覆盖桌面、平板、390px 窄屏和短窗口；另用真实本地 Rust API、隔离 SQLite、合成图片及硬件 WebGPU 跑通 15 项烟测，验证画框保存、撤销重做、负样本确认、指定版本批准、数据集冻结生成和下载。独立审查发现的跨断点失焦已修复并复核；记录见验证证据（私有归档：`reports/T08/layout-fix/verification.json`）、首次审查（私有归档：`reports/T08/layout-fix/review.json`）和修复复核（私有归档：`reports/T08/layout-fix/focus-review.json`）。未调用模型、未上传业务图片，G4 和发布关卡不变；源码提交见[本轮状态](../STATUS.json)。

### 浏览器首次登录

新数据库与合格恢复库自动展示启动码、密码与确认表单；初始化成功直接进入项目页并显示服务端实际用户名，重启后使用普通密码登录。未知写入结果或已创建但会话待核实只提供重查，不重复初始化；原 Host/Origin、CSRF、一次性兑换和历史身份约束不变。

主会话验证了 11 项原生认证/恢复检查、6 项真实 API 集成、37 项前端状态/表单与壳检查及 1 项真实首次登录浏览器 E2E；生成契约、Node 校验和类型检查通过。当前源码新建发行在实际同源浏览器中完成初始化、创建项目、同数据目录重启登录、真实备份恢复、新恢复管理员及恢复数据再次重启登录，320px 与桌面截图保留。独立审查发现的退出后 storage 故障和双退出竞态经红绿回归修复，storage 故障另有真实 logout 204 烟测。详见验证记录（私有归档：`reports/T10/first-start-login/verification.json`）、发行烟测（私有归档：`reports/T10/first-start-login/release-smoke.json`）、初审（私有归档：`reports/T10/first-start-login/review-initial.json`）与复核（私有归档：`reports/T10/first-start-login/review-final.json`）；源码提交见[本轮状态](../STATUS.json)。未调用模型、上传业务图或声称新的硬件 WebGPU 支持；T32/T35 与发布关卡不变。

### 图文入门与网页登录引导

本轮以已有安全网页登录能力重写 README 和首次使用指南，并同步运维/恢复说明；首次建立本地管理员与以后密码登录均在普通网页完成，不需要用户手写 PowerShell HTTP。源码仍须构建，无签名 exe/安装器；团队第二审核者需已有受保护管理员配置，没有成员管理 GUI。本轮不改认证、CLI、产品业务源码或发布关卡，actualcommit 见 [STATUS](../STATUS.json)。

主会话全新隔离数据目录经正常 CLI 启动，真实浏览器完成首次设置、普通重新登录、两类/enum 规范、逐文件媒体结果、NVIDIA WebGPU 画框/属性/保存、严格 COCO 映射与只读损失预览/确认、固定任务提交、独立审核者指定 revision 批准、冻结数据集及 Native/YOLO 实际下载；两份合成 ZIP 全量解析核对固定版本、连续像素 xyxy 与批准元数据。12 张 [教程图片](../docs/images/readme/) 经逐图独立冷读；导入/提交/审核长图由真实 200px 滚动区逐帧原样截图按实际物理 offset 拼接，非原界面同屏，正文已公开。

实际完整门禁：原生 workspace 322、Web 24 文件 562、认证启动恢复 3 文件 20、schema 3，strict TS 与生成契约退出 0；4 文档全部本地链接/锚点及 12 PNG hash 验证通过。保留错误 cwd 的契约初失败、被裁取景及提交后旧操作提示；最终正常只读刷新核对 Task5 待审核后重拍，并由独立审核者真实批准，未重复提交。最终独立审查所有 finding 闭合、12 图 PASS、P0/P1/P2 为 0。

入口：完整验证（私有归档：`reports/T33/readme-first-use/verification.json`）、12图索引（私有归档：`reports/T33/readme-first-use/screenshots.json`）、实际首次设置（私有归档：`reports/T33/readme-first-use/actual-browser-first-login.json`）、Task5提交与审核（私有归档：`reports/T33/readme-first-use/p2-task5-reviewed.json`）、ZIP解析（私有归档：`reports/T33/readme-first-use/actual-zip-readback.json`）、最终独立审查（私有归档：`reports/T33/readme-first-use/independent-review-final-pass.txt`）。两个隔离 writer worktree 已保全后移除；owned 控制器停机遇 Windows import 失败保留，按核实的 PID/lock 用生产同一树停止 primitive 清障，三端口确证关闭后移除 own lock，未伪称正常 exit0；见 停机（私有归档：`reports/T33/readme-first-use/owned-runtime-stop.json`）与临时清理（私有归档：`reports/T33/readme-first-use/temporary-cleanup.json`）。无外部账号、业务图、付费模型/权重调用；T32 blocked、T35 pending 和 UNLICENSED/未授予再分发许可不变。

### 文档治理与项目参考（2026-10-12）

新增治理规范、四套完整模板与唯一六列目录；补齐开发、配置、数据模型、完整 HTTP API、管理员配置和故障指南，同步架构/契约/运维/手工验收/四必需渠道边界。新增只读 docs:check 并接入实际 fast 与 G0/G2/G5 聚合，不改产品功能、原36任务或发布状态。

实际窄检查29/29、fast-bootstrap37/37、Vitest745 passed/4 skipped；新发行与doctor通过。真实NVIDIA Native完成22图导入、完整canonical几何/属性/complete/负样本、普通200/200/409/409保存、独立网页审核、单revision train快照、三ZIP标准库精确回读及单图COCO JSON回读；正常备份恢复后旧revision、媒体与原快照native ZIP hash一致，历史审核人不归新管理员。

原sccache/driver/旧任务失败与PowerShell中文响应乱码保留；客户端显式UTF8解码后另用新正图完整复跑六段API例子。密码输入仅由内存合成operator adapter供应，HTTP真实，不冒充人工键盘证明。自有Ctrl+C监督exit512保留，端口/进程/锁实际归零。模型调用0、安全专题skipped，T32 blocked/T35 pending与UNLICENSED不变，不是release通过。

入口：完整结果（私有归档：`reports/T33/documentation/2026-10-12T12-52-37-812Z/result.json`）、文档与工具审查（私有归档：`reports/T33/documentation/2026-10-12T12-52-37-812Z/review.md`）、最终证据审查（私有归档：`reports/T33/documentation/2026-10-12T12-52-37-812Z/review-evidence-final.md`）、三ZIP独立回读（私有归档：`reports/T33/documentation/2026-10-12T12-52-37-812Z/ui-dataset-independent.json`）、恢复链（私有归档：`reports/T33/documentation/2026-10-12T12-52-37-812Z/backup-restore-smoke.json`）、中文往返闭合（私有归档：`reports/T33/documentation/2026-10-12T12-52-37-812Z/api-unicode-closed.json`）。独立文档字节hash与实际commit由本轮结果/STATUS入口绑定，不借历史工程指纹覆盖Markdown。


### 原生 HTML/CSS/TypeScript 与 Rust 重构源码

以下描述首次净化集成时的历史状态；当前完成范围以上方“原生 HTML / Rust 重构增量”和 STATUS 为准，不沿用这里的旧进度或旧推理账本余额。

本次向公开 main 集成 R00–R04、R06–R08 的工程源码及 R05 的部分源码，不是完整原生切换或发布验收。默认网页入口仍保留 React；R05 blocked，R09–R11 尚未就绪，T32 blocked / T35 pending 不变。

保留公开基线的 Linux pidfd/subreaper broker、事务连接关闭与 lease/fencing 修复；Windows 原生运行时使用启动前分配的非 breakaway Job 和原始进程句柄。合并复验发现并修复并发终止请求的等待窗口，并保留完整 Host 丢弃后的物理退出断言；崩溃夹具等待期间显式持有 stdin，不降低退出码断言。

检测器唯一账本冻结于 3/20 debits；没有追加推理，也没有重试已取消的 UAC 文件软链接负控。原始报告、日志、截图、数据库、令牌、DLL 和模型工件留在私有项目内归档，不发布私有父提交。源码来源、已运行的公开集成验证及剩余边界见[结构化发布记录](publication/native-html-rust-rebuild.json)。

### CI 测试修复与当前源码对齐

2026-10-28 的本地修复处理了 SQLite profile 夹具写锁、测试内冷编译和缓存设置、ConPTY 编译占用启动窗口、数据集离页行刷新，以及 bootstrap 对失效审查指纹的错误前提；软件 WebGPU 改为完整 Chromium 与 Dawn SwiftShader。原完整 CI 数字只属于其绑定的私有源码，不冒充之后界面修改的全量复跑。

本轮已补入这些尚未发布的源文件，并重新执行文档与 bootstrap 回归、应用和测试类型检查、当前源码原生夹具构建与真实 API 烟测、定向故障回归、物理 Ctrl+C 及软件 WebGPU。物理退出仍使用已有不可变发行与当前夹具，不宣称新构建的完整产品发行；具体数量、原始来源、未选用例和审查范围见[结构化对齐记录](publication/all-main-20261029.json)。


## 维护这份索引

主会话集成后更新任务 ID、actualcommit、真实验收、审查和关卡状态。敏感输入不进入 Git；只保存授权范围、hash 和脱敏证据。文档清理不能改变已有任务状态或升级发布结论。
