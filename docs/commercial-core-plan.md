# 核心功能与使用体验商业化迭代计划

**历史证据边界：** 本页的私有归档路径仅记录原始验收来源，不随公开仓库分发，也不代表在当前公开提交重新验证。

> **历史归档，非待执行计划。** 商业核心 A–E 已结束，状态与提交见 `STATUS.json.user_requests.commercial_core`，完成记录见[报告索引](../reports/index.md#商业核心与体验增量)。本文保留原需求、审查修订、暂停/恢复过程及当时证据，不作为当前实现或验收通过声明。

读者：维护者与审查者。读后行动：对照已批准范围和历史验收依据；继续开发使用[现行契约](contracts.md)、[API 参考](api-reference.md)及[恢复入口](../START_HERE.md)，使用功能见[当前能力](current-capabilities.md)。T32、T35、模型、性能及许可边界不因归档改变。

## 1. 目标与基线

用户要求依据[功能及体验对比](label-studio-comparison.md)，按“需求发现 → 需求分析 → 做计划 → 审查计划 → 执行计划 → 审查结果 → commit”持续迭代核心功能与体验。

本增量保持静态 PNG/JPEG、轴对齐检测框与对象属性、本机 loopback 的定位。商业应用级在本轮意味着：核心人工操作完整可达；失败可理解且可恢复；版本、权限、保存、审核与导入不变量成立；真实运行证明；每轮结果审查和可追溯提交。它不代表所有模型渠道、企业服务、监管合规或正式发布关卡通过。

发现基线：`ffc794c41d88fe3c879babef0178581bbcc6b126`，契约 v1。计划结构检查：36任务、75依赖、原DAG无ready任务；按用户请求实施已完成任务的增量，不重启原DAG。当前前端基线：10文件、145测试通过。首次登录增量提交已在当前HEAD祖先链中。

当前源码已实现部分侧栏、辅助区折叠、AI隐藏不卸载及焦点控制；比较文档是固定旧发行分析，不重复重建已修功能。用户已有README/报告修改、未跟踪发行与权重目录、删除的配置全部保留，不纳入无关提交。

## 2. 用户已决定的边界

- 许可证：暂不授予再分发许可。不给项目擅自添加 MIT/Apache；记录源码可读不等于取得使用、修改或再分发授权，依赖许可仍独立。
- AI：本轮不追加模型调用。已有检测器额度已耗尽；不访问私人凭证、不调用付费模型、不下载权重。五渠道真实验收保持 blocked，T35 pending；改善工程体验不得改成 live。
- P2：SDK、Webhooks、云存储、签名安装器/自动升级为生态定位建议，不自动并入“核心功能和体验”增量；本文列清真实边界。视频、Mask、Polygon、3D、公网部署同样不在本轮。

## 3. 需求与可观察验收

| ID | 需求与结果 | 必验边界 |
|---|---|---|
| C01 | 创建及已有项目均能配置多类别、颜色、快捷键、enum/boolean/number/text属性、默认值、必填、枚举/数值约束及指南；管理员发布不可变新版本，其他成员可读 | 非法/重复定义保留草稿；创建项目成功但规范失败只补规范，不重复创建项目；旧媒体/任务/草稿继续固定旧版，新导入使用新版；权限未知不默认可写 |
| C02 | 正式选类绘制、单/多选原子改类；几何数值 x/y/w/h 编辑 | Rust 唯一几何/属性改类来源；一次改类一次undo；同类no-op保留值；非法/锁定目标整批不改；hidden只保持既有会话可见性；合法小数与边界保存刷新精确；切选择/切图/undo取消旧输入；读者只能选中查看 |
| C03 | 媒体导入queued/running/部分成功/失败/中断/状态未知清楚可见，按item_index逐文件原因与下一步 | 同名文件不合并；旧项目响应不覆盖新项目；只读重查不POST；未知上传结果不自动重发；不宣称不存在的cancel/retry服务能力 |
| C04 | COCO/YOLO目标、类别映射、来源图选择 → 只读preview → loss确认 → 单次commit → 真实新版本 | dirty草稿先flush并锁编辑；preview不改head；空检测不变negative；head变化重新preview；未知结果保留op，不新op重复写；任务导入不得绕过lease/fencing；成功重建编辑/queue，旧队列不得覆盖新head |
| C05 | 列表及画布显示类别名+文档顺序序号，ID留详情；名称/类别/ID检索及类别分组 | UI投影不改文档；真实selected集合不因过滤被偷偷改动；虚拟化保持；键盘可达；改类/排序变化刷新文字缓存 |
| C06 | 任务创建/转交用项目合资格人员、分页媒体、固定规范选择；领取后打开该任务的固定媒体+规范 | 不读取全站账号替代项目成员；项目管理员可读成员，非成员隐藏；成员失效后服务器复验；转交独立于任务行；领取/续租/提交保原fence、flush、generation及不可变revision |
| C07 | 保存、本地草稿、网络/服务错误、CAS冲突、租约失效、救援操作和loss报告可读；明确显式重试 | IDB未提交不能说本地已保存；普通失败复用immutable operation/payload；409与网络失败不同；只读核对不恢复写入；并发点击保护；前置媒体/annotation载入失败仍可救援本地记录，不承诺离线编辑 |
| C08 | 单图及固定数据集导出先读实际loss再明确确认；格式/范围变化撤销旧ack | 绑定实际revision/数据集/格式；未知或坏报告不说无损；技术field/reason保留可折叠；不臆造丢失数量；下载失败只重读既有产物；原生包不是完整项目备份 |
| C09 | 保留现有可折叠工作区、AI寿命及焦点；改善窄屏/短屏画布和主操作可达 | 320×640、320×短高、1280×800及1099两侧；无整页横向溢出；错误/冲突/负样本展开仍可操作；隐藏AI不cancel/restart/reconsent；真实WebGPU诊断保留 |
| C10 | 控件命中、正常文字对比度、键盘/IME、就地快捷键帮助 | 本产品交互控件目标44px；正常文字≥4.5；焦点可见；Tab/Enter/Space帮助打开关闭且回焦点；帮助/输入不误删对象；Windows/Mac按真实键位说明；不宣称完整WCAG认证 |
| C11 | 超512条固定范围可交付；大项目能分页选取范围 | 保守有界目标：每逻辑快照最多1024条含排除项；维持96MiB归档/解压、16MiB manifest、4096归档成员等预算，不宣称任意规模；513/1024及1025拒绝；固定审核revision、全局类别映射、source_group防泄漏、明确遗漏/排除和hash；独立解析回显；worker失租不得发布完成 |
| C12 | 诚实AI不可用诊断及授权、许可证和生态边界文档 | 不改T32/T35和live标记；不读取凭证；用户授权待定不自动赋予许可；普通标注不需AI |

## 4. 前置语义与接口决定

### 4.1 改类

目标类别默认值作为目标属性集合；保留目标仍合法的同key旧值；删除目标未定义键；缺失/不兼容值使用目标默认值。同label为no-op。全部在共享Rust领域/编辑命令中原子完成，UI先说明变化规则。同步已有AI候选验证/采纳；只读WASM投影返回既有AnnotationObject，B轮DiffView消费真实after，不写JS转换。保持production allowed_ops/run gate/predictions拒绝SetLabel，不新增模型能力或HTTP权限；null与历史optional/required语义不迁移。

### 4.2 不可变规范与媒体定位

新增成员鉴权的媒体annotation heads只读接口，返回固定规范与revision摘要，不把完整文档逐个拉取来做选项或数据集范围。最小固定规范载入装配归A3，确保A轮发布新规范后旧图不坏。选择优先级：任务固定规范→显式规范→同资产本地草稿的规范/base成套核验→明确已有head；不静默最新。草稿与任务/显式规范冲突不得偷换规范，保持只读/救援；无对应head显示真实不存在，不自动复制迁移。新发布不迁移旧媒体，不提供虚假“应用到所有图片”。

规范输入边界按实际服务端UTF-8字节预算说明并校验；不使用JS字符长度冒充字节。required表示属性键必须存在，不表示值非null；四种类型的required/default_value:null均按既有Rust Core语义允许，发布接口和表单必须一致，不迁移历史数据。

### 4.3 导入权限与loss

导入commit进入普通保存等价的同事务任务lease/fencing校验。若扩展lease字段，更新所有实际调用者和测试，服务端不以UI禁用代替权限。保留CAS、actor归属和幂等。单图未确认loss的422响应携带实际结构化loss_report，复用数据集模式；不能先ack产生文件后再询问。

COCO/YOLO新导入对象仅按明确映射的实际类别复制固定规范已声明default_value，包含optional键及null；不从类别名称或规范首类推断，不放松领域校验。仅实际对象的目标类别存在属性时，真实报告新增attribute_defaults，说明这些值不是来源标注，而是规范默认值，沿用显式损失确认。空输入、无属性类别和未选来源图不新增此损失。Native导入完整属性保持原样，不补键、不覆盖旧值；此窄边界已独立审查，来源于B正式烟雾发现的required-null导入缺口。

媒体状态使用实际result.items协议，修正文档与类型差异；稳定中文错误按code/明确结构化错误种类映射，未知保留诊断而非解析随机英文message。

### 4.4 有界扩容

1024目标是安全有界增量，不建设云级无限数据流水线。必须优化分页head摘要、快照与导出的短事务、worker heartbeat及publication fencing，不能只删除512常量。heartbeat覆盖等待permit与构建；result序列化及256KiB校验在发布前完成。最终短事务同时复验running/worker/fence/未过期lease、插入export业务行并转换job为succeeded；失租回滚，download只允许对应succeeded job。媒体核验、hash、ZIP及对象staging不持有写事务。长导出只读immutable manifest，不要求仍是current head。

### 4.5 只读和事件时防护

读/选择port与写port分离。写port在事件发生时检查当前资产、host、真实项目role、GPU ready、只读preview、submission/import锁。UI disabled不是服务端授权；reviewer不升级为annotator。选择、搜索、分组和类别工具选择不触发保存。

## 5. 迭代顺序与隔离

每轮：细化对应需求与契约 → 审查 → 永久行为回归先写/主会话跑red → edit-only隔离实施 → 主会话整合并跑窄gate/真实smoke → 独立规格与质量审查 → 修正及复验 → focused commit → 下一轮。

| 迭代 | 并行单元 | 真实依赖 |
|---|---|---|
| A：前置安全和规范 | A1共享Rust改类及只读WASM桥；A2heads摘要/成员读取/import lease与单图loss服务契约；A3规范表单、两阶段创建及最小固定规范工作台载入 | A2冻结/生成接口后A3接入；A1语义消费及候选DiffView在B装配，A不声称人工入口已完成 |
| B：人工核心闭环 | B1工作台选类/改类/数值、对象语义检索分组和画布、唯一装配；B2固定候选Rust投影消费；B3媒体/格式导入及单图loss组件 | 依赖A已审查提交；Workbench与样式共享写入只一个owner，组件接入不能互抢 |
| C：任务和可信反馈 | C1人员/媒体/规范任务选择及打开固定任务；C2保存/恢复/错误救援；C3布局/帮助/a11y | 依赖B可操作核心；公共客户端、样式、装配单写 |
| D：数据交付 | D1 snapshot/export预算/heartbeat/fencing；D2分页范围与摘要、1024UI、loss语义；D3独立loader/规模smoke输入 | 依赖A head/member公共读取；归档/作业接口若共享则先冻结契约再消费 |
| E：联合验收 | 全部受影响回归、真实正式同源用户旅程、权限/边界、文档与证据审查 | A–D全部green并提交；真实AI按用户决定不运行 |

最多3个隔离写agent+1个只读reviewer。三个工作树已建立在项目内，基于发现HEAD；使用前校验实际路径/HEAD。每次派工指定task ID、base SHA、契约版本、至多5个明确目标路径、验收和禁区；禁止递归派工、禁止运行测试/门禁/格式化。主会话统一验证格式化、共享入口、schema生成、migration编号、路由及状态；提交只纳入本轮owned paths。

隔离树中不安装依赖、不创建项目外缓存。主会话保存patch并整合验证，完成后核对未提交内容/独有commit/证据再清理；不覆盖或删除主checkout用户内容。

## 6. 验证与提交门槛

### 环境

固定项目根 `D:/workspace/src/weblabel`。工具已实际核对：Node24.16.0、pnpm10.34.5、Rust/cargo1.96.0、wasm-bindgen0.2.128、wasm-pack0.15.0。临时目录项目内；使用已存在项目内native缓存；不改全局配置。清除旧API/release override后从本次源码构建。Cargo祖先配置有问题时，仅在已安装工具cwd运行并显式指定项目manifest/target，不写共享工具目录。

### 主会话执行

- 按每轮改变运行领域、编辑器、API及前端窄回归，失败不能删断言或以无测试为通过。
- 最终运行Web完整project、受影响API integration、Rust domain/editor/formats/API、TS严格类型和生成契约检查；语言格式由主会话一次统一运行。
- 浏览器通过真实当前源码构建的同源发行入口、合成媒体、真实硬件WebGPU及实际控件：配置两类四种属性 → 导入好/坏图 → 选类画框/改类/数值 → Undo/Redo → 保存刷新 → 发布新规范后旧图可用 → COCO/YOLO preview确认导入 → 任务领取与固定版本审核 → >512固定范围导出 → 独立解析。
- 注入只用于明确错误/乱序边界，不用成功静态JSON代替实际产品。权限用真实角色/接口403验证；浏览器截图不是几何或服务提交证明。
- 320px、短屏、1099断点两侧、长中文、失败状态、焦点、热键及a11y抽查；不把单机结果写成跨设备认证。
- 保留脱敏命令/退出码/数量、HTTP结果、截图、review、actualcommit，更新本用户请求状态，不覆盖历史任务报告。
- 单图/快照loss未确认不能导出，确认后真实下载；COCO/YOLO独立loader核对连续像素，无+1；1025超容量、错误hash、未批准、源组泄漏应明确拒绝。
- 每个green迭代commit；未green、未真实跑变更路径、未解决审查阻断不得提交为完成。最后登记AI授权阻塞和许可未授予，不能把工程增量写成正式商业发布认证。

## 7. 当前审查状态

独立审查发现R1–R7，已据此修订。精确接口、预算与补充验收见第8节；这不是实现完成声明。

## 8. 审查修订、接口与预算冻结

### R1、R5、R6：规范、旧稿与未知结果

新发布至少一个类别，UI及服务端拒绝空新发布。历史空规范仍合法可读，显示无可绘制类别并保留查看/救援；管理员只能显式发布新版本，不自动补类/迁移。验收空新发布及历史空规范打开。

项目创建与规范发布分别保留未发、已确认、已发未知状态。收到项目ID后规范失败只补规范；ACK丢失不自动重发，只读列表核对，保留草稿。无法确定唯一匹配就说明不确定，不猜项目或版本。每种写路径验收未发/已发未知/已确认的按钮与operation保留。验收发布新版后旧版dirty草稿刷新、任务固定规范与草稿冲突。

### R4：精确共享接口

- `GET /api/projects/{project_id}/annotation-heads?ontology_version_id=…&limit=100&cursor=…`：membership鉴权；规范必须属于项目；limit为1–100。先按asset_revision_id媒体keyset取limit+1，再LEFT JOIN指定规范head。返回`AssetAnnotationHeadPage {items:{media:MediaRevision,head:AnnotationHeadSummary|null}[],next_cursor:string|null}`；null仅真实不存在，存储/解析错误不伪装null。
- `GET /api/assets/{asset_revision_id}/annotation-heads?limit=100&cursor=…`：membership鉴权，按ontology_version_id keyset返回`AnnotationHeadPage {items:AnnotationHeadSummary[],next_cursor:string|null}`，不会静默截断多个规范。
- `AnnotationHeadSummary`：ontology_version_id、annotation_revision_id、revision_no、content_hash、completion、object_count、approved_review_id显式null或ID；不含objects/body_json。SQL摘要及精确approval查询仅针对本页；摘要不是授权，冻结时准确复核。
- `GET /api/projects/{project_id}/members?limit=100&cursor=…`：仅真实项目admin；非成员404，其他成员403。user_id keyset返回`ProjectMemberPage {items:{user_id,username,role}[],next_cursor:string|null}`；role限admin/annotator/reviewer/viewer。不是全站用户查询。
- `AnnotationImportCommitRequest {loss_ack:boolean,operation_id:Id,lease:SaveLease|null}`：lease字段必须出现，hash包含lease；同事务复用save的缺lease/错任务/closed/holder/expiry/fence规则。已成功operation重放保既有授权重验且不新增revision；同op改payload409。preview后转交、失租或提交任务，再commit不写head/revision。
- 导出未确认损失统一返回完整C1 `ApiError`：`code=LOSS_ACK_REQUIRED`，真实报告位于`details.loss_report`，保留request_id；单图B与数据集D客户端按此位置消费，不增加临时错误envelope。
- unknown项目创建不因唯一同名/角色候选就确认为本次写入；没有服务端操作关联就保持未知、只读展示候选，由用户明确选择已有项目而非自动认领。显式请求资产不可见也不跳首图，按原asset读取paused草稿并提供救援。
- 新DTO统一Rust derive→主会话xtask→TS/schema及validators，不手写generated。媒体真实`result.items`保item_index，失败项新增结构化error_code，从真实ImportError种类/预检code映射，不解析英文；成功项error/error_code为null。部分成功保逐文件结果、同名不合并、切项目迟结果不覆盖。

### R3、R7：发布与独立预算

| 预算 | 冻结口径 |
|---|---|
| 逻辑范围 | included至少1；included+excluded≤1024，唯一且不相交 |
| 媒体核验 | ≤2048次original/canonical逻辑成员；逻辑媒体字节≤96MiB，不按hash去重放宽 |
| 归档 | ≤4096成员，解压内容≤96MiB，最终ZIP≤96MiB，分别检查 |
| manifest | DB冻结manifest及最终ZIP内manifest各自精确UTF-8≤16MiB |
| HTTP | 数据集JSON请求沿用2MiB，不因条数扩容放宽 |
| job | payload≤1MiB，progress/result≤256KiB；引用式结果不放全manifest/逐对象loss |

真实513及1024 included分别snapshot→worker→download→独立native/YOLO/COCO解析；1025及含excluded总数越界拒绝，全部excluded拒绝。另验96MiB/16MiB/4096成员/请求/result独立边界；失租、抢租、结果超限、事务失败无可下载业务记录。heartbeat覆盖permit等待与构建；业务export行及job succeeded必须同事务live fence检查；download只succeeded。内容寻址staging孤儿不能成为可下载业务行。

1300+媒体跨页选取1024之后的资产；范围外、未浏览与显式excluded区别展示。独立loader核对全部资产/revision集合、几何、hash、mapping、split及遗漏，不只数量。1024条不保证任意1024张大图均可打包。

独立结果审查须逐项核对R1–R7；工程增量不改变原T32 blocked/T35 pending，不授权模型或许可。

## 9. C轮共享边界细化（实施依赖B已通过并提交）

### 固定任务打开与服务端规范绑定

实际正式B发行的独立第二合成资产证明：v1任务有效lease可保存该资产的v3 head，服务端只校验asset而未校验任务固定ontology；证据`reports/T26/commercial-core/c-task-ontology-before.json`。C06必须补该服务端约束，不以锁定下拉框替代授权。共享validate_task_lease新增实际document ontology参数，普通save及annotation import所有调用者一起迁移；不匹配返回409 TASK_ONTOLOGY_MISMATCH，不写revision/head/journal/operation。无task分支、holder/expiry/fence/CAS/幂等授权复核保持。

ReviewPanel接入项目members、keyset media和不可变ontologies，不查询全站账号；合资格指派/转交仅annotator/admin，转交选择按任务行独立保存。Role未知或非项目admin不拉members。分页失败保已有选项和准确cursor，只显式继续读取。固定任务打开的本地TaskLease带asset、ontology、task和fence，HTTP SaveLease仍只task/fence。

冻结组件回调：onPrepareTaskOpen(task)返回Promise<TaskOpenPreparation>；ticket包含本次token、isCurrent()、捕获本次scope的onTaskOpen(task,lease)、release()。Main在旧lease仍有效时取消手势、阻断新写入并flush旧文档；未确认/冲突/导入/提交中不释放旧lease、不切上下文。C1捕获task/actor/project/component及操作epoch，准备完成、release旧lease、claim目标每个await后都复核ticket与操作身份；不得用latest替换本次onTaskOpen。onTaskOpen只采用核验实际project/asset/ontology/holder/fence的结果，Main即时使旧host失效并打开固定媒体与规范；finally仅释放匹配token。未知领取不称失败或自动重发；显式再次领取沿既有同holder语义。renew/release/transfer比较完整task+fence+actor+epoch，不允许同task晚到旧renew回退新lease。续租/释放/提交保持真实绑定和不可变审核。

Workbench区分真实任务固定规范与普通URL显式规范；URL不能被误当任务使所有规范选择永久禁用。真正任务上下文优先且无有效对应lease时只读，普通显式选择仍可变更并更新URL。草稿与任务规范冲突只读救援，不复制、迁移或覆盖旧草稿。

### 保存反馈与布局

C2复用真实SaveQueue retry/恢复/救援，不重建operation载荷。SaveStatus必需scopeKey、isCurrentScope(key)、canWrite(key)；Main提供实际session/role/host、匹配task lease和import/submission/preparation状态，未知资格不写。队列resolveConflict必需捕获的同步guard，fetchHead完成后，在任何adopt/clear/resume/schedule之前复核scope、实际写资格及state/version/pending未变；调用者then检查不能替代。只读核对不恢复自动写。未知prepared operation只可原payload重放或完整救援，不能清pending换基线；只有明确拒绝后的用户处理可重新准备。错误保留真实kind/code/message/request_id；网络/500/schema错误不能当null head。本地确认绑定当前persist_seq及已提交seq/generation，远端ACK绑定实际revision/generation；旧IDB回调或旧snapshot的local_persisted布尔不能证明当前record落盘。存储失败保内存完整救援，前置媒体/规范/head/图像失败由Main保留既有record，不能承诺离线编辑。

C3是样式与工作台布局唯一writer；Main整合Task和load行为，其他writer不碰Workbench、tokens、router/nav。保留已挂载AI及lease组件生命周期，折叠仅显示/焦点变更。针对已观察的1600×1000画布仅126.8px高，重新安排类别/帮助/导入导出/反馈空间；短屏和320px允许纵向滚动但无整页横溢，关键操作不截断。44px命中、正常文本4.5对比、IME/帮助与回焦点必须实际量测，不从CSS常量宣称通过。

### 不重叠写域与门槛

- C1：features/review目录、annotations/save.rs、annotations/imports.rs、tests/t11_save.rs、reports/T26/commercial-core。
- C2：workbench/SaveStatus.tsx、lib/persistence目录、workbench/save-feedback.test.tsx、reports/T13/commercial-core；不改Workbench或样式。
- C3：Workbench.tsx的布局与就地帮助、Keyboard.tsx、LabelControls.tsx、styles/tokens.css、reports/T08/commercial-core；任务/载入行为Main在handoff后单写集成。
- Main先跑作者red，再允许实施；依旧禁止writer gates/安装/递归/提交。Main拥有C3的keyboard/help/layout行为测试（workbench/workspace-experience.test.tsx）及真实布局red，C3只提供案例，不越写域。C1 save与import wrong-task-ontology回归均可写已拥有t11_save.rs，其他跨域消费者由Main handoff后迁移。当前这些是计划，不是C完成声明。

### C07 owner 补充边界（结果审查发现，修复前不验收）

只读审查定位自动timer/flush/switch默认guard、跨mount独立IDB写链两个P1；6个消费者RED全部实际失败，记录于T13 c-save-auto-scope-review、c-owner-plan-review、c-owner-red.log。保存owner独立于host/当前选图，绑定mount、actor、project、角色及同步授权epoch；csrf改变前先失效，普通同actor/project切图仍可后台同步。Workbench模块按project保留内存队列（不跨页面刷新），setWriteOwner交接当前lease getter，旧cleanup只能撤销自己的token；安排及每await/HTTP/ACK/持久化入口均核验捕获owner。

未知请求保原actor/project/payload/op/lease/journal/used IDs；不同actor不能重放成新写，同actor新mount/auth epoch仅可显式原请求重放。旧schema缺原actor元数据只读救援，不猜作者。DraftStore同asset put/delete/read共享排空屏障，真实tx完成后才确认；IDB.open后创建写tx前再核验，skipped不确认local_commit。Root所有直接IDB读取迁到guarded readDraft。该协议不宣称解决跨tab IDB冲突，也不改服务端同op成功ACK的既有lease语义。

Shared SaveQueueOwner为token、actor_id、project_id、isCurrent、isWritable和当前getLease；constructor owner必需，原constructor getLease一起删除迁移。C2拥有persistence和save-feedback测试；外域DenseHarness/import-cutover/t34_model_wait/t24_ui调用端独立writer；Main独占API授权epoch、Workbench registry/lifetime/读取迁移。条件计划审查并非关闭P1，必须实现、绿回归、真实Native/IDB/身份切换和结果审查后才完成。

第二次只读结果审查另定位未prepared dirty与rejected恢复的跨作者归属旁路，13新增消费者实际12fail/1pass。补充计划审查条件批准：draft_owner在首次未ACK编辑前绑定，缺失/不同作者及pending_owner缺失都只救援；部分ACK不得清后续work作者。每次实际install独立内部票据，同raw/token重装不会复活旧await；交接撤local_commit认证；timer/switch/genericflush不解除owner暂停。readonly IDB get等待request及真实tx完成，失效抛STORAGE_READ_REVOKED而非假无草稿。

Main把认证epoch绑定已核验Session对象；login/logout发出前同步失效，普通render不得借新epoch重新授权旧身份。身份角色owner门不强制当前lease；已成功旧请求的unknown显式确认保原actor/project/op/payload/原lease，真实SaveStatus可通过该门而不授权下一次新编辑。Fresh明确lease拒绝的重新领取只准原作者、同固定目标、已知rejected、无heldlease，保全请求与Native草稿到真实新fence核验后才允许显式重建。CAS冲突与普通lease/权限暂停分相，实际RecoveryReport才显示冲突处理。原代码/伪造或移除validator的临时bundle都不是验收证据，Main必须完整生产源码green与真实宿主/browser重跑。

### C06 创建任务前的保存屏障（真实 Native RED 后补充）

c5真实鼠标画框后创建任务200先于ordinary PUT409 LEASE_REQUIRED，随后显式领取也在acquire前阻断；证据c6-native-create-lease-race-red.json。创建改变整张asset的保存前提，不只新task规范。required onPrepareTaskCreate冻结project/asset/norm/assignee，验证真实admin、授权epoch与作用域；保留原lease，锁字段和目标导航，取消未提交手势但不丢已提交delta。目标queue内存优先，必要时真实IDB读；原作者分别核验draft_owner/pending_owner，正常工作在原规范/原lease flush并等待最新whenPersisted，复核真实local_commit及所有gen/seq/pending/error。unknown、legacy/foreign、storage/CAS/paused与import unknown禁止metadata POST；不猜作者、不自动重试或替换操作。持本地锁到POST settle，结果未知只读核对实际任务，不声称未创建、不自动再POST。

外部创建造成的ordinary fresh明确409 LEASE_REQUIRED，只在ctxNULL/noheldlease、真实exact open task、实际assignee或platform_admin、原作者完整、原nulllease请求与Native/retained asset+norm+base一致时可领取。核验真实fence后安装fixed上下文但保留Native host/undo/pending/journal，不触发同scope加载重建；直到显式retryRejectedLease才重建明确被拒绝的新操作。historical unknown、其他规范/错误与已知fixed特例不混用。计划有条件批准见c-task-create-plan-review.json；未GREEN、真实Native前后证明和结果审查前不标done。

### C06/C07 后续结果审查修订

正式c6b真实Native证明领取保持同Canvas，但新fence retry真实ACK后重建Canvas并丢Undo（c6-native-claim-retry-undo-red.json）。成功ACK与最新真实IDB完成后，若当前Native committed document等于当前queue完整document，保持host/request/history/selection；真正readonly或不同document才恢复currentrecord。服务器revision推进由queue confirmed base投影到AI，不以替换Canvas key更新。不同媒体catalog只更新目录，准备中延迟应用，原actor/project/epoch/scope过期丢弃；真实任务列表可只读刷新，不需整页reload或无关转交来发现外部任务。

已拒绝的原operation与historical unknown均可显式原样确认；编辑pause及上次诊断保持到匹配operation、revision和document的实际ACK，已拒绝重放只该pending一次，不带出future dirty新操作。未知请求后续4xx不改成已知拒绝或借新lease/newop。每install票据及独立双作者保护所有async，public local_commit在raw授权失效时即时撤销且不自动复活。SaveStatus通知Native恢复前等待稳定latest whenPersisted并核验current certificate；边界测试不是Native证据。

未知metadata创建按原project+actor在已挂载panel中保留，不绑定可变role；不污染独立scope，回原scope仍只能核对。发送前记录未确认，解析成功或明确4xx仅清原pair，晚结果不清新scope。跨卸载/刷新不宣称这份内存状态持久化，任务唯一性与服务权限仍由后端复验。中文主错误仅由实际kind/code/status映射；原message/request_id及标量确认凭证可展开，不在关闭的details热序列化整份document。

### C07 固定任务旧成功回执与最新本地提交

formal c7b 真实 Native 在 TaskD fence2 保存实际 HTTP200 后故意仅向应用抛网络错误；随后正常释放任务，显式原 operation 重放实际 HTTP200/idempotent_replay，但真实 IDB transaction complete 仍是旧 unknown/pending/base，内存已 ACK 且 local_commit 为 null（c7b-fixed-unknown-ack-real-red.json）。两参数 consumer 同样 RED，分别覆盖原 generation 和未来 Native generation/journal。精确 receipt 的当前 actor/project/directepoch/hostscope/install-ticket/双作者权限与 fresh operation 的任务 lease 权限分离：pending 清除不让该原 ACK 持久化 guard 自失效；真实最新记录提交后才发布新证书。partial ACK 仅推进原 N 和原 journal 范围，无当前 fixed lease 的未来 dirty 保留并暂停，绝不循环创建 nulllease 新操作，也不恢复 editable Native。ordinary 非 fixed nulllease 保存、C06 显式准备 flush 和旧请求 immutable payload/operation/fence 都不改变；身份、作用域、角色或安装票据失效仍立即撤销全部 async 权限。

### C07 已确认原回执后未来本地工作的显式续领

formal c7c 实际第三 Native command 保存 HTTP200、第四 Native command 仍属最新本地，丢回执后正常 release 与原请求同 payload/op/fence3 的真实 idempotent200 确认；actual IDB gen4/synced3/doc4/pending0/paused/cert4 均正确，但 SAME TaskD 普通 UI 再领取在 API acquire 前被旧冲突/未知屏障拒绝，用户未来工作无法继续（c7c-partial-native-ack-and-reacquire-red.json）。采用EA47的独立显式 controller 准备：same fixed task/project/asset/norm、原作者、实际当前身份/epoch、无持有lease、无pending/error/CAS/storage/inflight、可信已确认base（真实memory ACK或实际加载的不可变server base），最新真实IDB certificate与Native fullcommitted doc/gen完全一致。只允许该same-target acquire跳过缺lease的旧dirty flush；保Native/queue/journal/history且不自动save/清pause/释放别的task。新actuallease/fence确认后用户显式调用 retryOwnedFuture(asset,initialProof,reconciliationGuard)，所有参数必填；initial proof只捕获一次，持续currency不依赖mutablepending；mint及真实dispatch独立fresh权限核验，一次新op只带latest fullDoc/unsyncedjournal/可信base/newlease。Native编辑pause保持至该真实ACK与stable最新IDB complete，失败/abort/撤权/过期/被新记录取代不能解锁；明确已ACK的本地事务失败只显式重试本地提交，不new op或HTTP。unknown反馈不再把裸baseMismatch或网络/协议失败称原请求已拒绝。

### C07 旧请求入口与非法元数据保全

独立只读源码审查确认：固定任务已 release 后，原作者 rejected 请求被 unknown-only 按钮资格挡住；这与真实 C5 留存的旧错误诊断相结合会困住原作者。采用只读 canRetryRetained 查询，隔离原样重放或同安装真实 ACK 的 local-only commit retry 与 fresh operation 权限；不扩大 lease/CAS/Native 权限。cold null-base consumer 同时证实失败定位的 restore 将原 null base 写为空字符串；非法 raw 草稿只救援，不装入/写回。已确认 155 owner/feedback/t13 消费者通过 remaining-delay 调度纠错；本节不宣称新资格、非法草稿保全或 formal c7d 实际旅程已 GREEN。

### C07 ordinary 实际 ACK 也须等待本地提交

formal c7d 已实际完成 cold gen4 future续领/fence4/新请求真实200、gen6真实200丢回执/Native gen7 future、release后原payload/op/fence4真实idempotent200、sameTask fence5/显式新gen7真实200、Native Undo回到完整gen6并真实200。Native Redo gen9的真实HTTP200之后，真实IDB put请求success再transaction.abort，磁盘仍pending9/synced8，但UI仍允许Native编辑且无local-only retry入口（c7d-ordinary-ack-idb-abort-real-red.json）。原因是仅原已paused路径安装ACKlocalbarrier；移除此例外，每个实际接受ACK都以sameowner/guard/receipt/latestIDB屏障暂停编辑及后续发送，真实latest事务complete才解除；失败只原安装显式重试本地put，不HTTP或newop。desiredPause、actuallease、futureremaining-debounce、旧unknown及fresh权限分离保持；cold prepared已有原样unknown恢复，不能DB修补或拿head冒充ACK。此修订尚待新增controlled gate和formal c7e真实重验。

### 用户收口指令：本轮后停止

用户在 C06–C10 执行期间明确“执行完这一轮就停止迭代”。因此完成当前 C 轮全部命名验收、真实工作流、独立结果审查、文档/证据和 commit 后停止；不启动 D/E，不宣称它们完成。原数据集扩容及最终联合迭代计划保留为未执行。不得追加真实模型调用，T32 blocked/T35 pending 与 UNLICENSED 边界不变。

### C06–C10 本轮结果与操作入口

本轮只关闭 C，不覆盖 D/E 的扩容和跨轮验收。管理员在“任务与审核”中明确选择图片版本、固定规范和项目成员后创建任务；标注员显式领取匹配任务，在服务器确认且最新本地事务完成后提交固定 revision；审核员查看不可变版本后作出决定。新 revision 不继承旧批准。

“图片与对象”“属性”“AI 审校”可分别收起。折叠不会卸载任务面板或 Native 编辑器；窄屏可先关闭侧栏再使用“适配画布”。“快捷键帮助”可用 Enter 展开、Escape 关闭并返回标题焦点；输入框及 IME composing 不触发画布工具快捷键。

保存暂停、冲突或结果未知时，先下载本地草稿并核对原账户、项目与固定任务。只有界面明确提供“重试保存”时才确认原请求；该入口保留原 operation/payload/base/lease，不用新编号绕过未知结果。真实 ACK 后本地提交失败只重试本地事务，不重发 HTTP。版本或结构不支持、目录读取失败时仍可下载完整 raw；不要清站点数据或手工修改数据库。

最终完整前端回归 23 文件/493 项通过；正式构建的 TypeScript、生成契约、Rust API/WASM 与 Vite 均通过。真实硬件 producer 两项通过；实际 2k/10k Node producer 单独登记，不冒充 GPU 时间。真实角色任务提交/不可变审核/新 head 无继承批准、ACK 后 IDB abort/local-only retry、同 Native Undo/Redo，以及两个 raw 救援缺陷的 RED/GREEN 均有归档。受影响 T15/T24 五条实际硬件浏览器路径通过，覆盖逐文件媒体结果、损失确认与实际 COCO 下载、EXIF/mirror、负样本、Native 键盘原子性、冲突恢复及提交屏障；T24 的模型接口是明确测试夹具，不是外部模型验收。

7 个实际 viewport 无文档水平溢出，画布 ≥240px；已采样工具按钮 ≥44px。空、非空和无匹配对象三个实际 axe 页面均无已确认 WCAG-tagged 违规，各仍有 2 项需人工判断；这不是全设备/全控件 WCAG 认证。正文 metadata/surface 与 muted/surface 的实际计算对比度为 5.85 和 8.21。独立源码/结果审查关闭 C-RAW-01、C-RAW-02；收尾实际回归发现的冲突预览恢复与 scoped flush 问题由单独增量审查闭环，见本轮验证引用。

证据入口见 本轮验证（私有归档：`reports/T08/commercial-core/iteration-c-verification.json`） 与 独立结果审查（私有归档：`reports/T08/commercial-core/review-c-final.json`）。C 后按用户要求停止；D/E 未执行，T32 blocked、T35 pending、UNLICENSED 不变。

## 10. 用户重新要求持续迭代：D/E 恢复

新请求重新要求按比较结果持续迭代。第9节C后停止是已执行的历史决定，不抹掉其证据；本次从`feb9b828b6cf2511e0650ea6840e22c365ee1a0f`继续未执行的D/E，不重做A/B/C，也不解除模型、许可或发布关卡。当前源码前端23文件/493通过、T27原生6项通过；一次基线检查暴露了测试中动态`toRecord.updated_at`的毫秒差，删除该偶然值比较，保留非法raw拒绝、authority证书、暂停和实际存储写入断言。

D复用已有鉴权keyset annotation-head摘要，不拉取所有文档或把项目大小当作快照范围。规范显式选择；included、明确excluded、已浏览范围外与未浏览分开，任何批选都由用户明确触发且先原子检查容量。范围最多1024含排除项、至少一条included；2048逻辑媒体核验、96MiB媒体/解压/ZIP、4096成员和DB/ZIP各16MiB manifest独立检查，HTTP与作业预算不放宽。

freeze使用短事务捕获不可变revision/批准/媒体绑定，事务外核验及序列化，发布时短事务复验身份、绑定和幂等。后台heartbeat覆盖等待permit、构建及staging；有界结果在发布前准备，export业务行和job succeeded同事务检查live worker/fence/expiry，download还必须关联succeeded job。失租/抢租/结果超限/事务失败不得产生可下载记录。

数据集loss错误迁到既有C1 `details.loss_report`，不保留旧top-level兼容分支。未知snapshot/export保留原actor/project/operation/body，只能显式原样重试；已知job仅GET重查。格式/范围变化撤销旧确认，缺失或坏报告不能说无损。

完整写域与逐项验收见恢复计划（私有归档：`reports/T27/commercial-d/d-resume-plan.json`），三份发现报告同目录。最多三个项目内隔离writer加一个只读reviewer，主会话独占生成契约、装配、门禁、真实浏览器及commit。审查计划后先tests-only RED，再并行实施、整合GREEN、实际513/1024三格式worker下载及逐资产独立loader、规格/安全结果审查后提交D；E依赖D green commit。

### D计划审查修订

恢复计划的最终精确paths是唯一写域，发现报告中的提案已迁移；D2不得写T27 integration，D3同时拥有t27_snapshot及独立fixture/oracle。loss仅用C1 `details.loss_report`。最初tests-only RED针对当时既有的worker、发布、queue及archive入口；实际D已移除原分离发布入口，改为live fenced业务行与job终态同事务提交。缺新helper编译失败不是RED，私有helper和分阶段gate测试随真实实现添加。具体初始入口、fixture、精确预算及私有通道见测试契约（私有归档：`reports/T27/commercial-d/private-test-contract.json`），不增加公开fault端点。

queue现有report_progress也必须将now/续期时间移到成功获得BEGIN之后，finish/renew/publication同理，防止等锁期间过期后被旧时钟复活。export创建也分短capture、事务外精确字节/parse/hash/loss准备、短终事务membership与immutable dataset复核并同事务enqueue/idempotency；不能解析失败或SQL故障伪装404。旧worker失租不能发布，阻塞构建/staging仍须join后才释放permit，不允许脱离的重任务并发。所有命名精确预算、失败矩阵、六份真实下载及独立完整内容/hash比较保留，不以缩小注入预算或不相关早期拒绝替代。

### D已验证并提交（以下保留历史执行记录，E最终联合结果见下节）

当前实现将captured批准与请求的project、任务asset、ontology及同一不可变revision重新绑定，decision/submission批准清单均须匹配；媒体对象、原始revision/批准绑定与成员身份在最终短事务复验。旧head变化不重定位已请求且获批的历史revision。媒体重复hash仍按每个逻辑original/canonical引用扣除次数与字节，数据库与ZIP manifest均按最终UTF-8 bytes独立限额，不用文档长度加估算开销替代。

主会话已执行当前代码API库50/50、T27公开原生25/25、归档私有6/6与T14格式13/13，以及正常后台worker的真实HTTP三格式小夹具和双origin保密性2/2。真实不可变submission更新保护、延迟media外键COMMIT失败与rollback、合法另一个PNG绑定变更拒绝、两份实际获批revision的prepared批准绑定错配拒绝/未改成功，均保留并通过；没有关闭外键或保护来做fixture。前端当前24文件561项及其中68项交付范围边界已通过。

正式构建使用`--intermediate-dir`独有空目录，先拒绝已存在、release alias、双向嵌套及junction/case别名，再开始构建。WASM由现有Vite插件经`WEBLABEL_WASM_BRIDGE_DIR`读取本次生成目录；Host由`build-agent-host.mjs --out-dir`生成并直接复制到本次release。18份实际release产品hash/size和4份fresh Host/WASM中间文件已核验；不读取/写回旧固定WASM、Host或用户dist。D发行当前source_commit仍是未提交基线，实际changed源码hash另存；E必须在D actualcommit之后重新构建新发行。

后续受影响回归仅在导入前显式指定`WEBLABEL_T29_ROUTER_TARGET_DIR`、`WEBLABEL_T30_TEST_ROOT`与`WEBLABEL_T30_HOST_SCRIPT`到项目内独有路径/本次Host。没有设置时既有调用者默认行为不变；禁止调用会覆盖用户旧证据的历史全量包装脚本。正式CLI前门只转发`/api/*`，验证真实API `/health`204、前门`/`200及同源登录session，不虚构前门health路由。合成账号凭据只留内存，不写证据。

正式同源CLI已真实bootstrap并登录，1301媒体完成14页keyset摘要浏览与末行选择，真实1023纳入+1明确排除冻结成功。513与1024纳入各native/YOLO/COCO六份正常worker产物已逐成员、逐资产独立核验全部不可变revision、完整native文档、几何、全局类别映射、split/group、媒体hash/像素与遗漏；两份快照均在后续未批准head修改之前固定。实际YOLO/COCO损失报告、格式与范围变更撤销ack、明确确认、已知产物503故障保留与仅GET重下载均已验证。

真实320×640与320×400发现规范选择框被挤至26px；只在既有639px以下断点分行版本label/select与浏览按钮，新正式发行实际304×44px、无横向溢出。1280×800、1100×800、1098×800亦通过；短屏Tab到冻结、1301末行、split、快照编号、格式、生成与下载均可见且不小于44px，Enter已完成真实固定、正常worker原生导出及项目内ZIP实际SHA核验。修复后68项范围边界再次通过。

下载排查保留真实浏览器记录：一次自有合成原生包自动落到默认Downloads，未擅自读取或删除；CDP混合Windows路径导致FILE_FAILED，改用项目内Windows原生绝对目录后真实下载通过。没有改产品下载、关闭安全配置或以API字节冒充UI。D最终独立PASS，一项路径误读由原始JSON精确比较撤回，保留初审与依据，不改产品。D实际focused提交`5849c5b918755febf91b000f1a3cb5d5ece29817`；其后E联合计划PASS并完整执行，最终结果见下节。模型授权和许可证边界不变。

E测试须明确分开：现有Debug fixture回归依赖只在debug_assertions下提供的内部测试控制，使用主会话从D实际提交源码构建且绑定hash的debug API；不得向正式API加入测试hooks或筛掉套件。包装、真实同源界面与正常worker使用D提交后的新正式RELEASE，T30受监督Host使用本次发行Host；T33恢复演练使用独有Root目录。两类证据分别记录，不把工程mock/debug回归说成真实渠道或发行支持。

### E完整联合结果：已验证、独立审查PASS并focused提交`35c8009c28b54681425d14bcfbf479f8e6168e27`

完整workspace原生322项、24个前端文件562项、11个完整集成文件60项全部通过，无ignored/filtered/skip/waiver。严格TypeScript与generated contracts退出0、schema验证3项、精确7个Rust文件格式检查退出0。原生和整文件集成在两个UI修正前运行；API/Host/WASM生产未改且最终字节一致。最新CSS后全前端562项与正式构建内contracts/严格TS均重新真实通过。初始T25九项失败来自共享positive夹具的空规范；只给该夹具添加合法bbox_xyxy类别，原九项消费断言及空规范negative约束不变，窄9项与全workspace322项通过。

普通新账号创建项目并发布规范后，原Session仍无新项目membership，媒体控件正确只读。shared open现在调用已有Session.refresh，在authoritative角色核对期间不挂载新scope，保留generation/actor epoch、canWriteRole、draft owner和lease/fence。新增consumer回归真实RED32通过/1失败→GREEN33；正式同源实际新项目无需刷新页面或改角色即可上传。

普通UI真实发布两类各四属性的v1、上传1个好PNG与1个故意格式不符文件并显示部分成功；真实NVIDIA blackwell Native绘两框、改类、整笔数值几何、Undo/Redo、四属性、CAS保存与刷新完整文档一致。再发布v2后旧媒体/规范v1不迁移且继续可用。COCO/YOLO预览只读，展示attribute_defaults等实际损失，未确认不能提交；独立确认后正常CAS commit，全部框坐标核对，f64舍入使用统一64×EPSILON相对边界，不引入产品舍入特例。

独立合成角色B领取固定v1任务、完成并提交不可变revision6，角色C查看该版本与parent差异后批准。批准之后、后续head变更之前，普通UI冻结所选revision6并由正常worker导出/实际下载native、YOLO、COCO；全ZIP独立Python与Sharp核验完整revision/document、全局类别map、split/group、批准理由/actor、所有成员与源图/canonical hash和逐像素。后续普通UI创建distinct任务，B以新lease/fence仅修改comment并保存revision7；公开GET证明parent为6、旧revision完整不变、旧C批准仍只绑定6、新head approved_review_id为null。已结束task的旧Canvas无lease拒绝是正确guard；项目card导航清当前asset而不清旧task query，新B显式claim才换到新task，未清IDB或接管草稿。

最终1280×800、1100×800、1098×800、320×640、320×400两surface均真实无横向溢出，主控件不小于44px，实际Tab焦点solid2px且全部可见，Native始终hardware ready。320×640下载焦点底边原裁0.234px；只给既有dataset按钮/select/summary增加scroll-margin-block:8px，不放宽可见性条件。诊断注入已移除；独有新正式发行实际CSS SHA、18产品与4fresh中间件全部核验，API/Host/WASM及业务JS字节与前一正式E功能验收完全一致。320×400实际Enter下载48771字节native完整SHA匹配正常job。

完整证据与源码SHA见reports/T27/commercial-d/e-joint-verification-final.json；实际源码commit及构建时D基线加E变更SHA的真实绑定见e-actualcommit.json，不虚称precommit manifest已含E SHA。独立完整882行e-result-review-final.json为PASS、P0–P3均0；reviewer保存EPERM由Main保存完整原payload清除，不重审、不伪称reviewer写成功。十图实际审查、四张短屏按PNG bytes纠正扩展名，内容不变。B lease普通UI释放200；最后E2/E3 CLI及自有Chromium退出0、own lock移除/端口空闲，初E1 controller真实exit1与成功owned stop/lock移除分别保留，不声称所有controller exit0。五自建worktree的41个全部修改/未跟踪文件及独有commit检查后逐字节保全再移除；15前期加1最终metadata临时driver及ledger均保全后清理。项目内正式发行、合成DB/对象/草稿profile及长期证据保留，不触碰用户已有改动、数据、浏览器或私有文件。

真实GPU证明仅本机Chromium/NVIDIA，不推广跨浏览器/多vendor或全WCAG；UI三ZIP样本为1图/2对象/train，大规模513/1024与negative/group边界由D完整证明和原生/整文件消费者另覆盖。没有本人真实模型账号、live渠道或新付费调用/大权重/真实业务图/远端push。原T32 blocked、T35 pending、UNLICENSED与暂不授予再分发许可不变；原36任务DAG没有可执行就绪任务，不自动扩大范围。
