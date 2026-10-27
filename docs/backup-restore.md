# 一致性备份与恢复

这是有权管理本机数据的操作者使用的高级运维指南，用于创建一致性备份并恢复到新目录，不是普通用户登录前的准备步骤。已启动服务的用户直接按[网页首次登录与人工标注](getting-started.md#首次登录与人工标注)操作；首次设置与恢复后设置都不需要另开 PowerShell 初始化。备份会包含**全部本地项目业务数据**，不是单个成员的项目导出。只向可信操作者提供文件访问权限；向项目成员交付数据请使用鉴权快照导出。

当前运维使用 v2 发行中的单个原生程序，不需要 Node、Python 或编译器。下文用 Windows 的 `weblabel.exe`；Linux 使用同目录的 `weblabel`。从源码先[构建发行](getting-started.md#构建与启动)，并把示例可执行路径和 build-dir 一起替换为实际的新发行目录。旧 v1 包保留不动，不手改 release 清单。

恢复目标已存在、schema/hash 校验失败时按[备份恢复故障分组](troubleshooting.md#备份与恢复)保留原数据与失败证据，不覆写目标或改清单。未同步浏览器工作先按[保存与恢复](troubleshooting.md#保存与恢复)导出保全，再进行服务器备份。

仅忘记仍有正常密码的管理员时，不搬迁/恢复数据库，使用[本机管理员密码恢复](operations.md#管理员密码恢复)，保留原user_id、角色和业务数据。本文从备份恢复清空旧凭证并创建新restore-admin身份，两者互斥。已完成恢复journal是不可修改的审计数据，不含code/password/CSRF，随业务身份保留；不为scrubbed旧账号重新授予恢复资格。
## 创建备份

```powershell
.\target\local-release\weblabel.exe backup --data-dir "data" --backup-dir "backups/2026-10-06 中文 备份"
```

`--backup-dir` 必须不存在，且不能位于源数据目录内部。不复制源目录整体，也不忽略 WAL 裸拷主库。Rust 运维使用 **SQLite backup API** 取得事务一致快照，支持 API 正常运行且 WAL 有提交时备份。v1 备份格式与原 Node 工具互读；互操作证据不冒充全部真实安装升级或跨版本 schema 迁移保证。

源业务 DB 不被 scrub/修改。对象在快照取得后根据该 DB 的媒体/导出引用收集；不可变对象的存在和 SHA256 验证完成后才发布 `backup.json`。源不存在或 hash 不符会非零退出，不生成“成功”的清单。

成功备份只包含以下内容；清单发布前必须完成校验：

- scrubbed `api.sqlite`；integrity_check 和 foreign_key_check 必须通过。
- DB 引用的不可变媒体与导出对象（不是临时文件、孤儿对象或凭证目录）。
- `backup.json`：格式/版本、UTC 时间、实际 schema_migrations 已应用版本、完整业务 schema hash、认证处置、每个对象/数据库的 SHA256 和字节数。当前 API 使用自有迁移版本表，不存在 SQLx checksum 表；不伪造该字段。

每个输出目录独占创建。失败会删除本次命令自己创建的未完成备份（可能还含原始认证页）；不会删除源业务数据或已有备份。副本用secure_delete、VACUUM和WAL checkpoint移除被删除认证数据的旧页，然后**仅对副本切换DELETE journal mode**，关闭数据库后再计算最终单文件manifest hash。

源DB/WAL与源journal mode不变；正常只读SQLite审计备份后不产生WAL/SHM，仍可验证原manifest并恢复。备份包含敏感业务图像、规范、提示词和审计，**没有加密或数字签名**，必须自行设置目录ACL、加密磁盘和保管策略。Hash发现损坏，不证明作者可信。

## 不搬运认证

恢复需要保留业务历史：用户 ID、用户名、审核/创建身份引用、标注历史、媒体、快照和审核关系都保留。新管理员负责之后的操作，过去的审计不能改归给他。

移除session/CSRF、全部旧password_hash、model profile私有config_json/secret_ref，清空外发preview/consent/run authorization。对其余持久业务TEXT默认检查已知配置凭证，包含项目名称/描述、用户名/身份、任务/活动历史、业务ID/hash、审核issue code、媒体原始文件名及未分类字段；JSON检查原文和解码后的键/值，包括Unicode与引号转义。

冲突时以 `credential_in_immutable_business_data` 拒绝并删除本次不完整输出，不改写业务字节、空白/转义、批准绑定或审计身份，源DB/WAL不变。只对明确的 `jobs.progress_json` 可变诊断值和既有 `model_runs.profile_snapshot_json` 凭证配置保留脱敏；键冲突或无法安全消除的原始编码仍拒绝。

不用清理运行/租约状态掩盖原业务碰撞。官方CLI home/OAuth/API key文件、环境和私有Host配置从未枚举或复制；不声称自动发现未知秘密，也不扫描业务图像二进制。

排队/运行作业恢复为interrupted，不自动继续模型；活跃lease清空、fence和历史身份保留，profiles为needs_configuration/not_run。备份输出明确sensitive-whole-server-database、unencrypted、sha256-not-signature，不能覆盖任何浏览器未同步IDB草稿。每个浏览器先核实本地与远端证书；unknown/paused/foreign-author先下载完整救援包，不generic flush解锁。恢复后终端输出交接清单：指向全新目录、准备新凭据、核对原user_id与成员、按原作者只读救援草稿、显式重配AI并检查revision/media/snapshot/export；新凭据不授予旧作者写权。

## 恢复到全新目录

先保留旧目录，选择一个**完全不存在**的恢复目标，并确认父目录已存在。恢复成功后才能启动新目录：

```powershell
.\target\local-release\weblabel.exe restore --backup-dir "backups/2026-10-06 中文 备份" --data-dir "data-restored"
if ($LASTEXITCODE -ne 0) { throw "恢复失败；保留原数据和失败目标，不启动新目录" }
.\target\local-release\weblabel.exe serve --build-dir "target/local-release" --data-dir "data-restored" --port 48100
```

只接受当前发行的精确 schema/迁移，先检查清单、每个文件长度/hash、SQLite 完整性与外键、实际 schema 和当前迁移重建的 schema、实际已应用版本清单、对象引用闭包和认证已清空，全部成功才独占创建新目标。schema SQL 仅将 CRLF 规范为 LF，不放宽字段/约束/trigger 比较。

版本不兼容应先使用对应源码发行或另做受审查迁移；没有“忽略 schema”开关。

完成备份只能包含已checkpoint的单一数据库状态；恢复在打开 SQLite 前拒绝任何 `api.sqlite-wal`、`api.sqlite-shm` 或 `api.sqlite-journal`，不能让未列入清单的sidecar影响校验再只复制主文件。不要把运行中目录或手拼主库/WAL目录当完成备份；使用本工具的一致性备份。

`--migrations-dir` 可指向可信发行中的 migrations；不要从不可信备份接受替代迁移。目标只要已存在就拒绝，包括空目录和正在使用的目录。没有 overwrite、reset，也不会隐式清空。复制失败的本次新目录保留以便检查，缺少完成标记，不能当恢复成功；选择另一个新目录重试。

恢复写入 `restore.json` 完成标记。原生服务取得数据库 OS 锁后验证标记与已清空认证资格，再开启一次性恢复认证；兑换事务内再次检查，不能重置已有正常密码的数据库。

restore 成功只输出交接说明，不打印恢复码。随后用 `serve` 启动新恢复目录，终端才输出一次性 `WEBLABEL_BOOTSTRAP_CODE`。在精确本地网址的“设置恢复后的本地账户”中填写新码与密码。服务创建 `restore-admin-<新UUID>` 并授予已恢复项目 admin membership；保存实际新用户名，后续正常登录。历史用户 ID、成员和审计关系不变，旧密码/session 失效，不把历史改归新管理员。正常重启不会再次重置已设置的新密码。

空用户备份的新库沿用正常 `local-admin` bootstrap。

## 恢复演练

1. 启动新目录并用新本地认证登录，确认旧密码/旧 session 不可用。
2. 按不可变 revision ID 读取历史对象与 created_by，比较原值。
3. 打开 canonical 媒体，比较实际内容 hash。
4. 从旧 snapshot ID 创建原生导出并鉴权下载，核对固定 manifest hash/旧审核人；新 head 不应改变快照。
5. Ctrl+C 停止，核对 OS 锁已可重新取得；持久 sidecar 文件保留，再检查 SQLite 完整性，不靠删除文件解锁。

T33 使用程序生成媒体和本地合成密码，实际运行上述 API 与 CLI 的备份恢复路径，不调用模型。具体结果查任务报告的命令、退出码和测试数；这类工程验收不使 G4 通过。
