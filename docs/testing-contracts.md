# 测试、装配与共享接口补充

供编写和维护跨模块测试的工程师使用。本文与 contracts.md 一起冻结公共 helper、夹具与装配规则；具体实现和运行结果须核对源码及任务报告，不能把接口说明当作测试已通过。

## 1. 测试用例可独立运行

T00 创建 crates 的 lib 与 bin 最小入口、Vitest workspace、Playwright config；所有 packages 名称固定：annotation-domain、geometry、editor-core、renderer-wgpu、wasm-bridge、dataset-formats、weblabel-api、xtask；JS packages 为 @weblabel/web、@weblabel/agent-host、@weblabel/contracts。workspace 根统一运行 pnpm exec vitest / playwright。

TASKS.json 的 argv 指定本任务的窄测试入口，不能换成全套测试来绕开指定断言。缺少路径应补实现；环境失败应记录为环境阻塞，不算 Red 功能失败。

共享 helper 放在 tests/support/。新增 helper 必须由对应任务定义，不能依赖未说明的全局对象。

Vitest 运行 TS 测试，tsconfig 引用 generated contracts；Playwright 用 `data-testid` 寻址。Rust integration test 文件统一小写 snake_case，例如 t03_geometry.rs；cargo --test 参数同名。

Python使用 pytest，测试收集为零视为失败。所有 test ID 大小写以 manifest 为准。

## 2. HTTP 测试 helper：T06/T10 负责

```ts
export type Role = 'admin' | 'annotator' | 'reviewer' | 'viewer';
export interface ApiResponse<T = unknown> { status: number; json: T; headers: Headers }
export interface ApiClient {
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>>;
  upload<T = unknown>(path: string, bytes: Uint8Array, filename: string): Promise<ApiResponse<T>>;
}
export interface TestApp {
  base_url: string;
  as_user(role: Role): Promise<ApiClient>;
  stop(): Promise<void>;
}
export function start_test_app(cookieSecure?: 'true' | 'false', modelWorker?: 'manual' | 'background'): Promise<TestApp>;
export function launch_code_for_test(app: TestApp): Promise<string>;
```

每次启动独立临时目录/数据库，监听随机端口。生产代码提供启动 bootstrap 通道；测试捕获该管道，走真实登录/管理员创建用户接口，不插入万能绕过鉴权中间件。进程退出和测试失败也执行清理。只有 TEST build 允许 fault injection channel，release build不编译此入口。

真实API helper在每个worker首次使用前从当前源代码构建，不以可执行文件已存在替代新源码。Vitest integration的prepare-api setup在行为测试计时外编译，保持原测试deadline；显式WEBLABEL_API_BINARY仍表示调用者选择的可执行文件，不能把任意override当新源码证据。

T25测试helper的manual模式仅在debug构建显式设置WEBLABEL_TEST_MANUAL_MODEL_WORKER=1，让故障/脚本fixture拥有排空顺序；background模式运行服务原生模型worker。release忽略该开关。database_path_for_test只返回该helper自己创建的临时数据库路径，不能访问真实项目库。

`launch_code_for_test` 仅读取当前 helper 自建 app 的 stdout 启动码，不调用管理员 helper、不兑换、不记录 code；未知 app 拒绝。首次登录浏览器回归只用 app + 原生 page，不依赖会先初始化的 seededProject/adminPage/as_user。

固定业务fixture由 T01 提供 `tests/fixtures/golden/{ontology,media,document,save,prediction}.json`；对象ID `object_person_001`，类别ID `label_person`，640×480，bbox[10,20,110,220]，helmet_state默认unknown。测试 fixture ID 不受UUID生成器限制：Id验证是非空受限字符串，生产新ID用UUID。

## 3. Playwright fixture：T15建立

`tests/e2e/fixtures.ts` 导出扩展后的 `test` 和 `expect`，提供 app、adminPage、seededProject 三个 fixture。seededProject 通过真实 API 导入程序化图像，包含 project_id、asset_revision_id、base_revision_id；adminPage已真实登录，指向该项目工作台。

`forward_api_for_test(page: Page, baseUrl: string): Promise<void>` 抽取原 adminPage 的真实 route.fetch/route.fulfill 转发，只匹配开发入口 `http://127.0.0.1:5173/api/**`，保留 path/query/body/method/cookie，去掉 Host/content-length 并将 Origin 改为实际 API base。它不是正式发行同源门控的证据；后者必须在当前发行实际验证。认证 spec 显式关闭 trace/video/自动失败截图，仅保留字段为空或遮蔽后的截图及脱敏结果。

媒体就绪以该项目全部 canonical 资产实际生成作为条件，不以一次 manual drain 的处理数量代替；后台 worker 可能已经完成部分导入。

主 data-testid：

