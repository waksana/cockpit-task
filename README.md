# Task

Task 是 Cockpit 模块：用共同的持久化 Task 记录协作，通过唯一的 `node`
角色组合 System Prompt、Skill 和 HTTP MCP。Task 引用直接在聊天中显示卡片，详情按需读取；
不保存聊天、不自动监工或做依赖调度。默认不发送进度或完成通知；
默认不登记订阅；仅当未来状态会使 Owner 需要作决定、安排后续独立工作等必要行动时，
由 Owner 自行判断并显式登记一次性订阅，不为追踪进度或确认完成而订阅。

每个 session 都是 Task 树的节点：有被指派的 Task 就负责完成它，可亲自完成或在授权范围内
编排子 Task；没有 Task 的根节点委派交付。Owner / Executor 由每条 Task 的事实决定，读取结果以
`actor_role` 标明，卡片以 “As Executor:” / “As Owner:” 前缀说明身份；它们不是 session
的业务身份，也不是可选角色。旧 `owner` / `executor` 角色已删除且无别名。
服务拒绝自我指派、沿祖先链的回环指派，以及执行中节点与他人互相代建 Task。

子 Task 进入 done、blocked 或 cancelled 时，服务自动向其 Owner（父 Task 的 Executor）
每次转换发送一张 `[As Owner: child Task done](task:<uuid>?event=child_done)`（或
`child_blocked` / `child_cancelled`）卡片，无需订阅；同一次转换若已触发订阅则不重复，
父 Task 已结束时不发送。旧的无前缀卡片标签仍可识别。

通用引用为 `[Task](task:<uuid>)`；首次指派由 `task_assign` 仅发送一次
`[As Executor: Task assigned to you](task:<uuid>?event=assigned)`。Owner 明确决定的重要更新
使用 `[As Executor: Task updated](task:<uuid>?event=updated)`，并要求读取、ACK 最新版本。
event 只说明这条消息的原因，不是 Task 状态；卡片仍读取当前数据，普通编辑不发通知。

状态订阅使用独立的 `[As Owner: Task status updated](task:<uuid>?event=status_changed)`，
发送给 Task 的 Owner，不是要求 Executor 读取并 ACK 的更新指令。
登记时若已处于目标状态则明确失败，不创建订阅或补发消息；只有登记后第一次
进入目标状态才触发，不重复订阅、不轮询、不打断 Owner 当前工作。

“A 完成后做 B”时，Owner 立即以 `blocked_by` 创建未指派的 B 并写完整要求，
不必为每个前置 Task 订阅。所有 blocker done 前 `task_assign` / `task_automation_start`
返回 `TASK_NOT_READY`；就绪只发送 `[As Owner: Task ready](task:<uuid>?event=ready)` 给 B 的 Owner，
blocker 取消则发送 `[As Owner: Task blocker cancelled](task:<uuid>?event=blocker_cancelled)`，
不自动改状态、指派或启动。blocker 须同一 Owner、无环、最多 20 个。

默认 Agent Task 由一个 Executor 完整负责，可在内部使用 subagents。要求直接修改 Task，
Executor 在同步点读取并 ACK；执行动态和结果带有实际确认的版本。可在授权范围内
编排子 Task（受深度上限限制），没有改派或任意终态回退。用户明确授权返工时，符合条件的原 Executor 可自行
`task_reopen` 同一 done Agent Task；不重新派单、不自发消息、不更换责任人。
必须为 schema v5 升级后有持久序号的指派，且自该次指派后未承接其他 Task
（后来已完成/取消也不例外）、没有其他未结束 Task。升级前已指派的全部不符合条件，
不以时间戳推断或回填；cancelled 和 automation 不可重开。
重开原子创建并自 ACK 新 revision（正文相同也创建）、进入 in_progress；
历史成果/复盘保留但不代表新要求已交付，完成仍须新 outcome 与显式 retro。
已结束订阅不恢复，不增加通知、UI 重开按钮或轮次状态机。角色协作与工作方法分开：随包提供独立的
[github-coding](skills/github-coding/github-coding/SKILL.md)，指导 Git/GitHub 编码协作；
非编码工作仍使用其自身方法。

