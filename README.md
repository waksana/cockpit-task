# Task

Task 是 Cockpit 模块：用共同的持久化 Task 记录协作，通过唯一的 `node`
角色组合 System Prompt、Skill 和 HTTP MCP。Task 引用直接在聊天中显示卡片，详情按需读取；
不保存聊天、不自动监工或做依赖调度。默认不发送进度或完成通知；
默认不登记订阅；仅当未来状态会使 编排者需要作决定、安排后续独立工作等必要行动时，
由编排者自行判断并显式登记一次性订阅，不为追踪进度或确认完成而订阅。

每个 session 都是 Task 树的节点：有被指派的 Task 就负责完成它，可亲自完成或在授权范围内
编排Subtask；没有 Task 的根节点委派交付。`orchestrator` / `assignee` 由每条 Task 的事实决定，读取结果以
`actor_role` 标明，卡片使用当前标签；历史 “As Owner:” / “As Executor:” 前缀仅作兼容识别。它们不是 session
的业务身份，也不是可选角色。旧 `owner` / `executor` 角色已删除且无别名。
服务拒绝自我指派、沿祖先链的回环指派，以及执行中节点与他人互相代建 Task。

Subtask 进入 done 或 cancelled 时，服务自动向其 orchestrator（父 Task 的 assignee）
每次转换发送一张 `[Subtask done](task:<uuid>?event=child_done)`（或
`child_cancelled`）卡片，无需订阅；仅当同一次转换已触发订阅且 subscriber 正是该 orchestrator 时才不重复，
父 Task 已结束时不发送。旧的无前缀卡片标签仍可识别。

通用引用为 `[Task](task:<uuid>)`；首次指派由 `task_assign` 仅发送一次
`[Task assigned](task:<uuid>?event=assigned)`。当 assignee 之外的调用者在 ready 时修改完整 description、改变 ready/blocked 边界、重开或取消已指派未结束 Agent Task 时，服务自动用 `mode:"immediate"` 向 assignee 发送固定
`[Task updated](task:<uuid>?event=updated)` 或 `[Task cancelled](task:<uuid>?event=cancelled)`；通知完整正文仅为该链接，处理规则由 `cockpit-task-tree` Skill 统一规定。
event 只说明这条消息的原因，不是 Task 状态；卡片仍读取当前数据。assignee 新增具体
文字前置条件时，服务向 orchestrator 发送一次 `[Task blocked](task:<uuid>?event=blocked)`，
不向 assignee 自我提醒。

状态订阅使用独立的 `[Subscribed Task status changed](task:<uuid>?event=status_changed)`，
发送给实际 subscriber（Web board 用户的卡片路由到 orchestrator），不是要求 assignee 读取并 ACK 的更新指令。
登记时若已处于目标状态则明确失败，不创建订阅或补发消息；只有登记后第一次
进入目标状态才触发，不重复订阅、不轮询、不打断编排者当前工作。操作者自己的订阅只消费、不自我提醒；
同一收件人的取消订阅由即时取消指令覆盖，抑制原因持久保存。阻塞期间普通要求更新和部分解除静默。

“A 完成后做 B”时，编排者立即以 `blocked_by: [{task_id: A}]` 创建未指派的 B 并写完整要求，
不必为每个前置 Task 订阅。所有 blocker done 前 `task_assign` / `task_automation_start`
返回 `TASK_NOT_READY`；未指派依赖方就绪时发送 `[Subtask ready](task:<uuid>?event=ready)` 给其编排者，
blocker 取消则发送 `[Subtask blocker cancelled](task:<uuid>?event=blocker_cancelled)`；已指派依赖方改由 assignee 收到 `[Task updated]`。
这些通知不自动改状态、指派或启动。blocker 可由任意编排者创建；仍拒绝自身、成环、祖先 blocker（`BLOCKER_ANCESTOR`）和已取消 blocker，最多 20 个。
`blocked_by` 也可包含 `{condition}`，用于记录具体尚未满足的外部条件及满足标准。
active 关系决定 `ready`；解除会持久保存，blocker 后续 reopen 不会让旧关系复活。
assignee 可新增 condition，但只有 orchestrator/Web user 可解除或原子替换它。

