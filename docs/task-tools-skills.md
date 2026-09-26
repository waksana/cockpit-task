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

每个 session 都是节点：按上下文和责任需要选择自己做、内部 subagent 或正式 Task；
已有 Task 的 assignee 负责整合结果，启动 helper 不转移责任。
orchestrator/assignee 是针对某个 Task 的事实（`orchestrator`/`assignee`
字段与读取返回的 `actor_role`），不是 session 的角色；0.1.13 删除旧的 `owner`/`executor`
角色且不提供别名。宿主冷启动到 0.1.13 前，操作者须备份并迁移每个 session 的
`$COCKPIT_HOME/session-roles/<sessionId>.json`，把 `cockpit-task/owner` 和
`cockpit-task/executor` 替换为去重后的 `cockpit-task/node`，保留其他角色；仅追加 `node`
仍会因保存了未声明角色而加载失败，回滚到 0.1.12 时应同时恢复该备份。Task 不提供给已有
session 修改宿主角色的工具，指派也不补能力。调用者身份来自宿主 invocation，只作归因；服务拒绝自我指派（`SELF_ASSIGNMENT`）
和沿祖先链的回环指派（`DELEGATION_CYCLE`）。`DELEGATION_OWNER_MISMATCH` 已删除，
因为 `orchestrator` 不再是输入字段。
0.2.0 的工具调用者由配套宿主通过 `_meta["cockpit/invocation"]` 提供，
不再接受调用者填写的 `actor_session_id`；缺少 metadata 时明确返回
`INVOCATION_REQUIRED`。

Skill 结构为一个 [SKILL.md](../skills/cockpit-task-tree/cockpit-task-tree/SKILL.md) 操作手册，覆盖作为节点完成自己的 Task、编排 Subtask、读取当前事实、写入安全、通知与恢复；仅保留 [automation reference](../skills/cockpit-task-tree/cockpit-task-tree/references/automation.md) 说明可信脚本 Task。工具字段、错误码、视图和分页以 MCP 工具描述为准。

常驻 prompt 固定责任及加载入口；Skill 正文指导判断，随包 references 解释
具体问题。外层目录是原生发现根目录，内层技能自包含，不依赖仓库 docs。
`node` 的 `skillDirectories` 包含 `skills/cockpit-task-tree` 与 `skills/github-coding` 根。
需要特定工作 Skill 时引用其名字，不复制正文、不假定 Subtask 的 assignee 继承上下文，
也不在 role prompt 注入整套方法。

首次需要时加载 Skill，指令仍在上下文时复用。压缩/恢复后缺失、内容改变或
具体规则不清楚时再读，不因每条消息或检查点重复加载。稳定指导可以复用，
可变的 Task 定义、状态和 ACK 却必须按需刷新；文字指导不是加载频率的程序保证。

### Git/GitHub 编码协作

是否适用按需要修改并提交的仓库文件判断；从 GitHub 使用现有已验证产物部署、
运行配置或安全重启不由此流程强制 Issue/PR/branch/worktree，项目政策与不可变安装要求仍有效。
运行配置不等于仓库内版本号、构建配置、源码或文档变更；后者才走仓库变更流程。
委派混合交付时保持一个 Task，Issue/PR 只覆盖必要仓库变更，不额外建部署总 Issue。
执行中发现超出约定范围的变更时，assignee 先直接问用户（范围由用户决定），
获授权后更新当前 Task 并按同样方式建立该仓库的 Issue/worktree；不通过 assignee-to-orchestrator 聊天。
部署等独立授权与此流程适用性、协作方式的选择分开。

使用 Task 委派时，orchestrator 说明本项要求并引用现有 Issue；
不接管已指派的交付，也不准备或清理 assignee 的 branch/worktree。新建 assignee session 时把 cwd
设为目标仓库的共享主 checkout（跨仓库时任选其一），以加载仓库指令和 Skill。

该 checkout 对实施节点只读。编码时复用或创建 Issue，从新 fetch 的主线建立专用
branch 和独立 worktree；有 Task 时记录 Issue、branch 与路径，之后只在 worktree 操作。
工具默认使用 cwd，编辑、构建、测试须明确指向 worktree 路径。多仓库各自如此。
已有合适 Issue/环境在核实归属后继续使用，不能为“干净”丢弃、stash 或删除他人改动。

