# Security model

供本机操作者和扩展 WebLabel 的工程师维护授权边界。先确定请求凭什么取得权限，再检查拒绝行为；本地工程测试、官方运行时和真实模型的证据不能混用。

## Scope and trust

WebLabel 默认只部署在 loopback。本地管理员可以配置 execution profile，并明确批准精确的 provider base。这个批准不授权重定向、任意工具、额外文件系统根或无关项目数据。

图片及其中的文字、提示词、模型响应、工具参数、归档、URL 和浏览器请求头都是不可信输入。模型输出只是建议，不能批准人工审核，也不能因为 provider 请求就成为正式标注。浏览器 session 与 run capability 是不同权限。

合成测试使用独立数据库、图片、临时文件和 loopback 服务。通过这些测试不证明付费账号、官方 CLI 沙箱、硬件 WebGPU 或生产模型质量。

## HTTP and session boundary

| 边界 | 必须具备的权限 | 拒绝方式 |
|---|---|---|
| 浏览器 API | 精确配置的 Host；要求时的允许 Origin；有效 session | 攻击者控制的 Host/Origin 在受保护操作前拒绝。 |
| session 认证的写入 | 有效 session 和匹配 CSRF | 缺失或无效 CSRF 拒绝，包括带有效 cookie 的登录。 |
| 无效/过期 cookie 后登录 | 新的 username/password、有效 Host/Origin | session 查询返回 401 并使旧 cookie 过期。可用新凭证恢复，无须旧 CSRF；错误凭证仍拒绝。 |
| session 存储故障 | 正常的认证存储 | 存储故障报错，不能当 session 不存在而放行。 |
| run 工具 | 精确 Host/Origin 策略及未过期、未撤销的 run-scoped bearer capability | capability 不是浏览器 session，不能批准人工审核，也不能访问其他 run/project。 |

旧 cookie 恢复例外只适用于没有有效 principal 的情况，不放宽 Host/Origin 校验或有效 session 的 CSRF 规则。过期 cookie 仍使用正常认证的 strict、HttpOnly 边界。

工具参数不能指定任意 project/run 身份。服务端从 capability 与持久 run context 取得身份；取消立即撤销后续工具访问。查询他人的 run/media 不能泄露受保护项目数据。

## Explicit external-processing approval

外部处理需要项目策略允许、展示实际输入的预览，以及用户对该预览的 consent。批准绑定标注内容和配置的 execution profile；内容版本、profile 或 model 变化后必须重新预览和授权。旧批准不能把变化后的工作入队。

测试 profile 修改时，使用普通持久 synthetic profile。内建保留 mock profile 固定不变，不能冒充可配置 provider；生产 profile 也不能把 mock 输出显示成已验证的 provider 输出。

## Files, imports and exports

文件 grant 仅指向批准 staging root 下的批准文件。解析时检查 realpath，而不只检查表面路径；junction/symlink 不能把权限扩到外部文件。拒绝 traversal、绝对路径、Windows drive-relative 路径和 UNC。每次使用 grant 重验 project/run 绑定，撤销后不得访问。

归档提取还要拒绝 traversal、绝对路径、symlink entry、不区分大小写的名称冲突，以及资源预算超限。测试需包含能成功处理的安全归档，不能只证明所有归档都会失败。非法标注导入后，annotation head 和导入事务状态都必须不变。

图像 header 不是可信的分配指令。包括极端声明尺寸在内的解码失败，必须使导入 job 失败，不留下成功 asset。

数据集导出读取固定、人工批准的 revision。归档成员必须是该 revision 与对应批准图片，不包含私有 profile 凭证或相邻文件。测试检查实际下载 ZIP 和解码成员，不能只看响应 flag。

## Provider transport and credentials

管理员批准绑定精确 provider base。未批准的 loopback、metadata、其他域及非 HTTP 端点在联网前拒绝。普通请求和流式请求的任何重定向都拒绝；Authorization 只属于首次批准请求，不能转发给重定向目标。

测试可以将 metadata 地址写成重定向目标，但不能真的联系它。安全 guard 要观察生产请求的 `redirect: manual`，不能自行覆盖该选项而掩盖回归。

解析后的凭证只作私有 runtime 输入。provider 可能在错误里直接回显没有可识别前缀的 key。公开 failed event 前，除通用 header/token/key 模式外，还要脱敏精确凭证值；保留失败分类和非秘密诊断上下文。不能只靠 `sk-` 前缀或 `Bearer` 标签。

每个公开 provider event 都要脱敏，不只处理终态异常。工具名和 call ID 由上游控制，参数校验前就可能泄露凭证；message、嵌套 data 的键和值都须按精确值保护。脱敏不能放行禁用工具或伪造成功。OpenAI、Anthropic、MiMo 保留真实失败 code 和已观察 usage；尚无 usage 的失败仍是 unknown（`null`），不是 0。

生产扫描以新 synthetic credential sentinel 作为私有环境值，构建 API executable、浏览器 JavaScript/CSS/WASM、Agent Host bundle 与 sourcemap，再扫描实际产物字节和构建/runtime 日志。这只能证明本次 sentinel 没有嵌入，不能宣称能发现所有凭证格式。

## Injection and final tool permissions

本地 hostile-provider 场景发送真实 PNG，其中写有读取 `.secret`、运行 shell、批准标注的指令，提示词也包含同样文本。synthetic loopback provider 经合法流式响应返回各禁用工具调用；真实 Host 拒绝，另用直接请求核对 API 的最终拒绝。

即使模型完全服从注入指令，工具允许列表和参数 schema 仍是权限依据。未知工具拒绝；允许的读图工具夹带路径也拒绝。bearer capability 不能调用人工审核端点。被拒调用不能创建 prediction、改变标注、执行 shell 或暴露凭证。MCP 要再次校验参数，并传递权威的过期 token 拒绝结果。

## Verification channels and release gate

完整工程攻击验收入口是 `pnpm test:task T29`。保留未过滤日志、退出码和收集数量；过滤后的复现不能替代完整关卡。还要执行受影响类型、格式、生成契约检查及生产产物扫描。

Codex 活动渠道现已退役，以 `PROVIDER_RETIRED` 拒绝，不提供执行兼容路径；原 `UNSUPPORTED_RUNTIME` 拒绝及 T29 记录属于历史工程证据，不证明官方 runtime 受支持。T29 不使用真实 Codex/Claude 账号、付费模型或外部 live 端点。本轮按用户要求不执行安全专题，结果是 skipped_by_user/not_verified，不晋升 T32/G4。通用权限、外发政策撤销与历史 run 约束不因退役删除。

分别报告 mock/local synthetic transport、in-memory MCP、software GPU、hardware GPU 和 live 模型。T29 的内存 MCP 测试仍通过真实 HTTP 授权边界，但不是官方 CLI 证据。Windows junction 和归档 symlink entry 拒绝已在本地执行；其他平台的 OS-native symlink 要在对应平台另跑。
