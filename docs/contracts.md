# 契约 v1：跨 Agent 共同接口

本文件冻结语义。T01 在 crates/annotation-domain 中定义 Rust wire 类型，使用 serde/schemars/ts-rs 生成 JSON Schema 与 TypeScript 到 packages/contracts/generated。Node 端通过 `@weblabel/contracts/validate` 直接消费生成的 JSON Schema，不再维护第二套 DTO；`pnpm contracts:check` 重生成到临时目录并做差异检查。

## C1. 序列化与错误

所有 wire 字段 snake_case。ID 为非空、不透明字符串，最多 128 字符，不从文件名推导；真实数据使用 UUID。Option 在 wire 上固定为显式 null，禁止某端省略某端要求 null。属性只支持 string/boolean/finite number/null；必填字段规则来自 ontology。最大嵌套深度 16，字符串属性 ≤4096 字符，类别名 ≤128 字符。

所有时间为 UTC RFC3339。所有 generation/revision_no/seq 为非负安全整数（≤2^53-1）。禁止 NaN/Infinity 和未知 geometry discriminant。服务端返回 ApiError，UI 根据 code 分支，不解析 message。

```ts
export type Id = string;
export type Scalar = string | number | boolean | null;
export type Attrs = Record<string, Scalar>;
export interface ApiError {
  code: string;
  message: string;
  request_id: Id;
  details: Record<string, unknown> | null;
}
export interface BBox {
  type: 'bbox_xyxy';
  x_min: number; y_min: number; x_max: number; y_max: number;
}
export type Completion = 'unprocessed' | 'in_progress' | 'complete' | 'confirmed_negative';
export interface Origin {
  type: 'manual' | 'import' | 'prediction';
  prediction_id: Id | null;
  model_run_id: Id | null;
  import_batch_id: Id | null;
}
export interface AnnotationObject {
  object_id: Id;
  label_id: Id;
  geometry: BBox;
  attributes: Attrs;
  origin: Origin;
}
export interface AnnotationDocument {
  schema_version: 1;
  asset_revision_id: Id;
  ontology_version_id: Id;
  coordinate_space: { type: 'canonical_image_pixels'; width: number; height: number };
  completion: Completion;
  objects: AnnotationObject[];
}
export interface AnnotationRevision {
  annotation_revision_id: Id;
  parent_revision_id: Id | null;
  revision_no: number;
  document: AnnotationDocument;
  created_at: string;
  created_by: Id;
  content_hash: string;
}
export interface SuggestionDecisionIntent {
  suggestion_set_id: Id; change_ids: Id[]; decision: 'accept' | 'revert';
}
export interface SaveRequest {
  operation_id: Id; base_revision_id: Id; document: AnnotationDocument;
  lease: {task_id: Id; fencing_token: number} | null;
  suggestion_decisions: SuggestionDecisionIntent[];
}
export interface SaveResponse {
  operation_id: Id;
  revision: AnnotationRevision;
  idempotent_replay: boolean;
}
```

Import 完成时创建 revision_no=1、parent=null 的初始版本；后续保存的 base_revision_id 不为 null。audit 字段由服务端写，客户端不能自报 created_by。origin 中的 prediction/import 引用必须真实存在且归属同项目同资产。

HTTP 400=非法 JSON；401=未认证；403=无权限/外发被禁；404=不存在或无权暴露的跨项目资源；409=冲突/幂等复用/租约冲突；413=预算超限；422=领域校验失败；429=限额；503=运行时不可用。错误详情不得泄露密钥、其他项目路径或供应商 token。

## C2. Ontology 与媒体

```ts
export interface AttributeDef {
  key: string;
  kind: 'enum' | 'boolean' | 'number' | 'text';
  required: boolean;
  default_value: Scalar;
  enum_values: string[];
  min: number | null;
  max: number | null;
}
export interface LabelDef {
  label_id: Id; name: string; color: string;
  shortcut: string | null;
  allowed_geometry_types: ['bbox_xyxy'];
  attributes: AttributeDef[];
}
export interface OntologyVersion {
  ontology_version_id: Id; project_id: Id; version_no: number;
  labels: LabelDef[]; guidelines_markdown: string;
  allow_out_of_bounds: false;
}
export interface MediaRevision {
  asset_id: Id; asset_revision_id: Id; project_id: Id;
  original_name: string; original_sha256: string;
  canonical_sha256: string; canonical_width: number; canonical_height: number;
  exif_orientation: number;
  original_to_canonical: number[]; // row-major 3x3，长度严格为 9
  source_group_id: Id;
}
```