实施节点完整负责实现、必要验证、独立只读 review、修复、
关联 PR 和授权内正常合并；PR 创建后及时补已有 Task 链接，确认最新 head 的 CI，
不绕过仓库保护。Task 用现有 references/metadata/outcome.references 表达关联，
不增加 GitHub 字段、MCP 或评论镜像。仅 PR、补丁、调查授权不擅自扩成合并。
独立 review 可使用内部 helper；是否需要正式 Task 取决于独立责任，而非 review 这个阶段名。

合并后由实施节点自行清理：核实已按 PR 合入目标分支（含 squash/rebase），确认自己、
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

## 2. 选择协作与正式 Task 委派

上下文已在手、直接处理更合适时自己做；需要并行、分担上下文或独立判断时用内部
subagent，由当前负责人整合；需要独立负责人持续推进、独立交付或依赖协调时派 Task。
这是判断依据，不设固定顺序、数量目标或逐次审批，也不偏向新建或复用 session。
内部 helper 与当前节点交换结果；正式 Task 节点之间只读写 Task，不直接或经 helper 传话。
已有指派的责任和用户授权不因工具选择改变，同一用户决定不在多个会话重复询问。

Task description 只写本项工作特有且影响交付的目标、决定、边界和完成要求。
外部资料用可定位引用，不复制常识、已有规则、操作流程、无必要的实现细节或历史；
影响交付的关键约定不能只藏在引用或 metadata 中。activity 写重要变化，outcome 写实际
交付、遗留和证据入口。区分讨论、登记与执行授权，不对已授权工作重复索要开工口令。

选择正式 Agent Task 后：

1. 选择已授权工作环境及现有可发现的 Skill/MCP，`task_create` 登记本项交付要求与引用；
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
Task/session、不重新派单；可由 orchestrator 重开并通知 assignee，或由原 assignee 自助重开。保留原责任和环境，由原 assignee
继续。cancelled、automation、升级前指派或已发生后续指派等不符合条件的工作，
才按新的明确授权安排适当 Task，不换人接管原 Task。

### 轻量 automation 路径

Agent 仍是默认；orchestrator 仅为可信、可重复的已知脚本选择服务执行，不把任意工作
脚本化或绕过已有责任与授权。按需读
[orchestrator 脚本参考](../skills/cockpit-task-tree/cockpit-task-tree/references/automation.md)：
发现/不可变登记 → task_create 保存配置与类型化输入快照 → 可选必要订阅 → 显式 start。
无 assignee、ACK、session 占用或自动订阅；可作为服务管理的 Subtask，单队列不是工作流引擎。
本次执行结束均 done+真实 outcome，失败/中断由 run facts 表达；取消不回滚，reconcile 仅证明终止后
解除队列屏障，不重跑或更改结果。通知后重读最新事实，不安排轮询或自动续订。

## 3. assignee：完整交付、同步要求

automation 不属于 assignee 指派：可用现有读取工具看 kind、快照、运行事实、
outcomes 和有界 automation_log，不能 ack/report；现有 edit/cancel 不授予 create/start。
有授权的可信脚本可作为 automation Subtask；不能为绕过 Agent 交付临时造脚本。

assignee 先读 execution 确认真实指派、完整 description、资料、版本与状态，
不从名称、角色或旧聊天推断承接。内部组织步骤或 subagent，负责调查、实施、
修正和完整交付，可编排更具体的 Subtask 但须集成结果。同一 session 只执行一项未结束 Task。

开工、恢复、重要阶段间、重要外部操作前和交付前读取最新定义，理解并 ACK
精确 revision。ACK 与状态分开：确认后仍为 todo，开始时明确报告 in_progress。
每次响应都处理 definition_check，检查不可用不能解释为未变化。
按需组合不能代替这些完整 execution 读取与精确 ACK。

