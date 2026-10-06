# 自愿本地工时与受控试点协议

## 目的与证据边界

供项目操作员准备一个可复核的三臂对照试点。工具输出描述性统计，不输出ROI、市场验证或“节省30%”结论。`goal_human_time_reduction=0.30` 仅是预注册目标。样本为0时 `status=noData`，ROI/结论为null。即使提供人工记录，分析器也只标识 `operator_supplied_unverified`，不认证其真实性。

程序化演示是 **SYNTHETIC_FORMAT_DEMO**：20张真实生成的公开矩形PNG、每图ID/SHA256/seed/GT以及三臂的60条程序化记录。时间、错误、退回数均为演示输入，不是人工实测，也没有调用AI。20张配对图片不是60个独立样本；对象嵌套在图片/任务内，不能把70个对象误称70个独立操作员。

## 开启、暂停与数据控制

工作台“本地工时 · 自愿记录”默认关闭，重载仍关闭。每项目、每登录用户独立本地记录。开启后使用当前会话的 `performance.now()`；不以系统日期计算工时。已确认区间可跨会话累加，但旧会话的时钟锚点绝不恢复。时钟倒退不会产生负耗时或重复计时。

人工时间分为任务准备、标注、修正、审核、切图，类别互斥，人工合计为这五项之和。模型等待单列，不混入人工合计；等待时若人同时开始修正，选择修正，后续区间只算人工。分类可手动选择；工作台实际提交/切图/AI状态为自动分类边界。普通输入/指针活动只刷新活跃状态，不读取事件值、键名、提示词、笔记或几何。

失焦/隐藏后不计区间；人工空闲超过60秒仅保留上次活动后的前60秒。重新聚焦或实际交互开始新的有效区间。模型等待不受人工空闲阈值影响，但仍排除失焦时间，因此是“前台等待时间”，不是完整服务端作业墙钟延迟。需要端到端模型延迟时另取作业时间，不能把这里的等待称完整延迟。

本地定期与状态转换时确认区间，突然崩溃只恢复此前确认区间，最后未确认时间不猜测补齐。同步存储失败显示错误并停止可选收集，内存已测区间仍可下载，不能称已可靠落盘；若保存前的最终确认发现存储失败，停止发送项目保存请求，确认版本落盘失败也不会继续保存下一会话。损坏或无法访问的旧journal不会使主标注工作台失效，也不会自动覆盖/清除：统计保持禁用，可先下载原始记录，再明确清除；浏览器拒绝存储时先修复权限。每会话最多10000区间、累计不超过24小时；达到上限会停止并提示导出/明确清除后开始新会话。

“下载本地区间JSON”不发网络请求。“明确保存到本机项目”才向已认证本地服务发送区间；不是后台遥测，不发送外部站点。保存只归属当前用户、当前项目；同项目其他用户（含审核员）看不到本人的统计。清除本地记录关闭收集并开始新会话ID，不删除此前明确保存到本机服务的记录。localStorage属于浏览器同源存储，不是加密保险箱；不要在不信任的浏览器配置中采集。

## 三臂设计：先预注册，后测量

1. `human_only`：纯人工，无AI，`ai_configuration=null`。
2. `current_tool_same_AI`：现有工具，固定相同AI配置。
3. `this_tool_same_AI`：本工具，使用与第二臂完全相同的AI配置。

先固定图片清单与SHA256、canonical方向、规范版本、任务定义、抽样seed、操作员经验、训练阶段、硬件、AI完整模型/权重版本、提示/预处理/候选阈值与预算。AI配置标识必须引用一个不可变配置记录，两AI臂不能使用不同配置。现有工具耗时用相同人工/失焦/空闲规则独立记录，不把本工具前台时间当现有工具时间。

对图片/难度/密集度分层，以预注册seed随机分配顺序。使用不同但匹配的任务组或平衡交叉设计避免同人记住同图；记录顺序、训练/热身与中断。按图片/任务配对分析，报告操作员数、任务数、对象数，保留异常与失败，不只挑选成功图。费用未知为null；不把订阅费用摊销、失败调用或无usage调用默认为0。

## 独立质量审核：漏标不以AI建议为分母

审核员对完整原图建立GT对象库存，不先看AI提出了哪些对象。固定对象匹配规则（例如类别、IoU阈值、属性未知语义），盲化工具/臂信息并保留争议裁决。记录审核员标识、方法版本与审核的不可变标注revision。AI从未提出的GT对象必须参与漏标计数。