| ID | 定义 |
|---|---|
| project-create / project-name / project-submit | 项目创建表单 |
| media-import / asset-grid / asset-item-{id} | 文件input、列表、媒体项 |
| toggle-assets / toggle-attributes / toggle-ai / close-assets / close-inspector | 工作台侧栏切换与窄屏关闭；切换不卸载 AI 状态 |
| annotation-canvas / gpu-status / tool-box / tool-select / tool-pan | 画布、诊断与工具 |
| object-list / object-item-{id} / attribute-{key} | 虚拟对象列表和属性控件 |
| save-status / undo / redo / image-next / image-prev | 保存与编辑 |
| ai-provider / ai-prompt / ai-consent / ai-run / ai-authorize / ai-cancel | 模型、授权预览与明确开始 |
| ai-status / candidate-{change_id} / accept-selected / reject-selected | 候选、差异和决定 |
| task-submit / review-approve / review-reject | 指定版本审核 |
| snapshot-create / export-format / export-start / export-download | 固定快照导出 |
| recovery-banner / conflict-banner / export-local-draft | 恢复与失败救援 |

gpu-status 位于 canvas-renderer-status 独立正常流，不覆盖 annotation-canvas；暴露文本/可测试属性 actual_backend=webgpu、adapter_kind=hardware/software/unknown、device_state=loading/ready/lost/recovering/unsupported；不以浏览器支持检查代替真实 device 创建。

布局验收须使用真实浏览器：同时验证 1099px 两侧及短屏、侧栏切换和双向跨断点焦点、对象虚拟滚动不拦截布局控件、原生 resize 与调节按钮的真实尺寸边界、保存与完成状态可达、数据集末行滚动后主操作仍可点击。合成 GET 拦截只证明布局；真实 API 保存、确认负样本和导出须另记实测证据。硬件 adapter ready 不等于 G4 通过。

设备重建中显示recovering且Canvas只读，成功才恢复ready；失败保持lost和GPU_RECOVERY_FAILED诊断，gpu-retry显式重试renderer-only恢复。GPUDevice.destroy必须通过真实device.lost观测并自动触发重建，不调用simulate_device_loss。

测试中需要获取文档时调用正常的 GET annotation API或 Editor 测试 facade；测试 facade只在测试构建可用，不能让生产页面暴露任意内部命令绕过权限。截图只用于可视效果；几何、标签和保存必须用原始数值断言。

## 4. Provider fake-process 契约：T16建立

`tests/support/fake-runtime.mjs` 是无网络子进程，接收环境变量 TEST_SCENARIO（normal / malformed / oversized / crash / slow / spawn_child），从stdio读版本化协议并发送确定性测试响应。它不能命名为真实 provider，不能被生产profile枚举。

生产注册表在测试注入点之外永远不包含它。

`apps/agent-host/test/fixtures/` 保存带 `fixture_kind: "synthetic_protocol"` 标记的脱敏协议样本，不能声称官方真实调用日志。仍活动的官方 runtime（T23 Claude）须按实际固定版本验证协议/schema与相应命令；JSON fixture 不替代真实验证。原 T22 schema/生成命令要求仅属冻结历史，当前 Codex 已退役，不安装/调用 CLI，不以旧要求恢复接入。

## 5. shared file 集成规则

任务主写模块文件；新增模块声明、根router、导航和manifest变更放该任务 `integration.patch` 交主Agent。主Agent应用后复跑目标测试。T01生成 contracts 的 script由xtask负责；Node端只消费生成文件+JSON Schema，不另写一套不一致类型。

小函数由当前任务定义并测试即可。C1–C8、公共 helper 和 HTTP/Editor/Provider 契约的变更须先提出 ADR。任务卡中的“产生”签名表示该任务要实现的接口，不保证基线中已经存在。

## 6. 保存与候选接受的事务补充（本计划明确新增）

正式文档与候选决定必须一起保存。SaveRequest 的 `suggestion_decisions` 为数组，`lease` 可空；普通编辑传空数组和 null。EditorDelta 返回本次逻辑操作的 suggestion_decisions，保存队列必须完整保留。

```ts
export interface SuggestionDecisionIntent {
  suggestion_set_id: string;
  change_ids: string[];
  decision: 'accept' | 'revert';
}
export interface SaveRequest {
  operation_id: string;
  base_revision_id: string;
  document: AnnotationDocument;
  lease: {task_id: string; fencing_token: number} | null;
  suggestion_decisions: SuggestionDecisionIntent[];
}
```

T01将其合并进正式生成类型，不能生成两个SaveRequest。T11对普通空数组保存；T19/T25实现候选验证和同一事务内保存decision。T26对任务内编辑验证lease；无任务的本地项目可null。任务过期/权限不足不得仅凭CAS成功继续写入。