默认 Agent Task 由一个 assignee 完整负责，可在内部使用 subagents。要求直接修改 Task，
执行者在同步点读取并 ACK；执行动态和结果带有实际确认的版本。可在授权范围内
编排Subtask（受深度上限限制），没有改派或任意终态回退。用户明确授权返工时，orchestrator 或符合条件的原执行者可
`task_reopen` 同一 done Agent Task；不重新派单、不更换责任人。原执行者调用会 auto-ACK 且静默，orchestrator/Web-user 调用会通知 assignee 读取并 ACK。
必须为 schema v5 升级后有持久序号的指派，且自该次指派后未承接其他 Task
（后来已完成/取消也不例外）、没有其他未结束 Task。升级前已指派的全部不符合条件，
不以时间戳推断或回填；cancelled 和 automation 不可重开。
重开原子创建新 revision（正文相同也创建）、进入 in_progress；原执行者自己重开时 auto-ACK 且不发通知，orchestrator/Web-user 重开时不 ACK 并向 assignee 发送 `[Task updated]`。
历史成果/复盘保留但不代表新要求已交付，完成仍须新 outcome 与显式 retro。
已结束订阅不恢复，不增加 UI 重开按钮或轮次状态机。角色协作与工作方法分开：随包提供独立的
[github-coding](skills/github-coding/github-coding/SKILL.md)，指导 Git/GitHub 编码协作；
非编码工作仍使用其自身方法。

执行者完成交付后、报告 done 前进行轻量复盘：仅记录有实际证据、可行动的自动化
候选、具体慢点/重复卡点或 Skill/MCP 发现、契约和能力验证缺口；区分观察、假设与外部等待，
不编造耗时、不套多段模板。done 同次必须提交新 outcome 与显式 `retro` 文本或 `null`
（无有用发现），普通报告不传 retro。复盘独立于成果和阻塞，不授权改进或扩大范围；
服务不新增通知、派单或完成门槛；有 Subtask 的节点在自己 done 前把 Subtask retro 折入自己的 retro。`task_retro_handle` 只是可选记录工具，任何调用者都可用，Skill 不规定使用时机。服务保证提交，不保证思考或文本质量。

编排者也可为已授权、可信、可重复的已知脚本选择轻量 automation Task；不是把任意工作
转成脚本。先用 `task_script_read` / `task_script_register` 发现或不可变登记，
`task_create` 保存脚本和类型化参数快照，按必要后续行动选择订阅后，再显式
`task_automation_start`。服务持久单队列执行，不创建执行者、不 ACK、不占 session
任务槽。成功、失败或中断均表示本次执行结束并写 `done+outcome`，真实结果保留在
`automation.state`、exit/signal/error、日志与 barrier；不自动重跑，不能仅凭 Task `done` 判断成功。
脚本自动化仅支持 Linux（含 WSL2）；其他平台登记、创建与启动均返回 `AUTOMATION_PLATFORM`
且不写入任何记录。
Linux 进程组终止屏障只由 `task_automation_reconcile` 在内核确认组已不存在后解除；
未回收 zombie 也会保持屏障，须由宿主回收，不手改数据库绕过。
取消不回滚副作用。详见[轻量自动化](docs/task-automation.md)及
[编排者脚本参考](skills/cockpit-task-tree/cockpit-task-tree/references/automation.md)。

编码流程按是否需要修改并提交仓库文件判断，不按 GitHub 或部署等关键词触发。
纯部署使用现有已验证产物时用 Task，不由本 Skill 强制 Issue/PR/branch/worktree；
项目既有政策、不可变安装目录及独立部署授权仍须遵守，编排者默认委派职责不变。
混合交付保持一个 Task，Issue/PR 只覆盖必要仓库变更，不另建部署总 Issue。
编排者说明要求并引用现有 Issue，以目标仓库共享主 checkout 为 cwd 创建执行者，
不准备或清理 branch/worktree。执行者视该 checkout 为只读，自行复用或创建 Issue、
从最新主线建立专用 branch/worktree 并记录到 Task，负责开发、验证、独立审阅及授权内的
PR 合并，合并后确认无人使用再清理自己的 worktree/分支并记录结果；不确定时保留并说明。
执行中发现超出范围的变更先问用户，获授权后同样自建环境。
仅未来状态解锁必要且已授权的行动时订阅，不恢复默认通知或轮询。
仅讨论、仅 PR 和非 GitHub 工作保留各自边界；合并不等于部署。
已授权返工默认复用实际保留的 worktree/branch，即使先前 PR 已合并，已删除则新建；
核实项目、分支、归属及无冲突使用者，metadata 不是归属证明，也不扫描无关聊天。
安全 fetch/正常 merge 主线，按需新建后续 PR、独立审阅并在授权内正常合并；
不 force/reset/amend 或丢工作。环境改作他用或有冲突使用者时明确解决阻塞，不接管。
原执行者符合条件可继续时编排者 不建替代 Task；否则按新授权安排适当 Task。

