# 契约 v1：跨 Agent 共同接口

供跨端接口维护者实现和核对契约 v1。改文字不改变下列类型、字段、数值、路由或不变量；行为变更须同步更新所有消费者、生成物和测试。

Rust wire 类型定义在 crates/annotation-domain，使用 serde/schemars/ts-rs 生成 JSON Schema 与 TypeScript 到 packages/contracts/generated。Node 通过 `@weblabel/contracts/validate` 消费同一 JSON Schema，不另建 DTO。

`pnpm contracts:check` 在临时目录重生成并检查差异。

## C1. 序列化与错误

所有 wire 字段 snake_case。ID 为非空、不透明字符串，最多 128 字符，不从文件名推导；真实数据使用 UUID。Option 在 wire 上固定为显式 null，禁止某端省略某端要求 null。属性只支持 string/boolean/finite number/null；必填字段规则来自 ontology。

最大嵌套深度 16，字符串属性 ≤4096 字符，类别名 ≤128 字符。

所有时间为 UTC RFC3339。所有 generation/revision_no/seq 为非负安全整数（≤2^53-1）。禁止 NaN/Infinity 和未知 geometry discriminant。服务端返回 ApiError，UI 根据 code 分支，不解析 message。

Rust JSON入口与落盘读取使用正确舍入的f64解析（serde_json启用float_roundtrip）；合法分数坐标的最短可往返JSON不能在保存/读取后漂移一位。相同未编辑对象的wire数值与AI before_hash必须保持一致；禁止坐标取整、epsilon比较或重新钉死变化后的hash掩盖解析损失。

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

导入完成时创建初始版本：revision_no=1、parent=null。后续保存必须携带非 null 的 base_revision_id。