每记录提供完整 `ground_truth_object_ids`，最终正确匹配的 `final_ground_truth_object_ids`，AI正确匹配候选的 `ai_proposed_ground_truth_object_ids`（纯人工为null）。漏标为GT减最终匹配；`ai_never_proposed_gt` 为GT减AI候选匹配，不等于最终漏标。多余对象计入 `wrong_objects`；错类别、错属性单列，可按预注册规则同时记多项错误。未审核的错误项保持null，不填0。`returned_tasks / reviewed_tasks` 为退回率，分母为0或未知为null；说明是否首轮或所有轮次，不混淆两者。

## 分析输入与执行

本地区间导出不是试点样本。操作员必须将区间按任务/臂归档，附独立GT、质量审核与费用证据后形成以下schema。每条记录保留同一sample单位；不要把同一图的汇总与对象级记录混在同一个比较中。

```json
{
  "schema_version": 1,
  "samples": [{
    "sample_id": "paired-image-001",
    "sample_unit": "image",
    "image_id": "public-image-001",
    "image_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "task_id": "task-001",
    "seed": "pre-registered-seed",
    "synthetic": true,
    "auditor": "synthetic-example-not-human",
    "quality_method": "full-GT-inventory-example",
    "arm": "this_tool_same_AI",
    "ai_configuration": "SYNTHETIC-example-no-model-call",
    "durations_ms": {"task":1000,"annotation":2000,"correction":3000,"review":4000,"switch":500,"model_wait":6000},
    "ground_truth_object_ids": ["gt-1","gt-2"],
    "final_ground_truth_object_ids": ["gt-1"],
    "ai_proposed_ground_truth_object_ids": ["gt-1"],
    "wrong_objects": 0,
    "wrong_labels": 0,
    "wrong_attributes": null,
    "returned_tasks": null,
    "reviewed_tasks": null,
    "fees_usd": null
  }]
}
```

示例SHA仅演示字段，真实记录必须来自实际图片哈希。匹配ID必须属于GT，重复ID与重复arm/sample拒绝。时间/计数为非负安全整数；费用为有限非负USD或null。三臂名称大小写固定。相同sample_id的跨臂记录必须使用相同图片hash、seed、单位和GT库存。

```text
node scripts/analyze-pilot.mjs --empty --out zero.json
node scripts/analyze-pilot.mjs --demo reports/T34/synthetic-demo --out demo.json
node scripts/analyze-pilot.mjs --input reports/T34/synthetic-demo/samples.json --format csv --out demo.csv
node scripts/analyze-pilot.mjs --input pilot.json --out analysis.json
```

JSON保留逐样本记录与GT差集；CSV每臂一行包含图片/对象/任务分母、seed/审核方法、人工分类、等待、漏标/错标、退回与费用，未知显式写 `null`。`human_total_ms` 为五类人工工时；`active_total_ms` 加上单列前台模型等待，是有效流程总时长，不冒称含失焦/空闲的端到端墙钟完成时间。若研究需墙钟时间，另用完整任务起止证据并报告中断，不以有效工时推算。所有CSV单元按RFC4180转义，字符串公式前缀保护。CLI非法输入退出非0，不降级为零样本成功。

## 本机项目保存契约

`PUT /api/projects/{project_id}/activity-sessions/{session_id}` 接收 `{expected_version,intervals:[{seq,kind,duration_ms}]}`，初始版本0。服务端身份来自session，不接受客户端指定actor。区间seq从0连续，kind仅六种，duration为正安全整数；空区间、重复序号、负值及越界422。相同区间重放返回原版本，不重复计时；追加必须携带当前版本并保持旧区间为不可修改的前缀，否则409 `ACTIVITY_CONFLICT`。成功返回 `{session_id,version,intervals}`。它独立于标注/任务CAS，不修改几何、审核或租约。

`GET /api/projects/{project_id}/activity-sessions?limit=20&cursor=...` 仅列出当前用户的已明确保存会话；limit1..100，session_id字典序游标，返回 `{items,next_cursor}`，末页为null。沿用本机认证/项目角色/Origin/CSRF约束，未登录401，无项目角色403，写缺CSRF403。无自动发布、无公共聚合、无AI/供应商调用。

## 判读与发布纪律

先完整公布描述统计、质量与样本选择，再由独立分析评估配对置信区间、质量不劣界限和外部有效性；本工具不自动做该裁决。预注册目标不是实测结论。未经真实人工试点，不写节省比例、ROI、市场竞争或真实模型质量通过。程序化演示只证明格式、计算及复核链路可执行。