发布 ontology 创建新 ID；已有任务和文档继续引用旧版。v0.1 禁止后台直接原位删除已使用类别。新规范迁移为显式复制文档并生成新版本，需要显示变更报告。

## C3. 编辑 facade 与 Rust 核心

```ts
export interface Viewport { scale: number; tx: number; ty: number; css_width: number; css_height: number; dpr: number }
export interface PointerInput {
  phase: 'down' | 'move' | 'up' | 'cancel';
  pointer_id: number; x_css: number; y_css: number;
  button: number; buttons: number;
  shift: boolean; ctrl: boolean; alt: boolean; meta: boolean;
}
export type EditorCommand =
  | {kind: 'create'; object: AnnotationObject}
  | {kind: 'replace_geometry'; object_id: Id; geometry: BBox}
  | {kind: 'set_attributes'; object_ids: Id[]; values: Attrs}
  | {kind: 'set_label'; object_ids: Id[]; label_id: Id}
  | {kind: 'delete'; object_ids: Id[]}
  | {kind: 'duplicate'; object_ids: Id[]; new_ids: Id[]}
  | {kind: 'set_completion'; completion: Completion}
  | {kind: 'apply_suggestions'; set: SuggestionSet; change_ids: Id[]; expected_generation: number}
  | {kind: 'undo'} | {kind: 'redo'};
export interface EditorDelta {
  generation: number;
  changed_objects: AnnotationObject[];
  removed_object_ids: Id[];
  selected_object_ids: Id[];
  can_undo: boolean; can_redo: boolean;
  document_changed: boolean; repaint: boolean;
  suggestion_decisions: SuggestionDecisionIntent[];
  error: ApiError | null;
}
export interface EditorFacade {
  dispatch(command: EditorCommand): EditorDelta;
  pointer(input: PointerInput): EditorDelta;
  set_tool(tool: 'select' | 'box' | 'pan'): void;
  set_active_label(label_id: Id): void;
  set_viewport(view: Viewport): void;
  zoom_at(x_css: number, y_css: number, factor: number): void;
  fit_image(): void;
  set_selection(ids: Id[]): EditorDelta;
  set_local_flags(ids: Id[], flags: { hidden?: boolean; locked?: boolean }): EditorDelta;
  get_snapshot(): AnnotationDocument;
  get_generation(): number;
  set_predictions(sets: SuggestionSet[]): void;
  render(timestamp_ms: number): void;
  dispose(): void;
}
export function create_editor(
  canvas: HTMLCanvasElement,
  media: MediaRevision,
  ontology: OntologyVersion,
  document: AnnotationDocument,
  canonical_rgba: Uint8Array,
): Promise<EditorFacade>;
```

C3 的 flags 只属于编辑器会话，不进入保存文档。业务 UI 可持有不可修改的 changed_objects 投影；不直接 mutate。pointer move 只更新交互预览，不增加 generation，不触发完整快照或网络；pointer up 形成一个 command 才增加 generation。set_viewport/selection/hide 不改变业务 generation。取消/无效操作不增加 generation。undo/redo 改变文档且 generation 单调递增，不倒退。

Rust 函数边界：`geometry::image_to_css([f64;2], Viewport)->[f64;2]`、`css_to_image`、`validate_bbox(&BBox,w:u32,h:u32)->Result<(),DomainError>`；`editor_core::Editor::new(document,ontology)->Result<Editor,DomainError>`；`Editor::dispatch(EditorCommand)->Result<EditorDelta,DomainError>`；`Editor::snapshot()->AnnotationDocument`。渲染模块依赖只读 render scene，不反向修改 Editor。

WASM public facade 按 C3 命名；内部 JsValue/serde_wasm_bindgen 包装留在 wasm-bridge。`dispose` 释放监听、rAF、图像和 GPU 引用；重复调用无副作用。create_editor 异步完成时需匹配当前 asset token，旧图片初始化结果不得挂到新图片 Canvas。

## C4. 候选与模型运行

