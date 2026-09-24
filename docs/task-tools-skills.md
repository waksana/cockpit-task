# Task MCP 与角色 Skills

本文说明角色如何使用共同记录与工具。参数以
[MCP 契约](task-mcp-contract.md)和[源码 schema](../src/task-board/contracts.js)为准；
记录语义见 [Schema](task-schema.md)，隔离验证见
[生命周期回放](task-lifecycle-testing.md)。

## 1. 角色资源与工具

Task 提供一个树节点角色 `node` 与一个合并 Skill
[cockpit-task-tree](../skills/cockpit-task-tree/cockpit-task-tree/SKILL.md)，并随包提供独立工作 Skill
[github-coding](../skills/github-coding/github-coding/SKILL.md)。
工作方法与协作角色正交，不新增 Task 子类型；非编码或研究工作不加载编码流程。

| 角色 | 常驻指令 | 注入的 Task 工具 |
| --- | --- | --- |
| Node | [task-node.md](../roles/task-node.md) | 全部十七个：`task_read`、`task_create`、`task_session_create`、`task_session_prepare`、`task_assign`、`task_edit`、`task_cancel`、`task_subscribe`、`task_unsubscribe`、`task_script_read`、`task_script_register`、`task_automation_start`、`task_automation_reconcile`、`task_ack`、`task_report`、`task_reopen`、`task_retro_handle` |

每个 session 都是 Task 树中的节点：有被指派的 Task 就负责完成它（亲自做或编排 Subtask），
没有就作为根节点委派交付。orchestrator/assignee 是针对某个 Task 的事实（`orchestrator`/`assignee`
字段与读取返回的 `actor_role`），不是 session 的角色；0.1.13 删除旧的 `owner`/`executor`
角色且不提供别名。宿主冷启动到 0.1.13 前，操作者须备份并迁移每个 session 的
`$COCKPIT_HOME/session-roles/<sessionId>.json`，把 `cockpit-task/owner` 和
`cockpit-task/executor` 替换为去重后的 `cockpit-task/node`，保留其他角色；仅追加 `node`
仍会因保存了未声明角色而加载失败，回滚到 0.1.12 时应同时恢复该备份。Task 不提供给已有
session 修改宿主角色的工具，指派也不补能力。调用者身份来自宿主 invocation，只作归因；服务拒绝自我指派（`SELF_ASSIGNMENT`）
和沿祖先链的回环指派（`DELEGATION_CYCLE`）。`DELEGATION_OWNER_MISMATCH` 已删除，
因为 `orchestrator` 不再是输入字段。

Skill 按类别组织：[Doing your own Task](../skills/cockpit-task-tree/cockpit-task-tree/references/own-task.md) 指导作为 assignee 的完成责任，
[Orchestrating Subtasks](../skills/cockpit-task-tree/cockpit-task-tree/references/subtasks.md) 指导作为 orchestrator 的委派，
其余参考为读取、写入与恢复、链接、重要更新和自动化。

常驻 prompt 固定责任及加载入口；Skill 正文指导判断，随包 references 解释
具体问题。外层目录是原生发现根目录，内层技能自包含，不依赖仓库 docs。
`node` 的 `skillDirectories` 包含 `skills/cockpit-task-tree` 与 `skills/github-coding` 根。
Task 正文按名字指向这个可发现工作 Skill，不假定 Subtask 的 assignee 继承 orchestrator 已读的上下文，也不在 role prompt 注入整套方法。

首次需要时加载 Skill，指令仍在上下文时复用。压缩/恢复后缺失、内容改变或
具体规则不清楚时再读，不因每条消息或检查点重复加载。稳定指导可以复用，
可变的 Task 定义、状态和 ACK 却必须按需刷新；文字指导不是加载频率的程序保证。

### Git/GitHub 编码协作

是否适用按需要修改并提交的仓库文件判断；从 GitHub 使用现有已验证产物部署、
运行配置或安全重启不由此流程强制 Issue/PR/branch/worktree，项目政策与不可变安装要求仍有效。
运行配置不等于仓库内版本号、构建配置、源码或文档变更；后者才走仓库变更流程。
混合交付保持一个 Task，Issue/PR 只覆盖必要仓库变更，不额外建部署总 Issue。
执行中发现超出约定范围的变更时，assignee 先直接问用户（范围由用户决定），
获授权后更新当前 Task 并按同样方式建立该仓库的 Issue/worktree；不通过 assignee-to-orchestrator 聊天。
部署等独立授权与此流程适用性分开，orchestrator 默认委派职责不变。

