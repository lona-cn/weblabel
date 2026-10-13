# WebLabel：执行约束

## 先确认项目和任务

WebLabel 是本地服务加浏览器的图片标注与 AI 审校工作台。先读启动入口、实施计划、架构、共享契约和测试约定，再按 TASKS.json 的 36 项任务执行。已有代码时先核对状态和证据，不把项目重新当成空目录。

原始草案保存在 docs/reference/original-proposal.md。首版包含 VLM 属性审校；Mask、视频和云端不在本轮范围内。

## 怎样协作

主会话是唯一编排和集成者。最多 3 个隔离写入 Agent，加 1 个只读 reviewer；子 Agent 不得递归派工。只有全部依赖已 done、对应 commit 已落地，任务才就绪。并行任务的 locks 不得相交。

根 manifest、lockfile、router、导航、migration 编号、generated contracts 和 STATUS 只由主 Agent 集成。omp 可能默认共享 checkout；T00 要先验证隔离，后续工作也不能凭配置猜测隔离有效。无法确认，就串行执行。

每个任务按这个顺序推进：读任务卡、运行失败测试、最小实现、窄测试、规格与质量审查、主 Agent 复跑、提交、更新状态。派工必须附 task ID、base SHA、契约版本和可写路径。缺账号或真实 GPU 不妨碍独立任务，但不能伪造验证。

## 文件放在哪里，怎样收尾

1. Agent 主动创建的 worktree、源码副本、构建缓存、下载工具链和临时验证文件，默认必须放在项目根目录内。worktree 用 `target/worktrees/<任务或用途>`，构建缓存用 `target/build-cache/<平台或用途>`，临时工具用 `target/tools/<工具与版本>`；长期验收证据仍按报告约定保存。项目根由主 Agent 指定，不能因切换 cwd 或 checkout 重新定义。路径按解析符号链接、junction 等重定向后的实际落点判断；落点在项目外，就必须取得下一条所说的授权。报告约定本身不授权项目外路径。
2. 不得自行使用项目外目录，包括磁盘根下的 cache、相邻 workspace/wt 或系统 Temp。路径短、空间不足、隔离、WSL 可访问或性能考虑都不是授权。确实需要时，先说明准确路径、用途、保留内容和清理方式，取得用户明确授权；授权只限该路径和用途，不得扩展。
3. 可以使用已安装工具和用户已有的共享缓存，但不得擅自改全局缓存配置、迁移或清理共享目录。新建项目专用缓存仍须遵守前两条。工具自动产生系统临时文件，不等于允许 Agent 主动在那里建立长期工作区。共享缓存只能由对应工具按现有配置正常读取、更新；不能用来存项目专用工作区、源码副本、下载工具链或临时验证文件，也不能直接改写其他项目或用户的缓存。
4. 派工必须说明项目根、可写路径和目录边界，子 Agent 同样遵守。隔离工具不能把 worktree 放在允许目录时，先换项目内方案；仍无法确认隔离，就串行执行，不能默许落到项目外。
5. 使用 worktree 前记录所属仓库、路径、HEAD 和用途。结束后整合结果、停止所属进程，并清理不再使用的工作树。清理前检查未提交内容、独有 commit 和独有证据；先在项目内保全、验证，再用 `git worktree remove` 移除。目录已不存在，才清理失效注册。不得覆盖主 checkout、删除用户数据或未经检查强制清理。

## 不可破坏的约定

1. 原图到 canonical 的方向变换必须可追溯。标注只使用 canonical 连续像素 xyxy，不加 1；DPR 不进入持久坐标。
2. Rust Core 是唯一可编辑几何来源，React 只负责投影。pointermove 只预览，一次 pointerup 产生一个 undo。
3. Prediction、Draft、Revision、Review、DatasetVersion 分层保存。旧 AI 结果不能覆盖人工修改；采纳必须通过明确、可撤销的命令。
4. 保存使用 CAS 和幂等：同一 operation、同一 payload 可以重放；同一 operation 换 payload 返回 409。本地保存与远端保存分别确认。
5. 接受或撤销预测时，decision journal 与 revision 必须在同一事务中提交。CAS 不能绕过 lease/fencing。
6. 审核绑定不可变 revision，新版本不继承旧批准。导出先固定版本，再报告信息损失。
7. 空文档不是 negative。外发图像必须同时检查项目策略、真实 scope 和用户授权。
8. wgpu 必须真实运行。没有 WebGPU 时，只提供诊断或只读界面，不能用 Canvas2D 冒充。
9. Codex / Claude 使用最终用户本人的官方运行时。不得收集 token、代理订阅或把 API 伪装成订阅。
10. 所有模型和工具输出都不可信。run-scoped 权限、预算、schema 和 domain 校验必须在服务端执行。

## 安全与真实证据

默认只在 loopback 部署。没有明确授权，不登录账号、不读私人文件、不上传真实业务图、不调用付费模型、不下载大权重、不公开部署、不推远端。禁止删除用户数据，禁止 `git reset --hard`、`git clean -fd`、强推、修改全局安全配置或代填 Git 身份。

外部 model_id、CLI 和依赖可能变化，T00 / T02 要核验官方文档并固定实际版本。不得调用不存在的工具或 CLI flags。mock、静态 JSON、页面能打开、软件 GPU、跳过测试，都不能写成真实支持。

## 怎样报告

子 Agent 只能写自己 reports/Txx/ 下的报告；主 Agent 维护 STATUS.json 和 reports/index.md。每条 done 都要有 actualcommit、测试日志和 review。阻塞要说清最小可执行解法。恢复时先核对状态、Git 和证据，不靠聊天记忆。

T35 完成或没有可执行任务时停止，交付真实结果，不自动扩展范围。
