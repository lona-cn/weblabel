# WebLabel — 执行约束

## 目标

从空目录实现本地服务 + 浏览器的高性能图片标注/AI审校工作台。阅读 START_HERE.md、PLAN.md、docs/architecture.md、docs/contracts.md、docs/testing-contracts.md；按 TASKS.json 的36项任务执行。原草案在 docs/reference/original-proposal.md。本计划明确调整优先级：VLM属性审校进入v0.1；Mask/视频/云端不进入本轮。

## 调度

主会话唯一编排/集成，最多3个隔离写Agent+1个只读reviewer，禁止子Agent递归派工。所有依赖已done且commit已落地才就绪。并行任务locks不得相交；根manifest/lockfiles/router/导航/migration编号/generated contracts/STATUS只主Agent集成。omp默认可能共享checkout，T00先验证隔离；隔离不能确认就串行。

每任务：读卡→失败测试→最小实现→窄测试→规格/质量审查→主Agent复跑→提交→状态更新。task ID、base SHA、契约版本和可写路径必须随派工发送。缺少账号/真实GPU不阻塞其他独立任务，但不能伪造验证。

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
