# HTTP API 使用参考

读者：浏览器/API 客户端开发者、配置项目成员和验收数据生命周期的维护者。读后行动：在正常 session 权限下构造请求，读取不可变版本，处理 CAS、租约、导入损失及固定审核/快照。本文依据当前 Rust router、handler 与 annotation-domain DTO 核对，不表示本轮产品 smoke 或模型渠道已通过；可执行例子的真实运行记录由本轮报告给出，未运行的分支仍未验证。

总路由摘要只维护在[契约 C6](contracts.md#c6-http-路由清单)。本页按使用场景解释各 handler，不维护第二张摘要索引。首次启动和网页操作见[开始使用](getting-started.md)，管理员操作见[运维](operations.md)，保存状态与数据所有权见[数据模型](data-model.md)。

## 同源、Host、Origin、session 与 CSRF

- 使用启动器输出的精确 `WEBLABEL_LOCAL_URL`，不要把 `localhost` 和 `127.0.0.1`、Web 端口和私有 API 端口互换。Host 必须在服务允许列表；提供 Origin 时必须精确匹配允许来源。普通浏览器写请求携带 Cookie 时必须有精确 Origin 和 `x-csrf-token`；管理员恢复是下文独立 code 授权的维护接口，不放松普通路由。
- session Cookie 名为 `weblabel_session`，Path=/、HttpOnly、SameSite=Strict，按服务配置加 Secure，有效期 12 小时。不要从网页 JavaScript 读取 HttpOnly Cookie，也不要把 Cookie、CSRF 或密码写进报告。登录返回 CSRF，身份另外读取 GET session。
- 通用鉴权错误：401 `UNAUTHENTICATED`；500 `AUTHENTICATION_FAILED`；403 `HOST_NOT_ALLOWED`、`ORIGIN_NOT_ALLOWED`、`ORIGIN_REQUIRED`、`CSRF_REQUIRED`、`CSRF_INVALID`。平台管理员不是自动的项目成员；读写仍按项目 membership 判断。
- 本文“成员”指 admin/annotator/reviewer/viewer 任一项目角色；“写角色”仅 admin/annotator。“无 query/无 body”表示该 handler 不消费这些参数，不代表所有 handler 会拒绝多余字段。
- `GET /health` 不要求 session，返回 **204，无 JSON**；不是数据库、WebGPU 或模型可用性证明。
- wire `schema_version=1`、私有 Host `protocol_version=1`；公开 URL 没有 `/v1` 前缀。`POST /internal/agent-tools/{tool}` 是 run-scoped Bearer 内部能力，不是浏览器 session API；Cookie 不能授予 tool 权限。`/internal/test/jobs/drain` 只在 debug 构建编译且要求平台管理员，不用于生产调用或 release 验收。

## 序列化、分页与返回边界

生成 wire 的精确字段见[契约 C1](contracts.md#c1-序列化与错误)、[C2](contracts.md#c2-ontology-与媒体)、[C4](contracts.md#c4-候选与模型运行)及生成契约。字段 snake_case；ID 不透明；显式 nullable 字段必须发送 null；浮点数保持最短可往返表示，不能取整或用 epsilon 改写。UTC 时间为 RFC3339；安全整数上限 2^53−1。生成 DTO 通常拒绝未知字段，但 handler-local JSON/结构不能一概称为同样严格。

列表返回 `items` 和 `next_cursor`；仅下文明确分页的接口消费 cursor/after。继续页必须使用服务端返回的 cursor，URL 编码后发送；null 表示停止。有些 handler 满页就返回 cursor，下一页为空是正常情况。分页不是跨请求固定快照；冻结数据需 DatasetVersion。无分页列表不会因传入 limit 而变成分页。

以下已生成：BootstrapStatus、AdminRecoveryState/Status/Request、OntologyVersion、MediaRevision、AnnotationRevision、SaveRequest/SaveResponse、AnnotationHeadSummary/Page、AssetAnnotationHead/Page、ProjectMemberPage、ModelProfile、StartRunRequest、AI preview/consent、SuggestionSet、RunEvent、ActivityCheckpoint/Session/Page。session 身份、users/projects、任务/审核、import/export/snapshot 还有局部结构/JSON 返回，不把它们冒充已生成 DTO。

## Session

### 读取初始化状态

`GET /api/session/bootstrap`：无 body/query，无需登录；200 `BootstrapStatus={mode,bootstrap_available}`。mode 为 initial/restore/login。只读，不消费码、不返回身份或用户计数。初始空库 initial；有用户且服务明确进入合格恢复状态、没有有效密码和任何 session 才是 restore；其他为 login。码未过期且未被占用/消费时才 available。500 `BOOTSTRAP_STATUS_FAILED` 时不能猜模式。所有 session router 响应均 no-store，包括鉴权拒绝。

### 使用一次性码建立身份

`POST /api/session/bootstrap`：JSON `{launch_code,password}`，密码 12–1024 UTF-8 字节；无 query。200 设置 Cookie，返回 `{user_id,username,csrf_token}`。初始身份 local-admin；恢复创建全新 restore-admin-UUID，保留旧审计身份。码来自本轮 API 启动终端；恢复 CLI 不打印码。

400 `INVALID_REQUEST`/`INVALID_PASSWORD`；401 `INVALID_BOOTSTRAP_CODE`；409 `BOOTSTRAP_USED`/`BOOTSTRAP_UNAVAILABLE`。这是一次性事务，不是普通密码重置，也没有 operation_id 重放协议。返回不明先 GET 状态并核对正常登录，不反复消费启动码。

### 普通登录、读取身份、退出

`POST /api/session/login`：JSON `{username,password}`，用户名 3–64 ASCII 字母数字或 `._-`，密码 12–1024 UTF-8 字节。200 设置 Cookie，**body 只有 `{csrf_token}`**，不返回 user_id 或项目角色。无 query。无 Cookie 的登录可正常建立会话；替换失效 Cookie 可重新登录；有效 session 发登录写请求仍需 Origin/CSRF。

400/401 `INVALID_CREDENTIALS`（格式/密码不正确），429 `LOGIN_RATE_LIMITED`，500 `LOGIN_FAILED`。限流按 60 秒窗口，每用户名最多 8 次，已知/未知用户名各有全局 1024 次窗口预算；不要自动高速重试。

`GET /api/session`：无 body/query；200 `{user_id,username,platform_admin,project_roles:[{project_id,role}]}`，**没有 csrf_token**。401 `UNAUTHENTICATED`；传入失效 session 时附 Max-Age=0 清 Cookie；500 `AUTHENTICATION_FAILED` 不当作失效会话。

`POST /api/session/logout`：无语义 body/query，有 Cookie 的写请求需 Origin/CSRF。204 并清 Cookie，服务端删除 session；401 `UNAUTHENTICATED`，500 `LOGOUT_FAILED`。不返回 JSON。

### 管理员密码恢复维护

只由本机操作者按[恢复步骤](operations.md#管理员密码恢复)配置两输入环境变量启用，绑定已有有密码的 platform_admin；与 restore bootstrap 互斥。正常启动不开放重置授权；维护不挂载普通认证/业务/Agent 路由、不启动 workers。完成后仍维护，移除输入变量、正常重启才可登录。

`GET /api/session/password-recovery`：无需 session，无语义 body/query；200 生成的 `AdminRecoveryStatus={state,request_id,username}`。`disabled` 时两值为 null；`available`/`expired`/`completed` 返回当前请求 UUID 和目标用户名，不返回恢复码、user_id、session 或 CSRF。只读且不消费码；GET 等待正在进行的 hash/commit gate 结算后才报告 availability，500 `RECOVERY_FAILED` 不能猜状态。

`POST /api/session/password-recovery`：生成的 `AdminRecoveryRequest={recovery_code,password}`，拒绝未知字段；网页另做密码确认，服务不接收确认字段。授权只依赖随机终端码，既有 Cookie/CSRF 不授予权限；无论是否带 Cookie，POST 都必须有精确匹配 Origin 和唯一合法 Host，浏览器使用 credentials:omit。码严格匹配，网页仅 trim 码；密码不 trim，12–1024 UTF-8 字节。200 返回同一请求/目标的 `completed` Status，**不设 Cookie、不返回 CSRF、不自动登录**。

同事务插入不可修改的 request ID completion、更新原账号 Argon2id 哈希、删除该账号全部 session；目标身份/管理员角色/有效期再次核验，失败回滚。码有效期600秒、一次性，不是 operation_id 重放协议；已完成 request ID 持久防复用，重启不能再次启用。

全部恢复响应（含 gate 拒绝）`Cache-Control: no-store`。404 `RECOVERY_DISABLED`；400 `INVALID_PASSWORD`（JSON/字段或密码不合格）；401 `INVALID_RECOVERY_CODE`（错误或过期）；409 `RECOVERY_COMPLETED`（已经完成；等待另一提交结算后复查，不因只读查询冲突）；429 `RECOVERY_RATE_LIMITED`（每进程恢复请求60秒窗口最多8次码尝试，附 Retry-After）；500 `RECOVERY_FAILED`；Host/Origin错误沿用403。普通认证/业务/Agent 路由维护期间503 `RECOVERY_MAINTENANCE`，`GET /health` 保持204诊断。

POST 结果未知只读 GET 核对同一 request ID/用户名，不自动重发；仅核对 `available` 后可人工重新提交。`completed` 要求退出维护后正常登录核实；状态读取失败或请求身份改变不能解锁。

## Users、Projects、Members、Ontology

### 用户管理

`GET /api/users`：platform_admin专用，无body；limit默认100、1–100，cursor排他user_id排序，200 `{items:[{user_id,username,created_at}],next_cursor}`，不含密码。400 `INVALID_LIMIT`，403 `PLATFORM_ADMIN_REQUIRED`，500 `USER_LIST_FAILED`。

`POST /api/users`：platform_admin，JSON `{username,password}`，范围同普通登录；201 `{user_id,username}`，新用户 platform_admin=false。400 `INVALID_USER`，409 `USERNAME_EXISTS`，500 `USER_CREATE_FAILED`。没有 operation_id；同名不等于原 POST 的 ACK，也不能借 409 自动覆盖密码。返回不明先只读查用户，人工核实后继续。

### 项目

`GET /api/projects`：任意已登录用户，无 query/body；200 `{items:[{project_id,name,description,allow_self_review,role}],next_cursor:null}`，只列本人 membership，按创建时间/ID 排序。500 `PROJECT_LIST_FAILED`。

`POST /api/projects`：任意已登录用户，无 query；必填 `{name,description,allow_self_review}`。name trim 后非空、原输入≤128 UTF-8 字节；description≤4096 字节；allow_self_review 必须 boolean。201 `{project_id,name,description,allow_self_review}`，创建者成为项目 admin，外发策略默认 false。400 `INVALID_PROJECT`，500 `PROJECT_CREATE_FAILED`。没有 operation_id，不自动重试未知创建。

### 成员

`GET /api/projects/{project_id}/members`：仅该项目 admin（平台 admin 不能替代 membership）；query `limit` 默认100、1–100，`cursor` 可省略，按 user_id 排他排序。200 `ProjectMemberPage={items:[{user_id,username,role}],next_cursor}`。400 `INVALID_LIMIT`，403 `PROJECT_ADMIN_REQUIRED`，404 `PROJECT_NOT_FOUND`，500 `PROJECT_MEMBER_READ_FAILED`。

`POST /api/projects/{project_id}/members`：项目 admin；JSON `{user_id,role}`，role 为 admin/annotator/reviewer/viewer。200 `{project_id,user_id,role}`。同一成员已存在时替换角色；降低写权限会在事务中请求取消该 actor 的排队/运行模型。无 operation_id、无 query。400 `INVALID_MEMBERSHIP`，403 `PROJECT_ADMIN_REQUIRED`，404 `PROJECT_NOT_FOUND`/`USER_NOT_FOUND`，500 `MEMBERSHIP_FAILED`。不应盲目重发角色覆盖。

### Ontology 读取与发布

`GET /api/projects/{project_id}/ontologies`：成员，无 query/body；200 `{items:OntologyVersion[],next_cursor:null}`，version_no 降序。404 `PROJECT_NOT_FOUND`，500 `ONTOLOGY_READ_FAILED`。

`POST /api/projects/{project_id}/ontologies`：项目 admin，无 query，必填 `{labels,guidelines_markdown}`；201 完整 `OntologyVersion`，服务端生成 ontology_version_id/version_no/project_id，allow_out_of_bounds=false。guidelines≤65536 UTF-8 字节；labels 1–512，label_id 唯一且非空≤128字节；name trim 非空≤128字节；color 非空≤32字节；shortcut 为 null 或一个字节字符串；allowed_geometry_types 恰为 `["bbox_xyxy"]`；attributes 必填数组且 key 唯一。

每个 AttributeDef 必有 key/kind/required/default_value/enum_values/min/max；key 非空≤128字节；kind enum/boolean/number/text；number 边界 finite/null 且 min≤max；enum 非空唯一 string 数组、默认在集合内，min/max=null；boolean/text 的 enum_values=[]、min/max=null；text 默认≤4096字节。默认 null 可存在，保存文档时仍执行 required 校验。属性精确语义见 C2。

400/422 `INVALID_ONTOLOGY`，403 `PROJECT_ADMIN_REQUIRED`，404 `PROJECT_NOT_FOUND`，500 `ONTOLOGY_PUBLISH_FAILED`。发布不可变新版本，不原位修改旧任务/文档；无 operation_id，未知发布先 GET 核对，不能自动再发布一版。

### 外发策略

`GET /api/projects/{project_id}/external-processing-policy`：成员；无 query/body；200 `{allow_external_processing}`。`PUT` 同路径：项目 admin，JSON 只接受 `{allow_external_processing:boolean}`，200 同 body；既有及新项目默认 false。400 `INVALID_EXTERNAL_PROCESSING_POLICY`，403 `PROJECT_ADMIN_REQUIRED`，404 `PROJECT_NOT_FOUND`，500 `EXTERNAL_PROCESSING_POLICY_FAILED`。

禁用会事务性 cancel_requested 外部运行并拒绝后续披露；已经传出的数据无法收回。此策略不代替逐次 preview/consent，也不创建 profile。

## Media

### 上传与异步结果

`POST /api/projects/{project_id}/assets`：写角色；无 query。multipart 的每张图使用重复字段 `images`，必须 filename；`Idempotency-Key` header 必填、非空≤128字符。同批最多500张；整个 multipart/累计图像预算64 MiB。仅 PNG/JPEG、单帧、受支持 RGB 编码；最大边4096、像素16777216、文件名255字节。服务选当前最新 ontology（先发布），同批分配 source_group_id。

202 `{import_job_id,duplicate}`。必须 GET job 等待工作完成，不能把202视为媒体或 annotation 已存在。队列幂等范围为 project + media_import + operation；同actor及同批完整输入重放返回已有job，actor也包含于payload，其他actor复用operation并不获得同一请求ACK；变更输入为409 `IDEMPOTENCY_CONFLICT`。

错误：400 `IDEMPOTENCY_KEY_REQUIRED`、`INVALID_MULTIPART`、`EMPTY_BATCH`/`INVALID_IMPORT`；413 `UPLOAD_TOO_LARGE`、`TOO_MANY_IMAGES`；422 `ONTOLOGY_REQUIRED`/`INVALID_MEDIA`；403 `PROJECT_WRITE_REQUIRED`；404 `PROJECT_NOT_FOUND`；503 `QUEUE_FULL`；500 `PROJECT_LOOKUP_FAILED`、`ONTOLOGY_LOOKUP_FAILED`、`MEDIA_IMPORT_FAILED`。异步逐项失败还可记录具体媒体限制 code，读取 result 而不是只读 HTTP202。

### 媒体列表与图片

`GET /api/projects/{project_id}/assets`：成员；query limit 默认50、1–100，cursor 可省略、提供时非空≤128字节，排他 asset_revision_id；没有 filter 语义。200 `{items:MediaRevision[],next_cursor}`。400 `INVALID_PAGE`，404 `PROJECT_NOT_FOUND`，500 `PROJECT_LOOKUP_FAILED`，存储错误沿媒体错误分支。满页可能给 cursor，继续至空/null。

`GET /api/assets/{asset_revision_id}/image`：成员；无 query/body；200 canonical PNG，Content-Type=image/png、private/no-cache、nosniff、ETag 为带引号 SHA256。If-None-Match 精确匹配返回304无 body。404 `MEDIA_NOT_FOUND`；500 `MEDIA_LOOKUP_FAILED`/`MEDIA_IMPORT_FAILED`，无权访问不会公开媒体存在性。canonical 与 original 变换见 C2；不要把 original 坐标当 canonical 坐标。

## Annotation、Import、Export

### 当前和历史版本

`GET /api/assets/{asset_revision_id}/annotation`：成员；必填 query ontology_version_id，合法非空 ID≤128字符；200 `AnnotationRevision`。400 `ONTOLOGY_VERSION_REQUIRED`/`INVALID_ONTOLOGY_VERSION_ID`，404 `ANNOTATION_NOT_FOUND`，500 `ANNOTATION_READ_FAILED`/`ANNOTATION_CORRUPT`。head 按资产与 ontology 隔离，不自动挑最新 ontology。

`GET /api/annotation-revisions/{annotation_revision_id}`：成员；无 query/body；200 不可变 `AnnotationRevision`。404 `ANNOTATION_NOT_FOUND`，500 `ANNOTATION_READ_FAILED`/`ANNOTATION_CORRUPT`；审核和导出引用该 ID，而不是“当时最新 head”。

### 两种 heads 集合

`GET /api/assets/{asset_revision_id}/annotation-heads`：成员；limit 默认100、1–100；cursor 为排他 ontology_version_id。200 `AnnotationHeadPage`，items 每项字段为 ontology_version_id/annotation_revision_id/revision_no/content_hash/completion/object_count/approved_review_id（可null）。这是资产所有规范 heads；共享 query 中 ontology_version_id **不用于过滤**。400 `INVALID_LIMIT`，404 `ASSET_NOT_FOUND`，500 `ANNOTATION_HEAD_READ_FAILED`。

`GET /api/projects/{project_id}/annotation-heads`：成员；必填非空 ontology_version_id、limit 默认100、1–100，cursor 为排他 asset_revision_id。200 `AssetAnnotationHeadPage={items:[{media:MediaRevision,head:AnnotationHeadSummary|null}],next_cursor}`。先分页媒体再 LEFT JOIN 指定规范 head，缺失 head 保留为null，不能误当空标注/负样本。400 `INVALID_LIMIT`/`ONTOLOGY_REQUIRED`，404 `PROJECT_NOT_FOUND`/`ONTOLOGY_NOT_FOUND`，500 `ANNOTATION_HEAD_READ_FAILED`。approved_review_id 只属于该精确 revision，后续 head 不继承旧批准。

### 保存完整文档

`PUT /api/assets/{asset_revision_id}/annotation`：写角色；无 query；JSON `SaveRequest={operation_id,base_revision_id,document,lease,suggestion_decisions}`，全部必填，lease 无任务时显式 null，普通编辑 suggestion_decisions=[]。body≤32 MiB；base 必须已有非null head ID；document 的资产、规范、canonical尺寸、completion、对象/属性及真实 provenance 都需验证。operation_id 是合法不透明 ID（客户端例子用 UUID），不要求用 revision_no 作 CAS。

200 `SaveResponse={operation_id,revision,idempotent_replay}`。新写入在同一事务校验写权限、任务lease/fence、ontology、provenance、当前base并写revision/head、候选journal和幂等记录。同 actor、相同 operation 与完整内容重放返回同 revision，idempotent_replay=true；当前写权限仍要求满足，但成功历史重放不重新要求当下 lease/head。原请求的 lease/body/base/journal 不能换成新值来“重放”。

新写入：资产无任务时有lease反而409 `LEASE_NOT_REQUIRED`；有任务必须唯一open任务及其lease，且holder为本人、服务端expires_at未过期、fencing_token正确、document ontology固定。拒绝码409 `LEASE_REQUIRED`、`LEASE_NOT_HELD`、`LEASE_EXPIRED`、`STALE_FENCING_TOKEN`、`TASK_NOT_OPEN`、`TASK_STATE_INVALID`、`TASK_ONTOLOGY_MISMATCH`。角色或 lease 更新不会使旧未知请求自动变成新的可写操作。

其他错误：400 `INVALID_SAVE_REQUEST`；413 `ANNOTATION_TOO_LARGE`；409 `IDEMPOTENCY_KEY_REUSE`（同operation不同内容）、`REVISION_CONFLICT`（base不是当前head）、`REVISION_LIMIT_REACHED`；404 `ANNOTATION_NOT_FOUND`；403 `PROJECT_WRITE_REQUIRED`；422 `ASSET_REVISION_MISMATCH`、`COORDINATE_SPACE_MISMATCH`、`ONTOLOGY_NOT_FOUND`、`UNVERIFIED_PROVENANCE`及领域校验code；500 `ONTOLOGY_CORRUPT`、`ANNOTATION_SAVE_FAILED`、`IDEMPOTENCY_RECORD_CORRUPT`、`SAVE_ROLLBACK_FAILED`；503 `SAVE_UNAVAILABLE`。候选接受/revert 还校验固定pins、before_hash、change_ids和journal转换，错误包括 `SUGGESTION_SET_NOT_APPLICABLE`、`SUGGESTION_SET_NOT_FOUND`、`EMPTY_SELECTION`、`TOO_MANY_CHANGES`、`CHANGE_NOT_FOUND`、`ALREADY_ACCEPTED`、`REVERT_WITHOUT_ACCEPT`、`STALE_ASSET`、`STALE_CANONICAL_HASH`、`STALE_ONTOLOGY`、`STALE_BASE_REVISION`及共享候选校验code；不只保存几何而丢弃journal。

### 导入预览

`POST /api/assets/{asset_revision_id}/annotation-import-previews`：写角色，无query；multipart 单次字段 format（native/yolo/coco）、ontology_version_id、data（≤32 MiB）；YOLO另必填 label_ids（JSON有序实际label ID数组）；COCO可给整数 source_image_id（多图需显式定位）；其他格式不接受这两种映射。重复或未知字段拒绝。native data 为安全ZIP；YOLO为UTF-8文本；COCO为JSON，不是数据集ZIP。native匹配目标canonical hash、尺寸及完整ontology。

200 局部 `PreviewResponse={import_batch_id,document,loss_report,base_revision_id,base_revision_no}`。只冻结预览，不改head；预览不幂等，每次创建新batch。阅读loss_report后才能确认，native重导入也会报告源revision身份/历史被新revision替代的损失。

400 `IMPORT_MULTIPART_INVALID`、`IMPORT_FIELD_DUPLICATE`、`IMPORT_FIELD_INVALID`、`IMPORT_FORMAT_REQUIRED`/`IMPORT_FORMAT_INVALID`、`ONTOLOGY_VERSION_REQUIRED`、`IMPORT_DATA_REQUIRED`、`SOURCE_IMAGE_ID_INVALID`/`SOURCE_IMAGE_ID_UNEXPECTED`、`LABEL_IDS_UNEXPECTED`、`YOLO_LABELS_REQUIRED`；400/422 `IMPORT_INVALID`；422 `NATIVE_TARGET_MISMATCH`；404 `IMPORT_TARGET_NOT_FOUND`；403 `PROJECT_WRITE_REQUIRED`；503 `IMPORT_UNAVAILABLE`；500 `IMPORT_READ_FAILED`、`ONTOLOGY_CORRUPT`、`IMPORT_SERIALIZE_FAILED`、`IMPORT_WRITE_FAILED`、`IMPORT_ROLLBACK_FAILED`。

### 确认导入

`POST /api/annotation-import-previews/{import_batch_id}/commit`：同预览actor且仍有写权限；JSON `AnnotationImportCommitRequest={loss_ack,operation_id,lease}`，operation UUID，lease显式null或SaveLease；无query。200 `{import_batch_id,revision,idempotent_replay}`。有损必须明确loss_ack=true。新写入复查preview base ID/number并校验与保存相同lease/fence规则，同事务产生一个revision；精确成功历史重放不再执行新写资格检查。同actor/operation更改batch/body为409 `IDEMPOTENCY_CONFLICT`（不是保存的KEY_REUSE名称）。

400 `INVALID_IMPORT_COMMIT`/`INVALID_OPERATION_ID`；404 `IMPORT_PREVIEW_NOT_FOUND`；403 `PROJECT_WRITE_REQUIRED`；409 `IMPORT_ALREADY_COMMITTED`/`REVISION_CONFLICT`及保存lease码；422 `LOSS_ACK_REQUIRED`/`IMPORT_INVALID`；500 `IMPORT_CORRUPT`、`IMPORT_READ_FAILED`、`ONTOLOGY_CORRUPT`、`IMPORT_SERIALIZE_FAILED`、`IMPORT_WRITE_FAILED`、`IMPORT_ROLLBACK_FAILED`；503 `IMPORT_UNAVAILABLE`。明确base冲突应创建新预览并重新审阅损失，不修改旧preview。

### 单图版本导出与公共下载

`POST /api/annotation-revisions/{annotation_revision_id}/exports`：成员（不要求写角色）；无query；JSON `{format,loss_ack,operation_id}`，format=native/yolo/coco，operation UUID。200 `{export_id,format,download_url,byte_size,object_sha256,loss_report}`；同步生成，不返回job或DatasetVersion。相同actor/operation/request重放返回已有产物，不另生成；不同请求409 `IDEMPOTENCY_CONFLICT`。

native保存版本/ontology/canonical图无损，YOLO丢属性等数据、需按报告确认；COCO也按实际loss_report决定确认。422 `LOSS_ACK_REQUIRED` 的 details.loss_report 应先显示给操作者，不自动设置true。单图COCO下载为 **application/json/.json**；native/YOLO为ZIP（YOLO含labels.txt和label_ids.json）。

400 `INVALID_OPERATION_ID`/`EXPORT_FORMAT_INVALID`；404 `ANNOTATION_REVISION_NOT_FOUND`；422 `EXPORT_INVALID`/`LOSS_ACK_REQUIRED`；500 `ANNOTATION_CORRUPT`、`ONTOLOGY_CORRUPT`、`MEDIA_OBJECT_MISSING`、`EXPORT_READ_FAILED`、`EXPORT_CORRUPT`、`EXPORT_WRITE_FAILED`、`EXPORT_SERIALIZE_FAILED`、`EXPORT_ROLLBACK_FAILED`；503 `EXPORT_UNAVAILABLE`。

`GET /api/exports/{export_id}/download`：当前项目成员；无query/body；返回鉴权文件、Content-Length、attachment文件名、`X-WebLabel-Loss-Report` JSON。数据集export需job succeeded；其所有format都是ZIP。404 `EXPORT_NOT_FOUND`（也涵盖尚未成功或不可见）；500 `EXPORT_READ_FAILED`、`EXPORT_OBJECT_MISSING`、`EXPORT_DOWNLOAD_FAILED`。URL不是可公开分享的无鉴权链接。媒体/对象hash不是snapshot manifest hash。

## AI 与 Jobs

### 持久 profile 的公开投影

`GET /api/model-profiles`：已登录，无query/body；200 `{items:ModelProfile[],next_cursor:null}`，profile_id排序，过滤 retired codex_local，不返回config/secret_ref。字段 profile_id/provider_id/model_id/auth_kind/capabilities/availability/verification/runtime_version/verified_at，nullable显式null。500 `PROFILE_LIST_FAILED`；空库为空数组，配置入口如下。

### 服务端固定预设配置

以下三个接口仅 platform_admin；403 `PLATFORM_ADMIN_REQUIRED`，不由项目 admin 身份替代。DTO 为 handler-local，预设与 PUT 不是 generated contracts。常规 Cookie/Origin/CSRF gate 仍生效。

- `GET /api/model-profile-presets?limit=50`：limit 默认50、1–100，after 为上页 next_cursor，profile_id 排序。200 `{items:[{preset_id,profile_id,provider_id,model_id,auth_kind,capabilities,configuration_hash,configured,availability,availability_reason}],next_cursor}`。未设置或明确为空的Host配置正常返回空页；无 body；400 `INVALID_PAGE`；422 `HOST_CONFIGURATION_UNAVAILABLE` 表示真实不可读/格式无效/歧义。只返回脱敏固定身份、状态和哈希，不回传秘密或启动路径。
- `PUT /api/model-profiles/{profile_id}`：无query，JSON仅 `{configuration_hash}`，拒绝未知字段；profile_id 与哈希必须来自同一实际预设。200 `ModelProfile`。首次创建 verification=not_run、runtime_version/verified_at=null；同一完整身份/哈希可返回已有 profile，不覆盖历史不同配置。404 `PRESET_NOT_FOUND`；409 `PROFILE_CONFIGURATION_CONFLICT`；422 `DETECTOR_IDENTITY_UNAVAILABLE` 或 `HOST_CONFIGURATION_UNAVAILABLE`；存储错误500 `PROFILE_LIST_FAILED`。此动作不登录、不下载、不推理。
- `GET /api/model-profiles/{profile_id}`：无query/body，200 `{profile:ModelProfile,configuration_hash}`；404 `PROFILE_NOT_FOUND`，500 `PROFILE_LIST_FAILED`。未知 PUT 只读比较原 profile/provider/model/auth/capabilities/哈希；匹配仅证明当前配置，不证明原请求唯一归属。404不证明原写入未在途。

完整调用次序：管理员 GET 预设全部页，明确选择一项，用该 profile_id 与原哈希 PUT，再 GET 同一 profile 核对。不可提交自拟 provider/model/secret/path/args；ready 和 configured 不能替代 live_passed、项目外发政策或每次 preview/consent。

### 不执行模型的 preview 与 consent

`POST /api/ai/previews`：写角色；无query；JSON `AiPreviewRequest={request:StartRunRequest,grants:{allow_image,allow_object_context,preview_crop}}`，crop必填且null表示完整图像；非null必须canonical图内整数像素边界，且allow_image=true。4 MiB预算，prompt≤8192字符，object_hashes≤10000；所选对象ID不能重复。context完整pins见C4，必须当前head和实际媒体hash；空selected_object_ids配allow_object_context=true表示全部对象，应固定全部hash。

201 `AiPreviewResponse={preview_id,input_fingerprint,execution_configuration_hash,request,profile,grants,expires_at}`，服务端固定规范化request/profile/config/grants并生成权威fingerprint，有效10分钟，**不执行模型**。request.consent_id被置null，不能以自报fingerprint授权。

400 `INVALID_PREVIEW`；413或403 `PREVIEW_TOO_LARGE`；403 `DUPLICATE_SELECTED_OBJECT`、`PROFILE_UNAVAILABLE`、`EXTERNAL_PROCESSING_FORBIDDEN`、`IMAGE_INPUT_UNSUPPORTED`、`PREVIEW_INPUT_CHANGED`、`CONTEXT_HASH_MISMATCH`；422 `INVALID_APPROVED_REGION`；profile/context查询还可能404 `PROFILE_NOT_FOUND`/`ASSET_NOT_FOUND`/`ANNOTATION_NOT_FOUND`，403 `PROJECT_WRITE_REQUIRED`，422 `INPUT_HASH_MISMATCH`/`CONTEXT_OBJECT_UNKNOWN`，409 `PROVIDER_RETIRED`；500 `AUTHORIZATION_STORAGE_FAILED`/`PROFILE_LOOKUP_FAILED`/`PROFILE_INVALID`/`RUN_LOOKUP_FAILED`。

`POST /api/ai/consents`：同preview actor；无query；JSON仅 `{preview_id}`（≤4096 bytes）；201 `{consent_id,preview_id,input_fingerprint,expires_at}`。重验preview固定输入/配置/权限/到期；只是批准，不执行模型；没有operation_id，每次成功新consent。400 `INVALID_CONSENT`，403 `CONSENT_TOO_LARGE`/`PREVIEW_EXPIRED`/`PREVIEW_INPUT_CHANGED`，404 `PREVIEW_NOT_FOUND`及上述授权查询错误，500 `AUTHORIZATION_STORAGE_FAILED`。不要把旧consent跨actor、跨pins、跨profile复用。

### 创建与取消运行

`POST /api/ai/runs`：写角色；无query；**一个**StartRunRequest，不接受数组。operation_id合法ID；profile_id、context、intent（detect/audit_attributes/find_issues）、prompt、consent_id全部必填，实际新运行要求有效consent。context必有 project_id/asset_revision_id/annotation_revision_id/ontology_version_id/draft_generation/canonical_sha256/selected_object_ids/object_hashes/input_fingerprint。draft_generation不是revision_no。body≤4 MiB，prompt≤8192字符，object_hashes≤10000，input_fingerprint非空≤128字符。

202 展开的局部RunSummary加idempotent_replay：run_id/project_id/state/source/intent/profile_id/provider_id/model_id/verification/input_fingerprint/request_hash/job_id/cost_display/cancel_requested/created_at/started_at/finished_at。不是 `{runs:[]}`。同actor/operation/原输入返回原运行不重复计费；同operation不同输入409 `IDEMPOTENCY_KEY_REUSE`。新运行重验consent、profile、项目外发和输入，真实dispatch/工具读取继续重验。未知运行不可另起operation重发。

错误400 `INVALID_RUN_REQUEST`/`INVALID_OPERATION_ID`，413 `RUN_REQUEST_TOO_LARGE`/`PROMPT_TOO_LARGE`/`OBJECT_HASHES_TOO_LARGE`，422 `INPUT_FINGERPRINT_INVALID`/`INVALID_CONSENT_ID`及context校验，403 `CONSENT_REQUIRED`/`CONSENT_INVALID`/`CONSENT_PREVIEW_REQUIRED`/`CONSENT_INPUT_MISMATCH`以及preview授权码；503 `RUN_QUEUE_FULL`；500 `RUN_CREATE_FAILED`/`IDEMPOTENCY_RECORD_CORRUPT`及查询/授权存储码。profile不可用绝不降级成mock。

`POST /api/ai/runs/{run_id}/cancel`：项目写角色；无query；body可省略（读取最多4096字节，无语义）。200 RunSummary；重复取消幂等，终态不会再变运行，能力token撤销，迟到输出隔离，取消不保证未产生成本。404 `RUN_NOT_FOUND`，403 `PROJECT_WRITE_REQUIRED`，500 `RUN_CANCEL_FAILED`。取消本身不重启模型。

### 事件、候选及决策

`GET /api/ai/runs/{run_id}/events`：成员；query after 默认0（非负i64序号字符串）、limit默认100、1–200。200 `{run:RunSummary,items:RunEvent[],next_cursor}`，按seq升序，下一页仍用after。400 `INVALID_EVENTS_QUERY`，404 `RUN_NOT_FOUND`，500 `EVENTS_READ_FAILED`/`RUN_LOOKUP_FAILED`。每run只保留最近2000事件；不能把轮询当完整永久日志。interrupted使用failed事件及data.interrupted表达，不新增event_type。

`GET /api/ai/runs/{run_id}/suggestions`：成员；after可省略，提供时非空≤128字符且必须该run已有suggestion_set_id；limit默认100、1–500。200 `{run,items:SuggestionSet[],next_cursor}`，按创建rowid继续；next_cursor再次作为after。400 `INVALID_SUGGESTIONS_QUERY`，404 `RUN_NOT_FOUND`，500 `SUGGESTIONS_READ_FAILED`/`RUN_LOOKUP_FAILED`。候选不是已保存annotation。

`POST /api/ai/suggestions/{suggestion_set_id}/decision`：项目写角色（不可见/非写角色404）；无query；≤4096字节JSON仅 `{decision:"reject"}`；200 `{suggestion_set_id,state:"rejected",idempotent_replay}`，重复reject=true。accept返回409 `ACCEPT_REQUIRES_SAVE`；接受和revert必须随SaveRequest journal同事务，不能调用此端点单独接受。已accepted集合409 `ACCEPTED_SET_REQUIRES_REVERT`。其他：400/422 `INVALID_DECISION`，413 `DECISION_TOO_LARGE`，404 `SUGGESTION_NOT_FOUND`，500 `DECISION_FAILED`。

### 通用作业状态

`GET /api/jobs/{job_id}`：项目成员；无项目job仅platform_admin；无query/body；200 `{job_id,project_id,kind,state,progress_completed,progress_total,progress,result}`。progress/result可null，按kind解释；**没有通用顶层items字段**。media逐图结果、model逐asset结果在对应result中；dataset succeeded的result包含export_id/download_url等供下载。404 `JOB_NOT_FOUND`（含不可见），500 `JOB_READ_FAILED`。轮询等待succeeded/failed，不用debug drain推动生产队列。

### 逐项拒绝与持久 journal

POST /api/ai/suggestions/{suggestion_set_id}/rejections：项目写角色，无query；JSON仅 `{operation_id,change_ids}`，未知字段拒绝，change_ids非空、不重复、有序且最多1000项。200 `{suggestion_set_id,operation_id,change_ids,created_at,idempotent_replay}`。同operation/set/actor/有序payload重放返回原回执；不同payload409 OPERATION_CONFLICT；422 INVALID_REJECTION/CHANGE_NOT_FOUND；409 ACCEPTED_CHANGE_REQUIRES_REVERT；403 PROJECT_WRITE_REQUIRED；404 SUGGESTION_NOT_FOUND；500 REJECTION_FAILED。独立事务写拒绝journal，不改revision/head或几何undo；已接受项需先通过SaveRequest撤销，接受被拒项409 CHANGE_REJECTED。整set decision reject仍独立存在。

GET同路径：实际项目成员，operation_id可过滤原操作，after非负整数rowid，limit默认100、1–500。200 `{suggestion_set_id,rejected_change_ids,operations:[{operation_id,change_ids,created_at}],next_cursor}`；400 INVALID_REJECTION_QUERY；404/500同上。汇总IDs不限过滤operation，不能当原POST确认。未知结果保留原payload，完整分页查询同operation并逐项比较set/operation/有序change_ids，不自动重POST，未找到仍可能在途。

### 可核实的运行结果

`GET /api/ai/runs/{run_id}/outcome-summary`：项目成员，仅只读，无模型调用。200返回run、候选/接受/撤销/拒绝journal计数、采纳后对象观察（人工归因仍unknown）、usage/cost以及明确证据关联。404 `RUN_NOT_FOUND`（含不可见），500 `OUTCOME_SUMMARY_FAILED`。

`task_binding`为null或`{basis:"exact_decision_revision_submission",submissions,truncated}`；每项带真实task_id/review_id/annotation_revision_id、asset/ontology视觉pins、该submission审核状态、历史accept/revert种类和set来源。只匹配精确decision保存版本，不从同图或后继head推断；最多100项，截断明确标记。`activity_task_bindings`只来自本人显式run+task区间；`recorded_work_seconds`仅本人已发布且run_id匹配的人工毫秒合计，排除model_wait；无匹配记录为null，仅有已记录等待的人工0是实测零。`work_time_scope="current_actor_explicit_run_intervals"`；这不是完整工时、模型执行任务绑定或ROI，usage/费用未知不填零。

## Tasks、Reviews、Activity

本组共享403 `PROJECT_ROLE_REQUIRED` 与503 `REVIEW_UNAVAILABLE`（activity存储使用ACTIVITY_UNAVAILABLE）；不少请求/响应为handler-local结构，不假称统一生成wire。

### 固定任务

`POST /api/projects/{project_id}/tasks`：项目admin；无query；JSON `{asset_revision_id,ontology_version_id,assignee_id}`，可选project_id若有必须等于路径。assignee必须项目admin/annotator。200 `{task_id,project_id,asset_revision_id,ontology_version_id,assignee_id,state:"open",created_at}`。422 `PROJECT_MISMATCH`/`INVALID_ASSIGNEE`/`ONTOLOGY_MISMATCH`，404 `ASSET_NOT_FOUND`，409 `TASK_EXISTS`，503 `REVIEW_UNAVAILABLE`。无operation_id；未知创建先GET核实，不制造重复任务。任务固定asset与ontology，不能靠后续发布改变。

`GET /api/projects/{project_id}/tasks`：成员，无body；query limit默认100、1–100，cursor为上页next_cursor（task_id排他排序），未知字段拒绝。200 `{items:[{task_id,project_id,asset_revision_id,ontology_version_id,assignee_id,state,created_at,review_id,revision_ids,review_decision,review_reason}],next_cursor}`；400 `INVALID_PAGE`。审核字段可null，pending优先或最新历史submission；不是完整审核历史。读取到next_cursor=null才结束。

### 租约

`POST /api/tasks/{task_id}/lease`：JSON `{action,holder_id:null}`，action=acquire/renew/release/transfer，transfer必须holder_id目标；无query。acquire/renew/release要求项目admin/annotator，通常必须assignee（platform_admin只能豁免assignee比对，不能豁免项目角色）；transfer要求项目admin且目标为写角色。仅open任务可租。

200 `{task_id,holder_id,fencing_token,expires_at_unix,lease_seconds:60,heartbeat_seconds:20}`；release holder=null。expires按服务端时钟秒；同人有效acquire保留token/期限，renew延长期限，过期重新acquire及transfer递增token。lease请求没有客户端fencing_token字段；保存才带它。

400 `INVALID_LEASE_ACTION`/`TRANSFER_TARGET_REQUIRED`；404 `TASK_NOT_FOUND`；403 `TASK_NOT_ASSIGNED`；422 `INVALID_ASSIGNEE`；409 `TASK_NOT_OPEN`/`TASK_LEASED`/`LEASE_EXPIRED`/`FENCING_EXHAUSTED`/`TASK_STATE_CONFLICT`。重复transfer不是幂等重放，会产生新fence，禁止无条件重试。

### 提交与裁决

`POST /api/tasks/{task_id}/submit`：写角色、assignee（平台admin仅豁免assignee）、当前有效本人lease；无query；JSON `{annotation_revision_ids:[一个已保存当前head ID]}`，不接document/lease token。completion需非空complete或空confirmed_negative。200 `{review_id,task_id,submitted_by,revision_ids,state:"pending",created_at,lease_ended:true}`。同事务创建submission、任务改submitted、holder=NULL、expires_at=0、fence+1；无需后续release。

422 `INVALID_SUBMISSION`/`REVISION_MISMATCH`/`INVALID_NEGATIVE`/`EMPTY_NOT_NEGATIVE`/`ANNOTATION_INCOMPLETE`；404 `TASK_NOT_FOUND`；403 `TASK_NOT_ASSIGNED`；409 `TASK_NOT_OPEN`/`LEASE_REQUIRED`/`LEASE_EXPIRED`/`REVISION_NOT_HEAD`/`SUBMISSION_CONFLICT`/`TASK_STATE_CONFLICT`/`FENCING_EXHAUSTED`；500 `REVISION_INVALID`。无operation_id，不承诺重复提交返回同review。

`GET /api/tasks/{task_id}/submission`：项目成员，无query/body，200同提交投影，lease_ended由实际 holder=NULL且expiry=0计算；404 `SUBMISSION_NOT_FOUND`/`TASK_NOT_FOUND`，503 `REVIEW_UNAVAILABLE`。GET是当前最新固定提交观察，不是POST幂等回执。未知提交比对task/actor/唯一revision，不能自动重POST。继续下一任务仅重新GET session、同review提交与分页tasks，核实原lease结束后选择同项目/本人/open另一任务；查找阶段不写租约；显式继续的精准领取/导航须通过原上下文proof和task-open准备屏障。

`POST /api/reviews/{review_id}/decision`：项目reviewer/admin；无query；JSON `{decision:"approve"或"reject",reason,revision_ids:[精确提交ID]}`。reason trim非空≤4096 UTF-8字节；revision_ids必须与submission数组顺序/内容相同。项目allow_self_review=false禁止提交者自审（即使admin）；200 `{review_id,decision,reason,revision_ids,decided_by,created_at}`。approve关闭任务，reject重新open；原submission和裁决不可变，不继承到后续head。无operation_id，重复裁决409而非成功ACK。

422 `INVALID_REVIEW_DECISION`；404 `REVIEW_NOT_FOUND`；403 `SELF_REVIEW_FORBIDDEN`；409 `REVIEW_ALREADY_DECIDED`/`REVIEW_REVISION_MISMATCH`/`TASK_STATE_CONFLICT`；500 `REVIEW_INVALID`。

### 不可变审核问题

`GET /api/reviews/{review_id}/issues`：成员；无query/body/分页；200 `{items:[{issue_id,review_id,annotation_revision_id,ontology_version_id,object_id,code,message,region,created_by,created_at}],next_cursor:null}`。

`POST` 同路径：reviewer/admin；无query；JSON `{annotation_revision_id,object_id:null或实际ID,code,message,region:null或BBox}`。revision必须提交给该review；object必须属于该revision，region在该canonical图内；code/message trim非空，message≤4096字节。200完整issue（字段同列表）。无operation_id，新POST创建新issue，不自动重试。

404 `REVIEW_NOT_FOUND`/`REVISION_NOT_FOUND`；422 `INVALID_ISSUE`/`ISSUE_REVISION_MISMATCH`/`INVALID_ISSUE_REGION`/`ISSUE_OBJECT_NOT_IN_REVISION`；500 `REVISION_INVALID`；503 `REVIEW_UNAVAILABLE`。保存以后仍绑定原revision，不指向可变对象“最新内容”。

### 自愿本人活动记录

`PUT /api/projects/{project_id}/activity-sessions/{session_id}`：任一成员；无query；JSON ActivityCheckpoint `{expected_version,intervals}`。新session expected_version=0；intervals累计1–10000项，seq从0连续，kind=task/annotation/correction/review/switch/model_wait，duration_ms正整数≤86400000，全session累计≤86400000。区间可省略task_id/run_id，不回填旧记录；新后缀ID须真实属于项目，同时绑定时须媒体/规范一致，否则422 INVALID_ACTIVITY。200 ActivitySession `{session_id,version,intervals}`。精确intervals重放返回已有版本；新追加须expected_version匹配且旧前缀完全一致；不能改旧区间，历史关联对象后来变化/删除不改写已存prefix。

`GET /api/projects/{project_id}/activity-sessions`：仅本人该项目；query limit默认20、1–100，cursor为合法session_id、排他排序，不接受未知query字段。200 ActivitySessionPage，无其他actor的记录。422/解析状态 `INVALID_ACTIVITY`；409 `ACTIVITY_CONFLICT`；503 `ACTIVITY_UNAVAILABLE`，通用角色拒绝同上。该功能不改annotation/审核，不是自动遥测。

## DatasetVersion 与数据集导出

### 冻结快照

`POST /api/projects/{project_id}/dataset-versions`：成员（不只admin）；无query；局部JSON `{operation_id,ontology_version_id,items:[{asset_revision_id,annotation_revision_id,split}],excluded:[{asset_revision_id,reason}],split_seed:null,split_ratios:null}`。operation UUID；items至少1；included与excluded全体资产不重复且合计≤1024；exclusion需该项目实际媒体、reason非空。split=train/val/test；同source_group_id不能手工跨split。seed与ratios必须一起给；ratios为3个u32且和非零，按source_group固定分配，会替代items给出的split。

新创建201，精确同actor/operation/request重放200；均返回 `SnapshotResponse={dataset_version_id,project_id,ontology_version_id,items,excluded,category_mapping,manifest_sha256}`，items每项实际asset/revision/split。固定每项媒体、ontology、revision、批准人/理由/时间；每revision必须该任务精确approved、完成条件合法，非“只保存成功”。新冻结capture→校验对象→publish再次复核绑定，不静默纳入并发变化。manifest≤16 MiB，校验媒体最多2048成员/96 MiB；manifest_sha256是冻结snapshot manifest，不是ZIP manifest.json字节hash。

400 `DATASET_REQUEST_INVALID`/`DATASET_ITEMS_INVALID`/`SPLIT_CONFIG_INVALID`/`SPLIT_RATIOS_INVALID`；404 `PROJECT_NOT_FOUND`/`ONTOLOGY_NOT_FOUND`；422 `SNAPSHOT_EXCLUSION_INVALID`/`SNAPSHOT_REVISION_INVALID`/`SNAPSHOT_NOT_APPROVED`/`SNAPSHOT_NOT_READY`/`SNAPSHOT_COMPLETION_INVALID`/`SOURCE_GROUP_SPLIT`；409 `IDEMPOTENCY_KEY_REUSE`/`SNAPSHOT_BINDING_CHANGED`；413 `DATASET_SIZE_LIMIT`（早期scope超限可400 DATASET_REQUEST_INVALID）；500 `ONTOLOGY_CORRUPT`/`ANNOTATION_CORRUPT`/`MEDIA_METADATA_CORRUPT`/`MEDIA_OBJECT_MISSING`/`MEDIA_OBJECT_INVALID`/`DATASET_SERIALIZE_FAILED`/`DATASET_CORRUPT`/`DATASET_PERSIST_FAILED`；503 `DATASET_UNAVAILABLE`。

### 从固定快照导出

`POST /api/dataset-versions/{dataset_version_id}/exports`：成员；无query；JSON `{format,loss_ack,operation_id}`，format=native/coco/yolo、operation UUID。新建202，已有同意图job重放200；body `{job_id,state,format,loss_report}`。先审阅loss，再明确确认；422 LOSS_ACK_REQUIRED带details.loss_report。异步 GET job succeeded 后用result.download_url（或export_id）下载；三个格式均ZIP，不拿单图JSON规则解读。

400 `EXPORT_REQUEST_INVALID`；404 `DATASET_NOT_FOUND`；409 `IDEMPOTENCY_KEY_REUSE`/`SNAPSHOT_BINDING_CHANGED`；413 `EXPORT_SIZE_LIMIT`；422 `LOSS_ACK_REQUIRED`；429 `JOB_QUEUE_FULL`；500 `DATASET_CORRUPT`；503 `EXPORT_UNAVAILABLE`/`EXPORT_STATUS_UNAVAILABLE`。队列幂等范围为 project + dataset_export + operation，actor、format、loss_ack与snapshot绑定包含于payload；不能在同项目由另一actor复用operation而期待成功重放。worker失败进一步记录result.code（对象丢失/损坏、尺寸预算、序列化/读回等），必须读取终态，不把202当产物完成。原快照与review身份不随恢复管理员变化。

### 整组计划与真实体积错误

网页只计划明确include/exclude的已浏览范围；seed非空、默认文本17。SHA-256(seed + NUL + source_group_id)前8字节big-endian模100，0–79/train、80–89/val、90–99/test。按asset ID排序分批，每批含排除≤1024且至少一项纳入；必要时交换项保全全部ID，同组跨批同split，不保证实际数量比例。每批独立DatasetVersion与导出，不是服务端自动规划。

POST可413 EXPORT_SIZE_LIMIT，异步failed job也可result.code=EXPORT_SIZE_LIMIT。typed archive预算错误附可用的budget、limit_bytes、observed_bytes、message；早期路径可能仅code，不编造字节。实际ZIP上限96 MiB，冻结成功不保证体积。保留旧snapshot/job，明确缩小或重新分批新建快照，不改旧manifest、不自动重建；下载成功产物仅GET。

## 错误与未知结果

公开 ApiError 字段为 `{code,message,request_id,details}`，客户端按code分支，不匹配message。本文列 handler 显式错误；Axum某些JSON/query/multipart extractor拒绝尚不统一包络；不要强制所有4xx都能反序列化ApiError。响应 `x-request-id` 与body.request_id不保证相同，报告可分别记录非敏感ID。

超时、连接中断、服务提交失败响应等不能单凭客户端现象断言“未写入”。先保全原operation_id、完整body、base、lease、候选journal、导入batch或快照意图；优先只读核实或按相同actor/相同请求的既有幂等协议重放。不要换operation重复保存/计费，不把新fence塞进旧未知请求。明确409 base冲突需读当前head并人工合并；明确lease拒绝与历史未知请求的恢复资格不同。无幂等协议的账号、ontology、task、issue和裁决先只读核实，禁止自动循环POST。更完整的保全路径见[故障指南](troubleshooting.md)。

## 可执行合成例子

### 输入与正常登录

仅在项目内本轮专属数据运行；先按开始使用完成bootstrap、创建单Person/helmet_state规范并导入合成图。下面从网页实际ID取得project/ontology/asset，**不填写label_person**；普通保存/导入例子必须在创建任务之前做。PowerShell从项目根运行；精确URL来自启动器；账号是本轮已建立管理员。不要启用Host/模型。密码、Cookie与CSRF只留内存，截图/报告不输出这些变量。

重跑整组例子需另选一张从未建立固定任务的本轮新正图，并先用正式网页完成人工框、属性和 complete；已审核关闭的旧任务资产仍可能返回 TASK_NOT_OPEN，不能用 lease:null 绕过。下面响应按原始字节显式解码 UTF-8，避免 Windows PowerShell 5.1 在 application/json 缺 charset 时把中文审核理由错解；登录/退出仍使用普通 session 和 CSRF。

```powershell
$Base = (Read-Host '本轮 WEBLABEL_LOCAL_URL').TrimEnd('/')
$Project = Read-Host '本轮 project_id'
$Ontology = Read-Host '本轮 ontology_version_id'
$Asset = Read-Host '本轮正图 asset_revision_id'
$Output = Read-Host '项目内本轮新建下载目录（target/documentation-smoke/<run-id>/api-downloads）'
if (Test-Path $Output) { throw '输出目录必须未存在，不能覆盖历史材料' }
New-Item -ItemType Directory -Path $Output -ErrorAction Stop | Out-Null
function Connect-Wl($Username) {
    $secret = Read-Host "为 $Username 输入本轮密码" -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    try {
        $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
        $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
        $body = @{username=$Username; password=$password} | ConvertTo-Json -Compress
        $response = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$Base/api/session/login" -WebSession $session -Headers @{Origin=$Base} -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -ErrorAction Stop
        $reply = [Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray()) | ConvertFrom-Json
        return @{Session=$session; Csrf=$reply.csrf_token}
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
        $password=$null; $body=$null; $secret=$null
    }
}
function Invoke-Wl($Client, $Method, $Path, $Body=$null) {
    $args = @{Method=$Method; Uri="$Base$Path"; WebSession=$Client.Session; Headers=@{Origin=$Base; 'x-csrf-token'=$Client.Csrf}; ErrorAction='Stop'}
    if ($null -ne $Body) {
        $args.ContentType='application/json; charset=utf-8'
        $args.Body=[Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 64 -Compress))
    }
    # Windows PowerShell 5.1 对无 charset 的 JSON 可能错解中文；直接按 UTF-8 解析响应字节。
    $response = Invoke-WebRequest @args -UseBasicParsing
    if ($response.StatusCode -eq 204) { return }
    [Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray()) | ConvertFrom-Json
}
$AdminName = Read-Host '本轮管理员 username'
$Admin = Connect-Wl $AdminName
$Identity = Invoke-Wl $Admin Get '/api/session'
if (-not $Identity.platform_admin) { throw '需平台管理员' }
$projects = Invoke-Wl $Admin Get '/api/projects'
if (-not ($projects.items | Where-Object { $_.project_id -eq $Project -and $_.role -eq 'admin' })) { throw '需该项目admin' }
```

成功观察：GET session与projects分别读取身份及该项目admin角色；登录body不能用来读取身份。完整管理员步骤亦见[运维](operations.md)。

### 配置独立审核者

```powershell
$ReviewerName = Read-Host '本轮新 reviewer username（3–64 ASCII）'
$secret = Read-Host '为新审核者输入12–1024 UTF-8字节密码' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
    $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    $NewReviewer = Invoke-Wl $Admin Post '/api/users' @{username=$ReviewerName; password=$password}
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    $password=$null; $secret=$null
}
$membership = Invoke-Wl $Admin Post "/api/projects/$Project/members" @{user_id=$NewReviewer.user_id; role='reviewer'}
$members = Invoke-Wl $Admin Get "/api/projects/$Project/members?limit=100"
if (-not ($members.items | Where-Object { $_.user_id -eq $NewReviewer.user_id -and $_.role -eq 'reviewer' })) { throw '核对成员失败，需沿next_cursor继续查' }
```

本轮只用少量合成账户，例子第一页足够；真实大项目按next_cursor继续查。创建返回不明先GET users核实，不自动重发POST；同名/409不能证明先前请求ACK。新审核者随后正常网页登录核对角色，不能用管理员Cookie假冒审核者。

### 普通 SaveRequest、精确重放与冲突

前提：正图已有本轮网页保存的一对象complete文档，尚未建任务。下例保留实际document，不伪造provenance。读取结果作新base；精确重放不重新读取base。

```powershell
$headPath = "/api/assets/$Asset/annotation?ontology_version_id=$([uri]::EscapeDataString($Ontology))"
$head = Invoke-Wl $Admin Get $headPath
$Save = @{operation_id=[guid]::NewGuid().ToString(); base_revision_id=$head.annotation_revision_id; document=$head.document; lease=$null; suggestion_decisions=@()}
$Saved = Invoke-Wl $Admin Put "/api/assets/$Asset/annotation" $Save
$Replay = Invoke-Wl $Admin Put "/api/assets/$Asset/annotation" $Save
if ($Replay.revision.annotation_revision_id -ne $Saved.revision.annotation_revision_id -or -not $Replay.idempotent_replay) { throw '精确重放不一致' }
function Expect-WlConflict($Body, $Code) {
    try {
        $null = Invoke-Wl $Admin Put "/api/assets/$Asset/annotation" $Body
    } catch {
        $response = $_.Exception.Response
        if ($null -eq $response -or [int]$response.StatusCode -ne 409) { throw }
        $text = $_.ErrorDetails.Message
        if (-not $text -and $response.PSObject.Methods['GetResponseStream']) {
            $reader = New-Object IO.StreamReader($response.GetResponseStream())
            try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
        }
        $failure = $text | ConvertFrom-Json
        if ($failure.code -ne $Code) { throw "非预期code：$($failure.code)" }
        return
    }
    throw "预期409/$Code却成功"
}
$Changed = ($Save | ConvertTo-Json -Depth 64) | ConvertFrom-Json
$Changed.document.completion = 'in_progress'
Expect-WlConflict $Changed 'IDEMPOTENCY_KEY_REUSE'
$Stale = ($Save | ConvertTo-Json -Depth 64) | ConvertFrom-Json
$Stale.operation_id = [guid]::NewGuid().ToString()
Expect-WlConflict $Stale 'REVISION_CONFLICT'
$after = Invoke-Wl $Admin Get $headPath
if ($after.annotation_revision_id -ne $Saved.revision.annotation_revision_id) { throw '冲突改变了head' }
```

若原文档不是complete，此例应先网页完成，而不是使用相同completion冒充不同payload。任意未知结果停止例子并保全$Save，不运行后续新operation。结束后重新载入网页当前head。

### 导入预览与明确确认

在同一合成正图、尚未建任务时，用上例不可变Saved版本产生单图COCO，然后用它预览导入。先显式审阅每次loss_report；下面不预设loss_ack=true。multipart由内存HttpClient和正常session CookieContainer构造，不把Cookie/CSRF放进子进程参数。

```powershell
$singleRequest=@{format='coco'; loss_ack=$false; operation_id=[guid]::NewGuid().ToString()}
try {
    $export=Invoke-Wl $Admin Post "/api/annotation-revisions/$($Saved.revision.annotation_revision_id)/exports" $singleRequest
} catch {
    $text=$_.ErrorDetails.Message
    if (-not $text -and $_.Exception.Response.PSObject.Methods['GetResponseStream']) {
        $reader=New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
        try { $text=$reader.ReadToEnd() } finally { $reader.Dispose() }
    }
    $failure=$text | ConvertFrom-Json
    if ($failure.code -ne 'LOSS_ACK_REQUIRED') { throw }
    $failure.details.loss_report | ConvertTo-Json -Depth 16
    if ((Read-Host '确认此单图COCO损失报告？输入 CONFIRM') -ne 'CONFIRM') { throw '未确认' }
    $singleRequest.loss_ack=$true
    $export=Invoke-Wl $Admin Post "/api/annotation-revisions/$($Saved.revision.annotation_revision_id)/exports" $singleRequest
}
$Coco = Join-Path $Output 'single-image-coco.json'
Invoke-WebRequest -UseBasicParsing -Uri "$Base$($export.download_url)" -WebSession $Admin.Session -OutFile $Coco -ErrorAction Stop
Add-Type -AssemblyName System.Net.Http
$handler=New-Object Net.Http.HttpClientHandler
$handler.CookieContainer=$Admin.Session.Cookies
$http=New-Object Net.Http.HttpClient($handler)
$form=New-Object Net.Http.MultipartFormDataContent
try {
    $http.DefaultRequestHeaders.Add('Origin',$Base)
    $http.DefaultRequestHeaders.Add('x-csrf-token',$Admin.Csrf)
    $form.Add((New-Object Net.Http.StringContent('coco')),'format')
    $form.Add((New-Object Net.Http.StringContent($Ontology)),'ontology_version_id')
    $data=New-Object Net.Http.ByteArrayContent -ArgumentList (,[IO.File]::ReadAllBytes((Resolve-Path $Coco)))
    $data.Headers.ContentType=New-Object Net.Http.Headers.MediaTypeHeaderValue('application/json')
    $form.Add($data,'data','single-image-coco.json')
    $response=$http.PostAsync("$Base/api/assets/$Asset/annotation-import-previews",$form).GetAwaiter().GetResult()
    $previewText=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode) { throw "预览失败HTTP $([int]$response.StatusCode)，保留输入，不确认" }
    $preview=$previewText | ConvertFrom-Json
} finally {
    if ($null -ne $response) { $response.Dispose() }
    $form.Dispose(); $http.Dispose(); $handler.Dispose()
}
$preview.loss_report | ConvertTo-Json -Depth 16
$answer = Read-Host '已审阅此预览document与损失报告？输入 CONFIRM 才提交'
if ($answer -ne 'CONFIRM') { throw '未确认，不提交' }
$Imported = Invoke-Wl $Admin Post "/api/annotation-import-previews/$($preview.import_batch_id)/commit" @{loss_ack=$true; operation_id=[guid]::NewGuid().ToString(); lease=$null}
```

每个阶段未知结果停止；导入commit之后ID变为Imported.revision，不能继续用旧Saved当当前head。单图COCO可直接交[手工验收](manual-smoke.md)的Python checker，不解压。

### 固定任务、独立审核与快照导出

用导入后的最新head作base；导入可能改变completion及丢失属性，因此例子先显式恢复已核对的原手工complete文档，形成新的不可变版本，再建立任务。建立任务后不能再用lease:null作新写入。提交请求本身不带token；如在提交前继续保存，SaveRequest必须带当前lease。

```powershell
$importHead = Invoke-Wl $Admin Get $headPath
$restoredManual = Invoke-Wl $Admin Put "/api/assets/$Asset/annotation" @{operation_id=[guid]::NewGuid().ToString(); base_revision_id=$importHead.annotation_revision_id; document=$Saved.revision.document; lease=$null; suggestion_decisions=@()}
$current = $restoredManual.revision
$task = Invoke-Wl $Admin Post "/api/projects/$Project/tasks" @{asset_revision_id=$Asset; ontology_version_id=$Ontology; assignee_id=$Identity.user_id}
$lease = Invoke-Wl $Admin Post "/api/tasks/$($task.task_id)/lease" @{action='acquire'; holder_id=$null}
$submission = Invoke-Wl $Admin Post "/api/tasks/$($task.task_id)/submit" @{annotation_revision_ids=@($current.annotation_revision_id)}
$Reviewer = Connect-Wl $ReviewerName
$reviewIdentity = Invoke-Wl $Reviewer Get '/api/session'
if ($reviewIdentity.user_id -ne $NewReviewer.user_id -or $reviewIdentity.user_id -eq $Identity.user_id) { throw '不是独立审核者' }
$source = Invoke-Wl $Reviewer Get "/api/annotation-revisions/$($current.annotation_revision_id)"
$source.document | ConvertTo-Json -Depth 32
$Reason = Read-Host '核对完整固定revision后输入本轮真实批准理由（非空）'
$decision = Invoke-Wl $Reviewer Post "/api/reviews/$($submission.review_id)/decision" @{decision='approve'; reason=$Reason; revision_ids=@($current.annotation_revision_id)}
$snapshot = Invoke-Wl $Admin Post "/api/projects/$Project/dataset-versions" @{operation_id=[guid]::NewGuid().ToString(); ontology_version_id=$Ontology; items=@(@{asset_revision_id=$Asset; annotation_revision_id=$current.annotation_revision_id; split='train'}); excluded=@(); split_seed=$null; split_ratios=$null}
foreach ($format in @('native','coco','yolo')) {
    $request = @{format=$format; loss_ack=$false; operation_id=[guid]::NewGuid().ToString()}
    try {
        $job = Invoke-Wl $Admin Post "/api/dataset-versions/$($snapshot.dataset_version_id)/exports" $request
    } catch {
        $text = $_.ErrorDetails.Message
        if (-not $text -and $_.Exception.Response.PSObject.Methods['GetResponseStream']) {
            $reader = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
            try { $text=$reader.ReadToEnd() } finally { $reader.Dispose() }
        }
        $failure=$text | ConvertFrom-Json
        if ($failure.code -ne 'LOSS_ACK_REQUIRED') { throw }
        $failure.details.loss_report | ConvertTo-Json -Depth 16
        if ((Read-Host "确认 $format 的此损失报告？输入 CONFIRM") -ne 'CONFIRM') { throw '未确认' }
        $request.loss_ack=$true
        $job=Invoke-Wl $Admin Post "/api/dataset-versions/$($snapshot.dataset_version_id)/exports" $request
    }
    do {
        Start-Sleep -Milliseconds 500
        $status=Invoke-Wl $Admin Get "/api/jobs/$($job.job_id)"
    } while ($status.state -in @('queued','running'))
    if ($status.state -ne 'succeeded') { throw "export job未成功：$($status.state)" }
    $download=$status.result.download_url
    if (-not $download) { throw '成功job缺少download_url，停止并保留响应' }
    Invoke-WebRequest -UseBasicParsing -Uri "$Base$download" -WebSession $Admin.Session -OutFile (Join-Path $Output "dataset-$format.zip") -ErrorAction Stop
}
```

例子每次新job只在明确LOSS_ACK_REQUIRED后改变ack；连接中断或未知结果绝不走ack分支自动重发。租约60秒，若人工暂停太久，提交前renew并再次核对当前head；明确LEASE_EXPIRED要按当前任务状态恢复，不重建任务。实际网页审核还应查看固定版本差异，以上API读取不能代替网页验收证据。快照下载后独立回读三ZIP的revision/hash/reviewer/split，不能用保存成功代替审核批准。最后正常logout，销毁仅内存client：

```powershell
$null = Invoke-Wl $Reviewer Post '/api/session/logout'
$null = Invoke-Wl $Admin Post '/api/session/logout'
$Reviewer=$null; $Admin=$null
```

## 来源、审查与未验证边界

路由取自Rust主router及session/projects/media/annotations/ai/review/datasets router；字段与默认值取各handler及annotation-domain的auth、core_workflows、revision、prediction、ai_authorization、activity类型；保存、导入commit、snapshot publish和export enqueue的事务分支单独核对。C6中的批处理与实际公开单request返回、jobs顶层items误述已记录为区别，不改产品协议或原任务状态。

本文说明不代替实际验收；例子必须在独立合成实例上运行，静态类型/语法检查不证明HTTP成功、真实WebGPU或发布通过。当前平台管理员可从固定Host预设建立profile，但不能据配置或受控工程夹具宣称真实模型已验收。完整验证证据与阅读审查从[报告入口](../reports/index.md)进入；失败优先保全原始请求和本轮数据。
