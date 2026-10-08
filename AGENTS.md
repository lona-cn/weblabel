# WebLabel — 执行约束

## 目标

从空目录实现本地服务 + 浏览器的高性能图片标注/AI审校工作台。阅读 START_HERE.md、PLAN.md、docs/architecture.md、docs/contracts.md、docs/testing-contracts.md；按 TASKS.json 的36项任务执行。原草案在 docs/reference/original-proposal.md。本计划明确调整优先级：VLM属性审校进入v0.1；Mask/视频/云端不进入本轮。

## 调度

主会话唯一编排/集成，最多3个隔离写Agent+1个只读reviewer，禁止子Agent递归派工。所有依赖已done且commit已落地才就绪。并行任务locks不得相交；根manifest/lockfiles/router/导航/migration编号/generated contracts/STATUS只主Agent集成。omp默认可能共享checkout，T00先验证隔离；隔离不能确认就串行。

每任务：读卡→失败测试→最小实现→窄测试→规格/质量审查→主Agent复跑→提交→状态更新。task ID、base SHA、契约版本和可写路径必须随派工发送。缺少账号/真实GPU不阻塞其他独立任务，但不能伪造验证。

## 目录边界与收尾

1. 所有Agent主动创建的worktree、源码副本、构建缓存、下载的工具链和临时验证文件，默认必须位于项目根目录内。worktree使用 `target/worktrees/<任务或用途>`，构建缓存使用 `target/build-cache/<平台或用途>`，临时工具使用 `target/tools/<工具与版本>`；长期验收证据继续按报告约定保存。 本任务的项目根目录由主Agent明确指定，子Agent不得因切换cwd或checkout重新定义；允许目录按解析符号链接、junction等重定向后的实际路径判定，实际落点位于项目外的须按第2条授权。报告约定不豁免目录边界，不能仅凭既有报告约定推定项目外证据路径已获授权。
2. 禁止自行选用项目外目录，包括磁盘根目录下的cache、相邻workspace/wt及系统Temp。路径短、磁盘空间不足、并行隔离、WSL可访问或性能考虑都不构成授权。确需项目外目录时，必须先说明准确路径、用途、保留内容和清理方式，并取得用户明确授权；授权仅限该路径和用途，不得扩展。
3. 可以使用已安装的工具和用户已有的共享缓存，但不得擅自更改全局缓存配置、迁移或清理共享目录；新建项目专用缓存仍须遵守上述边界。工具自动产生的系统临时文件不等于允许Agent主动在那里建立长期工作区。 共享缓存仅供对应工具正常读取及按现有配置更新，不得借其存放项目专用工作区、源码副本、下载工具链或临时验证文件，也不得直接改写其他项目或用户的缓存内容。
4. 派工必须给出项目根目录、可写路径与目录边界，子Agent同样遵守。若隔离工具无法将worktree建在允许的目录内，先改用项目内隔离方案；仍无法确认隔离则串行，不得默许落到项目外。
5. 使用前记录worktree所属仓库、路径、HEAD和用途；任务结束后整合结果、停止所属进程并清理不再使用的worktree。清理前核查未提交内容、独有commit和独有证据；先在项目内保全并验证，再用git worktree remove移除，目录已不存在的才清理失效注册。禁止覆盖主checkout、删除用户数据或未经核查强制清理。

## 不变量

1. 原图→canonical方向变换可追溯；标注只用canonical连续像素xyxy，不+1，DPR不进入持久坐标。
2. Rust Core唯一可编辑几何；React仅投影；pointermove只预览，一次pointerup一个undo。
3. Prediction、Draft、Revision、Review、DatasetVersion分层；旧AI结果不覆盖人；接受走显式可撤销命令。
4. 保存CAS+幂等；相同operation相同payload重放，不同payload409；本地与远端保存各自确认。
5. 接受/撤销预测的decision journal与revision同一事务；lease/fencing不能被CAS绕过。
6. 审核绑定不可变revision；新版本不继承旧批准；导出先固定版本且报告信息损失。
7. 空文档不等于negative；外发图像必须检查项目策略/真实scope/用户授权。
8. wgpu必须真实运行；无WebGPU只诊断/只读，不用Canvas2D假替代。
9. Codex/Claude使用最终用户本人官方运行时；不收集token、不代理订阅、不伪装API为订阅。
10. 所有模型/工具输出不可信；run-scoped权限、预算和schema/domain校验在服务端执行。

## 安全和真实性

仅loopback默认部署。未明确授权，不登录账号、不读取私人文件、不上传真实业务图、不调用付费模型、不下载大权重、不公开部署、不推远端。禁止删除用户数据、git reset --hard/clean -fd/强推/改全局安全配置/代填Git身份。

外部model_id/CLI/依赖可能变化；T00/T02核验官方文档并固定实际版本。不会调用不存在的工具/CLI flags。不要把mock、静态JSON、页面能打开、软件GPU或跳过测试写成真实支持。

## 报告

子Agent只写自己reports/Txx/；主Agent维护STATUS.json和reports/index.md。每条done有actualcommit、测试日志和review。阻塞记录可执行的最小解法。恢复先读状态+git+证据，不靠聊天记忆。完成T35或无可执行任务时停止，交付真实结果；不得自动扩展范围。