orchestrator 说明要求（改什么、涉及哪些仓库、交付边界），有现成 Issue 时引用，并创建描述完整的 Task；
不准备也不清理 branch/worktree，也不亲自实施代码。orchestrator 创建 assignee session 时把 cwd
设为目标仓库的共享主 checkout（跨仓库时任选其一），以加载仓库指令和 Skill。

该 checkout 对 assignee 只读。编码的第一步是复用或创建 Issue，从新 fetch 的主线建立专用
branch 和独立 worktree，并在 Task 记录 Issue、branch 与路径；之后只在 worktree 操作。
工具默认使用 cwd，编辑、构建、测试须明确指向 worktree 路径。多仓库各自如此。
已有合适 Issue/环境在核实归属后继续使用，不能为“干净”丢弃、stash 或删除他人改动。

assignee 完整负责实现、必要验证、独立只读 review、修复、
关联 PR 和授权内正常合并；PR 创建后及时补 Task 链接，确认最新 head 的 CI，
不绕过仓库保护。Task 用现有 references/metadata/outcome.references 表达关联，
不增加 GitHub 字段、MCP 或评论镜像。仅 PR、补丁、调查授权不擅自扩成合并。

合并后由 assignee 自行清理：核实已按 PR 合入目标分支（含 squash/rebase），确认自己、
subagent 及其他工作都不再使用且无未保存/需保留产物后，仅删除本次的 worktree 和本地/远端
分支（仓库政策保留的除外），不删除任何 session 的 cwd。合并或占用不确定时保留并在
outcome 记录原因。outcome 记录 PR、branch、path 及清理结果。orchestrator 无例行清理职责，
仅可按同样安全检查一次性清理本流程之前由 orchestrator 准备的旧 worktree。
Task done 是约定结果，不等于 session 空闲。
仅当未来状态确实解锁必要且已授权的 orchestrator 行动时才订阅；不自动新增清理脚本或定时器，
不轮询或自动续订，也不新建清理 Task/审批门。发布、部署、重启不是默认阶段。
讨论、非编码和非 GitHub 工作不被强加不适用的步骤。
用户授权返工时，默认复用仍保留的 worktree/branch，即使旧 PR 已合并；已删除则新建。
核实实际项目、分支、归属及无冲突使用者；metadata 不是归属证明，也不扫描无关聊天。
安全 fetch/正常 merge 主线，不 force/reset/amend 或丢弃工作；按需建立新的后续 PR，
独立审阅并按授权正常合并。环境改作他用或有冲突使用者时明确解决阻塞，不接管。
源码交付不扩为发布/安装/部署/重启/迁移，合并后 assignee 再次清理。

## 2. orchestrator：澄清、委派、跟进

orchestrator 可只读了解情况、回答问题和澄清目标。实施及改变外部状态的交付默认通过
Task 交给独立 assignee，不亲自实施或用自身 subagent 绕过委派。
要求达成结果不等于要求本人执行；明确的本人执行要求或实际 assignee 指派才是例外。
仅持有 node 角色本身不是承接，无法委派应说明阻塞。

将一个完整成果放在一个 Task，独立成果才分别登记。创建或修订 description 时，
完整保留本项工作的目标、范围、关键决定、授权边界、特殊约束和完成条件；
完整约定不等于完整上下文。通用 Skill、仓库指令和环境资料按需引用，不重复展开，
任务专属且影响正确执行的信息仍须明确，已有调查与当前要求分开。
Task 是共同工作记录，不是原始证据仓库：详细证据用可访问、可定位的引用保留，
但不能以“见 Issue”替代关键约定、把要求藏进 metadata 或假定继承上下文；
支持结论或安全接续必需的精确数值仍应保留。不复制整段聊天，不强制工作表单。区分讨论、调查、登记
和执行授权；尊重“只讨论”“暂不执行”，不对已授权工作重复索要开工口令。

默认 Agent 流程：

1. 选择已授权工作环境及现有可发现的 Skill/MCP，`task_create` 登记完整要求；
   不从 Task 正文猜资源，backlog 登记不派单。
2. 用 `task_session_create` 显式选择资源，或以 `task_session_prepare` 准备符合条件的
   既有 assignee。排除任何绑定未结束 Task 的 session，即使 native idle；
   目标须已加载空闲、`node` 角色已应用且无待重载角色。检查 operation 回执，
   不强制优先新建/复用，未知效果不盲重试或替换。
3. 用 `task_assign` 进行能力/原生状态检查、绑定和一次 assigned 派单。
   不另发首条消息，不把角色标签当成就绪证明。