Executor 完成交付后、报告 done 前进行轻量复盘：仅记录有实际证据、可行动的自动化
候选、具体慢点/重复卡点或 Skill/MCP 发现、契约和能力验证缺口；区分观察、假设与外部等待，
不编造耗时、不套多段模板。done 同次必须提交新 outcome 与显式 `retro` 文本或 `null`
（无有用发现），普通报告不传 retro。复盘独立于成果和阻塞，不授权改进或扩大范围；
服务不新增通知、派单或完成门槛；Owner 按 Skill 用 `task_retro_handle`
处理有发现的 retro（有子 Task 的 Executor 在自己 done 前，根节点仅在用户问起时）。服务保证提交，不保证思考或文本质量。

Owner 也可为已授权、可信、可重复的已知脚本选择轻量 automation Task；不是把任意工作
转成脚本。先用 `task_script_read` / `task_script_register` 发现或不可变登记，
`task_create` 保存脚本和类型化参数快照，按必要后续行动选择订阅后，再显式
`task_automation_start`。服务持久单队列执行，不创建 Executor、不 ACK、不占 session
任务槽。成功写 done+outcome，失败/中断写 blocked+outcome，不自动重跑。
脚本自动化仅支持 Linux（含 WSL2）；其他平台登记、创建与启动均返回 `AUTOMATION_PLATFORM`
且不写入任何记录。
Linux 进程组终止屏障只由 `task_automation_reconcile` 在内核确认组已不存在后解除；
未回收 zombie 也会保持屏障，须由宿主回收，不手改数据库绕过。
取消不回滚副作用。详见[轻量自动化](docs/task-automation.md)及
[Owner 脚本参考](skills/cockpit-task-tree/cockpit-task-tree/references/automation.md)。

编码流程按是否需要修改并提交仓库文件判断，不按 GitHub 或部署等关键词触发。
纯部署使用现有已验证产物时用 Task，不由本 Skill 强制 Issue/PR/branch/worktree；
项目既有政策、不可变安装目录及独立部署授权仍须遵守，Owner 默认委派职责不变。
混合交付保持一个 Task，Issue/PR 只覆盖必要仓库变更，不另建部署总 Issue。
Owner 说明要求并引用现有 Issue，以目标仓库共享主 checkout 为 cwd 创建 Executor，
不准备或清理 branch/worktree。Executor 视该 checkout 为只读，自行复用或创建 Issue、
从最新主线建立专用 branch/worktree 并记录到 Task，负责开发、验证、独立审阅及授权内的
PR 合并，合并后确认无人使用再清理自己的 worktree/分支并记录结果；不确定时保留并说明。
执行中发现超出范围的变更先问用户，获授权后同样自建环境。
仅未来状态解锁必要且已授权的行动时订阅，不恢复默认通知或轮询。
仅讨论、仅 PR 和非 GitHub 工作保留各自边界；合并不等于部署。
已授权返工默认复用实际保留的 worktree/branch，即使先前 PR 已合并，已删除则新建；
核实项目、分支、归属及无冲突使用者，metadata 不是归属证明，也不扫描无关聊天。
安全 fetch/正常 merge 主线，按需新建后续 PR、独立审阅并在授权内正常合并；
不 force/reset/amend 或丢工作。环境改作他用或有冲突使用者时明确解决阻塞，不接管。
原 Executor 符合条件可继续时 Owner 不建替代 Task；否则按新授权安排适当 Task。

单项 `task_read(view=overview,include=[...])` 可一次选择当前需要的完整内容：
只看状态用 `["context"]`，需判断阻塞/交付时可组合 `["activity","outcome"]`；
retro、definition、automation、cancellation 按目的选取，不默认 read-all。
未选正文不加载，超预算明确报错；省略 include 保持旧视图，历史/日志仍分页。
Executor 开始、恢复与要求同步仍完整读取 execution 并精确 ACK。