```ts
export type ProviderId = 'codex_local' | 'claude_local' | 'openai_api' | 'anthropic_api' | 'mimo_api' | 'detector_local' | 'mock';
export interface ModelProfile {
  profile_id: Id; provider_id: ProviderId; model_id: string;
  auth_kind: 'official_user_login' | 'api_key' | 'local_weights' | 'none';
  capabilities: { image_input: boolean; tools: boolean; structured_output: boolean; bbox_output: boolean; attributes: boolean };
  availability: 'ready' | 'needs_login' | 'needs_configuration' | 'unsupported' | 'blocked';
  verification: 'not_run' | 'mock_only' | 'live_passed' | 'live_failed';
  runtime_version: string | null;
  verified_at: string | null;
}
export interface RunContext {
  project_id: Id; asset_revision_id: Id; annotation_revision_id: Id;
  ontology_version_id: Id; draft_generation: number;
  canonical_sha256: string; selected_object_ids: Id[];
  object_hashes: Record<Id, string>;
  input_fingerprint: string;
}
export interface StartRunRequest {
  operation_id: Id; profile_id: Id; context: RunContext;
  intent: 'detect' | 'audit_attributes' | 'find_issues';
  prompt: string;
  consent_id: Id | null;
}
export type Change =
  | {change_id: Id; kind: 'create'; object: AnnotationObject; before_hash: null; reason: string}
  | {change_id: Id; kind: 'set_attributes'; object_id: Id; values: Attrs; before_hash: string; reason: string}
  | {change_id: Id; kind: 'set_label'; object_id: Id; label_id: Id; before_hash: string; reason: string};
export interface QualityIssue {
  issue_id: Id; object_id: Id | null; code: string;
  message: string; region: BBox | null;
}
export interface SuggestionSet {
  suggestion_set_id: Id; model_run_id: Id; prediction_id: Id;
  context: RunContext; changes: Change[]; issues: QualityIssue[];
  score: number | null;
  state: 'pending' | 'stale' | 'rejected' | 'partially_accepted' | 'accepted';
}
export interface RunEvent {
  run_id: Id; seq: number;
  type: 'queued' | 'started' | 'progress' | 'tool_call' | 'candidate' | 'succeeded' | 'failed' | 'cancelled';
  message: string;
  data: Record<string, unknown> | null;
}
```

原始 provider 输出、usage、预处理变换单独保存为 Prediction/ModelRun 内部记录；API 返回做过大小限制和敏感信息处理的内容，不给前端任意文件路径。SuggestionSet.state 可变化，Prediction 内容不可覆盖。

`object_hash` 由 annotation-domain 的共享 Rust 规范化函数产生：按固定字段顺序包含 label、bbox 和排序后的 attributes；排除显示 flags 和 audit 时间。WASM 和服务端使用同函数，JS 不自行拼 JSON 算哈希。T01 用同一 golden fixture 交叉验证。request_hash 与 input_fingerprint 同样明确定义、包含全部相关输入和 provider profile 版本。

接受候选必须同时验证 asset/ontology/revision、当前 generation、object hash、类别/属性和 change_id 未重复接受。首期整批原子接受；任何一项失败整批不改。部分接受是用户选择一个子集后重新形成独立原子命令。撤销不删除原始预测；接受关系可以变为 reverted 并保留审计。

`Create` 只允许 detector 或显式启用 bbox_output 的 profile；VLM 属性审校不允许改变 bbox、创建/删除正式对象。模型返回不在 allowed_ops 中的动作以 422 拒绝，不能偷偷照做。

## C5. ProviderAdapter 与私有 Host 协议

```ts
export interface ProviderAdapter {
  probe(): Promise<ModelProfile[]>;
  run(input: StartRunRequest, ctx: RuntimeContext, signal: AbortSignal): AsyncIterable<RunEvent>;
}
export interface RuntimeContext {
  run_id: Id;
  read_region(grant_id: Id, region: BBox | null): Promise<{ bytes: Uint8Array; mime: 'image/png'; transform_to_canonical: number[] }>;
  get_document(): Promise<AnnotationDocument>;
  get_ontology(): Promise<OntologyVersion>;
  submit_candidates(candidate: unknown): Promise<SuggestionSet>;
  report_issues(issues: unknown): Promise<void>;
}
export interface RuntimeEnvelope {
  protocol_version: 1;
  id: Id;
  kind: 'request' | 'response' | 'event';
  method: 'probe' | 'start_run' | 'cancel_run' | 'shutdown' | 'run_event';
  payload: unknown;
}
```

