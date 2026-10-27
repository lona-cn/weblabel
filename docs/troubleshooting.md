# 故障诊断与安全恢复

读者：本地操作者与维护者。读后行动：按真实诊断保全未同步工作，选择有资格的下一动作并核实成功。验证边界：这是当前 CLI、SaveStatus/readableDiagnostic、save-queue 与 API 的恢复说明，不是本轮每个故障已演练的声明；具体字段见[契约](contracts.md)，正常操作见[入门](getting-started.md)、[运维](operations.md)和[备份恢复](backup-restore.md)。

先记录 code、kind、status、request_id 和技术诊断原文（去秘密），不按 message 猜错误类型。HTTP 状态本身不能证明未保存、已保存或版本冲突；未知结果优先于上次错误。不要将某次诊断当作当前作者、权限或租约资格。

## 启动与工具

- **症状/真实 code**：构建 Node pin 不符、doctor 工具 missing/version_mismatch、发行缺失或无效；blocked/2 与 failed/1 分开。
- **已确认与未知事实**：v2 runtime 模式不要求 Node/Python/编译器；build 模式要求固定工具。诊断通过不证明 GPU、账号或推理可用。
- **先保全什么**：原数据、草稿、发行与诊断 JSON；构建问题另外记录实际工具路径和版本。
- **允许的下一动作**：运行预编译产品用 `weblabel doctor --mode runtime`；源码构建才按[固定工具](getting-started.md#构建与启动)调整当前进程 PATH，不改全局配置。
- **禁止动作**：降低 pin、改全局配置、把历史版本输出当本机现状、借 doctor 宣称 live 通过。
- **成功判据**：实际可执行路径/版本与 pin 一致，工具 pinned；仍缺发行或其他前提时继续记录 blocked。

## 发行、端口与锁

- **症状/真实 code**：build_missing、build_incompatible、hash_mismatch、invalid_loopback_ports、data_in_use、process_tree_tool_missing；端口占用/监听失败以实际终端错误记录，不发明统一 API code。
- **已确认与未知事实**：发行能打开页面不证明 hash 正确；持久 OS sidecar 文件存在不说明活服务或陈旧。旧 PID 锁不授予终止进程权限。
- **先保全什么**：发行原字节、release.json、锁诊断与原 canonical 数据目录、SQLite/WAL/对象。
- **允许的下一动作**：新目录构建；冲突时核对所属进程和精确单一 loopback 端口，停止已确认属于自己的服务，再用原数据目录启动。不删除 sidecar 解锁。
- **禁止动作**：杀用户其他服务、伪造 manifest、删 SQLite/WAL/SHM/对象或锁文件抢占数据库、绑定 LAN/公网。
- **成功判据**：发行 hashes_valid，精确 WEBLABEL_LOCAL_URL 可用；正常 Ctrl+C 后自有树退出，OS 锁可再取得，sidecar 文件仍保留。

## 初始化与登录

- **症状/真实 code**：INVALID_BOOTSTRAP_CODE、BOOTSTRAP_USED、BOOTSTRAP_UNAVAILABLE、INVALID_PASSWORD、INVALID_CREDENTIALS、LOGIN_RATE_LIMITED、UNAUTHENTICATED；保存 401/403 另见下一节。
- **已确认与未知事实**：已用/过期码不能再次初始化；登录返回 csrf_token，身份另用 GET session 核实。密码长度按 UTF-8 12–1024 字节；登录失败不证明数据丢失。
- **先保全什么**：原数据与浏览器可导出草稿，原作者账号/项目范围；不记密码、码、Cookie、CSRF。
- **允许的下一动作**：沿[网页登录](getting-started.md#首次登录与人工标注)使用当前启动终端一次性码或正常密码登录；限流等待后由本人登录。恢复成功后启动恢复目录，码来自受管 API 终端而非 restore CLI；保存实际 restore-admin 用户名。
- **禁止动作**：清库重置账号、绕过鉴权、把恢复新管理员视作原草稿作者、反复猜密码。
- **成功判据**：GET session 的 user_id/project_roles 符合实际身份，正常网页进入项目；旧作者工作仍按作者资格恢复。

### 忘记已有管理员密码

有本机启动权限时按[管理员密码恢复](operations.md#管理员密码恢复)，不清库或另建身份。使用原目录与实际platform_admin，两输入必须完整合法，不能把 `WEBLABEL_ADMIN_RECOVERY_CODE` 当输入；空库/普通用户/scrubbed备份库拒绝是预期保护。

`RECOVERY_MAINTENANCE`/503 不表示项目丢失；完成后清两输入变量、停维护、原目录正常启动并完整刷新网页。`INVALID_RECOVERY_CODE`/401 核对终端码并只读检查expired；`RECOVERY_RATE_LIMITED`/429 等待Retry-After。`RECOVERY_COMPLETED`/409、网络/解析/500先同一请求只读核对，不自动重POST。消费ID重启拒绝时正常启动用新密码核实，不另造ID掩盖未知结果。成功为原user_id/角色/数据仍在，新密码登录成功，目标旧密码/session不可用，其他用户凭证不变。

`DATABASE_IN_USE` 是API的OS锁诊断，确认同库API已退出；不要删除 `api.sqlite.runtime.lock` 抢锁，sidecar保留但死进程锁由OS释放。启动器 `runtime.lock` 的陈旧处理仍按上一节，不混同两种锁。

## 导入

- **症状/真实 code**：ONTOLOGY_REQUIRED、TOO_MANY_BYTES、EDGE_LIMIT、PIXEL_LIMIT、UNSUPPORTED_FORMAT、INVALID_IMAGE、MULTIPLE_FRAMES、UNSUPPORTED_COLOR、INVALID_ORIENTATION、QUEUE_FULL；标注导入 IMPORT_INVALID、YOLO_LABELS_REQUIRED、NATIVE_TARGET_MISMATCH、IMPORT_TARGET_NOT_FOUND。
- **已确认与未知事实**：媒体排队不等于 canonical 完成；单图≤64 MiB、单边≤4096、总像素≤16,777,216。标注 preview 不是保存；YOLO 必须有显式 label_ids，Native 目标 hash/尺寸/规范必须匹配。
- **先保全什么**：原输入字节/hash、import/job ID、规范与类别映射、preview/loss report、确认请求。
- **允许的下一动作**：先发布规范；查看任务/逐项处理错误，换符合边界的新输入；标注先核对预览目标/类别/坐标/损失再明确确认。确认返回不明先只读核对，必要时保留原操作确认。
- **禁止动作**：扩展不受支持格式、按文件名猜目标、跳过 preview/loss acknowledgement、对未知确认另建 operation 自动重复。
- **成功判据**：媒体列表显示全部 canonical revision 且尺寸/方向正确；标注确认有真实 revision ACK，刷新后普通 GET 一致。

## GPU

- **症状/真实 code**：界面 GPU unsupported/lost、device_state 非 ready；这些是设备诊断状态，不等同服务器保存 code。
- **已确认与未知事实**：人工编辑要求真实 WebGPU hardware device；网页能显示或 CPU 文档存在不证明设备可写，logical bytes 不等于 VRAM。
- **先保全什么**：CPU 文档、完整本地草稿、GPU 诊断及设备丢失时刻。
- **允许的下一动作**：在支持浏览器/真实硬件检查设备，保留只读诊断；设备恢复后按页面显式恢复，核对当前资产与文档。
- **禁止动作**：Canvas2D 假降级、软件 adapter 冒充硬件、删除草稿来解除只读。
- **成功判据**：实际 actual_backend=webgpu、device_state=ready、hardware adapter；随后真实编辑保存另行证明。无设备则只读/诊断是正确结果，人工编辑未验证。

## 保存与恢复

### 未知结果优先与恢复屏障

- **症状/真实 code**：unknownOutcome、network；PROTOCOL_MISMATCH、INVALID_ANNOTATION_RESPONSE；或者未核实的 HTTP/其他失败。即使之后收到 lease/401/403 错误，historical unknown 仍不能被解释成原请求明确拒绝。
- **已确认与未知事实**：原请求可能已提交，response 可能丢失/不符合契约。完整原请求回执的确认资格与当前新写入资格分开；没有 fixed lease 仍可能允许受限原回执/最新 IDB 确认，不允许继续编辑或创建下一操作。
- **先保全什么**：下载可用的完整本地 Native 草稿/救援原记录；保留原 operation_id、完整 body/document、base、原 lease/fencing、候选 decision journal、作者/项目/规范与 generation。未知或不支持 schema、读取失败时保全 raw，不把它转成当前作者的新文档。
- **允许的下一动作**：用原作者登录原项目、只读查看服务器版本；仅当前 scope/可信原作者核对允许时，显式 singleflight“重试保存”确认同一原请求。ACK 已获得但本地落盘失败时，重试最新 IDB 完整提交屏障，不重做保存。
- **禁止动作**：替换原 payload/base/lease、换 operation、泛化为刷新/自动重试、generic flush/timer 解锁、清站点数据或关闭唯一未落盘页面。
- **成功判据**：真实 ACK 与原完整请求匹配，最新本地记录 IDB complete 且 scope 仍 current；pending 清除不独自证明全量同步。只有当前新写权限/固定任务 lease 资格也满足且最新 generation/journal 已同步，才恢复编辑；partial ACK 不能说全量成功。

### 明确错误逐项处理

以下每行遵循“先保全 → 允许 → 禁止 → 成功”；已确认仅指上次诊断，当前资格均需重新核对。所有行先保留完整草稿与上节原请求材料。

| 症状/code | 已确认与未知 | 允许的下一动作 | 禁止动作 | 成功判据 |
|---|---|---|---|---|
| REVISION_CONFLICT | 上次 base 不再是 head；本地修改未自动合并 | 下载本地草稿，查看服务器版本，比较并显式选择处理 | 静默覆盖 head、把 lease 拒绝当此错误 | 选择有记录，真实 ACK/最新 IDB 屏障完成 |
| IDEMPOTENCY_KEY_REUSE | 同编号用于不同内容；原请求结果仍需核对 | 下载并只读核对原请求及 head | 新编号绕过原核对 | 原操作内容/回执确定，不丢双方文档 |
| LEASE_REQUIRED | 上次缺任务 lease | 核对实际固定任务/资产/规范和 Native/context，精准领取后显式重试 | 把收到此 code 都认作 fresh 拒绝 | fresh 拒绝重准备资格及 ACK/IDB 屏障满足 |
| LEASE_NOT_REQUIRED | 上次 lease 不适用该图片 | 核对当前任务关系；按界面当前资格处理 | 手工删 lease 重发 unknown 原请求 | 原请求确认与当前新写资格分别成立 |
| LEASE_NOT_HELD | 上次非租约持有人 | 核对持有人，由有资格者领取 | 抢用他人 token | 当前真实租约持有人与作者一致 |
| LEASE_EXPIRED | 上次过期 | 当前固定任务精准重新领取，再显式重试 | 自动续租后替换 unknown 请求 | 新 lease 有效且 fresh 恢复满足屏障 |
| STALE_FENCING_TOKEN | 上次 fencing 已失效 | 核对并取得当前租约 | 复用旧 token 或改原 unknown body | 当前凭据核实，真实 ACK/IDB 完成 |
| TASK_STATE_INVALID | 上次多个开放任务 | 导出草稿，请管理员核对分配 | 随便挑任务写入 | 当前唯一固定上下文可核实 |
| TASK_NOT_OPEN | 上次任务不开放，已关联图片不能绕到普通写入 | 下载原始草稿/请求并在 GUI 明确留档；项目管理员新建明确任务后再领取 | 换 operation/删 lease/替换历史 paused 或 unknown payload、绕过提交审核锁 | 真实新任务与本人 lease 可核实；原记录保留，不自动重放 |
| ONTOLOGY_NOT_FOUND | 上次规范未在项目发布 | 管理员核对已发布规范，保留原规范引用 | 换规范重发原请求 | 规范/项目关系明确 |
| TASK_ONTOLOGY_MISMATCH | 上次规范非任务固定规范 | 核对任务固定版本、草稿差异 | 直接迁移规范绕过确认 | 当前 Native/context 与固定规范匹配 |
| DRAFT_OWNER_UNKNOWN | 缺可信原草稿作者 | 下载救援副本，保持只读 | 当前账号认领作者 | 救援文件已保全；无作者不恢复写入 |
| PENDING_OWNER_UNKNOWN | 缺可信原请求作者 | 下载并只读查看服务器 | 替换原请求/作者 | 原材料保全；不可授权重放仍记录阻塞 |
| DRAFT_OWNER_MISMATCH | 上次账号/项目非原作者 | 回到原作者/项目重新核对 | 借管理员身份覆盖 | 当前可信作者与 scope 匹配 |
| PENDING_OWNER_MISMATCH | 上次原请求作者不匹配 | 原作者/项目下核对同一请求 | 当前账号重建请求 | 原作者资格和原回执确认成立 |
| QUOTA_EXCEEDED | 本地存储空间不足，未完成本地保存 | 立即导出，再处理空间 | 先清站点数据 | 最新完整记录 IDB commit 成功 |
| STORAGE_FAILED / STORAGE_OPEN_FAILED / INDEXEDDB_UNAVAILABLE | 本地操作未完成，原因需诊断 | 先导出，检查浏览器存储权限 | 先关闭页/清数据 | 最新记录物理提交完成，不只 promise/ACK |
| STORAGE_READ_REVOKED | 读取中 scope 改变 | 能导出先保全，回原账号项目核对 | 用新 scope 继续读写旧记录 | 原 scope 重新核实，读取完整 |
| PROJECT_WRITE_REQUIRED | 上次无项目写权限 | 导出，请管理员核对角色 | bypass 权限或强制解锁 | 当前角色与工作所有权均合格 |
| 401 / 403（无更精确 code） | 身份/访问规则拒绝，不确定此前结果 | 导出，原作者登录，核对精确入口/项目权限 | 单凭 status 判定原请求没保存 | 原请求结果与当前身份单独核实 |

**fresh lease 拒绝是窄例外**：save-queue 只对没有 historical unknown 的新鲜明确 lease-related 409 标为 rejected；必须原作者、当前可写 scope、无 in-flight/pump、paused、实际当前 lease 与 canPrepareOperation 都成立。用户核对同一任务/资产/规范与 Native/context 并精准领取后，显式动作才可 reprepare 新 operation；直到新 ACK 与最新 IDB complete 前屏障仍在。旧 unknown 后来被 lease 拒绝仍原样保留；不能照此例外换请求。LEASE_NOT_REQUIRED 的诊断也不保证可 reprepare，实际 current lease/资格仍决定入口。完整约束见[现行契约](contracts.md)。

## 当前 UX 的只读核对与失败恢复

| 症状 | 保全与允许动作 | 禁止/成功边界 |
|---|---|---|
| 固定版本打不开或目标不匹配 | 保留project/asset/ontology/revision，核对指定revision与父版本；返回任务队列重新明确选择 | 不跳第一张、不以当前head代替历史；只读页不执行批准/退回 |
| 模型预设为空或HOST_CONFIGURATION_UNAVAILABLE | 人工标注继续；本机操作者准备私有Host配置，平台管理员GET固定预设 | 不上交秘密/路径/启动参数，不登录或调用模型填补；configured/ready不是live_passed |
| PROFILE_CONFIGURATION_CONFLICT / unknown PUT | 保留原profile完整身份和hash；GET同一profile逐字段比较 | 不覆盖历史，不换hash重POST/PUT；404仍可能在途，匹配只证明当前状态 |
| 拒绝结果未知 | 保留set/operation/有序change_ids，GET rejections按同operation完整分页核对journal | 不自动重POST、不以汇总IDs认领原请求；已接受项先保存撤销，被拒项不能重新接受 |
| 提交响应丢失/继续失败 | 保全revision/actor/task，GET同submission检查review/唯一revision/lease_ended；继续查找只读，执行前后验证原上下文证明 | 不重复submit、不补release；显式继续的精准领取须过task-open屏障，身份/文档/generation/本地凭证变更即停止 |
| 领取或cleanup release结果未知 | 保留project+actor及固定task的unknownLeaseWrites，仅GET刷新任务并保全草稿 | 无lease GET、任务列表无holder/fence/expiry，无法只读证实原租约写入；刷新不解锁，不重发、不renew、不continue |
| GUI账号/成员写入未知 | 只读账号/成员列表，核对真实user_id/项目角色；创建密码不得入报告 | 同名不归因原POST，项目admin不能枚举全站账号，平台admin不是自动项目成员 |
| EXPORT_SIZE_LIMIT | 记录POST 413或failed job result.code，以及实际存在的budget/limit_bytes/observed_bytes；保留旧snapshot/job，明确调整范围并新建快照 | 每批≤1024不保证ZIP≤96 MiB，不改旧manifest、不自动重建；成功产物下载失败只GET已有产物 |
| seed计划无法分批 | 检查非空seed、重复ID、每批至少一纳入与排除理由，重新明确范围再预览确认 | 不静默丢项、不把未浏览纳入；同组始终同split、数量不保证80/10/10 |

取景异常先看Native viewport与hitstack回执，重新适配画布或聚焦区域；这些操作只改变取景，不修复或改写bbox。pointermove没有远端保存是预期preview-only；pointerup后才核对真实document delta、本地提交与远端ACK。正常步骤与权限见[入门](getting-started.md)，请求字段见[API参考](api-reference.md)。本轮仅执行文档checker，未将这些故障演练或真实G4写成已验证。

## 任务与审核

- **症状/真实 code**：TASK_NOT_OPEN、TASK_STATE_INVALID、TASK_ONTOLOGY_MISMATCH、SELF_REVIEW_FORBIDDEN、REVIEW_REVISION_MISMATCH、REVIEW_ALREADY_DECIDED、TASK_STATE_CONFLICT、INVALID_REVIEW_DECISION。
- **已确认与未知事实**：任务固定资产/规范；review 绑定提交 revision，不是当前 head。自审受策略禁止；保存同步不等于已批准。
- **先保全什么**：草稿、task/review ID、提交 revision IDs、审核理由与原响应。
- **允许的下一动作**：管理员按[成员配置](operations.md#配置团队审核账号与成员)核实独立 reviewer；重新只读查看任务/提交与决定状态，决定严格绑定原提交 IDs 并有非空理由。
- **禁止动作**：管理员代替提交者自审、换 revision 掩盖冲突、未知结果重复决定、绕过审核锁写入。
- **成功判据**：独立审核者的真实决定与固定提交 IDs/理由一致；审核状态 approved 后才进入相应冻结快照。

## 导出

- **症状/真实 code**：LOSS_ACK_REQUIRED、EXPORT_FORMAT_INVALID、ANNOTATION_REVISION_NOT_FOUND、MEDIA_OBJECT_MISSING、EXPORT_OBJECT_MISSING、EXPORT_UNAVAILABLE、EXPORT_INVALID、IDEMPOTENCY_CONFLICT。
- **已确认与未知事实**：有损拒绝不表示原 revision 变化；单图 COCO 是 JSON，数据集 COCO 是 ZIP。operation 请求不明时不能认定未生成。
- **先保全什么**：固定 revision/快照 ID、格式/类别映射、loss report、原 operation/body、已下载字节/hash。
- **允许的下一动作**：只读核对导出记录；有损按页面 loss report 明确确认。缺对象/腐坏交维护者诊断，保留备份。按[人工验收](manual-smoke.md)分开回读 JSON/ZIP。
- **禁止动作**：伪造 loss ACK、把新 head 当固定版本、修改对象内容、把 ZIP 喂给单图 checker。
- **成功判据**：真实下载类型/成员正确，独立回读 ID/hash/类别与精确 canonical 坐标一致，历史审核引用保留。

## 备份与恢复

- **症状/真实 code**：restore_directory_exists、backup_incompatible、backup_schema_mismatch、schema_incompatible、backup_authentication_not_scrubbed、backup_object_missing_or_corrupt、restore_copy_hash_mismatch、restore_failed_target_preserved。
- **已确认与未知事实**：恢复拒绝已有目标；失败目标保留不保证完整可启动；备份不含浏览器未同步草稿，不提供加密/签名或跨 schema 自动迁移。
- **先保全什么**：原库/对象/WAL、浏览器救援副本、备份 manifest 和失败目标及错误。
- **允许的下一动作**：按[备份恢复](backup-restore.md)一致性备份；先验证原备份，使用不存在的新目标，成功 restore_created 后启动恢复库，由 API 终端码设置新的实际 restore-admin 身份。
- **禁止动作**：覆盖原库/失败目录、改 manifest hash 通过校验、复制旧 session/凭证、把历史审核归给新管理员。
- **成功判据**：restore.json 与备份指纹匹配，新身份正常登录；旧 revision、媒体 hash、快照与旧审核身份一致，仍需重新配置/验证 AI。

## AI

- **症状/真实 code**：profile 列表 items=[]、PROFILE_LIST_FAILED、PROVIDER_RETIRED；needs_configuration/needs_login/blocked/not_run 是能力状态，不是人工保存错误。
- **已确认与未知事实**：持久 profile、公开投影、私有原生配置/凭证环境、项目策略与逐次 preview/consent 是独立层。空库 [] 正常；平台管理员已有固定预设 GUI/API，只能选择本机操作者准备的预设。单设 `WEBLABEL_RUNTIME_CONFIG` 不建持久 profile，更不证明本地 CLI/检测器已 ready。doctor 不检查账号或推理；渠道与历史记录见[限制](known-limitations.md)。
- **先保全什么**：公开 profile/availability/verification、run/operation ID、预算/consent/preview 摘要与收费未知状态；不收集或打印私有 JSON、key/CLI home。
- **允许的下一动作**：继续 core 人工流程；授权环境的已有 profile 才按[运维分层](operations.md#ai-可选配置)和 provider 文档核对。终态/费用未知先查既有 run 与本人官方记录，由本人明确决定下一调用。
- **禁止动作**：SQL provisioning、假的配置 CLI、自动替换 retired Codex、绕过策略/逐次 consent、未授权登录/下载权重/调用模型、将 synthetic 候选算 live。
- **成功判据**：只读投影与真实状态一致；空列表限制如实说明。只有绑定实际账户/型号/runtime/输入与预算的授权 live 证据才证明对应能力，工程通过不解除 blocked。