Owner 明确选择现有可发现的 Skill/MCP 资源，以 `task_session_create` 新建并准备，
或用 `task_session_prepare` 准备已加载空闲、无未结束 Task 的既有 Executor；
检查分步回执后，由 `task_assign` 最终检查、绑定并发送一次派单；绑定后把默认/自动生成的
Executor 会话标题设为 Task 标题（保留显式设置的名称，失败单独报告，不影响派单）。登记 backlog 不派单，
准备也不发送初始化消息。就绪不等于授权、ACK 或执行，Skill 启用不等于正文已加载。
显式资源准备要求宿主 `resourcePreparationVersion: 1`；省略资源选择的旧创建保持兼容。

**使用与打包：[Task](docs/task-board.md)**。模块需要支持模块角色和宿主
能力接口的 Cockpit；旧版宿主不能仅靠安装这个包获得这些能力。构建、合并不等于安装
或升级，部署须由操作者另行决定。

契约：[产品设计](docs/task-design.md) · [Schema](docs/task-schema.md) ·
[MCP 工具](docs/task-mcp-contract.md) · [角色 Skills](docs/task-tools-skills.md) ·
[宿主接入](docs/task-host-contract.md) · [实现边界](docs/task-implementation.md)。

回归演练：[Owner / Executor 生命周期用例与复跑流程](docs/task-lifecycle-testing.md)，
包含隔离边界、输入、角色分工、故障注入、证据标准，以及生命周期与订阅必要性演练的结果和限制。

## 开发与打包

需要 Node.js 24 或更新版本：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run package:module
```

模块代码位于 `src/task-board/`，卡片位于 `web/task-board/`；
`cockpit.module.json` 是模块入口。归档输出到 `dist/cockpit-task-<version>.tgz`，
供支持所需接口的 Cockpit 装载；Task 不提供独立服务启动命令。

模块 ID、MCP key 和包名均为 `cockpit-task`；唯一角色为 `node`（Node），合并 Skill 为
[cockpit-task-tree](skills/cockpit-task-tree/cockpit-task-tree/SKILL.md)，
按执行、委派、读取、写入、链接、重要更新和自动化分类组织参考。
节点同时通过现有装载机制发现 `github-coding` 工作 Skill，
选择角色不等于每次都加载正文。准备包版本为 `0.1.13`；不同内容使用新版本，
不覆盖同版本的既有安装。源码合并、CI 归档均不会自动升级线上。
持久化仅使用宿主提供的模块目录，不自动导入其他数据库或修改既有安装。
本次准备打包 #71/#72/#74（经 #75 合入）的按 Task 层级委派与 tree-node 模型：新增
schema v7（`tasks.parent_task_id`、`tasks.depth`，最多 3 层，超出返回
`DELEGATION_DEPTH_EXCEEDED`；新表 `child_notices`），以唯一 `node` 角色和合并 Skill
`cockpit-task-tree` 取代 Owner/Executor 角色。schema v7 只能向前滚动：已安装的
`0.1.12` 不能打开 v7；切回旧包不等于数据库回退。0.1.13 删除 `owner`/`executor`
角色且不提供别名；宿主冷启动到 0.1.13 前，操作者须备份并迁移每个 session 的
`$COCKPIT_HOME/session-roles/<sessionId>.json`，把 `cockpit-task/owner` 和
`cockpit-task/executor` 替换为去重后的 `cockpit-task/node`，保留其他角色；回滚到 0.1.12
时应同时恢复该备份。
`0.1.12` 打包 `0.1.11` 之后已合并的原生 Task 依赖和 `github-coding` Skill 更新（#59、#61、#63、#65）。
Task 依赖新增 schema v6（`task_dependencies`、`dependency_notices`），v5→v6
迁移只新建表。schema v6 只能向前滚动：已安装的 `0.1.11` 不能打开 v6；
切回旧包不等于数据库回退，不得用历史备份覆盖实时数据。部署前应在隔离的一致副本上验证迁移。
`0.1.11` 在 `0.1.10` 基础上包含 Owner 顺序订阅跟进（#53）和 Executor 会话标题（#55），
不新增 schema 迁移。升级为 schema v5 时不回填历史指派；升级前已派单 Task 保持可读但均不可重开。