单项 `task_read(view=overview,include=[...])` 可一次选择当前需要的完整内容：
只看状态用 `["context"]`，需判断阻塞/交付时可组合 `["activity","outcome"]`；
retro、definition、automation、cancellation 按目的选取，不默认 read-all。
未选正文不加载，超预算明确报错；省略 include 保持旧视图，历史/日志仍分页。
执行者开始、恢复与要求同步仍完整读取 execution 并精确 ACK。

编排者明确选择现有可发现的 Skill/MCP 资源，以 `task_session_create` 新建并准备，
或用 `task_session_prepare` 准备已加载空闲、无未结束 Task 的既有执行者；
检查分步回执后，由 `task_assign` 最终检查、绑定并发送一次派单；绑定后把默认/自动生成的
执行者会话标题设为 Task 标题（保留显式设置的名称，失败单独报告，不影响派单）。登记 backlog 不派单，
准备也不发送初始化消息。就绪不等于授权、ACK 或执行，Skill 启用不等于正文已加载。
显式资源准备要求宿主 `resourcePreparationVersion: 1`；省略资源选择的旧创建保持兼容。

**使用与打包：[Task](docs/task-board.md)**。模块需要支持模块角色和宿主
能力接口的 Cockpit；旧版宿主不能仅靠安装这个包获得这些能力。构建、合并不等于安装
或升级，部署须由操作者另行决定。

契约：[产品设计](docs/task-design.md) · [Schema](docs/task-schema.md) ·
[MCP 工具](docs/task-mcp-contract.md) · [角色 Skills](docs/task-tools-skills.md) ·
[宿主接入](docs/task-host-contract.md) · [实现边界](docs/task-implementation.md)。

回归演练：[Task 生命周期用例与复跑流程](docs/task-lifecycle-testing.md)，
包含隔离边界、输入、角色分工、故障注入、证据标准，以及生命周期与订阅必要性演练的结果和限制。

## 开发与打包