4. 按需读取 Task，修改要求而非向 assignee 聊天追进度、澄清或索要确认。
5. 读取 outcome 判断实际交付及未执行边界，不把 idle 或成果可用性当成完成证明。

准备不安装、认证、改全局默认值、改角色/模型、重载或发送初始化消息；
未选资源保持不变。Skill enabled 不等于正文加载，MCP connected 不等于工具 offered，
初始化不等于最终 ready；就绪也不等于授权、绑定、消息接受、ACK 或执行。
assignee 在首次需要时自行加载相关 Skill 正文，不继承 orchestrator 已读的上下文。
参数、支持标记和失败恢复见工具 schema 与按需参考，不在角色 Skill 重复底层操作序列。

orchestrator 查找任务用 `task_read(view=list, orchestrator=<自己的 session ID>)`，actor 不是 orchestrator 筛选器。
单项按目的用 overview 的 include 一次选择：只需状态用 `["context"]`，需要判断阻塞/交付
及下一步时用 `["activity","outcome"]`，确有复盘问题才加 retro；不是固定通知模板。
所选记录完整保留版本、来源和时间；无 outcome 明确为 null，不先猜 outcomes 再补读 activity。
编辑前读完整 definition，历史有具体疑问才分页，省略 include 保持旧 overview。

用户明确授权 done Agent 返工且原 assignee 符合重开条件时，orchestrator 不创建替代
Task/session、不重新派单或代 assignee 重开。保留原责任和环境，由原 assignee
自助继续。cancelled、automation、升级前指派或已发生后续指派等不符合条件的工作，
才按新的明确授权安排适当 Task，不换人接管原 Task。

### 轻量 automation 路径

Agent 仍是默认；orchestrator 仅为可信、可重复的已知脚本选择服务执行，不把任意工作
脚本化，也不亲自实施来绕过委派。按需读
[orchestrator 脚本参考](../skills/cockpit-task-tree/cockpit-task-tree/references/automation.md)：
发现/不可变登记 → task_create 保存配置与类型化输入快照 → 可选必要订阅 → 显式 start。
无 assignee、ACK、session 占用、自动订阅或Subtask；服务单队列，不是工作流引擎。
成功 done+outcome，失败/中断 blocked+outcome；取消不回滚，reconcile 仅证明终止后
解除队列屏障，不重跑或更改结果。通知后重读最新事实，不安排轮询或自动续订。

## 3. assignee：完整交付、同步要求

automation 不属于 assignee 指派：可用现有读取工具看 kind、快照、运行事实、
outcomes 和有界 automation_log，不能 ack/report；现有 edit/cancel 不授予 create/start。
不为自己的已分配工作建立 automation Subtask。

assignee 先读 execution 确认真实指派、完整 description、资料、版本与状态，
不从名称、角色或旧聊天推断承接。内部组织步骤或 subagent，负责调查、实施、
修正和完整交付，不建立Subtask 或向下转移责任。同一 session 只执行一项未结束 Task。

开工、恢复、重要阶段间、重要外部操作前和交付前读取最新定义，理解并 ACK
精确 revision。ACK 与状态分开：确认后仍为 todo，开始时明确报告 in_progress。
每次响应都处理 definition_check，检查不可用不能解释为未变化。
按需组合不能代替这些完整 execution 读取与精确 ACK。

真实决策、缺少的重要条件及范围变更直接向自己 session 中的用户提出，
不让 orchestrator 转述，不向 orchestrator 直接或经 subagent 发送问题、进展、阻塞或完成消息。
澄清后的有效结论写回完整 description，并说明来源、原因和被替代决定。
编辑定义遵循上述任务专属约定与证据取舍原则，不要将提案或引用误作授权，
也不把要求藏进 metadata。

当前 assignee 成功修改未结束 Task 的实际正文时自动 ACK 新版；
相同正文、仅资料修改、终态编辑不适用。检查是否又有后续变化，不把通知当成新授权。

原 assignee 收到明确返工授权后读完整 execution，用独立 `task_reopen`
提交当前 revision/write_context、完整 description 和 reason。仅适用于 done Agent，
actor 必须等于原 assignee（归因而非认证）。资格要求 schema v5 后的持久单调指派序号、
自原指派后没有其他 Task 指派（后来 done/cancelled 仍不例外），且无其他未结束 Task。
升级前已指派的全部不可重开，不回填或猜时间顺序。只查能力就绪，不要求当前执行 session
空闲；不自发 prompt、prepare 或 dispatch。
原子进入 in_progress、创建新版并 self-ACK，即使正文相同；历史及引用不变，
旧成果/复盘 current:false，旧 ACK/成果不能交付新版。完成仍须新 outcome/retro。
已结束订阅不续订、不补发通知，不新增强制 activity 日志或轮次状态机。

