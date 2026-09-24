# 恢复WebLabel执行

继续本目录的计划，不重新初始化。先读AGENTS.md、PLAN.md、TASKS.json、STATUS.json和reports/index.md，再检查git status/log、上次中断分支/patch、实际测试证据。

done必须能对应已集成commit和report；若证据丢失改review后复核，不盲目重新实现。正在运行但会话已终止的任务核对未提交改动，只恢复该任务剩余步骤。不得reset/clean/覆盖用户文件。

依DAG和locks继续派工，最大3写+1只读review；隔离能力仍需确认。主Agent独占共享入口。外部blocked任务保留原因，先做不依赖它们的ready任务。

完成全部可执行工作或安全前置阻塞时，提交真实进度和最小剩余动作；禁止生成新的平行计划替代已有任务。