audit 由服务端写入，客户端不能自报 created_by。origin 中 prediction/import 引用必须真实存在，并归属同一项目、同一资产。

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
发布时先拒绝非项目 Admin，再以 `BEGIN IMMEDIATE` 获取 SQLite writer lock；在同一事务内重新确认当前 membership 为 Admin、读取 `MAX(version_no)`、插入新版本并提交。等待锁期间被降权或移除的请求分别返回 `403 PROJECT_ADMIN_REQUIRED` / `404 PROJECT_NOT_FOUND`，不分配或写入版本；后台 writer 与并发发布不能使旧 WAL read snapshot 升级失败或产生重复 version_no。

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
export interface CommitReadback extends Omit<AnnotationDocument, 'objects'> {
  generation: number;
  object_count: number;
  changed_positions: number[]; // 与changed_ids一一对应的原生canonical对象顺序slot
}
export interface EditorFacade {
  dispatch(command: EditorCommand): EditorDelta;
  pointer(input: PointerInput): EditorDelta;
  set_tool(tool: 'select' | 'box' | 'pan'): void;
  set_active_label(label_id: Id): void;
  set_viewport(view: Viewport): void;
  zoom_at(x_css: number, y_css: number, factor: number): void;
  fit_image(): void;
  focus_selection(): void;
  focus_region(bounds: BBox): boolean;
  get_hit_stack_state(): { index: number | null; count: number };
  get_viewport(): Viewport;
  set_selection(ids: Id[]): EditorDelta;
  set_local_flags(ids: Id[], flags: { hidden?: boolean; locked?: boolean }): EditorDelta;
  get_snapshot(): AnnotationDocument; // 真实full-native读/救援，不替换成JS编辑器
  get_commit_readback(expected_generation: number, changed_ids: Id[]): CommitReadback;
  get_generation(): number;
  get_object_hashes(): Record<Id, string>;
  set_predictions(sets: SuggestionSet[]): void;
  render(timestamp_ms: number): void;
  device_lost(): Promise<string>;
  get_device_state(): 'ready' | 'lost' | 'recovering' | 'disposed';
  recover_renderer(): Promise<void>;
  dispose(): void;
}
export function create_editor(
  canvas: HTMLCanvasElement,
  media: MediaRevision,
  ontology: OntologyVersion,
  document: AnnotationDocument,
  canonical_rgba: Uint8Array,
  initial_generation: number, // 与载入文档配对的SaveQueue.local_generation；新资产为0
): Promise<EditorFacade>;
```

C3 的 flags 只属于编辑器会话，不进入保存文档。业务 UI 可持有不可修改的 changed_objects 投影；不直接 mutate。pointer move 只更新交互预览，不增加 generation，不触发完整快照或网络；pointer up 形成一个 command 才增加 generation。

set_viewport/selection/hide 不改变业务 generation。取消/无效操作不增加 generation。undo/redo 改变文档且 generation 单调递增，不倒退。
T28前端只在成功的document_changed/suggestion decision逻辑提交读取committed snapshot；选中/隐藏/锁定仅更新局部UI投影与历史状态，不调用整文档快照或远端保存。local flags投影不可修改且只在Rust成功后发布；INVALID_FLAGS/未知object与locked mutation拒绝不能清空已确认选中/undo状态，切图重新建立会话并清理flags。

持久实例buffer按局部对象range更新；视口仅改变uniform和绘制ranges。资源计数来自实际创建/释放/上传/submit，logical texture bytes与V8 heap分别标识，不称真实VRAM。跨JS/WASM bytes当前只计实际RGBA输入，bridge耗时仅涵盖原生桥调用，不认证完整React/SaveQueue CPU或物理可见帧。

T31原生selected controls：未锁定、未隐藏的选中对象在四角及四边中点绘制8个8CSS像素方块。锚点先做canonical→CSS变换再加±4CSS偏移，DPR不进入持久坐标；4CSS可见fringe独立于bbox描边margin，零面积视口不产生绘制ranges。复用同一48-byte实例buffer和已有bind；一次扫描生成可复用bbox/control ranges，全部bbox后再绘controls。

preview flags=0 使用同一48-byte Native overlay buffer 先绘制 bbox 四边，再保留原中心控件；普通 selected 对象仍是8个屏幕空间控件。pointermove 仅更新预览，不增加generation/save/undo；工具切换或cancel必须清除已drain的旧预览。

T31普通direct/gesture提交先在单一working clone上执行并校验，generation/no-op/error检查通过后move旧文档为history.before并只克隆已安装文档为history.after；undo/redo按既有snapshot history还原且保持128条/64MiB预算。WASM只同步序列化不可变当前文档借用，native owned snapshot及全部JS wire保持不变；ApplySuggestions另有既有事务working clone，不将两克隆归因外推到所有命令。

T31持久化producer：EditorHost在asset load/renderer恢复从真实get_snapshot一次初始化只读完整document mirror；每次逻辑document/decision提交只消费C3原生changed_objects/removals及required内部get_commit_readback的exact-generation header/object_count/changed slots。

原生拒绝stale/非法generation/不存在object，JS不计算可编辑几何或猜completion/ontology/中间对象undo-restoration顺序。每个已消费delta对应自己的不可变document版本，same-generation值相等suggestion decision仍返回完整版本并追加有序journal；getSnapshot继续真实full-native救援读取。

未改public C1/C3 wire或生成DTO。
SaveQueue仅adopt模块私有WeakSet已认证的完整深冻JSON document，复用未变对象；未认证/外部Object.isFrozen浅根仍JSON-safe防御copy后递归冻结。认证只在全部JSON子节点与根成功冻结后写入；prepared/pending/request和decision journal保持不可变，恢复外部数据仍防御copy。

每次 enqueue 立即写完整 DraftRecord 的独立 branch envelope 到实际 IDB，不 defer/coalesce/delta store。本地 ACK 必须来自该 writer 的 exact draft_id/write_token/persist_seq/edit_seq/generation；request success 不替代 transaction complete。same-operation 重试 payload、旧 ACK 不能清新 dirty、quota/CAS/lease/flush/冲突语义不变；quota 失败保留磁盘原分支与内存 unsaved Native，不能发本地保存证书。

共享/冻结/CPU sampled诊断不等于原8000样本8ms/33ms硬件门禁通过。

T30设备恢复扩展：三项方法是每个facade实现的required能力。device_lost返回当前真实GPUDevice对应的owned one-shot Promise，在原生device lost callback收到Destroyed/Unknown时resolve诊断字符串；JS idle等待不持有WASM borrow，不靠RAF/poll/submit检测。

get_device_state只读返回实际renderer状态。recover_renderer只重建GPU资源，不create_editor、不刷新应用、不以snapshot新建会话；同一Rust editor、generation、history、selection、local flags、preview、predictions及既有SaveQueue保留。

Host发布lost/recovering期间阻止编辑，CPU只读访问和保存队列继续可用；成功后重订阅新device的loss，dirty一次，零尺寸仍暂停提交；失败为GPU_RECOVERY_FAILED并保留CPU会话，允许显式retry，绝不重新调用AI。异步重建与通知都必须以asset epoch、facade identity、disposed fence隔离切图/卸载；旧请求完成不得配置新画布或访问已free的facade。

T30资源寿命：pending的requestAdapter/requestDevice只持轻量请求元数据；旧renderer/scene保留在可同步dispose的共享owner。dispose在等待门释放前销毁旧buffer/texture/device并释放scene引用；晚返回的新device销毁且不配置旧canvas。

请求完成后才同步借saved scene上传并move，不克隆整图/CPU文档，不跨await持facade/session borrow。release不导出simulate_device_loss；测试从浏览器外部捕获真实GPUDevice并destroy。Canvas CSS尺寸不受backing intrinsic尺寸反馈；状态/alert/retry用overlay，Dense与独立React消费者提供positioned stage。

父控件订阅Host状态且仅ready可编辑；工具/完成状态在Native成功后更新React投影，不因恢复重复set_tool或清空preview。

Rust 函数边界：`geometry::image_to_css([f64;2], Viewport)->[f64;2]`、`css_to_image`、`validate_bbox(&BBox,w:u32,h:u32)->Result<(),DomainError>`；`editor_core::Editor::new(document,ontology)->Result<Editor,DomainError>`；`Editor::dispatch(EditorCommand)->Result<EditorDelta,DomainError>`；`Editor::document()->&AnnotationDocument` 仅不可变借用，`Editor::snapshot()->AnnotationDocument` 保持独立owned copy。渲染模块依赖只读render scene，不反向修改Editor。

WASM public facade 按 C3 命名；内部 JsValue/serde_wasm_bindgen 包装留在 wasm-bridge。`dispose` 释放监听、rAF、图像和 GPU 引用；重复调用无副作用。create_editor 异步完成时需匹配当前 asset token，旧图片初始化结果不得挂到新图片 Canvas。

T24只读扩展决策：`get_object_hashes`从Rust当前已校验文档生成C4对象hash，复用annotation-domain的canonical序列化；不在JS重新实现浮点/属性序列化，也不复制完整Rust文档。仅在运行准备或逻辑generation变化后读取；pointermove、pan和选择变化不得全量重算hash。

接受/撤销由EditorHost onDelta唯一保存边界入队，UI只flush并等待对应generation的远端ACK，禁止再用React旧props覆盖快照。

T24会话恢复决策：`Editor::from_snapshot(document,ontology,generation)`以载入文档配对的逻辑generation创建新会话，不恢复旧undo栈。WASM `create_editor` 必须传入此generation；工作台切图/草稿恢复沿用SaveQueue.local_generation，不能将已保存或待保存资产重置为0，不能丢弃queue/journal来绕过ACK检查。

新资产显式传0。
恢复时从同一queue record选择document/base/generation；保留内存ACK快照不能与较早HTTP GET文档混配。conflict/unreachable恢复保留本地document与journal并暂停写入，须显式保留本地/导出后才基于观察的服务端head继续。查看服务器版本为只读预览，不可覆盖本地queue；返回本地编辑时从queue重新装载对应快照。
显式保留本地冲突结果的 debounce 与 flush 持有原调用作用域 guard；scope 失效不能借后来的同账户工作台发出新 operation 或采纳旧回执。恢复编辑须等实际新 ACK、最新 IDB complete、匹配 base/generation/journal 与当前作者、owner、角色及固定任务 lease。只读服务端预览的 Native generation 属于另一个文档，不能与保留本地 draft 的 generation 混比；回到本地时从完整已确认 record 新建 Native。当前可编辑 Native 则仍须 generation 与完整文档相符，保持 history/selection。

T13 独立分支：IDB schema v2 的 draft_branches 复合键为 [asset_revision_id,draft_id]；DraftRecord/Native 救援及 SaveRequest wire 仍为 schema 1。envelope 持有 write_token、未经规范化的 record、sources[{draft_id,write_token,action:recover|use_server}]。旧 v1 原值整笔事务升级；任一失败回滚，blocked 报错，不返回空成功；原 v1 只读救援不写回。未知/未来 record 保留原值，仅提供救援；JSON 编码失败不下载、不删除、不伪造恢复包。

每个标签页及显式 fork 使用独立 writer/draft/token，保存完整 Native、原 pending 请求/operation、owner/outcome 和有序 journal，不自动 replay 旧 CAS 或按 updated_at 选胜者。用户逐源选择 recover/use_server，来源 token 必须仍相符：recover 需目标具备真实同步证据；显式 use_server 只需目标本地完整提交后将来源留档，archive 不等于上传或采纳原草稿。active/archive/rescue_only 以固定点归类，循环、缺失、改写来源和未解决内存分支保持阻断。选另一个来源不能继承上一个来源的 pause/服务端预览状态。

TaskCreatePreparation/TaskOpenPreparation 的 validateCurrent():Promise<boolean> 为必需能力：create/claim 前与 claim 后重新读取该 asset 全部来源 envelope，并同时验证作用域 isCurrent 与组件上下文。新任务/无关任务受全部未解决 raw/unknown/unmatched 来源约束。仅已认证 paused fork 对原 fixed task、相同 owner/asset/ontology/base 且无 pending/inflight/ACK/存储读取屏障时，可窄重新 claim；不是原来源已 recovered，更不能解锁新任务。IDB/HTTP 不原子，校验失败释放已取得的 ticket/lease，不能安装 Native。

## C4. 候选与模型运行

```ts
export type ProviderId = 'codex_local' | 'claude_local' | 'openai_api' | 'anthropic_api' | 'mimo_api' | 'detector_local' | 'mock'; // codex_local: historical decode only; retired, not runnable
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

Detector 本地 probe/run 的 deadline 从 spawn 后即生效，覆盖 stdin 写入、stdout 逐行读取与残缺尾行、stderr 排空、candidate 提交和真实进程退出；收到有效响应或 worker 已 exit0 都不能提前解除未完成生命周期的期限。run 的 private lifecycle signal 也约束 production candidate HTTP；deadline/cancel 必须回收所属子进程与暂存目录，且每次 run 只有一个 terminal。HTTP 观察被中断不等于服务端已接收的提交被回滚，不能据此宣称候选从未提交。