activity 先写本次有意义的变化、发现、决定、阻碍和必要剩余工作，说明解除阻碍
需要什么，不重述任务、不固定间隔更新、不编造百分比或倾倒工具日志。
outcome 先写交付结论、约定满足情况和剩余限制，再给必要依据；研究成果可详细，
区分结论、论证和未验证点。引用不能删去支持结论或安全接续必需的精确数值。
这些是内容取舍指导，不是必填模板、字数限制或模型行为保证。
activity 不自动改状态，outcome 不自动 done。完成最新已确认约定后，
在同次报告提交 `status=done`、新 outcome 与显式 `retro` 文本或 null，
保留成果引用和未执行边界。普通报告不传 retro；缺字段不当作 null。
先完成交付，再简短复盘，仅写有实际证据、可行动的自动化候选、具体慢点/重复卡点，
或 Skill/MCP 发现、契约、能力验证缺口。区分观察、假设及外部等待，不编造耗时；
无有用发现传 null，不要求多段模板或凑字数。复盘最多 2,000 字符，不代替成果和阻塞，
不授权改进或扩大范围；服务不新增通知、派单或完成门槛；
orchestrator 按 subtasks.md 用 `task_retro_handle` 处理有发现的 retro（有Subtask 的 assignee 在 done 前，根节点仅在用户问起时）。
服务保证提交和持久化，不保证思考或质量；automation 无 Agent 复盘。
仅工作本身需要时使用 in_review，不等待默认 orchestrator 审批。

## 4. 消息与一次性等待

| 引用 | 使用规则 |
| --- | --- |
| `[Task](task:<uuid>)` | 普通引用 |
| `[Task assigned to you](task:<uuid>?event=assigned)` | `task_assign` 的完整首次派单；orchestrator 不重复发送 |
| `[Task updated](task:<uuid>?event=updated)` | 服务按 `task_edit notify_assignee:true` 发送给 assignee 的重要要求更新，附读取/ACK 最新版要求 |
| `[Task status updated](task:<uuid>?event=status_changed)` | 系统按显式一次性订阅通知 Task.orchestrator，不是 assignee 的 ACK 通知 |
| `[Subtask ready](task:<uuid>?event=ready)` | `blocked_by` 全部 done 后系统通知依赖方 orchestrator；不代表已指派或启动 |
| `[Subtask blocker cancelled](task:<uuid>?event=blocker_cancelled)` | 待派发依赖方的 blocker 取消后系统通知 orchestrator 重新评估 |
| `[Subtask done](task:<uuid>?event=child_done)` | Subtask 每次真实进入 done 时系统通知其 orchestrator，无需订阅；同一转换已触发订阅或父 Task 已结束时不发 |
| `[Subtask blocked](task:<uuid>?event=child_blocked)` | Subtask 每次真实进入 blocked 时系统通知其 orchestrator，无需订阅；同一转换已触发订阅或父 Task 已结束时不发 |
| `[Subtask cancelled](task:<uuid>?event=child_cancelled)` | Subtask 每次真实进入 cancelled 时系统通知其 orchestrator，无需订阅；同一转换已触发订阅或父 Task 已结束时不发 |

