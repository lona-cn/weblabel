# ADR 0002: 服务端固定 AI 输入、授权实际 scope 并原子入队

- Status: Accepted design; implementation and verification recorded by T25, not asserted by this ADR.
- Decision owner: WebLabel 主会话
- Reader/action: 维护者据此接入一个 provider，而不建立独立媒体读取或正式标注写入通道。

## 问题

浏览器自行计算的 fingerprint 不能证明持久 profile 配置、媒体或实际授权范围未变。consent 意图不能替代项目策略。先授权提交、再入队会留下授权与作业之间的竞态；仅称 CLI 在本地运行也不能证明图像或对象元数据不会外发。

## 决定

1. 项目 `allow_external_processing` 服务端持久化，既有/新建项目默认 false。仅实际项目 admin 可更新；读取要求项目成员。API provider 与官方 Codex/Claude runtime 均视为可能外发，不因没有图像或对象 grant 绕过策略。检测器权重下载授权保持独立。
2. flush 成功后通过 `POST /api/ai/previews` 提交 `{request: StartRunRequest, grants: {allow_image, allow_object_context, preview_crop}}`。请求中的旧 fingerprint 不是信任凭据。服务端验证身份、项目/媒体/revision/ontology/object pins，固定实际 profile 配置与 scope，计算指纹并返回 `{preview_id, input_fingerprint, request, profile, grants, expires_at}`。返回的 request 已写入权威指纹且 consent_id 为 null；UI展示实际 provider/model 与授权范围后才允许确认。
3. input fingerprint 包括固定媒体内容/版本、annotation/ontology、有效对象范围与哈希、intent/prompt、实际区域与参数及私有 profile 配置版本摘要；不包括 operation_id、consent_id、preview_id、轮询游标、pan/zoom 或其他显示状态。私有 config/secret_ref 不返回浏览器。预览不可修改，10分钟到期。
4. `POST /api/ai/consents` 接受 `{preview_id}`，只确认该 actor 的未过期固定预览。原仅含 profile/fingerprint 的创建接口 clean cutover，迁移既有意图保留但不可据其启动真实 run。服务端重验配置、媒体、成员与政策，存入绑定 preview 的 consent；不读取图像或触发 provider。
5. `POST /api/ai/runs` 保持 StartRunRequest DTO。同一数据库写事务内重新验证固定预览、consent、actor、实际 pins/profile/policy/scope，写 idempotency、job、model_run 和 model_run_authorization。失败没有孤儿作业或可执行运行；相同 operation/payload 重放，异 payload 409。
6. dispatch 和每次 RuntimeContext/MCP 读取都检查实际 run、成员、policy、固定 profile 和批准 scope。无 image grant 不读图；crop-only 不升为全图，任何读取的实际像素范围不得扩大已批准范围。无对象 grant 不泄露对象；只返回明确批准范围的固定对象视图。取消/到期后 token 失效，候选提交不能绕过 run-scoped 校验。
7. 所有真实 provider 通过现有监督进程与 ProviderAdapter/RuntimeContext 接口运行。父进程固定可执行程序、argv 和私有通道；浏览器不能指定执行路径、环境、任意 URL 或文件。官方 runtime 由用户本人授权，不读取/收集订阅 token；API key 使用独立安全来源。
8. 模型输出先经大小、schema/domain、intent/allowed_ops 和来源上下文校验进入 Prediction/SuggestionSet。audit_attributes 不创建/删除对象或修改 bbox。accept/revert 仍只通过保存事务及 Rust editor 显式可撤销命令修改 annotation。
9. 取消、超时、未知模型、额度与协议错误不自动重发可能计费的请求；进程树必须回收。费用未知保持 unknown。明确工程 mock 仅证明 G2，不使真实 profile 连接 fake process，也不升级 T32/G4。

## 替代方案与代价

- 拒绝：信任前端 fingerprint 或复用未绑定实际 scope 的旧意图。无法证明 profile 配置与实际数据一致。
- 拒绝：每个 provider 自建权限/候选写入通道。会绕过统一范围、预算和事务。
- 选择：增加一次服务端 preview roundtrip 与持久固定记录。相较给公共 profile 暴露私有配置或让客户端重建服务端哈希，边界更清晰。
- 预览/授权表只增加记录，迁移不删除用户历史。真正的账户/权重/付费图像实测仍需要额外授权，工程接线不是外部支持证据。
