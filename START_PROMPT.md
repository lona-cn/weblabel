# 给 omp 主会话的执行指令

你现在是WebLabel项目的唯一主编排/集成Agent。当前目录已放入执行包，尚未实现应用。用户已要求按此计划执行，不再重复询问框架、范围或是否逐步继续。

先读AGENTS.md、START_HERE.md、PLAN.md、TASKS.json、STATUS.json、docs/architecture.md、docs/contracts.md、docs/testing-contracts.md、docs/execution.md、docs/verification.md。原设计可查docs/reference/original-proposal.md；有明确差异时以architecture的“相对原草案变更”为v0.1执行决定。

首先运行只读检查 `node tools/check-plan.mjs`（若没有Node，先记录并安装/请求必要环境），检查git状态和实际omp工具。T00由你串行完成：建立可构建workspace、固定版本、实现统一测试命令，核验原生隔离，建立首次有效commit。

随后依TASKS.json选择所有前置已done且已commit的就绪任务。最多3个写Agent+1个只读reviewer，不递归；共享目录默认不允许并行，确认native isolation或独立worktree后才能开始。如果实际omp不支持隔离/自定义agent，使用同样角色串行执行，不发明CLI参数或模拟“已经并行”。

自定义角色在.omp/agents/。不要把“使用哪个模型”硬编码为产品模型：开发agent模型继承本会话可用配置；产品Codex/Claude/Luna/MiMo由独立任务实现。

派工消息使用prompts/TASK_PACKET.md；结束后按prompts/REVIEW.md调用只读审查。所有事实从实际文件/命令/日志确认，不信agent一句“完成”。主Agent按任务实际文件范围集成commit并维护STATUS。

优先打通T15人工闭环，继续T25差异化AI闭环，再完成可靠性、真实GPU/模型、打包和T35审查。不要停在展示页面或mock provider，不要过早建设Mask/视频/推理引擎/云SaaS。

付费API调用、订阅登录、真实业务图外发、权重下载需要明确授权；未授权记录blocked并推进独立任务。缺账号/GPU时可以有limited preview，不得把mock测试记为G4。个人文件/secret不进入上下文、日志或Git。

运行到所有可执行任务完成、必须的用户安全动作阻塞、或者T35完成。结束交付实际运行命令、已通过和未通过关卡、证据路径、已知限制及最小剩余动作。不要重复生成本计划，也不要只输出一份新的计划。
