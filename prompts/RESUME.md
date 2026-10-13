# 恢复WebLabel执行

继续本目录已有计划，不重新初始化，也不另建平行计划。先读AGENTS.md、PLAN.md、TASKS.json、STATUS.json和reports/index.md，再检查git status/log、上次中断的分支或patch，以及实际测试证据。

## 确认可恢复的状态

done必须对应已集成commit和report。证据丢失时先改为review并复核，不盲目重新实现。会话已终止但任务仍显示运行时，先核对未提交改动，只恢复该任务剩余步骤。不得reset、clean或覆盖用户文件。

## 继续派工

按DAG和locks选择任务，最多3个写任务加1个只读review。继续派工前仍需确认隔离能力。共享入口由主Agent独占。

外部blocked任务保留具体原因，先执行不依赖这些阻塞的ready任务。

全部可执行工作完成，或遇到安全前置阻塞时，提交真实进度和下一步最小动作。禁止用新计划替代已有任务。