POST suggestions/{id}/decision 仅用于 reject 和对已保存决定的查询/幂等确认，**不能脱离保存事务接受正式变更**。undo接受操作会产生revert intent；redo产生accept intent。提交/撤销对同一change的状态迁移按保存操作顺序记录，不能静默去重掉accept→revert。

保存多个未同步逻辑操作时，保留有序intent journal；数据库校验最终文档及完整有效序列。源预测不可改。

新增管理路由：`POST /api/users {username,password}` 仅平台管理员，用于本地多角色审核；`GET /api/users` 仅管理员列出id/username，不返回密码hash。T10负责，密码Argon2id；v0.1不做公网注册和在线自助找回。本机已有管理员的一次性密码恢复是独立维护入口，见[运维](operations.md#管理员密码恢复)。

管理员恢复回归使用项目内synthetic SQLite，不接触真实数据：原user_id/用户名/成员身份和其他用户凭证不变；目标sessions撤销与journal同事务；错误/过期码、UTF-8边界、限流/Retry-After、Host/Origin/普通CSRF隔离、故障回滚/重试、目标角色复核、空库/scrubbed拒绝、消费ID重启拒绝。覆盖POST先于GET的未知结果结算及GET先于POST的公平等待，不用固定延时掩盖race；直接二进制验证同库OS锁和退出后重启，根router验证完成后仍503维护。

Web检查旧cookie覆盖、字段确认/单飞、明确无写入拒绝与未知结果分流、错请求ACK及只读核对，不自动重POST。最终真实buildRelease/startLocal+浏览器闭环与CLI消费ID拒绝另有证据，synthetic route/mock或页面能开不替代。截图清空/隐藏凭证，不存code/password/cookie/CSRF；不清IndexedDB来证明恢复。


## 7. BBoxInstance 的固定初版布局

T05的实例结构采用 `#[repr(C)]`：bounds:[f32;4]、color:[f32;4]、flags:u32、padding:[u32;3]，大小48字节。WGSL读取相同布局；不使用Rust bool映射GPU。未来改变需同时更新布局测试与shader，不能只改一侧。

## 8. 临时编辑导出不是数据集快照

T14实现 `POST /api/annotation-revisions/{id}/exports`，以单个已保存不可变版本输出canonical图及检测标签，用于T15人工闭环；产物挂通用jobs并通过鉴权download读取。T27增加多图DatasetVersion冻结，不改变T14输出的坐标和信息损失语义。

未保存草稿的救援下载是原生格式，明确标记unsynced，不能冒充审核数据集。

## 9. 活动验收输出隔离

`tests/support/report-paths.mjs::taskReportPath(taskId,...segments)` 将输出放在 `WEBLABEL_TEST_REPORT_DIR/<taskId>`；未指定时使用进程唯一的项目内 `target/test-artifacts`。根及已有父目录先解析真实路径，不能经 junction 写到项目外。`WEBLABEL_T30_TEST_ROOT` 仍优先于通用报告根。历史 `reports/T29` 生产/assemble 和既有报告不属于新的输出目录。

活动 T33 使用 `tests/support/active-host-shutdown.mjs::activeHostShutdown(mode,release,{reportDir,skipSecurity})`；`reportDir` 必填，fixture 位于 `tests/fixtures/active-host-shutdown`，私有运行数据与 fixture 分离。`skipSecurity=true` 只排除并记录 unauthenticated START/no-consent START 两项权限探测，不改变实际 Ctrl+C、进程回收或服务守卫。旧 `reports/T33/active-host-shutdown` helper/报告冻结，不再由活动测试导入。

T31/T32 CLI 的 `--report-dir` 选择项目内本轮输出；T31 配置仍从 `reports/T31` 读取。未启动或缺测试报告时计数为 `null`，不能伪造零测试或复用旧结果。源码身份由 `scripts/evidence-identity.mjs::captureEvidenceIdentity()` 绑定实际文件集合与 SHA256，含未提交源码、migration、生成契约、检测 worker 和活动 T31 控制，不读取账号、权重或私人报告。

## 10. 手动模型与生产媒体 worker 分离

`WEBLABEL_TEST_MANUAL_MODEL_WORKER=1` 只暂停模型后台消费，媒体导入继续使用生产 worker。合成 fixture 用带真实 MIME 的上传与公开 canonical assets 列表等待，不调用模型 drain 充当媒体完成证明。T25 功能回归要求模型入队前后两张新合成图都实际完成 canonical，已入队 Engineering Mock 仍 queued 且无候选。

浏览器种子保留 20 PNG + 两张方向 JPEG 共 22 资产；T31 再上传两张 2048×2048 图后等 24，并逐名称验证真实 canonical metadata。媒体准备成功不证明 GPU 性能通过；2000/10000 对象、seed 17、每场景 40 warmup + 1000 submission 和既有 P95 阈值不变，只有实际硬件样本可作性能证据。
