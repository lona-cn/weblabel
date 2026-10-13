# 主Agent派工模板

发送前填写全部字段。占位符描述需要提供的材料，不是运行证据。

任务：<TASK_ID>，读取 tasks/<TASK_ID>.md。
base_commit：<已集成实际SHA>。
contract_hash：<docs/contracts.md + testing-contracts.md实际hash>。
工作区：<实际隔离工作区/受限cwd>。
owner：<TASKS.json中的角色>。
前置完成证据：<依赖任务commit与报告路径>。
允许修改：<此任务文件范围，不含主Agent独占共享入口>。
互斥域：<locks>，其他在途任务：<任务ID及目录>。
需要先读：AGENTS、architecture、任务卡、相关C章节、testing-contracts。

## 执行要求

先为任务卡要求的行为添加失败测试，再实现最小功能。返回真实测试日志和结构化结果，不以静态说明代替运行证据。

不能修改公共contract、manifest、lockfiles、router或导航。需要这些共享改动时，提供integration.patch交给我集成。不要递归派工。没有凭证或真实GPU时，准确说明阻塞，不能伪造结果。

发现上游缺陷时，提供最小复现和受影响task；不能因此重写整个项目。

## 审查与集成

你返回后，我会独立审查并集成。你不能自行将STATUS改为done。