需要 Node.js 24 或更新版本：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run package:module
```

Each worktree needs its own `node_modules`; untracked or ignored local setup is not
inherited. Use the initialization command above when the current work needs missing
dependencies, reusing downloads through npm's own cache. Do not copy production
dependencies or credentials, or symlink another worktree's entire `node_modules`.
Documentation-only edits do not require dependency installation, and a ready
environment should not be reinstalled unconditionally.

Run `npm run quotas` for prompt-text usage and remaining capacity; it needs no
dependency installation. Characters are JavaScript `String.length` (UTF-16 code
units): Markdown line endings are normalized to LF, Skill frontmatter and outer
whitespace are excluded, and internal whitespace is counted. MCP descriptions are
counted unchanged. The fixed limits and counting rules live in
`scripts/prompt-quotas.js`, separately from business payload limits.

模块代码位于 `src/task-board/`，卡片位于 `web/task-board/`；
`cockpit.module.json` 是模块入口。归档输出到 `dist/cockpit-task-<version>.tgz`，
供支持所需接口的 Cockpit 装载；Task 不提供独立服务启动命令。

模块 ID、MCP key 和包名均为 `cockpit-task`；唯一角色为 `node`（Node），合并 Skill 为
[cockpit-task-tree](skills/cockpit-task-tree/cockpit-task-tree/SKILL.md)，
核心操作约定在 Skill 正文中，可信脚本 Task 另有 automation reference。
节点同时通过现有装载机制发现 `github-coding` 工作 Skill，
选择角色不等于每次都加载正文。准备包版本为 `0.3.1`；不同内容使用新版本，
不覆盖同版本的既有安装。源码合并、CI 归档均不会自动升级线上。
持久化仅使用宿主提供的模块目录，不自动导入其他数据库或修改既有安装。
已发行 0.1.13 打包 #71/#72/#74（经 #75 合入）的按 Task 层级委派与 tree-node 模型：新增
schema v7（`tasks.parent_task_id`、`tasks.depth`，最多 3 层，超出返回
`DELEGATION_DEPTH_EXCEEDED`；新表 `child_notices`），以唯一 `node` 角色和合并 Skill
`cockpit-task-tree` 取代 legacy owner/executor 角色。schema v7 只能向前滚动：已安装的
`0.1.12` 不能打开 v7；切回旧包不等于数据库回退。0.1.13 删除 `owner`/`executor`
角色且不提供别名；宿主冷启动到 0.1.13 前，操作者须备份并迁移每个 session 的
`$COCKPIT_HOME/session-roles/<sessionId>.json`，把 `cockpit-task/owner` 和
`cockpit-task/executor` 替换为去重后的 `cockpit-task/node`，保留其他角色；回滚到 0.1.12
时应同时恢复该备份。
`0.2.0` 同时打包 schema v8 的 outcome retro handling 与 schema v9 的
orchestrator/assignee 公共词汇切换。v9 从宿主
`_meta["cockpit/invocation"].sessionId` 派生调用者，删除工具输入中的
`actor_session_id`；必须与提供该 metadata 的 Cockpit 0.4.7 联合部署。
schema v9 只能向前滚动，0.1.13 不能打开升级后的数据库。
Version `0.3.0` packages the incompatible schema v10 contract and requires an explicit
reviewed plan for every existing v9 database, including those without legacy statuses.
Released `0.2.0` cannot open v10. See the
[migration procedure](docs/task-implementation.md#schema-v10-migration);
version preparation does not authorize production migration or deployment.

Version `0.3.1` prepares schema v11 and scopes every `request_id` to the trusted
calling session; its main and subagents share the namespace, while different
sessions may reuse IDs. Operation reads and `resume_request_id` resolve only in
that namespace; HTTP retains the internal `user` namespace. Migration preserves
original receipts and uncertain effects. Unattributable legacy IDs stay reserved
and return `LEGACY_OPERATION_UNSCOPED`, never guessed or reexecuted. Released
`0.3.0` cannot open v11. See the
[receipt migration contract](docs/task-implementation.md#caller-scoped-receipts-and-schema-v11).
No production migration, installation, release or deployment is authorized.

schema v10 将 lifecycle 收敛为 `todo`、`in_progress`、`done`、`cancelled`，
并把 Task/condition blocker 改为持久化关系轮次。v9→v10 不会猜测旧
`blocked` / `in_review` 的含义：先运行 `node scripts/migrate-task-v10.js --data-root <dir>`
只读盘点，再对每项以精确 revision、source_fingerprint 和事实来源编写计划，
先用 `--preflight --plan <file>` 无副作用核对，最后经独立授权显式传
`--apply --plan <file>`；任一项缺失或源数据漂移时整个迁移拒绝。上线前必须对包含 WAL 的最新一致副本
重新盘点并演练；源码合并不授权修改生产数据。
`0.1.12` 打包 `0.1.11` 之后已合并的原生 Task 依赖和 `github-coding` Skill 更新（#59、#61、#63、#65）。
Task 依赖新增 schema v6（`task_dependencies`、`dependency_notices`），v5→v6
迁移只新建表。schema v6 只能向前滚动：已安装的 `0.1.11` 不能打开 v6；
切回旧包不等于数据库回退，不得用历史备份覆盖实时数据。部署前应在隔离的一致副本上验证迁移。
`0.1.11` 在 `0.1.10` 基础上包含 orchestrator 顺序订阅跟进（#53）和 执行者会话标题（#55），
不新增 schema 迁移。升级为 schema v5 时不回填历史指派；升级前已派单 Task 保持可读但均不可重开。