真实决策、缺少的重要条件及范围变更直接向自己 session 中的用户提出，
不让 orchestrator 转述，不向 orchestrator 直接或经 subagent 发送问题、进展、阻塞或完成消息。
澄清后的当前有效结论写回 description，变更原因留在修订记录中，不把旧决定反复搬回正文。
编辑定义遵循上述任务专属约定与证据取舍原则，不要将提案或引用误作授权，
也不把要求藏进 metadata。

当前 assignee 成功修改未结束 Task 的实际正文时自动 ACK 新版；
相同正文、仅资料修改、终态编辑不适用。检查是否又有后续变化，不把通知当成新授权。

明确返工授权后，orchestrator 或原 assignee 可读完整 execution 并用独立 `task_reopen`
提交当前 revision/write_context、完整 description 和 reason；工作继续归原 assignee。仅适用于 done Agent，
调用者必须是 orchestrator 或原 assignee（归因而非认证）。资格要求 schema v5 后的持久单调指派序号、
自原指派后没有其他 Task 指派（后来 done/cancelled 仍不例外），且无其他未结束 Task。
升级前已指派的全部不可重开，不回填或猜时间顺序。只查能力就绪，不要求当前执行 session
空闲；不 prepare 或 dispatch。
原子进入 in_progress、创建新版，即使正文相同；原 assignee 调用会 self-ACK 且不发 notice，orchestrator/Web-user 调用不 auto-ACK 并发送 `[Task updated]`；历史及引用不变，
旧成果/复盘 current:false，旧 ACK/成果不能交付新版。完成仍须新 outcome/retro。
已结束订阅不续订、不补发通知，不新增强制 activity 日志或轮次状态机。

activity 只记重要变化，不重述任务、固定间隔更新或倾倒工具日志。
outcome 写实际交付、遗留和证据入口，详细研究成果作为引用；影响交付判断的必要精确数值仍须保留。
这些是内容取舍指导，不是必填模板、字数限制或模型行为保证。
用户暂缓不报告 blocked 或虚构前置；in_progress 不要求持续运行。真实阻碍用具体
`{condition}` 加入 active blocked_by，服务向 orchestrator 上行一次；由其确认解除或
原子换成 `{task_id}`。阻塞期间普通修订/部分解除静默，最后前置满足通知一次。
ready/通知不能覆盖完整约定中的“等我说继续”；reopen 不复活旧依赖，新问题须新建关系。
activity 不自动改状态，outcome 不自动 done。完成最新已确认约定后，
在同次报告提交 `status=done`、新 outcome 与显式 `retro` 文本或 null，
保留成果引用和未执行边界。普通报告不传 retro；缺字段不当作 null。
先完成交付，再简短复盘，仅写有实际证据、可行动的自动化候选、具体慢点/重复卡点，
或 Skill/MCP 发现、契约、能力验证缺口。区分观察、假设及外部等待，不编造耗时；
无有用发现传 null，不要求多段模板或凑字数。复盘最多 2,000 字符，不代替成果和阻塞，
不授权改进或扩大范围；服务不新增通知、派单或完成门槛；
有 Subtask 的节点在自己 done 前把 Subtask retro 折入自己的 retro。`task_retro_handle` 只是可选记录工具，任意调用者可用，Skill 不规定使用时机。
服务保证提交和持久化，不保证思考或质量；automation 无 Agent 复盘。
评审是普通工作，不写 in_review，也不等待默认 orchestrator 审批。

## 4. 消息与一次性等待