T32 named API receipt（仅 `openai_api` / `mimo_api`）：终态 succeeded/failed/cancelled 的 `data.receipts` 按实际尝试的上游 HTTP turn 顺序保存，`data.receipt` 为最新项，无上游请求时为 null、receipts=[]。被本地配置/turn budget 阻止而未尝试的请求不产生 receipt；HTTP 502 等已尝试但未给身份的 turn 保留 null 身份项，不能用上一 turn 或请求配置填充。

每项形状：`{provider_id,requested_model_id,actual_model_id,response_id,auth_kind,transport,runtime_version,runtime_version_status,budgets}`。`provider_id`/`requested_model_id` 为 Host 已配置事实；`auth_kind='api_key'`；transport 为 `openai_responses_sse` / `mimo_chat_completions_sse`（协议而非官方 endpoint/付费账户的证明）。

上游 metadata 不得改变这些事实、内部工具 call/result ID、schema 或权限。

`actual_model_id` 和 `response_id` 仅取 OpenAI Responses 已识别 lifecycle event 的 `response.model/id` 或 MiMo SSE 的 `chunk.model/id` 非空字符串；缺失/非字符串为 null，绝不回退 requested_model_id。

已观测值在同一 turn 后续缺字段时不被清空；不同 turn 分别保存。未知嵌套 metadata 和营销/配置别名不是实际模型身份。

HTTP server runtime 版本未正式暴露：`runtime_version=null,runtime_version_status='not_exposed'`；Node/Host 构建版本是另一个本地事实，不能冒充服务端版本。`budgets={max_tool_turns,max_run_ms,max_total_bytes,request_timeout_ms,cost_usd:null}` 记录当前实际强制配置；max_run_ms 在 beginTurn 边界检查，不承诺硬墙钟中断；request_timeout_ms 是每次 HTTP/SSE deadline，max_total_bytes 是累计已消费 SSE data UTF-8 字节，max_tool_turns 是允许请求回合上限。

未强制货币上限、未知费用保持 null，不虚构 currency cap。

先观测 receipt/usage 再解析工具或处理终态；失败、超时、取消保留之前已观测证据。成功但未报告 usage 的 turn 使总量保持 unknown；未返回任何 usage 的 HTTP 失败不能清除之前已观测量。所有 receipt（含 receipts 数组及最新项）仍经过同一递归 exact-known-credential public redactor，不改内部工具 ID。

C4 RunEvent.data 已是通用 unknown JSON，Rust model_jobs→ai/events→events API 原样脱敏持久化，无 DTO/migration。

T32观测checkpoint：OpenAI/MiMo在实际attempt或已识别身份/有效usage改变时，使用现有progress事件持久化同形receipts/receipt/usage/cost_display；不逐token发事件，不扩大16KiB/4096事件上限。服务端cancel立即撤销run token并停止Host，不等待其终态data；取消前checkpoint为已观测证据，取消后不接受候选。

脱敏仅保留精确input_tokens/output_tokens键的null或JS安全非负整数，其他token键与畸形值继续脱敏。

T32授权配置指纹：AiPreviewResponse必含execution_configuration_hash。API与WASM复用annotation-domain对Rust serde_json::Value规范序列化的SHA256，JS不得parse/stringify重建浮点/大整数/键序。

只读host_execution_configuration_hash接收原始Host JSON与provider/profile，唯一选择实际执行配置；missing/ambiguous拒绝。显式live授权在consent/start前比较此hash与实际API preview，配置和预算亦被已有input_fingerprint绑定；仅检查公开文件不等于正在执行的Host/数据库配置。

现有 16 KiB event data cap 不扩大。默认 8 turn 常规完整 ID 记录仍可持久化；恶意超长 model/id 或配置过大 turn 上限可能触发现有 event_data_too_large，届时 live consumer 必须诊断缺证据/blocked，不能把 requested identity 当成功或扩大预算。

账户权限、付费、图像能力、视觉结果仍由显式 opt-in live 验证，工程 loopback receipt 不升级 G4。

`object_hash` 由 annotation-domain 的共享 Rust 规范化函数产生：按固定字段顺序包含 label、bbox 和排序后的 attributes；排除显示 flags 和 audit 时间。WASM 和服务端使用同函数，JS 不自行拼 JSON 算哈希。T01 用同一 golden fixture 交叉验证。

request_hash 与 input_fingerprint 同样明确定义、包含全部相关输入和 provider profile 版本。

接受前同时验证 asset/ontology/revision、当前 generation、object hash、类别/属性，以及 change_id 尚未被接受。任一项失败，整批不改。

部分接受也不是逐项偷偷落盘：用户先明确选择子集，再形成独立原子命令。撤销保留原始预测；接受关系可变为 reverted，审计仍保留。

`Create` 只允许 detector 或显式启用 bbox_output 的 profile；VLM 属性审校不允许改变 bbox、创建/删除正式对象。模型返回不在 allowed_ops 中的动作以 422 拒绝，不能偷偷照做。

Model worker 在首个 item 前执行 fenced progress checkpoint；item 与周期为原 claim lease_for/3 的续租 future 必须并发 poll，成功续租后 reset 周期。续租失败即 drop item 及其 RuntimeLease；item/renewal 的作用域先结束，再写下一个 checkpoint 或终态，避免 item 持有 SQLite writer 时互等。续租沿用 JobQueue 现有 MAX_LEASE 规则，不改变 claim 的初始期限或测试 deadline。进度的 succeeded/failed owned Value 只在结果变化时重算，heartbeat 借用缓存，Queue 的 &Value/JSON 契约不变。

所有 worker-owned 状态、started/interruption/terminal、RunDriver event 与 candidate 写入，必须在对应 SQLite writer 事务内用 fresh server now 验证原 job_id、running、worker_id、fencing_token 和未过期 lease，再进入持久化 funnel。RunDriver 私有借用原不可变 LeasedJob，不重载新 owner、不获得 claim/renew 权利；等待 writer 前的时钟不能证明等待后仍有权限。现有 AgentTools 的 run-token/授权通道保持独立，不把这个 RunDriver guard 描述为该通道的 worker epoch fencing。

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

unknown 值必须在契约入口立即按 JSON Schema 验证，不能以 `any` 传入业务逻辑。NDJSON 一行一消息，单行 ≤4 MiB，stdout 专用；stderr 日志脱敏。图片字节不塞入该行：API 创建运行暂存 grant，Host/Worker 只获得已批准映射。每个 request 必有 response；超时、重复 ID、未知 method、进程退出、截断/超长行必须被测试。

协议错误终止本次运行，不重启后自动重发可能已计费调用。
三个API适配器只在本run私有内存保存已解析credential；所有公开RunEvent的message、嵌套data值及键按该确切值脱敏，包括未校验工具名、合法工具call_id及上游错误正文。供应商协议内部保留原始call_id；错误分类、已观察usage和未知null用量不被脱敏改写。

Linux 每个受管 Host 及 Node Host 创建的 provider child 都使用发行 API 二进制的私有、单线程 broker，只有各 broker 设置 process-local subreaper；原 CLI executable、argv、allowlisted env、cwd 和 stdio 原样转发，不增加 shell。API 在 spawn 前捕获自身 process pidfd；Node child broker 以 getppid 与 /proc start_ticks 在 pidfd_open 前后确认原 Node parent 身份。创建线程退出不能终止仍然存活的所属运行。pidfd/subreaper 不可用或启动失败必须明确报错，不退回裸 PID、环境 marker 或已失效 PPID 链。控制 FD 只在 broker 内保留，CLI exec 前关闭继承。

