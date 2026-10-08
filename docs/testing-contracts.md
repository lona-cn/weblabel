# 测试、装配与共享接口补充

本文件与 contracts.md 一起冻结。这里定义的是待实现测试接口，不是已有工具。

## 1. 测试用例可独立运行

T00 创建 crates 的 lib 与 bin 最小入口、Vitest workspace、Playwright config；所有 packages 名称固定：annotation-domain、geometry、editor-core、renderer-wgpu、wasm-bridge、dataset-formats、weblabel-api、xtask；JS packages 为 @weblabel/web、@weblabel/agent-host、@weblabel/contracts。workspace 根统一运行 pnpm exec vitest / playwright。

TASKS.json 中 argv 为窄测试入口；任务实现时要创建这些路径，不得改成全部测试绕过指定断言。出现环境失败时记录环境阻塞，不当成 Red 功能测试证据。测试 helper 在 tests/support/；任何额外 helper 必须在同一任务定义，不能留神秘全局对象。

Vitest 运行 TS 测试，tsconfig 引用 generated contracts；Playwright 用 `data-testid` 寻址。Rust integration test 文件统一小写 snake_case，例如 t03_geometry.rs；cargo --test 参数同名。Python使用 pytest，测试收集为零视为失败。所有 test ID 大小写以 manifest 为准。

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
```

每次启动独立临时目录/数据库，监听随机端口。生产代码提供启动 bootstrap 通道；测试捕获该管道，走真实登录/管理员创建用户接口，不插入万能绕过鉴权中间件。进程退出和测试失败也执行清理。只有 TEST build 允许 fault injection channel，release build不编译此入口。

真实API helper在每个worker首次使用前从当前源代码构建，不以可执行文件已存在替代新源码。Vitest integration的prepare-api setup在行为测试计时外编译，保持原测试deadline；显式WEBLABEL_API_BINARY仍表示调用者选择的可执行文件，不能把任意override当新源码证据。T26在beforeAll执行真实bootstrap、媒体准备和用户密码哈希/login；原5秒用例仍覆盖完整lease/fencing/CAS与不可变revision审核。T26临时local request observer只在既有fixture完成后包装五个原client，真实delegate仅调用一次并保持JSON消费/return/error/upload语义；START/END仅输出ordinal、时间、静态method/route模板与status，不输出live URL/ID/body/header/credential。完整原it的31请求、55行为/63全文件expect与5秒期限均不改；本地通过不证明Azure失败请求，需当次远端取证，收证后删除临时observer。T17每个beforeEach创建独立新API/数据库并完成真实管理员、媒体与角色fixture，setup失败和afterEach均清理自己拥有的进程。T29只将恢复用户创建、首次真实login及expired session准备放到已有beforeAll，stale/expired两种cookie的完整GET删除、错误密码、Origin/Host、重新登录、session与CSRF行为仍在同一个原5秒it内；F22两个原content/provider case各在beforeEach准备独立真实app/media/pins，initial authorize、实际输入变更、403拒绝/零model rows、fresh approval/202与cancel/200仍完整留在原5秒行为窗口，setup失败清除所有权后close、afterEach清理当次app。T10用户列表case只在scoped beforeEach完成fresh app/bootstrap/admin准备，创建用户、hash/date/identity检查、logout/relogin、角色/cookie与401仍在原5秒it内。T27只前置fresh app/scratch/bootstrap与初始approved r8，原单case完整unready拒绝、固定snapshot/r9新审核、幂等冲突、native/YOLO/COCO/multi-image/negative与download scope断言仍在同一5秒窗口；部分setup失败、case finally和afterEach先清除所有权再清理scratch/自己拥有的API，不以guard重复stop外来进程。全部case计数与领域/权限断言不变，不将冷setup计入行为窗口。

T25测试helper的manual模式仅在debug构建显式设置WEBLABEL_TEST_MANUAL_MODEL_WORKER=1，让故障/脚本fixture拥有排空顺序；background模式运行服务原生模型worker。release忽略该开关。database_path_for_test只返回该helper自己创建的临时数据库路径，不能访问真实项目库。

T33九个连接到live API库的writable DatabaseSync fixture各设置一次PRAGMA busy_timeout=1000，readonly/offline连接不改；保留13用例与16-field immutable audit矩阵及完整源history/hash/保密断言，不做应用重试或停掉background worker。独立writer的原0预算失败、1000ms耗尽不改行、page-changing commit后的单次成功与durable读回只证明fixture contention边界，具体远端持锁身份未实证。后台seed用单次1000ms SQLite busy handler与BEGIN IMMEDIATE取得writer后插入测试profile，成功commit、失败close回滚，不做应用重试；一次drain后按upload的import_job_id只读等待原5秒内的真实succeeded/media_import/1-of-1，后台先claim时processed=0不冒充导入失败。仍校验唯一canonical资产、annotation版本及完整内容。T29源library/router与production扫描统一遵守CARGO_TARGET_DIR和调用者Cargo cwd，从repo数字pin选择真实host compiler，不用发行普通API替代安全fixture。文件grant消费者实际读取resolve返回路径并校验与批准图像相同的字节，不把Windows长路径与NTFS 8.3别名的字符串拼写当作文件identity；真实junction/symlink逃逸、portable绕过、foreign binding与revocation断言不变，生产canonical containment算法不改。

T17 保持原30秒retention lease、2100事件生产、2000窗口与104..2103的真实API分页/replay断言；silent runner、持有writer的item与expiry/replacement-worker回调必须覆盖真实Queue/SQLite行为。权限丢失后立即提交新provider identity和合法candidate，校验event/prediction/suggestion计数及foreign authority不变，不靠等待下一个heartbeat拒绝输出。T16 的owned child在第二次spawn/setup之前进入清理作用域；Linux真实broker故障仍以private capability的单次5秒cached failure拒绝成功，不以裸PID或空killed列表假报SIGKILL。

T06 的原120ms写锁冲突预算、2秒上界及解锁后recovery断言不变；首次冷迁移不是放宽预算的理由。新增真实SQLite消费者回归由独立Repository确认abandon/task-abort写入均回滚，恢复writer提交后精确读回，不断言连接identity。临时native smoke另覆盖timeout/取消pending BEGIN及deferred-FK COMMIT失败后无残留行/锁；成功归池、失败关闭的源码审查不以SQLx库名字代替取消安全证明。
T10 bootstrap竞争验证使用真实新数据库/API、后台export worker和独立SQLite writer，不把一次无竞争200或归档能启动当作竞争闭环。临时native smoke覆盖保留空writer及提交页变更的writer、原配置预算耗尽后无半写入、解锁后的显式新请求、session/CSRF和one-use replay，以及恢复资格拒绝/成功；自然相位复现只比较每个fresh app的首次请求，不自动重试或移除失败样本。单Tokio worker仅用于复现实验，非CI/生产配置修复；诊断仅记录静态阶段和SQLite数字码，收证后删除instrumentation。不添加依赖任意sleep/内部trace callback的永久测试或生产test hook；保留真实before/after日志，完整双平台源码CI和当次归档消费仍为发布gate。
CI完整Rust workspace明确使用--test-threads=2，Vitest使用--maxWorkers=2，以限制同机SQLite、Tokio runtime、Node/CIM消费者并发；不删除用例、不改变原2秒Host timeout/30秒lease/120ms锁预算/5秒行为期限或原请求次数断言。这是已实测的资源政策，不将单次未保留终态事件的0调用失败归因到CPU/冷文件系统，也不保证任意外部过载下必定在provider启动前完成。
T33真实Windows ConPTY将当前唯一C#interop源码在原600秒beforeAll内编译到fresh owned DLL；物理runtime以标准CLR Assembly.LoadFrom加载调用者提供且SHA256不变的prepared DLL，不重入Add-Type的Utility/cmdlet/CodeDom初始化，不保留inline编译旧路径。集成test与standalone CLI均先准备真实assembly，实际DLL加载/ConPTY/CreateProcess/API仍在原20秒bootstrap条件内，物理case原120秒不变。错误信息区分编译、assembly load、ConPTY/CreateProcess、首输出、token观察和实际session端点条件，先去VT控制再脱敏launch code，静态phase只输出名称/时间。bootstrap等待期间即捕获自己启动PID的creation identity，失败清理仍要求同一creation_filetime与自己拥有的命令路径；release路径只做native separator归一化，不以裸PID或acceptance前taskkill冒充物理关闭。原报告路径和CLI消费者不变。本地headless/慢真实编译实验不替代当次GitHub Windows物理lane实证，实际PS5.1 IL确认Add-Type即使载入DLL仍构造CSharpCodeProvider；本地fresh DLL的restricted/full env比较与真实两mode只能证明标准loader省去无关初始化、保持完整物理/API行为，不证明Azure阻塞的更深子阶段，也不把已观测未完成阶段归因到未实证的CPU/杀毒/环境原因。临时关闭取证仅在原ctrl_c/serving/watch-send/全部worker-await边界输出四个静态phase；native原30000ms失败点先读取仍open的pinned API/root/descendant handle并记录数字exit与signal/error时间，失败断言复用既有VT/launch-code脱敏后展示原输出。信号、等待、成功JSON与41个断言不变；workers_joined不等于Tokio runtime blocking-task回收完成，packaged launcher原force termination也不证明原生graceful退出。实际远端根因仍未知，收证后删除这些临时diagnostic。
固定业务fixture由 T01 提供 `tests/fixtures/golden/{ontology,media,document,save,prediction}.json`；对象ID `object_person_001`，类别ID `label_person`，640×480，bbox[10,20,110,220]，helmet_state默认unknown。测试 fixture ID 不受UUID生成器限制：Id验证是非空受限字符串，生产新ID用UUID。

## 3. Playwright fixture：T15建立

`tests/e2e/fixtures.ts` 导出扩展后的 `test` 和 `expect`，提供 app、adminPage、seededProject 三个 fixture。seededProject 通过真实 API 导入程序化图像，包含 project_id、asset_revision_id、base_revision_id；adminPage已真实登录，指向该项目工作台。

主 data-testid：

| ID | 定义 |
|---|---|
| project-create / project-name / project-submit | 项目创建表单 |
| media-import / asset-grid / asset-item-{id} | 文件input、列表、媒体项 |
| annotation-canvas / gpu-status / tool-box / tool-select / tool-pan | 画布、诊断与工具 |
| object-list / object-item-{id} / attribute-{key} | 虚拟对象列表和属性控件 |
| save-status / undo / redo / image-next / image-prev | 保存与编辑 |
| ai-provider / ai-prompt / ai-consent / ai-run / ai-cancel | 模型和明确授权 |
| ai-status / candidate-{change_id} / accept-selected / reject-selected | 候选、差异和决定 |
| task-submit / review-approve / review-reject | 指定版本审核 |
| snapshot-create / export-format / export-start / export-download | 固定快照导出 |
| recovery-banner / conflict-banner / export-local-draft | 恢复与失败救援 |

gpu-status 暴露文本/可测试属性 actual_backend=webgpu、adapter_kind=hardware/software/unknown、device_state=loading/ready/lost/recovering/unsupported；不以浏览器支持检查代替真实 device 创建。设备重建中显示recovering且Canvas只读，成功才恢复ready；失败保持lost和GPU_RECOVERY_FAILED诊断，gpu-retry显式重试renderer-only恢复。GPUDevice.destroy必须通过真实device.lost观测并自动触发重建，不调用simulate_device_loss。

测试中需要获取文档时调用正常的 GET annotation API或 Editor 测试 facade；测试 facade只在测试构建可用，不能让生产页面暴露任意内部命令绕过权限。截图只用于可视效果；几何、标签和保存必须用原始数值断言。

## 4. Provider fake-process 契约：T16建立

`tests/support/fake-runtime.mjs` 是无网络子进程，接收环境变量 TEST_SCENARIO（normal / malformed / oversized / crash / slow / spawn_child），从stdio读版本化协议并发送确定性测试响应。它不能命名为真实 provider，不能被生产profile枚举。生产注册表在测试注入点之外永远不包含它。

`apps/agent-host/test/fixtures/` 保存带 `fixture_kind: "synthetic_protocol"` 标记的脱敏协议样本。不能声称是官方真实调用日志。T22/T23 同时保留从所固定 CLI 生成的真实协议schema和生成命令，JSON fixture不得代替schema验证。

## 5. shared file 集成规则

任务主写模块文件；新增模块声明、根router、导航和manifest变更放该任务 `integration.patch` 交主Agent。主Agent应用后复跑目标测试。T01生成 contracts 的 script由xtask负责；Node端只消费生成文件+JSON Schema，不另写一套不一致类型。

新增小函数可由当前任务定义并测试；不得改变 C1–C8、上述公共 helper 或 HTTP/Editor/Provider契约而不提出 ADR。每个任务卡列出的“产生”签名是它负责实现的新接口，不是既有接口。

## 6. 保存与候选接受的事务补充（本计划明确新增）

为避免“文档保存了，但预测接受记录丢了”，SaveRequest 增加 `suggestion_decisions` 数组和可空 `lease`；普通编辑传空数组和null。EditorDelta 同步返回该逻辑操作产生的 suggestion_decisions，保存队列不能丢掉它们。

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

POST suggestions/{id}/decision 仅用于 reject 和对已保存决定的查询/幂等确认，**不能脱离保存事务接受正式变更**。undo接受操作会产生revert intent；redo产生accept intent。提交/撤销对同一change的状态迁移按保存操作顺序记录，不能静默去重掉accept→revert。保存多个未同步逻辑操作时，保留有序intent journal；数据库校验最终文档及完整有效序列。源预测不可改。

新增管理路由：`POST /api/users {username,password}` 仅平台管理员，用于本地多角色审核；`GET /api/users` 仅管理员列出id/username，不返回密码hash。T10负责，密码Argon2id，返回一次性登录提示而非明文长期日志；v0.1不做公网注册和密码找回。


## 7. BBoxInstance 的固定初版布局

T05的实例结构采用 `#[repr(C)]`：bounds:[f32;4]、color:[f32;4]、flags:u32、padding:[u32;3]，大小48字节。WGSL读取相同布局；不使用Rust bool映射GPU。未来改变需同时更新布局测试与shader，不能只改一侧。

## 8. 临时编辑导出不是数据集快照

T14实现 `POST /api/annotation-revisions/{id}/exports`，以单个已保存不可变版本输出canonical图及检测标签，用于T15人工闭环；产物挂通用jobs并通过鉴权download读取。T27增加多图DatasetVersion冻结，不改变T14输出的坐标和信息损失语义。未保存草稿的救援下载是原生格式，明确标记unsynced，不能冒充审核数据集。