| 引用 | 使用规则 |
| --- | --- |
| `[Task](task:<uuid>)` | 普通引用 |
| `[Task assigned](task:<uuid>?event=assigned)` | `task_assign` 的完整首次派单；orchestrator 不重复发送；旧 assigned-to-you 标签仅兼容识别 |
| `[Task updated](task:<uuid>?event=updated)` | 服务自动发送给 assignee 的要求/依赖/重开更新；完整正文仅为该链接，处理规则由 Skill 规定 |
| `[Task cancelled](task:<uuid>?event=cancelled)` | 服务自动发送给 assignee 的取消通知；完整正文仅为该链接，处理规则由 Skill 规定 |
| `[Subscribed Task status changed](task:<uuid>?event=status_changed)` | 系统按显式一次性订阅通知 subscriber，不是 assignee 的 ACK 通知 |
| `[Subtask ready](task:<uuid>?event=ready)` | `blocked_by` 全部 done 后系统通知依赖方 orchestrator；不代表已指派或启动 |
| `[Subtask blocker cancelled](task:<uuid>?event=blocker_cancelled)` | 待派发依赖方的 blocker 取消后系统通知 orchestrator 重新评估 |
| `[Subtask done](task:<uuid>?event=child_done)` | Subtask 每次真实进入 done 时系统通知其 orchestrator，无需订阅；仅同一转换已触发给同一 orchestrator 的订阅或父 Task 已结束时不发 |
| `[Task blocked](task:<uuid>?event=blocked)` | assignee 新增具体未满足文字条件时向 orchestrator 上行一次 |
| `[Subtask blocked](task:<uuid>?event=child_blocked)` | 仅旧历史兼容，不再产生 |
| `[Subtask cancelled](task:<uuid>?event=child_cancelled)` | Subtask 每次真实进入 cancelled 时系统通知其 orchestrator，无需订阅；仅同一转换已触发给同一 orchestrator 的订阅或父 Task 已结束时不发 |

使用真实 UUID。event 由 URL 明确给出，只有上表小写值有效；不是 Task 类型、
状态、命令或事件总线。卡片读取当前数据，消息原因保持不变。
完整语法见[引用契约](task-implementation.md#read-boundaries-and-reference)。

正式 Task 节点间的要求更新只改 Task，不直接或经内部 helper 传话、补发卡片。服务按 ready 期间更新、
ready/blocked 边界、reopen 或取消规则发送固定引用，仍 blocked 时普通更新/部分完成静默，
不提醒操作者本人。assignee notices 用 `mode:"immediate"`，不复制 description、
不整理或重放队列；未知效果不盲目补发。接受不等于 ACK，不解除用户暂缓约定。

**默认不订阅。** orchestrator 只有在未来状态会使自己采取具体、必要的后续行动时，
才用 task_subscribe；无需等用户明确要求订阅，但不能为此虚构工作、拆分成果或
增加审批。仅看进度、确认完成或重复交付汇报不是理由；assignee 已直接问用户的
blocked 不让 orchestrator 再转述。选择最少必要目标，行动不再需要时
task_unsubscribe 取消仍在等待的订阅。

登记时已匹配则失败，不即时通知。首次实际匹配后由系统 enqueue 给 subscriber，
不打断或清队列、不保持原模型轮次等待。subscriber 收到后按实际目的一次读取所需最新内容，重新判断
后续行动是否仍必要且已授权，不自动续订或轮询。assignee 不等待订阅或通知被读，
也不发送、重复或 ACK 这条消息。失败投递不抹去已保存成果，不手工补发未知通知。

<a id="通用响应"></a>

## 5. 通用响应

| 字段 | 职责 |
| --- | --- |
| `result` | 读取数据或原操作的明确效果，可能包含已应用部分 |
| `error` | 原操作未完成部分的错误；无错误为 `null` |
| `definition_check` | 响应检查点的定义同步情况，独立于操作成功与否 |
| `notifications` / `notification_error` | 触发订阅、依赖、Subtask 或 assignee notice 时的投递证据与独立错误，不回滚 Task 效果 |

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
| 完成自己的 Task、编排 Subtask、处理通知与恢复 | [Task tree Skill](../skills/cockpit-task-tree/cockpit-task-tree/SKILL.md) |
| 可信脚本 automation Task | [Automation reference](../skills/cockpit-task-tree/cockpit-task-tree/references/automation.md) |
| 视图、字段、截断、分页、错误码和工具输入 | [MCP 契约](task-mcp-contract.md) |
| Task 引用和通知原因 | [实现边界](task-implementation.md#read-boundaries-and-reference) |
| 可信脚本与自动化 | [自动化](../skills/cockpit-task-tree/cockpit-task-tree/references/automation.md) |

只读当前需要的参考，不每轮加载全套。Skill 指导真实行为，工具保护数据一致性；
两者都不保证自然语言遵从性、验证用户授权或扩大任务范围。