Node child 启动先通过既有 executable/cwd/env policy，再从受信父进程的 WEBLABEL_API_BINARY 定位 broker；API 仅为显式 WEBLABEL_HOST_CONFIG 的受管 Host 注入此内部 locator，并覆盖 provider 同名配置，普通 CLI 不额外获得该变量。READY 后私有 byte 0 为 GO、byte 1 为 STOP-before-exec；STOP 经实际 ECHILD 清理确认后完成，不执行 provider 或记入请求 ledger。GO 前 EOF/未知 byte 失败关闭。Node 在检查 child.pid 前注册 exec-error listener；无 PID 的 exec 拒绝返回 controlled spawn_failed、关闭自己的 stdio，并保留后到的 errno/cause 与脱敏诊断，不让 unhandled error 杀死 Host。

Linux 清理由私有根能力持有目标 identity/pidfd/完成通道，Reader/Host 析构不能使异步 RuntimeLease 丢失该能力。正常退出、崩溃、deadline、cancel、父 API/Node process death 或控制通道 EOF 都回收本根后代（含 setsid/double-fork），不触碰其他运行或无关进程。只有 waitpid 确认 ECHILD 后才发送成功完成确认；wait 同时要求确认与真正 CLI 退出状态。missing ACK、EOF、信号失败或超过完整 5 秒预算保持清理失败，同一根缓存一次完整尝试结果，Drop 与显式清理不能另起预算或把失败重试成成功。ACK 不证明具体哪些 PID 收到 SIGKILL，Node reclaim report 不伪造 killed 列表；CLI 原退出码/信号仍保留。这是进程所有权与生命周期机制，不是第三方 CLI 权限 sandbox，也不证明远端收费调用已取消。

MCP 入口是 Agent Host 包中的独立 stdio 命令。Claude 只安装本项目 server 配置，不读取项目里任意第三方 MCP 配置。它通过 loopback `/internal/agent-tools/{tool}` 与 API 通信，使用专门生成的短期 run-scoped Bearer，不能使用管理员 session。该路由同样检查允许Host和已提供的Origin；私有非浏览器客户端可省略Origin，浏览器cookie不替代Bearer，也不触发浏览器CSRF规则。token只在子进程环境/私有通道传递，不在argv、工具参数或输出里传递；到期/取消后立即失效。

该路由同样检查允许Host和已提供的Origin；私有非浏览器客户端可省略Origin，浏览器cookie不替代Bearer，也不触发浏览器CSRF规则。token只在子进程环境/私有通道传递，不在argv、工具参数或输出里传递；到期/取消后立即失效。

检测器locked file先解析真实target并限定在显式配置的resolved weights root，再stat/hash/read；大小和SHA256使用同一打开FD，processor/model loader各自前重新校验。operator显式配置的公开外部模型根仍可供独立worker使用；verify-live文件检查授权限repository内，不能把仓库默认weights的hash称为外部worker实际权重证明。

路径复核拒绝已观察的verify/load间escape，不承诺第三方loader打开前的OS级原子TOCTOU消除；默认diagnostic不hash大文件、不启动Python探针、不登录/调用模型。

允许工具及参数：

| 工具 | 输入 | 输出/权限 |
|---|---|---|
| get_context | {} | 当前 run 的规范、版本、用户意图，不能换项目 |
| list_objects | {cursor:null|string,limit:1..100} | 当前作用范围内对象、bbox、attributes、object_hash |
| read_region | {region:BBox|null} | 已授权图像/crop及变换；消耗 crop/pixel 预算 |
| propose_changes | {changes:Change[]} | 校验后存候选，不能直接接受 |
| report_issues | {issues:QualityIssue[]} | 保存疑似问题，不写审核结论 |

服务端从 token 取得 context，Agent 传入的 project_id 不是授权依据。API provider 可以直接复用 RuntimeContext 函数，无须经 MCP 再发一次网络请求。

## C6. HTTP 路由清单

本节是唯一总路由摘要索引；逐 handler 的输入、默认值、权限、错误及调用示例见 [HTTP API 使用参考](api-reference.md)。AnnotationRevision、SaveRequest/SaveResponse、heads、ProjectMemberPage、AI preview/consent、activity 等 wire DTO 由 annotation-domain 生成；session、users、projects、任务/审核以及 import/export/snapshot 的部分请求与响应仍由 handler 局部结构或 JSON 构造，不是全部已生成。列表通常使用 `{items:[], next_cursor:null|string}`；jobs 返回 `progress`/`result`，AI 列表还带 `run`。无分页的列表 next_cursor 恒 null，不承诺所有列表均支持 cursor。

