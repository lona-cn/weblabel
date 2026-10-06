# 一致性备份与恢复

本指南面向有权管理本机业务数据的操作者。备份是**包含全部本地项目业务数据**的管理操作，不是某个成员的项目导出；仅向可信操作者提供本地文件访问权限。项目成员交付应使用鉴权快照导出。

## 创建备份

```powershell
node scripts/backup.mjs --data-dir "data" --backup-dir "backups/2026-10-06 中文 备份"
```

`--backup-dir` 必须不存在，且不能位于源数据目录内部。不复制源目录整体，也不复制裸主 DB 忽略 WAL。固定 Node 24.15.0 的 **SQLite backup API** 从源 SQLite 连接生成事务一致的数据库快照，可以在 API 正常运行且 WAL 有提交时执行。源业务 DB 不被 scrub/修改。对象在快照取得后根据该 DB 的媒体/导出引用收集；不可变对象的存在和 SHA256 验证完成后才发布 `backup.json`。源不存在或 hash 不符会非零退出，不生成“成功”的清单。

备份内容只有：

- scrubbed `api.sqlite`；integrity_check 和 foreign_key_check 必须通过。
- DB 引用的不可变媒体与导出对象（不是临时文件、孤儿对象或凭证目录）。
- `backup.json`：格式/版本、UTC 时间、实际 schema_migrations 已应用版本、完整业务 schema hash、认证处置、每个对象/数据库的 SHA256 和字节数。当前 API 使用自有迁移版本表，不存在 SQLx checksum 表；不伪造该字段。

每个输出目录独占创建。失败会删除本次命令自己创建的未完成备份（可能还含原始认证页）；不会删除源业务数据或已有备份。备份 DB 用 secure_delete、VACUUM 和 WAL checkpoint 移除被删除认证数据的旧页。备份仍包含业务图像、规范、提示词、历史审计等敏感业务信息，**没有加密或数字签名**，必须自行设置目录 ACL、加密磁盘和保管策略。Hash 能发现损坏，不证明备份作者可信。

## 不搬运认证

保留用户 ID、用户名与审核/创建身份引用，保留标注历史、媒体、快照和审核关系；不把过去审计归给新用户。

移除 session/CSRF、全部旧 password_hash、model profile 私有 `config_json` 和 `secret_ref`，清空外发 preview/consent/run authorization。已知 provider 配置凭证值在持久化可变 JSON/提示词/日志字段中再次出现时脱敏。若该值出现在不可变标注、规范、导入或 snapshot 正文中，命令以 `credential_in_immutable_business_data` 拒绝并删除本次不完整输出，而不是悄悄改写正文使业务 hash 失效；源数据不变。官方 CLI 的 home、OAuth/API key 文件、环境、私有 Host 配置从未被枚举或复制。用户自己放在业务图像/属性/自由文本中的未知秘密不是自动识别承诺，分享前应自行审查。

排队/运行中的作业变为 interrupted，模型调用不会恢复后自动继续；活跃任务 holder/expiry 清空，历史 fencing token 和审计身份保留。模型 profile 重新进入 needs_configuration/not_run。备份不包含浏览器尚未同步的 IndexedDB 草稿；先 flush 保存，或单独导出本地草稿救援包。

## 恢复到全新目录

保持旧目录不动，选择**完全不存在**的新目录，其父目录必须已存在：

```powershell
node scripts/restore.mjs --backup-dir "backups/2026-10-06 中文 备份" --data-dir "data-restored"
node scripts/start-local.mjs --build-dir "target/local-release" --data-dir "data-restored"
```

只接受当前发行的精确 schema/迁移，先检查清单、每个文件长度/hash、SQLite 完整性与外键、实际 schema 和当前迁移重建的 schema、实际已应用版本清单、对象引用闭包和认证已清空，全部成功才独占创建新目标。schema SQL 仅将 CRLF 规范为 LF，不放宽字段/约束/trigger 比较。版本不兼容应先使用对应源码发行或另做受审查迁移；没有“忽略 schema”开关。

`--migrations-dir` 可指向可信发行中的 migrations；不要从不可信备份接受替代迁移。已有目录（包括空目录、正在使用的目录）一律拒绝，没有 overwrite、reset 或隐式清空。复制失败的本次新目录保留以便检查，缺少完成标记，不能当恢复成功；选择另一个新目录重试。

恢复写入 `restore.json` 完成标记，启动器验证其格式/认证处置，并检查已有用户的密码均为空、session 为零，才设置一次性恢复认证模式。API 再在兑换事务内复核，显式 flag 也不能重置有正常密码的数据库。

在普通登录页输入终端的一次性启动码，并选择新密码即可。服务新建 **`restore-admin-<新 UUID>`** 管理员，授予全部已恢复项目 admin membership，返回新 session/CSRF；旧用户 ID 留作审计，但旧密码失效。记录界面显示/接口返回的实际用户名以供以后密码登录。恢复不是复制旧管理员身份，业务仍可由新授权本地身份访问。若备份为空用户，新库沿用正常 `local-admin` bootstrap。

## 恢复演练

1. 启动新目录并用新本地认证登录，确认旧密码/旧 session 不可用。
2. 按不可变 revision ID 读取历史对象与 created_by，比较原值。
3. 打开 canonical 媒体，比较实际内容 hash。
4. 从旧 snapshot ID 创建原生导出并鉴权下载，核对固定 manifest hash/旧审核人；新 head 不应改变快照。
5. Ctrl+C 停止，确认锁消失，再运行 SQLite 完整性检查。

T33 自动验收实际运行以上 API 路径与 CLI 备份/恢复，使用程序生成的测试媒体/本地合成密码，不调用模型；结果以任务报告的命令、exit 和测试数为准，不升级 G4。
