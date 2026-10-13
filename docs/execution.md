# omp 多 Agent 执行规程

## 1. 执行身份与上下文

供负责派工和集成的维护者使用。omp 指 oh-my-pi，只用于开发；产品用户不需要安装它。主会话负责调度和集成，子 Agent 不默认拥有此前聊天。

派工时给齐任务卡、契约章节、输入版本、可写目录、禁区、验收命令和上游 evidence，避免工作者按猜测补上下文。

技术决策以 architecture.md 为准，不重开泛化市场调研。遇到实际不兼容时，用最小 ADR 说明替代方案、证据和影响。账号或硬件缺失应如实阻塞相关验收；独立任务可以继续，测试结果不能伪造。

## 2. 并发和隔离

默认最多 3 个写代码子 Agent + 1 个只读 reviewer，主 Agent 自己不与子 Agent并发修改同一文件。子 Agent 禁止递归派工。文件不重叠只是必要条件，所有 depends_on 已 done 且 commit 落地才可启动。

omp 当前文档指出默认共享 checkout；因此 T00 必须先核对实际版本的隔离配置，再启动并行写任务。T00 当时记录 .omp/config.yml 的 task.maxConcurrency=4（3写+1只读）、maxRecursionDepth=1、Isolation=auto、merge=patch；当前执行应核对有效配置和实际版本，不因历史记录恢复用户已删除的配置。

保留配置支持的自动应用机制，但自动应用不等于验收通过。原生工具返回 patch/workspace 标识时将其保存到任务报告。[S1]

每个 wave：选择依赖已完成且 locks 不相交的最多 3 个任务 → 隔离派工 → 等所有写任务返回 → 审核实际 diff → 主 Agent 单独复跑测试 → 逐任务按文件范围提交 → 更新状态 → 才进入下一 wave。执行期间不得把临时已应用、未审核修改当作下一任务的基线。

不要假设有 `omp --parallel`、`omp --agents 4`、`omp --isolation` 等参数。通过当前工具 schema 和 `/settings` 使用真实能力。若配置尚未启用，主 Agent 先串行推进 T00；需要用户更改设置时只请求这一动作，同时允许无冲突的串行任务继续。

原生隔离不可用时，主 Agent 在指定项目根内创建 `target/worktrees/<任务或用途>` 和 `task/Txx` 分支，再从该工作区启动独立会话。使用前记录所属仓库、实际路径、HEAD 和用途；符号链接或 junction 的实际落点也必须在允许范围内。项目外目录不能作为默认备选：确有需要，先说明准确路径、用途、保留内容和清理方式，取得用户对该路径与用途的明确授权。工作者只提交自己允许修改的内容，主 Agent 审查并集成。无法可靠设置子会话 cwd 或确认隔离时，就串行工作，不冒险共用目录并行写。

Git 用户身份缺失不能擅自填写用户名/email。先保留生成产物并记录 git_identity blocker；用户补配置后继续。禁止 reset --hard、clean -fd、强推、清空项目或覆盖用户已有文件。

## 3. 文件锁和共享入口

机器图在 TASKS.json，状态在 STATUS.json。`locks` 是逻辑互斥域，不只是路径；相同域不可并发。以下内容只由主 Agent 集成时修改：根 package.json/Cargo.toml、所有 lockfiles、workspace 设置、统一测试脚本注册、生成 contracts、migration 序号、路由装配文件与全局导航入口。

任务可以提交这些共享文件的补丁建议，不能并行写。T00/T01 是串行初始化例外。每个子 Agent 可以写自己的 reports/Txx/*，不能更新 STATUS.json 或其他任务报告。`reports/index.md` 由主 Agent维护。

状态按 pending → running → review → done 流转。失败记 failed，外部条件缺失记 blocked。只有依赖已 done、测试有真实输出、review 没有未解决阻断且 commit 已集成，才能标 done。

provider 只有源码和 mock 测试时仍是 implemented/mock_only，不能标 live_passed。

## 4. 每个任务的操作循环

- 读取 AGENTS.md、任务卡、architecture.md 中相关章节、contracts.md 的相关 C 编号。
- 核对上游文件确实存在、HEAD/契约 hash 与派工一致。
- 先实现任务卡里的失败测试/输入向量，运行指定命令确认失败是功能缺失而非无测试或环境坏了。
- 最小实现，运行窄测试，再运行 lint/typecheck/contract gate；不得降低断言来过关。
- 保存命令、退出码、测试数量、环境、真实截图/trace（需要时）到 reports/Txx/。
- 提交结构化结果供主 Agent 审核；未集成不得标 done。

对外部接口先用脱敏协议 fixture 和 fake process 做错误路径测试，再进行用户授权的真实 smoke；两种证据分开。不得把固定 JSON、console.log、“页面能开”、mock 图层或未启用真实 wgpu 当成功能完成。

## 5. 任务返回格式

```json
{
  "task_id": "T03",
  "status": "review",
  "base_commit": "实际 SHA",
  "artifact_kind": "native_patch",
  "artifact_ref": "实际 patch 或分支位置",
  "changed_files": ["crates/geometry/src/viewport.rs"],
  "commands": [{"argv": ["cargo","test","-p","geometry","--test","T03_geometry","--locked"],"exit_code": 0,"tests_passed": 8,"log_path": "reports/T03/tests.log"}],
  "contract_changes": [],
  "known_limits": [],
  "external_blockers": []
}
```

示例 SHA 和路径只说明格式，提交结果时必须换成实际值。失败也要列出已完成文件与真实错误，不能只报成功部分。

## 6. Reviewer 的两道门

先做规格审查：能否对应需求、契约和任务卡的每个验收项；再做质量/安全审查：竞态、边界、错误处理、权限、性能路径和可维护性。reviewer 默认 read/grep/glob，不授予 shell 或写文件；测试由主 Agent复跑，reviewer检查日志与实现，避免“只读 reviewer”实际拥有任意 shell 写权限。

最多 2 轮局部修订仍失败则主 Agent缩小问题并接管/拆分，不允许循环重写框架。共享契约变更必须说明所有受影响消费者，更新契约、golden fixtures 和双方测试后再继续。

## 7. 恢复与停止条件

会话恢复先读取 STATUS.json、reports/index.md 和 git status/log，不按聊天记忆重跑已完成任务。不信任状态文件的 done：抽查对应 commit 和测试证据；丢失证据则改 review，不能直接重复生成整个模块。

没有 ready 任务但存在 blocked 时，总结阻塞依赖与用户所需最小动作。没有凭证、缺真实 GPU、网络无法安装必要依赖、正式运行时无法安全限制，是可记录阻塞；不得改成 skip/pass。用户中断时立即停止派新任务，保存未提交补丁、当前步骤和下一条命令。

本轮只执行到 T35，不自动开始 Mask、视频或云同步。无需每改一个文件都询问是否继续；当前可执行队列完成，或余下任务都受阻且必须由用户完成安全审批时停止。

## 8. 推荐调度而非虚假同时开工

第一轮仅 T00；第二轮 T01 与 T02（锁不同）。随后按 TASKS.json 的 DAG 自动选择。优先打通 T03/T04/T05/T06/T07/T08/T09/T10/T11/T12/T13/T14/T15 的人工纵向链，同时让已就绪的 AI 探针/Host 任务推进。T22/T23 可在隔离 workspace 并行，但共享 native-runtime 锁时应先拆清 profile 文件；默认按 manifest 序列化安全相关修改。

每完成 G1/G2/G3/G4 输出一份 checkpoint，含已可运行命令、截图/trace、功能状态、未验证项，不输出没有证据的进度百分比。