| 方法/路径 | 请求与返回 | 所属任务 |
|---|---|---|
| GET /api/session/bootstrap | BootstrapStatus：initial/restore/login + bootstrap_available；只读提示，no-store，不返回凭证/身份/计数 | T10 |
| POST /api/session/bootstrap | {launch_code,password} → session cookie + csrf_token + identity；空DB为local-admin，合格本机恢复为restore-admin-UUID；密码由用户选择且不回显 | T10/T33 |
| GET /api/session/password-recovery | AdminRecoveryStatus：disabled/available/expired/completed + nullable request_id/username；只读、等待提交结算、no-store、不返回码或会话 | T10 |
| POST /api/session/password-recovery | AdminRecoveryRequest：{recovery_code,password} → completed Status；独占本机维护，strict Origin/code 授权，原身份密码更新/目标session撤销/completion同事务；不自动登录 | T10/T33 |
| POST /api/session/login | {username,password} → session + csrf_token；Host/Origin总校验，已失效credential可重新登录，有效session仍须CSRF | T10/T29 |
| POST /api/session/logout | 清除服务端 session | T10 |
| GET /api/session | 当前principal/项目角色；传入失效session时401并返回同Path/SameSite/Secure属性的Max-Age=0清理Cookie，DB失败不当作失效 | T10/T29 |
| GET/POST /api/users | platform_admin；GET limit默认100、1–100，cursor排他user_id分页；POST普通账号，不授平台或项目权限 | T10/UX |
| GET/POST /api/projects | 列表 / {name,description,allow_self_review} → project | T10 |
| GET/POST /api/projects/{id}/members | 均要求项目 admin；GET limit 默认100、1–100，cursor 为排他 user_id，返回 ProjectMemberPage；POST {user_id,role} → membership（新增或替换角色） | T10 |
| GET/POST /api/projects/{id}/ontologies | 已发布规范 / 发布不可变版本 | T10 |
| POST /api/projects/{id}/assets | multipart images → import_job_id | T07 |
| GET /api/projects/{id}/assets | cursor/limit → media 列表；limit 默认50、1–100，没有 filter 参数语义 | T07 |
| GET /api/assets/{asset_revision_id}/image | 鉴权 canonical 图片，ETag 为哈希 | T07 |
| GET /api/assets/{asset_revision_id}/annotation | query ontology_version_id，读取指定规范的head | T11 |
| GET /api/assets/{asset_revision_id}/annotation-heads | 项目成员；limit 默认100、1–100，cursor 为排他 ontology_version_id；返回 AnnotationHeadPage，资产的全部 ontology heads（不按 ontology_version_id 过滤） | T11 |
| GET /api/projects/{project_id}/annotation-heads | 项目成员；必填 ontology_version_id、limit 默认100、1–100，cursor 为排他 asset_revision_id；返回 AssetAnnotationHeadPage，先分页媒体再连指定 head，缺失 head 为 null | T11 |
| GET /api/annotation-revisions/{id} | 鉴权不可变历史版本，审核使用 | T11 |
| PUT /api/assets/{asset_revision_id}/annotation | SaveRequest → SaveResponse | T11 |
| GET /api/jobs/{id} | 作业状态、progress_completed/progress_total、progress/result；逐资产结果位于 kind 对应 result 内，不是通用顶层 items | T17 |
| GET /api/model-profiles | 持久公开能力/验证投影，不回传秘密，空库为空 | T16/UX |
| GET /api/model-profile-presets | platform_admin；固定Host脱敏预设，limit默认50、1–100，after排他profile_id | UX |
| GET/PUT /api/model-profiles/{id} | platform_admin；GET profile+configuration_hash；PUT仅原hash，历史不同配置409，首次not_run，不执行模型 | UX |
| POST /api/ai/previews | {request:StartRunRequest,grants:{allow_image,allow_object_context,preview_crop}} → 服务端不可变preview、权威fingerprint、固定request/profile/grants及expires_at；不执行模型 | T25 |
| POST /api/ai/consents | {preview_id} → 绑定实际actor/pins/profile/policy/scope的consent_id；仅记录批准，真实dispatch每次重验；旧仅fingerprint意图不再是启动凭据 | T25（取代T24前置创建契约） |
| POST /api/ai/runs | StartRunRequest → run_id；T17实现幂等创建/状态机，T25叠加consent与外发门 | T17/T25 |
| GET /api/ai/runs/{id}/events | after=seq → 事件分页 | T17 |
| GET /api/ai/runs/{id}/suggestions | 候选集合 | T17 |
| POST /api/ai/runs/{id}/cancel | 幂等取消；T17实现取消/隔离审计，T25叠加授权语义 | T17/T25 |
| POST /api/ai/suggestions/{id}/decision | 拒绝/幂等确认；接受必须随SaveRequest同事务 | T19/T25 |
| GET/POST /api/ai/suggestions/{id}/rejections | GET持久逐项拒绝journal；POST operation_id+有序distinct change_ids≤1000，项目写角色，不改head；已接受先保存撤销 | UX |
| POST/GET /api/projects/{id}/tasks | 创建固定asset+ontology任务；GET limit默认100、1–100，cursor排他task_id分页 | T26/UX |
| POST /api/tasks/{id}/lease | acquire/renew/release/transfer + server-clock expiry/fencing token | T26 |
| POST /api/tasks/{id}/submit | 唯一当前saved revision → submission；同事务task submitted、清lease并fence+1，返回submitted_by/lease_ended=true | T26/UX |
| GET /api/tasks/{id}/submission | 成员只读当前最新提交/实际lease_ended；非POST幂等回执 | UX |
| POST /api/reviews/{id}/decision | approve/reject + reason + exact submitted revision IDs | T26 |
| GET/POST /api/reviews/{id}/issues | 读取/创建绑定来源 revision 与 ontology 的不可变问题 | T26 |
| POST /api/projects/{id}/dataset-versions | 指定 revisions/split → immutable snapshot | T27 |
| POST /api/dataset-versions/{id}/exports | format,loss_ack,operation_id → export job | T27 |
| POST /api/assets/{asset_revision_id}/annotation-import-previews | multipart format/ontology/data/显式映射 → 不可变预览、损失报告与base head，不改head | T14 |
| POST /api/annotation-import-previews/{id}/commit | AnnotationImportCommitRequest（loss_ack/operation_id/必有lease:null或SaveLease）→ 同事务lease/fence与CAS提交一个revision，重复operation重放 | T14 |
| POST /api/annotation-revisions/{id}/exports | 单个不可变版本的native/YOLO/COCO导出，format/loss_ack/operation_id | T14 |
| GET /api/exports/{id}/download | 项目成员鉴权文件，响应头 X-WebLabel-Loss-Report 携带损失报告 | T14/T27 |
| POST /internal/agent-tools/{tool} | run-scoped Bearer，不接受session；Host/已提供Origin允许列表校验，私有客户端可无Origin | T21/T29 |
| GET/PUT /api/projects/{id}/external-processing-policy | {allow_external_processing:boolean}；成员读、项目admin写、既有及新项目默认false；无图像的外部运行也受门控 | T25主会话 |
| PUT /api/projects/{id}/activity-sessions/{session_id} | {expected_version,intervals}；本人累计不可改前缀checkpoint，精确intervals重放，冲突409；所有项目角色自愿显式保存 | T34 |
| GET /api/projects/{id}/activity-sessions | 只读本人的有界分页；无自动上传或远端遥测 | T34 |

初始化状态使用一次 SQL SELECT 的三个 EXISTS 读取 users、非空 password_hash 和任意 sessions。无 users 为 initial；有 users 且本机明确启用恢复、无非空密码且无任何 session 为 restore；其余为 login。仅非 login、启动码未过期（now <= expires_at）且未被占用/消费时 bootstrap_available=true；GET 不释放、不消费启动码，POST 仍原子消费并事务复核资格。SQL 错误返回 500/BOOTSTRAP_STATUS_FAILED，message 固定 Bootstrap status could not be read，不猜模式。状态与 session router 所有响应 Cache-Control: no-store，包含 Host/Origin 拒绝。GET 继承精确 Host/Origin 校验，无 Origin 的 GET 沿用既有允许规则。详见 [浏览器首次登录 ADR](adr/0003-browser-first-login.md)。

`/api/jobs` 由 T07 临时实现通用 schema 的 media job，T17 扩展同一 job engine，不能另外做两种互不兼容的 job。T07 不提前增加模型队列逻辑。
生产media_import、dataset_export、model worker分别按kind租用同一持久队列，不能互相抢走job；停机接收watch并join worker。debug集成fixture显式manual drain不用于真实release验收。Host进程树清理完成须独立运行时证据，不能由worker join推断。

T33恢复认证仅由本机启动WEBLABEL_RESTORE_AUTH=1请求：必须已有users、全部password_hash为空且sessions为空才输出新的10分钟一次性launch code；bootstrap在同一事务再次复查并创建全新唯一restore-admin-UUID，为每个恢复项目添加admin成员。

不覆盖旧身份/审计/已批准revision，不复活旧密码/session。任何幸存或并发新增credential/session均拒绝恢复bootstrap；正常已有账号启动行为不变。

管理员密码恢复独立于 T33 restore bootstrap：`WEBLABEL_ADMIN_RECOVERY_REQUEST_ID`（canonical 小写、非 nil UUID）及 `WEBLABEL_ADMIN_RECOVERY_USERNAME` 成对配置，绑定已有有密码的 platform_admin。随机32字节码仅终端输出、600秒一次，code hash/expiry不持久化。`admin_password_recoveries` 只保存消费request ID、原user_id/用户名及完成UTC，不存码/密码/CSRF，禁止UPDATE/DELETE。事务复核身份/角色/期限，更新密码并仅删除目标sessions；完成仍维护，同一ID重启拒绝。

普通/直接API与维护启动均取得规范化数据库路径旁OS独占sidecar锁。维护不挂载正常auth/业务/Agent路由，不启动workers/Host或恢复中断运行。GET与POST共享公平执行门，只读查询不误报写入冲突；已授权hash/commit任务独占门直到结算，包括HTTP断连，GET不能在仍可能commit时返回available。普通权限、CSRF、lease/fencing及保存协议不变。

v0.1 使用 polling，active job/run 每 500ms，后台/idle 2s；支持 after seq，取消轮询并按 asset/run 隔离缓存。不同时实现 SSE/WebSocket。停止/恢复轮询不能重新提交模型请求。

T14单图导出同步生成单个不可变revision的native/YOLO/COCO产物并持久化对象与损失报告，不假称DatasetVersion或异步job。T27才添加固定多图快照；两种导出共用鉴权下载路径，不建立临时无鉴权下载路径。