使用真实 UUID。event 由 URL 明确给出，只有上表小写值有效；不是 Task 类型、
状态、命令或事件总线。卡片读取当前数据，消息原因保持不变。
完整语法见[引用契约](task-implementation.md#read-boundaries-and-reference)。

普通要求更新只改 Task，不排队发送 cue。orchestrator 仅在重要变更不能等待正常检查点时，
按[重要更新参考](../skills/cockpit-task-tree/cockpit-task-tree/references/important-updates.md)
把所有说明写进完整要求，并在改变 description 的同一次 `task_edit` 设置
`notify_assignee:true`。服务用 `mode:"immediate"` 单次发送固定 updated 引用和读取/ACK 要求。
不复制 description、不整理或重放队列、不为通知中断工作；未知效果只作有界核对，
不手写补发。接受不等于消费或当前 revision 的 ACK。

**默认不订阅。** orchestrator 只有在未来状态会使自己采取具体、必要的后续行动时，
才用 task_subscribe；无需等用户明确要求订阅，但不能为此虚构工作、拆分成果或
增加审批。仅看进度、确认完成或重复交付汇报不是理由；assignee 已直接问用户的
blocked 不让 orchestrator 再转述。选择最少必要目标，行动不再需要时
task_unsubscribe 取消仍在等待的订阅。

登记时已匹配则失败，不即时通知。首次实际匹配后由系统 enqueue 给 Task.orchestrator，
不打断或清队列、不保持原模型轮次等待。orchestrator 收到后按实际目的一次读取所需最新内容，重新判断
后续行动是否仍必要且已授权，不自动续订或轮询。assignee 不等待订阅或通知被读，
也不发送、重复或 ACK 这条消息。失败投递不抹去已保存成果，不手工补发未知通知。

<a id="通用响应"></a>

## 5. 通用响应

| 字段 | 职责 |
| --- | --- |
| `result` | 读取数据或原操作的明确效果，可能包含已应用部分 |
| `error` | 原操作未完成部分的错误；无错误为 `null` |
| `definition_check` | 响应检查点的定义同步情况，独立于操作成功与否 |
| `notifications` / `notification_error` | 触发订阅时的投递证据与独立错误，不回滚 Task 效果 |

definition_check 检查本次定向 Task 及 actor 承接的未结束 Task，不扫描聊天或全部任务。
`checked` 的条目含 task_id、revision、acknowledged_revision、needs_ack，
需要时附提醒；`unavailable` 带检查错误；确实无相关 Task 才为 `not_applicable`。
读取仍不 ACK，提醒的确认责任仍属于固定 assignee，不要求 orchestrator 代确认。

操作结果与检查时点分别解释：报告已提交后才出现的新要求，不会使先前成功写入
消失；重放原效果也不能缓存旧的“无需 ACK”结论。

### 写入、冲突与恢复

- 使用真实 ID、自报 actor、稳定 request_id；同一操作重试保持完整输入不变。
  新的明确操作才使用新 ID，不通过换 ID 绕过不确定效果。
- 既有 Task 写入原样回传 write_context；task_unsubscribe 直接检查指定等待。
  description revision 不负责全部生命周期或资料冲突。
- 逐版 ACK 是精确记录。ACK v3 不证明跳过的 v2 已确认；不能把旧工作重标新版本。
- 已确认旧版 activity 可保存，同时旧版 status/outcome 被拒绝。保留各字段实际效果，
  读取/理解/ACK 当前定义后，以新的明确报告提交真正满足新要求的状态或成果，
  不重复已保存 activity。
- session 创建、能力、绑定、消息接受、ACK 和执行是不同事实。部分失败保留已创建/
  绑定资源；未知效果不允许自动换 Task/session、撤销归属或重发。
- `resume_request_id` 仅适用于未被消费的 final 指派回执证明
  `assignment=applied`、`message=not_sent`；新操作用同 Task/assignee 和最新上下文。
  unknown/queued/accepted/pending 不符合条件，不允许重开终态或换人。
- 取消 Task 不停止原生工作或撤销外部效果。仅上述 `task_reopen` 可恢复符合条件的
  done Agent；cancelled/automation 不恢复，不符合资格的后续工作需适当的新授权 Task。

## 6. 按问题加载参考

| 问题 | 参考 |
| --- | --- |
| 作为 assignee 完成 Task | [执行](../skills/cockpit-task-tree/cockpit-task-tree/references/own-task.md) |
| 作为 orchestrator 委派Subtask | [委派](../skills/cockpit-task-tree/cockpit-task-tree/references/subtasks.md) |
| 视图、字段、截断和分页 | [Task 读取](../skills/cockpit-task-tree/cockpit-task-tree/references/reading-tasks.md) |
| 写入、冲突、部分结果与恢复 | [写入与恢复](../skills/cockpit-task-tree/cockpit-task-tree/references/task-writes-and-recovery.md) |
| Task 引用和通知原因 | [Task 链接](../skills/cockpit-task-tree/cockpit-task-tree/references/task-links.md) |
| 重要变更不能等正常检查点 | orchestrator：[重要更新](../skills/cockpit-task-tree/cockpit-task-tree/references/important-updates.md) 并用 `task_edit notify_assignee:true`；assignee：读取完整 execution 并 ACK 最新 revision |
| 可信脚本与自动化 | [自动化](../skills/cockpit-task-tree/cockpit-task-tree/references/automation.md) |

只读当前需要的参考，不每轮加载全套。Skill 指导真实行为，工具保护数据一致性；
两者都不保证自然语言遵从性、验证用户授权或扩大任务范围。