Unknown 在契约入口立即按 JSON Schema 验证，不能以 `any` 流遍业务。NDJSON 一行一消息，单行 ≤4 MiB，stdout 专用；stderr 日志脱敏。图片字节不塞入该行：API 创建运行暂存 grant，Host/Worker 只获得已批准映射。每个 request 必有 response；超时、重复 ID、未知 method、进程退出、截断/超长行必须被测试。协议错误终止本次运行，不重启后自动重发可能已计费调用。

MCP 入口是 Agent Host 包中的独立 stdio 命令。Codex/Claude 只安装本项目 server 配置，不读取项目里任意第三方 MCP 配置。它通过 loopback `/internal/agent-tools/{tool}` 与 API 通信，使用专门生成的短期 run-scoped Bearer，不能使用管理员 session。token 只在子进程环境/私有通道传递，不在 argv、工具参数或输出里传递；到期/取消后立即失效。

允许工具及参数：

| 工具 | 输入 | 输出/权限 |
|---|---|---|
| get_context | {} | 当前 run 的规范、版本、用户意图，不能换项目 |
| list_objects | {cursor:null|string,limit:1..100} | 当前作用范围内对象、bbox、attributes、object_hash |
| read_region | {region:BBox|null} | 已授权图像/crop及变换；消耗 crop/pixel 预算 |
| propose_changes | {changes:Change[]} | 校验后存候选，不能直接接受 |
| report_issues | {issues:QualityIssue[]} | 保存疑似问题，不写审核结论 |

服务端由 token 查 context，不相信 Agent 传入的 project_id。对于 API provider，可以直接复用 RuntimeContext 函数，不必通过 MCP 再绕网络。

## C6. HTTP 路由清单

响应 JSON 的 DTO 均由 T01/T10 对上述实体生成。列表统一 `{items:[], next_cursor:null|string}`，时间/数量使用明确字段；T01 先生成核心 DTO，后续新增通过主 Agent 批准契约变更。

| 方法/路径 | 请求与返回 | 所属任务 |
|---|---|---|
| POST /api/session/bootstrap | {launch_code,password} → session cookie + csrf_token + local-admin identity; password is chosen by the user and never echoed | T10 |
| POST /api/session/login | {username,password} → session + csrf_token | T10 |
| POST /api/session/logout | 清除服务端 session | T10 |
| GET /api/session | 当前 principal、项目角色 | T10 |
| GET/POST /api/projects | 列表 / {name,description,allow_self_review} → project | T10 |
| POST /api/projects/{id}/members | {user_id,role} → membership | T10 |
| GET/POST /api/projects/{id}/ontologies | 已发布规范 / 发布不可变版本 | T10 |
| POST /api/projects/{id}/assets | multipart images → import_job_id | T07 |
| GET /api/projects/{id}/assets | cursor/limit/filter → media 列表 | T07 |
| GET /api/assets/{asset_revision_id}/image | 鉴权 canonical 图片，ETag 为哈希 | T07 |
| GET /api/assets/{asset_revision_id}/annotation | query ontology_version_id，读取指定规范的head | T11 |
| GET /api/annotation-revisions/{id} | 鉴权不可变历史版本，审核使用 | T11 |
| PUT /api/assets/{asset_revision_id}/annotation | SaveRequest → SaveResponse | T11 |
| POST /api/projects/{id}/imports/preview | 文件/映射 → report_id | T14 |
| POST /api/projects/{id}/imports/commit | {report_id,operation_id,loss_ack} → job_id | T14 |
| GET /api/jobs/{id} | 作业状态、逐资产结果 | T17 |
| GET /api/model-profiles | 配置/能力/验证状态，不返回密钥 | T16 |
| POST /api/ai/consents | {profile_id,input_fingerprint,approved_grants} → consent_id | T25 |
| POST /api/ai/runs | StartRunRequest → run_id | T25 |
| GET /api/ai/runs/{id}/events | after=seq → 事件分页 | T17 |
| GET /api/ai/runs/{id}/suggestions | 候选集合 | T17 |
| POST /api/ai/runs/{id}/cancel | 幂等取消 | T25 |
| POST /api/ai/suggestions/{id}/decision | 拒绝/幂等确认；接受必须随SaveRequest同事务 | T19/T25 |
| POST/GET /api/projects/{id}/tasks | 创建/列出任务 | T26 |
| POST /api/tasks/{id}/lease | acquire/renew/release + fencing token | T26 |
| POST /api/tasks/{id}/submit | 指定 annotation revisions → review request | T26 |
| POST /api/reviews/{id}/decision | approve/reject + reason + revision IDs | T26 |
| POST /api/projects/{id}/dataset-versions | 指定 revisions/split → immutable snapshot | T27 |
| POST /api/dataset-versions/{id}/exports | format,loss_ack,operation_id → export job | T27 |
| POST /api/annotation-revisions/{id}/exports | 单个不可变版本的检测导出，format/loss_ack/operation_id | T14 |
| GET /api/exports/{id}/download | 鉴权文件 + 报告；T27扩展数据集输出 | T14/T27 |
| POST /internal/agent-tools/{tool} | run-scoped token，不接受 session cookie | T21 |