T17 内部 create_batch 使用 RunSummary 数组；当前公开 `POST /api/ai/runs` 只接受一个 StartRunRequest，返回一个展开的 RunSummary 加 `idempotent_replay`（不是数组）。`GET /api/ai/runs/{id}/events`与`/suggestions`返回`{run,items,next_cursor}`（run摘要使UI可见interrupted与cost_display=unknown）；`GET /api/jobs/{id}`返回作业状态与 kind 对应的 `progress`/`result`。以上区分原批处理说明与实际公开 handler，不据数组目标构造公开请求。

Interrupted无对应RunEventType（C4冻结8值），恢复事件以`failed`+`data:{interrupted:true,cost_display}`表达。`POST /internal/test/jobs/drain`为debug构建专用测试通道（cfg(debug_assertions)+平台管理员），生产不编译。

T19裁定：Prediction出处校验固定身份引用（object_id/prediction_id/model_run_id真实存在且属于该run），不固定接受时刻的对象内容——接受后的手工编辑保留prediction出处，内容变化由revision history记录。`suggestion_set_states`由决策journal重算；T25落地reject路由时，rejected/stale终态不得被静默覆盖，reject必须阻止后续accept除非用户显式重新确认。

`GET /health` 返回 204、无 JSON；wire schema_version 与 Host protocol_version 均为 1，URL 没有 `/v1` 前缀。ApiError 的公开字段是 code/message/request_id/details；当前部分 Axum extractor 拒绝尚不统一为该包络，响应 x-request-id 与错误 body.request_id 也不保证一致。

### 当前 UX 状态不变量

固定revision页面只读钉asset/ontology/revision，不跟随head，不fallback；批准/退回仍在任务队列。Native get_viewport是实时取景只读投影，focus_region（Web focusRegion）不改document；get_hit_stack_state返回最后完成点击的zero-based index/count，非DOM估算。pointermove只preview，pointerup有效业务提交才一个undo，DPR不进canonical。

GUI平台账号管理与项目成员管理遵守独立权限，未知无幂等POST只读观察。固定预设配置不接收秘密、路径、args，不调用模型；configured/ready/not_run不等于live_passed。逐项拒绝独立operation journal，不推进revision；accept/revert仍与SaveRequest同事务。未知拒绝保留原set/actor/operation/有序payload，按原operation分页核对，不靠汇总认领。

UX23增量契约：`ActivityInterval`可省略`task_id`、`run_id`，旧区间不补当前身份。新关联由用户明确选择，切换先封存旧区间；计时默认关闭、仅显式发布。服务端校验新后缀的项目归属及同时绑定run/task时的媒体、规范一致；历史前缀和同payload重放仍按原CAS规则保全。绑定不授予标注/审核/租约权限。

`GET /api/ai/runs/{id}/outcome-summary`的任务关系只由decision journal所保存的精确revision与提交了该精确revision的submission建立，含匹配review状态；不使用同图任务、后继revision或最新审核猜测。`task_binding`无证据为null；自愿区间明确关联的任务另列`activity_task_bindings`。`recorded_work_seconds`只累加当前用户已发布、显式run_id匹配的人工区间，排除model_wait；无可匹配记录为null。它不是完整工时、run独占成本、效率收益或ROI，旧记录不可追溯归因。

继续查找与执行分离：`onContinueTask(input): Promise<TaskContinueResult | null>`，`TaskContinueResult={task:ReviewTask,proof:TaskContinuationProof}`；`proof.isCurrent(preparationToken: symbol | null)`保存原document/generation/local certificate/host/loaded/scope/authEpoch，独立于旧Panel act epoch。`onPrepareTaskOpen(task,proof?)`在准备前后核对证明；显式继续的精准acquire/导航仅通过既有task-open屏障，不以查找成功直接导航。

unknown acquire（含陈旧acquire之后cleanup release的不确定结果）进入project+actor范围的fixed-task unknownLeaseWrites，与release/transfer未知结果同样保留围栏；禁止继续、新租约写入与renew。只有lease POST，无通用lease GET；ReviewTask不含holder/fence/expiry，任务GET刷新不提供未知租约操作的只读回执，不能解锁。submission的lease_ended只证明其固定提交的当前结束状态，不能泛化清除另一未知acquire。
submit结束lease，不额外release；continue重验session、原review/actor/唯一revision和lease_ended，分页选择本项目本人open另一任务，查找阶段不写租约；显式继续的精准领取/导航须通过原上下文proof和task-open准备屏障。网页seed计划按SHA-256(seed + NUL + source_group_id)前8字节big-endian模100整组80/10/10，同组跨批同split，数量比例不保证。每批含排除≤1024且至少一项纳入，各批独立快照/导出；96 MiB真实ZIP仍可typed EXPORT_SIZE_LIMIT，实际已知时附budget/limit_bytes/observed_bytes。详细请求、错误与恢复以[API参考](api-reference.md)为准；这些实现约束不构成本轮运行证明。

## C7. SQLite 表与不可变对象

写事务在原有限期限内依次取得 Repository 共享 FIFO 准入、PoolConnection 并同步 detach 为专属 SqliteConnection，再执行 BEGIN IMMEDIATE；SQL 执行和关闭确认期间保留连接与准入所有权。成功 COMMIT/ROLLBACK 也关闭连接，不归池，以确认 Windows 文件句柄释放。失败、超时、future 取消或未提交事务被放弃时，独立关闭线程持有连接和准入直到 SQLx worker 停止，不受 Tokio shutdown 取消。COMMIT 已持久化后的关闭错误不改写业务结果或触发重复写入；busy_timeout、原始调用预算及 PoolTimedOut 映射不变。独立 auth pool 不使用 Repository 准入，仍遵守自己的原始写入预算。
bootstrap在auth pool读取users/恢复资格之前取得同一BEGIN IMMEDIATE guard，管理员、恢复项目成员和session仍在单笔事务提交。AuthState::new(pool, config, write_timeout)的唯一AppState caller传入原ServerConfig.write_timeout；密码hash在SQL事务外，不把该预算冒充完整HTTP请求期限。空队列export worker仍运行，不以禁用worker、重试或扩大预算掩盖deferred read-to-write升级的SQLITE_BUSY。事务取消的回滚/连接关闭不意味着外层handler取消后会重新开放launch code；其既有one-use行为未变。

T06预留migrations 0001_core：users/sessions/projects/memberships/ontology_versions/media_assets/media_revisions/annotation_revisions/annotation_heads/idempotency_keys/jobs/job_items。T17增加0008_ai（主Agent按仓库实际序号分配，覆盖草案中的0002_ai）：model_profiles/model_runs/predictions/suggestion_sets/suggestion_decisions/run_events/consents。T26增加0009_workflow：review_tasks/task_leases/review_submissions/review_decisions/review_issues。T27迁移编号由主Agent在依赖落地后按仓库实际序号分配。禁止多个Agent同时分配migration编号。
T14 migration 0007增加不可变annotation_import_batches与annotation_exports，preview记录base head及loss report；commit与revision同一事务。

外键开启；关键关联包含 project_id 校验，head unique(asset_revision_id,ontology_version_id)。idempotency unique(actor_id,operation_id,operation_kind)。作业 lease 与任务租约分开；重启恢复 running job 为 interrupted/retryable，并且模型调用存在费用不确定性时要求显式重试。

