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
export function start_test_app(): Promise<TestApp>;
```

每次启动独立临时目录/数据库，监听随机端口。生产代码提供启动 bootstrap 通道；测试捕获该管道，走真实登录/管理员创建用户接口，不插入万能绕过鉴权中间件。进程退出和测试失败也执行清理。只有 TEST build 允许 fault injection channel，release build不编译此入口。

真实API helper在每个worker首次使用前从当前源代码构建，不以可执行文件已存在替代新源码。Vitest integration的prepare-api setup在行为测试计时外编译，保持原测试deadline；显式WEBLABEL_API_BINARY仍表示调用者选择的可执行文件，不能把任意override当新源码证据。

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

gpu-status 暴露文本/可测试属性 actual_backend=webgpu、adapter_kind=hardware/software/unknown、device_state=ready/lost/unsupported；不以浏览器支持检查代替真实 device 创建。

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
