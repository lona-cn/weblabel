# 主Agent派工模板

发送时填写下面字段；它们是模板字段，不是运行证据。

任务：<TASK_ID>，读取 tasks/<TASK_ID>.md。
base_commit：<已集成实际SHA>。
contract_hash：<docs/contracts.md + testing-contracts.md实际hash>。
工作区：<实际隔离工作区/受限cwd>。
owner：<TASKS.json中的角色>。
前置完成证据：<依赖任务commit与报告路径>。
允许修改：<此任务文件范围，不含主Agent独占共享入口>。
互斥域：<locks>，其他在途任务：<任务ID及目录>。
需要先读：AGENTS、architecture、任务卡、相关C章节、testing-contracts。

先添加任务卡的失败测试，再实现最小功能；返回真实测试日志和结构化结果。不要更改公共contract/manifest/lockfiles/router导航；需要时提供integration.patch给我。不要递归派工。没有凭证/真实GPU不伪造结果。发现上游缺陷时给最小复现和受影响task，不能重写整个项目。

我会在你返回后进行独立审查和集成；你不能修改STATUS为done。