文件路径只由 SHA256/内部 ID 生成。先写临时文件、fsync/原子 rename，再提交 DB 引用；崩溃可能遗留孤儿文件，但不能创建引用不存在文件的已完成记录。删除/GC 不是 v0.1 必需功能，不实现“清理全部”按钮。
T34 migration 0013_activity_sessions：(project_id,actor_id,session_id)联合主键；version与intervals_json在同一写事务CAS更新。intervals按seq从0连续，duration_ms为正整数，每session最多10000区间/24小时；kind限task/annotation/correction/review/switch/model_wait。

统计不进入标注/审核事务，不改变revision或decision。浏览器默认关闭，project+actor分区，commit记录单调时钟区间；失焦/人工60秒空闲不计人工，model_wait与人工分类分离。损坏/不可保存journal显式可救援但不影响主编辑/保存。发布必须用户明确点击本机项目保存；返回JSON错误且不回显输入内容。

## C8. 固定测试向量

Golden image：W=640,H=480；bbox=[10,20,110,220]。YOLO 输出 center=(0.09375,0.25), size=(0.15625,0.4166666666666667)；COCO=[10,20,100,200]。导出再导入的最大绝对坐标误差 ≤1e-6 pixel（文本保留足够有效位）。
COCO 导入必须为每个 category 提供有效的 WebLabel `label_id` 扩展；不按 category_id 的数组位置或同名类别自动映射。多图 COCO 必须显式给 source_image_id。空检测文件映射为 Unprocessed，不是 negative。
COCO/YOLO新对象按实际映射目标类别填入其全部已声明default_value（含optional/null），随后严格领域校验；实际对象类别有属性时报告`attribute_defaults`并要求显式loss_ack。这是固定规范默认值，不是来源属性还原。空对象、无属性类别、未选图不触发此项；Native原有属性与缺失optional键不改写。
T14 ZIP 成员名仅接受 ASCII 安全相对路径；路径、符号链接、casefold 重复及条目数/总解压量超限均拒绝。
Native 格式 pure conversion保留revision内容与provenance；API导入会绑定显式目标并创建本地新revision，来源revision history/对象provenance重绑会列入LossReport，必须确认后commit。

Viewport：scale=2,tx=13,ty=-7，image(10,20)→CSS(33,33)；DPR=1/1.25/2/3 不改变此结果。当前鼠标 CSS(33,33)，缩放到 scale=4 后 translation=(-7,-47)，锚点仍是 image(10,20)。

Save：head=r7，op=a 基于 r7 写入 docA 得到 r8；重试 a/docA 返回 r8 replay=true；a/docB 返回409；op=b/base=r7 返回409；期间有本地 generation9，generation8 ACK 不能清掉 generation9 dirty。

AI：runA 绑定 assetA/r8/generation8；切到 assetB 后 runA 返回只能出现在 assetA；编辑对象使 hash 从 h1→h2，包含 before_hash=h1 的变更必须拒绝；AI 修改 bbox 的属性审校响应必须422。

Review：批准 r8，保存 r9 后 r8 保留 approved，r9=pending/unsubmitted；snapshot S 固定 r8，r9 的创建不能改变 S 的导出 hash。

## T25 服务端授权契约决定

冻结预览、实际scope、服务端配置版本指纹与授权/job/run同事务，按[ADR 0002](adr/0002-server-owned-ai-authorization.md)实施。预览/consent的10分钟是新START窗口；成功START另持久化独立10分钟run capability deadline，旧NULL记录拒绝执行。

公共StartRunRequest保持原DTO，权威fingerprint由server preview返回；私有profile配置不回传浏览器，只由服务端经Host私有输入传递。

授权HTTP公共DTO由annotation-domain::ai_authorization定义并通过xtask生成TS/JSON Schema：AiApprovedGrants、AiPreviewRequest/Response、AiConsentRequest/Response、ExternalProcessingPolicy。

AiApprovedGrants.preview_crop必填且可null：显式null允许完整图像，缺省不能静默扩大为全图；所有请求拒绝未知字段。POST /api/ai/previews返回服务端冻结请求，POST /api/ai/consents只接收{preview_id}，不得再提交客户端自签fingerprint/grants。

GET/PUT项目external-processing-policy使用实际membership，只有项目admin可PUT，默认false且UI先保存确认才生效。

工程 Mock G2 只证明标注命令/持久化链路，不证明真实模型、账号或 G4 质量。Codex 活动适配器与选择入口退役，新 preview/start 返回 409 PROVIDER_RETIRED，旧 queued run 在 runner 前持久失败；历史枚举、snapshot、RunSummary、幂等回放及已有 prediction/decision 保留原身份，不自动改用 Claude/OpenAI。退役不使四必需真实渠道或完整发行通过。

## 商业核心增量：只读定位与显式导入