`/api/jobs` 由 T07 临时实现通用 schema 的 media job，T17 扩展同一 job engine，不能另外做两种互不兼容的 job。T07 不提前增加模型队列逻辑。

v0.1 使用 polling，active job/run 每 500ms，后台/idle 2s；支持 after seq，取消轮询并按 asset/run 隔离缓存。不同时实现 SSE/WebSocket。停止/恢复轮询不能重新提交模型请求。

T14的单图导出用于G1，读取一个不可变revision并将产物引用存入通用jobs结果，不假称DatasetVersion。T27才添加固定多图快照；两种导出共用安全下载服务，不建立临时无鉴权下载路径。

POST /api/users 与 GET /api/users 的管理员接口由 testing-contracts.md §6定义，T10实现。

## C7. SQLite 表与不可变对象

T06 预留 migrations 0001_core：users/sessions/projects/memberships/ontology_versions/media_assets/media_revisions/annotation_revisions/annotation_heads/idempotency_keys/jobs/job_items。T17 增加 0002_ai：model_profiles/model_runs/predictions/suggestion_sets/suggestion_decisions/run_events/consents。T26 增加 0003_workflow：tasks/task_items/task_leases/review_requests/review_decisions/review_issues。T27 增加 0004_datasets：dataset_versions/dataset_items/export_jobs。禁止多个 Agent 同时分配 migration 编号。

外键开启；关键关联包含 project_id 校验，head unique(asset_revision_id,ontology_version_id)。idempotency unique(actor_id,operation_id,operation_kind)。作业 lease 与任务租约分开；重启恢复 running job 为 interrupted/retryable，并且模型调用存在费用不确定性时要求显式重试。

文件路径只由 SHA256/内部 ID 生成。先写临时文件、fsync/原子 rename，再提交 DB 引用；崩溃可能遗留孤儿文件，但不能创建引用不存在文件的已完成记录。删除/GC 不是 v0.1 必需功能，不实现“清理全部”按钮。

## C8. 固定测试向量

Golden image：W=640,H=480；bbox=[10,20,110,220]。YOLO 输出 center=(0.09375,0.25), size=(0.15625,0.4166666666666667)；COCO=[10,20,100,200]。导出再导入的最大绝对坐标误差 ≤1e-6 pixel（文本保留足够有效位）。

Viewport：scale=2,tx=13,ty=-7，image(10,20)→CSS(33,33)；DPR=1/1.25/2/3 不改变此结果。当前鼠标 CSS(33,33)，缩放到 scale=4 后 translation=(-7,-47)，锚点仍是 image(10,20)。

Save：head=r7，op=a 基于 r7 写入 docA 得到 r8；重试 a/docA 返回 r8 replay=true；a/docB 返回409；op=b/base=r7 返回409；期间有本地 generation9，generation8 ACK 不能清掉 generation9 dirty。

AI：runA 绑定 assetA/r8/generation8；切到 assetB 后 runA 返回只能出现在 assetA；编辑对象使 hash 从 h1→h2，包含 before_hash=h1 的变更必须拒绝；AI 修改 bbox 的属性审校响应必须422。

Review：批准 r8，保存 r9 后 r8 保留 approved，r9=pending/unsubmitted；snapshot S 固定 r8，r9 的创建不能改变 S 的导出 hash。