本增量保持契约v1；新增Rust wire声明经xtask生成，客户端不得手写generated。精确分页、错误、权限及边界验收冻结于[商业核心计划第8节](commercial-core-plan.md#8-审查修订接口与预算冻结)。

新增`AnnotationHeadSummary`、`AnnotationHeadPage`、`AssetAnnotationHead`、`AssetAnnotationHeadPage`、`ProjectMemberRole`、`ProjectMember`、`ProjectMemberPage`与`AnnotationImportCommitRequest`。Option必须显式null；revision_no/object_count/fencing_token为非负安全整数。HeadSummary不含objects，摘要不是冻结/写入授权。项目分页必须先限制媒体页再关联指定规范head，不丢没有head的媒体；读取失败不是head:null。项目成员读取仅项目admin，不使用全站用户列表。

导入commit的lease字段必须出现，为`SaveLease|null`；普通save与annotation import在同一提交事务中核验任务固定的asset revision与ontology version，再核验holder/expiry/fence及CAS。规范不匹配返回`TASK_ONTOLOGY_MISMATCH`，不得只核对资产或以当前head规范代替任务固定规范。请求hash包含lease，所有调用者同步迁移；首次提交与成功ACK重放按既有授权/idempotency规则区分，不创建第二个revision、不放宽重放授权、lease或CAS。已成功普通save的原ACK重放仍要求当前actor及project write权限，但不强制原lease在重放时仍未过期；这不是新写入授权，也不豁免annotation import既有重放复核。单图导出loss未ack的422采用完整C1 ApiError，真实报告在`details.loss_report`，保留request_id；鉴权先于计算，不先产物后确认。数据集增量同样采用此位置。

实际换类由一个Rust helper原子处理目标属性：保留目标合法同key值、删除未定义键、缺/非法用目标default；同类不补历史缺值、不变history/generation。保留null合法及optional历史语义；hidden仍只会话可见性，locked仍禁止写。只读WASM投影返回既有AnnotationObject并核对固定版本/hash，不改变历史或generation；生产AI SetLabel仍拒绝。

新发布至少一个类别；已有空规范可读，不自动补类或迁移。required仅要求对象字段存在，null default仍合法；类别身份为稳定label_id，不强迫同名类别改名。不可变规范定位优先任务→显式规范→同资产草稿规范/base成套核验→明确head，禁止默认最新配旧doc。未知创建/发布ACK不自动重发；无服务端操作关联时，唯一同名/角色候选也不能确认本次项目创建。显式请求资产不可见时保留该ID，按原ID恢复paused草稿并提供救援，不默换首图。

媒体job的逐文件结果在`result.items`，以item_index而非文件名关联；失败项提供实际错误种类的error_code，成功error/error_code显式null。不根据随机英文message判断错误或实现虚构取消/重发。

C06/C07草稿恢复要求：`draft_owner`与`pending_owner`独立记录各自原作者，不能由当前登录身份、另一owner或旧schema猜测补齐；缺少可信元数据的旧记录仅供救援，不自动恢复写入。auth直接epoch变化必须同步撤销旧授权，每次install使用独立ticket，使旧异步结果不能安装到新scope。guarded IndexedDB读取必须等待真实transaction complete；失败、abort或过期scope不能以null伪装为无草稿。只有真实IDB complete且actor/project/固定asset+ontology、epoch/install ticket仍current时，才可签发当前记录的local certificate；读取或状态查询发现失效也必须撤证。

paused是编辑屏障，不是可由generic flush或timer解除的重试状态。显式确认原请求必须singleflight，原样保留operation/body/base/lease/journal；匹配真实成功ACK后仍须等待最新本地记录的IDB真实complete及current核验，方可恢复编辑，旧ACK不能清较新dirty。fresh请求被明确拒绝lease时，只能精准领取实际同一固定任务/资产/规范的有效lease，并核对当前Native/context后，由操作者明确reprepare为新operation；historical unknown不能替换原payload或借新lease包装原请求。只读核对只能诊断，不能清pending、解除paused或触发恢复。跨tab冲突仍未解决，不据此宣称已协调多标签页写入。以上为C06/C07规范要求；本次文档更新不代表此次纠错已取得GREEN或运行时恢复验收。
普通入口编辑资格先完整分页读取当前项目 tasks，按 asset（不按 actor、ontology、state 或排序）核对。任何匹配任务均不能走普通 null-lease 编辑；读取未完成、失败或 scope/auth/catalog 变化保持只读。开放待办须显式走固定 task-open 屏障及本人匹配 lease；仅有关闭任务须管理员明确新建任务后领取。该读取是时点快照，不是事务分配锁：随后新增任务仍由服务端拒绝并原样保留操作/草稿，不自动认领、创建或重放。Native commands、pointer/keyboard、raw mutation delta admission、AI/import 与 SaveQueue.canPrepareOperation 共用资格，而非只禁用控件。
固定任务已成功原请求的回执确认与 fresh operation 授权独立：`SaveQueueOwner.canPrepareOperation(asset_revision_id, ontology_version_id)` 必填，queue 在 mint 和实际 fresh dispatch 前复核；ordinary 非 fixed 可按原规则使用 nulllease，但 receipt-only 不准创建新操作。显式原请求重放的 guard 在 capture 时绑定初始双作者、实际 state 与独立 install ticket，继续核验 actor/project/directepoch/hostscope/currentcurrency；实际 ACK 清 pending 不使该原回执最新本地提交权限自失效。ACK 元数据改变立即撤销旧 local_commit，最新 document/journal/base/synced N 经真实 IDB complete 才有新证书；partial ACK 保留未来 dirty/作者/journal，没有当前固定 lease 即暂停，不借原回执循环发下一操作或恢复编辑。 同 fixed task 的已确认基准上存在原作者 future-only 本地工作时，显式准备可在 Native/真实 latest IDB certificate/不可变 base 证明一致后续领该 same target，不能先发无 lease 保存、清 pause 或自动送新操作。后续只由显式 `retryOwnedFuture(asset, initialProof, reconciliationGuard)` 产生一次新请求；两个 guard 必填，初始资格不在 pending 更新后自失效，持续身份/安装/作用域授权仍每 await 核验，fresh lease 在 mint 和实际 dispatch 独立核验。实际 ACK 后 Native 编辑屏障保持至 latest 本地事务真实完成；失败、abort、skip、过期或 superseded completion 不解锁，已 ACK 的本地失败显式重试只本地提交，不改变请求或增加 HTTP。

导入/单图导出区分fresh发送和发送前已unknown的原请求重放。fresh明确4xx可按本次无写拒绝处理，fresh LOSS_ACK_REQUIRED仅由显式确认修改loss_ack；曾unknown之后的401/403/404/409/422或其他非匹配成功ACK只诊断本次拒绝，不能证明首请求未提交，不能删除原outbox/改operation、payload、lease、ACK、base/解除锁或创造替代操作。当前鉴权/fence复核可能发生于查询成功幂等记录之前；不得绕过这些服务端复核来消除未知。只有匹配原batch/operation与固定target的实际成功ACK才消除不确定性，已确认artifact下载失败只重试GET。跨组件卸载保留原页面module记录，晚scope拒绝同样不能删除旧unknown；不宣称page reload持久化。

数据交付每逻辑范围included+excluded≤1024，included非空且两集合唯一、不相交；2048次逻辑媒体核验、96MiB媒体/ZIP/解压、4096归档成员、冻结与输出manifest各16MiB、HTTP JSON2MiB、job payload1MiB/progress及result256KiB均为独立预算。导出heartbeat覆盖等待与构建；短事务同时检查live worker/fence、写export行与job succeeded，下载只允许成功job对应的业务记录。

只读资格查询 `SaveQueue.canRetryRetained(asset, scopeGuard)` 必须显式传入当前 scope guard；它只识别当前双作者的原 unknown/rejected immutable 请求，或同一 installed owner 的真实 ACK 尚未完成本地提交的 runtime barrier。prepared、借用旧 install/epoch 的回执、无 pending/无实际 barrier 的 paused future 均无此资格。SaveStatus 只在显式 retry 入口使用此资格，不把它授予 fresh canWrite、CAS/rebase、keep_local_export 或 Native 编辑；ACK 清 pending 后持续使用纯回执 currency，仍需真实 latest IDB complete。非法或无法定位的原草稿只保留完整 raw recovery/救援，不通过 restore 正常化写回或制造证书。

Every accepted real ACK installs the same-owner/captured-guard/actual-receipt latest-local-transaction barrier, including ordinary auto saves. SaveQueue.flush bypasses debounce, waits the latest local attempt, and drains dirty permitted ordinary work only while the captured owner/state is current and actual receipt/barrier progress occurred. It never replays retained unknown/rejected work, retries a failed local PUT, clears a paused future, or grants fresh lease authority. whenPersisted waits the latest attempt on that state, not merely the promise present at entry; settlement is not successful commit. Task creation/import/export/submission retain all success and ownership checks after flush; no early interpretation of transient ACK writes_paused as a permanent failure.

Raw 草稿结构准入只读：安装队列前核验当前 schema、固定 asset/ontology/base、safe-integer generation/同步计数/日志范围、完整 AnnotationDocument 与 SaveRequest 的生成 wire schema、canonical bbox 边界、原请求 operation/base/document 配对，以及已有作者元数据的结构。结构有效不等于作者可信或 lease 有效，不能借此授权。拒绝不支持 schema、非法或无法定位的记录时，不改写、不正常化、不安装队列、不创建 Native 或当前 local certificate。

初始目录读取失败时读取物理原始记录并直接进入救援，不为导出调用 restore。救援始终序列化该完整 raw，保留未知字段、双作者、pending 与 journal；不得优先使用旧内存记录或 Native 导出替换物理 raw。正常 Native 工作区的“下载本地草稿”仍使用既有完整原生草稿格式；两者的用途和保全范围不同。

上述 C 行为的具体真实验证见对应报告。C 停止时 D/E 尚未执行；随后 D（5849c5b918755febf91b000f1a3cb5d5ece29817）与 E（35c8009c28b54681425d14bcfbf479f8e6168e27）已有实现与各自报告。D 的 513/1024 六份实际 Native/YOLO/COCO 导出及分页校验、E 的联合工程与正式构建证据只适用于各报告所绑定 commit，不等于当前 HEAD 重验，也不使 T32/T35 或再分发许可通过。
